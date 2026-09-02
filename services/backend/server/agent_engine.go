package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

const (
	queuedRunLease  = 2 * time.Minute
	workerTick      = time.Second
	maxRunInputSize = 512 * 1024
)

// AgentEngine is the shared execution boundary for manual, scheduled, and
// conversational runs. It intentionally contains no HTTP state, so handlers
// and the worker use exactly the same snapshot/lease/executor path.
type AgentEngine struct {
	app      *App
	workerID string
	start    sync.Once
	oauth    sync.Map
}

type agentExecutionRequest struct {
	UserID          uuid.UUID
	OrganizationID  uuid.UUID
	ConversationID  *uuid.UUID
	RunID           uuid.UUID
	NodeID          uuid.UUID
	Agent           models.Agent
	Instruction     string
	Input           json.RawMessage
	Scope           models.AgentContextScope
	ApprovalGranted bool
	OnProgress      func(string) error
}

type agentExecutionResult struct {
	Summary      string
	ProviderTask string
	Artifacts    []a2aArtifact
}

type agentApprovalRequiredError struct{}

func (*agentApprovalRequiredError) Error() string {
	return "agent execution is waiting for approval"
}

// AgentExecutor is the common execution seam for native and remote agents.
// The workflow engine owns leasing, retries, approvals, snapshots, and event
// persistence; adapters only translate one bounded node into provider work.
type AgentExecutor interface {
	Execute(context.Context, agentExecutionRequest) (agentExecutionResult, error)
}

type nativeAgentExecutor struct{ engine *AgentEngine }
type a2aAgentExecutor struct{ engine *AgentEngine }

type agentRunCreateOptions struct {
	UserID         uuid.UUID
	OrganizationID uuid.UUID
	WorkflowID     *uuid.UUID
	ParentRunID    *uuid.UUID
	ConversationID *uuid.UUID
	RootAgentID    *uuid.UUID
	SourceType     string
	Input          json.RawMessage
	Definition     models.AgentWorkflowDefinition
	ScheduledFor   *time.Time
}

type agentSnapshot struct {
	Definition models.AgentWorkflowDefinition `json:"definition"`
	Agents     map[string]map[string]any      `json:"agents"`
}

func NewAgentEngine(app *App) *AgentEngine {
	return &AgentEngine{app: app, workerID: "agent-worker-" + uuid.NewString()}
}

func (a *App) StartAgentWorker(ctx context.Context) {
	if a.AgentWorker == nil {
		a.AgentWorker = NewAgentEngine(a)
	}
	a.AgentWorker.Start(ctx)
}

func (e *AgentEngine) Start(ctx context.Context) {
	if e == nil || e.app == nil {
		return
	}
	e.start.Do(func() {
		go e.workerLoop(ctx)
	})
}

func (e *AgentEngine) workerLoop(ctx context.Context) {
	ticker := time.NewTicker(workerTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !e.app.platformCapabilityEnabled(ctx, "agents") {
				continue
			}
			e.recoverAgentLeases(ctx)
			e.expireAgentApprovals(ctx)
			e.scheduleAgentWorkflows(ctx)
			for index := 0; index < 4; index++ {
				runID, claimed, err := e.claimAgentRun(ctx)
				if err != nil {
					slog.Warn("agent run claim failed", "error", err)
					break
				}
				if !claimed {
					break
				}
				go e.executeRun(ctx, runID)
			}
		}
	}
}

func (e *AgentEngine) recoverAgentLeases(ctx context.Context) {
	_, _ = e.app.DB.ExecContext(ctx, `
		UPDATE agent_runs
		SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = now()
		WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < now()`)
	_, _ = e.app.DB.ExecContext(ctx, `
		UPDATE agent_run_nodes n
		SET status = 'pending', updated_at = now()
		FROM agent_runs r
		WHERE n.run_id = r.id AND n.status = 'running'
		  AND r.status = 'queued'`)
}

func (e *AgentEngine) expireAgentApprovals(ctx context.Context) {
	rows, err := e.app.DB.QueryContext(ctx, `
		SELECT id, run_id, node_id FROM agent_run_approvals
		WHERE status = 'pending' AND expires_at <= now()
		LIMIT 100`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var approvalID, runID, nodeID uuid.UUID
		if rows.Scan(&approvalID, &runID, &nodeID) != nil {
			continue
		}
		_, _ = e.app.DB.ExecContext(ctx, `UPDATE agent_run_approvals SET status = 'expired', reason = 'approval expired', decided_at = now() WHERE id = $1 AND status = 'pending'`, approvalID)
		_, _ = e.app.DB.ExecContext(ctx, `UPDATE agent_run_nodes SET status = 'failed', error = 'approval expired', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'waiting_approval'`, nodeID)
		_, _ = e.app.DB.ExecContext(ctx, `UPDATE agent_runs SET status = 'failed', error = 'approval expired', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'waiting_approval'`, runID)
		e.emitEvent(ctx, runID, &nodeID, "approval.expired", map[string]any{"approvalId": approvalID.String()})
	}
}

func (e *AgentEngine) scheduleAgentWorkflows(ctx context.Context) {
	rows, err := e.app.DB.QueryContext(ctx, `
		SELECT id, user_id, organization_id, name, definition, schedule, timezone, next_run_at, legacy_automation_id
		FROM agent_workflows
		WHERE deleted_at IS NULL AND enabled = TRUE
		  AND (next_run_at IS NULL OR next_run_at <= now())
		  AND COALESCE(schedule->>'kind', 'manual') <> 'manual'
		ORDER BY next_run_at NULLS FIRST
		LIMIT 20`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var workflowID, userID, organizationID uuid.UUID
		var name string
		var definitionRaw, scheduleRaw []byte
		var nextRun sql.NullTime
		var legacyAutomationID sql.NullString
		var timezone string
		if rows.Scan(&workflowID, &userID, &organizationID, &name, &definitionRaw, &scheduleRaw, &timezone, &nextRun, &legacyAutomationID) != nil {
			continue
		}
		var definition models.AgentWorkflowDefinition
		if json.Unmarshal(definitionRaw, &definition) != nil || ValidateAgentWorkflowDefinition(definition) != nil {
			continue
		}
		var schedule models.AgentSchedule
		if json.Unmarshal(scheduleRaw, &schedule) != nil {
			continue
		}
		if schedule.Kind == "legacy" {
			schedule, _ = NormalizeAgentSchedule(schedule)
		}
		now := time.Now().UTC()
		if !nextRun.Valid {
			next, scheduleErr := NextAgentScheduleTime(schedule, timezone, now)
			if scheduleErr == nil && !next.IsZero() {
				_, _ = e.app.DB.ExecContext(ctx, `UPDATE agent_workflows SET next_run_at = $2, updated_at = now() WHERE id = $1 AND next_run_at IS NULL`, workflowID, next)
				e.syncLegacyScheduleCursor(ctx, legacyAutomationID, time.Time{}, next)
			}
			continue
		}
		// next_run_at is the durable cursor for the occurrence to enqueue. Do
		// not call NextAgentScheduleTime on that value before creating the run:
		// doing so skips an occurrence that is already due and can leave the
		// cursor permanently stuck in the past.
		due := nextRun.Time.UTC()
		if due.After(now) {
			continue
		}
		// The row's scheduled_for timestamp is the idempotency key. A second
		// worker may calculate the same occurrence, but the partial unique index
		// makes it impossible to enqueue duplicate work.
		createdRun, createErr := e.createRun(agentRunCreateOptions{
			UserID: userID, OrganizationID: organizationID, WorkflowID: &workflowID,
			SourceType: "schedule", Input: json.RawMessage(`{}`), Definition: definition,
			ScheduledFor: &due,
		})
		if createErr == nil || errors.Is(createErr, errAgentRunScheduleDuplicate) {
			next, nextErr := NextAgentScheduleTime(schedule, timezone, due)
			if nextErr == nil {
				_, _ = e.app.DB.ExecContext(ctx, `UPDATE agent_workflows SET last_run_at = $2, next_run_at = $3, updated_at = now() WHERE id = $1`, workflowID, due, next)
				e.syncLegacyScheduleCursor(ctx, legacyAutomationID, due, next)
				if errors.Is(createErr, errAgentRunScheduleDuplicate) {
					_ = e.app.DB.QueryRowContext(ctx, `SELECT id FROM agent_runs WHERE workflow_id=$1 AND scheduled_for=$2 ORDER BY created_at DESC LIMIT 1`, workflowID, due).Scan(&createdRun.ID)
				}
				if createdRun.ID != uuid.Nil {
					e.syncLegacyScheduledRun(ctx, legacyAutomationID, createdRun.ID)
				}
			}
		}
		_ = name
	}
}

