package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestRemindersAreSetAndDeliveredIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	a := &App{DB: db}
	userID, orgID, other := uuid.New(), uuid.New(), uuid.New()
	for _, q := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'ada@example.org', 'Ada'), ($2, 'bob@example.org', 'Bob')`, []any{userID, other}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		{`INSERT INTO notification_settings (user_id, locale, timezone) VALUES ($1, 'de', 'Europe/Berlin')`, []any{userID}},
	} {
		if _, err := db.ExecContext(ctx, q.query, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := a.reminderTool(ctx, userID, orgID, uuid.Nil, "set_reminder", map[string]any{"message": "Kaffee holen", "inMinutes": 5.0})
	if err != nil {
		t.Fatal(err)
	}
	var set struct {
		ReminderID uuid.UUID `json:"reminderId"`
		TimeZone   string    `json:"timeZone"`
		DueLocal   string    `json:"dueLocal"`
	}
	_ = json.Unmarshal(raw, &set)
	if set.TimeZone != "Europe/Berlin" || !strings.Contains(set.DueLocal, "CET") {
		t.Fatalf("set = %s", raw)
	}
	if _, err := a.reminderTool(ctx, userID, orgID, uuid.Nil, "set_reminder", map[string]any{"message": "zu spät", "at": "2020-01-01 10:00"}); err == nil {
		t.Fatal("a reminder in the past was accepted")
	}
	// Someone else cannot cancel it.
	if _, err := a.reminderTool(ctx, other, orgID, uuid.Nil, "cancel_reminder", map[string]any{"reminderId": set.ReminderID.String()}); err == nil {
		t.Fatal("another user cancelled the reminder")
	}
	if len(a.claimDueReminders(ctx)) != 0 {
		t.Fatal("a reminder was sent before it was due")
	}
	if _, err := db.ExecContext(ctx, `UPDATE reminders SET due_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	events := a.claimDueReminders(ctx)
	if len(events) != 1 || events[0].UserID != userID || events[0].Message != "Kaffee holen" || events[0].Link != "/" {
		t.Fatalf("due = %+v", events)
	}
	a.notify(ctx, events[0])
	var title, body string
	if err := db.QueryRowContext(ctx, `SELECT title, body FROM notifications WHERE user_id = $1`, userID).Scan(&title, &body); err != nil || title != "Erinnerung" || body != "Kaffee holen" {
		t.Fatalf("notification = %q %q %v", title, body, err)
	}
	if len(a.claimDueReminders(ctx)) != 0 {
		t.Fatal("a reminder was sent twice")
	}
	listed, _ := a.reminderTool(ctx, userID, orgID, uuid.Nil, "list_reminders", map[string]any{})
	if !strings.Contains(string(listed), `"reminders":[]`) {
		t.Fatalf("sent reminder still listed: %s", listed)
	}
}

func TestTranscriptionProblemsReachTheOwnerIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	a := &App{DB: db}
	owner, reader, orgID, sessionID, sourceID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, q := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'owner@example.org', 'Owner'), ($2, 'reader@example.org', 'Reader')`, []any{owner, reader}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		{`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, []any{orgID, owner, reader}},
		{`INSERT INTO transcription_sessions (id, user_id, organization_id, title, status) VALUES ($1, $2, $3, '113. Sitzung', 'live')`, []any{sessionID, owner, orgID}},
		{`INSERT INTO transcription_readers (session_id, user_id, organization_id) VALUES ($1, $2, $3)`, []any{sessionID, reader, orgID}},
		{`INSERT INTO transcription_sources (id, session_id, name, kind) VALUES ($1, $2, 'Bundestag', 'stream')`, []any{sourceID, sessionID}},
		{`INSERT INTO transcription_stream_sources (source_id, url_ciphertext, protocol, status, interrupted_at) VALUES ($1, '\x00', 'https', 'reconnecting', now() - interval '5 minutes')`, []any{sourceID}},
	} {
		if _, err := db.ExecContext(ctx, q.query, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	kinds := func(events []notificationEvent) []string {
		var out []string
		for _, e := range events {
			out = append(out, e.Kind)
		}
		return out
	}

	events := a.claimProblemEvents(ctx)
	if got := kinds(events); len(got) != 1 || got[0] != "stream_outage" || events[0].Minutes < 4 || !events[0].OwnerOnly {
		t.Fatalf("outage events = %+v", events)
	}
	a.notify(ctx, events[0])
	if again := a.claimProblemEvents(ctx); len(again) != 0 {
		t.Fatalf("the same outage was told twice: %v", kinds(again))
	}
	var readerCount int
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM notifications WHERE user_id = $1`, reader).Scan(&readerCount)
	if readerCount != 0 {
		t.Fatal("a reader was told about a capture problem")
	}

	// The stream comes back.
	if _, err := db.ExecContext(ctx, `UPDATE transcription_stream_sources SET interrupted_at = NULL, status = 'connected' WHERE source_id = $1`, sourceID); err != nil {
		t.Fatal(err)
	}
	if got := kinds(a.claimProblemEvents(ctx)); len(got) != 1 || got[0] != "stream_recovered" {
		t.Fatalf("recovery events = %v", got)
	}

	// Post-processing fails, then the session fails.
	if _, err := db.ExecContext(ctx, `INSERT INTO transcription_live_processing (session_id, status) VALUES ($1, 'failed')`, sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'failed' WHERE id = $1`, sessionID); err != nil {
		t.Fatal(err)
	}
	got := kinds(a.claimProblemEvents(ctx))
	if len(got) != 2 || !strings.Contains(strings.Join(got, ","), "processing_failed") || !strings.Contains(strings.Join(got, ","), "transcription_failed") {
		t.Fatalf("failure events = %v", got)
	}
	if title, body, _ := notificationTexts("de", notificationEvent{Kind: "stream_outage", SessionTitle: "113. Sitzung", Minutes: 5}); title != "„113. Sitzung“: Stream unterbrochen" || !strings.Contains(body, "5 Minuten") {
		t.Fatalf("texts = %q / %q", title, body)
	}
}
