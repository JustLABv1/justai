package server

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
)

// openTranscriptionChat: POST /transcription/sessions/:id/chat returns the user's chat
// about a transcription, creating it on first use. The chat has the transcription
// attached, so every message reads the transcript as it stands, also while it runs.
// One chat per user and transcription keeps the conversation going across visits.
func (a *App) openTranscriptionChat(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	// The owner and the people the transcript is shared with may ask about it.
	var allowed bool
	if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM transcription_sessions s WHERE s.id = $1 AND s.organization_id = $2 AND s.archived_at IS NULL
		AND (s.user_id = $3 OR EXISTS (SELECT 1 FROM transcription_readers r WHERE r.session_id = s.id AND r.user_id = $3 AND r.organization_id = $2)))`,
		sessionID, organizationID, principal.UserID).Scan(&allowed); err != nil || !allowed {
		writeError(c, http.StatusNotFound, fmt.Errorf("transcription session not found"))
		return
	}
	var item models.Conversation
	err = a.DB.QueryRowContext(c, `SELECT c.id, c.title, c.created_at, c.updated_at
		FROM conversations c JOIN conversation_transcription_sessions cts ON cts.conversation_id = c.id
		WHERE cts.session_id = $1 AND c.user_id = $2 AND c.organization_id = $3 AND c.archived_at IS NULL
		ORDER BY c.updated_at DESC LIMIT 1`, sessionID, principal.UserID, organizationID).Scan(&item.ID, &item.Title, &item.CreatedAt, &item.UpdatedAt)
	if err == nil {
		item.OwnerID, item.CanManage = principal.UserID, true
		c.JSON(http.StatusOK, gin.H{"conversation": item, "created": false})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var title string
	if err := a.DB.QueryRowContext(c, `SELECT title FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&title); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	tx, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(c, `INSERT INTO conversations (user_id, organization_id, title) VALUES ($1, $2, $3) RETURNING id, title, created_at, updated_at`,
		principal.UserID, organizationID, truncateRunes(firstNonEmptyString(title, defaultConversationTitle), 200)).Scan(&item.ID, &item.Title, &item.CreatedAt, &item.UpdatedAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := tx.ExecContext(c, `INSERT INTO conversation_transcription_sessions (conversation_id, session_id, added_by) VALUES ($1, $2, $3)`, item.ID, sessionID, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.OwnerID, item.CanManage = principal.UserID, true
	c.JSON(http.StatusCreated, gin.H{"conversation": item, "created": true})
}
