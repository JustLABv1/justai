package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/models"
	"justai-backend/provider"
)

// When live detection misses the call of the next agenda item, the running item swallows
// it. An AI model then reads the transcript and proposes where the next item began. The
// user can accept or reject the proposal; without an answer it is applied.
const (
	// topicAIGrace: an item counts as overdue this long after its planned start.
	topicAIGrace = 15 * time.Minute
	// topicAICheckEvery spaces the checks of one running item.
	topicAICheckEvery = 10 * time.Minute
	// topicAIDecisionWindow is how long the user has to decide.
	topicAIDecisionWindow = 10 * time.Minute
	// topicAIMaxLines bounds what one request sends to the model, topicAIMaxWindows the
	// requests of one check.
	topicAIMaxLines   = 500
	topicAIMaxWindows = 6
	// topicAIFollowing is how many later items the model may choose from.
	topicAIFollowing = 3
)

// topicAICue marks lines worth showing the model: the chair's calls, item numbers and
// procedure words. Lines around them are sent as context.
var topicAICue = regexp.MustCompile(`(?i)\b(rufe|kommen|einzelpl|tagesordnung|zusatzpunkt|bundesministerium|geschäftsbereich|aussprache|abstimmung|beschlussempfehlung|drucksache|berichterstatt|eröffne|schließe)`)

type topicAIItem struct {
	ID     uuid.UUID
	Label  string
	Title  string
	Starts *time.Time
}

type topicAILine struct {
	StartMs int64
	Text    string
}

type topicAIAnswer struct {
	Found  bool   `json:"found"`
	Item   int    `json:"item"`
	Line   int    `json:"line"`
	Quote  string `json:"quote"`
	Reason string `json:"reason"`
}

func (m *TranscriptionManager) topicBoundaryLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		m.applyDueBoundaryProposals(ctx)
		m.checkTopicBoundaries(ctx)
	}
}

// applyDueBoundaryProposals lets the AI decide where the user did not.
func (m *TranscriptionManager) applyDueBoundaryProposals(ctx context.Context) {
	rows, err := m.DB.QueryContext(ctx, `SELECT id FROM transcription_topics WHERE boundary_status = 'pending' AND boundary_deadline <= now()`)
	if err != nil {
		return
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		if _, err := m.decideBoundaryProposal(ctx, id, true, "ai"); err != nil {
			slog.Warn("applying a topic boundary proposal failed", "topicId", id, "error", err)
		}
	}
}

// checkTopicBoundaries finds sessions whose latest recorded item may have swallowed an
// overdue one and asks the model about each.
func (m *TranscriptionManager) checkTopicBoundaries(ctx context.Context) {
	if m.app == nil {
		return
	}
	// The latest recorded item per session, while a later planned item is overdue.
	rows, err := m.DB.QueryContext(ctx, `SELECT p.id FROM transcription_topics p
		JOIN transcription_sessions s ON s.id = p.session_id
		WHERE s.archived_at IS NULL AND (s.ended_at IS NULL OR s.ended_at > now() - interval '1 day')
		AND p.status IN ('active', 'done') AND p.detected_by <> 'missed' AND p.started_offset_ms IS NOT NULL
		AND p.boundary_status IN ('none', 'rejected', 'accepted')
		AND (p.boundary_checked_at IS NULL OR p.boundary_checked_at < now() - $1 * interval '1 second')
		AND NOT EXISTS (SELECT 1 FROM transcription_topics q WHERE q.session_id = p.session_id AND q.status IN ('active', 'done') AND q.detected_by <> 'missed' AND q.started_offset_ms > p.started_offset_ms)
		AND EXISTS (SELECT 1 FROM transcription_topics n WHERE n.session_id = p.session_id AND n.status = 'planned' AND n.sort_order > p.sort_order
			AND n.planned_start_at < now() - $2 * interval '1 second' AND n.planned_start_at > now() - interval '2 days')`,
		topicAICheckEvery.Seconds(), topicAIGrace.Seconds())
	if err != nil {
		return
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		if err := m.proposeTopicBoundary(ctx, id); err != nil {
			slog.Warn("topic boundary check failed", "topicId", id, "error", err)
		}
	}
}