func (e *AgentEngine) syncLegacyScheduleCursor(ctx context.Context, legacyAutomationID sql.NullString, lastRunAt, nextRunAt time.Time) {
	if !legacyAutomationID.Valid {
		return
	}
	automationID, err := uuid.Parse(legacyAutomationID.String)
	if err != nil {
		return
	}
	if lastRunAt.IsZero() {
		_, _ = e.app.DB.ExecContext(ctx, `UPDATE automations SET next_run_at=$2,updated_at=now() WHERE id=$1`, automationID, nextRunAt)
		return
	}
	_, _ = e.app.DB.ExecContext(ctx, `UPDATE automations SET last_run_at=$2,next_run_at=$3,updated_at=now() WHERE id=$1`, automationID, lastRunAt, nextRunAt)
}

func (e *AgentEngine) syncLegacyScheduledRun(ctx context.Context, legacyAutomationID sql.NullString, agentRunID uuid.UUID) {
	if !legacyAutomationID.Valid || agentRunID == uuid.Nil {
		return
	}
	automationID, err := uuid.Parse(legacyAutomationID.String)
	if err != nil {
		return
	}
	_, _ = e.app.DB.ExecContext(ctx, `
		INSERT INTO automation_runs (automation_id,agent_run_id,status,summary)
		SELECT $1,$2,'queued','Run queued in the agent execution engine.'
		WHERE NOT EXISTS (SELECT 1 FROM automation_runs WHERE agent_run_id=$2)`, automationID, agentRunID)
}

var errAgentRunScheduleDuplicate = errors.New("scheduled agent run already exists")

func (e *AgentEngine) claimAgentRun(ctx context.Context) (uuid.UUID, bool, error) {
	transaction, err := e.app.DB.BeginTx(ctx, nil)
	if err != nil {
		return uuid.Nil, false, err
	}
	defer transaction.Rollback()
	var runID uuid.UUID
	err = transaction.QueryRowContext(ctx, `
		SELECT id FROM agent_runs
		WHERE status = 'queued' AND (next_wake_at IS NULL OR next_wake_at <= now())
		ORDER BY created_at
		FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&runID)
	if errors.Is(err, sql.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE agent_runs SET status = 'running', lease_owner = $2, lease_until = now() + interval '2 minutes', updated_at = now() WHERE id = $1`, runID, e.workerID); err != nil {
		return uuid.Nil, false, err
	}
	if err := transaction.Commit(); err != nil {
		return uuid.Nil, false, err
	}
	e.emitEvent(ctx, runID, nil, "run.started", map[string]any{"workerId": e.workerID})
	return runID, true, nil
}

