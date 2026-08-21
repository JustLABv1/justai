package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	stdhtml "html"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	xhtml "golang.org/x/net/html"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

func workspaceScope(c *gin.Context) (middleware.Principal, uuid.UUID, error) {
	principal, ok := middleware.GetPrincipal(c)
	if !ok {
		return middleware.Principal{}, uuid.Nil, fmt.Errorf("authentication required")
	}
	organizationID, ok := middleware.GetOrganizationID(c)
	if !ok || organizationID == uuid.Nil {
		return middleware.Principal{}, uuid.Nil, fmt.Errorf("organization context is required")
	}
	return principal, organizationID, nil
}

func imageModelForEndpoint(endpoint provider.Endpoint) string {
	if model := strings.TrimSpace(endpoint.ImageModel); model != "" {
		return model
	}
	return "gpt-image-1"
}

func (a *App) memoryPrompt(ctx context.Context, userID, organizationID uuid.UUID) (string, error) {
	rows, err := a.DB.QueryContext(ctx, `
		SELECT content
		FROM memories
		WHERE user_id = $1 AND organization_id = $2 AND enabled = TRUE
		ORDER BY updated_at DESC
		LIMIT 40`, userID, organizationID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var builder strings.Builder
	count := 0
	for rows.Next() {
		var content string
		if err := rows.Scan(&content); err != nil {
			return "", err
		}
		if count == 0 {
			builder.WriteString("The user has explicitly saved the following memories. Use them only when relevant and never claim them as newly learned facts:\n")
		}
		builder.WriteString("- ")
		builder.WriteString(content)
		builder.WriteByte('\n')
		count++
	}
	return builder.String(), rows.Err()
}

func (a *App) listMemories(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `SELECT id, content, source, enabled, created_at, updated_at FROM memories WHERE user_id = $1 AND organization_id = $2 ORDER BY updated_at DESC`, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := []models.Memory{}
	for rows.Next() {
		var item models.Memory
		if err := rows.Scan(&item.ID, &item.Content, &item.Source, &item.Enabled, &item.CreatedAt, &item.UpdatedAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"memories": result})
}

func (a *App) createMemory(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request struct {
		Content string `json:"content"`
		Source  string `json:"source"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	request.Content = strings.TrimSpace(request.Content)
	if request.Content == "" || len([]rune(request.Content)) > 2000 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("memory must contain between 1 and 2000 characters"))
		return
	}
	request.Source = strings.TrimSpace(request.Source)
	if request.Source == "" {
		request.Source = "manual"
	}
	if request.Source != "manual" && request.Source != "chat" && request.Source != "import" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("unsupported memory source"))
		return
	}
	var item models.Memory
	err = a.DB.QueryRowContext(c, `INSERT INTO memories (user_id, organization_id, content, source) VALUES ($1, $2, $3, $4) RETURNING id, content, source, enabled, created_at, updated_at`, principal.UserID, organizationID, request.Content, request.Source).Scan(&item.ID, &item.Content, &item.Source, &item.Enabled, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"memory": item})
}

func (a *App) updateMemory(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid memory id"))
		return
	}
	var request struct {
		Content *string `json:"content"`
		Enabled *bool   `json:"enabled"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.Content == nil && request.Enabled == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("content or enabled is required"))
		return
	}
	content := any(nil)
	if request.Content != nil {
		value := strings.TrimSpace(*request.Content)
		if value == "" || len([]rune(value)) > 2000 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("memory must contain between 1 and 2000 characters"))
			return
		}
		content = value
	}
	enabled := any(nil)
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	var item models.Memory
	err = a.DB.QueryRowContext(c, `UPDATE memories SET content = COALESCE($4::text, content), enabled = COALESCE($5::boolean, enabled), updated_at = now() WHERE id = $1 AND user_id = $2 AND organization_id = $3 RETURNING id, content, source, enabled, created_at, updated_at`, id, principal.UserID, organizationID, content, enabled).Scan(&item.ID, &item.Content, &item.Source, &item.Enabled, &item.CreatedAt, &item.UpdatedAt)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("memory not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"memory": item})
}

