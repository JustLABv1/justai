package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/models"
	"justai-backend/provider"
)

// Capturing only selected topics ("capture_scope = topics"): the capture starts a lead
// time before the first selected item's planned slot, runs while the chair's
// announcements are transcribed, pauses after a selected item is finished when the next
// selected one is far away, and ends after the last one. Only during these windows is
// audio sent to the transcription provider.
const (
	topicCaptureLead     = 30 * time.Minute // start this long before the planned slot
	topicCaptureMinPause = 20 * time.Minute // shorter gaps keep the capture running
	topicCaptureOverrun  = 3 * time.Hour    // hard stop after the last selected slot
)

// topicCapturePlan computes the first capture window for the selected items.
func topicCapturePlan(selected []planItem, now time.Time) (start, end time.Time) {
	for i, it := range selected {
		if i == 0 || it.StartAt.Before(start) {
			start = it.StartAt
		}
		if i == 0 || it.EndAt.After(end) {
			end = it.EndAt
		}
	}
	start = start.Add(-topicCaptureLead)
	if start.Before(now) {
		start = now
	}
	return start, end.Add(topicCaptureOverrun)
}

// topicScopeDecision is what to do with a topic-scoped capture after a topic changed.
type topicScopeDecision struct {
	Missed   []uuid.UUID // selected items the sitting passed before the capture reached them
	Finish   bool        // all selected items are done
	ResumeAt *time.Time  // pause until then
	Next     *models.TranscriptionTopic
}

// decideTopicScope is the pure part of the policy, so it can be tested without a database.
func decideTopicScope(topics []models.TranscriptionTopic, now time.Time) topicScopeDecision {
	var d topicScopeDecision
	sorted := append([]models.TranscriptionTopic(nil), topics...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Order < sorted[j].Order })
	reached := -1
	for _, t := range sorted {
		if t.Status == "active" || (t.Status == "done" && t.DetectedBy != "missed") {
			if t.Order > reached {
				reached = t.Order
			}
		}
	}
	var active *models.TranscriptionTopic
	var lastDoneSelected *models.TranscriptionTopic
	for i := range sorted {
		t := &sorted[i]
		switch {
		case t.Status == "active":
			active = t
		case t.Status == "planned" && t.Starred && t.Order < reached:
			d.Missed = append(d.Missed, t.ID)
		case t.Status == "done" && t.Starred && t.DetectedBy != "missed":
			lastDoneSelected = t
		}
	}
	if active != nil && active.Starred {
		return d // a selected item is running
	}
	missed := map[uuid.UUID]bool{}
	for _, id := range d.Missed {
		missed[id] = true
	}
	for i := range sorted {
		t := &sorted[i]
		if t.Starred && t.Status == "planned" && !missed[t.ID] {
			d.Next = t
			break
		}
	}
	if d.Next == nil {
		d.Finish = active == nil || !active.Starred
		return d
	}
	if d.Next.PlannedStartAt == nil {
		return d // unknown slot: keep listening
	}
	// The sitting usually runs late; carry the delay seen on the last selected item over.
	var delay time.Duration
	if lastDoneSelected != nil && lastDoneSelected.PlannedEndAt != nil && now.After(*lastDoneSelected.PlannedEndAt) {
		delay = now.Sub(*lastDoneSelected.PlannedEndAt)
	}
	resume := d.Next.PlannedStartAt.Add(delay - topicCaptureLead)
	if resume.Sub(now) >= topicCaptureMinPause {
		d.ResumeAt = &resume
	}
	return d
}

