package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/models"
)

type automationRequest struct {
	Name         *string  `json:"name"`
	Prompt       *string  `json:"prompt"`
	AssistantID  *string  `json:"assistantId"`
	Schedule     *string  `json:"schedule"`
	Timezone     *string  `json:"timezone"`
	MCPServerIDs []string `json:"mcpServerIds"`
	ApprovalMode *string  `json:"approvalMode"`
	Enabled      *bool    `json:"enabled"`
}

func (a *App) listAutomations(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `SELECT id, name, prompt, assistant_id, schedule, timezone, mcp_server_ids, approval_mode, enabled, last_run_at, next_run_at, created_at, updated_at FROM automations WHERE organization_id = $1 AND user_id = $2 ORDER BY updated_at DESC`, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	items := []models.Automation{}
	for rows.Next() {
		item, scanErr := scanAutomation(rows)
		if scanErr != nil {
			writeError(c, http.StatusInternalServerError, scanErr)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"automations": items})
}

func (a *App) createAutomation(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request automationRequest
	if !decodeJSON(c, &request) {
		return
	}
	name, prompt, schedule, timezone, approval, assistantID, err := automationValues(request, nil)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var id uuid.UUID
	err = a.DB.QueryRowContext(c, `INSERT INTO automations (user_id, organization_id, assistant_id, name, prompt, schedule, timezone, mcp_server_ids, approval_mode, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, principal.UserID, organizationID, assistantID, name, prompt, schedule, timezone, jsonRaw(request.MCPServerIDs), approval, boolValue(request.Enabled, true)).Scan(&id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := a.loadAutomation(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"automation": item})
}

func (a *App) updateAutomation(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid automation id"))
		return
	}
	current, err := a.loadAutomation(c, id, principal.UserID, organizationID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeError(c, http.StatusNotFound, fmt.Errorf("automation not found"))
		} else {
			writeError(c, http.StatusInternalServerError, err)
		}
		return
	}
	var request automationRequest
	if !decodeJSON(c, &request) {
		return
	}
	name, prompt, schedule, timezone, approval, assistantID, err := automationValues(request, &current)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	mcpIDs := current.MCPServerIDs
	if request.MCPServerIDs != nil {
		mcpIDs = request.MCPServerIDs
	}
	enabled := current.Enabled
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	_, err = a.DB.ExecContext(c, `UPDATE automations SET assistant_id=$2,name=$3,prompt=$4,schedule=$5,timezone=$6,mcp_server_ids=$7,approval_mode=$8,enabled=$9,updated_at=now() WHERE id=$1`, id, assistantID, name, prompt, schedule, timezone, jsonRaw(mcpIDs), approval, enabled)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := a.loadAutomation(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"automation": item})
}

func (a *App) deleteAutomation(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid automation id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM automations WHERE id=$1 AND user_id=$2 AND organization_id=$3`, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("automation not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) listAutomationRuns(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid automation id"))
		return
	}
	rows, err := a.DB.QueryContext(c, `SELECT r.id,r.automation_id,r.status,r.summary,r.started_at,r.finished_at FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.automation_id=$1 AND a.user_id=$2 AND a.organization_id=$3 ORDER BY r.started_at DESC LIMIT 20`, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	runs := []models.AutomationRun{}
	for rows.Next() {
		var run models.AutomationRun
		if err := rows.Scan(&run.ID, &run.AutomationID, &run.Status, &run.Summary, &run.StartedAt, &run.FinishedAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		runs = append(runs, run)
	}
	c.JSON(http.StatusOK, gin.H{"runs": runs})
}

func (a *App) runAutomation(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid automation id"))
		return
	}
	item, err := a.loadAutomation(c, id, principal.UserID, organizationID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeError(c, http.StatusNotFound, fmt.Errorf("automation not found"))
		} else {
			writeError(c, http.StatusInternalServerError, err)
		}
		return
	}
	status, summary := "needs_review", "Run queued for review before any connected integration can make changes."
	if item.ApprovalMode == "read_only_auto" {
		status = "queued"
		summary = "Read-only run queued with the selected MCP access."
	}
	var run models.AutomationRun
	err = a.DB.QueryRowContext(c, `INSERT INTO automation_runs (automation_id,status,summary) VALUES ($1,$2,$3) RETURNING id,automation_id,status,summary,started_at,finished_at`, id, status, summary).Scan(&run.ID, &run.AutomationID, &run.Status, &run.Summary, &run.StartedAt, &run.FinishedAt)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	_, _ = a.DB.ExecContext(c, `UPDATE automations SET last_run_at=now(),updated_at=now() WHERE id=$1`, id)
	c.JSON(http.StatusCreated, gin.H{"run": run})
}

