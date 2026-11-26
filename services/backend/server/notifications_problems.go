package server

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Problems during a transcription are told to its owner (unless they muted it), so a
// failed capture or step is not only noticed when someone opens the page.

// notifiedStreamAlerts are the stream alerts worth a notification; the others are
// progress notes (a pause, a moved schedule, all topics done).
var notifiedStreamAlerts = map[string]bool{
	"capture_aborted":    true,
	"stream_unreachable": true,
	"watch_missed":       true,
	"topic_missed":       true,
	"plan_missing":       true,
}

// streamOutageNotice is how long a stream must be gone before its owner is told.
const streamOutageNotice = 3 * time.Minute

// sessionLink is where a transcription opens in the app.
func (a *App) sessionLink(ctx context.Context, sessionID uuid.UUID) string {
	var video bool
	_ = a.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM transcription_video_uploads WHERE session_id = $1)`, sessionID).Scan(&video)
	if video {
		return "/video-transcription/" + sessionID.String()
	}
	return "/live-transcription/" + sessionID.String()
}

// notifyStreamAlert tells the owner about a stream problem that was just raised.
func (a *App) notifyStreamAlert(sessionID uuid.UUID, kind string) {
	if !notifiedStreamAlerts[kind] {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	event := notificationEvent{Kind: kind, SessionID: sessionID, OwnerOnly: true}
	if err := a.DB.QueryRowContext(ctx, `SELECT organization_id, title FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&event.OrganizationID, &event.SessionTitle); err != nil {
		return
	}
	// One notice per problem and hour, even when the alert text changes meanwhile.
	event.DedupeKey = fmt.Sprintf("%s:%s:%d", kind, sessionID, time.Now().Unix()/3600)
	event.Link = a.sessionLink(ctx, sessionID)
	a.notify(ctx, event)
}

// claimProblemEvents finds failures and interruptions not announced yet and marks them.
func (a *App) claimProblemEvents(ctx context.Context) []notificationEvent {
	var events []notificationEvent
	collect := func(kind, query string, args ...any) {
		rows, err := a.DB.QueryContext(ctx, query, args...)
		if err != nil {
			return
		}
		defer rows.Close()
		for rows.Next() {
			event := notificationEvent{Kind: kind, OwnerOnly: true}
			var marker time.Time
			if rows.Scan(&event.SessionID, &event.OrganizationID, &event.SessionTitle, &event.Minutes, &marker) != nil {
				continue
			}
			event.DedupeKey = fmt.Sprintf("%s:%s:%d", kind, event.SessionID, marker.Unix())
			events = append(events, event)
		}
	}
	// A transcription that failed (video processing, or a live session that could not
	// finish). Topic transcripts are copies and never fail on their own.
	collect("transcription_failed", `UPDATE transcription_sessions s SET done_notified_at = now()
		WHERE s.status = 'failed' AND s.done_notified_at IS NULL AND s.updated_at > now() - interval '2 days'
		RETURNING s.id, s.organization_id, s.title, 0, s.updated_at`)
	// Speaker detection or polishing after a live session failed.
	collect("processing_failed", `UPDATE transcription_live_processing p SET failure_notified_at = now()
		FROM transcription_sessions s
		WHERE s.id = p.session_id AND p.status = 'failed' AND p.failure_notified_at IS NULL AND p.updated_at > now() - interval '2 days'
		RETURNING s.id, s.organization_id, s.title, 0, p.updated_at`)
	// A stream gone for a few minutes, told once per interruption.
	collect("stream_outage", `UPDATE transcription_stream_sources st SET outage_notified_for = st.interrupted_at
		FROM transcription_sources src JOIN transcription_sessions s ON s.id = src.session_id
		WHERE src.id = st.source_id AND st.interrupted_at IS NOT NULL AND st.interrupted_at < now() - $1 * interval '1 second'
		AND st.outage_notified_for IS DISTINCT FROM st.interrupted_at AND st.status NOT IN ('stopped', 'failed')
		RETURNING s.id, s.organization_id, s.title, GREATEST(1, EXTRACT(EPOCH FROM now() - st.interrupted_at)::int / 60), st.interrupted_at`, streamOutageNotice.Seconds())
	// Back after a notified interruption. A capture that ended instead is told as such.
	collect("stream_recovered", `UPDATE transcription_stream_sources st SET outage_notified_for = NULL
		FROM (SELECT st2.source_id, st2.outage_notified_for AS was, s.id AS session_id, s.organization_id, s.title
			FROM transcription_stream_sources st2
			JOIN transcription_sources src ON src.id = st2.source_id
			JOIN transcription_sessions s ON s.id = src.session_id
			WHERE st2.interrupted_at IS NULL AND st2.outage_notified_for IS NOT NULL AND st2.status = 'connected'
			FOR UPDATE OF st2) old
		WHERE st.source_id = old.source_id
		RETURNING old.session_id, old.organization_id, old.title, GREATEST(1, EXTRACT(EPOCH FROM now() - old.was)::int / 60), old.was`)
	_, _ = a.DB.ExecContext(ctx, `UPDATE transcription_stream_sources SET outage_notified_for = NULL WHERE outage_notified_for IS NOT NULL AND interrupted_at IS NULL AND status IN ('stopped', 'failed')`)
	for i := range events {
		events[i].Link = a.sessionLink(ctx, events[i].SessionID)
	}
	return events
}