func (e *AgentEngine) createRun(options agentRunCreateOptions) (models.AgentRun, error) {
	if options.SourceType == "" {
		options.SourceType = "manual"
	}
	switch options.SourceType {
	case "manual", "schedule", "chat", "delegation":
	default:
		return models.AgentRun{}, fmt.Errorf("invalid agent run source type")
	}
	resolvedDefinition, err := e.resolveWorkflowAgents(options.Definition, options.UserID, options.OrganizationID)
	if err != nil {
		return models.AgentRun{}, err
	}
	options.Definition = resolvedDefinition
	if err := ValidateAgentWorkflowDefinition(options.Definition); err != nil {
		return models.AgentRun{}, err
	}
	sharedWorkflow := false
	if options.WorkflowID != nil {
		var visibility string
		if err := e.app.DB.QueryRowContext(context.Background(), `SELECT visibility FROM agent_workflows WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, *options.WorkflowID, options.OrganizationID).Scan(&visibility); err != nil {
			return models.AgentRun{}, fmt.Errorf("workflow could not be loaded: %w", err)
		}
		if err := e.app.validateSharedWorkflowResources(context.Background(), options.Definition, visibility, options.UserID, options.OrganizationID); err != nil {
			return models.AgentRun{}, err
		}
		sharedWorkflow = visibility == "workspace"
	}
	if err := e.validateAgentWorkflowContext(context.Background(), options.Definition, options.UserID, options.OrganizationID, options.ConversationID, sharedWorkflow); err != nil {
		return models.AgentRun{}, err
	}
	input := options.Input
	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
	if len(input) > maxRunInputSize || !json.Valid(input) {
		return models.AgentRun{}, fmt.Errorf("run input must be valid JSON under %d bytes", maxRunInputSize)
	}
	snapshot, err := e.buildAgentSnapshot(options.Definition, options.UserID, options.OrganizationID)
	if err != nil {
		return models.AgentRun{}, err
	}
	definitionSnapshot, err := json.Marshal(snapshot)
	if err != nil {
		return models.AgentRun{}, err
	}
	contextSnapshot, _ := json.Marshal(map[string]any{"version": 1, "scopes": agentWorkflowScopes(options.Definition)})
	transaction, err := e.app.DB.Begin()
	if err != nil {
		return models.AgentRun{}, err
	}
	defer transaction.Rollback()
	var runID uuid.UUID
	err = transaction.QueryRow(`
		INSERT INTO agent_runs
			(user_id, organization_id, workflow_id, root_agent_id, parent_run_id,
			 conversation_id, source_type, input, definition_snapshot, context_snapshot,
			 scheduled_for)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		RETURNING id`, options.UserID, options.OrganizationID, options.WorkflowID,
		options.RootAgentID, options.ParentRunID, options.ConversationID, options.SourceType,
		input, definitionSnapshot, contextSnapshot, options.ScheduledFor).Scan(&runID)
	if err != nil {
		if options.ScheduledFor != nil && strings.Contains(strings.ToLower(err.Error()), "agent_runs_schedule_dedupe") {
			return models.AgentRun{}, errAgentRunScheduleDuplicate
		}
		return models.AgentRun{}, err
	}
	for _, node := range options.Definition.Nodes {
		var versionID any
		if node.AgentID != nil {
			var id uuid.UUID
			if scanErr := transaction.QueryRow(`SELECT v.id FROM saved_assistants a JOIN saved_assistant_versions v ON v.assistant_id = a.id AND v.version = a.current_version WHERE a.id = $1 AND a.organization_id = $2 AND a.deleted_at IS NULL`, *node.AgentID, options.OrganizationID).Scan(&id); scanErr == nil {
				versionID = id
			}
		}
		definition, _ := json.Marshal(node)
		if _, err := transaction.Exec(`INSERT INTO agent_run_nodes (run_id,node_key,agent_id,agent_version_id,definition) VALUES ($1,$2,$3,$4,$5)`, runID, node.ID, node.AgentID, versionID, definition); err != nil {
			return models.AgentRun{}, err
		}
	}
	if err := transaction.Commit(); err != nil {
		if options.ScheduledFor != nil && strings.Contains(strings.ToLower(err.Error()), "agent_runs_schedule_dedupe") {
			return models.AgentRun{}, errAgentRunScheduleDuplicate
		}
		return models.AgentRun{}, err
	}
	e.emitEvent(context.Background(), runID, nil, "run.created", map[string]any{"sourceType": options.SourceType})
	e.auditAgentEvent(context.Background(), options.UserID, options.OrganizationID, "agent.run.created", "agent_run", runID, map[string]any{"sourceType": options.SourceType, "workflowId": options.WorkflowID})
	return e.loadAgentRun(context.Background(), runID)
}

func (e *AgentEngine) resolveWorkflowAgents(definition models.AgentWorkflowDefinition, userID, organizationID uuid.UUID) (models.AgentWorkflowDefinition, error) {
	for index := range definition.Nodes {
		if definition.Nodes[index].AgentID != nil {
			continue
		}
		agentID, err := e.defaultAgentID(context.Background(), userID, organizationID)
		if err != nil || agentID == nil {
			return definition, fmt.Errorf("workflow node %q has no agent and no default native agent is available", definition.Nodes[index].ID)
		}
		definition.Nodes[index].AgentID = agentID
	}
	return definition, nil
}

func (e *AgentEngine) buildAgentSnapshot(definition models.AgentWorkflowDefinition, userID, organizationID uuid.UUID) (agentSnapshot, error) {
	snapshot := agentSnapshot{Definition: definition, Agents: map[string]map[string]any{}}
	for _, node := range definition.Nodes {
		if node.AgentID == nil {
			continue
		}
		agent, err := e.loadAgent(context.Background(), *node.AgentID, userID, organizationID, nil)
		if err != nil {
			return agentSnapshot{}, fmt.Errorf("agent for node %q could not be loaded: %w", node.ID, err)
		}
		value := map[string]any{"id": agent.ID.String(), "kind": agent.Kind, "name": agent.Name}
		if agent.VersionID != nil {
			value["versionId"] = agent.VersionID.String()
		}
		if agent.ConnectionID != nil {
			value["connectionId"] = agent.ConnectionID.String()
		}
		snapshot.Agents[node.ID] = value
	}
	return snapshot, nil
}

func agentWorkflowScopes(definition models.AgentWorkflowDefinition) map[string]models.AgentContextScope {
	scopes := map[string]models.AgentContextScope{}
	for _, node := range definition.Nodes {
		scopes[node.ID] = node.Context
	}
	return scopes
}

func (e *AgentEngine) executeRun(ctx context.Context, runID uuid.UUID) {
	run, err := e.loadAgentRun(ctx, runID)
	if err != nil {
		e.failRun(context.WithoutCancel(ctx), runID, err)
		return
	}
	persistContext := context.WithoutCancel(ctx)
	leaseContext, stopLease := context.WithCancel(ctx)
	defer stopLease()
	go e.refreshAgentLease(leaseContext, runID)
	deadline := run.StartedAt.Add(maxAgentRunTimeout)
	runContext, stopRun := context.WithDeadline(ctx, deadline)
	defer stopRun()
	for {
		if err := runContext.Err(); err != nil {
			e.failRun(persistContext, runID, fmt.Errorf("agent run exceeded the %s timeout", maxAgentRunTimeout))
			return
		}
		if e.runCancelRequested(runContext, runID) {
			e.cancelRun(persistContext, runID)
			return
		}
		current, err := e.loadAgentRun(runContext, runID)
		if err != nil {
			e.failRun(persistContext, runID, err)
			return
		}
		if current.Status == "waiting_approval" {
			return
		}
		if current.Status == "cancelled" || current.Status == "failed" || current.Status == "completed" {
			return
		}
		definition, err := definitionFromSnapshot(current)
		if err != nil {
			e.failRun(persistContext, runID, err)
			return
		}
		if hasFailedAgentNode(current.Nodes) {
			e.failRun(persistContext, runID, fmt.Errorf("one or more agent nodes failed"))
			return
		}
		if allAgentNodesFinished(current.Nodes) {
			summary := finalAgentRunSummary(current.Nodes)
			e.completeRun(persistContext, runID, summary)
			return
		}
		ready := readyAgentNodes(definition, current.Nodes)
		if len(ready) == 0 {
			e.failRun(persistContext, runID, fmt.Errorf("workflow has no executable nodes remaining"))
			return
		}
		if len(ready) > maxAgentWorkflowFanout {
			ready = ready[:maxAgentWorkflowFanout]
		}
		var wait sync.WaitGroup
		for _, node := range ready {
			node := node
			wait.Add(1)
			go func() {
				defer wait.Done()
				if err := e.executeNode(runContext, current, definition, node); err != nil {
					slog.Warn("agent node execution failed", "runId", runID, "node", node.ID, "error", err)
				}
			}()
		}
		wait.Wait()
	}
}

// executeDirectRun claims a newly-created conversational/delegation run before
// entering the common executor. Worker-claimed runs are executed only by the
// worker goroutine; keeping the claim at the boundary prevents the two paths
// from executing the same provider request concurrently.
func (e *AgentEngine) executeDirectRun(ctx context.Context, runID uuid.UUID) {
	if e.claimDirectAgentRun(ctx, runID) {
		e.executeRun(ctx, runID)
	}
}

// claimDirectAgentRun closes the small race between a handler starting a
// conversational run and the background worker claiming the same queued row.
// Worker-claimed rows already carry this engine's lease and pass through
// unchanged; a row leased by another worker is left alone for that worker.
func (e *AgentEngine) claimDirectAgentRun(ctx context.Context, runID uuid.UUID) bool {
	result, err := e.app.DB.ExecContext(ctx, `
		UPDATE agent_runs
		SET status='running', lease_owner=$2, lease_until=now() + interval '2 minutes', updated_at=now()
		WHERE id=$1 AND status='queued' AND cancel_requested=FALSE`, runID, e.workerID)
	if err == nil {
		if affected, rowsErr := result.RowsAffected(); rowsErr == nil && affected > 0 {
			e.emitEvent(ctx, runID, nil, "run.started", map[string]any{"workerId": e.workerID})
			return true
		}
	}
	var status, owner string
	if err := e.app.DB.QueryRowContext(ctx, `SELECT status,COALESCE(lease_owner,'') FROM agent_runs WHERE id=$1`, runID).Scan(&status, &owner); err != nil {
		return false
	}
	if status == "running" && (owner == "" || owner == e.workerID) {
		return true
	}
	return false
}

func (e *AgentEngine) refreshAgentLease(ctx context.Context, runID uuid.UUID) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = e.app.DB.ExecContext(ctx, `UPDATE agent_runs SET lease_until=now() + interval '2 minutes', updated_at=now() WHERE id=$1 AND status='running' AND (lease_owner=$2 OR lease_owner IS NULL)`, runID, e.workerID)
		}
	}
}

func definitionFromSnapshot(run models.AgentRun) (models.AgentWorkflowDefinition, error) {
	var snapshot agentSnapshot
	if err := json.Unmarshal(run.DefinitionSnapshot, &snapshot); err == nil && len(snapshot.Definition.Nodes) > 0 {
		return snapshot.Definition, nil
	}
	var definition models.AgentWorkflowDefinition
	if err := json.Unmarshal(run.DefinitionSnapshot, &definition); err != nil {
		return definition, fmt.Errorf("invalid run definition snapshot")
	}
	return definition, nil
}

func readyAgentNodes(definition models.AgentWorkflowDefinition, nodes []models.AgentRunNode) []models.AgentWorkflowNode {
	state := map[string]string{}
	for _, node := range nodes {
		state[node.NodeKey] = node.Status
	}
	ready := []models.AgentWorkflowNode{}
	for _, node := range definition.Nodes {
		if state[node.ID] != "pending" {
			continue
		}
		blocked := false
		for _, edge := range definition.Edges {
			if edge.To == node.ID && state[edge.From] != "completed" && state[edge.From] != "skipped" {
				blocked = true
				break
			}
		}
		if !blocked {
			ready = append(ready, node)
		}
	}
	return ready
}

func hasFailedAgentNode(nodes []models.AgentRunNode) bool {
	for _, node := range nodes {
		if node.Status == "failed" || node.Status == "cancelled" {
			return true
		}
	}
	return false
}

func allAgentNodesFinished(nodes []models.AgentRunNode) bool {
	if len(nodes) == 0 {
		return false
	}
	for _, node := range nodes {
		if node.Status != "completed" && node.Status != "skipped" {
			return false
		}
	}
	return true
}

func finalAgentRunSummary(nodes []models.AgentRunNode) string {
	for index := len(nodes) - 1; index >= 0; index-- {
		if nodes[index].Status == "completed" {
			var value struct {
				Summary string `json:"summary"`
			}
			if json.Unmarshal(nodes[index].Output, &value) == nil && strings.TrimSpace(value.Summary) != "" {
				return value.Summary
			}
		}
	}
	return "Agent workflow completed."
}

func (e *AgentEngine) executeNode(ctx context.Context, run models.AgentRun, definition models.AgentWorkflowDefinition, node models.AgentWorkflowNode) error {
	runNode, err := findAgentRunNode(run.Nodes, node.ID)
	if err != nil {
		return err
	}
	input := nodeInput(run, definition, node)
	action := map[string]any{"type": "agent.execute", "agentId": node.AgentID, "nodeId": node.ID, "input": input}
	actionHash := agentArgumentHash(action)
	approvalGranted := e.approvalGranted(ctx, run.ID, runNode.ID, actionHash)
	if !approvalGranted && e.nodeNeedsApproval(ctx, run, node) {
		approvalID, active, createErr := e.requestAgentApproval(ctx, run.ID, runNode.ID, action, actionHash)
		if createErr != nil {
			return createErr
		}
		if !active {
			return nil
		}
		e.emitEvent(ctx, run.ID, &runNode.ID, "approval.requested", map[string]any{"approvalId": approvalID.String(), "actionType": "agent.execute", "argumentHash": actionHash})
		return nil
	}
	claim, err := e.app.DB.ExecContext(ctx, `UPDATE agent_run_nodes SET status = 'running', attempt = attempt + 1, input = $2, started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND status = 'pending'`, runNode.ID, input)
	if err != nil {
		return err
	}
	if affected, rowsErr := claim.RowsAffected(); rowsErr != nil || affected == 0 {
		// A concurrent cancellation or lease recovery already moved this node.
		// Do not start a second provider request for the same durable attempt.
		return nil
	}
	e.emitEvent(ctx, run.ID, &runNode.ID, "node.started", map[string]any{"nodeKey": node.ID})
	attempt := runNode.Attempt + 1
	maxAttempts := node.Retry.MaxAttempts
	if maxAttempts == 0 {
		maxAttempts = maxAgentAttempts
	}
	timeout := time.Duration(node.TimeoutSeconds) * time.Second
	if timeout <= 0 || timeout > maxAgentNodeTimeout {
		timeout = maxAgentNodeTimeout
	}
	operationContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stopCancellationWatch := make(chan struct{})
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopCancellationWatch:
				return
			case <-operationContext.Done():
				return
			case <-ticker.C:
				if e.runCancelRequested(ctx, run.ID) {
					cancel()
					return
				}
			}
		}
	}()
	defer close(stopCancellationWatch)
	agentID := node.AgentID
	if agentID == nil {
		agentID, err = e.defaultAgentID(operationContext, run.UserID, run.OrganizationID)
		if err != nil {
			return e.nodeFailure(ctx, run.ID, runNode.ID, attempt, maxAttempts, err)
		}
	}
	agent, err := e.loadAgent(operationContext, *agentID, run.UserID, run.OrganizationID, runNode.AgentVersionID)
	if err != nil {
		return e.nodeFailure(ctx, run.ID, runNode.ID, attempt, maxAttempts, err)
	}
	result, err := e.executeAgent(operationContext, agentExecutionRequest{UserID: run.UserID, OrganizationID: run.OrganizationID, ConversationID: run.ConversationID, RunID: run.ID, NodeID: runNode.ID, Agent: agent, Instruction: node.Instruction, Input: input, Scope: node.Context, ApprovalGranted: approvalGranted, OnProgress: func(delta string) error {
		e.emitEvent(ctx, run.ID, &runNode.ID, "node.progress", map[string]any{"nodeKey": node.ID, "delta": truncateAgentText(delta, 4000)})
		return nil
	}})
	if err != nil {
		var approvalRequired *agentApprovalRequiredError
		if errors.As(err, &approvalRequired) {
			return nil
		}
		return e.nodeFailure(ctx, run.ID, runNode.ID, attempt, maxAttempts, err)
	}
	output := map[string]any{"summary": result.Summary}
	if result.ProviderTask != "" {
		output["providerTaskId"] = result.ProviderTask
	}
	encodedOutput, _ := json.Marshal(output)
	completed, err := e.app.DB.ExecContext(ctx, `UPDATE agent_run_nodes SET status = 'completed', output = $2, error = '', provider_task_id = $3, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'`, runNode.ID, encodedOutput, result.ProviderTask)
	if err != nil {
		return err
	}
	if affected, rowsErr := completed.RowsAffected(); rowsErr != nil || affected == 0 {
		// Cancellation wins over a late provider response.
		return nil
	}
	for _, artifact := range result.Artifacts {
		if err := e.storeAgentArtifact(ctx, run.ID, &runNode.ID, artifact); err != nil {
			return err
		}
	}
	e.emitEvent(ctx, run.ID, &runNode.ID, "node.completed", map[string]any{"nodeKey": node.ID, "summary": truncateAgentText(result.Summary, 4000)})
	e.maybeQueueAgentRun(ctx, run.ID)
	return nil
}

func (e *AgentEngine) nodeNeedsApproval(ctx context.Context, run models.AgentRun, node models.AgentWorkflowNode) bool {
	mode := strings.ToLower(strings.TrimSpace(node.ApprovalMode))
	if mode == "review" || mode == "" {
		return true
	}
	if mode != "read_only_auto" || node.AgentID == nil {
		return mode == "read_only_auto"
	}
	agent, err := e.loadAgent(ctx, *node.AgentID, run.UserID, run.OrganizationID, nil)
	if err != nil {
		return true
	}
	if agent.Kind == "native" {
		// Native model execution is side-effect free until it asks for an MCP
		// operation. The tool loop creates an exact, argument-hashed approval
		// for write-capable or unclassified tools at the point of use.
		return false
	}
	if agent.ConnectionID == nil {
		return true
	}
	connection, err := e.app.loadRemoteAgentConnection(ctx, *agent.ConnectionID, run.UserID, run.OrganizationID)
	return err != nil || !connection.TrustedReadOnly
}

func (e *AgentEngine) executeAgent(ctx context.Context, request agentExecutionRequest) (agentExecutionResult, error) {
	if request.Agent.Kind == "remote" {
		return (&a2aAgentExecutor{engine: e}).Execute(ctx, request)
	}
	return (&nativeAgentExecutor{engine: e}).Execute(ctx, request)
}

func (executor *a2aAgentExecutor) Execute(ctx context.Context, request agentExecutionRequest) (agentExecutionResult, error) {
	if request.Agent.ConnectionID == nil {
		return agentExecutionResult{}, fmt.Errorf("remote agent has no connection")
	}
	connection, err := executor.engine.app.loadRemoteAgentConnection(ctx, *request.Agent.ConnectionID, request.UserID, request.OrganizationID)
	if err != nil {
		return agentExecutionResult{}, err
	}
	message := request.Instruction + "\n\nSelected input (do not request JustAI credentials):\n" + string(request.Input)
	if contextPrompt, contextErr := executor.engine.agentWorkflowContextPrompt(ctx, request.UserID, request.OrganizationID, request.Scope, false, request.Agent.DeepContext); contextErr != nil {
		return agentExecutionResult{}, contextErr
	} else if strings.TrimSpace(contextPrompt) != "" {
		message += "\n\n" + contextPrompt
	}
	result, err := executor.engine.app.executeA2A(ctx, connection, message, request.OnProgress)
	if err != nil {
		return agentExecutionResult{}, err
	}
	return agentExecutionResult{Summary: firstNonEmptyString(result.Summary, "Remote agent completed the task."), ProviderTask: result.TaskID, Artifacts: result.Artifacts}, nil
}

func (executor *nativeAgentExecutor) Execute(ctx context.Context, request agentExecutionRequest) (agentExecutionResult, error) {
	e := executor.engine
	endpointID := request.Agent.EndpointID
	if endpointID == nil {
		endpointID, _ = e.defaultEndpointID(ctx, request.UserID, request.OrganizationID)
	}
	if endpointID == nil {
		return agentExecutionResult{}, fmt.Errorf("native agent has no available chat endpoint")
	}
	endpoint, err := e.app.providerEndpoint(ctx, *endpointID)
	if err != nil {
		return agentExecutionResult{}, err
	}
	input := string(request.Input)
	if len(input) > maxRunInputSize {
		input = input[:maxRunInputSize]
	}
	prompt := strings.TrimSpace(request.Instruction) + "\n\nStructured input:\n" + input
	contextPrompt, err := e.agentWorkflowContextPrompt(ctx, request.UserID, request.OrganizationID, request.Scope, request.Agent.UseMemory, request.Agent.DeepContext)
	if err != nil {
		return agentExecutionResult{}, err
	}
	history := []provider.ToolMessage{}
	if instructions := savedAssistantInstructions(&models.SavedAssistant{ID: request.Agent.ID, Name: request.Agent.Name, Instructions: request.Agent.Instructions}); instructions != "" {
		history = append(history, provider.ToolMessage{Role: "system", Content: instructions})
	}
	if strings.TrimSpace(contextPrompt) != "" {
		history = append(history, provider.ToolMessage{Role: "system", Content: contextPrompt})
	}
	history = append(history, provider.ToolMessage{Role: "user", Content: prompt})
	definitions, bindings, err := e.discoverNativeMCPTools(ctx, request.UserID, request.OrganizationID, request.Scope)
	if err != nil {
		return agentExecutionResult{}, err
	}
	if len(definitions) > 0 && provider.SupportsToolCalling(endpoint) {
		result, loopErr := e.nativeAgentToolLoop(ctx, request, endpoint, history, definitions, bindings)
		if loopErr != nil {
			return agentExecutionResult{}, loopErr
		}
		return result, nil
	}
	plainHistory := make([]provider.Message, 0, len(history))
	for _, message := range history {
		plainHistory = append(plainHistory, provider.Message{Role: message.Role, Content: message.Content, ContentParts: message.ContentParts})
	}
	var response strings.Builder
	err = provider.StreamChat(ctx, endpoint, provider.ChatOptions{Messages: plainHistory, Model: request.Agent.Model}, func(delta string) error {
		response.WriteString(delta)
		if request.OnProgress != nil {
			return request.OnProgress(delta)
		}
		return nil
	})
	if err != nil {
		return agentExecutionResult{}, err
	}
	if strings.TrimSpace(response.String()) == "" {
		return agentExecutionResult{}, provider.ErrNoChatContentOrToolCalls
	}
	return agentExecutionResult{Summary: strings.TrimSpace(response.String())}, nil
}

func uuidStrings(values []uuid.UUID) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, value.String())
	}
	return result
}