func (a *App) deleteMemory(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid memory id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM memories WHERE id = $1 AND user_id = $2 AND organization_id = $3`, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("memory not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) listConversationFolders(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `SELECT id, name, color, created_at, updated_at FROM conversation_folders WHERE user_id = $1 AND organization_id = $2 ORDER BY lower(name)`, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := []models.ConversationFolder{}
	for rows.Next() {
		var item models.ConversationFolder
		if err := rows.Scan(&item.ID, &item.Name, &item.Color, &item.CreatedAt, &item.UpdatedAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		result = append(result, item)
	}
	c.JSON(http.StatusOK, gin.H{"folders": result})
}

func (a *App) createConversationFolder(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" || len([]rune(request.Name)) > 80 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("folder name must contain between 1 and 80 characters"))
		return
	}
	request.Color = strings.TrimSpace(request.Color)
	if request.Color == "" {
		request.Color = "primary"
	}
	var item models.ConversationFolder
	err = a.DB.QueryRowContext(c, `INSERT INTO conversation_folders (user_id, organization_id, name, color) VALUES ($1, $2, $3, $4) RETURNING id, name, color, created_at, updated_at`, principal.UserID, organizationID, request.Name, request.Color).Scan(&item.ID, &item.Name, &item.Color, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			writeError(c, http.StatusConflict, fmt.Errorf("a folder with that name already exists"))
			return
		}
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"folder": item})
}

func (a *App) updateConversationFolder(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid folder id"))
		return
	}
	var request struct {
		Name  *string `json:"name"`
		Color *string `json:"color"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.Name == nil && request.Color == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("name or color is required"))
		return
	}
	name, color := any(nil), any(nil)
	if request.Name != nil {
		value := strings.TrimSpace(*request.Name)
		if value == "" || len([]rune(value)) > 80 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("folder name must contain between 1 and 80 characters"))
			return
		}
		name = value
	}
	if request.Color != nil {
		color = strings.TrimSpace(*request.Color)
	}
	var item models.ConversationFolder
	err = a.DB.QueryRowContext(c, `UPDATE conversation_folders SET name = COALESCE($4::text, name), color = COALESCE($5::text, color), updated_at = now() WHERE id = $1 AND user_id = $2 AND organization_id = $3 RETURNING id, name, color, created_at, updated_at`, id, principal.UserID, organizationID, name, color).Scan(&item.ID, &item.Name, &item.Color, &item.CreatedAt, &item.UpdatedAt)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("folder not found"))
		return
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			writeError(c, http.StatusConflict, fmt.Errorf("a folder with that name already exists"))
			return
		}
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"folder": item})
}

