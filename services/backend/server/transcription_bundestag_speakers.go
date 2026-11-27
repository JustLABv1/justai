package server

import (
	"context"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"justai-backend/models"
)

// In a Bundestag sitting the chair calls up every speaker by name ("Das Wort hat die
// Kollegin Anna Müller für die SPD-Fraktion."). Everything said until the chair speaks
// again belongs to that person, so the transcript can carry real names while it is
// being written, and later the voices found by speaker separation can be named the
// same way.

const (
	parliamentSpeakerPrefix = "Bundestag · "
	parliamentChairName     = "Sitzungsleitung"
)

type announcedSpeaker struct {
	Name  string
	Group string // parliamentary group, e.g. "SPD"
	Role  string // government office when the speaker is a member of the government
}

func (s announcedSpeaker) displayName() string {
	switch {
	case s.Group != "":
		return s.Name + " (" + s.Group + ")"
	case s.Role != "":
		return s.Name + " (" + s.Role + ")"
	default:
		return s.Name
	}
}

const (
	speakerRolePattern = `(?:Kollegin|Kollegen|Kollege|Abgeordneten|Abgeordnete|Bundeskanzlerin|Bundeskanzler|Bundesministerin|Bundesminister|Staatsministerin|Staatsminister|Ministerin|Minister|Parlamentarischen Staatssekretärin|Parlamentarische Staatssekretärin|Parlamentarischen Staatssekretär|Parlamentarische Staatssekretär|Staatssekretärin|Staatssekretär|Frau|Herrn|Herr)`
	speakerNamePattern = `((?:(?:Dr\.|Prof\.)\s+)*[A-ZÄÖÜ][\p{L}’'-]+(?:\s+(?:(?:von|van|de|zu|der|den)\s+)*[A-ZÄÖÜ][\p{L}’'-]+){1,3})`
	speakerLeadPattern = `(?:(?:die|der|dem|den)\s+)?(?:(` + speakerRolePattern + `)\s+)?`
)

var (
	speakerAnnouncements = []*regexp.Regexp{
		regexp.MustCompile(`(?i:das\s+wort\s+hat)\s+(?i:(?:jetzt|nun|zunächst|als\s+nächste[rs]?(?:\s+(?:rednerin|redner))?)\s+)?` + speakerLeadPattern + speakerNamePattern),
		regexp.MustCompile(`(?i:nächste[rs]?\s+(?:rednerin|redner)(?:\s+in\s+der\s+debatte)?(?:\s+ist)?)\s*:?\s+` + speakerLeadPattern + speakerNamePattern),
		regexp.MustCompile(`(?i:ich\s+erteile)\s+(?i:(?:jetzt|nun)\s+)?(?i:das\s+wort\s+)?` + speakerLeadPattern + speakerNamePattern),
		regexp.MustCompile(`(?i:es\s+spricht|spricht\s+(?:jetzt|nun))\s+` + speakerLeadPattern + speakerNamePattern),
	}
	// Words that end up capitalised after an announcement phrase but are no names.
	speakerNameStopwords = map[string]bool{"fraktion": true, "bundesregierung": true, "kollegin": true, "kollege": true, "kollegen": true, "damen": true, "herren": true,
		"präsident": true, "präsidentin": true, "wort": true, "debatte": true, "aussprache": true, "tagesordnungspunkt": true, "zusatzpunkt": true, "antrag": true}
	parliamentGroups = []struct {
		pattern *regexp.Regexp
		name    string
	}{
		{regexp.MustCompile(`(?i)\bcdu\s*[/-]?\s*csu\b|\bunion\b|\bcdu\b|\bcsu\b`), "CDU/CSU"},
		{regexp.MustCompile(`(?i)\bspd\b`), "SPD"},
		{regexp.MustCompile(`(?i)\bafd\b`), "AfD"},
		{regexp.MustCompile(`(?i)bündnis\s*90|\bgrünen?\b`), "Bündnis 90/Die Grünen"},
		{regexp.MustCompile(`(?i)\blinken?\b`), "Die Linke"},
		{regexp.MustCompile(`(?i)\bfdp\b`), "FDP"},
		{regexp.MustCompile(`(?i)\bbsw\b`), "BSW"},
	}
	chairClosing = regexp.MustCompile(`(?i)^\s*(?:(?:vielen|herzlichen)\s+dank|danke(?:\s+schön)?)\b[^.!?]{0,60}\b(?:kolleg|herr|frau|minister|staatssekretär)|ich\s+schließe\s+die\s+aussprache|weitere\s+wortmeldungen\s+liegen\s+nicht\s+vor`)
)

