package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
)

type agentWorkflowRequest struct {
	Name        *string         `json:"name"`
	Description *string         `json:"description"`
	Visibility  *string         `json:"visibility"`
	Definition  json.RawMessage `json:"definition"`
	Schedule    json.RawMessage `json:"schedule"`
	Timezone    *string         `json:"timezone"`
	Enabled     *bool           `json:"enabled"`
}

type workflowRunRequest struct {
	Input      json.RawMessage `json:"input"`
	SourceType string          `json:"sourceType"`
}

type agentApprovalDecisionRequest struct {
	Decision     string `json:"decision"`
	Reason       string `json:"reason"`
	ArgumentHash string `json:"argumentHash"`
}

func (a *App) listAgentWorkflows(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT id,name,description,visibility,definition,schedule,timezone,enabled,last_run_at,next_run_at,created_at,updated_at
		FROM agent_workflows
		WHERE organization_id=$1 AND deleted_at IS NULL AND (visibility='workspace' OR user_id=$2)
		ORDER BY updated_at DESC,name`, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	items := []models.AgentWorkflow{}
	for rows.Next() {
		item, scanErr := scanAgentWorkflow(rows)
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
	c.JSON(http.StatusOK, gin.H{"workflows": items})
}

func scanAgentWorkflow(scanner interface{ Scan(...any) error }) (models.AgentWorkflow, error) {
	var item models.AgentWorkflow
	var definitionRaw, scheduleRaw []byte
	if err := scanner.Scan(&item.ID, &item.Name, &item.Description, &item.Visibility, &definitionRaw, &scheduleRaw, &item.Timezone, &item.Enabled, &item.LastRunAt, &item.NextRunAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	if err := json.Unmarshal(definitionRaw, &item.Definition); err != nil {
		return item, fmt.Errorf("workflow definition is invalid: %w", err)
	}
	if err := json.Unmarshal(scheduleRaw, &item.Schedule); err != nil {
		return item, fmt.Errorf("workflow schedule is invalid: %w", err)
	}
	return item, nil
}

func (a *App) getAgentWorkflow(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := parseRouteUUID(c, "workflow")
	if err != nil {
		return
	}
	item, _, err := a.loadWorkflowForAccess(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("workflow not found"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"workflow": item})
}

func (a *App) createAgentWorkflow(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request agentWorkflowRequest
	if !decodeJSON(c, &request) {
		return
	}
	name := strings.TrimSpace(stringValue(request.Name))
	if name == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("name is required"))
		return
	}
	definition, err := parseWorkflowDefinition(request.Definition)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	timezone := strings.TrimSpace(stringValue(request.Timezone))
	if timezone == "" {
		timezone = "UTC"
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("timezone must be a valid IANA timezone"))
		return
	}
	schedule, err := parseWorkflowSchedule(request.Schedule)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	visibility := strings.TrimSpace(stringValue(request.Visibility))
	if visibility == "" {
		visibility = "private"
	}
	if visibility != "private" && visibility != "workspace" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("visibility must be private or workspace"))
		return
	}
	if err := a.validateSharedWorkflowResources(c, definition, visibility, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	nextRun, err := NextAgentScheduleTime(schedule, timezone, time.Now().UTC())
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	definitionRaw, _ := json.Marshal(definition)
	scheduleRaw, _ := json.Marshal(schedule)
	var id uuid.UUID
	err = a.DB.QueryRowContext(c, `INSERT INTO agent_workflows (user_id,organization_id,name,description,visibility,definition,schedule,timezone,enabled,next_run_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, principal.UserID, organizationID, name, strings.TrimSpace(stringValue(request.Description)), visibility, definitionRaw, scheduleRaw, timezone, boolValue(request.Enabled, true), nullableTime(nextRun)).Scan(&id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, _, err := a.loadWorkflowForAccess(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"workflow": item})
}

