package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

// Usage is counted in tokens per calendar month (UTC), taken from the token
// totals the provider reports for each chat run.
const maxMonthlyTokenLimit = int64(1) << 50

type usageSummary struct {
	PeriodStart  time.Time `json:"periodStart"`
	PeriodEnd    time.Time `json:"periodEnd"`
	InputTokens  int64     `json:"inputTokens"`
	OutputTokens int64     `json:"outputTokens"`
	TotalTokens  int64     `json:"totalTokens"`
	Requests     int64     `json:"requests"`
	// MonthlyTokenLimit is nil when the member has no limit.
	MonthlyTokenLimit *int64 `json:"monthlyTokenLimit"`
	// LimitSource is "member" for a limit set for this person, "workspace" for
	// the workspace default and "none" when nothing limits them.
	LimitSource string `json:"limitSource"`
}

func usagePeriod(now time.Time) (time.Time, time.Time) {
	now = now.UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	return start, start.AddDate(0, 1, 0)
}

const usageSumSQL = `SELECT COALESCE(SUM(input_tokens), 0)::bigint,
	COALESCE(SUM(output_tokens), 0)::bigint,
	COALESCE(SUM(COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))), 0)::bigint,
	COUNT(*)::bigint
	FROM chat_runs WHERE organization_id = $1 AND user_id = $2 AND started_at >= $3 AND started_at < $4`

// memberUsage returns one member's usage for the current month and the limit
// that applies to them.
func (a *App) memberUsage(ctx context.Context, organizationID, userID uuid.UUID) (usageSummary, error) {
	start, end := usagePeriod(time.Now())
	summary := usageSummary{PeriodStart: start, PeriodEnd: end, LimitSource: "none"}
	if err := a.DB.QueryRowContext(ctx, usageSumSQL, organizationID, userID, start, end).
		Scan(&summary.InputTokens, &summary.OutputTokens, &summary.TotalTokens, &summary.Requests); err != nil {
		return summary, err
	}
	var limit sql.NullInt64
	err := a.DB.QueryRowContext(ctx, `SELECT monthly_token_limit FROM organization_member_usage_limits WHERE organization_id = $1 AND user_id = $2`, organizationID, userID).Scan(&limit)
	switch {
	case err == nil:
		summary.LimitSource = "member"
	case errors.Is(err, sql.ErrNoRows):
		err = a.DB.QueryRowContext(ctx, `SELECT monthly_token_limit FROM organization_usage_limits WHERE organization_id = $1`, organizationID).Scan(&limit)
		if err == nil {
			summary.LimitSource = "workspace"
		} else if !errors.Is(err, sql.ErrNoRows) {
			return summary, err
		}
	default:
		return summary, err
	}
	summary.MonthlyTokenLimit = positiveLimit(limit)
	return summary, nil
}

// usageLimitReached reports whether a member has used their whole budget.
func (u usageSummary) usageLimitReached() bool {
	return u.MonthlyTokenLimit != nil && u.TotalTokens >= *u.MonthlyTokenLimit
}

// enforceUsageLimit refuses a new chat turn once the member's monthly budget
// is used up. It writes the response and returns false when it refuses.
func (a *App) enforceUsageLimit(c *gin.Context, organizationID, userID uuid.UUID) bool {
	usage, err := a.memberUsage(c, organizationID, userID)
	if err != nil {
		// Counting failed; do not block chat because of it.
		return true
	}
	if !usage.usageLimitReached() {
		return true
	}
	writeError(c, http.StatusTooManyRequests, publicError("usage_limit_reached",
		fmt.Sprintf("Your monthly usage limit is used up. It resets on %s, or ask a workspace admin to raise it.", usage.PeriodEnd.Format("2 January"))))
	return false
}

// getMyUsage returns the signed-in member's usage for the current month.
func (a *App) getMyUsage(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, ok := middleware.GetOrganizationID(c)
	if !ok {
		writeError(c, http.StatusForbidden, publicError("organization_context_required", "organization context required"))
		return
	}
	usage, err := a.memberUsage(c, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, usage)
}