// applyTopicScope pauses, resumes or ends a topic-scoped capture after a topic changed.
func (m *TranscriptionManager) applyTopicScope(ctx context.Context, sessionID, sourceID uuid.UUID) {
	var scope string
	if err := m.DB.QueryRowContext(ctx, `SELECT capture_scope FROM transcription_stream_sources WHERE source_id = $1`, sourceID).Scan(&scope); err != nil || scope != "topics" {
		return
	}
	topics, err := loadTopics(ctx, m.DB, sessionID)
	if err != nil {
		return
	}
	var mine []models.TranscriptionTopic
	for _, t := range topics {
		if t.SourceID == nil || *t.SourceID == sourceID {
			mine = append(mine, t)
		}
	}
	d := decideTopicScope(mine, time.Now())
	for _, id := range d.Missed {
		if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_topics SET status = 'done', detected_by = 'missed', updated_at = now() WHERE id = $1 AND status = 'planned'`, id); err == nil {
			liveStreamEvents.inc("topic_missed")
			m.broadcastTopic(sessionID, id)
		}
	}
	if len(d.Missed) > 0 {
		m.setStreamAlert(sessionID, sourceID, "topic_missed", "A selected topic was called up before the capture window began, so it was not recorded. The capture continues with the remaining topics.")
	}
	switch {
	case d.Finish:
		m.setStreamAlert(sessionID, sourceID, "topics_complete", "All selected topics are finished. The capture has ended.")
		m.finishLiveStream(sessionID, sourceID, "all selected topics finished")
		m.stopStreamSource(sourceID)
	case d.ResumeAt != nil:
		result, err := m.DB.ExecContext(ctx, `UPDATE transcription_stream_sources SET status = 'scheduled', scheduled_start_at = $2, start_mode = 'at_time', updated_at = now() WHERE source_id = $1 AND status IN ('pending', 'connecting', 'connected', 'reconnecting')`, sourceID, *d.ResumeAt)
		if err != nil {
			return
		}
		if paused, _ := result.RowsAffected(); paused == 0 {
			return
		}
		liveStreamEvents.inc("topic_pause")
		berlin, _ := time.LoadLocation("Europe/Berlin")
		m.setStreamAlert(sessionID, sourceID, "topic_pause", fmt.Sprintf("Paused until %s (Berlin time), shortly before the next selected topic: %s.", d.ResumeAt.In(berlin).Format("15:04"), d.Next.Title))
		m.stopStreamSource(sourceID)
		m.setStreamStatus(sessionID, sourceID, "scheduled", "", false)
	}
}

// continueSourceOffset returns where a restarted capture continues on the source's
// timeline. Sessions with topics need one continuous timeline, because topic
// boundaries are offsets; starting again at zero would overlap earlier topics.
func (m *TranscriptionManager) continueSourceOffset(ctx context.Context, sessionID, sourceID uuid.UUID) int64 {
	var hasTopics bool
	if err := m.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM transcription_topics WHERE session_id = $1)`, sessionID).Scan(&hasTopics); err != nil || !hasTopics {
		return 0
	}
	var last sql.NullInt64
	_ = m.DB.QueryRowContext(ctx, `SELECT MAX(end_offset_ms) FROM transcription_segments WHERE session_id = $1 AND source_id = $2`, sessionID, sourceID).Scan(&last)
	if !last.Valid || last.Int64 <= 0 {
		return 0
	}
	return last.Int64 + 1000
}

// ---- agenda for the topic picker ----

var agendaCache = struct {
	sync.Mutex
	at    time.Time
	items []planItem
}{}

func (a *App) cachedAblaufplan(ctx context.Context) ([]planItem, error) {
	agendaCache.Lock()
	defer agendaCache.Unlock()
	if !agendaCache.at.IsZero() && time.Since(agendaCache.at) < 10*time.Minute {
		return agendaCache.items, nil
	}
	fetchCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	items, err := fetchBundestagAblaufplan(fetchCtx, provider.SafeHTTPClient(20*time.Second, a.Config.AllowPrivate))
	if err != nil {
		return nil, err
	}
	agendaCache.items, agendaCache.at = items, time.Now()
	return items, nil
}

