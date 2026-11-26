package server

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"justai-backend/models"
)

// splitMissedAnnouncement looks through a finished topic's lines for the chair calling
// up a later agenda item that live detection missed. When it finds one, the topic ends
// there and the missed item takes over the rest of the range. It returns the item that
// was split off, or uuid.Nil.
func (m *TranscriptionManager) splitMissedAnnouncement(ctx context.Context, topicID uuid.UUID) uuid.UUID {
	topic, err := loadTopic(ctx, m.DB, topicID)
	if err != nil || topic.Status != "done" || topic.DetectedBy == "missed" || topic.StartedOffsetMs == nil || topic.EndedOffsetMs == nil {
		return uuid.Nil
	}
	sourceID := uuid.Nil // matches only topics without a source
	if topic.SourceID != nil {
		sourceID = *topic.SourceID
	}
	open, err := m.loadOpenTopics(ctx, topic.SessionID, sourceID)
	if err != nil {
		return uuid.Nil
	}
	var refs []topicRef
	for _, t := range open {
		if t.Status == "planned" {
			refs = append(refs, t)
		}
	}
	if len(refs) == 0 {
		return uuid.Nil
	}
	var source uuid.NullUUID
	if topic.SourceID != nil {
		source = uuid.NullUUID{UUID: *topic.SourceID, Valid: true}
	}
	// Skip the topic's own opening lines, which name the topic itself.
	rows, err := m.DB.QueryContext(ctx, `SELECT text, start_offset_ms, end_offset_ms FROM transcription_segments
		WHERE session_id = $1 AND canonical AND start_offset_ms > $2 AND start_offset_ms < $3 AND ($4::uuid IS NULL OR source_id IS NULL OR source_id = $4)
		ORDER BY start_offset_ms, created_at`, topic.SessionID, *topic.StartedOffsetMs, *topic.EndedOffsetMs, source)
	if err != nil {
		return uuid.Nil
	}
	var (
		pending   topicCallBuffer
		previous  int64
		splitAt   int64
		splitInto = -1
	)
	for rows.Next() {
		var text string
		var start, end int64
		if rows.Scan(&text, &start, &end) != nil {
			continue
		}
		candidate := pending.candidate(text, start, end)
		at := start
		if candidate != text {
			at = previous // the call began on the line before
		}
		previous = start
		if !mightAnnounceTopic(candidate) {
			continue
		}
		if idx := detectTopicAnnouncement(candidate, refs); idx >= 0 {
			splitAt, splitInto = at, idx
			break
		}
	}
	rows.Close()
	if splitInto < 0 || splitAt <= *topic.StartedOffsetMs {
		return uuid.Nil
	}

	if !m.splitTopicAt(ctx, topic, refs[splitInto].ID, splitAt, "announcement") {
		return uuid.Nil
	}
	liveStreamEvents.inc("topic_split_retroactive")
	slog.Info("split a missed agenda item off a finished topic", "topicId", topic.ID, "missedTopicId", refs[splitInto].ID, "offsetMs", splitAt)
	return refs[splitInto].ID
}

// splitTopicAt ends a finished topic at splitAt and gives the rest of its range to the
// planned item next. The shortened topic gets a fresh summary for its new range.
func (m *TranscriptionManager) splitTopicAt(ctx context.Context, topic models.TranscriptionTopic, next uuid.UUID, splitAt int64, by string) bool {
	if topic.Status != "done" || topic.StartedOffsetMs == nil || topic.EndedOffsetMs == nil || splitAt <= *topic.StartedOffsetMs || splitAt >= *topic.EndedOffsetMs {
		return false
	}
	var source uuid.NullUUID
	if topic.SourceID != nil {
		source = uuid.NullUUID{UUID: *topic.SourceID, Valid: true}
	}
	tx, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return false
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE transcription_topics SET ended_offset_ms = $2, summary = '', summary_status = 'none', summary_error = '', updated_at = now()
		WHERE id = $1 AND status = 'done' AND ended_offset_ms = $3 AND summary_status <> 'processing'`, topic.ID, splitAt, *topic.EndedOffsetMs)
	if err != nil {
		return false
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return false
	}
	result, err = tx.ExecContext(ctx, `UPDATE transcription_topics SET status = 'done', started_offset_ms = $2, ended_offset_ms = $3, detected_by = $5, source_id = COALESCE(source_id, $4), updated_at = now()
		WHERE id = $1 AND status = 'planned'`, next, splitAt, *topic.EndedOffsetMs, source, by)
	if err != nil {
		return false
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return false
	}
	if tx.Commit() != nil {
		return false
	}
	m.broadcastTopic(topic.SessionID, topic.ID)
	return true
}

// repairTopicBoundaries runs the retroactive split over a session's finished topics
// while an agenda item is still waiting although its slot is over, then lets a
// topic-scoped capture react (for example end because every selected item is done).
func (m *TranscriptionManager) repairTopicBoundaries(ctx context.Context, sessionID uuid.UUID) {
	var overdue bool
	if err := m.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM transcription_topics WHERE session_id = $1 AND status = 'planned' AND planned_end_at < $2)
		AND EXISTS (SELECT 1 FROM transcription_topics WHERE session_id = $1 AND status = 'done' AND detected_by <> 'missed')`, sessionID, time.Now()).Scan(&overdue); err != nil || !overdue {
		return
	}
	rows, err := m.DB.QueryContext(ctx, `SELECT id, source_id FROM transcription_topics WHERE session_id = $1 AND status = 'done' AND detected_by <> 'missed' AND ended_offset_ms IS NOT NULL ORDER BY started_offset_ms`, sessionID)
	if err != nil {
		return
	}
	type done struct {
		id     uuid.UUID
		source uuid.NullUUID
	}
	var finished []done
	for rows.Next() {
		var d done
		if rows.Scan(&d.id, &d.source) == nil {
			finished = append(finished, d)
		}
	}
	rows.Close()
	sources := map[uuid.UUID]bool{}
	for _, d := range finished {
		next := m.splitMissedAnnouncement(ctx, d.id)
		if next == uuid.Nil {
			continue
		}
		// topicFinished splits the new item further if it hides another call.
		m.topicFinished(sessionID, d.id)
		m.topicFinished(sessionID, next)
		if d.source.Valid {
			sources[d.source.UUID] = true
		}
	}
	for source := range sources {
		m.applyTopicScope(ctx, sessionID, source)
	}
}