func nodeInput(run models.AgentRun, definition models.AgentWorkflowDefinition, node models.AgentWorkflowNode) json.RawMessage {
	value := map[string]any{"input": json.RawMessage(run.Input)}
	for _, predecessor := range definition.Edges {
		if predecessor.To != node.ID {
			continue
		}
		if previous, err := findAgentRunNode(run.Nodes, predecessor.From); err == nil {
			value[predecessor.From] = json.RawMessage(previous.Output)
		}
	}
	if len(node.InputBindings) > 0 {
		bound := map[string]any{}
		for _, binding := range node.InputBindings {
			if binding.Name == "" {
				continue
			}
			if strings.EqualFold(strings.TrimSpace(binding.Source), "input") {
				bound[binding.Name] = resolveAgentBindingValue(value["input"], binding.Path)
			} else {
				bound[binding.Name] = resolveAgentBindingValue(value[binding.NodeID], binding.Path)
			}
		}
		value["bindings"] = bound
	}
	encoded, _ := json.Marshal(value)
	return encoded
}

// resolveAgentBindingValue supports the small, deterministic binding syntax
// exposed by the workflow editor: dotted object paths and numeric array
// indexes. A missing path resolves to null rather than leaking the whole
// predecessor payload into a node that requested a narrower scope.
func resolveAgentBindingValue(value any, path string) any {
	path = strings.TrimSpace(path)
	if path == "" {
		return value
	}
	var current any
	switch typed := value.(type) {
	case json.RawMessage:
		if json.Unmarshal(typed, &current) != nil {
			return nil
		}
	case []byte:
		if json.Unmarshal(typed, &current) != nil {
			return nil
		}
	default:
		current = typed
	}
	path = strings.TrimPrefix(path, "/")
	parts := strings.FieldsFunc(path, func(r rune) bool { return r == '.' || r == '/' })
	for _, part := range parts {
		if part == "" {
			continue
		}
		switch typed := current.(type) {
		case map[string]any:
			var ok bool
			current, ok = typed[part]
			if !ok {
				return nil
			}
		case []any:
			index, err := strconv.Atoi(part)
			if err != nil || index < 0 || index >= len(typed) {
				return nil
			}
			current = typed[index]
		default:
			return nil
		}
	}
	return current
}

