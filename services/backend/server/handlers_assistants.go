package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/models"
)

type savedAssistantQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type savedAssistantRequest struct {
	Name         *string `json:"name"`
	Description  *string `json:"description"`
	Icon         *string `json:"icon"`
	Visibility   *string `json:"visibility"`
	Instructions *string `json:"instructions"`
	EndpointID   *string `json:"endpointId"`
	Model        *string `json:"model"`
	UseMemory    *bool   `json:"useMemory"`
	DeepContext  *bool   `json:"deepContext"`
}

type savedAssistantValues struct {
	Name         string
	Description  string
	Icon         string
	Visibility   string
	Instructions string
	EndpointID   *uuid.UUID
	Model        string
	UseMemory    bool
	DeepContext  bool
}

func (a *App) listSavedAssistants(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT a.id, v.id, v.version, a.name, a.description, a.icon, a.visibility,
		       v.instructions, COALESCE(v.endpoint_id::text, ''), v.model,
		       v.use_memory, v.deep_context, a.created_at, a.updated_at
		FROM saved_assistants a
		JOIN saved_assistant_versions v
		  ON v.assistant_id = a.id AND v.version = a.current_version
		WHERE a.organization_id = $1
		  AND a.agent_kind = 'native'
		  AND a.deleted_at IS NULL
		  AND (a.visibility = 'workspace' OR a.user_id = $2)
		ORDER BY a.updated_at DESC, a.name`, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()

	result := []models.SavedAssistant{}
	for rows.Next() {
		item, scanErr := scanSavedAssistant(rows)
		if scanErr != nil {
			writeError(c, http.StatusInternalServerError, scanErr)
			return
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"assistants": result})
}

func (a *App) getSavedAssistant(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid assistant id"))
		return
	}
	item, err := loadSavedAssistant(c, a.DB, id, principal.UserID, organizationID)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(c, http.StatusNotFound, fmt.Errorf("assistant not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"assistant": item})
}

func (a *App) createSavedAssistant(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request savedAssistantRequest
	if !decodeJSON(c, &request) {
		return
	}
	values, err := savedAssistantValuesFromRequest(request, nil)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if err := a.validateSavedAssistantEndpoint(c, values.EndpointID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}

	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()

	var assistantID uuid.UUID
	if err := transaction.QueryRowContext(c, `
		INSERT INTO saved_assistants
			(user_id, organization_id, name, description, icon, visibility, current_version)
		VALUES ($1, $2, $3, $4, $5, $6, 1)
		RETURNING id`,
		principal.UserID, organizationID, values.Name, values.Description, values.Icon, values.Visibility,
	).Scan(&assistantID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}

	if _, err := transaction.ExecContext(c, `
		INSERT INTO saved_assistant_versions
			(assistant_id, version, instructions, endpoint_id, model, use_memory, deep_context, created_by)
		VALUES ($1, 1, $2, $3, $4, $5, $6, $7)
		`,
		assistantID, values.Instructions, values.EndpointID, values.Model, values.UseMemory, values.DeepContext, principal.UserID,
	); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}

	item, err := loadSavedAssistant(c, a.DB, assistantID, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"assistant": item})
}

func (a *App) updateSavedAssistant(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid assistant id"))
		return
	}
	var request savedAssistantRequest
	if !decodeJSON(c, &request) {
		return
	}
	current, err := loadSavedAssistantForMutation(c, a.DB, id, principal.UserID, organizationID)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(c, http.StatusNotFound, fmt.Errorf("assistant not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	values, err := savedAssistantValuesFromRequest(request, &current)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if err := a.validateSavedAssistantEndpoint(c, values.EndpointID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}

	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	nextVersion := current.Version + 1
	if _, err := transaction.ExecContext(c, `
		INSERT INTO saved_assistant_versions
			(assistant_id, version, instructions, endpoint_id, model, use_memory, deep_context, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		id, nextVersion, values.Instructions, values.EndpointID, values.Model, values.UseMemory, values.DeepContext, principal.UserID,
	); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := transaction.ExecContext(c, `
		UPDATE saved_assistants
		SET name = $2, description = $3, icon = $4, visibility = $5,
		    current_version = $6, updated_at = now()
		WHERE id = $1 AND user_id = $7 AND organization_id = $8`,
		id, values.Name, values.Description, values.Icon, values.Visibility, nextVersion, principal.UserID, organizationID,
	); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := loadSavedAssistant(c, a.DB, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"assistant": item})
}