// bundestagAgenda lists the agenda items of a sitting so users can choose topics.
func (a *App) bundestagAgenda(c *gin.Context) {
	sitting, err := strconv.Atoi(c.Query("sitting"))
	if err != nil || sitting <= 0 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("a sitting number is required"))
		return
	}
	items, err := a.cachedAblaufplan(c)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	forSitting := plenaryItemsForSession(items, sitting)
	if forSitting == nil {
		forSitting = []planItem{}
	}
	c.JSON(http.StatusOK, gin.H{"items": forSitting, "leadMinutes": int(topicCaptureLead / time.Minute)})
}

// rescheduleTopicCapture moves a topic-scoped capture that is waiting (not started yet,
// or paused between topics) when the published plan moved the selected items or the
// user changed the selection. Only plan changes leave a note on the source.
func (m *TranscriptionManager) rescheduleTopicCapture(ctx context.Context, sessionID uuid.UUID, planChanged bool) {
	var sourceID uuid.UUID
	var start, end *time.Time
	err := m.DB.QueryRowContext(ctx, `
		SELECT stream.source_id, stream.scheduled_start_at, stream.scheduled_end_at
		FROM transcription_stream_sources stream
		JOIN transcription_sources source ON source.id = stream.source_id
		WHERE source.session_id = $1 AND stream.capture_scope = 'topics' AND stream.status = 'scheduled'
		LIMIT 1`, sessionID).Scan(&sourceID, &start, &end)
	if err != nil {
		return
	}
	topics, err := loadTopics(ctx, m.DB, sessionID)
	if err != nil {
		return
	}
	now := time.Now()
	nextStart, nextEnd, ok := topicCaptureWindow(topics, start, now)
	if !ok {
		return
	}
	if start != nil && end != nil && absDuration(start.Sub(nextStart)) <= time.Minute && absDuration(end.Sub(nextEnd)) <= time.Minute {
		return
	}
	if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_stream_sources SET scheduled_start_at = $2, scheduled_end_at = $3, updated_at = now() WHERE source_id = $1 AND status = 'scheduled'`, sourceID, nextStart, nextEnd); err != nil {
		return
	}
	if !planChanged {
		m.broadcast(sessionID, "transcription.stream", ginData{"sourceId": sourceID, "scheduledStartAt": nextStart, "scheduledEndAt": nextEnd})
		return
	}
	berlin, _ := time.LoadLocation("Europe/Berlin")
	message := fmt.Sprintf("The Bundestag plan changed: capture now starts at %s (Berlin time).", nextStart.In(berlin).Format("02.01. 15:04"))
	if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_stream_sources SET alert = $2, alerted_at = now() WHERE source_id = $1`, sourceID, message); err == nil {
		liveStreamEvents.inc("plan_changed")
	}
	m.broadcast(sessionID, "transcription.stream", ginData{"sourceId": sourceID, "alert": message, "scheduledStartAt": nextStart, "scheduledEndAt": nextEnd})
}

// topicCaptureWindow is the window for the selected topics that are still planned.
// Before any topic was reached it is the first capture window. While paused between
// topics, the resume time (which already includes the observed delay) only moves earlier
// when the next selected item was brought forward; a later slot just means listening longer.
func topicCaptureWindow(topics []models.TranscriptionTopic, current *time.Time, now time.Time) (start, end time.Time, ok bool) {
	started := false
	var pending []planItem
	for _, t := range topics {
		if t.Status != "planned" {
			started = true
		}
		if t.Starred && t.Status == "planned" && t.PlannedStartAt != nil && t.PlannedEndAt != nil {
			pending = append(pending, planItem{StartAt: *t.PlannedStartAt, EndAt: *t.PlannedEndAt})
		}
	}
	if len(pending) == 0 {
		return start, end, false
	}
	start, end = topicCapturePlan(pending, now)
	if started && current != nil && !start.Before(*current) {
		start = *current
	}
	return start, end, true
}
