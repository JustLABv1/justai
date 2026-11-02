//go:build integration

package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

// Temp tables shadow production names in this transaction; no application data
// is created, changed, or removed by this test.
func TestAnalyticsInsightsSQLIntegration(t *testing.T) {
	url := os.Getenv("JUSTAI_DATABASE_URL")
	if url == "" {
		t.Skip("JUSTAI_DATABASE_URL is not configured")
	}
	db, err := sql.Open("postgres", url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	fixture := `
 CREATE TEMP TABLE users(id uuid,display_name text,email text) ON COMMIT DROP;
 CREATE TEMP TABLE organizations(id uuid,name text) ON COMMIT DROP;
 CREATE TEMP TABLE mcp_servers(id uuid,name text) ON COMMIT DROP;
 CREATE TEMP TABLE chat_runs(id uuid,user_id uuid,organization_id uuid,endpoint_id uuid,conversation_id uuid,model text,status text,started_at timestamptz,finished_at timestamptz,total_tokens bigint) ON COMMIT DROP;
 CREATE TEMP TABLE agent_runs(id uuid,user_id uuid,organization_id uuid,created_at timestamptz,started_at timestamptz,finished_at timestamptz,status text,source_type text) ON COMMIT DROP;
 CREATE TEMP TABLE transcription_sessions(id uuid,user_id uuid,organization_id uuid,created_at timestamptz,status text) ON COMMIT DROP;
 CREATE TEMP TABLE audit_events(id bigint,user_id uuid,organization_id uuid,resource_type text,resource_id uuid,action text,outcome text,created_at timestamptz,request_id text,details jsonb) ON COMMIT DROP;
 INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000001','Alice','alice@example.test'),('00000000-0000-0000-0000-000000000002','Bob','bob@example.test');
 INSERT INTO organizations VALUES ('10000000-0000-0000-0000-000000000001','One'),('10000000-0000-0000-0000-000000000002','Two');
 INSERT INTO mcp_servers VALUES ('20000000-0000-0000-0000-000000000001','Calendar');
 INSERT INTO chat_runs SELECT gen_random_uuid(),id,('10000000-0000-0000-0000-'||right(id::text,12))::uuid,NULL,gen_random_uuid(),'model',CASE WHEN display_name='Alice' THEN 'complete' ELSE 'error' END,'2026-10-22 10:00Z','2026-10-22 10:01Z',100 FROM users;
 INSERT INTO agent_runs VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','2026-10-22 11:00Z','2026-10-22 11:00Z','2026-10-22 11:01Z','completed','manual');
 INSERT INTO transcription_sessions VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-10-22 12:00Z','completed');
 INSERT INTO audit_events SELECT row_number() OVER(),u.id,('10000000-0000-0000-0000-'||right(u.id::text,12))::uuid,'mcp_tool','20000000-0000-0000-0000-000000000001',a.action,'success','2026-10-22 13:00Z',NULL,jsonb_build_object('serverId','20000000-0000-0000-0000-000000000001','tool','list_events','arguments',jsonb_build_object('secret','DO_NOT_EXPOSE'),'resultPreview','DO_NOT_EXPOSE') || CASE WHEN a.action='chat.mcp.completed' THEN jsonb_build_object('success',u.display_name='Alice') ELSE '{}'::jsonb END FROM users u CROSS JOIN (VALUES('chat.mcp.execution'),('chat.mcp.approval'),('chat.mcp.completed')) a(action);
 `
	if _, err := tx.ExecContext(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	start, end := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
	var raw []byte
	query := func(org, user any, category, outcome, search, server string, offset int) map[string]any {
		t.Helper()
		if err := tx.QueryRowContext(ctx, analyticsInsightsSQL, start, end, org, user, category, outcome, search, server, 25, offset, "YYYY-MM-DD").Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), "DO_NOT_EXPOSE") || strings.Contains(string(raw), "arguments") {
			t.Fatal("raw tool content leaked")
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	all := query(nil, nil, "", "", "", "", 0)
	summary := all["summary"].(map[string]any)
	for key, want := range map[string]float64{"activeUsers": 2, "activeWorkspaces": 2, "chatRuns": 2, "mcpCalls": 2, "mcpFailures": 1, "agentRuns": 1, "transcriptions": 1} {
		if summary[key] != want {
			t.Fatalf("%s = %v want %v", key, summary[key], want)
		}
	}
	tools := all["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["calls"] != float64(2) {
		t.Fatalf("completion events double counted: %v", tools)
	}
	filtered := query("10000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000002", "mcp", "failed", "list_events", "20000000-0000-0000-0000-000000000001", 0)
	activity := filtered["activity"].(map[string]any)
	// The failed completion is distinct from approval and execution events.
	if activity["total"] != float64(1) {
		t.Fatalf("filtered events = %v", activity)
	}
	if filtered["summary"].(map[string]any)["mcpCalls"] != float64(1) {
		t.Fatal("user/workspace scope leaked")
	}
	emptyPage := query(nil, nil, "mcp", "", "", "", 100)["activity"].(map[string]any)
	if emptyPage["total"] != float64(6) || len(emptyPage["items"].([]any)) != 0 {
		t.Fatalf("pagination total lost: %v", emptyPage)
	}
	if query(nil, nil, "", "", "%", "", 0)["activity"].(map[string]any)["total"] != float64(0) {
		t.Fatal("search wildcard was not literal")
	}
}
