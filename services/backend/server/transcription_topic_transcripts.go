package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"
)

// errTopicNotRecorded: the topic has no captured lines to build a transcript from.
var errTopicNotRecorded = errors.New("this topic was not recorded, so it has no transcript")

// topicTranscriptTitle names a topic's transcript after the item and its sitting.
func topicTranscriptTitle(topicTitle, label, sessionTitle string) string {
	title := strings.TrimSpace(topicTitle)
	if label = strings.TrimSpace(label); label != "" && !strings.Contains(title, label) {
		title += " (" + label + ")"
	}
	if sessionTitle = strings.TrimSpace(sessionTitle); sessionTitle != "" {
		title += " · " + sessionTitle
	}
	if runes := []rune(title); len(runes) > 200 {
		title = string(runes[:199]) + "…"
	}
	return title
}

// syncTopicTranscript gives a finished topic its own transcript: a completed session
// holding a copy of the topic's lines (offsets start at zero) and its speakers. It is
// created once. With refresh, an existing copy is rebuilt from the sitting (for example
// after speaker detection finished), but only while nobody has worked on it yet.
func (a *App) syncTopicTranscript(ctx context.Context, topicID uuid.UUID, refresh bool) (uuid.UUID, error) {
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback()

	var (
		parentID           uuid.UUID
		sourceID, copyID   uuid.NullUUID
		start, end         sql.NullInt64
		status, detectedBy string
		title, label       string
		syncedAt           sql.NullTime
	)
	err = tx.QueryRowContext(ctx, `SELECT session_id, source_id, status, detected_by, started_offset_ms, ended_offset_ms, title, label, transcript_session_id, transcript_synced_at FROM transcription_topics WHERE id = $1 FOR UPDATE`, topicID).
		Scan(&parentID, &sourceID, &status, &detectedBy, &start, &end, &title, &label, &copyID, &syncedAt)
	if err != nil {
		return uuid.Nil, err
	}
	if status != "done" || detectedBy == "missed" || !start.Valid {
		return uuid.Nil, errTopicNotRecorded
	}
	if copyID.Valid {
		if !refresh || !syncedAt.Valid {
			return copyID.UUID, nil
		}
		var touched bool
		if err := tx.QueryRowContext(ctx, `SELECT
			EXISTS (SELECT 1 FROM transcription_sessions WHERE id = $1 AND (updated_at > $2 OR done_at IS NOT NULL OR archived_at IS NOT NULL))
			OR EXISTS (SELECT 1 FROM transcription_segments WHERE session_id = $1 AND updated_at > $2)
			OR EXISTS (SELECT 1 FROM transcription_speakers WHERE session_id = $1 AND updated_at > $2)
			OR EXISTS (SELECT 1 FROM transcription_insights WHERE session_id = $1)
			OR EXISTS (SELECT 1 FROM transcription_annotations WHERE session_id = $1)`, copyID.UUID, syncedAt.Time).Scan(&touched); err != nil {
			return uuid.Nil, err
		}
		if touched {
			return copyID.UUID, nil
		}
		for _, table := range []string{"transcription_segments", "transcription_speakers", "transcription_sources"} {
			if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE session_id = $1`, copyID.UUID); err != nil {
				return uuid.Nil, err
			}
		}
	}

	var sessionTitle string
	if err := tx.QueryRowContext(ctx, `SELECT title FROM transcription_sessions WHERE id = $1`, parentID).Scan(&sessionTitle); err != nil {
		return uuid.Nil, err
	}
	copySession := copyID.UUID
	if !copyID.Valid {
		err = tx.QueryRowContext(ctx, `INSERT INTO transcription_sessions (user_id, organization_id, title, status, transcription_endpoint_id, diarization_endpoint_id, grammar_endpoint_id, transcription_model, diarization_model, grammar_model, language, record_audio, polish_status, participants, started_at, ended_at)
			SELECT user_id, organization_id, $2, 'completed', transcription_endpoint_id, diarization_endpoint_id, grammar_endpoint_id, transcription_model, diarization_model, grammar_model, language, FALSE, 'not_requested', participants,
				started_at + make_interval(secs => $3::bigint / 1000.0),
				started_at + make_interval(secs => COALESCE($4::bigint, $3::bigint) / 1000.0)
			FROM transcription_sessions WHERE id = $1 RETURNING id`,
			parentID, topicTranscriptTitle(title, label, sessionTitle), start.Int64, end).Scan(&copySession)
		if err != nil {
			return uuid.Nil, err
		}
		// People the sitting was shared with may read its topics too.
		if _, err := tx.ExecContext(ctx, `INSERT INTO transcription_readers (session_id, user_id, organization_id) SELECT $2, user_id, organization_id FROM transcription_readers WHERE session_id = $1 ON CONFLICT DO NOTHING`, parentID, copySession); err != nil {
			return uuid.Nil, err
		}
	} else {
		if _, err := tx.ExecContext(ctx, `UPDATE transcription_sessions SET updated_at = now() WHERE id = $1`, copySession); err != nil {
			return uuid.Nil, err
		}
	}

	var copySource uuid.NullUUID
	if err := tx.QueryRowContext(ctx, `INSERT INTO transcription_sources (session_id, name, kind, device_label, status)
		SELECT $2, name, kind, device_label, 'stopped' FROM transcription_sources
		WHERE session_id = $1 AND ($3::uuid IS NULL OR id = $3) ORDER BY created_at LIMIT 1 RETURNING id`, parentID, copySession, sourceID).Scan(&copySource); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return uuid.Nil, err
	}

	// The lines of the topic, the same ones the topic's own transcript shows.
	const inRange = `s.session_id = $1 AND s.canonical AND s.start_offset_ms >= $2 AND ($3::bigint IS NULL OR s.start_offset_ms < $3) AND ($4::uuid IS NULL OR s.source_id IS NULL OR s.source_id = $4)`
	rows, err := tx.QueryContext(ctx, `SELECT id, label, display_name, color, name_source, suggested_name, suggestion_confidence, suggestion_evidence FROM transcription_speakers
		WHERE session_id = $1 AND merged_into IS NULL AND id IN (
			SELECT COALESCE(sp.merged_into, sp.id) FROM transcription_segments s JOIN transcription_speakers sp ON sp.id = s.speaker_id WHERE `+inRange+`)
		ORDER BY created_at`, parentID, start.Int64, end, sourceID)
	if err != nil {
		return uuid.Nil, err
	}
	type speaker struct {
		id                                                  uuid.UUID
		label, name, color, nameSource, suggested, evidence string
		confidence                                          float64
	}
	var speakers []speaker
	for rows.Next() {
		var s speaker
		if err := rows.Scan(&s.id, &s.label, &s.name, &s.color, &s.nameSource, &s.suggested, &s.confidence, &s.evidence); err != nil {
			rows.Close()
			return uuid.Nil, err
		}
		speakers = append(speakers, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return uuid.Nil, err
	}
	oldIDs := make([]string, 0, len(speakers))
	newIDs := make([]string, 0, len(speakers))
	for _, s := range speakers {
		var id uuid.UUID
		if err := tx.QueryRowContext(ctx, `INSERT INTO transcription_speakers (session_id, label, display_name, color, name_source, suggested_name, suggestion_confidence, suggestion_evidence) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
			copySession, s.label, s.name, s.color, s.nameSource, s.suggested, s.confidence, s.evidence).Scan(&id); err != nil {
			return uuid.Nil, err
		}
		oldIDs = append(oldIDs, s.id.String())
		newIDs = append(newIDs, id.String())
	}

	if _, err := tx.ExecContext(ctx, `INSERT INTO transcription_segments (session_id, source_id, speaker_id, text, raw_text, polished_text, edited_text, start_offset_ms, end_offset_ms, confidence, signal_quality, canonical)
		SELECT $5, $6, map.new_id, s.text, s.raw_text, s.polished_text, s.edited_text, s.start_offset_ms - $2, GREATEST(s.end_offset_ms - $2, s.start_offset_ms - $2), s.confidence, s.signal_quality, TRUE
		FROM transcription_segments s
		LEFT JOIN transcription_speakers sp ON sp.id = s.speaker_id
		LEFT JOIN unnest($7::uuid[], $8::uuid[]) AS map(old_id, new_id) ON map.old_id = COALESCE(sp.merged_into, sp.id)
		WHERE `+inRange+` ORDER BY s.start_offset_ms, s.created_at`,
		parentID, start.Int64, end, sourceID, copySession, copySource, pq.Array(oldIDs), pq.Array(newIDs)); err != nil {
		return uuid.Nil, err
	}
	// clock_timestamp is later than every row written above, so later edits stand out.
	if _, err := tx.ExecContext(ctx, `UPDATE transcription_topics SET transcript_session_id = $2, transcript_synced_at = clock_timestamp() WHERE id = $1`, topicID, copySession); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(); err != nil {
		return uuid.Nil, err
	}
	return copySession, nil
}