// parseSpeakerAnnouncement finds the chair calling up the next speaker.
func parseSpeakerAnnouncement(text string) (announcedSpeaker, bool) {
	for _, pattern := range speakerAnnouncements {
		match := pattern.FindStringSubmatchIndex(text)
		if match == nil {
			continue
		}
		role := ""
		if match[2] >= 0 {
			role = text[match[2]:match[3]]
		}
		name := strings.TrimSpace(text[match[4]:match[5]])
		valid := true
		for _, word := range strings.Fields(name) {
			if speakerNameStopwords[strings.ToLower(strings.Trim(word, ".,"))] {
				valid = false
				break
			}
		}
		if !valid || len(strings.Fields(strings.ReplaceAll(strings.ReplaceAll(name, "Dr.", ""), "Prof.", ""))) < 2 {
			continue
		}
		speaker := announcedSpeaker{Name: name}
		// The group is named right around the announcement ("für die SPD-Fraktion").
		around := text[max(0, match[0]-60):min(len(text), match[1]+80)]
		for _, group := range parliamentGroups {
			if group.pattern.MatchString(around) {
				speaker.Group = group.name
				break
			}
		}
		if lower := strings.ToLower(role); strings.Contains(lower, "minister") || strings.Contains(lower, "kanzler") || strings.Contains(lower, "staatssekretär") {
			// "Parlamentarischen Staatssekretär" → "Staatssekretär"
			words := strings.Fields(role)
			speaker.Role = words[len(words)-1]
		}
		return speaker, true
	}
	return announcedSpeaker{}, false
}

// isChairClosing recognises the chair thanking the speaker or closing the debate: the
// speaker's turn is over.
func isChairClosing(text string) bool {
	return len(strings.Fields(text)) <= 40 && chairClosing.MatchString(text)
}

// speakerTurnLabels walks the transcript in order and returns, per segment, who the
// chair's announcements say is speaking ("" when unknown).
func speakerTurnLabels(segments []models.TranscriptionSegment) []string {
	labels := make([]string, len(segments))
	current := ""
	for i, segment := range segments {
		text := segmentText(segment)
		if speaker, ok := parseSpeakerAnnouncement(text); ok {
			labels[i] = parliamentChairName
			current = speaker.displayName()
			continue
		}
		if isChairClosing(text) {
			labels[i] = parliamentChairName
			current = ""
			continue
		}
		labels[i] = current
	}
	return labels
}

func segmentText(segment models.TranscriptionSegment) string {
	if segment.EditedText != nil && strings.TrimSpace(*segment.EditedText) != "" {
		return *segment.EditedText
	}
	return segment.Text
}

// ---- live ----

type parliamentFlag struct {
	yes     bool
	checked time.Time
}

var (
	parliamentSessions sync.Map // session id -> parliamentFlag
	currentSpeakers    sync.Map // source id -> speaker id of the running turn
)

