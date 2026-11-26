package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"justai-backend/models"
	"justai-backend/provider"
)

// Tools that change the transcription attached to a chat: which agenda items are
// recorded or announced, the names of speakers, and misheard words in the text. Only
// the owner of the transcription can use them, and only on a transcription attached to
// the current chat.

const transcriptCorrectionLimit = 500

func transcriptionEditTools() []provider.ToolDefinition {
	session := `"sessionId":{"type":"string","description":"The transcription to change. Leave out when exactly one transcription is attached to this chat."}`
	return []provider.ToolDefinition{
		{
			Name:        "update_transcription_topics",
			Description: "Select or deselect agenda items of the transcription attached to this chat. In a capture of selected topics only, selected items are the ones that get recorded (the capture window is replanned); otherwise selected items notify the user when they finish. Name items by their label (\"EPL 12\", \"TOP I\") or title. Report the returned selection, not what you intended.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{` + session + `,"select":{"type":"array","items":{"type":"string"},"description":"Items to select."},"deselect":{"type":"array","items":{"type":"string"},"description":"Items to deselect."}},"additionalProperties":false}`),
		},
		{
			Name:        "rename_transcription_speaker",
			Description: "Give a speaker in the attached transcription a name, for example when the user says who \"Speaker 2\" is. Name the speaker by its current name or label.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{` + session + `,"speaker":{"type":"string","description":"Current name or label of the speaker."},"name":{"type":"string","minLength":1,"maxLength":120}},"required":["speaker","name"],"additionalProperties":false}`),
		},
		{
			Name:        "correct_transcript",
			Description: "Correct a word or phrase that was transcribed wrongly, everywhere in the attached transcription (for example a misspelled name). Matches exact text, case-sensitive. The original wording stays available. Report how many lines changed.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{` + session + `,"find":{"type":"string","minLength":2,"maxLength":200},"replace":{"type":"string","maxLength":200}},"required":["find","replace"],"additionalProperties":false}`),
		},
	}
}

func isTranscriptionEditTool(name string) bool {
	switch name {
	case "update_transcription_topics", "rename_transcription_speaker", "correct_transcript":
		return true
	}
	return false
}

// editableChatTranscription finds the transcription a tool may change: attached to
// this chat and owned by the user.
func (a *App) editableChatTranscription(ctx context.Context, userID, organizationID, conversationID uuid.UUID, args map[string]any) (uuid.UUID, error) {
	attached, err := a.conversationTranscriptionSessionIDs(ctx, conversationID, organizationID, userID)
	if err != nil {
		return uuid.Nil, err
	}
	var sessionID uuid.UUID
	if raw := strings.TrimSpace(stringToolArgument(args, "sessionId")); raw != "" {
		if sessionID, err = uuid.Parse(raw); err != nil {
			return uuid.Nil, fmt.Errorf("sessionId is not valid")
		}
		found := false
		for _, id := range attached {
			found = found || id == sessionID
		}
		if !found {
			return uuid.Nil, fmt.Errorf("that transcription is not attached to this chat")
		}
	} else {
		switch len(attached) {
		case 0:
			return uuid.Nil, fmt.Errorf("no transcription is attached to this chat")
		case 1:
			sessionID = attached[0]
		default:
			return uuid.Nil, fmt.Errorf("several transcriptions are attached; give sessionId")
		}
	}
	if a.authorizeTranscriptionSession(ctx, sessionID, userID, organizationID) != nil {
		return uuid.Nil, fmt.Errorf("only the owner of this transcription can change it; it was shared with you read-only")
	}
	return sessionID, nil
}

func (a *App) transcriptionEditTool(ctx context.Context, userID, organizationID, conversationID uuid.UUID, name string, args map[string]any) (json.RawMessage, error) {
	if !a.platformCapabilityEnabled(ctx, "transcription") {
		return nil, fmt.Errorf("transcription is temporarily disabled by the platform administrator")
	}
	sessionID, err := a.editableChatTranscription(ctx, userID, organizationID, conversationID, args)
	if err != nil {
		return nil, err
	}
	switch name {
	case "update_transcription_topics":
		return a.chatUpdateTopics(ctx, sessionID, args)
	case "rename_transcription_speaker":
		return a.chatRenameSpeaker(ctx, sessionID, args)
	default:
		return a.chatCorrectTranscript(ctx, sessionID, args)
	}
}

func stringListArgument(args map[string]any, key string) []string {
	raw, _ := args[key].([]any)
	var out []string
	for _, item := range raw {
		if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
			out = append(out, strings.TrimSpace(value))
		}
	}
	return out
}

