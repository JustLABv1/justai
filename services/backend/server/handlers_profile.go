package server

import (
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gabriel-vasile/mimetype"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

const maxProfileAvatarUploadBytes = 2 << 20

var allowedProfileAvatarTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
}

type profileActivityDay struct {
	Date  string `json:"date"`
	Count int    `json:"count"`
}

type profileUpdateRequest struct {
	DisplayName string `json:"displayName"`
}

type profileStatsResponse struct {
	Conversations         int      `json:"conversations"`
	Prompts               int      `json:"prompts"`
	Notes                 int      `json:"notes"`
	AgentRuns             int      `json:"agentRuns"`
	TranscriptionMinutes  int      `json:"transcriptionMinutes"`
	CurrentStreak         int      `json:"currentStreak"`
	LongestStreak         int      `json:"longestStreak"`
	ProductiveWeekday     string   `json:"productiveWeekday,omitempty"`
	Last30DaysActions     int      `json:"last30DaysActions"`
	Previous30DaysActions int      `json:"previous30DaysActions"`
	FavoriteAgent         string   `json:"favoriteAgent,omitempty"`
	FavoriteModel         string   `json:"favoriteModel,omitempty"`
	Milestones            []string `json:"milestones,omitempty"`
}

func avatarVersionAt(updatedAt time.Time) string {
	return strconv.FormatInt(updatedAt.UnixNano()/int64(time.Microsecond), 10)
}

func profileLocation(c *gin.Context) (*time.Location, string, error) {
	timezone := strings.TrimSpace(c.Query("timezone"))
	if timezone == "" {
		timezone = "UTC"
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, "", fmt.Errorf("timezone must be a valid IANA timezone")
	}
	return location, timezone, nil
}

func profileActivityInsights(activity []profileActivityDay, now time.Time, location *time.Location) (current, longest int, productiveWeekday string, last30, previous30, total, activeDays int, milestones []string) {
	counts := make(map[string]int, len(activity))
	weekdayTotals := make(map[time.Weekday]int)
	for _, day := range activity {
		if day.Count <= 0 {
			continue
		}
		counts[day.Date] += day.Count
		total += day.Count
		activeDays++
		parsed, err := time.ParseInLocation("2006-01-02", day.Date, location)
		if err == nil {
			weekdayTotals[parsed.Weekday()] += day.Count
		}
	}

	today := time.Date(now.In(location).Year(), now.In(location).Month(), now.In(location).Day(), 12, 0, 0, 0, location)
	dateFor := func(value time.Time) string { return value.Format("2006-01-02") }
	cursor := today
	if counts[dateFor(cursor)] == 0 {
		cursor = cursor.AddDate(0, 0, -1)
	}
	for counts[dateFor(cursor)] > 0 {
		current++
		cursor = cursor.AddDate(0, 0, -1)
	}
	for date := range counts {
		parsed, err := time.ParseInLocation("2006-01-02", date, location)
		if err != nil {
			continue
		}
		streak := 1
		for previous := parsed.AddDate(0, 0, -1); counts[dateFor(previous)] > 0; previous = previous.AddDate(0, 0, -1) {
			streak++
		}
		if streak > longest {
			longest = streak
		}
	}

	productiveTotal := 0
	for weekday, weekdayTotal := range weekdayTotals {
		if weekdayTotal > productiveTotal {
			productiveTotal = weekdayTotal
			productiveWeekday = weekday.String()
		}
	}
	dayUTC := func(value time.Time) time.Time {
		local := value.In(location)
		return time.Date(local.Year(), local.Month(), local.Day(), 12, 0, 0, 0, time.UTC)
	}
	todayUTC := dayUTC(now)
	for date, count := range counts {
		parsed, err := time.ParseInLocation("2006-01-02", date, location)
		if err != nil {
			continue
		}
		offset := int(todayUTC.Sub(dayUTC(parsed)) / (24 * time.Hour))
		switch {
		case offset >= 0 && offset < 30:
			last30 += count
		case offset >= 30 && offset < 60:
			previous30 += count
		}
	}
	for _, milestone := range []struct {
		threshold int
		label     string
	}{{100, "100 actions"}, {500, "500 actions"}, {1000, "1,000 actions"}, {5000, "5,000 actions"}} {
		if total >= milestone.threshold {
			milestones = append(milestones, milestone.label)
		}
	}
	return
}

