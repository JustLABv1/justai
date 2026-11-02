package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const usageMetricsTTL = 30 * time.Second

// usageMetricsCache keeps scrapes from hammering the database: any number of
// scrapers within the TTL share one set of aggregate queries.
type usageMetricsCache struct {
	mu      sync.Mutex
	body    string
	expires time.Time
}

// Counts are all-time totals per category and outcome, matching the outcome
// mapping used by the admin analytics view.
const usageEventsSQL = `SELECT category, outcome, count(*)::bigint, COALESCE(sum(tokens),0)::bigint FROM (
 SELECT 'chat' AS category,
   CASE WHEN status='complete' THEN 'success' WHEN status IN ('error','incomplete') THEN 'failed' WHEN status='cancelled' THEN 'cancelled' ELSE 'pending' END AS outcome,
   total_tokens AS tokens FROM chat_runs
 UNION ALL
 SELECT 'agents', CASE WHEN status='completed' THEN 'success' WHEN status='failed' THEN 'failed' WHEN status='cancelled' THEN 'cancelled' ELSE 'pending' END, NULL::bigint FROM agent_runs
 UNION ALL
 SELECT 'transcription', CASE WHEN status='completed' THEN 'success' WHEN status='failed' THEN 'failed' ELSE 'pending' END, NULL::bigint FROM transcription_sessions
) e GROUP BY 1,2 ORDER BY 1,2`

const usageMCPSQL = `SELECT COALESCE(m.name, NULLIF(a.details->>'serverName',''), 'unknown') AS server,
   COALESCE(NULLIF(a.details->>'tool',''), 'unknown') AS tool,
   CASE WHEN a.details->>'success'='false' OR a.outcome IN ('failed','failure','error') THEN 'failed'
     WHEN a.details->>'approved'='false' THEN 'cancelled' ELSE 'success' END AS outcome,
   count(*)::bigint
 FROM audit_events a LEFT JOIN mcp_servers m ON m.id::text = COALESCE(a.details->>'serverId', CASE WHEN a.resource_type IN ('mcp_tool','mcp_server') THEN a.resource_id::text END)
 WHERE a.action IN ('chat.mcp.completed','voice.mcp.completed','agent.mcp.completed','mcp.app.completed')
 GROUP BY 1,2,3 ORDER BY count(*) DESC, 1,2,3 LIMIT 500`

const usageActiveSQL = `WITH act AS (
 SELECT user_id, organization_id, started_at AS ts FROM chat_runs WHERE started_at >= now() - interval '7 days'
 UNION ALL SELECT user_id, organization_id, created_at FROM agent_runs WHERE created_at >= now() - interval '7 days'
 UNION ALL SELECT user_id, organization_id, created_at FROM transcription_sessions WHERE created_at >= now() - interval '7 days'
 UNION ALL SELECT user_id, organization_id, created_at FROM audit_events WHERE created_at >= now() - interval '7 days'
)
SELECT count(DISTINCT user_id) FILTER (WHERE ts >= now() - interval '1 day')::bigint,
  count(DISTINCT user_id)::bigint,
  count(DISTINCT organization_id) FILTER (WHERE ts >= now() - interval '1 day')::bigint,
  count(DISTINCT organization_id)::bigint,
  (SELECT count(*) FROM users)::bigint, (SELECT count(*) FROM organizations)::bigint FROM act`

// Per-workspace series are limited to the busiest workspaces to bound label
// cardinality. Activity without a workspace (platform/system) is excluded.
const usageWorkspaceLimit = 100