// labelParts reads "EPL 06, 21" or "Einzelplan 12" or "TOP II" into a kind and its
// numbers ("06" and "6" are the same).
func labelParts(value string) (string, []string) {
	fields := strings.FieldsFunc(strings.ToLower(value), func(r rune) bool { return r == ' ' || r == ',' || r == ':' || r == '.' })
	if len(fields) < 2 {
		return "", nil
	}
	kind := map[string]string{"einzelplan": "epl", "tagesordnungspunkt": "top", "zusatzpunkt": "zp"}[fields[0]]
	if kind == "" {
		kind = fields[0]
	}
	var numbers []string
	for _, field := range fields[1:] {
		if field == "und" || field == "and" {
			continue
		}
		numbers = append(numbers, strings.TrimLeft(field, "0"))
	}
	return kind, numbers
}

// matchTopic finds an agenda item by id, label ("EPL 12", "Einzelplan 12", "TOP I")
// or title. Several matches are an error, so a vague name changes nothing.
func matchTopic(topics []models.TranscriptionTopic, ref string) (models.TranscriptionTopic, error) {
	want := strings.ToLower(strings.Join(strings.Fields(ref), " "))
	wantKind, wantNumbers := labelParts(ref)
	unique := map[uuid.UUID]models.TranscriptionTopic{}
	for _, topic := range topics {
		title := strings.ToLower(topic.Title)
		switch {
		case topic.ID.String() == ref, strings.ToLower(topic.Label) == want, title == want:
			return topic, nil
		case utf8.RuneCountInString(want) >= 4 && strings.Contains(title, want):
			unique[topic.ID] = topic
		}
		if kind, numbers := labelParts(topic.Label); kind != "" && kind == wantKind && len(wantNumbers) == 1 {
			for _, number := range numbers {
				if number == wantNumbers[0] {
					unique[topic.ID] = topic
				}
			}
		}
	}
	switch len(unique) {
	case 1:
		for _, topic := range unique {
			return topic, nil
		}
	case 0:
		return models.TranscriptionTopic{}, fmt.Errorf("no agenda item matches %q", ref)
	}
	var names []string
	for _, topic := range unique {
		names = append(names, strings.TrimSpace(topic.Label+" "+topic.Title))
	}
	return models.TranscriptionTopic{}, fmt.Errorf("%q matches several items: %s", ref, strings.Join(names, "; "))
}

func (a *App) chatUpdateTopics(ctx context.Context, sessionID uuid.UUID, args map[string]any) (json.RawMessage, error) {
	topics, err := loadTopics(ctx, a.DB, sessionID)
	if err != nil {
		return nil, err
	}
	if len(topics) == 0 {
		return nil, fmt.Errorf("this transcription has no agenda items")
	}
	changes := map[uuid.UUID]bool{}
	var problems []string
	for _, pair := range []struct {
		key   string
		value bool
	}{{"select", true}, {"deselect", false}} {
		for _, ref := range stringListArgument(args, pair.key) {
			topic, err := matchTopic(topics, ref)
			if err != nil {
				problems = append(problems, err.Error())
				continue
			}
			if topic.Status != "planned" && pair.value {
				problems = append(problems, fmt.Sprintf("%s has already %s", strings.TrimSpace(topic.Label+" "+topic.Title), map[string]string{"active": "started", "done": "finished"}[topic.Status]))
				continue
			}
			changes[topic.ID] = pair.value
		}
	}
	if len(changes) == 0 {
		if len(problems) > 0 {
			return nil, errors.New(strings.Join(problems, "; "))
		}
		return nil, fmt.Errorf("name the items to select or deselect")
	}
	for id, starred := range changes {
		if _, err := a.DB.ExecContext(ctx, `UPDATE transcription_topics SET starred = $2, updated_at = now() WHERE id = $1 AND session_id = $3`, id, starred, sessionID); err != nil {
			return nil, err
		}
		a.Live.broadcastTopic(sessionID, id)
	}
	// With "only selected topics" the selection decides when the capture runs.
	a.Live.rescheduleTopicCapture(ctx, sessionID, false)
	topics, _ = loadTopics(ctx, a.DB, sessionID)
	var selected []string
	for _, topic := range topics {
		if topic.Starred {
			selected = append(selected, strings.TrimSpace(topic.Label+" "+topic.Title))
		}
	}
	var scope string
	_ = a.DB.QueryRowContext(ctx, `SELECT COALESCE(MAX(st.capture_scope), 'all') FROM transcription_stream_sources st JOIN transcription_sources src ON src.id = st.source_id WHERE src.session_id = $1`, sessionID).Scan(&scope)
	meaning := "Selected items notify the user when they finish."
	if scope == "topics" {
		meaning = "Only selected items are recorded; the capture window was replanned."
	}
	return json.Marshal(map[string]any{"changed": len(changes), "selected": selected, "meaning": meaning, "problems": problems})
}