func (a *App) deleteConversationFolder(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid folder id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM conversation_folders WHERE id = $1 AND user_id = $2 AND organization_id = $3`, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("folder not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) listConversationTags(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `SELECT id, name, color, created_at, updated_at FROM conversation_tags WHERE user_id = $1 AND organization_id = $2 ORDER BY lower(name)`, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := []models.ConversationTag{}
	for rows.Next() {
		var item models.ConversationTag
		if err := rows.Scan(&item.ID, &item.Name, &item.Color, &item.CreatedAt, &item.UpdatedAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		result = append(result, item)
	}
	c.JSON(http.StatusOK, gin.H{"tags": result})
}

func (a *App) createConversationTag(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" || len([]rune(request.Name)) > 40 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("tag name must contain between 1 and 40 characters"))
		return
	}
	request.Color = strings.TrimSpace(request.Color)
	if request.Color == "" {
		request.Color = "secondary"
	}
	var item models.ConversationTag
	err = a.DB.QueryRowContext(c, `INSERT INTO conversation_tags (user_id, organization_id, name, color) VALUES ($1, $2, $3, $4) RETURNING id, name, color, created_at, updated_at`, principal.UserID, organizationID, request.Name, request.Color).Scan(&item.ID, &item.Name, &item.Color, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			writeError(c, http.StatusConflict, fmt.Errorf("a tag with that name already exists"))
			return
		}
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"tag": item})
}

func (a *App) updateConversationTag(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid tag id"))
		return
	}
	var request struct {
		Name  *string `json:"name"`
		Color *string `json:"color"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.Name == nil && request.Color == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("name or color is required"))
		return
	}
	name, color := any(nil), any(nil)
	if request.Name != nil {
		value := strings.TrimSpace(*request.Name)
		if value == "" || len([]rune(value)) > 40 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("tag name must contain between 1 and 40 characters"))
			return
		}
		name = value
	}
	if request.Color != nil {
		color = strings.TrimSpace(*request.Color)
	}
	var item models.ConversationTag
	err = a.DB.QueryRowContext(c, `UPDATE conversation_tags SET name = COALESCE($4::text, name), color = COALESCE($5::text, color), updated_at = now() WHERE id = $1 AND user_id = $2 AND organization_id = $3 RETURNING id, name, color, created_at, updated_at`, id, principal.UserID, organizationID, name, color).Scan(&item.ID, &item.Name, &item.Color, &item.CreatedAt, &item.UpdatedAt)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("tag not found"))
		return
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			writeError(c, http.StatusConflict, fmt.Errorf("a tag with that name already exists"))
			return
		}
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"tag": item})
}