const usageWorkspaceSQL = `WITH ev AS (
 SELECT organization_id, 'chat' AS category,
   CASE WHEN status='complete' THEN 'success' WHEN status IN ('error','incomplete') THEN 'failed' WHEN status='cancelled' THEN 'cancelled' ELSE 'pending' END AS outcome,
   total_tokens AS tokens FROM chat_runs WHERE organization_id IS NOT NULL
 UNION ALL
 SELECT organization_id, 'agents', CASE WHEN status='completed' THEN 'success' WHEN status='failed' THEN 'failed' WHEN status='cancelled' THEN 'cancelled' ELSE 'pending' END, NULL::bigint
   FROM agent_runs WHERE organization_id IS NOT NULL
 UNION ALL
 SELECT organization_id, 'transcription', CASE WHEN status='completed' THEN 'success' WHEN status='failed' THEN 'failed' ELSE 'pending' END, NULL::bigint
   FROM transcription_sessions WHERE organization_id IS NOT NULL
 UNION ALL
 SELECT a.organization_id, 'mcp',
   CASE WHEN a.details->>'success'='false' OR a.outcome IN ('failed','failure','error') THEN 'failed' WHEN a.details->>'approved'='false' THEN 'cancelled' ELSE 'success' END,
   NULL::bigint
   FROM audit_events a WHERE a.organization_id IS NOT NULL
   AND a.action IN ('chat.mcp.completed','voice.mcp.completed','agent.mcp.completed','mcp.app.completed')
), top AS (
 SELECT organization_id FROM ev GROUP BY organization_id ORDER BY count(*) DESC, organization_id LIMIT $1
)
SELECT ev.organization_id::text, COALESCE(o.name, ''), ev.category, ev.outcome, count(*)::bigint, COALESCE(sum(ev.tokens),0)::bigint
FROM ev JOIN top USING (organization_id) LEFT JOIN organizations o ON o.id = ev.organization_id
GROUP BY 1,2,3,4 ORDER BY 1,3,4`

