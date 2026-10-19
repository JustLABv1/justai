package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

const (
	// speakerAutoApplyConfidence is the minimum model confidence at which a
	// name is applied without waiting for the user. Anything below is stored
	// as a suggestion that the user confirms or dismisses.
	speakerAutoApplyConfidence = 0.85
	// speakerUnlistedConfidenceCap keeps names that are not on the supplied
	// participant list from being applied automatically.
	speakerUnlistedConfidenceCap = 0.6
	speakerSuggestionMinimum     = 0.3
	speakerTranscriptRuneBudget  = 48000
	maxSpeakerParticipants       = 100
)

type speakerParticipant struct {
	Name string `json:"name"`
	Role string `json:"role,omitempty"`
}

type speakerIdentifyRequest struct {
	// Participants is optional. When set it is stored on the session so later
	// runs (for example during a live session) reuse it.
	Participants *[]speakerParticipant `json:"participants"`
	// AutoApply applies high-confidence names directly. Defaults to true.
	AutoApply *bool `json:"autoApply"`
}

type speakerIdentification struct {
	Label      string  `json:"label"`
	Name       string  `json:"name"`
	Confidence float64 `json:"confidence"`
	Evidence   string  `json:"evidence"`
}

type resolvedSpeakerName struct {
	SpeakerID  uuid.UUID
	Name       string
	Confidence float64
	Evidence   string
	Apply      bool
}

const speakerIdentifySystemPrompt = `You identify who the anonymous speakers of a transcript are. Speakers are labeled like SPEAKER_00 or Speaker 1.
Only use evidence that is literally present in the transcript: a speaker introducing themselves, being addressed by name by someone else, or a clear role match with an entry of the participant list.
Never guess. If a speaker's name is not supported by evidence, return an empty name and confidence 0.
Confidence: 0.9+ for self-introduction or direct address followed by that person answering; 0.5-0.8 for indirect clues or role matches; below 0.3 means unknown.
If a participant list is given, prefer its exact spelling of names. Do not give the same name to two labels.
Return exactly one JSON object and nothing else, in the shape {"speakers":[{"label":"SPEAKER_00","name":"","confidence":0,"evidence":"short quote or reason, in the transcript language"}]}.`

func normalizeSpeakerParticipants(values []speakerParticipant) []speakerParticipant {
	result := make([]speakerParticipant, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		name := strings.Join(strings.Fields(value.Name), " ")
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, speakerParticipant{Name: truncateTranscriptionInsightText(name, 80), Role: truncateTranscriptionInsightText(strings.Join(strings.Fields(value.Role), " "), 120)})
		if len(result) == maxSpeakerParticipants {
			break
		}
	}
	return result
}

// speakerTranscriptForIdentification renders the transcript with the original
// diarization labels. Introductions cluster at the start and direct address
// can occur anywhere, so an oversized transcript keeps its head and tail.
func speakerTranscriptForIdentification(segments []models.TranscriptionSegment, speakers []models.TranscriptionSpeaker) string {
	labelByID := make(map[uuid.UUID]string, len(speakers))
	for _, speaker := range speakers {
		labelByID[speaker.ID] = speaker.Label
	}
	lines := make([]string, 0, len(segments))
	for _, segment := range segments {
		if segment.SpeakerID == nil {
			continue
		}
		label := labelByID[*segment.SpeakerID]
		text := strings.TrimSpace(segment.Text)
		if segment.EditedText != nil {
			text = strings.TrimSpace(*segment.EditedText)
		} else if segment.PolishedText != nil && strings.TrimSpace(*segment.PolishedText) != "" {
			text = strings.TrimSpace(*segment.PolishedText)
		}
		if label == "" || text == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("[%s] %s: %s", formatTranscriptTimestamp(segment.StartOffsetMs), label, text))
	}
	total := 0
	for _, line := range lines {
		total += len([]rune(line)) + 1
	}
	if total <= speakerTranscriptRuneBudget {
		return strings.Join(lines, "\n")
	}
	headBudget, tailBudget := speakerTranscriptRuneBudget*6/10, speakerTranscriptRuneBudget*4/10
	head, tail := []string{}, []string{}
	used := 0
	headEnd := 0
	for index, line := range lines {
		size := len([]rune(line)) + 1
		if used+size > headBudget {
			break
		}
		used += size
		head = append(head, line)
		headEnd = index + 1
	}
	used = 0
	for index := len(lines) - 1; index >= headEnd; index-- {
		size := len([]rune(lines[index])) + 1
		if used+size > tailBudget {
			break
		}
		used += size
		tail = append([]string{lines[index]}, tail...)
	}
	return strings.Join(head, "\n") + "\n[… transcript shortened …]\n" + strings.Join(tail, "\n")
}