// refreshTopicTranscripts rebuilds the untouched topic transcripts of a sitting once its
// final processing (speaker detection, polishing) has rewritten the lines.
func (a *App) refreshTopicTranscripts(ctx context.Context, sessionID uuid.UUID) {
	rows, err := a.DB.QueryContext(ctx, `SELECT id FROM transcription_topics WHERE session_id = $1 AND transcript_session_id IS NOT NULL`, sessionID)
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
		if _, err := a.syncTopicTranscript(ctx, id, true); err != nil {
			slog.Warn("topic transcript refresh failed", "topicId", id, "error", err)
		}
	}
}

// openTopicTranscript: POST /transcription/topics/:id/transcript-session returns the
// topic's own transcript, creating it for topics that finished before it existed.
func (a *App) openTopicTranscript(c *gin.Context) {
	topic, ok := a.authorizeTopic(c)
	if !ok {
		return
	}
	id, err := a.syncTopicTranscript(c, topic.ID, false)
	if errors.Is(err, errTopicNotRecorded) {
		writeError(c, http.StatusConflict, err)
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("the topic transcript could not be created: %w", err))
		return
	}
	a.Live.broadcastTopic(topic.SessionID, topic.ID)
	c.JSON(http.StatusOK, gin.H{"sessionId": id})
}