func (e *AgentEngine) nodeFailure(ctx context.Context, runID, nodeID uuid.UUID, attempt, maxAttempts int, nodeErr error) error {
	message := redactAgentError(nodeErr.Error())
	if attempt < maxAttempts {
		result, updateErr := e.app.DB.ExecContext(ctx, `UPDATE agent_run_nodes SET status = 'pending', error = $2, updated_at = now() WHERE id = $1 AND status = 'running'`, nodeID, message)
		if updateErr == nil {
			if affected, rowsErr := result.RowsAffected(); rowsErr == nil && affected > 0 {
				e.emitEvent(ctx, runID, &nodeID, "node.retry", map[string]any{"attempt": attempt, "maxAttempts": maxAttempts, "error": message})
			}
		}
		return nodeErr
	}
	result, updateErr := e.app.DB.ExecContext(ctx, `UPDATE agent_run_nodes SET status = 'failed', error = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'`, nodeID, message)
	if updateErr == nil {
		if affected, rowsErr := result.RowsAffected(); rowsErr == nil && affected > 0 {
			e.emitEvent(ctx, runID, &nodeID, "node.failed", map[string]any{"attempt": attempt, "error": message})
		}
	}
	return nodeErr
}

func (e *AgentEngine) failRun(ctx context.Context, runID uuid.UUID, runErr error) {
	message := redactAgentError(runErr.Error())
	result, updateErr := e.app.DB.ExecContext(ctx, `UPDATE agent_runs SET status = 'failed', error = $2, finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = $1 AND status NOT IN ('completed','cancelled','failed')`, runID, message)
	if updateErr != nil {
		return
	}
	if affected, rowsErr := result.RowsAffected(); rowsErr != nil || affected == 0 {
		return
	}
	e.emitEvent(ctx, runID, nil, "run.failed", map[string]any{"error": message})
	e.auditRunEvent(ctx, runID, "agent.run.failed", map[string]any{"error": message})
	e.syncAutomationRun(ctx, runID, "failed", message)
}