func (a *App) usageMetricsHandler(c *gin.Context) {
	token := a.Config.MetricsToken
	if token == "" {
		c.Status(http.StatusNotFound)
		return
	}
	given := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	want, have := sha256.Sum256([]byte(token)), sha256.Sum256([]byte(given))
	if !strings.HasPrefix(c.GetHeader("Authorization"), "Bearer ") || subtle.ConstantTimeCompare(want[:], have[:]) != 1 {
		c.Header("WWW-Authenticate", `Bearer realm="metrics"`)
		c.Status(http.StatusUnauthorized)
		return
	}
	cache := &a.usageMetrics
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if time.Now().Before(cache.expires) {
		c.Data(http.StatusOK, "text/plain; version=0.0.4", []byte(cache.body))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()
	body, err := a.buildUsageMetrics(ctx)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	cache.body, cache.expires = body, time.Now().Add(usageMetricsTTL)
	c.Data(http.StatusOK, "text/plain; version=0.0.4", []byte(body))
}

func (a *App) buildUsageMetrics(ctx context.Context) (string, error) {
	var b strings.Builder
	rows, err := a.DB.QueryContext(ctx, usageEventsSQL)
	if err != nil {
		return "", err
	}
	type eventRow struct {
		category, outcome string
		count, tokens     int64
	}
	var events []eventRow
	for rows.Next() {
		var r eventRow
		if err := rows.Scan(&r.category, &r.outcome, &r.count, &r.tokens); err != nil {
			rows.Close()
			return "", err
		}
		events = append(events, r)
	}
	if err := closeRows(rows); err != nil {
		return "", err
	}
	b.WriteString("# HELP justai_usage_events_total Recorded model requests, agent runs and transcription sessions.\n# TYPE justai_usage_events_total counter\n")
	for _, r := range events {
		fmt.Fprintf(&b, "justai_usage_events_total{category=%s,outcome=%s} %d\n", metricLabel(r.category), metricLabel(r.outcome), r.count)
	}
	b.WriteString("# HELP justai_usage_chat_tokens_total Tokens reported by model requests.\n# TYPE justai_usage_chat_tokens_total counter\n")
	var tokens int64
	for _, r := range events {
		tokens += r.tokens
	}
	fmt.Fprintf(&b, "justai_usage_chat_tokens_total %d\n", tokens)

	rows, err = a.DB.QueryContext(ctx, usageMCPSQL)
	if err != nil {
		return "", err
	}
	b.WriteString("# HELP justai_mcp_tool_calls_total Completed MCP tool calls (top 500 server/tool/outcome combinations).\n# TYPE justai_mcp_tool_calls_total counter\n")
	for rows.Next() {
		var server, tool, outcome string
		var count int64
		if err := rows.Scan(&server, &tool, &outcome, &count); err != nil {
			rows.Close()
			return "", err
		}
		fmt.Fprintf(&b, "justai_mcp_tool_calls_total{server=%s,tool=%s,outcome=%s} %d\n", metricLabel(server), metricLabel(tool), metricLabel(outcome), count)
	}
	if err := closeRows(rows); err != nil {
		return "", err
	}

	rows, err = a.DB.QueryContext(ctx, usageWorkspaceSQL, usageWorkspaceLimit)
	if err != nil {
		return "", err
	}
	type workspaceRow struct {
		id, name, category, outcome string
		count, tokens               int64
	}
	var workspaces []workspaceRow
	for rows.Next() {
		var r workspaceRow
		if err := rows.Scan(&r.id, &r.name, &r.category, &r.outcome, &r.count, &r.tokens); err != nil {
			rows.Close()
			return "", err
		}
		workspaces = append(workspaces, r)
	}
	if err := closeRows(rows); err != nil {
		return "", err
	}
	b.WriteString("# HELP justai_workspace_events_total Recorded operations per workspace (busiest workspaces only). Category mcp counts completed tool calls.\n# TYPE justai_workspace_events_total counter\n")
	for _, r := range workspaces {
		fmt.Fprintf(&b, "justai_workspace_events_total{workspace_id=%s,workspace=%s,category=%s,outcome=%s} %d\n", metricLabel(r.id), metricLabel(r.name), metricLabel(r.category), metricLabel(r.outcome), r.count)
	}
	b.WriteString("# HELP justai_workspace_chat_tokens_total Tokens reported by model requests per workspace.\n# TYPE justai_workspace_chat_tokens_total counter\n")
	chatTokens := map[string]int64{}
	var order []workspaceRow
	for _, r := range workspaces {
		if r.category != "chat" {
			continue
		}
		if _, ok := chatTokens[r.id]; !ok {
			order = append(order, r)
		}
		chatTokens[r.id] += r.tokens
	}
	for _, r := range order {
		fmt.Fprintf(&b, "justai_workspace_chat_tokens_total{workspace_id=%s,workspace=%s} %d\n", metricLabel(r.id), metricLabel(r.name), chatTokens[r.id])
	}

	var users1d, users7d, orgs1d, orgs7d, users, orgs int64
	if err := a.DB.QueryRowContext(ctx, usageActiveSQL).Scan(&users1d, &users7d, &orgs1d, &orgs7d, &users, &orgs); err != nil {
		return "", err
	}
	b.WriteString("# HELP justai_active_users Distinct users with recorded activity in the window.\n# TYPE justai_active_users gauge\n")
	fmt.Fprintf(&b, "justai_active_users{window=\"1d\"} %d\njustai_active_users{window=\"7d\"} %d\n", users1d, users7d)
	b.WriteString("# HELP justai_active_workspaces Distinct workspaces with recorded activity in the window.\n# TYPE justai_active_workspaces gauge\n")
	fmt.Fprintf(&b, "justai_active_workspaces{window=\"1d\"} %d\njustai_active_workspaces{window=\"7d\"} %d\n", orgs1d, orgs7d)
	b.WriteString("# HELP justai_users Registered users.\n# TYPE justai_users gauge\n")
	fmt.Fprintf(&b, "justai_users %d\n", users)
	b.WriteString("# HELP justai_workspaces Workspaces.\n# TYPE justai_workspaces gauge\n")
	fmt.Fprintf(&b, "justai_workspaces %d\n", orgs)
	return b.String(), nil
}

func closeRows(rows *sql.Rows) error {
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	return rows.Close()
}

// metricLabel renders a quoted Prometheus label value.
func metricLabel(value string) string {
	value = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(value)
	return `"` + value + `"`
}