type memberUsageRow struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"displayName"`
	Email       string    `json:"email"`
	Role        string    `json:"role"`
	usageSummary
}

// getOrganizationUsage lists every member's usage and limit for workspace admins.
func (a *App) getOrganizationUsage(c *gin.Context) {
	organizationID, err := a.organizationRouteID(c)
	if err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	start, end := usagePeriod(time.Now())
	var defaultLimit sql.NullInt64
	if err := a.DB.QueryRowContext(c, `SELECT monthly_token_limit FROM organization_usage_limits WHERE organization_id = $1`, organizationID).Scan(&defaultLimit); err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT u.id, u.display_name, u.email, om.role,
		       COALESCE(SUM(r.input_tokens), 0)::bigint,
		       COALESCE(SUM(r.output_tokens), 0)::bigint,
		       COALESCE(SUM(COALESCE(r.total_tokens, COALESCE(r.input_tokens, 0) + COALESCE(r.output_tokens, 0))), 0)::bigint,
		       COUNT(r.id)::bigint,
		       (ml.user_id IS NOT NULL), ml.monthly_token_limit
		FROM organization_members om
		JOIN users u ON u.id = om.user_id
		LEFT JOIN organization_member_usage_limits ml ON ml.organization_id = om.organization_id AND ml.user_id = om.user_id
		LEFT JOIN chat_runs r ON r.organization_id = om.organization_id AND r.user_id = om.user_id AND r.started_at >= $2 AND r.started_at < $3
		WHERE om.organization_id = $1
		GROUP BY u.id, u.display_name, u.email, om.role, ml.user_id, ml.monthly_token_limit
		ORDER BY COALESCE(SUM(COALESCE(r.total_tokens, COALESCE(r.input_tokens, 0) + COALESCE(r.output_tokens, 0))), 0) DESC, u.display_name`,
		organizationID, start, end)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	members := []memberUsageRow{}
	for rows.Next() {
		row := memberUsageRow{usageSummary: usageSummary{PeriodStart: start, PeriodEnd: end, LimitSource: "none"}}
		var hasOverride bool
		var override sql.NullInt64
		if err := rows.Scan(&row.ID, &row.DisplayName, &row.Email, &row.Role, &row.InputTokens, &row.OutputTokens, &row.TotalTokens, &row.Requests, &hasOverride, &override); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		switch {
		case hasOverride:
			row.LimitSource = "member"
			row.MonthlyTokenLimit = positiveLimit(override)
		case positiveLimit(defaultLimit) != nil:
			row.LimitSource = "workspace"
			row.MonthlyTokenLimit = positiveLimit(defaultLimit)
		}
		members = append(members, row)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defaultValue := positiveLimit(defaultLimit)
	c.JSON(http.StatusOK, gin.H{"periodStart": start, "periodEnd": end, "defaultMonthlyTokenLimit": defaultValue, "members": members})
}

// positiveLimit reads a stored limit. Zero means no limit, like an empty one.
func positiveLimit(limit sql.NullInt64) *int64 {
	if !limit.Valid || limit.Int64 <= 0 {
		return nil
	}
	value := limit.Int64
	return &value
}

func validTokenLimit(limit *int64) bool {
	return limit == nil || (*limit >= 0 && *limit <= maxMonthlyTokenLimit)
}