// proposeTopicBoundary asks the model whether one of the following items was called up
// inside the running topic, and stores the answer as a proposal.
func (m *TranscriptionManager) proposeTopicBoundary(ctx context.Context, topicID uuid.UUID) error {
	topic, err := loadTopic(ctx, m.DB, topicID)
	if err != nil || topic.StartedOffsetMs == nil {
		return err
	}
	from := *topic.StartedOffsetMs
	var floor sql.NullInt64
	var checkedUntil sql.NullInt64
	if err := m.DB.QueryRowContext(ctx, `SELECT CASE WHEN boundary_status = 'rejected' THEN boundary_offset_ms END, boundary_checked_until_ms FROM transcription_topics WHERE id = $1`, topicID).Scan(&floor, &checkedUntil); err != nil {
		return err
	}
	if floor.Valid && floor.Int64 > from {
		from = floor.Int64 // never propose the rejected point again, nor anything before it
	}
	to := m.app.currentTranscriptOffset(ctx, topic.SessionID)
	if topic.EndedOffsetMs != nil {
		to = *topic.EndedOffsetMs
	}
	// Claim the check; a finished topic whose range was already read is not read again.
	claim, err := m.DB.ExecContext(ctx, `UPDATE transcription_topics SET boundary_checked_at = now(), boundary_checked_until_ms = $3
		WHERE id = $1 AND boundary_status <> 'pending' AND (boundary_checked_at IS NULL OR boundary_checked_at < now() - $2 * interval '1 second')
		AND NOT ($4 AND boundary_checked_until_ms IS NOT NULL AND boundary_checked_until_ms >= $3)`,
		topicID, topicAICheckEvery.Seconds(), to, topic.Status == "done")
	if err != nil {
		return err
	}
	if n, _ := claim.RowsAffected(); n == 0 {
		return nil
	}

	following, err := m.followingTopics(ctx, topic)
	if err != nil || len(following) == 0 {
		return err
	}
	lines, err := m.topicAILines(ctx, topic, from, to, following)
	if err != nil || len(lines) == 0 {
		return err
	}
	endpoint, _, err := m.app.transcriptionChatEndpoint(ctx, topic.SessionID)
	if err != nil {
		return err
	}
	// Long ranges are read in windows, earliest first, since the first call matters.
	var answer topicAIAnswer
	var window []topicAILine
	for begin, asked := 0, 0; begin < len(lines) && asked < topicAIMaxWindows; asked++ {
		window = lines[begin:min(len(lines), begin+topicAIMaxLines)]
		if answer, err = askTopicBoundary(ctx, endpoint, topic, following, window); err != nil {
			return err
		}
		if answer.Found {
			break
		}
		begin += topicAIMaxLines - 5 // overlap, so a call split at the edge is seen whole
	}
	if !answer.Found || answer.Item < 1 || answer.Item > len(following) || answer.Line < 1 || answer.Line > len(window) {
		return nil
	}
	lines = window
	at := lines[callStartLine(lines, answer.Line-1)].StartMs
	if at <= from || at <= *topic.StartedOffsetMs {
		return nil
	}
	quote := truncateRunes(strings.TrimSpace(answer.Quote), 300)
	if quote == "" {
		quote = truncateRunes(lines[answer.Line-1].Text, 300)
	}
	result, err := m.DB.ExecContext(ctx, `UPDATE transcription_topics SET boundary_status = 'pending', boundary_topic_id = $2, boundary_offset_ms = $3, boundary_quote = $4, boundary_reason = $5, boundary_deadline = now() + $6 * interval '1 second', updated_at = now()
		WHERE id = $1 AND boundary_status <> 'pending'`, topicID, following[answer.Item-1].ID, at, quote, truncateRunes(strings.TrimSpace(answer.Reason), 300), topicAIDecisionWindow.Seconds())
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n > 0 {
		liveStreamEvents.inc("topic_boundary_proposed")
		m.broadcastTopic(topic.SessionID, topicID)
	}
	return nil
}

// topicCallReach is how far before the chosen line a call may have begun.
const topicCallReach = 15_000

// callStartLine moves a boundary the model put on the line naming the item ("60
// Allgemeine Finanzverwaltung.") back to the line where the chair began the call
// ("Ich rufe die Einzelpläne 32 Bundesschuld und"), so the item's transcript starts
// with its call.
func callStartLine(lines []topicAILine, i int) int {
	if opensTopicCall(lines[i].Text) {
		return i
	}
	for j := i - 1; j >= max(0, i-2); j-- {
		if lines[j+1].StartMs-lines[j].StartMs > topicCallReach {
			break
		}
		if opensTopicCall(lines[j].Text) {
			return j
		}
	}
	return i
}