func (e *AgentEngine) completeRun(ctx context.Context, runID uuid.UUID, summary string) {
	result, err := e.app.DB.ExecContext(ctx, `UPDATE agent_runs SET status = 'completed', summary = $2, finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = $1 AND status = 'running'`, runID, truncateAgentText(summary, 30000))
	if err != nil {
		return
	}
	if affected, rowsErr := result.RowsAffected(); rowsErr != nil || affected == 0 {
		return
	}
	e.emitEvent(ctx, runID, nil, "run.completed", map[string]any{"summary": truncateAgentText(summary, 4000)})
	e.auditRunEvent(ctx, runID, "agent.run.completed", map[string]any{"summary": truncateAgentText(summary, 4000)})
	e.syncAutomationRun(ctx, runID, "completed", summary)
}

func (e *AgentEngine) cancelRun(ctx context.Context, runID uuid.UUID) {
	result, updateErr := e.app.DB.ExecContext(ctx, `UPDATE agent_runs SET status = 'cancelled', error = 'cancelled by user', finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = $1 AND status NOT IN ('completed','failed','cancelled')`, runID)
	if updateErr != nil {
		return
	}
	if affected, rowsErr := result.RowsAffected(); rowsErr != nil || affected == 0 {
		return
	}
	_, _ = e.app.DB.ExecContext(ctx, `UPDATE agent_run_nodes SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE run_id = $1 AND status IN ('pending','running','waiting_approval')`, runID)
	e.emitEvent(ctx, runID, nil, "run.cancelled", map[string]any{"reason": "cancelled by user"})
	e.auditRunEvent(ctx, runID, "agent.run.cancelled", map[string]any{"reason": "cancelled by user"})
	e.syncAutomationRun(ctx, runID, "failed", "cancelled by user")
}

func (e *AgentEngine) runCancelRequested(ctx context.Context, runID uuid.UUID) bool {
	var requested bool
	_ = e.app.DB.QueryRowContext(ctx, `SELECT cancel_requested FROM agent_runs WHERE id = $1`, runID).Scan(&requested)
	return requested
}

func (e *AgentEngine) syncAutomationRun(ctx context.Context, runID uuid.UUID, status, summary string) {
	if status == "failed" {
		_, _ = e.app.DB.ExecContext(ctx, `UPDATE automation_runs SET status = 'failed', summary = $2, finished_at = now() WHERE agent_run_id = $1`, runID, truncateAgentText(summary, 30000))
		return
	}
	_, _ = e.app.DB.ExecContext(ctx, `UPDATE automation_runs SET status = $2, summary = $3, finished_at = now() WHERE agent_run_id = $1`, runID, status, truncateAgentText(summary, 30000))
}

func (e *AgentEngine) emitEvent(ctx context.Context, runID uuid.UUID, nodeID *uuid.UUID, eventType string, payload map[string]any) {
	encoded, err := json.Marshal(redactAgentValue(payload))
	if err != nil {
		return
	}
	_, _ = e.app.DB.ExecContext(ctx, `INSERT INTO agent_run_events (run_id,node_id,event_type,payload) VALUES ($1,$2,$3,$4)`, runID, nodeID, eventType, encoded)
}

func (e *AgentEngine) auditRunEvent(ctx context.Context, runID uuid.UUID, action string, details map[string]any) {
	var userID, organizationID uuid.UUID
	if err := e.app.DB.QueryRowContext(ctx, `SELECT user_id, organization_id FROM agent_runs WHERE id=$1`, runID).Scan(&userID, &organizationID); err != nil {
		return
	}
	e.auditAgentEvent(ctx, userID, organizationID, action, "agent_run", runID, details)
}

func (e *AgentEngine) auditAgentEvent(ctx context.Context, userID, organizationID uuid.UUID, action, resourceType string, resourceID uuid.UUID, details map[string]any) {
	encoded, err := json.Marshal(redactAgentValue(details))
	if err != nil {
		return
	}
	_, _ = e.app.DB.ExecContext(ctx, `INSERT INTO audit_events (user_id, organization_id, action, resource_type, resource_id, details) VALUES ($1,$2,$3,$4,$5,$6)`, userID, organizationID, action, resourceType, resourceID, encoded)
}

// requestAgentApproval atomically moves a live node/run into the durable
// waiting state before returning control to the worker. Locking the run row
// makes cancellation win cleanly instead of allowing a late approval request
// to resurrect a cancelled run.
func (e *AgentEngine) requestAgentApproval(ctx context.Context, runID, nodeID uuid.UUID, action map[string]any, argumentHash string) (uuid.UUID, bool, error) {
	transaction, err := e.app.DB.BeginTx(ctx, nil)
	if err != nil {
		return uuid.Nil, false, err
	}
	defer transaction.Rollback()
	var runStatus string
	var cancelRequested bool
	if err := transaction.QueryRowContext(ctx, `SELECT status,cancel_requested FROM agent_runs WHERE id=$1 FOR UPDATE`, runID).Scan(&runStatus, &cancelRequested); err != nil {
		return uuid.Nil, false, err
	}
	if cancelRequested || runStatus == "completed" || runStatus == "failed" || runStatus == "cancelled" {
		return uuid.Nil, false, nil
	}
	var nodeStatus string
	if err := transaction.QueryRowContext(ctx, `SELECT status FROM agent_run_nodes WHERE id=$1 AND run_id=$2 FOR UPDATE`, nodeID, runID).Scan(&nodeStatus); err != nil {
		return uuid.Nil, false, err
	}
	if nodeStatus != "pending" && nodeStatus != "running" && nodeStatus != "waiting_approval" {
		return uuid.Nil, false, nil
	}
	actionType, _ := action["type"].(string)
	if strings.TrimSpace(actionType) == "" {
		actionType = "agent.execute"
	}
	encoded, _ := json.Marshal(redactAgentValue(action))
	var approvalID uuid.UUID
	insertErr := transaction.QueryRowContext(ctx, `INSERT INTO agent_run_approvals (run_id,node_id,action_type,action,argument_hash,expires_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, runID, nodeID, actionType, encoded, argumentHash, time.Now().Add(maxAgentApprovalTTL)).Scan(&approvalID)
	if errors.Is(insertErr, sql.ErrNoRows) {
		if scanErr := transaction.QueryRowContext(ctx, `SELECT id FROM agent_run_approvals WHERE run_id=$1 AND node_id=$2 AND status='pending' ORDER BY created_at DESC LIMIT 1`, runID, nodeID).Scan(&approvalID); scanErr != nil {
			return uuid.Nil, false, scanErr
		}
	} else if insertErr != nil {
		return uuid.Nil, false, insertErr
	}
	if nodeStatus != "waiting_approval" {
		if _, err := transaction.ExecContext(ctx, `UPDATE agent_run_nodes SET status='waiting_approval',updated_at=now() WHERE id=$1 AND status IN ('pending','running')`, nodeID); err != nil {
			return uuid.Nil, false, err
		}
	}
	if runStatus != "waiting_approval" {
		if _, err := transaction.ExecContext(ctx, `UPDATE agent_runs SET status='waiting_approval',next_wake_at=$2,updated_at=now() WHERE id=$1 AND status IN ('queued','running') AND cancel_requested=FALSE`, runID, time.Now().Add(maxAgentApprovalTTL)); err != nil {
			return uuid.Nil, false, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return uuid.Nil, false, err
	}
	return approvalID, true, nil
}

func (e *AgentEngine) approvalGranted(ctx context.Context, runID, nodeID uuid.UUID, argumentHash string) bool {
	var exists bool
	_ = e.app.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM agent_run_approvals WHERE run_id = $1 AND node_id = $2 AND status = 'approved' AND argument_hash = $3 AND expires_at > now())`, runID, nodeID, argumentHash).Scan(&exists)
	return exists
}