func (a *App) chatRenameSpeaker(ctx context.Context, sessionID uuid.UUID, args map[string]any) (json.RawMessage, error) {
	ref := strings.TrimSpace(stringToolArgument(args, "speaker"))
	name := strings.TrimSpace(stringToolArgument(args, "name"))
	if ref == "" || name == "" || utf8.RuneCountInString(name) > 120 {
		return nil, fmt.Errorf("give the speaker and a name of up to 120 characters")
	}
	speakers, err := loadTranscriptionSpeakers(ctx, a.DB, sessionID)
	if err != nil {
		return nil, err
	}
	var matches []models.TranscriptionSpeaker
	for _, speaker := range speakers {
		if speaker.ID.String() == ref || strings.EqualFold(speaker.Label, ref) || strings.EqualFold(speaker.DisplayName, ref) {
			matches = append(matches, speaker)
		}
	}
	if len(matches) != 1 {
		var known []string
		for _, speaker := range speakers {
			known = append(known, firstNonEmptyString(speaker.DisplayName, speaker.Label))
		}
		return nil, fmt.Errorf("no single speaker is called %q; speakers: %s", ref, strings.Join(known, ", "))
	}
	speaker := matches[0]
	if _, err := a.DB.ExecContext(ctx, `UPDATE transcription_speakers SET display_name = $3, name_source = 'manual', suggested_name = '', suggestion_confidence = 0, suggestion_evidence = '', updated_at = now() WHERE id = $1 AND session_id = $2`, speaker.ID, sessionID, name); err != nil {
		return nil, err
	}
	a.Live.broadcast(sessionID, "transcription.speaker", ginData{"speakerId": speaker.ID, "displayName": name})
	return json.Marshal(map[string]any{"renamed": true, "from": firstNonEmptyString(speaker.DisplayName, speaker.Label), "to": name})
}

func (a *App) chatCorrectTranscript(ctx context.Context, sessionID uuid.UUID, args map[string]any) (json.RawMessage, error) {
	find := stringToolArgument(args, "find")
	replace := stringToolArgument(args, "replace")
	if utf8.RuneCountInString(strings.TrimSpace(find)) < 2 || len(find) > 200 || len(replace) > 200 {
		return nil, fmt.Errorf("find needs at least 2 characters; both at most 200")
	}
	if find == replace {
		return nil, fmt.Errorf("find and replace are the same")
	}
	// The correction is stored as an edit, so the recognised text stays available.
	rows, err := a.DB.QueryContext(ctx, `UPDATE transcription_segments
		SET edited_text = replace(COALESCE(NULLIF(edited_text, ''), NULLIF(polished_text, ''), text), $2, $3), updated_at = now()
		WHERE id IN (SELECT id FROM transcription_segments WHERE session_id = $1 AND canonical
			AND strpos(COALESCE(NULLIF(edited_text, ''), NULLIF(polished_text, ''), text), $2) > 0
			ORDER BY start_offset_ms LIMIT $4)
		RETURNING id`, sessionID, find, replace, transcriptCorrectionLimit)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			ids = append(ids, id.String())
		}
	}
	rows.Close()
	if len(ids) == 0 {
		return nil, fmt.Errorf("%q does not occur in the transcript", find)
	}
	if segments, err := loadTranscriptionSegments(ctx, a.DB, sessionID); err == nil {
		changed := map[string]bool{}
		for _, id := range ids {
			changed[id] = true
		}
		for _, segment := range segments {
			if changed[segment.ID.String()] {
				a.Live.broadcast(sessionID, "transcription.segment.updated", ginData{"segment": segment})
			}
		}
	}
	result := map[string]any{"changedLines": len(ids), "find": find, "replace": replace}
	var more bool
	_ = a.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM transcription_segments WHERE session_id = $1 AND canonical AND strpos(COALESCE(NULLIF(edited_text, ''), NULLIF(polished_text, ''), text), $2) > 0)`, sessionID, find).Scan(&more)
	if more {
		result["note"] = fmt.Sprintf("Only %d lines were changed at once; run it again for the rest.", transcriptCorrectionLimit)
	}
	return json.Marshal(result)
}