func (a *App) deleteConversationTag(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid tag id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM conversation_tags WHERE id = $1 AND user_id = $2 AND organization_id = $3`, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("tag not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) attachConversationTag(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	principal, organizationID, _ := workspaceScope(c)
	tagID, err := uuid.Parse(c.Param("tagId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid tag id"))
		return
	}
	var available bool
	if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM conversation_tags WHERE id = $1 AND user_id = $2 AND organization_id = $3)`, tagID, principal.UserID, organizationID).Scan(&available); err != nil || !available {
		writeError(c, http.StatusForbidden, fmt.Errorf("tag is not available"))
		return
	}
	if _, err := a.DB.ExecContext(c, `INSERT INTO conversation_tag_links (conversation_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, conversationID, tagID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) detachConversationTag(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	tagID, err := uuid.Parse(c.Param("tagId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid tag id"))
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM conversation_tag_links WHERE conversation_id = $1 AND tag_id = $2`, conversationID, tagID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) hydrateConversationOrganization(ctx context.Context, item *models.Conversation) error {
	var folderID sql.NullString
	var ownerID, projectID sql.NullString
	if err := a.DB.QueryRowContext(ctx, `SELECT folder_id::text, pinned_at, user_id::text, visibility, project_id::text FROM conversations WHERE id = $1`, item.ID).Scan(&folderID, &item.PinnedAt, &ownerID, &item.Visibility, &projectID); err != nil {
		return err
	}
	item.FolderID = parseOptionalUUIDString(folderID.String)
	item.OwnerID = uuid.Nil
	if parsedOwner := parseOptionalUUIDString(ownerID.String); parsedOwner != nil {
		item.OwnerID = *parsedOwner
	}
	item.ProjectID = parseOptionalUUIDString(projectID.String)
	rows, err := a.DB.QueryContext(ctx, `SELECT t.id, t.name, t.color, t.created_at, t.updated_at FROM conversation_tag_links l JOIN conversation_tags t ON t.id = l.tag_id WHERE l.conversation_id = $1 ORDER BY lower(t.name)`, item.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	item.Tags = []models.ConversationTag{}
	for rows.Next() {
		var tag models.ConversationTag
		if err := rows.Scan(&tag.ID, &tag.Name, &tag.Color, &tag.CreatedAt, &tag.UpdatedAt); err != nil {
			return err
		}
		item.Tags = append(item.Tags, tag)
	}
	return rows.Err()
}

func (a *App) listNotes(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	query := strings.TrimSpace(c.Query("q"))
	args := []any{principal.UserID, organizationID}
	where := `(n.user_id = $1 OR n.visibility = 'workspace') AND n.organization_id = $2`
	if query != "" {
		args = append(args, "%"+strings.ToLower(query)+"%")
		where += ` AND (lower(n.title) LIKE $3 OR lower(n.content) LIKE $3)`
	}
	rows, err := a.DB.QueryContext(c, `SELECT n.id, n.user_id::text, n.visibility, n.title, n.content, n.source_conversation_id, n.pinned_at, n.created_at, n.updated_at FROM notes n WHERE `+where+` ORDER BY n.pinned_at DESC NULLS LAST, n.updated_at DESC LIMIT 200`, args...)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := []models.Note{}
	for rows.Next() {
		var item models.Note
		var sourceID, ownerID sql.NullString
		if err := rows.Scan(&item.ID, &ownerID, &item.Visibility, &item.Title, &item.Content, &sourceID, &item.PinnedAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if parsedOwner := parseOptionalUUIDString(ownerID.String); parsedOwner != nil {
			item.OwnerID = *parsedOwner
		}
		item.CanManage = item.OwnerID == principal.UserID
		item.SourceConversationID = parseOptionalUUIDString(sourceID.String)
		result = append(result, item)
	}
	c.JSON(http.StatusOK, gin.H{"notes": result})
}

func (a *App) createNote(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request struct {
		Title                string  `json:"title"`
		Content              string  `json:"content"`
		SourceConversationID *string `json:"sourceConversationId"`
		Visibility           string  `json:"visibility"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	request.Title = strings.TrimSpace(request.Title)
	if request.Title == "" {
		request.Title = "Untitled note"
	}
	if len([]rune(request.Title)) > 160 || len(request.Content) > 10*1024*1024 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("note title or content is too large"))
		return
	}
	request.Visibility = strings.TrimSpace(request.Visibility)
	if request.Visibility == "" {
		request.Visibility = "private"
	}
	if request.Visibility != "private" && request.Visibility != "workspace" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("visibility must be private or workspace"))
		return
	}
	var sourceID any
	if request.SourceConversationID != nil && strings.TrimSpace(*request.SourceConversationID) != "" {
		parsed, parseErr := uuid.Parse(strings.TrimSpace(*request.SourceConversationID))
		if parseErr != nil || !a.conversationOwnedBy(c, parsed, principal.UserID, organizationID) {
			writeError(c, http.StatusBadRequest, fmt.Errorf("source conversation is not available"))
			return
		}
		sourceID = parsed
	}
	var item models.Note
	var rawSourceID sql.NullString
	err = a.DB.QueryRowContext(c, `INSERT INTO notes (user_id, organization_id, title, content, source_conversation_id, visibility) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title, content, source_conversation_id, pinned_at, created_at, updated_at`, principal.UserID, organizationID, request.Title, request.Content, sourceID, request.Visibility).Scan(&item.ID, &item.Title, &item.Content, &rawSourceID, &item.PinnedAt, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.SourceConversationID = parseOptionalUUIDString(rawSourceID.String)
	item.OwnerID = principal.UserID
	item.Visibility = request.Visibility
	item.CanManage = true
	c.JSON(http.StatusCreated, gin.H{"note": item})
}

func (a *App) getNote(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid note id"))
		return
	}
	var item models.Note
	var rawSourceID sql.NullString
	var ownerID sql.NullString
	err = a.DB.QueryRowContext(c, `SELECT id, user_id::text, visibility, title, content, source_conversation_id, pinned_at, created_at, updated_at FROM notes WHERE id = $1 AND organization_id = $3 AND (user_id = $2 OR visibility = 'workspace')`, id, principal.UserID, organizationID).Scan(&item.ID, &ownerID, &item.Visibility, &item.Title, &item.Content, &rawSourceID, &item.PinnedAt, &item.CreatedAt, &item.UpdatedAt)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("note not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.SourceConversationID = parseOptionalUUIDString(rawSourceID.String)
	if parsedOwner := parseOptionalUUIDString(ownerID.String); parsedOwner != nil {
		item.OwnerID = *parsedOwner
	}
	item.CanManage = item.OwnerID == principal.UserID
	c.JSON(http.StatusOK, gin.H{"note": item})
}

func (a *App) updateNote(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid note id"))
		return
	}
	var request struct {
		Title      *string `json:"title"`
		Content    *string `json:"content"`
		Pinned     *bool   `json:"pinned"`
		Visibility *string `json:"visibility"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.Title == nil && request.Content == nil && request.Pinned == nil && request.Visibility == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("title, content, pinned, or visibility is required"))
		return
	}
	if request.Visibility != nil {
		value := strings.TrimSpace(*request.Visibility)
		if value != "private" && value != "workspace" {
			writeError(c, http.StatusBadRequest, fmt.Errorf("visibility must be private or workspace"))
			return
		}
		var ownerID uuid.UUID
		if err := a.DB.QueryRowContext(c, `SELECT user_id FROM notes WHERE id = $1 AND organization_id = $2`, id, organizationID).Scan(&ownerID); err != nil {
			if err == sql.ErrNoRows {
				writeError(c, http.StatusNotFound, fmt.Errorf("note not found"))
			} else {
				writeError(c, http.StatusInternalServerError, err)
			}
			return
		}
		if ownerID != principal.UserID {
			writeError(c, http.StatusForbidden, fmt.Errorf("only the note owner can change sharing"))
			return
		}
	}
	title, content, pinned, visibility := any(nil), any(nil), any(nil), any(nil)
	if request.Title != nil {
		value := strings.TrimSpace(*request.Title)
		if value == "" || len([]rune(value)) > 160 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("note title must contain between 1 and 160 characters"))
			return
		}
		title = value
	}
	if request.Content != nil {
		if len(*request.Content) > 10*1024*1024 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("note content is limited to 10 MB"))
			return
		}
		content = *request.Content
	}
	if request.Pinned != nil {
		pinned = *request.Pinned
	}
	if request.Visibility != nil {
		visibility = strings.TrimSpace(*request.Visibility)
	}
	var item models.Note
	var rawSourceID sql.NullString
	var ownerID sql.NullString
	err = a.DB.QueryRowContext(c, `UPDATE notes SET title = COALESCE($4::text, title), content = COALESCE($5::text, content), pinned_at = CASE WHEN $6::boolean IS NULL THEN pinned_at WHEN $6 THEN COALESCE(pinned_at, now()) ELSE NULL END, visibility = COALESCE($7::text, visibility), updated_at = now() WHERE id = $1 AND organization_id = $3 AND (user_id = $2 OR visibility = 'workspace') RETURNING id, user_id::text, visibility, title, content, source_conversation_id, pinned_at, created_at, updated_at`, id, principal.UserID, organizationID, title, content, pinned, visibility).Scan(&item.ID, &ownerID, &item.Visibility, &item.Title, &item.Content, &rawSourceID, &item.PinnedAt, &item.CreatedAt, &item.UpdatedAt)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("note not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.SourceConversationID = parseOptionalUUIDString(rawSourceID.String)
	if parsedOwner := parseOptionalUUIDString(ownerID.String); parsedOwner != nil {
		item.OwnerID = *parsedOwner
	}
	item.CanManage = item.OwnerID == principal.UserID
	c.JSON(http.StatusOK, gin.H{"note": item})
}

