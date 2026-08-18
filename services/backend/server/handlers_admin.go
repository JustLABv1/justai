package server

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

type adminDefaults struct {
	EndpointID   *uuid.UUID  `json:"endpointId"`
	MCPServerIDs []uuid.UUID `json:"mcpServerIds"`
}

func (a *App) getOrganizationAdminDefaults(c *gin.Context) {
	organizationID, ok := a.adminOrganizationID(c, c.Param("id"))
	if !ok {
		return
	}
	defaults, err := a.readAdminDefaults(c, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, defaults)
}

func (a *App) putOrganizationAdminDefaults(c *gin.Context) {
	organizationID, ok := a.adminOrganizationID(c, c.Param("id"))
	if !ok {
		return
	}
	var request struct {
		EndpointID   *string  `json:"endpointId"`
		MCPServerIDs []string `json:"mcpServerIds"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	endpointID, err := parseNullableUUID(request.EndpointID)
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid endpointId"))
		return
	}
	serverIDs := make([]uuid.UUID, 0, len(request.MCPServerIDs))
	seen := make(map[uuid.UUID]struct{}, len(request.MCPServerIDs))
	for _, raw := range request.MCPServerIDs {
		id, parseErr := uuid.Parse(strings.TrimSpace(raw))
		if parseErr != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid MCP server id"))
			return
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		serverIDs = append(serverIDs, id)
	}

	tx, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer tx.Rollback()
	if endpointID != nil {
		var valid bool
		if err := tx.QueryRowContext(c, `
			SELECT EXISTS (
				SELECT 1 FROM endpoint_settings
				WHERE id = $1 AND enabled = TRUE AND (capabilities->>'chat') = 'true'
				  AND ((scope_type = 'organization' AND scope_id = $2) OR scope_type = 'global')
			)`, *endpointID, organizationID).Scan(&valid); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if !valid {
			writeError(c, http.StatusBadRequest, fmt.Errorf("endpoint is not available to this organization"))
			return
		}
	}
	if _, err := tx.ExecContext(c, `UPDATE endpoint_settings SET is_default = FALSE, updated_at = now() WHERE scope_type = 'organization' AND scope_id = $1`, organizationID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := tx.ExecContext(c, `DELETE FROM organization_default_endpoints WHERE organization_id = $1`, organizationID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if endpointID != nil {
		var scopeType string
		if err := tx.QueryRowContext(c, `SELECT scope_type FROM endpoint_settings WHERE id = $1`, *endpointID).Scan(&scopeType); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if scopeType == "organization" {
			if _, err := tx.ExecContext(c, `UPDATE endpoint_settings SET is_default = TRUE, updated_at = now() WHERE id = $1`, *endpointID); err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
		}
		if _, err := tx.ExecContext(c, `INSERT INTO organization_default_endpoints (organization_id, endpoint_id, created_by) VALUES ($1, $2, $3)`, organizationID, *endpointID, principal.UserID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if _, err := tx.ExecContext(c, `DELETE FROM organization_mcp_defaults WHERE organization_id = $1`, organizationID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	for _, serverID := range serverIDs {
		var valid bool
		if err := tx.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM mcp_servers WHERE id = $1 AND enabled = TRUE AND ((scope_type = 'global') OR (scope_type = 'organization' AND scope_id = $2)))`, serverID, organizationID).Scan(&valid); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if !valid {
			writeError(c, http.StatusBadRequest, fmt.Errorf("MCP server is not enabled in this organization"))
			return
		}
		if _, err := tx.ExecContext(c, `INSERT INTO organization_mcp_defaults (organization_id, server_id, created_by) VALUES ($1, $2, $3)`, organizationID, serverID, principal.UserID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defaults, err := a.readAdminDefaults(c, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, defaults)
}

func (a *App) getGlobalAdminDefaults(c *gin.Context) {
	principal, ok := middleware.GetPrincipal(c)
	if !ok || !principal.PlatformAdmin {
		writeError(c, http.StatusForbidden, fmt.Errorf("platform admin access required"))
		return
	}
	var endpointID sql.NullString
	err := a.DB.QueryRowContext(c, `SELECT id::text FROM endpoint_settings WHERE scope_type = 'global' AND is_default = TRUE LIMIT 1`).Scan(&endpointID)
	if err != nil && err != sql.ErrNoRows {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defaults := adminDefaults{MCPServerIDs: []uuid.UUID{}}
	defaults.EndpointID = parseOptionalUUID(endpointID)
	c.JSON(http.StatusOK, defaults)
}

func (a *App) putGlobalAdminDefaults(c *gin.Context) {
	principal, ok := middleware.GetPrincipal(c)
	if !ok || !principal.PlatformAdmin {
		writeError(c, http.StatusForbidden, fmt.Errorf("platform admin access required"))
		return
	}
	var request struct {
		EndpointID *string `json:"endpointId"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	endpointID, err := parseNullableUUID(request.EndpointID)
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid endpointId"))
		return
	}
	tx, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(c, `UPDATE endpoint_settings SET is_default = FALSE, updated_at = now() WHERE scope_type = 'global'`); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if endpointID != nil {
		var valid bool
		if err := tx.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM endpoint_settings WHERE id = $1 AND scope_type = 'global' AND enabled = TRUE AND (capabilities->>'chat') = 'true')`, *endpointID).Scan(&valid); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if !valid {
			writeError(c, http.StatusBadRequest, fmt.Errorf("global endpoint is not available"))
			return
		}
		if _, err := tx.ExecContext(c, `UPDATE endpoint_settings SET is_default = TRUE, updated_at = now() WHERE id = $1`, *endpointID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.defaults.updated", "platform_defaults", nil, gin.H{"endpointChanged": true})
	a.getGlobalAdminDefaults(c)
}

func (a *App) readAdminDefaults(ctx *gin.Context, organizationID uuid.UUID) (adminDefaults, error) {
	var endpointID sql.NullString
	err := a.DB.QueryRowContext(ctx, `SELECT endpoint_id::text FROM organization_default_endpoints WHERE organization_id = $1`, organizationID).Scan(&endpointID)
	if err == sql.ErrNoRows {
		err = a.DB.QueryRowContext(ctx, `
			SELECT id::text FROM endpoint_settings
			WHERE is_default = TRUE AND scope_type = 'organization' AND scope_id = $1
			LIMIT 1`, organizationID).Scan(&endpointID)
	}
	if err != nil && err != sql.ErrNoRows {
		return adminDefaults{}, err
	}
	result := adminDefaults{EndpointID: parseOptionalUUID(endpointID), MCPServerIDs: []uuid.UUID{}}
	rows, err := a.DB.QueryContext(ctx, `SELECT server_id FROM organization_mcp_defaults WHERE organization_id = $1 ORDER BY created_at, server_id`, organizationID)
	if err != nil {
		return adminDefaults{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return adminDefaults{}, err
		}
		result.MCPServerIDs = append(result.MCPServerIDs, id)
	}
	return result, rows.Err()
}

func (a *App) adminOrganizationID(c *gin.Context, raw string) (uuid.UUID, bool) {
	organizationID, err := uuid.Parse(raw)
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid organization id"))
		return uuid.Nil, false
	}
	principal, ok := middleware.GetPrincipal(c)
	if !ok {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("authentication required"))
		return uuid.Nil, false
	}
	contextOrganization, _ := middleware.GetOrganizationID(c)
	if contextOrganization != uuid.Nil && contextOrganization != organizationID && !principal.PlatformAdmin {
		writeError(c, http.StatusForbidden, fmt.Errorf("organization context mismatch"))
		return uuid.Nil, false
	}
	if principal.PlatformAdmin {
		return organizationID, true
	}
	var role string
	if err := a.DB.QueryRowContext(c, `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`, organizationID, principal.UserID).Scan(&role); err != nil {
		writeError(c, http.StatusForbidden, fmt.Errorf("organization access required"))
		return uuid.Nil, false
	}
	if role != "owner" && role != "admin" {
		writeError(c, http.StatusForbidden, fmt.Errorf("organization owner or admin access required"))
		return uuid.Nil, false
	}
	return organizationID, true
}

func parseNullableUUID(value *string) (*uuid.UUID, error) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil, nil
	}
	id, err := uuid.Parse(strings.TrimSpace(*value))
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (a *App) getOrganizationAnalytics(c *gin.Context) {
	organizationID, ok := a.adminOrganizationID(c, c.Param("id"))
	if !ok {
		return
	}
	a.writeAnalytics(c, &organizationID)
}