func (a *App) updateAgentWorkflow(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := parseRouteUUID(c, "workflow")
	if err != nil {
		return
	}
	current, ownerID, err := a.loadWorkflowForAccess(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("workflow not found"))
		return
	}
	if err := a.authorizeWorkflowManage(c, ownerID, current.Visibility, principal); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var request agentWorkflowRequest
	if !decodeJSON(c, &request) {
		return
	}
	name := current.Name
	if request.Name != nil {
		name = strings.TrimSpace(*request.Name)
	}
	description := current.Description
	if request.Description != nil {
		description = strings.TrimSpace(*request.Description)
	}
	visibility := current.Visibility
	if request.Visibility != nil {
		visibility = strings.TrimSpace(*request.Visibility)
	}
	if name == "" || visibility != "private" && visibility != "workspace" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid workflow name or visibility"))
		return
	}
	definition := current.Definition
	if len(request.Definition) > 0 {
		definition, err = parseWorkflowDefinition(request.Definition)
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
	}
	timezone := current.Timezone
	if request.Timezone != nil {
		timezone = strings.TrimSpace(*request.Timezone)
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("timezone must be a valid IANA timezone"))
		return
	}
	schedule := current.Schedule
	if len(request.Schedule) > 0 {
		schedule, err = parseWorkflowSchedule(request.Schedule)
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
	}
	nextRun, err := NextAgentScheduleTime(schedule, timezone, time.Now().UTC())
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	enabled := current.Enabled
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	if err := a.validateSharedWorkflowResources(c, definition, visibility, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	definitionRaw, _ := json.Marshal(definition)
	scheduleRaw, _ := json.Marshal(schedule)
	if _, err := a.DB.ExecContext(c, `UPDATE agent_workflows SET name=$2,description=$3,visibility=$4,definition=$5,schedule=$6,timezone=$7,enabled=$8,next_run_at=$9,updated_at=now() WHERE id=$1 AND organization_id=$10`, id, name, description, visibility, definitionRaw, scheduleRaw, timezone, enabled, nullableTime(nextRun), organizationID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, _, err := a.loadWorkflowForAccess(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"workflow": item})
}

