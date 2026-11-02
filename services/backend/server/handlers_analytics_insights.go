package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Each source row is one recorded operation or audit event. MCP usage is counted
// only from canonical completion events, never approval/execution notifications.
const analyticsInsightsSQL = `WITH source AS (
 SELECT 'chat:' || r.id::text AS id, r.user_id, r.organization_id, 'chat'::text AS category,
   'chat.request'::text AS action,
   CASE WHEN r.status = 'complete' THEN 'success' WHEN r.status IN ('error','incomplete') THEN 'failed' WHEN r.status = 'cancelled' THEN 'cancelled' ELSE 'pending' END AS outcome,
   r.started_at AS occurred_at, ''::text AS server_id, ''::text AS server_name, ''::text AS tool,
   false AS mcp_completion, r.total_tokens,
   jsonb_build_object('model', r.model, 'endpointId', r.endpoint_id, 'conversationId', r.conversation_id, 'status', r.status, 'startedAt', r.started_at, 'finishedAt', r.finished_at, 'totalTokens', r.total_tokens,
     'durationMs', CASE WHEN r.finished_at IS NOT NULL THEN round(extract(epoch FROM (r.finished_at-r.started_at))*1000) ELSE NULL END) AS metadata
 FROM chat_runs r WHERE r.started_at >= $1 AND r.started_at < $2
 UNION ALL
 SELECT 'agent:' || r.id::text, r.user_id, r.organization_id, 'agents', 'agent.run',
   CASE WHEN r.status='completed' THEN 'success' WHEN r.status='failed' THEN 'failed' WHEN r.status='cancelled' THEN 'cancelled' ELSE 'pending' END,
   r.created_at, '', '', '', false, NULL::bigint,
   jsonb_build_object('runId', r.id, 'source', r.source_type, 'status', r.status, 'startedAt', r.started_at, 'finishedAt', r.finished_at)
 FROM agent_runs r WHERE r.created_at >= $1 AND r.created_at < $2
 UNION ALL
 SELECT 'transcription:' || s.id::text, s.user_id, s.organization_id, 'transcription', 'transcription.session',
   CASE WHEN s.status='completed' THEN 'success' WHEN s.status='failed' THEN 'failed' ELSE 'pending' END,
   s.created_at, '', '', '', false, NULL::bigint, jsonb_build_object('sessionId', s.id, 'status', s.status)
 FROM transcription_sessions s WHERE s.created_at >= $1 AND s.created_at < $2
 UNION ALL
 SELECT 'audit:' || a.id::text, a.user_id, a.organization_id,
   CASE WHEN a.action LIKE 'chat.mcp.%' OR a.action LIKE 'voice.mcp.%' OR a.action LIKE 'agent.mcp.%' OR a.action LIKE 'mcp.app.%' THEN 'mcp' ELSE 'audit' END,
   a.action,
   CASE WHEN a.details->>'success' = 'false' OR a.outcome IN ('failed','failure','error') THEN 'failed'
     WHEN a.details->>'approved' = 'false' THEN 'cancelled' WHEN a.action LIKE '%.execution' THEN 'pending' ELSE COALESCE(NULLIF(a.outcome,''),'success') END,
   a.created_at, COALESCE(a.details->>'serverId', CASE WHEN a.resource_type IN ('mcp_tool','mcp_server') THEN a.resource_id::text END, ''),
   COALESCE(a.details->>'serverName', ''), COALESCE(a.details->>'tool',''),
   a.action IN ('chat.mcp.completed','voice.mcp.completed','agent.mcp.completed','mcp.app.completed'), NULL::bigint,
   jsonb_strip_nulls(jsonb_build_object('eventId',a.id,'resourceType',a.resource_type,'resourceId',a.resource_id,'requestId',a.request_id,
     'conversationId',a.details->>'conversationId','runId',a.details->>'runId','approved',a.details->'approved','approvalId',a.details->>'approvalId','status',a.details->>'status'))
 FROM audit_events a WHERE a.created_at >= $1 AND a.created_at < $2
), scoped AS (
 SELECT s.*, COALESCE(u.display_name,CASE WHEN s.user_id IS NULL THEN 'System' ELSE 'Deleted user' END) AS user_name, COALESCE(u.email,'') AS user_email,
   COALESCE(o.name,CASE WHEN s.organization_id IS NULL THEN 'Platform' ELSE 'Deleted workspace' END) AS workspace_name,
   COALESCE(m.name,NULLIF(s.server_name,''),'Unknown MCP server') AS resolved_server_name
 FROM source s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN organizations o ON o.id=s.organization_id
 LEFT JOIN mcp_servers m ON m.id::text=s.server_id
 WHERE ($3::uuid IS NULL OR s.organization_id=$3::uuid) AND ($4::uuid IS NULL OR s.user_id=$4::uuid)
), activity AS (
 SELECT * FROM scoped WHERE ($5='' OR category=$5) AND ($6='' OR outcome=$6)
   AND ($7='' OR strpos(lower(user_name || ' ' || user_email || ' ' || workspace_name || ' ' || action || ' ' || resolved_server_name || ' ' || tool || ' ' || COALESCE(metadata->>'model','')),lower($7)) > 0)
   AND ($8='' OR server_id=$8)
), page_rows AS (
 SELECT * FROM activity ORDER BY occurred_at DESC,id DESC LIMIT $9 OFFSET $10
), daily AS (
 SELECT to_char(occurred_at AT TIME ZONE 'UTC',$11::text) AS date,
   count(*) FILTER (WHERE category='chat')::int AS chats, count(*) FILTER (WHERE mcp_completion)::int AS tools,
   count(*) FILTER (WHERE category='agents')::int AS agents, count(*) FILTER (WHERE category='transcription')::int AS transcriptions,
   count(DISTINCT user_id)::int AS users
 FROM scoped GROUP BY 1 ORDER BY 1
), by_user AS (
 SELECT user_id, max(user_name) AS name, max(user_email) AS email, count(*)::int AS events,
   count(*) FILTER (WHERE category='chat')::int AS chats, count(*) FILTER (WHERE mcp_completion)::int AS tools,
   count(*) FILTER (WHERE category='agents')::int AS agents, count(*) FILTER (WHERE category='transcription')::int AS transcriptions,
   sum(total_tokens) AS tokens, max(occurred_at) AS last_active
 FROM scoped WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY count(*) DESC,user_id LIMIT 50
), by_workspace AS (
 SELECT organization_id, max(workspace_name) AS name, count(DISTINCT user_id)::int AS users,
   count(*) FILTER (WHERE category='chat')::int AS chats, count(*) FILTER (WHERE mcp_completion)::int AS tools,
   count(*) FILTER (WHERE category='agents')::int AS agents, count(*) FILTER (WHERE category='transcription')::int AS transcriptions,
   count(*)::int AS events, max(occurred_at) AS last_active
 FROM scoped WHERE organization_id IS NOT NULL GROUP BY organization_id ORDER BY count(*) DESC,organization_id LIMIT 50
), by_tool AS (
 SELECT server_id,max(resolved_server_name) AS resolved_server_name,tool,count(*)::int AS calls,count(*) FILTER (WHERE outcome='failed')::int AS failed,
   count(DISTINCT user_id)::int AS users,max(occurred_at) AS last_used
 FROM scoped WHERE mcp_completion GROUP BY server_id,tool ORDER BY count(*) DESC,server_id,tool LIMIT 50
)
SELECT jsonb_build_object(
 'summary',(SELECT jsonb_build_object('activeUsers',count(DISTINCT user_id),'activeWorkspaces',count(DISTINCT organization_id),
   'chatRuns',count(*) FILTER (WHERE category='chat'),'mcpCalls',count(*) FILTER (WHERE mcp_completion),
   'mcpFailures',count(*) FILTER (WHERE mcp_completion AND outcome='failed'),
   'agentRuns',count(*) FILTER (WHERE category='agents'),'transcriptions',count(*) FILTER (WHERE category='transcription'),'events',count(*)) FROM scoped),
 'daily',COALESCE((SELECT jsonb_agg(jsonb_build_object('date',date,'chatRuns',chats,'mcpCalls',tools,'agentRuns',agents,'transcriptions',transcriptions,'activeUsers',users) ORDER BY date) FROM daily),'[]'::jsonb),
 'users',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',user_id,'name',name,'email',email,'events',events,'chatRuns',chats,'mcpCalls',tools,'agentRuns',agents,'transcriptions',transcriptions,'tokens',tokens,'lastActive',last_active) ORDER BY events DESC,user_id) FROM by_user),'[]'::jsonb),
 'workspaces',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',organization_id,'name',name,'activeUsers',users,'chatRuns',chats,'mcpCalls',tools,'agentRuns',agents,'transcriptions',transcriptions,'events',events,'lastActive',last_active) ORDER BY events DESC,organization_id) FROM by_workspace),'[]'::jsonb),
 'tools',COALESCE((SELECT jsonb_agg(jsonb_build_object('serverId',server_id,'serverName',resolved_server_name,'tool',tool,'calls',calls,'failed',failed,'users',users,'lastUsed',last_used) ORDER BY calls DESC,server_id,tool) FROM by_tool),'[]'::jsonb),
 'activity',jsonb_build_object('total',(SELECT count(*) FROM activity),'items',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'id',id,'userId',user_id,'userName',user_name,'userEmail',user_email,'organizationId',organization_id,'workspaceName',workspace_name,
   'category',category,'action',action,'outcome',outcome,'occurredAt',occurred_at,'serverId',NULLIF(server_id,''),
   'serverName',CASE WHEN server_id<>'' THEN resolved_server_name ELSE NULL END,'tool',NULLIF(tool,''),'metadata',metadata) ORDER BY occurred_at DESC,id DESC) FROM page_rows),'[]'::jsonb)))`