// followingTopics are the next planned items after the topic, in agenda order.
func (m *TranscriptionManager) followingTopics(ctx context.Context, topic models.TranscriptionTopic) ([]topicAIItem, error) {
	rows, err := m.DB.QueryContext(ctx, `SELECT id, label, title, planned_start_at FROM transcription_topics
		WHERE session_id = $1 AND status = 'planned' AND sort_order > $2 AND (source_id IS NULL OR $3::uuid IS NULL OR source_id = $3)
		ORDER BY sort_order LIMIT $4`, topic.SessionID, topic.Order, topic.SourceID, topicAIFollowing)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []topicAIItem
	for rows.Next() {
		var item topicAIItem
		var starts sql.NullTime
		if err := rows.Scan(&item.ID, &item.Label, &item.Title, &starts); err != nil {
			return nil, err
		}
		if starts.Valid {
			item.Starts = &starts.Time
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// topicAILines picks the lines worth reading: cue lines with two lines of context each.
func (m *TranscriptionManager) topicAILines(ctx context.Context, topic models.TranscriptionTopic, from, to int64, following []topicAIItem) ([]topicAILine, error) {
	rows, err := m.DB.QueryContext(ctx, `SELECT text, start_offset_ms FROM transcription_segments
		WHERE session_id = $1 AND canonical AND start_offset_ms > $2 AND start_offset_ms <= $3 AND ($4::uuid IS NULL OR source_id IS NULL OR source_id = $4)
		ORDER BY start_offset_ms, created_at`, topic.SessionID, from, to, topic.SourceID)
	if err != nil {
		return nil, err
	}
	var all []topicAILine
	for rows.Next() {
		var line topicAILine
		if rows.Scan(&line.Text, &line.StartMs) == nil {
			all = append(all, line)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var words []string
	for _, item := range following {
		words = append(words, titleTokens(item.Title)...)
	}
	keep := make([]bool, len(all))
	for i, line := range all {
		lower := strings.ToLower(line.Text)
		cue := topicAICue.MatchString(lower)
		for _, w := range words {
			if cue {
				break
			}
			cue = strings.Contains(lower, w)
		}
		if !cue {
			continue
		}
		for j := max(0, i-2); j <= min(len(all)-1, i+2); j++ {
			keep[j] = true
		}
	}
	var out []topicAILine
	for i, line := range all {
		if keep[i] {
			out = append(out, line)
		}
	}
	return out, nil
}

const topicAISystemPrompt = `You read live transcripts of German Bundestag sittings. The speech recognition makes mistakes: words and numbers can be misheard, sentences can be split across lines, and short phrases can be hallucinated (for example "Thank you." or text in another language).

Find the first line where the presiding officer calls up one of the listed agenda items, that is the moment the item's deliberation begins. Typical calls are "Ich rufe ... auf", "Wir kommen (jetzt) zu(m) ...", "Kommen wir zu ...", usually followed by the item's Einzelplan or Tagesordnungspunkt number, its ministry or its title. A misheard number still counts when the ministry or title fits.

Not a call: a speaker mentioning an item in a speech, a vote on the item that is running ("Wir kommen zur Abstimmung über ..."), or a reference to another day.

Answer only with JSON:
{"found": true, "item": <number of the item in the list>, "line": <line number>, "quote": "<the calling words as transcribed>", "reason": "<one short sentence in German>"}
or {"found": false} when no line clearly calls up one of the items.`

func askTopicBoundary(ctx context.Context, endpoint provider.Endpoint, topic models.TranscriptionTopic, following []topicAIItem, lines []topicAILine) (topicAIAnswer, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "Running item: %s\n\nItems that may follow, in agenda order:\n", strings.TrimSpace(topic.Label+" "+topic.Title))
	for i, item := range following {
		fmt.Fprintf(&b, "%d. %s", i+1, strings.TrimSpace(item.Label+" – "+item.Title))
		if item.Starts != nil {
			fmt.Fprintf(&b, " (planned %s)", item.Starts.UTC().Format("15:04 UTC"))
		}
		b.WriteString("\n")
	}
	b.WriteString("\nTranscript lines (number | time in the recording | text). Lines without procedural words are left out; a gap is marked with …\n")
	for i, line := range lines {
		if i > 0 && line.StartMs-lines[i-1].StartMs > 15000 {
			b.WriteString("…\n")
		}
		fmt.Fprintf(&b, "%d | %s | %s\n", i+1, offsetClock(line.StartMs), line.Text)
	}
	ask := func() (topicAIAnswer, error) {
		callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		var output strings.Builder
		err := provider.StreamChat(callCtx, endpoint, provider.ChatOptions{
			Model:    endpoint.ChatModel,
			Messages: []provider.Message{{Role: "system", Content: topicAISystemPrompt}, {Role: "user", Content: b.String()}},
		}, func(delta string) error {
			output.WriteString(delta)
			return nil
		})
		if err != nil {
			return topicAIAnswer{}, err
		}
		return decodeTopicAIAnswer(output.String())
	}
	answer, err := ask()
	if err != nil && ctx.Err() == nil {
		answer, err = ask() // one retry for empty or malformed answers
	}
	return answer, err
}

func decodeTopicAIAnswer(value string) (topicAIAnswer, error) {
	start, end := strings.Index(value, "{"), strings.LastIndex(value, "}")
	if start < 0 || end <= start {
		return topicAIAnswer{}, fmt.Errorf("the model did not answer with JSON")
	}
	var answer topicAIAnswer
	if err := json.Unmarshal([]byte(value[start:end+1]), &answer); err != nil {
		return topicAIAnswer{}, fmt.Errorf("the model answered with invalid JSON: %w", err)
	}
	return answer, nil
}

func offsetClock(ms int64) string {
	total := ms / 1000
	return fmt.Sprintf("%d:%02d:%02d", total/3600, total/60%60, total%60)
}

func truncateRunes(value string, limit int) string {
	if runes := []rune(value); len(runes) > limit {
		return string(runes[:limit-1]) + "…"
	}
	return value
}

var errNoBoundaryProposal = errors.New("there is no open proposal for this topic")

// decideBoundaryProposal accepts or rejects a pending proposal. An accepted one ends the
// topic at the proposed point and starts the proposed item there. It returns the topic
// the proposal started, if any.
func (m *TranscriptionManager) decideBoundaryProposal(ctx context.Context, topicID uuid.UUID, accept bool, by string) (uuid.UUID, error) {
	status := "rejected"
	if accept {
		status = "accepted"
	}
	var next uuid.NullUUID
	var at sql.NullInt64
	err := m.DB.QueryRowContext(ctx, `UPDATE transcription_topics SET boundary_status = $2, boundary_deadline = NULL, boundary_checked_at = now(), boundary_checked_until_ms = NULL, updated_at = now()
		WHERE id = $1 AND boundary_status = 'pending' RETURNING boundary_topic_id, boundary_offset_ms`, topicID, status).Scan(&next, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return uuid.Nil, errNoBoundaryProposal
	}
	if err != nil {
		return uuid.Nil, err
	}
	topic, err := loadTopic(ctx, m.DB, topicID)
	if err != nil {
		return uuid.Nil, err
	}
	if !accept {
		liveStreamEvents.inc("topic_boundary_rejected")
		m.broadcastTopic(topic.SessionID, topicID)
		return uuid.Nil, nil
	}
	liveStreamEvents.inc("topic_boundary_accepted_" + by)
	if !next.Valid || !at.Valid {
		return uuid.Nil, nil
	}
	sourceID := uuid.Nil
	if topic.SourceID != nil {
		sourceID = *topic.SourceID
	}
	switch topic.Status {
	case "active":
		m.switchTopic(ctx, topic.SessionID, sourceID, next.UUID, at.Int64, by)
	case "done":
		if !m.splitTopicAt(ctx, topic, next.UUID, at.Int64, by) {
			m.broadcastTopic(topic.SessionID, topicID)
			return uuid.Nil, nil // the proposed item has started some other way meanwhile
		}
		m.topicFinished(topic.SessionID, topic.ID)
		m.topicFinished(topic.SessionID, next.UUID)
	}
	if sourceID != uuid.Nil {
		m.applyTopicScope(ctx, topic.SessionID, sourceID)
	}
	m.broadcastTopic(topic.SessionID, topicID)
	m.broadcastTopic(topic.SessionID, next.UUID)
	return next.UUID, nil
}

// decideTopicBoundary: POST /transcription/topics/:id/boundary {"decision": "accept"|"reject"}.
func (a *App) decideTopicBoundary(c *gin.Context) {
	topic, ok := a.authorizeTopic(c)
	if !ok {
		return
	}
	var request struct {
		Decision string `json:"decision"`
	}
	if err := c.ShouldBindJSON(&request); err != nil || (request.Decision != "accept" && request.Decision != "reject") {
		writeError(c, http.StatusBadRequest, fmt.Errorf("decision must be accept or reject"))
		return
	}
	if _, err := a.Live.decideBoundaryProposal(c, topic.ID, request.Decision == "accept", "manual"); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errNoBoundaryProposal) {
			status = http.StatusConflict
		}
		writeError(c, status, err)
		return
	}
	topics, err := loadTopics(c, a.DB, topic.SessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"topics": topics})
}
