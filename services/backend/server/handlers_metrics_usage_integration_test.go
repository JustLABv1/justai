//go:build integration

package server

import (
	"database/sql"
	"net/http"
	"os"
	"strings"
	"testing"

	_ "github.com/lib/pq"

	"justai-backend/config"
)

// Read-only: runs the aggregate queries against the configured database.
func TestUsageMetricsIntegration(t *testing.T) {
	url := os.Getenv("JUSTAI_DATABASE_URL")
	if url == "" {
		t.Skip("JUSTAI_DATABASE_URL is not configured")
	}
	db, err := sql.Open("postgres", url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	app := &App{DB: db, Config: config.Config{MetricsToken: "0123456789abcdef"}}
	rec := usageMetricsRequest(app, "Bearer 0123456789abcdef")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	for _, want := range []string{"justai_usage_events_total", "justai_mcp_tool_calls_total", "justai_workspace_events_total", "justai_workspace_chat_tokens_total", "justai_active_users{window=\"1d\"}", "justai_workspaces "} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Fatalf("missing %s in:\n%s", want, rec.Body.String())
		}
	}
	t.Log(rec.Body.String())
}