// putOrganizationUsageDefault sets the monthly limit every member gets unless
// they have their own. A null limit means no workspace default.
func (a *App) putOrganizationUsageDefault(c *gin.Context) {
	organizationID, err := a.organizationRouteID(c)
	if err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var request struct {
		MonthlyTokenLimit *int64 `json:"monthlyTokenLimit"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if !validTokenLimit(request.MonthlyTokenLimit) {
		writeError(c, http.StatusBadRequest, publicError("invalid_request", "monthlyTokenLimit is out of range"))
		return
	}
	// Zero is the same as no limit.
	if request.MonthlyTokenLimit != nil && *request.MonthlyTokenLimit == 0 {
		request.MonthlyTokenLimit = nil
	}
	principal, _ := middleware.GetPrincipal(c)
	if _, err := a.DB.ExecContext(c, `
		INSERT INTO organization_usage_limits (organization_id, monthly_token_limit, updated_by, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (organization_id) DO UPDATE SET monthly_token_limit = EXCLUDED.monthly_token_limit, updated_by = EXCLUDED.updated_by, updated_at = now()`,
		organizationID, request.MonthlyTokenLimit, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"defaultMonthlyTokenLimit": request.MonthlyTokenLimit})
}

// putMemberUsageLimit gives one member their own limit, lifts the limit for
// them, or returns them to the workspace default.
func (a *App) putMemberUsageLimit(c *gin.Context) {
	organizationID, err := a.organizationRouteID(c)
	if err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	userID, err := uuid.Parse(c.Param("userId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, publicError("invalid_request", "invalid user id"))
		return
	}
	var request struct {
		Mode              string `json:"mode"`
		MonthlyTokenLimit *int64 `json:"monthlyTokenLimit"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	switch request.Mode {
	case "inherit":
		_, err = a.DB.ExecContext(c, `DELETE FROM organization_member_usage_limits WHERE organization_id = $1 AND user_id = $2`, organizationID, userID)
	case "unlimited", "limit":
		var limit *int64
		if request.Mode == "limit" {
			if request.MonthlyTokenLimit == nil || *request.MonthlyTokenLimit < 1 || !validTokenLimit(request.MonthlyTokenLimit) {
				writeError(c, http.StatusBadRequest, publicError("invalid_request", "monthlyTokenLimit must be at least 1 for a limit"))
				return
			}
			limit = request.MonthlyTokenLimit
		}
		var member bool
		if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2)`, organizationID, userID).Scan(&member); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if !member {
			writeError(c, http.StatusNotFound, publicError("not_found", "member not found"))
			return
		}
		_, err = a.DB.ExecContext(c, `
			INSERT INTO organization_member_usage_limits (organization_id, user_id, monthly_token_limit, updated_by, updated_at)
			VALUES ($1, $2, $3, $4, now())
			ON CONFLICT (organization_id, user_id) DO UPDATE SET monthly_token_limit = EXCLUDED.monthly_token_limit, updated_by = EXCLUDED.updated_by, updated_at = now()`,
			organizationID, userID, limit, principal.UserID)
	default:
		writeError(c, http.StatusBadRequest, publicError("invalid_request", "mode must be inherit, unlimited or limit"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"saved": true})
}

type usageDay struct {
	Date         string `json:"date"`
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
	TotalTokens  int64  `json:"totalTokens"`
	Requests     int64  `json:"requests"`
}

const usageHistoryDays = 30

// getMyUsageHistory returns the signed-in member's tokens per day for the
// last 30 days (UTC), including days without any use.
func (a *App) getMyUsageHistory(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, ok := middleware.GetOrganizationID(c)
	if !ok {
		writeError(c, http.StatusForbidden, publicError("organization_context_required", "organization context required"))
		return
	}
	today := time.Now().UTC().Truncate(24 * time.Hour)
	since := today.AddDate(0, 0, -(usageHistoryDays - 1))
	rows, err := a.DB.QueryContext(c, `
		SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
		       COALESCE(SUM(input_tokens), 0)::bigint,
		       COALESCE(SUM(output_tokens), 0)::bigint,
		       COALESCE(SUM(COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))), 0)::bigint,
		       COUNT(*)::bigint
		FROM chat_runs WHERE organization_id = $1 AND user_id = $2 AND started_at >= $3
		GROUP BY 1`, organizationID, principal.UserID, since)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	byDate := map[string]usageDay{}
	for rows.Next() {
		var day usageDay
		if err := rows.Scan(&day.Date, &day.InputTokens, &day.OutputTokens, &day.TotalTokens, &day.Requests); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		byDate[day.Date] = day
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	days := make([]usageDay, 0, usageHistoryDays)
	for offset := 0; offset < usageHistoryDays; offset++ {
		date := since.AddDate(0, 0, offset).Format("2006-01-02")
		day, found := byDate[date]
		if !found {
			day = usageDay{Date: date}
		}
		days = append(days, day)
	}
	c.JSON(http.StatusOK, gin.H{"days": days})
}