func (a *App) deleteSavedAssistant(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid assistant id"))
		return
	}
	result, err := a.DB.ExecContext(c, `
		UPDATE saved_assistants
		SET deleted_at = now(), updated_at = now()
		WHERE id = $1 AND user_id = $2 AND organization_id = $3 AND deleted_at IS NULL`, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("assistant not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func loadSavedAssistant(ctx context.Context, queryer savedAssistantQueryer, id, userID, organizationID uuid.UUID) (models.SavedAssistant, error) {
	return scanSavedAssistant(queryer.QueryRowContext(ctx, `
		SELECT a.id, v.id, v.version, a.name, a.description, a.icon, a.visibility,
		       v.instructions, COALESCE(v.endpoint_id::text, ''), v.model,
		       v.use_memory, v.deep_context, a.created_at, a.updated_at
		FROM saved_assistants a
		JOIN saved_assistant_versions v
		  ON v.assistant_id = a.id AND v.version = a.current_version
		WHERE a.id = $1 AND a.organization_id = $2
		  AND a.agent_kind = 'native'
		  AND a.deleted_at IS NULL
		  AND (a.visibility = 'workspace' OR a.user_id = $3)`, id, organizationID, userID))
}

func loadSavedAssistantForMutation(ctx context.Context, queryer savedAssistantQueryer, id, userID, organizationID uuid.UUID) (models.SavedAssistant, error) {
	return scanSavedAssistant(queryer.QueryRowContext(ctx, `
		SELECT a.id, v.id, v.version, a.name, a.description, a.icon, a.visibility,
		       v.instructions, COALESCE(v.endpoint_id::text, ''), v.model,
		       v.use_memory, v.deep_context, a.created_at, a.updated_at
		FROM saved_assistants a
		JOIN saved_assistant_versions v
		  ON v.assistant_id = a.id AND v.version = a.current_version
		WHERE a.id = $1 AND a.organization_id = $2 AND a.user_id = $3
		  AND a.agent_kind = 'native'
		  AND a.deleted_at IS NULL`, id, organizationID, userID))
}

// loadCanonicalSavedAssistant is used by conversation routing. The public
// /assistants compatibility adapter intentionally filters to native agents,
// but a conversation may be pinned to a remote first-class agent.
func loadCanonicalSavedAssistant(ctx context.Context, queryer savedAssistantQueryer, id, userID, organizationID uuid.UUID) (models.SavedAssistant, error) {
	return scanSavedAssistant(queryer.QueryRowContext(ctx, `
		SELECT a.id, v.id, v.version, a.name, a.description, a.icon, a.visibility,
		       v.instructions, COALESCE(v.endpoint_id::text, ''), v.model,
		       v.use_memory, v.deep_context, a.created_at, a.updated_at
		FROM saved_assistants a
		JOIN saved_assistant_versions v
		  ON v.assistant_id = a.id AND v.version = a.current_version
		WHERE a.id = $1 AND a.organization_id = $2
		  AND a.deleted_at IS NULL
		  AND (a.visibility = 'workspace' OR a.user_id = $3)`, id, organizationID, userID))
}

func scanSavedAssistant(scanner interface{ Scan(...any) error }) (models.SavedAssistant, error) {
	var item models.SavedAssistant
	var rawEndpointID string
	err := scanner.Scan(
		&item.ID, &item.VersionID, &item.Version, &item.Name, &item.Description,
		&item.Icon, &item.Visibility, &item.Instructions, &rawEndpointID,
		&item.Model, &item.UseMemory, &item.DeepContext, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return item, err
	}
	item.EndpointID = parseOptionalUUIDString(rawEndpointID)
	return item, nil
}

func savedAssistantValuesFromRequest(request savedAssistantRequest, current *models.SavedAssistant) (savedAssistantValues, error) {
	values := savedAssistantValues{
		Name:         "",
		Description:  "",
		Icon:         "sparkles",
		Visibility:   "private",
		Instructions: "",
		Model:        "",
		UseMemory:    true,
	}
	if current != nil {
		values = savedAssistantValues{
			Name:         current.Name,
			Description:  current.Description,
			Icon:         current.Icon,
			Visibility:   current.Visibility,
			Instructions: current.Instructions,
			EndpointID:   current.EndpointID,
			Model:        current.Model,
			UseMemory:    current.UseMemory,
			DeepContext:  current.DeepContext,
		}
	}
	if request.Name != nil {
		values.Name = strings.TrimSpace(*request.Name)
	}
	if request.Description != nil {
		values.Description = strings.TrimSpace(*request.Description)
	}
	if request.Icon != nil {
		values.Icon = strings.TrimSpace(*request.Icon)
	}
	if request.Visibility != nil {
		values.Visibility = strings.TrimSpace(*request.Visibility)
	}
	if request.Instructions != nil {
		values.Instructions = strings.TrimSpace(*request.Instructions)
	}
	if request.Model != nil {
		values.Model = strings.TrimSpace(*request.Model)
	}
	if request.UseMemory != nil {
		values.UseMemory = *request.UseMemory
	}
	if request.DeepContext != nil {
		values.DeepContext = *request.DeepContext
	}
	if request.EndpointID != nil {
		raw := strings.TrimSpace(*request.EndpointID)
		if raw == "" {
			values.EndpointID = nil
		} else {
			parsed, err := uuid.Parse(raw)
			if err != nil {
				return values, fmt.Errorf("invalid endpoint id")
			}
			values.EndpointID = &parsed
		}
	}
	if values.Name == "" {
		return values, fmt.Errorf("name is required")
	}
	if utf8.RuneCountInString(values.Name) > 80 {
		return values, fmt.Errorf("name must be between 1 and 80 characters")
	}
	if utf8.RuneCountInString(values.Description) > 300 {
		return values, fmt.Errorf("description must be 300 characters or fewer")
	}
	if values.Icon == "" || utf8.RuneCountInString(values.Icon) > 40 {
		return values, fmt.Errorf("icon must be between 1 and 40 characters")
	}
	if values.Visibility != "private" && values.Visibility != "workspace" {
		return values, fmt.Errorf("visibility must be private or workspace")
	}
	if utf8.RuneCountInString(values.Instructions) > 30000 {
		return values, fmt.Errorf("instructions must be 30000 characters or fewer")
	}
	if utf8.RuneCountInString(values.Model) > 200 {
		return values, fmt.Errorf("model must be 200 characters or fewer")
	}
	return values, nil
}

func (a *App) validateSavedAssistantEndpoint(c *gin.Context, endpointID *uuid.UUID, userID, organizationID uuid.UUID) error {
	if endpointID == nil {
		return nil
	}
	var available bool
	err := a.DB.QueryRowContext(c, `
		SELECT EXISTS (
			SELECT 1
			FROM endpoint_settings
			WHERE id = $1 AND enabled = TRUE
			  AND (capabilities->>'chat') = 'true'
			  AND (scope_type = 'global'
			       OR (scope_type = 'organization' AND scope_id = $2)
			       OR (scope_type = 'user' AND scope_id = $3))
		)`, *endpointID, organizationID, userID).Scan(&available)
	if err != nil {
		return err
	}
	if !available {
		return fmt.Errorf("endpoint is not available to this workspace")
	}
	return nil
}

func (a *App) savedAssistantForConversation(ctx context.Context, conversationID, userID, organizationID uuid.UUID) (*models.SavedAssistant, error) {
	item, err := scanSavedAssistant(a.DB.QueryRowContext(ctx, `
		SELECT a.id, v.id, v.version, a.name, a.description, a.icon, a.visibility,
		       v.instructions, COALESCE(v.endpoint_id::text, ''), v.model,
		       v.use_memory, v.deep_context, a.created_at, a.updated_at
		FROM conversations c
		JOIN saved_assistants a ON a.id = c.assistant_id
		JOIN saved_assistant_versions v
		  ON v.id = c.assistant_version_id AND v.assistant_id = a.id
		WHERE c.id = $1 AND c.organization_id = $3
		  AND (c.user_id = $2 OR c.visibility = 'workspace')`, conversationID, userID, organizationID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func savedAssistantInstructions(assistant *models.SavedAssistant) string {
	if assistant == nil || strings.TrimSpace(assistant.Instructions) == "" {
		return ""
	}
	return "You are the saved assistant named \"" + assistant.Name + "\". Follow these instructions for this conversation:\n\n" + strings.TrimSpace(assistant.Instructions)
}