func buildSpeakerIdentifyInput(title, transcript string, participants []speakerParticipant, speakers []models.TranscriptionSpeaker) string {
	var builder strings.Builder
	if title = strings.TrimSpace(title); title != "" {
		builder.WriteString("Session title: " + title + "\n")
	}
	if len(participants) > 0 {
		builder.WriteString("Participants:\n")
		for _, participant := range participants {
			if participant.Role != "" {
				builder.WriteString("- " + participant.Name + " (" + participant.Role + ")\n")
			} else {
				builder.WriteString("- " + participant.Name + "\n")
			}
		}
	} else {
		builder.WriteString("Participants: not provided; use names that appear in the transcript only.\n")
	}
	builder.WriteString("Speaker labels to identify: ")
	labels := make([]string, 0, len(speakers))
	for _, speaker := range speakers {
		if !speakerNameProtected(speaker) {
			labels = append(labels, speaker.Label)
		}
	}
	builder.WriteString(strings.Join(labels, ", ") + "\n")
	var named []string
	for _, speaker := range speakers {
		if speakerNameProtected(speaker) {
			named = append(named, speaker.Label+" = "+speaker.DisplayName)
		}
	}
	if len(named) > 0 {
		builder.WriteString("Already named by the user (do not reuse these names): " + strings.Join(named, "; ") + "\n")
	}
	builder.WriteString("\nTranscript:\n" + transcript)
	return builder.String()
}

// speakerNameProtected reports whether a name was set by a person. Names that
// the AI chose earlier may be refined by a later run.
func speakerNameProtected(speaker models.TranscriptionSpeaker) bool {
	return strings.TrimSpace(speaker.DisplayName) != "" && speaker.NameSource != "ai"
}

func decodeSpeakerIdentifications(output string) ([]speakerIdentification, error) {
	var lastErr error
	for _, candidate := range videoPolishJSONCandidates(output) {
		var wrapped struct {
			Speakers []speakerIdentification `json:"speakers"`
		}
		if err := json.Unmarshal(candidate, &wrapped); err == nil && wrapped.Speakers != nil {
			return wrapped.Speakers, nil
		} else if err != nil {
			lastErr = err
		}
		var bare []speakerIdentification
		if err := json.Unmarshal(candidate, &bare); err == nil && bare != nil {
			return bare, nil
		}
	}
	if lastErr != nil {
		return nil, fmt.Errorf("endpoint returned invalid JSON: %w", lastErr)
	}
	return nil, fmt.Errorf("endpoint returned no speaker identification")
}

