package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

const topicColumns = `id, session_id, source_id, topic_key, sort_order, kind, label, title, planned_start_at, planned_end_at, status, started_offset_ms, ended_offset_ms, detected_by, starred, summary, summary_status, summary_error, updated_at, original_start_at, plan_changed_at, transcript_session_id`

func scanTopic(scan func(...any) error) (models.TranscriptionTopic, error) {
	var t models.TranscriptionTopic
	var source, transcript uuid.NullUUID
	var start, end sql.NullInt64
	var plannedStart, plannedEnd, originalStart, planChanged sql.NullTime
	if err := scan(&t.ID, &t.SessionID, &source, &t.Key, &t.Order, &t.Kind, &t.Label, &t.Title, &plannedStart, &plannedEnd, &t.Status, &start, &end, &t.DetectedBy, &t.Starred, &t.Summary, &t.SummaryStatus, &t.SummaryError, &t.UpdatedAt, &originalStart, &planChanged, &transcript); err != nil {
		return t, err
	}
	if source.Valid {
		t.SourceID = &source.UUID
	}
	if transcript.Valid {
		t.TranscriptSessionID = &transcript.UUID
	}
	if plannedStart.Valid {
		t.PlannedStartAt = &plannedStart.Time
	}
	if plannedEnd.Valid {
		t.PlannedEndAt = &plannedEnd.Time
	}
	if originalStart.Valid {
		t.OriginalStartAt = &originalStart.Time
	}
	if planChanged.Valid {
		t.PlanChangedAt = &planChanged.Time
	}
	if start.Valid {
		t.StartedOffsetMs = &start.Int64
	}
	if end.Valid {
		t.EndedOffsetMs = &end.Int64
	}
	return t, nil
}