func (a *App) deleteNote(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid note id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM notes WHERE id = $1 AND user_id = $2 AND organization_id = $3`, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("note not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

type webSearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
	Source  string `json:"source"`
}

func (a *App) webSearch(c *gin.Context) {
	query := strings.TrimSpace(c.Query("q"))
	if query == "" || len([]rune(query)) > 300 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("a search query between 1 and 300 characters is required"))
		return
	}
	limit := 8
	if raw := c.Query("limit"); raw != "" {
		if _, err := fmt.Sscanf(raw, "%d", &limit); err != nil || limit < 1 || limit > 12 {
			limit = 8
		}
	}
	result, err := a.searchWeb(c, query, limit)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"query": query, "results": result})
}

func parseDuckDuckGoResults(reader io.Reader, limit int) []webSearchResult {
	document, err := xhtml.Parse(reader)
	if err != nil {
		return []webSearchResult{}
	}
	result := []webSearchResult{}
	var walk func(*xhtml.Node)
	walk = func(node *xhtml.Node) {
		if node.Type == xhtml.ElementNode && node.Data == "a" && hasHTMLClass(node, "result__a") {
			href := htmlAttribute(node, "href")
			title := strings.TrimSpace(htmlText(node))
			if resolved, ok := resolveDuckDuckGoURL(href); ok && title != "" {
				snippet := ""
				if parent := node.Parent; parent != nil {
					if snippetNode := findHTMLClass(parent, "result__snippet"); snippetNode != nil {
						snippet = strings.TrimSpace(htmlText(snippetNode))
					}
				}
				result = append(result, webSearchResult{Title: title, URL: resolved, Snippet: snippet, Source: "DuckDuckGo"})
			}
			if len(result) >= limit {
				return
			}
		}
		for child := node.FirstChild; child != nil && len(result) < limit; child = child.NextSibling {
			walk(child)
		}
	}
	walk(document)
	return result
}

func resolveDuckDuckGoURL(raw string) (string, bool) {
	parsed, err := url.Parse(stdhtml.UnescapeString(strings.TrimSpace(raw)))
	if err != nil {
		return "", false
	}
	if value := parsed.Query().Get("uddg"); value != "" {
		if decoded, err := url.QueryUnescape(value); err == nil {
			parsed, err = url.Parse(decoded)
			if err != nil {
				return "", false
			}
		}
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" || parsed.Hostname() == "" {
		return "", false
	}
	return parsed.String(), true
}

func (a *App) webFetch(c *gin.Context) {
	rawURL := strings.TrimSpace(c.Query("url"))
	if rawURL == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("url is required"))
		return
	}
	content, err := a.fetchWebURL(c, rawURL)
	if err != nil {
		status := http.StatusBadGateway
		if a.RAG == nil {
			status = http.StatusServiceUnavailable
		}
		writeError(c, status, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"url": rawURL, "content": content})
}

func hasHTMLClass(node *xhtml.Node, class string) bool {
	for _, attribute := range node.Attr {
		if attribute.Key == "class" {
			for _, value := range strings.Fields(attribute.Val) {
				if value == class {
					return true
				}
			}
		}
	}
	return false
}

func findHTMLClass(node *xhtml.Node, class string) *xhtml.Node {
	if hasHTMLClass(node, class) {
		return node
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if found := findHTMLClass(child, class); found != nil {
			return found
		}
	}
	return nil
}

func htmlAttribute(node *xhtml.Node, key string) string {
	for _, attribute := range node.Attr {
		if attribute.Key == key {
			return attribute.Val
		}
	}
	return ""
}

func htmlText(node *xhtml.Node) string {
	if node.Type == xhtml.TextNode {
		return node.Data
	}
	var builder strings.Builder
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		builder.WriteByte(' ')
		builder.WriteString(htmlText(child))
	}
	return strings.Join(strings.Fields(builder.String()), " ")
}

func (a *App) resolveImageEndpoint(ctx context.Context, userID, organizationID uuid.UUID, rawID string) (uuid.UUID, error) {
	if rawID != "" {
		id, err := uuid.Parse(rawID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("invalid image endpoint id")
		}
		var scopeType string
		var scopeID sql.NullString
		if err := a.DB.QueryRowContext(ctx, `SELECT scope_type, scope_id::text FROM endpoint_settings WHERE id = $1 AND enabled = TRUE AND (capabilities->>'image-generation') = 'true'`, id).Scan(&scopeType, &scopeID); err != nil {
			return uuid.Nil, fmt.Errorf("image endpoint not found")
		}
		if scopeType == "global" || (scopeType == "user" && scopeID.String == userID.String()) || (scopeType == "organization" && scopeID.String == organizationID.String()) {
			return id, nil
		}
		return uuid.Nil, fmt.Errorf("image endpoint is outside the current scope")
	}
	var id uuid.UUID
	if err := a.DB.QueryRowContext(ctx, `SELECT id FROM endpoint_settings WHERE enabled = TRUE AND (capabilities->>'image-generation') = 'true' AND ((scope_type = 'user' AND scope_id = $1) OR (scope_type = 'organization' AND scope_id = $2) OR scope_type = 'global') ORDER BY CASE WHEN scope_type = 'user' THEN 1 WHEN scope_type = 'organization' THEN 2 ELSE 3 END, is_default DESC, created_at LIMIT 1`, userID, organizationID).Scan(&id); err != nil {
		return uuid.Nil, fmt.Errorf("no enabled image-generation endpoint is configured")
	}
	return id, nil
}

func imageEndpointURL(endpoint provider.Endpoint, suffix string) string {
	base := strings.TrimRight(endpoint.BaseURL, "/")
	path := strings.Trim(endpoint.APIPath, "/")
	if path != "" && !strings.HasSuffix(base, "/"+path) {
		base += "/" + path
	}
	return base + "/" + strings.TrimLeft(suffix, "/")
}

func imageProviderRequest(ctx context.Context, endpoint provider.Endpoint, method, suffix string, body io.Reader, contentType string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, imageEndpointURL(endpoint, suffix), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", contentType)
	if endpoint.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+endpoint.Credential)
	}
	return (&http.Client{Timeout: time.Duration(maxInt(endpoint.TimeoutSeconds, 120)) * time.Second}).Do(request)
}

func maxInt(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func decodeProviderImage(response *http.Response) ([]byte, string, error) {
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, "", fmt.Errorf("image provider returned status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	var payload struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
			URL     string `json:"url"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, "", err
	}
	if len(payload.Data) == 0 {
		return nil, "", fmt.Errorf("image provider returned no image")
	}
	if payload.Data[0].B64JSON != "" {
		data, err := base64.StdEncoding.DecodeString(payload.Data[0].B64JSON)
		return data, "image/png", err
	}
	if payload.Data[0].URL != "" {
		parsed, err := url.Parse(payload.Data[0].URL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return nil, "", fmt.Errorf("image provider returned an invalid image URL")
		}
		imageResponse, err := (&http.Client{Timeout: 30 * time.Second}).Get(parsed.String())
		if err != nil {
			return nil, "", err
		}
		defer imageResponse.Body.Close()
		if imageResponse.StatusCode >= 300 {
			return nil, "", fmt.Errorf("image URL returned status %d", imageResponse.StatusCode)
		}
		data, err := io.ReadAll(io.LimitReader(imageResponse.Body, 15*1024*1024+1))
		if err != nil || len(data) > 15*1024*1024 {
			return nil, "", fmt.Errorf("generated image is too large")
		}
		return data, firstImageMime(imageResponse.Header.Get("Content-Type")), nil
	}
	return nil, "", fmt.Errorf("image provider returned no usable image data")
}

