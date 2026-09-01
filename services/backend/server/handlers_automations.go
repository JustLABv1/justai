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
		item.WorkflowID, _ = a.automationWorkflowID(c, item.ID)
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
	if _, err := a.ensureAutomationWorkflow(c, id, principal.UserID, organizationID); err != nil {
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
	if workflowID, workflowErr := a.ensureAutomationWorkflow(c, id, principal.UserID, organizationID); workflowErr == nil {
		_ = a.syncAutomationWorkflow(c, workflowID, item)
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
	rows, err := a.DB.QueryContext(c, `SELECT r.id,r.automation_id,r.agent_run_id,r.status,r.summary,r.started_at,r.finished_at FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.automation_id=$1 AND a.user_id=$2 AND a.organization_id=$3 ORDER BY r.started_at DESC LIMIT 20`, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	runs := []models.AutomationRun{}
	for rows.Next() {
		var run models.AutomationRun
		if err := rows.Scan(&run.ID, &run.AutomationID, &run.AgentRunID, &run.Status, &run.Summary, &run.StartedAt, &run.FinishedAt); err != nil {
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
	workflowID, err := a.ensureAutomationWorkflow(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	definition := automationWorkflowDefinition(item)
	rootAgentID := item.AssistantID
	agentRun, err := a.AgentWorker.createRun(agentRunCreateOptions{UserID: principal.UserID, OrganizationID: organizationID, WorkflowID: &workflowID, RootAgentID: rootAgentID, SourceType: "manual", Input: json.RawMessage(`{"prompt":""}`), Definition: definition})
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	status, summary := "queued", "Run queued in the agent execution engine."
	var run models.AutomationRun
	err = a.DB.QueryRowContext(c, `INSERT INTO automation_runs (automation_id,agent_run_id,status,summary) VALUES ($1,$2,$3,$4) RETURNING id,automation_id,agent_run_id,status,summary,started_at,finished_at`, id, agentRun.ID, status, summary).Scan(&run.ID, &run.AutomationID, &run.AgentRunID, &run.Status, &run.Summary, &run.StartedAt, &run.FinishedAt)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	_, _ = a.DB.ExecContext(c, `UPDATE automations SET last_run_at=now(),updated_at=now() WHERE id=$1`, id)
	c.JSON(http.StatusCreated, gin.H{"run": run, "agentRun": agentRun})
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

func (a *App) automationWorkflowID(c *gin.Context, id uuid.UUID) (*uuid.UUID, error) {
	var raw sql.NullString
	err := a.DB.QueryRowContext(c, `SELECT workflow_id FROM automations WHERE id=$1`, id).Scan(&raw)
	if err != nil || !raw.Valid {
		return nil, err
	}
	return parseOptionalUUIDString(raw.String), nil
}

func automationWorkflowDefinition(item models.Automation) models.AgentWorkflowDefinition {
	var mcpIDs []uuid.UUID
	for _, raw := range item.MCPServerIDs {
		if id, err := uuid.Parse(strings.TrimSpace(raw)); err == nil {
			mcpIDs = append(mcpIDs, id)
		}
	}
	return models.AgentWorkflowDefinition{Nodes: []models.AgentWorkflowNode{{ID: "agent-1", Type: "agent", AgentID: item.AssistantID, Instruction: item.Prompt, Context: models.AgentContextScope{MCPServerIDs: mcpIDs}, ApprovalMode: item.ApprovalMode, Retry: models.AgentRetryPolicy{MaxAttempts: maxAgentAttempts}, TimeoutSeconds: int(maxAgentNodeTimeout / time.Second)}}}
}

func (a *App) ensureAutomationWorkflow(c *gin.Context, automationID, userID, organizationID uuid.UUID) (uuid.UUID, error) {
	if existing, err := a.automationWorkflowID(c, automationID); err == nil && existing != nil {
		return *existing, nil
	}
	item, err := a.loadAutomation(c, automationID, userID, organizationID)
	if err != nil {
		return uuid.Nil, err
	}
	definition := automationWorkflowDefinition(item)
	if err := ValidateAgentWorkflowDefinition(definition); err != nil {
		return uuid.Nil, err
	}
	schedule, scheduleErr := ParseAgentSchedule(item.Schedule)
	if scheduleErr != nil {
		// Keep compatibility records inspectable even if an old client wrote a
		// non-builder string. The canonical scheduler will leave that row paused
		// until the user normalizes it in Workflows.
		schedule = models.AgentSchedule{Kind: "legacy", Display: item.Schedule}
	}
	definitionRaw, _ := json.Marshal(definition)
	scheduleRaw, _ := json.Marshal(schedule)
	nextRun, _ := NextAgentScheduleTime(schedule, item.Timezone, time.Now().UTC())
	var workflowID uuid.UUID
	err = a.DB.QueryRowContext(c, `INSERT INTO agent_workflows (user_id,organization_id,name,description,visibility,definition,schedule,timezone,enabled,next_run_at,legacy_automation_id) VALUES ($1,$2,$3,$4,'private',$5,$6,$7,$8,$9,$10) RETURNING id`, userID, organizationID, item.Name, "Compatibility workflow for automation "+item.ID.String(), definitionRaw, scheduleRaw, item.Timezone, item.Enabled, nullableTime(nextRun), item.ID).Scan(&workflowID)
	if err != nil {
		// Another request may have created the projection between the initial
		// read and insert. Return that canonical id when possible.
		if existing, lookupErr := a.automationWorkflowID(c, automationID); lookupErr == nil && existing != nil {
			return *existing, nil
		}
		return uuid.Nil, err
	}
	if _, err := a.DB.ExecContext(c, `UPDATE automations SET workflow_id=$2,next_run_at=$3,updated_at=now() WHERE id=$1`, automationID, workflowID, nullableTime(nextRun)); err != nil {
		return uuid.Nil, err
	}
	return workflowID, nil
}

func (a *App) syncAutomationWorkflow(c *gin.Context, workflowID uuid.UUID, item models.Automation) error {
	definition := automationWorkflowDefinition(item)
	if err := ValidateAgentWorkflowDefinition(definition); err != nil {
		return err
	}
	schedule, err := ParseAgentSchedule(item.Schedule)
	if err != nil {
		schedule = models.AgentSchedule{Kind: "legacy", Display: item.Schedule}
	}
	definitionRaw, _ := json.Marshal(definition)
	scheduleRaw, _ := json.Marshal(schedule)
	nextRun, _ := NextAgentScheduleTime(schedule, item.Timezone, time.Now().UTC())
	_, err = a.DB.ExecContext(c, `UPDATE agent_workflows SET name=$2,definition=$3,schedule=$4,timezone=$5,enabled=$6,next_run_at=$7,updated_at=now() WHERE id=$1`, workflowID, item.Name, definitionRaw, scheduleRaw, item.Timezone, item.Enabled, nullableTime(nextRun))
	return err
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