func loadTopics(ctx context.Context, db *sql.DB, sessionID uuid.UUID) ([]models.TranscriptionTopic, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+topicColumns+` FROM transcription_topics WHERE session_id = $1 ORDER BY sort_order, created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.TranscriptionTopic{}
	for rows.Next() {
		t, err := scanTopic(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func loadTopic(ctx context.Context, db *sql.DB, topicID uuid.UUID) (models.TranscriptionTopic, error) {
	return scanTopic(db.QueryRowContext(ctx, `SELECT `+topicColumns+` FROM transcription_topics WHERE id = $1`, topicID).Scan)
}

// syncTopics stores the items of a sitting as planned topics. Items already opened keep
// their state; only planned ones follow later changes of the published plan. It returns
// the planned topics whose slot moved by more than a minute.
func syncTopics(ctx context.Context, db *sql.DB, sessionID, sourceID uuid.UUID, items []planItem) ([]uuid.UUID, error) {
	var moved []uuid.UUID
	for i, it := range items {
		numbers := make([]int64, len(it.Numbers))
		for n, v := range it.Numbers {
			numbers[n] = int64(v)
		}
		var source any
		if sourceID != uuid.Nil {
			source = sourceID
		}
		var id uuid.UUID
		var changed bool
		err := db.QueryRowContext(ctx, `
			INSERT INTO transcription_topics (session_id, source_id, topic_key, sort_order, kind, label, numbers, title, planned_start_at, planned_end_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (session_id, topic_key) DO UPDATE
			SET sort_order = $4, title = $8, planned_start_at = $9, planned_end_at = $10, updated_at = now(),
			    original_start_at = CASE WHEN `+topicSlotMoved+` THEN COALESCE(transcription_topics.original_start_at, transcription_topics.planned_start_at) ELSE transcription_topics.original_start_at END,
			    plan_changed_at = CASE WHEN `+topicSlotMoved+` THEN now() ELSE transcription_topics.plan_changed_at END
			WHERE transcription_topics.status = 'planned'
			RETURNING id, COALESCE(plan_changed_at = now(), FALSE)`,
			sessionID, source, it.Key, i, it.Kind, it.Label, pq.Array(numbers), it.Title, it.StartAt, it.EndAt).Scan(&id, &changed)
		if errors.Is(err, sql.ErrNoRows) {
			continue // the topic is already open or finished
		}
		if err != nil {
			return moved, err
		}
		if changed {
			moved = append(moved, id)
		}
	}
	return moved, nil
}

// topicSlotMoved compares the stored slot with the new one ($9, $10) in syncTopics.
const topicSlotMoved = `(transcription_topics.planned_start_at IS DISTINCT FROM $9 AND abs(extract(epoch FROM (transcription_topics.planned_start_at - $9))) > 60 OR transcription_topics.planned_end_at IS DISTINCT FROM $10 AND abs(extract(epoch FROM (transcription_topics.planned_end_at - $10))) > 60)`

func (m *TranscriptionManager) broadcastTopic(sessionID, topicID uuid.UUID) {
	if topic, err := loadTopic(context.Background(), m.DB, topicID); err == nil {
		m.broadcast(sessionID, "transcription.topic", ginData{"topic": topic})
	}
}

func (m *TranscriptionManager) loadOpenTopics(ctx context.Context, sessionID, sourceID uuid.UUID) ([]topicRef, error) {
	rows, err := m.DB.QueryContext(ctx, `SELECT id, kind, numbers, title, status FROM transcription_topics WHERE session_id = $1 AND (source_id IS NULL OR source_id = $2) AND status <> 'done' ORDER BY sort_order`, sessionID, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []topicRef
	for rows.Next() {
		var t topicRef
		var raw pq.Int64Array
		if err := rows.Scan(&t.ID, &t.Kind, &raw, &t.Title, &t.Status); err != nil {
			return nil, err
		}
		for _, n := range raw {
			t.Numbers = append(t.Numbers, int(n))
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// observeTopics reacts to a finished transcript segment: when the chair calls up an
// item, the previous item is finished at that moment and the new one opened.
func (m *TranscriptionManager) observeTopics(ctx context.Context, sessionID, sourceID uuid.UUID, text string, startOffsetMs int64) bool {
	if !mightAnnounceTopic(text) {
		return false
	}
	topics, err := m.loadOpenTopics(ctx, sessionID, sourceID)
	if err != nil || len(topics) == 0 {
		return false
	}
	if isSittingClosed(text) {
		m.finishActiveTopics(ctx, sessionID, sourceID, startOffsetMs, "sitting_closed")
		m.applyTopicScope(ctx, sessionID, sourceID)
		return false
	}
	idx := detectTopicAnnouncement(text, topics)
	if idx < 0 || topics[idx].Status == "active" {
		return false
	}
	m.switchTopic(ctx, sessionID, sourceID, topics[idx].ID, startOffsetMs, "announcement")
	m.applyTopicScope(ctx, sessionID, sourceID)
	return true
}

// switchTopic finishes the active topic and opens another at the given offset.
func (m *TranscriptionManager) switchTopic(ctx context.Context, sessionID, sourceID, topicID uuid.UUID, offsetMs int64, by string) {
	tx, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return
	}
	defer tx.Rollback()
	var closed []uuid.UUID
	rows, err := tx.QueryContext(ctx, `UPDATE transcription_topics SET status = 'done', ended_offset_ms = GREATEST($3, COALESCE(started_offset_ms, 0)), updated_at = now() WHERE session_id = $1 AND status = 'active' AND id <> $2 AND (source_id IS NULL OR source_id = $4) RETURNING id`, sessionID, topicID, offsetMs, sourceID)
	if err != nil {
		return
	}
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			closed = append(closed, id)
		}
	}
	_ = rows.Close()
	result, err := tx.ExecContext(ctx, `UPDATE transcription_topics SET status = 'active', started_offset_ms = $2, ended_offset_ms = NULL, detected_by = $3, source_id = COALESCE(source_id, $4), updated_at = now() WHERE id = $1 AND status = 'planned'`, topicID, offsetMs, by, sourceID)
	if err != nil {
		return
	}
	if opened, _ := result.RowsAffected(); opened == 0 {
		return
	}
	if err := tx.Commit(); err != nil {
		return
	}
	liveStreamEvents.inc("topic_started")
	for _, id := range closed {
		m.topicFinished(sessionID, id)
	}
	m.broadcastTopic(sessionID, topicID)
}

// finishActiveTopics ends whichever topic is open at the given offset.
func (m *TranscriptionManager) finishActiveTopics(ctx context.Context, sessionID, sourceID uuid.UUID, offsetMs int64, by string) {
	rows, err := m.DB.QueryContext(ctx, `UPDATE transcription_topics SET status = 'done', ended_offset_ms = GREATEST($3, COALESCE(started_offset_ms, 0)), detected_by = CASE WHEN detected_by = '' THEN $4 ELSE detected_by END, updated_at = now() WHERE session_id = $1 AND status = 'active' AND (source_id IS NULL OR source_id = $2) RETURNING id`, sessionID, sourceID, offsetMs, by)
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
	_ = rows.Close()
	for _, id := range ids {
		m.topicFinished(sessionID, id)
	}
}

// finishTopicsAtStreamEnd closes the open topic when a capture ends.
func (m *TranscriptionManager) finishTopicsAtStreamEnd(sessionID, sourceID uuid.UUID) {
	var last sql.NullInt64
	_ = m.DB.QueryRow(`SELECT MAX(end_offset_ms) FROM transcription_segments WHERE session_id = $1 AND (source_id = $2 OR source_id IS NULL)`, sessionID, sourceID).Scan(&last)
	m.finishActiveTopics(context.Background(), sessionID, sourceID, last.Int64, "stream_ended")
}

func (a *App) currentTranscriptOffset(ctx context.Context, sessionID uuid.UUID) int64 {
	var last sql.NullInt64
	_ = a.DB.QueryRowContext(ctx, `SELECT MAX(end_offset_ms) FROM transcription_segments WHERE session_id = $1`, sessionID).Scan(&last)
	return last.Int64
}

// ---- HTTP ----

func (a *App) authorizeTopic(c *gin.Context) (models.TranscriptionTopic, bool) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	topicID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid topic id"))
		return models.TranscriptionTopic{}, false
	}
	topic, err := loadTopic(c, a.DB, topicID)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("topic not found"))
		return topic, false
	}
	if err := a.authorizeTranscriptionSession(c, topic.SessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("topic not found"))
		return topic, false
	}
	return topic, true
}

func (a *App) listTranscriptionTopics(c *gin.Context) {
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
	topics, err := loadTopics(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"topics": topics})
}

// syncTranscriptionTopics loads the agenda items of a Bundestag sitting into a session.
// The sitting is taken from the followed plan or given as `sessionNo`.
func (a *App) syncTranscriptionTopics(c *gin.Context) {
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
	var request struct {
		SessionNo int `json:"sessionNo"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	var sourceID uuid.UUID
	var planKey string
	_ = a.DB.QueryRowContext(c, `SELECT source.id, stream.plan_key FROM transcription_sources source JOIN transcription_stream_sources stream ON stream.source_id = source.id WHERE source.session_id = $1 ORDER BY (stream.plan_key <> '') DESC, source.created_at LIMIT 1`, sessionID).Scan(&sourceID, &planKey)
	sessionNo := request.SessionNo
	if sessionNo == 0 {
		sessionNo = sittingNumberFromPlanKey(planKey)
	}
	if sessionNo <= 0 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("choose a Bundestag session to load its agenda items"))
		return
	}
	count, err := a.loadSittingTopics(c, sessionID, sourceID, sessionNo)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	topics, _ := loadTopics(c, a.DB, sessionID)
	c.JSON(http.StatusOK, gin.H{"topics": topics, "loaded": count})
}

