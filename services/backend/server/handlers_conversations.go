package server

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
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

	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()

	var item models.Conversation
	var rawEndpointID sql.NullString
	err = transaction.QueryRowContext(c, `
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
	if err := attachUserRepositories(c, transaction, item.ID, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
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
	archivedQuery := strings.ToLower(strings.TrimSpace(c.Query("archived")))
	if archivedQuery == "true" {
		archiveFilter = "c.archived_at IS NOT NULL"
	} else if archivedQuery == "all" {
		archiveFilter = "TRUE"
	}
	conditions := []string{
		"c.user_id = $1",
		"c.organization_id = $2",
		archiveFilter,
		`EXISTS (
			SELECT 1
			FROM messages conversation_messages
			WHERE conversation_messages.conversation_id = c.id
			  AND conversation_messages.role IN ('user', 'assistant')
		)`,
	}
	args := []any{principal.UserID, organizationID}
	organized := strings.EqualFold(strings.TrimSpace(c.Query("organized")), "true")
	if folderID := strings.TrimSpace(c.Query("folderId")); folderID != "" {
		parsed, parseErr := uuid.Parse(folderID)
		if parseErr != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid folder id"))
			return
		}
		args = append(args, parsed)
		conditions = append(conditions, fmt.Sprintf("c.folder_id = $%d", len(args)))
	}
	if strings.EqualFold(strings.TrimSpace(c.Query("pinned")), "true") {
		conditions = append(conditions, "c.pinned_at IS NOT NULL")
	}
	if tagID := strings.TrimSpace(c.Query("tagId")); tagID != "" {
		parsed, parseErr := uuid.Parse(tagID)
		if parseErr != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid tag id"))
			return
		}
		args = append(args, parsed)
		conditions = append(conditions, fmt.Sprintf("EXISTS (SELECT 1 FROM conversation_tag_links filter_links WHERE filter_links.conversation_id = c.id AND filter_links.tag_id = $%d)", len(args)))
	}
	if query := strings.TrimSpace(c.Query("q")); query != "" {
		pattern := "%" + strings.ToLower(query) + "%"
		args = append(args, pattern, query)
		patternIndex := len(args) - 1
		textIndex := len(args)
		conditions = append(conditions, fmt.Sprintf(`(
			LOWER(c.title) LIKE $%d
			OR EXISTS (
				SELECT 1 FROM messages search_messages
				WHERE search_messages.conversation_id = c.id
				  AND LOWER(search_messages.content) LIKE $%d
			)
			OR to_tsvector('simple', COALESCE(c.title, '')) @@ plainto_tsquery('simple', $%d)
			OR EXISTS (
				SELECT 1 FROM messages search_documents
				WHERE search_documents.conversation_id = c.id
				  AND to_tsvector('simple', COALESCE(search_documents.content, '')) @@ plainto_tsquery('simple', $%d)
			)
		)`, patternIndex, patternIndex, textIndex, textIndex))
	}
	if cursor := strings.TrimSpace(c.Query("cursor")); cursor != "" {
		value, decodeErr := decodeConversationCursor(cursor)
		if decodeErr != nil {
			writeError(c, http.StatusBadRequest, decodeErr)
			return
		}
		args = append(args, value.UpdatedAt, value.ID)
		updatedAtIndex := len(args) - 1
		idIndex := len(args)
		conditions = append(conditions, fmt.Sprintf("(c.updated_at, c.id) < ($%d, $%d)", updatedAtIndex, idIndex))
	}
	args = append(args, 51)
	limitIndex := len(args)
	query := `
		SELECT
			c.id,
			c.title,
			COALESCE(c.endpoint_id::text, ''),
			c.created_at,
			c.updated_at,
			c.archived_at,
			(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant'))::int
		FROM conversations c
		WHERE ` + strings.Join(conditions, " AND ") + `
		ORDER BY c.updated_at DESC, c.id DESC
		LIMIT $` + strconv.Itoa(limitIndex)
	rows, err := a.DB.QueryContext(c, query, args...)
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
	if organized {
		for index := range result {
			if err := a.hydrateConversationOrganization(c, &result[index]); err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
		}
	}
	nextCursor := ""
	if len(result) > 50 {
		last := result[50]
		nextCursor = encodeConversationCursor(last.UpdatedAt, last.ID)
		result = result[:50]
	}
	c.JSON(http.StatusOK, gin.H{"conversations": result, "nextCursor": nextCursor})
}

type conversationCursor struct {
	UpdatedAt time.Time
	ID        uuid.UUID
}

func encodeConversationCursor(updatedAt time.Time, id uuid.UUID) string {
	value := updatedAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(value))
}

func decodeConversationCursor(value string) (conversationCursor, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return conversationCursor{}, fmt.Errorf("invalid conversation cursor")
	}
	parts := strings.Split(string(decoded), "|")
	if len(parts) != 2 {
		return conversationCursor{}, fmt.Errorf("invalid conversation cursor")
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return conversationCursor{}, fmt.Errorf("invalid conversation cursor")
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return conversationCursor{}, fmt.Errorf("invalid conversation cursor")
	}
	return conversationCursor{UpdatedAt: updatedAt, ID: id}, nil
}

func (a *App) getConversation(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	conversationID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid conversation id"))
		return
	}

	var item models.Conversation
	var rawEndpointID sql.NullString
	err = a.DB.QueryRowContext(c, `
		SELECT c.id, c.title, COALESCE(c.endpoint_id::text, ''), c.created_at,
		       c.updated_at, c.archived_at,
		       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant'))::int
		FROM conversations c
		WHERE c.id = $1 AND c.user_id = $2 AND c.organization_id = $3
	`, conversationID, principal.UserID, organizationID).Scan(
		&item.ID,
		&item.Title,
		&rawEndpointID,
		&item.CreatedAt,
		&item.UpdatedAt,
		&item.ArchivedAt,
		&item.MessageCount,
	)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(c, http.StatusNotFound, fmt.Errorf("conversation not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.EndpointID = parseOptionalUUID(rawEndpointID)
	if err := a.hydrateConversationOrganization(c, &item); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversation": item})
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
		Archived *bool   `json:"archived"`
		Title    *string `json:"title"`
		Pinned   *bool   `json:"pinned"`
		FolderID *string `json:"folderId"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.Archived == nil && request.Title == nil && request.Pinned == nil && request.FolderID == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("title, archived, pinned, or folderId is required"))
		return
	}
	title := ""
	if request.Title != nil {
		title = strings.TrimSpace(*request.Title)
		if title == "" || utf8.RuneCountInString(title) > 160 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("title must be between 1 and 160 characters"))
			return
		}
	}
	var result sql.Result
	if request.Pinned == nil && request.FolderID == nil && request.Title != nil && request.Archived == nil {
		result, err = a.DB.ExecContext(c, `
			UPDATE conversations
			SET title = $4, updated_at = now()
			WHERE id = $1 AND user_id = $2 AND organization_id = $3
		`, conversationID, principal.UserID, organizationID, title)
	} else if request.Pinned == nil && request.FolderID == nil && request.Title == nil && request.Archived != nil {
		result, err = a.DB.ExecContext(c, `
			UPDATE conversations
			SET archived_at = CASE WHEN $4 THEN COALESCE(archived_at, now()) ELSE NULL END,
			    updated_at = now()
			WHERE id = $1 AND user_id = $2 AND organization_id = $3
		`, conversationID, principal.UserID, organizationID, *request.Archived)
	} else if request.Pinned == nil && request.FolderID == nil {
		result, err = a.DB.ExecContext(c, `
			UPDATE conversations
			SET title = $4,
			    archived_at = CASE WHEN $5 THEN COALESCE(archived_at, now()) ELSE NULL END,
			    updated_at = now()
			WHERE id = $1 AND user_id = $2 AND organization_id = $3
		`, conversationID, principal.UserID, organizationID, title, *request.Archived)
	} else {
		var folderID any
		if request.FolderID != nil {
			value := strings.TrimSpace(*request.FolderID)
			if value != "" {
				parsed, parseErr := uuid.Parse(value)
				if parseErr != nil {
					writeError(c, http.StatusBadRequest, fmt.Errorf("invalid folder id"))
					return
				}
				var available bool
				if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM conversation_folders WHERE id = $1 AND user_id = $2 AND organization_id = $3)`, parsed, principal.UserID, organizationID).Scan(&available); err != nil || !available {
					writeError(c, http.StatusBadRequest, fmt.Errorf("folder is not available"))
					return
				}
				folderID = parsed
			} else {
				folderID = ""
			}
		}
		var titleValue any
		if request.Title != nil {
			titleValue = title
		}
		var archivedValue, pinnedValue any
		if request.Archived != nil {
			archivedValue = *request.Archived
		}
		if request.Pinned != nil {
			pinnedValue = *request.Pinned
		}
		result, err = a.DB.ExecContext(c, `
			UPDATE conversations
			SET title = COALESCE($4::text, title),
			    archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN COALESCE(archived_at, now()) ELSE NULL END,
			    folder_id = CASE WHEN $6::text IS NULL THEN folder_id ELSE NULLIF($6, '')::uuid END,
			    pinned_at = CASE WHEN $7::boolean IS NULL THEN pinned_at WHEN $7 THEN COALESCE(pinned_at, now()) ELSE NULL END,
			    updated_at = now()
			WHERE id = $1 AND user_id = $2 AND organization_id = $3
		`, conversationID, principal.UserID, organizationID, titleValue, archivedValue, folderID, pinnedValue)
	}
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
	if c.Query("format") == "assistant-ui" {
		a.listAssistantUIMessages(c)
		return
	}
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