func (e *AgentEngine) approvalGrantedForAction(ctx context.Context, runID, nodeID uuid.UUID, argumentHash string) bool {
	return e.approvalGranted(ctx, runID, nodeID, argumentHash)
}

func (e *AgentEngine) maybeQueueAgentRun(ctx context.Context, runID uuid.UUID) {
	_, _ = e.app.DB.ExecContext(ctx, `
		UPDATE agent_runs
		SET status='queued',next_wake_at=NULL,updated_at=now()
		WHERE id=$1 AND status='waiting_approval' AND cancel_requested=FALSE
		  AND NOT EXISTS (SELECT 1 FROM agent_run_approvals WHERE run_id=$1 AND status='pending')
		  AND NOT EXISTS (SELECT 1 FROM agent_run_nodes WHERE run_id=$1 AND status='running')`, runID)
}

func agentArgumentHash(value any) string {
	encoded, _ := json.Marshal(value)
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func redactAgentValue(value any) any {
	switch item := value.(type) {
	case json.RawMessage:
		var decoded any
		if json.Unmarshal(item, &decoded) == nil {
			return redactAgentValue(decoded)
		}
		return "[redacted]"
	case []byte:
		var decoded any
		if json.Unmarshal(item, &decoded) == nil {
			return redactAgentValue(decoded)
		}
		return "[redacted]"
	case map[string]any:
		result := map[string]any{}
		for key, child := range item {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "secret") || strings.Contains(lower, "credential") || strings.Contains(lower, "password") || strings.Contains(lower, "token") || strings.Contains(lower, "privatekey") {
				result[key] = "[redacted]"
				continue
			}
			result[key] = redactAgentValue(child)
		}
		return result
	case []any:
		result := make([]any, len(item))
		for index, child := range item {
			result[index] = redactAgentValue(child)
		}
		return result
	default:
		return value
	}
}

func truncateAgentText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len([]rune(value)) > limit {
		return string([]rune(value)[:limit]) + "…"
	}
	return value
}

