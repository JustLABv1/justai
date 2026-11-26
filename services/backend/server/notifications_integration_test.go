package server

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"justai-backend/config"
)

func TestNotificationsReachOwnerAndReadersIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	a := &App{DB: db, Config: config.Config{PublicURL: "https://justai.example.org"}}

	owner, reader, muted, outsider, orgID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	sessionID, sourceID, topicID, copyID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'owner@example.org', 'Owner'), ($2, 'reader@example.org', 'Reader'), ($3, 'muted@example.org', 'Muted'), ($4, 'out@example.org', 'Out')`, []any{owner, reader, muted, outsider}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		{`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`, []any{orgID, owner, reader, muted, outsider}},
		{`INSERT INTO notification_settings (user_id, locale) VALUES ($1, 'de')`, []any{reader}},
		{`INSERT INTO transcription_sessions (id, user_id, organization_id, title, status, started_at) VALUES ($1, $2, $3, '112. Sitzung', 'live', now() - interval '3 hours'), ($4, $2, $3, 'Landwirtschaft · 112. Sitzung', 'completed', now())`, []any{sessionID, owner, orgID, copyID}},
		{`INSERT INTO transcription_sources (id, session_id, name, kind) VALUES ($1, $2, 'Bundestag', 'stream')`, []any{sourceID, sessionID}},
		{`INSERT INTO transcription_readers (session_id, user_id, organization_id) VALUES ($1, $2, $4), ($1, $3, $4)`, []any{sessionID, reader, muted, orgID}},
		{`INSERT INTO transcription_notification_mutes (session_id, user_id) VALUES ($1, $2)`, []any{sessionID, muted}},
		{`INSERT INTO transcription_topics (id, session_id, source_id, topic_key, title, status, started_offset_ms, ended_offset_ms, detected_by, transcript_session_id, summary_status, updated_at) VALUES
			($1, $2, $3, 'epl10', 'Landwirtschaft', 'done', 1000, 9000, 'announcement', $4, 'completed', now() - interval '5 minutes')`, []any{topicID, sessionID, sourceID, copyID}},
	} {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	events := a.claimNotificationEvents(ctx)
	if len(events) != 1 || events[0].Kind != "topic_done" || events[0].Link != "/live-transcription/"+copyID.String() || !events[0].HasSummary {
		t.Fatalf("events = %+v", events)
	}
	a.notify(ctx, events[0])
	a.notify(ctx, events[0]) // a repeat stores nothing new

	titles := map[uuid.UUID]string{}
	rows, err := db.QueryContext(ctx, `SELECT user_id, title FROM notifications`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var user uuid.UUID
		var title string
		_ = rows.Scan(&user, &title)
		titles[user] = title
	}
	rows.Close()
	if len(titles) != 2 || titles[owner] != "“Landwirtschaft” is finished" || titles[reader] != "„Landwirtschaft“ ist fertig" {
		t.Fatalf("notifications = %v (muted and outsiders must get none)", titles)
	}
	if again := a.claimNotificationEvents(ctx); len(again) != 0 {
		t.Fatalf("claimed twice: %+v", again)
	}

	// The sitting ends: the whole transcript is announced once.
	if _, err := db.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'completed', ended_at = now() - interval '5 minutes' WHERE id = $1`, sessionID); err != nil {
		t.Fatal(err)
	}
	events = a.claimNotificationEvents(ctx)
	if len(events) != 1 || events[0].Kind != "transcript_done" || events[0].TopicCount != 1 || events[0].SessionID != sessionID {
		t.Fatalf("session events = %+v (the topic transcript itself must not be announced)", events)
	}
	if title, body, _ := notificationTexts("de", events[0]); title != "„112. Sitzung“ ist abgeschlossen" || body != "Die Live-Transkription ist beendet und fertig bearbeitet. 1 Thema wurde aufgenommen." {
		t.Fatalf("texts = %q / %q", title, body)
	}
	if got := a.publicLink(ctx, events[0].Link); got != "https://justai.example.org/live-transcription/"+sessionID.String() {
		t.Fatalf("link = %s", got)
	}
}