func (a *App) deleteAgentWorkflow(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := parseRouteUUID(c, "workflow")
	if err != nil {
		return
	}
	current, ownerID, err := a.loadWorkflowForAccess(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("workflow not found"))
		return
	}
	if err := a.authorizeWorkflowManage(c, ownerID, current.Visibility, principal); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE agent_workflows SET deleted_at=now(),enabled=FALSE,updated_at=now() WHERE id=$1 AND organization_id=$2`, id, organizationID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) validateAgentWorkflow(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := parseRouteUUID(c, "workflow")
	if err != nil {
		return
	}
	item, _, err := a.loadWorkflowForAccess(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("workflow not found"))
		return
	}
	if err := ValidateAgentWorkflowDefinition(item.Definition); err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"valid": false, "error": err.Error()})
		return
	}
	if err := a.validateSharedWorkflowResources(c, item.Definition, item.Visibility, principal.UserID, organizationID); err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"valid": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"valid": true, "nodeCount": len(item.Definition.Nodes), "maxDepth": workflowDepth(item.Definition)})
}

func (a *App) createWorkflowRun(c *gin.Context) {
	if !a.featureEnabled(c, "agents") {
		return
	}
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := parseRouteUUID(c, "workflow")
	if err != nil {
		return
	}
	workflow, _, err := a.loadWorkflowForAccess(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("workflow not found"))
		return
	}
	if err := a.validateSharedWorkflowResources(c, workflow.Definition, workflow.Visibility, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request workflowRunRequest
	if c.Request.ContentLength > 0 && !decodeJSON(c, &request) {
		return
	}
	if request.SourceType == "" {
		request.SourceType = "manual"
	}
	if request.SourceType != "manual" && request.SourceType != "chat" && request.SourceType != "delegation" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid sourceType"))
		return
	}
	rootAgentID := firstWorkflowAgent(workflow.Definition)
	run, err := a.AgentWorker.createRun(agentRunCreateOptions{UserID: principal.UserID, OrganizationID: organizationID, WorkflowID: &workflow.ID, RootAgentID: rootAgentID, SourceType: request.SourceType, Input: request.Input, Definition: workflow.Definition})
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"run": run})
}

func (a *App) listWorkflowRuns(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := parseRouteUUID(c, "workflow")
	if err != nil {
		return
	}
	if _, _, err := a.loadWorkflowForAccess(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("workflow not found"))
		return
	}
	a.listRunsForQuery(c, `WHERE r.workflow_id=$1`, []any{id}, principal.UserID, organizationID)
}

func (a *App) listAgentRuns(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	filters := []string{}
	args := []any{}
	if status := strings.TrimSpace(c.Query("status")); status != "" {
		filters = append(filters, "r.status = $1")
		args = append(args, status)
	}
	where := ""
	if len(filters) > 0 {
		where = " AND " + strings.Join(filters, " AND ")
	}
	a.listRunsForQuery(c, "WHERE 1=1"+where, args, principal.UserID, organizationID)
}

func (a *App) listRunsForQuery(c *gin.Context, clause string, args []any, userID, organizationID uuid.UUID) {
	queryArgs := append([]any{}, args...)
	queryArgs = append(queryArgs, organizationID, userID)
	query := `SELECT r.id,r.workflow_id,r.root_agent_id,r.parent_run_id,r.conversation_id,r.source_type,r.status,r.input,r.summary,r.error,r.started_at,r.finished_at,r.created_at,r.updated_at FROM agent_runs r LEFT JOIN agent_workflows w ON w.id=r.workflow_id ` + clause + ` AND r.organization_id=$` + strconv.Itoa(len(args)+1) + ` AND (r.user_id=$` + strconv.Itoa(len(args)+2) + ` OR w.visibility='workspace') ORDER BY r.created_at DESC LIMIT 100`
	rows, err := a.DB.QueryContext(c, query, queryArgs...)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	items := []models.AgentRun{}
	for rows.Next() {
		item, scanErr := scanAgentRunSummary(rows)
		if scanErr != nil {
			writeError(c, http.StatusInternalServerError, scanErr)
			return
		}
		items = append(items, item)
	}
	c.JSON(http.StatusOK, gin.H{"runs": items})
}

func scanAgentRunSummary(scanner interface{ Scan(...any) error }) (models.AgentRun, error) {
	var item models.AgentRun
	var workflowID, rootAgentID, parentRunID, conversationID sql.NullString
	if err := scanner.Scan(&item.ID, &workflowID, &rootAgentID, &parentRunID, &conversationID, &item.SourceType, &item.Status, &item.Input, &item.Summary, &item.Error, &item.StartedAt, &item.FinishedAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	item.WorkflowID = parseOptionalUUIDString(workflowID.String)
	item.RootAgentID = parseOptionalUUIDString(rootAgentID.String)
	item.ParentRunID = parseOptionalUUIDString(parentRunID.String)
	item.ConversationID = parseOptionalUUIDString(conversationID.String)
	return item, nil
}

func (a *App) getAgentRun(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := parseRouteUUID(c, "run")
	if err != nil {
		return
	}
	if _, err := a.loadVisibleRun(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent run not found"))
		return
	}
	run, err := a.AgentWorker.loadAgentRun(c, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"run": run})
}

func (a *App) streamAgentRunEvents(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := parseRouteUUID(c, "run")
	if err != nil {
		return
	}
	if _, err := a.loadVisibleRun(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent run not found"))
		return
	}
	after, _ := strconv.ParseInt(c.GetHeader("Last-Event-ID"), 10, 64)
	if queryAfter := c.Query("after"); queryAfter != "" {
		after, _ = strconv.ParseInt(queryAfter, 10, 64)
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache, no-transform")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	flusher, _ := c.Writer.(http.Flusher)
	for {
		rows, queryErr := a.DB.QueryContext(c, `SELECT id,run_id,node_id,event_type,payload,created_at FROM agent_run_events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT 100`, id, after)
		if queryErr != nil {
			return
		}
		for rows.Next() {
			var event models.AgentRunEvent
			var nodeID sql.NullString
			if rows.Scan(&event.ID, &event.RunID, &nodeID, &event.EventType, &event.Payload, &event.CreatedAt) != nil {
				rows.Close()
				return
			}
			event.NodeID = parseOptionalUUIDString(nodeID.String)
			payload, _ := json.Marshal(event)
			_, _ = fmt.Fprintf(c.Writer, "id: %d\ndata: %s\n\n", event.ID, payload)
			after = event.ID
		}
		rows.Close()
		if flusher != nil {
			flusher.Flush()
		}
		var status string
		if a.DB.QueryRowContext(c, `SELECT status FROM agent_runs WHERE id=$1`, id).Scan(&status) == nil && (status == "completed" || status == "failed" || status == "cancelled") {
			return
		}
		select {
		case <-c.Request.Context().Done():
			return
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func (a *App) cancelAgentRun(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := parseRouteUUID(c, "run")
	if err != nil {
		return
	}
	if _, err := a.loadVisibleRun(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent run not found"))
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE agent_runs SET cancel_requested=TRUE,status=CASE WHEN status IN ('queued','waiting_approval') THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status IN ('queued','waiting_approval') THEN now() ELSE finished_at END,lease_owner=CASE WHEN status IN ('queued','waiting_approval') THEN NULL ELSE lease_owner END,lease_until=CASE WHEN status IN ('queued','waiting_approval') THEN NULL ELSE lease_until END,updated_at=now() WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	_, _ = a.DB.ExecContext(c, `UPDATE agent_run_nodes SET status='cancelled',finished_at=now(),updated_at=now() WHERE run_id=$1 AND status IN ('pending','waiting_approval')`, id)
	_, _ = a.DB.ExecContext(c, `UPDATE agent_run_approvals SET status='expired',reason='run cancelled',decided_at=now() WHERE run_id=$1 AND status='pending'`, id)
	a.AgentWorker.emitEvent(c, id, nil, "run.cancel_requested", map[string]any{"requestedBy": principal.UserID.String()})
	a.AgentWorker.auditAgentEvent(c, principal.UserID, organizationID, "agent.run.cancel_requested", "agent_run", id, map[string]any{"requestedBy": principal.UserID.String()})
	run, _ := a.AgentWorker.loadAgentRun(c, id)
	c.JSON(http.StatusOK, gin.H{"run": run})
}

func (a *App) retryAgentRun(c *gin.Context) {
	if !a.featureEnabled(c, "agents") {
		return
	}
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := parseRouteUUID(c, "run")
	if err != nil {
		return
	}
	old, err := a.loadVisibleRun(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent run not found"))
		return
	}
	if old.Status != "failed" && old.Status != "cancelled" {
		writeError(c, http.StatusConflict, fmt.Errorf("only failed or cancelled runs can be retried"))
		return
	}
	definition, err := definitionFromSnapshot(old)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	run, err := a.AgentWorker.createRun(agentRunCreateOptions{UserID: old.UserID, OrganizationID: old.OrganizationID, WorkflowID: old.WorkflowID, ParentRunID: &old.ID, ConversationID: old.ConversationID, RootAgentID: old.RootAgentID, SourceType: old.SourceType, Input: old.Input, Definition: definition})
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"run": run})
}

func (a *App) decideAgentApproval(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	runID, err := parseRouteUUID(c, "run")
	if err != nil {
		return
	}
	approvalID, err := uuid.Parse(c.Param("approvalId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid approval id"))
		return
	}
	if _, err := a.loadVisibleRun(c, runID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent run not found"))
		return
	}
	var request agentApprovalDecisionRequest
	if !decodeJSON(c, &request) {
		return
	}
	decision := strings.ToLower(strings.TrimSpace(request.Decision))
	if decision != "approved" && decision != "rejected" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("decision must be approved or rejected"))
		return
	}
	var storedHash, status string
	if err := a.DB.QueryRowContext(c, `SELECT argument_hash,status FROM agent_run_approvals WHERE id=$1 AND run_id=$2`, approvalID, runID).Scan(&storedHash, &status); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("approval not found"))
		return
	}
	if status != "pending" {
		writeError(c, http.StatusConflict, fmt.Errorf("approval is no longer pending"))
		return
	}
	if request.ArgumentHash != "" && request.ArgumentHash != storedHash {
		writeError(c, http.StatusConflict, fmt.Errorf("approval argument hash does not match the requested action"))
		return
	}
	newStatus := decision
	result, err := a.DB.ExecContext(c, `UPDATE agent_run_approvals SET status=$2,reason=$3,decided_by=$4,decided_at=now() WHERE id=$1 AND status='pending' AND expires_at > now()`, approvalID, newStatus, strings.TrimSpace(request.Reason), principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusConflict, fmt.Errorf("approval is expired or no longer pending"))
		return
	}
	var nodeID uuid.UUID
	_ = a.DB.QueryRowContext(c, `SELECT node_id FROM agent_run_approvals WHERE id=$1`, approvalID).Scan(&nodeID)
	if decision == "approved" {
		_, _ = a.DB.ExecContext(c, `UPDATE agent_run_nodes SET status='pending',updated_at=now() WHERE id=$1 AND status='waiting_approval'`, nodeID)
		a.AgentWorker.maybeQueueAgentRun(c, runID)
	} else {
		_, _ = a.DB.ExecContext(c, `UPDATE agent_run_nodes SET status='failed',error='approval rejected',finished_at=now(),updated_at=now() WHERE id=$1 AND status='waiting_approval'`, nodeID)
		_, _ = a.DB.ExecContext(c, `UPDATE agent_runs SET status='failed',error='approval rejected',finished_at=now(),updated_at=now() WHERE id=$1 AND status='waiting_approval'`, runID)
	}
	a.AgentWorker.emitEvent(c, runID, &nodeID, "approval."+decision, map[string]any{"approvalId": approvalID.String(), "argumentHash": storedHash})
	a.AgentWorker.auditAgentEvent(c, principal.UserID, organizationID, "agent.approval."+decision, "agent_run", runID, map[string]any{"approvalId": approvalID.String(), "argumentHash": storedHash})
	run, _ := a.AgentWorker.loadAgentRun(c, runID)
	c.JSON(http.StatusOK, gin.H{"run": run})
}

func (a *App) downloadAgentArtifact(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	runID, err := parseRouteUUID(c, "run")
	if err != nil {
		return
	}
	artifactID, err := uuid.Parse(c.Param("artifactId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid artifact id"))
		return
	}
	if _, err := a.loadVisibleRun(c, runID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent run not found"))
		return
	}
	var name, mime string
	var content []byte
	if err := a.DB.QueryRowContext(c, `SELECT name,mime_type,content FROM agent_run_artifacts WHERE id=$1 AND run_id=$2`, artifactID, runID).Scan(&name, &mime, &content); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("artifact not found"))
		return
	}
	c.Header("Content-Disposition", `attachment; filename="`+safeDownloadName(name)+`"`)
	c.Data(http.StatusOK, mime, content)
}

func parseWorkflowDefinition(raw json.RawMessage) (models.AgentWorkflowDefinition, error) {
	if len(raw) == 0 {
		return models.AgentWorkflowDefinition{}, fmt.Errorf("definition is required")
	}
	var definition models.AgentWorkflowDefinition
	if err := json.Unmarshal(raw, &definition); err != nil {
		return definition, fmt.Errorf("definition must be valid JSON: %w", err)
	}
	if err := ValidateAgentWorkflowDefinition(definition); err != nil {
		return definition, err
	}
	return definition, nil
}

// validateSharedWorkflowResources prevents a workspace-visible workflow from
// becoming a privilege-escalation path through a private agent or a personal
// remote connection. Private workflows are checked by the normal owner/access
// queries when they are loaded and run.
func (a *App) validateSharedWorkflowResources(ctx context.Context, definition models.AgentWorkflowDefinition, visibility string, userID, organizationID uuid.UUID) error {
	if visibility != "workspace" {
		return nil
	}
	for _, node := range definition.Nodes {
		if node.AgentID == nil {
			return fmt.Errorf("workspace workflows must explicitly select an agent for node %q", node.ID)
		}
		if err := a.validateSharedWorkflowAgent(ctx, *node.AgentID, userID, organizationID); err != nil {
			return fmt.Errorf("node %q: %w", node.ID, err)
		}
		for _, delegatedID := range node.DelegationAgentIDs {
			if err := a.validateSharedWorkflowAgent(ctx, delegatedID, userID, organizationID); err != nil {
				return fmt.Errorf("node %q delegation target: %w", node.ID, err)
			}
		}
	}
	return nil
}

func (a *App) validateSharedWorkflowAgent(ctx context.Context, agentID, userID, organizationID uuid.UUID) error {
	var visibility, kind, connectionScope string
	err := a.DB.QueryRowContext(ctx, `
		SELECT a.visibility,a.agent_kind,COALESCE(c.scope_type,'')
		FROM saved_assistants a
		LEFT JOIN agent_connections c ON c.id=a.connection_id
		WHERE a.id=$1 AND a.organization_id=$2 AND a.deleted_at IS NULL
		  AND (a.visibility='workspace' OR a.user_id=$3)`, agentID, organizationID, userID).Scan(&visibility, &kind, &connectionScope)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("agent %s is not accessible", agentID)
		}
		return fmt.Errorf("agent %s could not be checked: %w", agentID, err)
	}
	if visibility != "workspace" {
		return fmt.Errorf("agent %s is private and cannot be used by a workspace workflow", agentID)
	}
	if kind == "remote" && connectionScope == "user" {
		return fmt.Errorf("agent %s uses a personal remote connection and cannot be shared", agentID)
	}
	return nil
}

func parseWorkflowSchedule(raw json.RawMessage) (models.AgentSchedule, error) {
	if len(raw) == 0 {
		return models.AgentSchedule{Kind: "manual"}, nil
	}
	var display string
	if json.Unmarshal(raw, &display) == nil {
		return ParseAgentSchedule(display)
	}
	var schedule models.AgentSchedule
	if err := json.Unmarshal(raw, &schedule); err != nil {
		return schedule, fmt.Errorf("schedule must be an object or legacy schedule string")
	}
	return NormalizeAgentSchedule(schedule)
}

func (a *App) loadWorkflowForAccess(c *gin.Context, id, userID, organizationID uuid.UUID) (models.AgentWorkflow, uuid.UUID, error) {
	var item models.AgentWorkflow
	var ownerID uuid.UUID
	var definitionRaw, scheduleRaw []byte
	err := a.DB.QueryRowContext(c, `SELECT id,user_id,name,description,visibility,definition,schedule,timezone,enabled,last_run_at,next_run_at,created_at,updated_at FROM agent_workflows WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL AND (visibility='workspace' OR user_id=$3)`, id, organizationID, userID).Scan(&item.ID, &ownerID, &item.Name, &item.Description, &item.Visibility, &definitionRaw, &scheduleRaw, &item.Timezone, &item.Enabled, &item.LastRunAt, &item.NextRunAt, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return item, uuid.Nil, err
	}
	if err := json.Unmarshal(definitionRaw, &item.Definition); err != nil {
		return item, ownerID, err
	}
	if err := json.Unmarshal(scheduleRaw, &item.Schedule); err != nil {
		return item, ownerID, err
	}
	return item, ownerID, nil
}

func (a *App) authorizeWorkflowManage(c *gin.Context, ownerID uuid.UUID, visibility string, principal middleware.Principal) error {
	if ownerID == principal.UserID {
		return nil
	}
	role := middleware.GetOrganizationRole(c)
	if visibility == "workspace" && (role == "owner" || role == "admin" || principal.PlatformAdmin) {
		return nil
	}
	return fmt.Errorf("workflow can only be managed by its owner or a workspace administrator")
}

func (a *App) loadVisibleRun(c *gin.Context, id, userID, organizationID uuid.UUID) (models.AgentRun, error) {
	var run models.AgentRun
	var workflowID, rootAgentID, parentRunID, conversationID sql.NullString
	err := a.DB.QueryRowContext(c, `SELECT r.id,r.user_id,r.organization_id,r.workflow_id,r.root_agent_id,r.parent_run_id,r.conversation_id,r.source_type,r.status,r.input,r.summary,r.error,r.started_at,r.finished_at,r.created_at,r.updated_at FROM agent_runs r LEFT JOIN agent_workflows w ON w.id=r.workflow_id WHERE r.id=$1 AND r.organization_id=$2 AND (r.user_id=$3 OR w.visibility='workspace')`, id, organizationID, userID).Scan(&run.ID, &run.UserID, &run.OrganizationID, &workflowID, &rootAgentID, &parentRunID, &conversationID, &run.SourceType, &run.Status, &run.Input, &run.Summary, &run.Error, &run.StartedAt, &run.FinishedAt, &run.CreatedAt, &run.UpdatedAt)
	if err != nil {
		return run, err
	}
	run.WorkflowID = parseOptionalUUIDString(workflowID.String)
	run.RootAgentID = parseOptionalUUIDString(rootAgentID.String)
	run.ParentRunID = parseOptionalUUIDString(parentRunID.String)
	run.ConversationID = parseOptionalUUIDString(conversationID.String)
	// Reload through the engine to attach nodes, approvals, artifacts, and the
	// immutable definition snapshot used by retry.
	return a.AgentWorker.loadAgentRun(c, id)
}

func parseRouteUUID(c *gin.Context, kind string) (uuid.UUID, error) {
	raw := c.Param("id")
	id, err := uuid.Parse(raw)
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid %s id", kind))
	}
	return id, err
}

func firstWorkflowAgent(definition models.AgentWorkflowDefinition) *uuid.UUID {
	for _, node := range definition.Nodes {
		if node.AgentID != nil {
			copy := *node.AgentID
			return &copy
		}
	}
	return nil
}

func workflowDepth(definition models.AgentWorkflowDefinition) int {
	depth := map[string]int{}
	for _, node := range definition.Nodes {
		depth[node.ID] = 1
	}
	for changed := true; changed; {
		changed = false
		for _, edge := range definition.Edges {
			if depth[edge.To] < depth[edge.From]+1 {
				depth[edge.To] = depth[edge.From] + 1
				changed = true
			}
		}
		if len(depth) > maxAgentWorkflowDepth+maxAgentWorkflowNodes {
			break
		}
	}
	maximum := 0
	for _, value := range depth {
		if value > maximum {
			maximum = value
		}
	}
	return maximum
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}

func safeDownloadName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "artifact"
	}
	value = strings.NewReplacer("/", "_", "\\", "_", "\"", "_", "\r", "_", "\n", "_").Replace(value)
	if len([]rune(value)) > 120 {
		value = string([]rune(value)[:120])
	}
	return value
}