func sittingNumberFromPlanKey(key string) int {
	if n, err := strconv.Atoi(strings.TrimPrefix(key, "bundestag-sitzung-")); err == nil && strings.HasPrefix(key, "bundestag-sitzung-") {
		return n
	}
	return 0
}

// loadSittingTopics reads the published plan and stores the items of one sitting.
func (a *App) loadSittingTopics(ctx context.Context, sessionID, sourceID uuid.UUID, sessionNo int) (int, error) {
	fetchCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	items, err := fetchBundestagAblaufplan(fetchCtx, provider.SafeHTTPClient(20*time.Second, a.Config.AllowPrivate))
	if err != nil {
		return 0, err
	}
	forSitting := plenaryItemsForSession(items, sessionNo)
	if len(forSitting) == 0 {
		return 0, fmt.Errorf("the planned course has no items for the %d. sitting", sessionNo)
	}
	if _, err := syncTopics(ctx, a.DB, sessionID, sourceID, forSitting); err != nil {
		return 0, err
	}
	return len(forSitting), nil
}

func (a *App) updateTranscriptionTopic(c *gin.Context) {
	topic, ok := a.authorizeTopic(c)
	if !ok {
		return
	}
	var request struct {
		Starred *bool `json:"starred"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.Starred != nil {
		if _, err := a.DB.ExecContext(c, `UPDATE transcription_topics SET starred = $2, updated_at = now() WHERE id = $1`, topic.ID, *request.Starred); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	updated, _ := loadTopic(c, a.DB, topic.ID)
	a.Live.broadcastTopic(topic.SessionID, topic.ID)
	if request.Starred != nil {
		// With "only selected topics" the selection decides when the capture runs.
		a.Live.rescheduleTopicCapture(c, topic.SessionID, false)
	}
	c.JSON(http.StatusOK, gin.H{"topic": updated})
}

// startTranscriptionTopic and finishTranscriptionTopic are the manual fallback when the
// chair's announcement was not recognised.
func (a *App) startTranscriptionTopic(c *gin.Context) {
	topic, ok := a.authorizeTopic(c)
	if !ok {
		return
	}
	var sourceID uuid.UUID
	if topic.SourceID != nil {
		sourceID = *topic.SourceID
	} else {
		_ = a.DB.QueryRowContext(c, `SELECT id FROM transcription_sources WHERE session_id = $1 ORDER BY created_at LIMIT 1`, topic.SessionID).Scan(&sourceID)
	}
	if topic.Status == "done" {
		writeError(c, http.StatusConflict, fmt.Errorf("this topic is already finished"))
		return
	}
	a.Live.switchTopic(c, topic.SessionID, sourceID, topic.ID, a.currentTranscriptOffset(c, topic.SessionID), "manual")
	a.Live.applyTopicScope(c, topic.SessionID, sourceID)
	updated, _ := loadTopic(c, a.DB, topic.ID)
	c.JSON(http.StatusOK, gin.H{"topic": updated})
}

func (a *App) finishTranscriptionTopic(c *gin.Context) {
	topic, ok := a.authorizeTopic(c)
	if !ok {
		return
	}
	if topic.Status != "active" {
		writeError(c, http.StatusConflict, fmt.Errorf("only the running topic can be finished"))
		return
	}
	offset := a.currentTranscriptOffset(c, topic.SessionID)
	if _, err := a.DB.ExecContext(c, `UPDATE transcription_topics SET status = 'done', ended_offset_ms = GREATEST($2, COALESCE(started_offset_ms, 0)), detected_by = CASE WHEN detected_by = '' THEN 'manual' ELSE detected_by END, updated_at = now() WHERE id = $1 AND status = 'active'`, topic.ID, offset); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.Live.topicFinished(topic.SessionID, topic.ID)
	if topic.SourceID != nil {
		a.Live.applyTopicScope(c, topic.SessionID, *topic.SourceID)
	}
	updated, _ := loadTopic(c, a.DB, topic.ID)
	c.JSON(http.StatusOK, gin.H{"topic": updated})
}

// topicRows returns the transcript lines that belong to a topic, available while the
// session is still running (an open topic runs up to the newest line).
func (a *App) topicRows(ctx context.Context, topic models.TranscriptionTopic) ([]transcriptionExportRow, error) {
	if topic.StartedOffsetMs == nil {
		return nil, fmt.Errorf("this topic has not started yet")
	}
	segments, err := loadTranscriptionSegments(ctx, a.DB, topic.SessionID)
	if err != nil {
		return nil, err
	}
	var inRange []models.TranscriptionSegment
	for _, s := range segments {
		if s.StartOffsetMs < *topic.StartedOffsetMs || (topic.EndedOffsetMs != nil && s.StartOffsetMs >= *topic.EndedOffsetMs) {
			continue
		}
		if topic.SourceID != nil && s.SourceID != nil && *s.SourceID != *topic.SourceID {
			continue
		}
		inRange = append(inRange, s)
	}
	speakers, err := loadTranscriptionSpeakers(ctx, a.DB, topic.SessionID)
	if err != nil {
		return nil, err
	}
	return transcriptionExportRows(inRange, speakers), nil
}

func topicTranscriptText(topic models.TranscriptionTopic, rows []transcriptionExportRow) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n", topic.Title)
	if topic.Label != "" {
		fmt.Fprintf(&b, "%s\n", topic.Label)
	}
	b.WriteString("\n")
	for _, row := range rows {
		b.WriteString(transcriptionInsightTranscriptLine(row))
	}
	return b.String()
}

func (a *App) topicTranscript(c *gin.Context) {
	topic, ok := a.authorizeTopic(c)
	if !ok {
		return
	}
	rows, err := a.topicRows(c, topic)
	if err != nil {
		writeError(c, http.StatusConflict, err)
		return
	}
	text := topicTranscriptText(topic, rows)
	if c.Query("download") != "" {
		name := strings.Map(func(r rune) rune {
			if r == '/' || r == '\\' || r == '"' || r < 32 {
				return '-'
			}
			return r
		}, firstNonEmptyString(topic.Label, topic.Title))
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.txt"`, strings.TrimSpace(name)))
		c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(text))
		return
	}
	c.JSON(http.StatusOK, gin.H{"topic": topic, "rows": rows, "text": text})
}

