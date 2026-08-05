package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
)

const defaultConversationTitle = "New conversation"

func (a *App) createConversation(c *gin.Context) {
	principal, ok := middleware.GetPrincipal(c)
	if !ok {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("authentication required"))
		return
	}
	organizationID, ok := middleware.GetOrganizationID(c)
	if !ok || organizationID == uuid.Nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("organization context is required"))
		return
	}

	var item models.Conversation
	var rawEndpointID sql.NullString
	err := a.DB.QueryRowContext(c, `
		INSERT INTO conversations (user_id, organization_id)
		VALUES ($1, $2)
		RETURNING id, title, endpoint_id::text, created_at, updated_at
	`, principal.UserID, organizationID).Scan(
		&item.ID,
		&item.Title,
		&rawEndpointID,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.EndpointID = parseOptionalUUID(rawEndpointID)
	c.JSON(http.StatusCreated, gin.H{"conversation": item})
}

func (a *App) listConversations(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	archiveFilter := "c.archived_at IS NULL"
	if strings.EqualFold(strings.TrimSpace(c.Query("archived")), "true") {
		archiveFilter = "c.archived_at IS NOT NULL"
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT
			c.id,
			c.title,
			COALESCE(c.endpoint_id::text, ''),
			c.created_at,
			c.updated_at,
			c.archived_at,
			(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)::int
		FROM conversations c
		WHERE c.user_id = $1 AND c.organization_id = $2 AND `+archiveFilter+`
		ORDER BY c.updated_at DESC
		LIMIT 50
	`, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()

	result := []models.Conversation{}
	for rows.Next() {
		var item models.Conversation
		var rawEndpointID string
		if err := rows.Scan(&item.ID, &item.Title, &rawEndpointID, &item.CreatedAt, &item.UpdatedAt, &item.ArchivedAt, &item.MessageCount); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		item.EndpointID = parseOptionalUUIDString(rawEndpointID)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversations": result})
}

func (a *App) updateConversation(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	conversationID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid conversation id"))
		return
	}
	var request struct {
		Archived *bool `json:"archived"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.Archived == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("archived is required"))
		return
	}
	result, err := a.DB.ExecContext(c, `
		UPDATE conversations
		SET archived_at = CASE WHEN $4 THEN COALESCE(archived_at, now()) ELSE NULL END,
		    updated_at = now()
		WHERE id = $1 AND user_id = $2 AND organization_id = $3
	`, conversationID, principal.UserID, organizationID, *request.Archived)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("conversation not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) deleteConversation(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	conversationID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid conversation id"))
		return
	}
	result, err := a.DB.ExecContext(c, `
		DELETE FROM conversations
		WHERE id = $1 AND user_id = $2 AND organization_id = $3
	`, conversationID, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("conversation not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) listConversationMessages(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	conversationID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid conversation id"))
		return
	}

	var exists bool
	if err := a.DB.QueryRowContext(c, `
		SELECT EXISTS (
			SELECT 1 FROM conversations
			WHERE id = $1 AND user_id = $2 AND organization_id = $3
		)
	`, conversationID, principal.UserID, organizationID).Scan(&exists); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !exists {
		writeError(c, http.StatusNotFound, fmt.Errorf("conversation not found"))
		return
	}

	rows, err := a.DB.QueryContext(c, `
		SELECT id, role, content, citations, created_at
		FROM messages
		WHERE conversation_id = $1
		ORDER BY created_at ASC
		LIMIT 500
	`, conversationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()

	result := []models.Message{}
	for rows.Next() {
		var item models.Message
		var rawCitations []byte
		if err := rows.Scan(&item.ID, &item.Role, &item.Content, &rawCitations, &item.CreatedAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if len(rawCitations) > 0 {
			if err := json.Unmarshal(rawCitations, &item.Citations); err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"messages": result})
}

func parseOptionalUUID(value sql.NullString) *uuid.UUID {
	if !value.Valid {
		return nil
	}
	return parseOptionalUUIDString(value.String)
}

func parseOptionalUUIDString(value string) *uuid.UUID {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return nil
	}
	return &id
}

func conversationTitle(content string) string {
	value := strings.Join(strings.Fields(strings.TrimSpace(content)), " ")
	if value == "" {
		return defaultConversationTitle
	}
	const maxRunes = 72
	if utf8.RuneCountInString(value) <= maxRunes {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:maxRunes])) + "…"
}