func firstImageMime(value string) string {
	value = strings.TrimSpace(strings.Split(value, ";")[0])
	if strings.HasPrefix(value, "image/") {
		return value
	}
	return "image/png"
}

func (a *App) storeGeneratedImage(ctx context.Context, userID, organizationID, endpointID uuid.UUID, prompt, mode, mimeType string, data []byte) (models.GeneratedImage, error) {
	if len(data) == 0 || len(data) > 15*1024*1024 {
		return models.GeneratedImage{}, fmt.Errorf("generated image is empty or too large")
	}
	var item models.GeneratedImage
	err := a.DB.QueryRowContext(ctx, `INSERT INTO generated_images (user_id, organization_id, endpoint_id, prompt, mode, mime_type, image_data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, endpoint_id, prompt, mode, mime_type, created_at`, userID, organizationID, endpointID, prompt, mode, mimeType, data).Scan(&item.ID, &item.EndpointID, &item.Prompt, &item.Mode, &item.MimeType, &item.CreatedAt)
	if err != nil {
		return models.GeneratedImage{}, err
	}
	item.URL = "/api/v1/images/" + item.ID.String()
	return item, nil
}

func (a *App) generateImage(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request struct {
		EndpointID string `json:"endpointId"`
		Prompt     string `json:"prompt"`
		Size       string `json:"size"`
		Quality    string `json:"quality"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	request.Prompt = strings.TrimSpace(request.Prompt)
	if request.Prompt == "" || len([]rune(request.Prompt)) > 4000 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("an image prompt between 1 and 4000 characters is required"))
		return
	}
	if request.Size == "" {
		request.Size = "1024x1024"
	}
	if request.Quality == "" {
		request.Quality = "auto"
	}
	endpointID, err := a.resolveImageEndpoint(c, principal.UserID, organizationID, strings.TrimSpace(request.EndpointID))
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	endpoint, err := a.providerEndpoint(c, endpointID)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if endpoint.ProviderType != "openai" && endpoint.ProviderType != "openai-compatible" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("image generation currently requires an OpenAI-compatible image endpoint"))
		return
	}
	body, _ := json.Marshal(map[string]any{"model": imageModelForEndpoint(endpoint), "prompt": request.Prompt, "size": request.Size, "quality": request.Quality, "response_format": "b64_json"})
	response, err := imageProviderRequest(c, endpoint, http.MethodPost, "/images/generations", bytes.NewReader(body), "application/json")
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	data, mimeType, err := decodeProviderImage(response)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	item, err := a.storeGeneratedImage(c, principal.UserID, organizationID, endpointID, request.Prompt, "generate", mimeType, data)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"image": item})
}

func (a *App) editImage(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	fileHeader, err := c.FormFile("image")
	if err != nil || fileHeader.Size == 0 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("an image file is required"))
		return
	}
	if fileHeader.Size > 15*1024*1024 {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("images are limited to 15 MB"))
		return
	}
	prompt := strings.TrimSpace(c.PostForm("prompt"))
	if prompt == "" || len([]rune(prompt)) > 4000 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("an edit prompt between 1 and 4000 characters is required"))
		return
	}
	endpointID, err := a.resolveImageEndpoint(c, principal.UserID, organizationID, strings.TrimSpace(c.PostForm("endpointId")))
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	endpoint, err := a.providerEndpoint(c, endpointID)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	form := &bytes.Buffer{}
	writer := multipart.NewWriter(form)
	_ = writer.WriteField("model", imageModelForEndpoint(endpoint))
	_ = writer.WriteField("prompt", prompt)
	_ = writer.WriteField("response_format", "b64_json")
	part, err := writer.CreateFormFile("image", fileHeader.Filename)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	_, copyErr := io.Copy(part, file)
	_ = file.Close()
	if copyErr != nil {
		writeError(c, http.StatusBadRequest, copyErr)
		return
	}
	if err := writer.Close(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	response, err := imageProviderRequest(c, endpoint, http.MethodPost, "/images/edits", form, writer.FormDataContentType())
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	data, mimeType, err := decodeProviderImage(response)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	item, err := a.storeGeneratedImage(c, principal.UserID, organizationID, endpointID, prompt, "edit", mimeType, data)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"image": item})
}

func (a *App) serveGeneratedImage(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid image id"))
		return
	}
	var data []byte
	var mimeType string
	err = a.DB.QueryRowContext(c, `SELECT image_data, mime_type FROM generated_images WHERE id = $1 AND user_id = $2 AND organization_id = $3`, id, principal.UserID, organizationID).Scan(&data, &mimeType)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("image not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Data(http.StatusOK, mimeType, data)
}