// summarizeTranscriptionTopic summarises one topic in the background, reusing the
// session's chat endpoint and the same chunked prompts as whole-session insights.
func (a *App) summarizeTranscriptionTopic(c *gin.Context) {
	topic, ok := a.authorizeTopic(c)
	if !ok {
		return
	}
	if status, err := a.startTopicSummary(c, topic, 0); err != nil {
		writeError(c, status, err)
		return
	}
	a.Live.broadcastTopic(topic.SessionID, topic.ID)
	updated, _ := loadTopic(c, a.DB, topic.ID)
	c.JSON(http.StatusAccepted, gin.H{"topic": updated})
}

// startTopicSummary claims the topic and writes its summary in the background. Topics
// with fewer than minWords transcribed words are skipped. The HTTP status describes
// why it could not start.
func (a *App) startTopicSummary(ctx context.Context, topic models.TranscriptionTopic, minWords int) (int, error) {
	rows, err := a.topicRows(ctx, topic)
	if err != nil || len(rows) == 0 {
		return http.StatusConflict, fmt.Errorf("there is no transcript for this topic yet")
	}
	if minWords > 0 {
		words := 0
		for _, row := range rows {
			words += len(strings.Fields(row.Text))
		}
		if words < minWords {
			return http.StatusConflict, fmt.Errorf("the topic is too short to summarise")
		}
	}
	var title, language string
	if err := a.DB.QueryRowContext(ctx, `SELECT title, language FROM transcription_sessions WHERE id = $1`, topic.SessionID).Scan(&title, &language); err != nil {
		return http.StatusInternalServerError, err
	}
	endpoint, status, err := a.transcriptionChatEndpoint(ctx, topic.SessionID)
	if err != nil {
		return status, err
	}
	claim, err := a.DB.ExecContext(ctx, `UPDATE transcription_topics SET summary_status = 'processing', summary_error = '', updated_at = now() WHERE id = $1 AND summary_status <> 'processing'`, topic.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if claimed, _ := claim.RowsAffected(); claimed > 0 {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), transcriptionInsightJobTimeout)
			defer cancel()
			a.runTopicSummary(ctx, topic, endpoint, title, language, rows)
		}()
	}
	return http.StatusAccepted, nil
}

