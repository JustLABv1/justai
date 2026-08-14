package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

type platformBanner struct {
	ID          uuid.UUID  `json:"id"`
	Message     string     `json:"message"`
	Severity    string     `json:"severity"`
	LinkURL     string     `json:"linkUrl,omitempty"`
	Priority    int        `json:"priority"`
	Enabled     bool       `json:"enabled"`
	Dismissible bool       `json:"dismissible"`
	StartsAt    time.Time  `json:"startsAt"`
	EndsAt      *time.Time `json:"endsAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

type platformBannerRequest struct {
	Message     *string         `json:"message"`
	Severity    *string         `json:"severity"`
	LinkURL     json.RawMessage `json:"linkUrl"`
	Priority    *int            `json:"priority"`
	Enabled     *bool           `json:"enabled"`
	Dismissible *bool           `json:"dismissible"`
	StartsAt    *time.Time      `json:"startsAt"`
	EndsAt      json.RawMessage `json:"endsAt"`
}

func parseOptionalBannerTime(raw json.RawMessage) (*time.Time, error) {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil, nil
	}
	var value time.Time
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("banner end time must be a valid timestamp")
	}
	value = value.UTC()
	return &value, nil
}

func parseOptionalBannerString(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("banner link must be a string")
	}
	return strings.TrimSpace(value), nil
}

func scanPlatformBanner(scanner interface{ Scan(...any) error }) (platformBanner, error) {
	var banner platformBanner
	var endsAt sql.NullTime
	if err := scanner.Scan(&banner.ID, &banner.Message, &banner.Severity, &banner.LinkURL, &banner.Priority, &banner.Enabled, &banner.Dismissible, &banner.StartsAt, &endsAt, &banner.CreatedAt, &banner.UpdatedAt); err != nil {
		return platformBanner{}, err
	}
	if endsAt.Valid {
		banner.EndsAt = &endsAt.Time
	}
	return banner, nil
}

const platformBannerSelect = `SELECT id, message, severity, COALESCE(link_url, ''), priority, enabled, dismissible, starts_at, ends_at, created_at, updated_at FROM platform_banners`

func validatePlatformBanner(message, severity, linkURL string, startsAt time.Time, endsAt *time.Time) error {
	message = strings.TrimSpace(message)
	if message == "" {
		return fmt.Errorf("banner message is required")
	}
	if len([]rune(message)) > 1000 {
		return fmt.Errorf("banner message must be 1000 characters or fewer")
	}
	switch strings.ToLower(strings.TrimSpace(severity)) {
	case "info", "success", "warning", "danger":
	default:
		return fmt.Errorf("banner severity must be info, success, warning, or danger")
	}
	if linkURL != "" {
		parsed, err := url.Parse(linkURL)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return fmt.Errorf("banner link must be an absolute http(s) URL")
		}
	}
	if startsAt.IsZero() {
		return fmt.Errorf("banner start time is required")
	}
	if endsAt != nil && !endsAt.After(startsAt) {
		return fmt.Errorf("banner end time must be after the start time")
	}
	return nil
}

func (a *App) activePlatformBanners(ctx *gin.Context) []platformBanner {
	if a.DB == nil {
		return []platformBanner{}
	}
	rows, err := a.DB.QueryContext(ctx, platformBannerSelect+` WHERE enabled = TRUE AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) ORDER BY priority DESC, starts_at DESC, updated_at DESC`)
	if err != nil {
		return []platformBanner{}
	}
	defer rows.Close()
	result := []platformBanner{}
	for rows.Next() {
		banner, err := scanPlatformBanner(rows)
		if err != nil {
			return []platformBanner{}
		}
		result = append(result, banner)
	}
	return result
}

func (a *App) listPlatformBanners(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	rows, err := a.DB.QueryContext(c, platformBannerSelect+` ORDER BY starts_at DESC, priority DESC, updated_at DESC`)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := []platformBanner{}
	for rows.Next() {
		banner, err := scanPlatformBanner(rows)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		result = append(result, banner)
	}
	c.JSON(http.StatusOK, gin.H{"banners": result})
}

func (a *App) createPlatformBanner(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	var request platformBannerRequest
	if !decodeJSON(c, &request) {
		return
	}
	now := time.Now().UTC()
	message := valueOrEmpty(request.Message)
	severity := "info"
	if request.Severity != nil && strings.TrimSpace(*request.Severity) != "" {
		severity = strings.ToLower(strings.TrimSpace(*request.Severity))
	}
	linkURL, err := parseOptionalBannerString(request.LinkURL)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	priority := 0
	if request.Priority != nil {
		priority = *request.Priority
	}
	enabled := true
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	dismissible := true
	if request.Dismissible != nil {
		dismissible = *request.Dismissible
	}
	startsAt := now
	if request.StartsAt != nil {
		startsAt = request.StartsAt.UTC()
	}
	endsAt, err := parseOptionalBannerTime(request.EndsAt)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if err := validatePlatformBanner(message, severity, linkURL, startsAt, endsAt); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	var endsValue any
	if endsAt != nil {
		endsValue = *endsAt
	}
	var id uuid.UUID
	err = a.DB.QueryRowContext(c, `INSERT INTO platform_banners (message, severity, link_url, priority, enabled, dismissible, starts_at, ends_at, created_by, updated_by) VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, $9, $9) RETURNING id`, message, severity, linkURL, priority, enabled, dismissible, startsAt, endsValue, principal.UserID).Scan(&id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.banner.created", "platform_banner", &id, nil)
	banner, err := a.getPlatformBanner(c, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, banner)
}

func (a *App) getPlatformBanner(c *gin.Context, id uuid.UUID) (platformBanner, error) {
	row := a.DB.QueryRowContext(c, platformBannerSelect+` WHERE id = $1`, id)
	return scanPlatformBanner(row)
}

func (a *App) updatePlatformBanner(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid banner id"))
		return
	}
	current, err := a.getPlatformBanner(c, id)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("banner not found"))
		return
	}
	var request platformBannerRequest
	if !decodeJSON(c, &request) {
		return
	}
	if request.Message != nil {
		current.Message = strings.TrimSpace(*request.Message)
	}
	if request.Severity != nil {
		current.Severity = strings.ToLower(strings.TrimSpace(*request.Severity))
	}
	if len(request.LinkURL) > 0 {
		current.LinkURL, err = parseOptionalBannerString(request.LinkURL)
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
	}
	if request.Priority != nil {
		current.Priority = *request.Priority
	}
	if request.Enabled != nil {
		current.Enabled = *request.Enabled
	}
	if request.Dismissible != nil {
		current.Dismissible = *request.Dismissible
	}
	if request.StartsAt != nil {
		current.StartsAt = request.StartsAt.UTC()
	}
	if len(request.EndsAt) > 0 {
		current.EndsAt, err = parseOptionalBannerTime(request.EndsAt)
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
	}
	if err := validatePlatformBanner(current.Message, current.Severity, current.LinkURL, current.StartsAt, current.EndsAt); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var endsValue any
	if current.EndsAt != nil {
		endsValue = *current.EndsAt
	}
	principal, _ := middleware.GetPrincipal(c)
	_, err = a.DB.ExecContext(c, `UPDATE platform_banners SET message = $2, severity = $3, link_url = NULLIF($4, ''), priority = $5, enabled = $6, dismissible = $7, starts_at = $8, ends_at = $9, updated_by = $10, updated_at = now() WHERE id = $1`, id, current.Message, current.Severity, current.LinkURL, current.Priority, current.Enabled, current.Dismissible, current.StartsAt, endsValue, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.banner.updated", "platform_banner", &id, nil)
	banner, err := a.getPlatformBanner(c, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, banner)
}

func (a *App) deletePlatformBanner(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid banner id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM platform_banners WHERE id = $1`, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("banner not found"))
		return
	}
	a.writePlatformAudit(c, "platform.banner.deleted", "platform_banner", &id, nil)
	c.Status(http.StatusNoContent)
}
