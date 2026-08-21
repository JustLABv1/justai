package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/models"
)

func (a *App) listWorkspaceProjects(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT id, user_id, name, description, visibility, created_at, updated_at
		FROM workspace_projects
		WHERE organization_id = $1 AND (user_id = $2 OR visibility = 'workspace')
		ORDER BY updated_at DESC, lower(name)`, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	projects := make([]models.WorkspaceProject, 0)
	for rows.Next() {
		item, scanErr := scanWorkspaceProject(rows, principal.UserID, organizationID)
		if scanErr != nil {
			writeError(c, http.StatusInternalServerError, scanErr)
			return
		}
		projects = append(projects, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"projects": projects})
}

func (a *App) createWorkspaceProject(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Visibility  string `json:"visibility"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	request.Description = strings.TrimSpace(request.Description)
	request.Visibility = strings.TrimSpace(request.Visibility)
	if request.Name == "" || utf8.RuneCountInString(request.Name) > 120 || utf8.RuneCountInString(request.Description) > 30000 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("project name or description is too large"))
		return
	}
	if request.Visibility == "" {
		request.Visibility = "private"
	}
	if request.Visibility != "private" && request.Visibility != "workspace" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("visibility must be private or workspace"))
		return
	}
	var item models.WorkspaceProject
	err = a.DB.QueryRowContext(c, `
		INSERT INTO workspace_projects (user_id, organization_id, name, description, visibility)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, user_id, name, description, visibility, created_at, updated_at
	`, principal.UserID, organizationID, request.Name, request.Description, request.Visibility).Scan(
		&item.ID, &item.OwnerID, &item.Name, &item.Description, &item.Visibility, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.CanManage = true
	c.JSON(http.StatusCreated, gin.H{"project": item})
}

func (a *App) getWorkspaceProject(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid project id"))
		return
	}
	item, err := a.loadWorkspaceProject(c, id, principal.UserID, organizationID)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("project not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"project": item})
}

func (a *App) updateWorkspaceProject(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid project id"))
		return
	}
	var request struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Visibility  *string `json:"visibility"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.Name == nil && request.Description == nil && request.Visibility == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("name, description, or visibility is required"))
		return
	}
	var name, description, visibility any
	if request.Name != nil {
		value := strings.TrimSpace(*request.Name)
		if value == "" || utf8.RuneCountInString(value) > 120 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("project name must contain between 1 and 120 characters"))
			return
		}
		name = value
	}
	if request.Description != nil {
		value := strings.TrimSpace(*request.Description)
		if utf8.RuneCountInString(value) > 30000 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("project description is too large"))
			return
		}
		description = value
	}
	if request.Visibility != nil {
		value := strings.TrimSpace(*request.Visibility)
		if value != "private" && value != "workspace" {
			writeError(c, http.StatusBadRequest, fmt.Errorf("visibility must be private or workspace"))
			return
		}
		visibility = value
	}
	var item models.WorkspaceProject
	err = a.DB.QueryRowContext(c, `
		UPDATE workspace_projects
		SET name = COALESCE($3::text, name),
		    description = COALESCE($4::text, description),
		    visibility = COALESCE($5::text, visibility),
		    updated_at = now()
		WHERE id = $1 AND user_id = $2 AND organization_id = $6
		RETURNING id, user_id, name, description, visibility, created_at, updated_at
	`, id, principal.UserID, name, description, visibility, organizationID).Scan(
		&item.ID, &item.OwnerID, &item.Name, &item.Description, &item.Visibility, &item.CreatedAt, &item.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("project not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.CanManage = true
	c.JSON(http.StatusOK, gin.H{"project": item})
}

func (a *App) deleteWorkspaceProject(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid project id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM workspace_projects WHERE id = $1 AND user_id = $2 AND organization_id = $3`, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("project not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) loadWorkspaceProject(ctx context.Context, id, userID, organizationID uuid.UUID) (models.WorkspaceProject, error) {
	var item models.WorkspaceProject
	err := a.DB.QueryRowContext(ctx, `
		SELECT id, user_id, name, description, visibility, created_at, updated_at
		FROM workspace_projects
		WHERE id = $1 AND organization_id = $3 AND (user_id = $2 OR visibility = 'workspace')
	`, id, userID, organizationID).Scan(&item.ID, &item.OwnerID, &item.Name, &item.Description, &item.Visibility, &item.CreatedAt, &item.UpdatedAt)
	if err == nil {
		item.OrganizationID = organizationID
		item.CanManage = item.OwnerID == userID
	}
	return item, err
}

func scanWorkspaceProject(scanner interface{ Scan(dest ...any) error }, userID, organizationID uuid.UUID) (models.WorkspaceProject, error) {
	var item models.WorkspaceProject
	if err := scanner.Scan(&item.ID, &item.OwnerID, &item.Name, &item.Description, &item.Visibility, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	item.OrganizationID = organizationID
	item.CanManage = item.OwnerID == userID
	return item, nil
}

func (a *App) loadConversationProject(ctx context.Context, conversationID, userID, organizationID uuid.UUID) (*models.WorkspaceProject, error) {
	var item models.WorkspaceProject
	err := a.DB.QueryRowContext(ctx, `
		SELECT p.id, p.user_id, p.name, p.description, p.visibility, p.created_at, p.updated_at
		FROM conversations c
		JOIN workspace_projects p ON p.id = c.project_id
		WHERE c.id = $1 AND c.organization_id = $3
		  AND (c.user_id = $2 OR c.visibility = 'workspace')
	`, conversationID, userID, organizationID).Scan(&item.ID, &item.OwnerID, &item.Name, &item.Description, &item.Visibility, &item.CreatedAt, &item.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item.OrganizationID = organizationID
	item.CanManage = item.OwnerID == userID
	return &item, nil
}

func (a *App) projectPrompt(ctx context.Context, conversationID uuid.UUID) (string, error) {
	var name, description string
	err := a.DB.QueryRowContext(ctx, `
		SELECT p.name, p.description
		FROM conversations c
		JOIN workspace_projects p ON p.id = c.project_id
		WHERE c.id = $1`, conversationID).Scan(&name, &description)
	if err == sql.ErrNoRows || strings.TrimSpace(description) == "" {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Project context for %s. Treat this as durable workspace context and keep responses aligned with it:\n%s", strings.TrimSpace(name), strings.TrimSpace(description)), nil
}