// topicAutoSummaryDelay lets the last lines of a topic arrive before it is summarised.
const topicAutoSummaryDelay = 30 * time.Second

// topicAutoSummaryMinWords skips items that were only called up and closed, such as
// votes without debate.
const topicAutoSummaryMinWords = 150

// topicFinished announces a finished topic and, when the session has a chat endpoint,
// summarises it shortly after, so each agenda item can be read on its own right away.
func (m *TranscriptionManager) topicFinished(sessionID, topicID uuid.UUID) {
	liveStreamEvents.inc("topic_finished")
	m.broadcastTopic(sessionID, topicID)
	if m.app == nil {
		return
	}
	go func() {
		time.Sleep(topicAutoSummaryDelay)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		// Every recorded topic becomes a transcript of its own. One opened right at the
		// end may miss the last lines, so an untouched copy is rebuilt here.
		if _, err := m.app.syncTopicTranscript(ctx, topicID, true); err == nil {
			m.broadcastTopic(sessionID, topicID)
		} else if !errors.Is(err, errTopicNotRecorded) {
			slog.Warn("topic transcript failed", "topicId", topicID, "error", err)
		}
		topic, err := loadTopic(ctx, m.DB, topicID)
		if err != nil || topic.Status != "done" || topic.DetectedBy == "missed" || topic.SummaryStatus == "completed" || topic.SummaryStatus == "processing" {
			return
		}
		if _, err := m.app.startTopicSummary(ctx, topic, topicAutoSummaryMinWords); err == nil {
			liveStreamEvents.inc("topic_summary_auto")
			m.broadcastTopic(sessionID, topicID)
		}
	}()
}