func (a *App) loadAutomation(c *gin.Context, id, userID, organizationID uuid.UUID) (models.Automation, error) {
	return scanAutomation(a.DB.QueryRowContext(c, `SELECT id,name,prompt,assistant_id,schedule,timezone,mcp_server_ids,approval_mode,enabled,last_run_at,next_run_at,created_at,updated_at FROM automations WHERE id=$1 AND user_id=$2 AND organization_id=$3`, id, userID, organizationID))
}
func scanAutomation(scanner interface{ Scan(...any) error }) (models.Automation, error) {
	var item models.Automation
	var ids []byte
	err := scanner.Scan(&item.ID, &item.Name, &item.Prompt, &item.AssistantID, &item.Schedule, &item.Timezone, &ids, &item.ApprovalMode, &item.Enabled, &item.LastRunAt, &item.NextRunAt, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(ids, &item.MCPServerIDs); err != nil {
		return item, err
	}
	return item, nil
}
func automationValues(request automationRequest, current *models.Automation) (string, string, string, string, string, *uuid.UUID, error) {
	name, prompt, schedule, timezone, approval := "", "", "", "", ""
	var assistantID *uuid.UUID
	if current != nil {
		name, prompt, schedule, timezone, approval, assistantID = current.Name, current.Prompt, current.Schedule, current.Timezone, current.ApprovalMode, current.AssistantID
	}
	if request.Name != nil {
		name = strings.TrimSpace(*request.Name)
	}
	if request.Prompt != nil {
		prompt = strings.TrimSpace(*request.Prompt)
	}
	if request.Schedule != nil {
		schedule = strings.TrimSpace(*request.Schedule)
	}
	if request.Timezone != nil {
		timezone = strings.TrimSpace(*request.Timezone)
	}
	if request.ApprovalMode != nil {
		approval = *request.ApprovalMode
	}
	if request.AssistantID != nil {
		if strings.TrimSpace(*request.AssistantID) == "" {
			assistantID = nil
		} else {
			parsed, err := uuid.Parse(*request.AssistantID)
			if err != nil {
				return "", "", "", "", "", nil, fmt.Errorf("invalid assistant id")
			}
			assistantID = &parsed
		}
	}
	if name == "" || len(name) > 120 {
		return "", "", "", "", "", nil, fmt.Errorf("name must be between 1 and 120 characters")
	}
	if prompt == "" || len(prompt) > 30000 {
		return "", "", "", "", "", nil, fmt.Errorf("task instructions are required")
	}
	if schedule == "" || len(schedule) > 160 {
		return "", "", "", "", "", nil, fmt.Errorf("schedule is required")
	}
	if timezone == "" || len(timezone) > 80 {
		return "", "", "", "", "", nil, fmt.Errorf("timezone is required")
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		return "", "", "", "", "", nil, fmt.Errorf("timezone must be a valid IANA timezone")
	}
	if approval != "review" && approval != "read_only_auto" {
		return "", "", "", "", "", nil, fmt.Errorf("invalid approval mode")
	}
	return name, prompt, schedule, timezone, approval, assistantID, nil
}