func (a *App) getPlatformAnalytics(c *gin.Context) {
	principal, ok := middleware.GetPrincipal(c)
	if !ok || !principal.PlatformAdmin {
		writeError(c, http.StatusForbidden, fmt.Errorf("platform admin access required"))
		return
	}
	if raw := strings.TrimSpace(c.Query("organizationId")); raw != "" {
		organizationID, err := uuid.Parse(raw)
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid organizationId"))
			return
		}
		a.writeAnalytics(c, &organizationID)
		return
	}
	a.writeAnalytics(c, nil)
}

type adminAnalyticsSummary struct {
	Requests       int     `json:"requests"`
	Succeeded      int     `json:"succeeded"`
	Failed         int     `json:"failed"`
	Cancelled      int     `json:"cancelled"`
	AverageLatency float64 `json:"averageLatencyMs"`
	P95Latency     float64 `json:"p95LatencyMs"`
	AverageTTFT    float64 `json:"averageTtftMs"`
	InputTokens    *int64  `json:"inputTokens"`
	OutputTokens   *int64  `json:"outputTokens"`
	TotalTokens    *int64  `json:"totalTokens"`
	ToolCalls      int     `json:"toolCalls"`
}

type adminAnalyticsEndpoint struct {
	EndpointID       string  `json:"endpointId"`
	EndpointName     string  `json:"endpointName"`
	Model            string  `json:"model"`
	Requests         int     `json:"requests"`
	Errors           int     `json:"errors"`
	AverageLatencyMs float64 `json:"averageLatencyMs"`
}