func (a *App) getPlatformAnalyticsInsights(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	start, end, err := analyticsRange(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	ids := make([]any, 2)
	for i, key := range []string{"organizationId", "userId"} {
		if raw := strings.TrimSpace(c.Query(key)); raw != "" {
			id, err := uuid.Parse(raw)
			if err != nil {
				writeError(c, http.StatusBadRequest, fmt.Errorf("invalid %s", key))
				return
			}
			ids[i] = id
		}
	}
	category, outcome := strings.TrimSpace(c.Query("category")), strings.TrimSpace(c.Query("outcome"))
	if !validAnalyticsCategory(category) || !validAnalyticsOutcome(outcome) {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid activity category or outcome"))
		return
	}
	serverID := strings.TrimSpace(c.Query("serverId"))
	if serverID != "" {
		if _, err := uuid.Parse(serverID); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid serverId"))
			return
		}
	}
	page, pageSize, offset := pageValues(c)
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	bucket, bucketFormat := analyticsBucket(end.Sub(start))
	var result json.RawMessage
	if err := a.DB.QueryRowContext(ctx, analyticsInsightsSQL, start, end, ids[0], ids[1], category, outcome, strings.TrimSpace(c.Query("search")), serverID, pageSize, offset, bucketFormat).Scan(&result); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(result, &body); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	body["period"], _ = json.Marshal(gin.H{"from": start, "to": end})
	body["bucket"], _ = json.Marshal(bucket)
	body["page"], _ = json.Marshal(page)
	body["pageSize"], _ = json.Marshal(pageSize)
	c.JSON(http.StatusOK, body)
}

// analyticsBucket picks the chart granularity for a reporting span: minutes up
// to 2 hours, hours up to 3 days, otherwise UTC days.
func analyticsBucket(span time.Duration) (string, string) {
	switch {
	case span <= 2*time.Hour:
		return "minute", `YYYY-MM-DD"T"HH24:MI`
	case span <= 72*time.Hour:
		return "hour", `YYYY-MM-DD"T"HH24:00`
	default:
		return "day", "YYYY-MM-DD"
	}
}

func validAnalyticsCategory(value string) bool {
	switch value {
	case "", "chat", "mcp", "agents", "transcription", "audit":
		return true
	}
	return false
}
func validAnalyticsOutcome(value string) bool {
	switch value {
	case "", "success", "failed", "cancelled", "pending":
		return true
	}
	return false
}
