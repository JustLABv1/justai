package server

import (
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gabriel-vasile/mimetype"
	"github.com/gin-gonic/gin"

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

func (a *App) getProfile(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	var createdAt time.Time
	var hasAvatar bool
	if err := a.DB.QueryRowContext(c, `SELECT created_at, EXISTS (SELECT 1 FROM user_avatars WHERE user_id=$1) FROM users WHERE id=$1`, principal.UserID).Scan(&createdAt, &hasAvatar); err != nil {
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
		SELECT created_at::date, COUNT(*) FROM activity
		WHERE created_at >= CURRENT_DATE - INTERVAL '364 days'
		GROUP BY created_at::date ORDER BY created_at::date`, principal.UserID)
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

	var conversations, prompts, notes, agentRuns, transcriptionMinutes int
	err = a.DB.QueryRowContext(c, `SELECT
		(SELECT COUNT(*) FROM conversations WHERE user_id=$1),
		(SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=$1 AND m.role='user'),
		(SELECT COUNT(*) FROM notes WHERE user_id=$1),
		(SELECT COUNT(*) FROM agent_runs WHERE user_id=$1),
		COALESCE((SELECT FLOOR(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, updated_at)-COALESCE(started_at, created_at))))/60)::int FROM transcription_sessions WHERE user_id=$1), 0)`, principal.UserID).
		Scan(&conversations, &prompts, &notes, &agentRuns, &transcriptionMinutes)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	avatarURL := ""
	if hasAvatar {
		avatarURL = "/api/v1/profile/avatar"
	}
	c.JSON(http.StatusOK, gin.H{
		"createdAt": createdAt,
		"avatarUrl": avatarURL,
		"activity":  activity,
		"stats":     gin.H{"conversations": conversations, "prompts": prompts, "notes": notes, "agentRuns": agentRuns, "transcriptionMinutes": transcriptionMinutes},
	})
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
		writeError(c, http.StatusUnprocessableEntity, err)
		return
	}
	_, err = a.DB.ExecContext(c, `INSERT INTO user_avatars (user_id,mime_type,image_data,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (user_id) DO UPDATE SET mime_type=EXCLUDED.mime_type,image_data=EXCLUDED.image_data,updated_at=now()`, principal.UserID, normalizedType, normalized)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"avatarUrl": "/api/v1/profile/avatar"})
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
	c.Header("Cache-Control", "private, max-age=3600")
	c.Data(http.StatusOK, mimeType, data)
}