type adminAnalyticsDay struct {
	Date             string  `json:"date"`
	Requests         int     `json:"requests"`
	Succeeded        int     `json:"succeeded"`
	Failed           int     `json:"failed"`
	Cancelled        int     `json:"cancelled"`
	AverageLatencyMs float64 `json:"averageLatencyMs"`
	ToolCalls        int     `json:"toolCalls"`
	InputTokens      *int64  `json:"inputTokens"`
	OutputTokens     *int64  `json:"outputTokens"`
	TotalTokens      *int64  `json:"totalTokens"`
}

type adminAnalytics struct {
	Summary    adminAnalyticsSummary    `json:"summary"`
	ByEndpoint []adminAnalyticsEndpoint `json:"byEndpoint"`
	TimeSeries []adminAnalyticsDay      `json:"timeSeries"`
}

func (a *App) writeAnalytics(c *gin.Context, organizationID *uuid.UUID) {
	analytics, err := a.readAnalytics(c, organizationID)
	if err != nil {
		writeError(c, analyticsErrorStatus(err), err)
		return
	}
	c.JSON(http.StatusOK, analytics)
}

func analyticsErrorStatus(err error) int {
	if strings.HasPrefix(err.Error(), "invalid ") || strings.HasPrefix(err.Error(), "days ") || strings.HasPrefix(err.Error(), "from ") || strings.HasPrefix(err.Error(), "to ") {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

func (a *App) readAnalytics(c *gin.Context, organizationID *uuid.UUID) (adminAnalytics, error) {
	start, end, err := analyticsRange(c)
	if err != nil {
		return adminAnalytics{}, err
	}
	endpointID, err := parseAnalyticsEndpointID(c.Query("endpointId"))
	if err != nil {
		return adminAnalytics{}, err
	}
	model := strings.TrimSpace(c.Query("model"))
	status := strings.ToLower(strings.TrimSpace(c.Query("status")))
	if status != "" {
		validStatuses := map[string]bool{"running": true, "requires-action": true, "complete": true, "error": true, "cancelled": true, "incomplete": true}
		if !validStatuses[status] {
			return adminAnalytics{}, fmt.Errorf("status must be running, requires-action, complete, error, cancelled, or incomplete")
		}
	}

	// Build the same parameter list for the summary, endpoint breakdown, and
	// time-series queries. The alias is intentionally supplied by each query so
	// filters remain unambiguous when chat_runs is joined to endpoint_settings.
	args := []any{start, end}
	if organizationID != nil {
		args = append(args, *organizationID)
	}
	if endpointID != nil {
		args = append(args, *endpointID)
	}
	if model != "" {
		args = append(args, model)
	}
	if status != "" {
		args = append(args, status)
	}
	whereFor := func(alias string) string {
		prefix := ""
		if alias != "" {
			prefix = alias + "."
		}
		parts := []string{prefix + "started_at >= $1", prefix + "started_at < $2"}
		position := 3
		if organizationID != nil {
			parts = append(parts, prefix+fmt.Sprintf("organization_id = $%d", position))
			position++
		}
		if endpointID != nil {
			parts = append(parts, prefix+fmt.Sprintf("endpoint_id = $%d", position))
			position++
		}
		if model != "" {
			parts = append(parts, prefix+fmt.Sprintf("model = $%d", position))
			position++
		}
		if status != "" {
			parts = append(parts, prefix+fmt.Sprintf("status = $%d", position))
		}
		return strings.Join(parts, " AND ")
	}
	var summary adminAnalyticsSummary
	query := `SELECT COUNT(*)::int, COUNT(*) FILTER (WHERE status = 'complete')::int, COUNT(*) FILTER (WHERE status = 'error')::int, COUNT(*) FILTER (WHERE status = 'cancelled')::int, COALESCE(AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL), 0), COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL), 0), COALESCE(AVG(EXTRACT(EPOCH FROM (first_token_at - started_at)) * 1000) FILTER (WHERE first_token_at IS NOT NULL), 0), SUM(input_tokens), SUM(output_tokens), SUM(total_tokens), COALESCE(SUM(tool_call_count), 0)::int FROM chat_runs WHERE ` + whereFor("")
	if err := a.DB.QueryRowContext(c, query, args...).Scan(&summary.Requests, &summary.Succeeded, &summary.Failed, &summary.Cancelled, &summary.AverageLatency, &summary.P95Latency, &summary.AverageTTFT, &summary.InputTokens, &summary.OutputTokens, &summary.TotalTokens, &summary.ToolCalls); err != nil {
		return adminAnalytics{}, err
	}
	byEndpointQuery := `SELECT COALESCE(r.endpoint_id::text, ''), COALESCE(e.name, 'Unknown endpoint'), r.model, COUNT(*)::int, COUNT(*) FILTER (WHERE r.status IN ('error', 'incomplete'))::int, COALESCE(AVG(EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000) FILTER (WHERE r.finished_at IS NOT NULL), 0) FROM chat_runs r LEFT JOIN endpoint_settings e ON e.id = r.endpoint_id WHERE ` + whereFor("r") + ` GROUP BY r.endpoint_id, e.name, r.model ORDER BY COUNT(*) DESC`
	rows, err := a.DB.QueryContext(c, byEndpointQuery, args...)
	if err != nil {
		return adminAnalytics{}, err
	}
	defer rows.Close()
	byEndpoint := []adminAnalyticsEndpoint{}
	for rows.Next() {
		var endpointID, name, model string
		var requests, errors int
		var latency float64
		if err := rows.Scan(&endpointID, &name, &model, &requests, &errors, &latency); err != nil {
			return adminAnalytics{}, err
		}
		byEndpoint = append(byEndpoint, adminAnalyticsEndpoint{EndpointID: endpointID, EndpointName: name, Model: model, Requests: requests, Errors: errors, AverageLatencyMs: latency})
	}
	if err := rows.Err(); err != nil {
		return adminAnalytics{}, err
	}
	timeSeriesQuery := `SELECT TO_CHAR(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), COUNT(*)::int, COUNT(*) FILTER (WHERE r.status = 'complete')::int, COUNT(*) FILTER (WHERE r.status IN ('error', 'incomplete'))::int, COUNT(*) FILTER (WHERE r.status = 'cancelled')::int, COALESCE(AVG(EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000) FILTER (WHERE r.finished_at IS NOT NULL), 0), COALESCE(SUM(r.tool_call_count), 0)::int, SUM(r.input_tokens), SUM(r.output_tokens), SUM(r.total_tokens) FROM chat_runs r WHERE ` + whereFor("r") + ` GROUP BY 1 ORDER BY 1`
	timeRows, err := a.DB.QueryContext(c, timeSeriesQuery, args...)
	if err != nil {
		return adminAnalytics{}, err
	}
	defer timeRows.Close()
	timeSeries := []adminAnalyticsDay{}
	for timeRows.Next() {
		var date string
		var requests, succeeded, failed, cancelled, toolCalls int
		var latency float64
		var inputTokens, outputTokens, totalTokens sql.NullInt64
		if err := timeRows.Scan(&date, &requests, &succeeded, &failed, &cancelled, &latency, &toolCalls, &inputTokens, &outputTokens, &totalTokens); err != nil {
			return adminAnalytics{}, err
		}
		timeSeries = append(timeSeries, adminAnalyticsDay{
			Date: date, Requests: requests, Succeeded: succeeded, Failed: failed, Cancelled: cancelled,
			AverageLatencyMs: latency, ToolCalls: toolCalls,
			InputTokens: nullableInt64(inputTokens), OutputTokens: nullableInt64(outputTokens), TotalTokens: nullableInt64(totalTokens),
		})
	}
	if err := timeRows.Err(); err != nil {
		return adminAnalytics{}, err
	}
	return adminAnalytics{Summary: summary, ByEndpoint: byEndpoint, TimeSeries: timeSeries}, nil
}

func analyticsRange(c *gin.Context) (time.Time, time.Time, error) {
	now := time.Now().UTC()
	start := now.Add(-30 * 24 * time.Hour)
	end := now
	if raw := strings.TrimSpace(c.Query("days")); raw != "" {
		days, err := strconv.Atoi(raw)
		if err != nil || days < 1 || days > 365 {
			return time.Time{}, time.Time{}, fmt.Errorf("days must be between 1 and 365")
		}
		start = now.Add(-time.Duration(days) * 24 * time.Hour)
	}
	if raw := strings.TrimSpace(c.Query("from")); raw != "" {
		parsed, err := parseAnalyticsTime(raw, false)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("invalid from date")
		}
		start = parsed
	}
	if raw := strings.TrimSpace(c.Query("to")); raw != "" {
		parsed, err := parseAnalyticsTime(raw, true)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("invalid to date")
		}
		end = parsed
	}
	if !start.Before(end) {
		return time.Time{}, time.Time{}, fmt.Errorf("from must be before to")
	}
	return start, end, nil
}

func parseAnalyticsTime(value string, endOfDate bool) (time.Time, error) {
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed.UTC(), nil
	}
	parsed, err := time.ParseInLocation("2006-01-02", value, time.UTC)
	if err != nil {
		return time.Time{}, err
	}
	if endOfDate {
		return parsed.Add(24 * time.Hour), nil
	}
	return parsed, nil
}

func parseAnalyticsEndpointID(value string) (*uuid.UUID, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return nil, fmt.Errorf("invalid endpointId")
	}
	return &id, nil
}