// isParliamentSession reports whether a session follows a Bundestag sitting (it has
// agenda items). A negative answer is re-checked after a few minutes, since the
// agenda items can be loaded later.
func (m *TranscriptionManager) isParliamentSession(ctx context.Context, sessionID uuid.UUID) bool {
	if cached, ok := parliamentSessions.Load(sessionID); ok {
		flag := cached.(parliamentFlag)
		if flag.yes || time.Since(flag.checked) < 5*time.Minute {
			return flag.yes
		}
	}
	var yes bool
	if err := m.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM transcription_topics WHERE session_id = $1)`, sessionID).Scan(&yes); err != nil {
		return false
	}
	parliamentSessions.Store(sessionID, parliamentFlag{yes: yes, checked: time.Now()})
	return yes
}

// observeSpeakers names the speaker of a new live segment from the chair's announcements.
func (m *TranscriptionManager) observeSpeakers(ctx context.Context, sessionID, sourceID, segmentID uuid.UUID, text string) {
	if !m.isParliamentSession(ctx, sessionID) {
		return
	}
	var speakerID uuid.UUID
	if announced, ok := parseSpeakerAnnouncement(text); ok {
		chair, err := m.ensureParliamentSpeaker(ctx, sessionID, parliamentChairName)
		if err != nil {
			return
		}
		next, err := m.ensureParliamentSpeaker(ctx, sessionID, announced.displayName())
		if err != nil {
			return
		}
		currentSpeakers.Store(sourceID, next)
		speakerID = chair
	} else if isChairClosing(text) {
		chair, err := m.ensureParliamentSpeaker(ctx, sessionID, parliamentChairName)
		if err != nil {
			return
		}
		currentSpeakers.Delete(sourceID)
		speakerID = chair
	} else if current, ok := currentSpeakers.Load(sourceID); ok {
		speakerID = current.(uuid.UUID)
	} else {
		return
	}
	result, err := m.DB.ExecContext(ctx, `UPDATE transcription_segments SET speaker_id = $2, updated_at = now() WHERE id = $1 AND speaker_id IS NULL`, segmentID, speakerID)
	if err != nil {
		return
	}
	if changed, _ := result.RowsAffected(); changed > 0 {
		m.broadcast(sessionID, "transcription.segment.updated", ginData{"segmentId": segmentID, "speakerId": speakerID})
	}
}

// ensureParliamentSpeaker returns the speaker row for an announced name, creating it
// named. A name the user changed later is kept.
func (m *TranscriptionManager) ensureParliamentSpeaker(ctx context.Context, sessionID uuid.UUID, name string) (uuid.UUID, error) {
	label := parliamentSpeakerPrefix + name
	var speaker models.TranscriptionSpeaker
	var created bool
	err := m.DB.QueryRowContext(ctx, `
		INSERT INTO transcription_speakers (session_id, label, color, display_name, name_source)
		VALUES ($1, $2, $3, $4, 'ai')
		ON CONFLICT (session_id, label) DO UPDATE SET label = EXCLUDED.label
		RETURNING id, session_id, label, display_name, color, name_source, (xmax = 0)`, sessionID, label, speakerColor(label), name).
		Scan(&speaker.ID, &speaker.SessionID, &speaker.Label, &speaker.DisplayName, &speaker.Color, &speaker.NameSource, &created)
	if err != nil {
		return uuid.Nil, err
	}
	if created {
		m.broadcast(sessionID, "transcription.speaker", ginData{"speakerId": speaker.ID, "displayName": speaker.DisplayName, "speaker": speaker})
	}
	return speaker.ID, nil
}

// ---- after speaker separation ----

// nameSpeakersFromAnnouncements names the voices found by speaker separation: a voice
// that mostly speaks during one announced turn gets that person's name. Speakers the
// user named are left alone. Rows created live that no longer have segments go away.
func (m *TranscriptionManager) nameSpeakersFromAnnouncements(ctx context.Context, sessionID uuid.UUID) error {
	if !m.isParliamentSession(ctx, sessionID) {
		return nil
	}
	return m.nameSpeakersFromTurns(ctx, sessionID)
}

// nameSpeakersFromTurns is nameSpeakersFromAnnouncements for a transcript known to be
// a parliament debate, such as an agenda item's own transcript.
func (m *TranscriptionManager) nameSpeakersFromTurns(ctx context.Context, sessionID uuid.UUID) error {
	segments, err := loadTranscriptionSegments(ctx, m.DB, sessionID)
	if err != nil {
		return err
	}
	speakers, err := loadTranscriptionSpeakers(ctx, m.DB, sessionID)
	if err != nil {
		return err
	}
	names := speakerNamesFromTurns(segments, speakerTurnLabels(segments))
	for _, speaker := range speakers {
		name, ok := names[speaker.ID]
		if !ok || strings.HasPrefix(speaker.Label, parliamentSpeakerPrefix) || speaker.NameSource == "manual" || speaker.DisplayName != "" {
			continue
		}
		if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_speakers SET display_name = $2, name_source = 'ai', updated_at = now() WHERE id = $1 AND name_source <> 'manual'`, speaker.ID, name); err != nil {
			return err
		}
		m.broadcast(sessionID, "transcription.speaker", ginData{"speakerId": speaker.ID, "displayName": name})
	}
	_, err = m.DB.ExecContext(ctx, `DELETE FROM transcription_speakers sp WHERE sp.session_id = $1 AND sp.label LIKE $2 AND NOT EXISTS (SELECT 1 FROM transcription_segments seg WHERE seg.speaker_id = sp.id)`, sessionID, parliamentSpeakerPrefix+"%")
	return err
}

// speakerNamesFromTurns picks, per speaker, the announced name it speaks under most:
// at least 60 % of its speaking time and 20 seconds.
func speakerNamesFromTurns(segments []models.TranscriptionSegment, labels []string) map[uuid.UUID]string {
	totals := map[uuid.UUID]int64{}
	byName := map[uuid.UUID]map[string]int64{}
	for i, segment := range segments {
		if segment.SpeakerID == nil {
			continue
		}
		duration := max(segment.EndOffsetMs-segment.StartOffsetMs, 1)
		totals[*segment.SpeakerID] += duration
		if labels[i] == "" {
			continue
		}
		if byName[*segment.SpeakerID] == nil {
			byName[*segment.SpeakerID] = map[string]int64{}
		}
		byName[*segment.SpeakerID][labels[i]] += duration
	}
	out := map[uuid.UUID]string{}
	for speaker, counts := range byName {
		best, bestMs := "", int64(0)
		for name, ms := range counts {
			if ms > bestMs || (ms == bestMs && name < best) {
				best, bestMs = name, ms
			}
		}
		if bestMs >= 20_000 && float64(bestMs) >= 0.6*float64(totals[speaker]) {
			out[speaker] = best
		}
	}
	return out
}
