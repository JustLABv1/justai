package server

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"justai-backend/models"
)

func TestAgentNotificationsIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	a := &App{DB: db}
	userID, orgID := uuid.New(), uuid.New()
	quiet, loud := uuid.New(), uuid.New()
	scheduled, fromChat, approval, done, loudRun := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, q := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'ada@example.org', 'Ada')`, []any{userID}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		{`INSERT INTO notification_settings (user_id, locale) VALUES ($1, 'de')`, []any{userID}},
		// quiet keeps the defaults; loud also tells about completed runs.
		{`INSERT INTO agent_workflows (id, user_id, organization_id, name) VALUES ($1, $3, $4, 'Presseschau'), ($2, $3, $4, 'Gesetzesradar')`, []any{quiet, loud, userID, orgID}},
		{`UPDATE agent_workflows SET notify_on = '{"approval":true,"failed":true,"completed":true}' WHERE id = $1`, []any{loud}},
		{`INSERT INTO agent_runs (id, user_id, organization_id, workflow_id, source_type, status, error, summary) VALUES
			($1, $6, $7, $8, 'schedule', 'failed', 'endpoint timeout', ''),
			($2, $6, $7, $8, 'chat', 'failed', 'x', ''),
			($3, $6, $7, $8, 'manual', 'waiting_approval', '', ''),
			($4, $6, $7, $8, 'schedule', 'completed', '', 'Nichts Neues.'),
			($5, $6, $7, $9, 'schedule', 'completed', '', 'Zwei neue Gesetzentwürfe zur Digitalisierung.')`, []any{scheduled, fromChat, approval, done, loudRun, userID, orgID, quiet, loud}},
	} {
		if _, err := db.ExecContext(ctx, q.query, q.args...); err != nil {
			t.Fatal(err)
		}
	}

	events := a.claimAgentRunEvents(ctx)
	kinds := map[string]notificationEvent{}
	for _, e := range events {
		kinds[e.Kind] = e
	}
	if len(events) != 3 || kinds["agent_failed"].Link != agentRunLink(scheduled) || kinds["agent_approval"].Link != agentRunLink(approval) || kinds["agent_completed"].Message != "Zwei neue Gesetzentwürfe zur Digitalisierung." {
		t.Fatalf("events = %+v (chat runs and completed runs of quiet workflows stay silent)", events)
	}
	if again := a.claimAgentRunEvents(ctx); len(again) != 0 {
		t.Fatalf("announced twice: %+v", again)
	}
	if title, _, _ := notificationTexts("de", kinds["agent_approval"]); title != "„Presseschau“ wartet auf deine Freigabe" {
		t.Fatalf("title = %q", title)
	}

	// The run continues and stops for a second approval: announced again.
	if _, err := db.ExecContext(ctx, `UPDATE agent_runs SET status = 'running', updated_at = now() WHERE id = $1`, approval); err != nil {
		t.Fatal(err)
	}
	a.claimAgentRunEvents(ctx)
	if _, err := db.ExecContext(ctx, `UPDATE agent_runs SET status = 'waiting_approval', updated_at = now() + interval '1 second' WHERE id = $1`, approval); err != nil {
		t.Fatal(err)
	}
	if again := a.claimAgentRunEvents(ctx); len(again) != 1 || again[0].Kind != "agent_approval" {
		t.Fatalf("second approval = %+v", again)
	}

	// The agent decides to notify; limits apply per run.
	request := agentExecutionRequest{UserID: userID, OrganizationID: orgID, RunID: done, Agent: models.Agent{Name: "Gesetzesradar"}}
	for i := 0; i < agentNotifyPerRun; i++ {
		if _, err := a.agentNotifyUser(ctx, request, map[string]any{"title": "Neues Gesetz", "message": "Digitalgesetz im Bundestag"}); err != nil {
			t.Fatalf("notify %d: %v", i, err)
		}
	}
	if _, err := a.agentNotifyUser(ctx, request, map[string]any{"title": "Noch eins", "message": "x"}); err == nil || !strings.Contains(err.Error(), "most allowed") {
		t.Fatalf("the per-run limit did not apply: %v", err)
	}
	var title, link string
	if err := db.QueryRowContext(ctx, `SELECT title, link FROM notifications WHERE kind = 'agent_message' LIMIT 1`).Scan(&title, &link); err != nil || title != "Neues Gesetz" || link != agentRunLink(done) {
		t.Fatalf("agent message = %q %q %v", title, link, err)
	}
}