// resolveSpeakerIdentifications turns raw model output into safe decisions.
// It drops unknown labels, names a person already set, empty or low
// confidence answers, and duplicate names (the more confident label wins).
func resolveSpeakerIdentifications(items []speakerIdentification, speakers []models.TranscriptionSpeaker, participants []speakerParticipant, autoApply bool) []resolvedSpeakerName {
	byLabel := make(map[string]models.TranscriptionSpeaker, len(speakers))
	usedByPeople := map[string]struct{}{}
	for _, speaker := range speakers {
		byLabel[strings.ToLower(strings.TrimSpace(speaker.Label))] = speaker
		if speakerNameProtected(speaker) {
			usedByPeople[strings.ToLower(strings.TrimSpace(speaker.DisplayName))] = struct{}{}
		}
	}
	canonical := make(map[string]string, len(participants))
	for _, participant := range participants {
		canonical[strings.ToLower(participant.Name)] = participant.Name
	}
	best := map[string]resolvedSpeakerName{}
	for _, item := range items {
		speaker, ok := byLabel[strings.ToLower(strings.TrimSpace(item.Label))]
		name := strings.Join(strings.Fields(item.Name), " ")
		if !ok || name == "" || speakerNameProtected(speaker) {
			continue
		}
		name = truncateTranscriptionInsightText(name, 80)
		confidence := item.Confidence
		if confidence != confidence || confidence < 0 {
			confidence = 0
		}
		if confidence > 1 {
			confidence = 1
		}
		key := strings.ToLower(name)
		if known, listed := canonical[key]; listed {
			name = known
		} else if len(participants) > 0 && confidence > speakerUnlistedConfidenceCap {
			confidence = speakerUnlistedConfidenceCap
		}
		if confidence < speakerSuggestionMinimum {
			continue
		}
		if _, taken := usedByPeople[key]; taken {
			continue
		}
		current, exists := best[key]
		if exists && current.Confidence >= confidence {
			continue
		}
		best[key] = resolvedSpeakerName{
			SpeakerID:  speaker.ID,
			Name:       name,
			Confidence: confidence,
			Evidence:   truncateTranscriptionInsightText(strings.Join(strings.Fields(item.Evidence), " "), 300),
			Apply:      autoApply && confidence >= speakerAutoApplyConfidence,
		}
	}
	// A label can still appear for two names; keep its most confident one.
	perSpeaker := map[uuid.UUID]resolvedSpeakerName{}
	for _, resolved := range best {
		if current, exists := perSpeaker[resolved.SpeakerID]; !exists || resolved.Confidence > current.Confidence {
			perSpeaker[resolved.SpeakerID] = resolved
		}
	}
	result := make([]resolvedSpeakerName, 0, len(perSpeaker))
	for _, resolved := range perSpeaker {
		result = append(result, resolved)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func (a *App) identifyTranscriptionSpeakers(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request speakerIdentifyRequest
	if c.Request.ContentLength != 0 && !decodeJSON(c, &request) {
		return
	}
	autoApply := request.AutoApply == nil || *request.AutoApply

	var endpointID uuid.NullUUID
	var grammarModel, title string
	var storedParticipants []byte
	if err := a.DB.QueryRowContext(c, `SELECT grammar_endpoint_id, COALESCE(grammar_model, ''), title, participants FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&endpointID, &grammarModel, &title, &storedParticipants); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !endpointID.Valid {
		writeError(c, http.StatusBadRequest, fmt.Errorf("configure a grammar/chat endpoint before identifying speakers"))
		return
	}
	endpoint, err := a.providerEndpoint(c, endpointID.UUID)
	if err != nil || !endpointSupports(endpoint, "chat") {
		writeError(c, http.StatusBadRequest, fmt.Errorf("the configured grammar endpoint does not support chat"))
		return
	}
	endpoint.ChatModel = firstNonEmptyString(grammarModel, endpoint.ChatModel)

	var participants []speakerParticipant
	if request.Participants != nil {
		participants = normalizeSpeakerParticipants(*request.Participants)
		encoded, _ := json.Marshal(participants)
		if _, err := a.DB.ExecContext(c, `UPDATE transcription_sessions SET participants = $2, updated_at = now() WHERE id = $1`, sessionID, encoded); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	} else {
		_ = json.Unmarshal(storedParticipants, &participants)
	}

	speakers, err := loadTranscriptionSpeakers(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	segments, err := loadTranscriptionSegments(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	candidates := 0
	for _, speaker := range speakers {
		if !speakerNameProtected(speaker) {
			candidates++
		}
	}
	transcript := speakerTranscriptForIdentification(segments, speakers)
	if candidates == 0 || strings.TrimSpace(transcript) == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("there are no unnamed speakers with transcript text to identify"))
		return
	}

	callContext, cancel := context.WithTimeout(c, transcriptionInsightCallTimeout)
	defer cancel()
	var output strings.Builder
	err = provider.StreamChat(callContext, endpoint, provider.ChatOptions{
		Model: endpoint.ChatModel,
		Messages: []provider.Message{
			{Role: "system", Content: speakerIdentifySystemPrompt},
			{Role: "user", Content: buildSpeakerIdentifyInput(title, transcript, participants, speakers)},
		},
	}, func(delta string) error {
		output.WriteString(delta)
		return nil
	})
	if err != nil {
		writeError(c, http.StatusBadGateway, fmt.Errorf("speaker identification failed: %w", err))
		return
	}
	items, err := decodeSpeakerIdentifications(output.String())
	if err != nil {
		writeError(c, http.StatusBadGateway, fmt.Errorf("speaker identification failed: %w", err))
		return
	}

	for _, resolved := range resolveSpeakerIdentifications(items, speakers, participants, autoApply) {
		if resolved.Apply {
			if _, err := a.DB.ExecContext(c, `UPDATE transcription_speakers SET display_name = $3, name_source = 'ai', suggested_name = '', suggestion_confidence = $4, suggestion_evidence = $5, updated_at = now() WHERE id = $1 AND session_id = $2`, resolved.SpeakerID, sessionID, resolved.Name, resolved.Confidence, resolved.Evidence); err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			a.Live.broadcast(sessionID, "transcription.speaker", ginData{"speakerId": resolved.SpeakerID, "displayName": resolved.Name})
			continue
		}
		if _, err := a.DB.ExecContext(c, `UPDATE transcription_speakers SET suggested_name = $3, suggestion_confidence = $4, suggestion_evidence = $5, updated_at = now() WHERE id = $1 AND session_id = $2`, resolved.SpeakerID, sessionID, resolved.Name, resolved.Confidence, resolved.Evidence); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	updated, err := loadTranscriptionSpeakers(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"speakers": updated, "participants": participants})
}

// dismissTranscriptionSpeakerSuggestion drops a pending name suggestion.
// Accepting one goes through the regular rename endpoint.
func (a *App) dismissTranscriptionSpeakerSuggestion(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	speakerID, err := uuid.Parse(c.Param("speakerId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid speaker id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	result, err := a.DB.ExecContext(c, `UPDATE transcription_speakers SET suggested_name = '', suggestion_confidence = 0, suggestion_evidence = '', updated_at = now() WHERE id = $1 AND session_id = $2`, speakerID, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		writeError(c, http.StatusNotFound, fmt.Errorf("speaker not found"))
		return
	}
	c.Status(http.StatusNoContent)
}