func (a *App) getProfile(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	location, timezone, err := profileLocation(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var createdAt time.Time
	var avatarUpdatedAt sql.NullTime
	if err := a.DB.QueryRowContext(c, `SELECT created_at, (SELECT updated_at FROM user_avatars WHERE user_id=$1) FROM users WHERE id=$1`, principal.UserID).Scan(&createdAt, &avatarUpdatedAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}

	activity := []profileActivityDay{}
	rows, err := a.DB.QueryContext(c, `
		WITH activity AS (
			SELECT created_at FROM conversations WHERE user_id=$1
			UNION ALL SELECT m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=$1
			UNION ALL SELECT created_at FROM notes WHERE user_id=$1
			UNION ALL SELECT created_at FROM transcription_sessions WHERE user_id=$1
			UNION ALL SELECT created_at FROM agent_runs WHERE user_id=$1
		)
		SELECT (created_at AT TIME ZONE $2)::date, COUNT(*) FROM activity
		WHERE created_at >= ((CURRENT_TIMESTAMP AT TIME ZONE $2) - INTERVAL '364 days') AT TIME ZONE $2
		GROUP BY (created_at AT TIME ZONE $2)::date ORDER BY (created_at AT TIME ZONE $2)::date`, principal.UserID, timezone)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var day time.Time
		var count int
		if err := rows.Scan(&day, &count); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		activity = append(activity, profileActivityDay{Date: day.Format("2006-01-02"), Count: count})
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}

	var stats profileStatsResponse
	err = a.DB.QueryRowContext(c, `SELECT
		(SELECT COUNT(*) FROM conversations WHERE user_id=$1),
		(SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=$1 AND m.role='user'),
		(SELECT COUNT(*) FROM notes WHERE user_id=$1),
		(SELECT COUNT(*) FROM agent_runs WHERE user_id=$1),
		COALESCE((SELECT FLOOR(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, updated_at)-COALESCE(started_at, created_at))))/60)::int FROM transcription_sessions WHERE user_id=$1 AND status IN ('live','paused','processing','completed')), 0)`, principal.UserID).
		Scan(&stats.Conversations, &stats.Prompts, &stats.Notes, &stats.AgentRuns, &stats.TranscriptionMinutes)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	avatarURL := ""
	avatarVersion := ""
	if avatarUpdatedAt.Valid {
		avatarURL = "/api/v1/profile/avatar"
		avatarVersion = avatarVersionAt(avatarUpdatedAt.Time)
	}
	stats.CurrentStreak, stats.LongestStreak, stats.ProductiveWeekday, stats.Last30DaysActions, stats.Previous30DaysActions, _, _, stats.Milestones = profileActivityInsights(activity, time.Now(), location)
	_ = a.DB.QueryRowContext(c, `SELECT model FROM chat_runs WHERE user_id=$1 AND model <> '' GROUP BY model ORDER BY COUNT(*) DESC, model LIMIT 1`, principal.UserID).Scan(&stats.FavoriteModel)
	_ = a.DB.QueryRowContext(c, `SELECT a.name FROM conversations c JOIN saved_assistants a ON a.id=c.assistant_id WHERE c.user_id=$1 AND a.deleted_at IS NULL GROUP BY a.name ORDER BY COUNT(*) DESC, a.name LIMIT 1`, principal.UserID).Scan(&stats.FavoriteAgent)
	c.JSON(http.StatusOK, gin.H{
		"createdAt":     createdAt,
		"avatarUrl":     avatarURL,
		"avatarVersion": avatarVersion,
		"timezone":      timezone,
		"activity":      activity,
		"stats":         stats,
	})
}

func (a *App) updateProfile(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	var request profileUpdateRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.DisplayName = strings.TrimSpace(request.DisplayName)
	if request.DisplayName == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("display name is required"))
		return
	}
	if len([]rune(request.DisplayName)) > 120 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("display name must be 120 characters or fewer"))
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE users SET display_name=$2, updated_at=now() WHERE id=$1`, principal.UserID, request.DisplayName); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	user, err := a.userByID(c, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": user})
}

func (a *App) uploadProfileAvatar(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	fileHeader, err := c.FormFile("avatar")
	if err != nil || fileHeader.Size <= 0 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("an avatar image is required"))
		return
	}
	if fileHeader.Size > maxProfileAvatarUploadBytes {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("profile pictures are limited to 2 MB"))
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxProfileAvatarUploadBytes+1))
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if len(data) == 0 || len(data) > maxProfileAvatarUploadBytes {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("profile pictures are limited to 2 MB"))
		return
	}
	mimeType := mimetype.Detect(data).String()
	if !allowedProfileAvatarTypes[mimeType] {
		writeError(c, http.StatusUnsupportedMediaType, fmt.Errorf("use a PNG, JPEG, GIF, or WebP image"))
		return
	}
	normalized, normalizedType, err := normalizeMCPServerIcon(data, mimeType)
	if err != nil {
		writeError(c, http.StatusUnprocessableEntity, fmt.Errorf("profile picture could not be processed; choose a clear PNG, JPEG, GIF, or WebP image"))
		return
	}
	var updatedAt time.Time
	err = a.DB.QueryRowContext(c, `INSERT INTO user_avatars (user_id,mime_type,image_data,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (user_id) DO UPDATE SET mime_type=EXCLUDED.mime_type,image_data=EXCLUDED.image_data,updated_at=now() RETURNING updated_at`, principal.UserID, normalizedType, normalized).Scan(&updatedAt)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"avatarUrl": "/api/v1/profile/avatar", "avatarVersion": avatarVersionAt(updatedAt)})
}

func (a *App) deleteProfileAvatar(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	if _, err := a.DB.ExecContext(c, `DELETE FROM user_avatars WHERE user_id=$1`, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) serveProfileAvatar(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	var mimeType string
	var data []byte
	err := a.DB.QueryRowContext(c, `SELECT mime_type,image_data FROM user_avatars WHERE user_id=$1`, principal.UserID).Scan(&mimeType, &data)
	if err == sql.ErrNoRows {
		c.Status(http.StatusNotFound)
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("Vary", "Cookie")
	c.Data(http.StatusOK, mimeType, data)
}

func (a *App) serveOrganizationMemberAvatar(c *gin.Context) {
	organizationID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	memberID, err := uuid.Parse(c.Param("userId"))
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	principal, ok := middleware.GetPrincipal(c)
	if !ok {
		c.Status(http.StatusUnauthorized)
		return
	}
	var mimeType string
	var data []byte
	err = a.DB.QueryRowContext(c, `SELECT ua.mime_type, ua.image_data FROM organization_members viewer JOIN organization_members target ON target.organization_id=viewer.organization_id JOIN user_avatars ua ON ua.user_id=target.user_id WHERE viewer.organization_id=$1 AND viewer.user_id=$2 AND target.user_id=$3`, organizationID, principal.UserID, memberID).Scan(&mimeType, &data)
	if err == sql.ErrNoRows {
		c.Status(http.StatusNotFound)
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("Vary", "Cookie")
	c.Data(http.StatusOK, mimeType, data)
}
