package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/models"
)

type agentWorkflowVersionResponse struct {
	ID          int64                          `json:"id"`
	WorkflowID  uuid.UUID                      `json:"workflowId"`
	Version     int                            `json:"version"`
	Name        string                         `json:"name"`
	Description string                         `json:"description"`
	Visibility  string                         `json:"visibility"`
	Definition  models.AgentWorkflowDefinition `json:"definition"`
	Schedule    models.AgentSchedule           `json:"schedule"`
	Timezone    string                         `json:"timezone"`
	Enabled     bool                           `json:"enabled"`
	CreatedBy   *uuid.UUID                     `json:"createdBy,omitempty"`
	CreatedAt   time.Time                      `json:"createdAt"`
}

func (a *App) listAgentWorkflowVersions(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	workflowID, err := parseRouteUUID(c, "workflow")
	if err != nil {
		return
	}
	if _, _, err := a.loadWorkflowForAccess(c, workflowID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, publicError("workflow_not_found", "workflow not found"))
		return
	}
	limit := 50
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 1 || parsed > 100 {
			writeError(c, http.StatusBadRequest, publicError("invalid_limit", "limit must be between 1 and 100"))
			return
		}
		limit = parsed
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT v.id,v.workflow_id,v.version,v.name,v.description,v.visibility,v.definition,v.schedule,v.timezone,v.enabled,v.created_by,v.created_at
		FROM agent_workflow_versions v
		JOIN agent_workflows w ON w.id = v.workflow_id
		WHERE v.workflow_id = $1 AND w.organization_id = $2 AND w.deleted_at IS NULL
		  AND (w.visibility = 'workspace' OR w.user_id = $3)
		ORDER BY v.version DESC
		LIMIT $4`, workflowID, organizationID, principal.UserID, limit)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	versions := make([]agentWorkflowVersionResponse, 0, limit)
	for rows.Next() {
		item, scanErr := scanAgentWorkflowVersion(rows)
		if scanErr != nil {
			writeError(c, http.StatusInternalServerError, scanErr)
			return
		}
		versions = append(versions, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"versions": versions})
}

func (a *App) getAgentWorkflowVersion(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	workflowID, err := parseRouteUUID(c, "workflow")
	if err != nil {
		return
	}
	version, err := strconv.Atoi(c.Param("version"))
	if err != nil || version < 1 {
		writeError(c, http.StatusBadRequest, publicError("invalid_version", "workflow version is invalid"))
		return
	}
	if _, _, err := a.loadWorkflowForAccess(c, workflowID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, publicError("workflow_not_found", "workflow not found"))
		return
	}
	item, err := a.loadAgentWorkflowVersion(c, workflowID, version, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, publicError("version_not_found", "workflow version not found"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"version": item})
}

func (a *App) restoreAgentWorkflowVersion(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	workflowID, err := parseRouteUUID(c, "workflow")
	if err != nil {
		return
	}
	version, err := strconv.Atoi(c.Param("version"))
	if err != nil || version < 1 {
		writeError(c, http.StatusBadRequest, publicError("invalid_version", "workflow version is invalid"))
		return
	}
	current, ownerID, err := a.loadWorkflowForAccess(c, workflowID, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, publicError("workflow_not_found", "workflow not found"))
		return
	}
	if err := a.authorizeWorkflowManage(c, ownerID, current.Visibility, principal); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	snapshot, err := a.loadAgentWorkflowVersion(c, workflowID, version, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, publicError("version_not_found", "workflow version not found"))
		return
	}
	if err := ValidateAgentWorkflowDefinition(snapshot.Definition); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if err := a.validateSharedWorkflowResources(c, snapshot.Definition, snapshot.Visibility, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	nextRun, err := NextAgentScheduleTime(snapshot.Schedule, snapshot.Timezone, time.Now().UTC())
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	definitionRaw, _ := json.Marshal(snapshot.Definition)
	scheduleRaw, _ := json.Marshal(snapshot.Schedule)
	result, err := a.DB.ExecContext(c, `UPDATE agent_workflows SET name=$2,description=$3,visibility=$4,definition=$5,schedule=$6,timezone=$7,enabled=$8,next_run_at=$9,updated_at=now() WHERE id=$1 AND organization_id=$10 AND deleted_at IS NULL`, workflowID, snapshot.Name, snapshot.Description, snapshot.Visibility, definitionRaw, scheduleRaw, snapshot.Timezone, snapshot.Enabled, nullableTime(nextRun), organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		writeError(c, http.StatusNotFound, publicError("workflow_not_found", "workflow not found"))
		return
	}
	item, _, err := a.loadWorkflowForAccess(c, workflowID, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"workflow": item, "restoredVersion": version})
}

func (a *App) loadAgentWorkflowVersion(c *gin.Context, workflowID uuid.UUID, version int, organizationID uuid.UUID) (agentWorkflowVersionResponse, error) {
	var item agentWorkflowVersionResponse
	var definitionRaw, scheduleRaw []byte
	var createdBy uuid.NullUUID
	err := a.DB.QueryRowContext(c, `SELECT id,workflow_id,version,name,description,visibility,definition,schedule,timezone,enabled,created_by,created_at FROM agent_workflow_versions WHERE workflow_id=$1 AND version=$2 AND EXISTS (SELECT 1 FROM agent_workflows WHERE id=$1 AND organization_id=$3 AND deleted_at IS NULL)`, workflowID, version, organizationID).Scan(&item.ID, &item.WorkflowID, &item.Version, &item.Name, &item.Description, &item.Visibility, &definitionRaw, &scheduleRaw, &item.Timezone, &item.Enabled, &createdBy, &item.CreatedAt)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(definitionRaw, &item.Definition); err != nil {
		return item, fmt.Errorf("workflow definition is invalid: %w", err)
	}
	if err := json.Unmarshal(scheduleRaw, &item.Schedule); err != nil {
		return item, fmt.Errorf("workflow schedule is invalid: %w", err)
	}
	if createdBy.Valid {
		item.CreatedBy = &createdBy.UUID
	}
	return item, nil
}

func scanAgentWorkflowVersion(scanner interface{ Scan(...any) error }) (agentWorkflowVersionResponse, error) {
	var item agentWorkflowVersionResponse
	var definitionRaw, scheduleRaw []byte
	var createdBy uuid.NullUUID
	if err := scanner.Scan(&item.ID, &item.WorkflowID, &item.Version, &item.Name, &item.Description, &item.Visibility, &definitionRaw, &scheduleRaw, &item.Timezone, &item.Enabled, &createdBy, &item.CreatedAt); err != nil {
		return item, err
	}
	if err := json.Unmarshal(definitionRaw, &item.Definition); err != nil {
		return item, err
	}
	if err := json.Unmarshal(scheduleRaw, &item.Schedule); err != nil {
		return item, err
	}
	if createdBy.Valid {
		item.CreatedBy = &createdBy.UUID
	}
	return item, nil
}