func (e *AgentEngine) storeAgentArtifact(ctx context.Context, runID uuid.UUID, nodeID *uuid.UUID, artifact a2aArtifact) error {
	if len(artifact.Content) > 8*1024*1024 {
		return fmt.Errorf("agent artifact exceeds the 8 MB limit")
	}
	hash := sha256.Sum256(artifact.Content)
	metadata, _ := json.Marshal(redactAgentValue(artifact.Metadata))
	_, err := e.app.DB.ExecContext(ctx, `INSERT INTO agent_run_artifacts (run_id,node_id,name,kind,mime_type,content,metadata,size_bytes,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, runID, nodeID, truncateAgentText(firstNonEmptyString(artifact.Name, "artifact"), 120), firstNonEmptyString(artifact.Kind, "text"), firstNonEmptyString(artifact.MimeType, "text/plain"), artifact.Content, metadata, len(artifact.Content), hex.EncodeToString(hash[:]))
	return err
}

func findAgentRunNode(nodes []models.AgentRunNode, key string) (models.AgentRunNode, error) {
	for _, node := range nodes {
		if node.NodeKey == key {
			return node, nil
		}
	}
	return models.AgentRunNode{}, fmt.Errorf("run node %q not found", key)
}

func (e *AgentEngine) defaultEndpointID(ctx context.Context, userID, organizationID uuid.UUID) (*uuid.UUID, error) {
	var id uuid.UUID
	err := e.app.DB.QueryRowContext(ctx, `
		SELECT id FROM endpoint_settings
		WHERE enabled = TRUE AND (capabilities->>'chat') = 'true'
		  AND (scope_type = 'global' OR (scope_type = 'organization' AND scope_id = $1) OR (scope_type = 'user' AND scope_id = $2))
		ORDER BY is_default DESC, CASE scope_type WHEN 'user' THEN 0 WHEN 'organization' THEN 1 ELSE 2 END, updated_at DESC
		LIMIT 1`, organizationID, userID).Scan(&id)
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (e *AgentEngine) defaultAgentID(ctx context.Context, userID, organizationID uuid.UUID) (*uuid.UUID, error) {
	var id uuid.UUID
	err := e.app.DB.QueryRowContext(ctx, `SELECT id FROM saved_assistants WHERE organization_id = $1 AND deleted_at IS NULL AND agent_kind = 'native' AND (visibility = 'workspace' OR user_id = $2) ORDER BY updated_at DESC LIMIT 1`, organizationID, userID).Scan(&id)
	return &id, err
}

func (e *AgentEngine) loadAgent(ctx context.Context, id, userID, organizationID uuid.UUID, versionID *uuid.UUID) (models.Agent, error) {
	versionCondition := "v.version = a.current_version"
	args := []any{id, organizationID, userID}
	if versionID != nil {
		versionCondition = "v.id = $4"
		args = append(args, *versionID)
	}
	row := e.app.DB.QueryRowContext(ctx, `
		SELECT a.id, a.agent_kind, a.name, a.description, a.icon, a.visibility,
		       v.id, v.version, v.instructions, v.endpoint_id, v.model,
		       v.use_memory, v.deep_context, a.connection_id,
		       a.delegation_agent_ids, COALESCE(c.agent_card, '{}'::jsonb),
		       COALESCE(c.agent_card->'capabilities', '{}'::jsonb),
		       COALESCE(c.agent_card->'skills', '[]'::jsonb),
		       CASE WHEN a.agent_kind = 'remote' AND (c.enabled IS FALSE OR c.id IS NULL) THEN 'disabled'
		            WHEN a.agent_kind = 'remote' AND COALESCE(c.last_error, '') <> '' THEN 'degraded'
		            ELSE 'ready' END,
		       COALESCE(c.encrypted_credential IS NOT NULL OR c.encrypted_client_certificate IS NOT NULL, FALSE),
		       a.created_at, a.updated_at
		FROM saved_assistants a
		LEFT JOIN saved_assistant_versions v ON v.assistant_id = a.id AND `+versionCondition+`
		LEFT JOIN agent_connections c ON c.id = a.connection_id
		WHERE a.id = $1 AND a.organization_id = $2 AND a.deleted_at IS NULL
		  AND (a.visibility = 'workspace' OR a.user_id = $3)`, args...)
	return scanAgent(row)
}

func scanAgent(scanner interface{ Scan(...any) error }) (models.Agent, error) {
	var item models.Agent
	var versionID, endpointID, connectionID sql.NullString
	var version sql.NullInt64
	var delegation, card, capabilities, skills []byte
	if err := scanner.Scan(&item.ID, &item.Kind, &item.Name, &item.Description, &item.Icon, &item.Visibility, &versionID, &version, &item.Instructions, &endpointID, &item.Model, &item.UseMemory, &item.DeepContext, &connectionID, &delegation, &card, &capabilities, &skills, &item.Status, &item.CredentialConfigured, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	item.VersionID = parseOptionalUUIDString(versionID.String)
	if version.Valid {
		item.Version = int(version.Int64)
	}
	item.EndpointID = parseOptionalUUIDString(endpointID.String)
	item.ConnectionID = parseOptionalUUIDString(connectionID.String)
	_ = json.Unmarshal(delegation, &item.DelegationAgentIDs)
	item.AgentCard = json.RawMessage(card)
	item.Capabilities = json.RawMessage(capabilities)
	item.Skills = json.RawMessage(skills)
	return item, nil
}

func (e *AgentEngine) loadAgentRun(ctx context.Context, runID uuid.UUID) (models.AgentRun, error) {
	var run models.AgentRun
	var workflowID, rootAgentID, parentRunID, conversationID sql.NullString
	var definitionSnapshot []byte
	err := e.app.DB.QueryRowContext(ctx, `SELECT id, user_id, organization_id, workflow_id, root_agent_id, parent_run_id, conversation_id, source_type, status, input, definition_snapshot, summary, error, started_at, finished_at, created_at, updated_at FROM agent_runs WHERE id = $1`, runID).Scan(&run.ID, &run.UserID, &run.OrganizationID, &workflowID, &rootAgentID, &parentRunID, &conversationID, &run.SourceType, &run.Status, &run.Input, &definitionSnapshot, &run.Summary, &run.Error, &run.StartedAt, &run.FinishedAt, &run.CreatedAt, &run.UpdatedAt)
	if err != nil {
		return run, err
	}
	run.WorkflowID = parseOptionalUUIDString(workflowID.String)
	run.RootAgentID = parseOptionalUUIDString(rootAgentID.String)
	run.ParentRunID = parseOptionalUUIDString(parentRunID.String)
	run.ConversationID = parseOptionalUUIDString(conversationID.String)
	run.DefinitionSnapshot = json.RawMessage(definitionSnapshot)
	run.Nodes, _ = e.loadAgentRunNodes(ctx, run.ID)
	run.Approvals, _ = e.loadAgentApprovals(ctx, run.ID)
	run.Artifacts, _ = e.loadAgentArtifacts(ctx, run.ID)
	return run, nil
}

func (e *AgentEngine) loadAgentRunNodes(ctx context.Context, runID uuid.UUID) ([]models.AgentRunNode, error) {
	rows, err := e.app.DB.QueryContext(ctx, `SELECT id,run_id,node_key,agent_id,agent_version_id,definition,status,attempt,input,output,error,provider_task_id,started_at,finished_at,updated_at FROM agent_run_nodes WHERE run_id = $1 ORDER BY id`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []models.AgentRunNode{}
	for rows.Next() {
		var item models.AgentRunNode
		var agentID, versionID sql.NullString
		if err := rows.Scan(&item.ID, &item.RunID, &item.NodeKey, &agentID, &versionID, &item.Definition, &item.Status, &item.Attempt, &item.Input, &item.Output, &item.Error, &item.ProviderTaskID, &item.StartedAt, &item.FinishedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.AgentID = parseOptionalUUIDString(agentID.String)
		item.AgentVersionID = parseOptionalUUIDString(versionID.String)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (e *AgentEngine) loadAgentApprovals(ctx context.Context, runID uuid.UUID) ([]models.AgentApproval, error) {
	rows, err := e.app.DB.QueryContext(ctx, `SELECT id,run_id,node_id,action_type,action,argument_hash,status,reason,expires_at,decided_at,created_at FROM agent_run_approvals WHERE run_id = $1 ORDER BY created_at`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []models.AgentApproval{}
	for rows.Next() {
		var item models.AgentApproval
		var nodeID sql.NullString
		if err := rows.Scan(&item.ID, &item.RunID, &nodeID, &item.ActionType, &item.Action, &item.ArgumentHash, &item.Status, &item.Reason, &item.ExpiresAt, &item.DecidedAt, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.NodeID = parseOptionalUUIDString(nodeID.String)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (e *AgentEngine) loadAgentArtifacts(ctx context.Context, runID uuid.UUID) ([]models.AgentArtifact, error) {
	rows, err := e.app.DB.QueryContext(ctx, `SELECT id,run_id,node_id,name,kind,mime_type,metadata,size_bytes,sha256,created_at FROM agent_run_artifacts WHERE run_id = $1 ORDER BY created_at`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []models.AgentArtifact{}
	for rows.Next() {
		var item models.AgentArtifact
		var nodeID sql.NullString
		if err := rows.Scan(&item.ID, &item.RunID, &nodeID, &item.Name, &item.Kind, &item.MimeType, &item.Metadata, &item.SizeBytes, &item.SHA256, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.NodeID = parseOptionalUUIDString(nodeID.String)
		items = append(items, item)
	}
	return items, rows.Err()
}

// DelegateAgent creates an ad-hoc one-node child run. It is deliberately
// synchronous for conversational use: the caller receives the final summary
// when the child completes, or a durable waiting_approval run when policy
// requires a decision.
func (e *AgentEngine) DelegateAgent(ctx context.Context, userID, organizationID, conversationID, coordinatorID, targetID uuid.UUID, task string, input json.RawMessage) (models.AgentRun, error) {
	coordinator, err := e.loadAgent(ctx, coordinatorID, userID, organizationID, nil)
	if err != nil {
		return models.AgentRun{}, err
	}
	allowed := false
	for _, id := range coordinator.DelegationAgentIDs {
		if id == targetID {
			allowed = true
			break
		}
	}
	if !allowed {
		return models.AgentRun{}, fmt.Errorf("coordinator agent is not allowed to delegate to the selected agent")
	}
	if _, err := e.loadAgent(ctx, targetID, userID, organizationID, nil); err != nil {
		return models.AgentRun{}, err
	}
	conversation := conversationID
	definition := models.AgentWorkflowDefinition{Nodes: []models.AgentWorkflowNode{{ID: "delegated-agent", Type: "agent", AgentID: &targetID, Instruction: strings.TrimSpace(task), Context: models.AgentContextScope{}, ApprovalMode: "read_only_auto", Retry: models.AgentRetryPolicy{MaxAttempts: maxAgentAttempts}, TimeoutSeconds: int(maxAgentNodeTimeout / time.Second)}}}
	run, err := e.createRun(agentRunCreateOptions{UserID: userID, OrganizationID: organizationID, ParentRunID: nil, ConversationID: &conversation, RootAgentID: &targetID, SourceType: "delegation", Input: input, Definition: definition})
	if err != nil {
		return models.AgentRun{}, err
	}
	if !e.claimDirectAgentRun(ctx, run.ID) {
		return e.waitForAgentRun(ctx, run.ID)
	}
	e.executeRun(ctx, run.ID)
	return e.loadAgentRun(ctx, run.ID)
}

func (e *AgentEngine) waitForAgentRun(ctx context.Context, runID uuid.UUID) (models.AgentRun, error) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		run, err := e.loadAgentRun(ctx, runID)
		if err != nil {
			return models.AgentRun{}, err
		}
		switch run.Status {
		case "completed", "failed", "cancelled", "waiting_approval":
			return run, nil
		}
		select {
		case <-ctx.Done():
			return models.AgentRun{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (e *AgentEngine) CreateDirectAgentRun(ctx context.Context, userID, organizationID, conversationID, agentID uuid.UUID, instruction string, input json.RawMessage) (models.AgentRun, error) {
	if _, err := e.loadAgent(ctx, agentID, userID, organizationID, nil); err != nil {
		return models.AgentRun{}, err
	}
	definition := models.AgentWorkflowDefinition{Nodes: []models.AgentWorkflowNode{{ID: "chat-agent", Type: "agent", AgentID: &agentID, Instruction: strings.TrimSpace(instruction), Context: models.AgentContextScope{}, ApprovalMode: "read_only_auto", Retry: models.AgentRetryPolicy{MaxAttempts: maxAgentAttempts}, TimeoutSeconds: int(maxAgentNodeTimeout / time.Second)}}}
	conversation := conversationID
	return e.createRun(agentRunCreateOptions{UserID: userID, OrganizationID: organizationID, ConversationID: &conversation, RootAgentID: &agentID, SourceType: "chat", Input: input, Definition: definition})
}

// Keep these references compile-time visible to callers that use the existing
// organization middleware while the engine itself remains HTTP-independent.
var _ = middleware.Principal{}