// topicDebatePrompt: topics are agenda items of a Bundestag sitting, so the reader wants
// to know where each parliamentary group stands.
const topicDebatePrompt = ` This transcript is one agenda item of a German Bundestag sitting. Speaker names may carry their parliamentary group in parentheses. Name each speaker's group when it is known, make clear which position each group takes on the item, and mention the outcome (for example a vote or a referral to committee) when the transcript states it.`

func (a *App) runTopicSummary(ctx context.Context, topic models.TranscriptionTopic, endpoint provider.Endpoint, sessionTitle, language string, rows []transcriptionExportRow) {
	fail := func(cause error) {
		slog.Error("topic summary failed", "topicId", topic.ID, "error", cause)
		_, _ = a.DB.Exec(`UPDATE transcription_topics SET summary_status = 'failed', summary_error = $2, updated_at = now() WHERE id = $1`, topic.ID, cause.Error())
		a.Live.broadcastTopic(topic.SessionID, topic.ID)
	}
	title := firstNonEmptyString(topic.Title, sessionTitle)
	chunks := splitTranscriptionInsightRows(rows)
	if len(chunks) == 0 {
		fail(fmt.Errorf("there is no transcript for this topic yet"))
		return
	}
	durationMs := chunks[len(chunks)-1].EndOffsetMs - chunks[0].StartOffsetMs
	analyses := make([]transcriptionInsightChunkAnalysis, 0, len(chunks))
	for i, chunk := range chunks {
		response, err := requestTranscriptionInsight(ctx, endpoint,
			transcriptionInsightChunkSystemPrompt("auto", language, i+1, len(chunks))+topicDebatePrompt,
			buildTranscriptionInsightChunkInput(title, language, chunk, i+1, len(chunks), durationMs))
		if err != nil {
			fail(fmt.Errorf("summary failed for transcript window %d/%d: %w", i+1, len(chunks), err))
			return
		}
		analyses = append(analyses, transcriptionInsightChunkAnalysis{Chunk: chunk, Response: response})
	}
	summary := strings.TrimSpace(analyses[0].Response.Summary)
	if len(analyses) > 1 {
		summary = fallbackTranscriptionInsightSummary(analyses)
		if reduced, err := requestTranscriptionInsight(ctx, endpoint,
			transcriptionInsightReduceSystemPrompt("auto", language)+topicDebatePrompt,
			buildTranscriptionInsightReduceInput(title, language, analyses)); err == nil && strings.TrimSpace(reduced.Summary) != "" {
			summary = strings.TrimSpace(reduced.Summary)
		}
	}
	if summary == "" {
		fail(fmt.Errorf("the model returned an empty summary"))
		return
	}
	if _, err := a.DB.Exec(`UPDATE transcription_topics SET summary = $2, summary_status = 'completed', summary_error = '', updated_at = now() WHERE id = $1`, topic.ID, summary); err != nil {
		fail(err)
		return
	}
	a.Live.broadcastTopic(topic.SessionID, topic.ID)
}
