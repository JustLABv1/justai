package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/provider"
)

// Agents notify their owner in two ways: a workflow says which run events are worth a
// notification (waiting for approval, failed, completed), and an agent can decide on
// its own to send one with the notify_user tool ("tell me only if ...").

const (
	agentNotifyPerRun  = 5
	agentNotifyPerHour = 30
)

type agentNotifyOn struct {
	Approval  bool `json:"approval"`
	Failed    bool `json:"failed"`
	Completed bool `json:"completed"`
}

var defaultAgentNotifyOn = agentNotifyOn{Approval: true, Failed: true}

func agentRunLink(runID uuid.UUID) string { return "/agents?tab=runs&run=" + runID.String() }

func agentNotifyTool() provider.ToolDefinition {
	return provider.ToolDefinition{
		Name:        "notify_user",
		Description: "Send the user a notification now: it appears in JustAI and, when they turned it on, as a browser push, e-mail or webhook, with a link to this run. Use it only when the instructions ask to be told about something and that condition is met, or for a result the user must not miss. Do not use it to report ordinary progress. Write in the user's language.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":120,"description":"Short headline."},"message":{"type":"string","minLength":1,"maxLength":1000,"description":"What the user should know."}},"required":["title","message"],"additionalProperties":false}`),
	}
}

// agentNotifyUser runs the notify_user tool for one agent node.
func (a *App) agentNotifyUser(ctx context.Context, request agentExecutionRequest, args map[string]any) (string, error) {
	title := strings.TrimSpace(stringToolArgument(args, "title"))
	message := strings.TrimSpace(stringToolArgument(args, "message"))
	if title == "" || message == "" {
		return "", fmt.Errorf("title and message are required")
	}
	var perRun, perHour int
	_ = a.DB.QueryRowContext(ctx, `SELECT
		COUNT(*) FILTER (WHERE dedupe_key LIKE $2),
		COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')
		FROM notifications WHERE user_id = $1 AND kind = 'agent_message'`, request.UserID, "agent_message:"+request.RunID.String()+":%").Scan(&perRun, &perHour)
	if perRun >= agentNotifyPerRun {
		return "", fmt.Errorf("this run already sent %d notifications, the most allowed", agentNotifyPerRun)
	}
	if perHour >= agentNotifyPerHour {
		return "", fmt.Errorf("too many agent notifications in the last hour; try again later")
	}
	event := notificationEvent{
		Kind:           "agent_message",
		OrganizationID: request.OrganizationID,
		UserID:         request.UserID,
		DedupeKey:      fmt.Sprintf("agent_message:%s:%s", request.RunID, uuid.NewString()),
		Link:           agentRunLink(request.RunID),
		Topic:          truncateRunes(title, 120),
		Message:        truncateRunes(message, 1000),
		SessionTitle:   request.Agent.Name,
	}
	a.notify(ctx, event)
	encoded, _ := json.Marshal(map[string]any{"sent": true, "title": event.Topic})
	return string(encoded), nil
}

// claimAgentRunEvents marks run states as announced and returns the ones worth a
// notification. Runs started from chat are left out (the user was there), and so are
// delegated child runs (their parent run speaks for them).
func (a *App) claimAgentRunEvents(ctx context.Context) []notificationEvent {
	// Back to work: a later approval is announced again.
	_, _ = a.DB.ExecContext(ctx, `UPDATE agent_runs SET notified_status = NULL WHERE notified_status IS NOT NULL AND status IN ('queued', 'running')`)
	rows, err := a.DB.QueryContext(ctx, `UPDATE agent_runs r SET notified_status = r.status
		FROM (SELECT r2.id, COALESCE(w.notify_on, '{}'::jsonb) AS notify_on, w.id IS NOT NULL AS has_workflow, COALESCE(w.name, sa.name, '') AS name
			FROM agent_runs r2
			LEFT JOIN agent_workflows w ON w.id = r2.workflow_id
			LEFT JOIN saved_assistants sa ON sa.id = r2.root_agent_id
			WHERE r2.status IN ('completed', 'failed', 'waiting_approval') AND r2.notified_status IS DISTINCT FROM r2.status
			AND r2.updated_at > now() - interval '1 day'
			FOR UPDATE OF r2) x
		WHERE r.id = x.id
		RETURNING r.id, r.user_id, r.organization_id, r.status, r.source_type, r.parent_run_id IS NOT NULL, x.notify_on, x.has_workflow, x.name, r.error, r.summary, r.updated_at`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var events []notificationEvent
	for rows.Next() {
		var runID, userID, organizationID uuid.UUID
		var status, source, name, runError, summary string
		var child, hasWorkflow bool
		var notifyRaw []byte
		var updated time.Time
		if rows.Scan(&runID, &userID, &organizationID, &status, &source, &child, &notifyRaw, &hasWorkflow, &name, &runError, &summary, &updated) != nil {
			continue
		}
		if source == "chat" || child {
			continue
		}
		notifyOn := defaultAgentNotifyOn
		if hasWorkflow {
			notifyOn = agentNotifyOn{}
			if json.Unmarshal(notifyRaw, &notifyOn) != nil {
				notifyOn = defaultAgentNotifyOn
			}
		}
		event := notificationEvent{OrganizationID: organizationID, UserID: userID, Link: agentRunLink(runID), SessionTitle: name}
		switch {
		case status == "waiting_approval" && notifyOn.Approval:
			event.Kind = "agent_approval"
		case status == "failed" && notifyOn.Failed:
			event.Kind, event.Message = "agent_failed", truncateRunes(runError, 300)
		case status == "completed" && notifyOn.Completed:
			event.Kind, event.Message = "agent_completed", truncateRunes(strings.TrimSpace(summary), 300)
		default:
			continue
		}
		event.DedupeKey = fmt.Sprintf("%s:%s:%d", event.Kind, runID, updated.Unix())
		events = append(events, event)
	}
	return events
}

func agentTexts(german bool, event notificationEvent) (title, body, linkLabel string) {
	name := event.SessionTitle
	if name == "" {
		name = "Agent"
	}
	switch event.Kind {
	case "agent_message":
		if german {
			return event.Topic, event.Message, "Lauf öffnen"
		}
		return event.Topic, event.Message, "Open run"
	case "agent_approval":
		if german {
			return "„" + name + "“ wartet auf deine Freigabe", "Ein Agent-Lauf möchte eine Aktion ausführen und braucht deine Zustimmung, bevor die Freigabe abläuft.", "Freigabe prüfen"
		}
		return "“" + name + "” is waiting for your approval", "An agent run wants to take an action and needs your approval before the request expires.", "Review approval"
	case "agent_failed":
		if german {
			body = "Der Agent-Lauf ist fehlgeschlagen."
			if event.Message != "" {
				body += " " + event.Message
			}
			return "„" + name + "“ ist fehlgeschlagen", body, "Lauf öffnen"
		}
		body = "The agent run failed."
		if event.Message != "" {
			body += " " + event.Message
		}
		return "“" + name + "” failed", body, "Open run"
	default: // agent_completed
		body = event.Message
		if german {
			if body == "" {
				body = "Der Agent-Lauf ist abgeschlossen."
			}
			return "„" + name + "“ ist fertig", body, "Ergebnis öffnen"
		}
		if body == "" {
			body = "The agent run is complete."
		}
		return "“" + name + "” is done", body, "Open result"
	}
}

// workflowNotifications: GET or PUT {"approval","failed","completed"} for a workflow.
func (a *App) workflowNotifications(c *gin.Context) {
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
	if c.Request.Method == http.MethodPut {
		if err := a.authorizeWorkflowManage(c, ownerID, current.Visibility, principal); err != nil {
			writeError(c, http.StatusForbidden, err)
			return
		}
		var request agentNotifyOn
		if !decodeJSON(c, &request) {
			return
		}
		raw, _ := json.Marshal(request)
		if _, err := a.DB.ExecContext(c, `UPDATE agent_workflows SET notify_on = $2, updated_at = now() WHERE id = $1 AND organization_id = $3`, id, raw, organizationID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	var raw []byte
	if err := a.DB.QueryRowContext(c, `SELECT notify_on FROM agent_workflows WHERE id = $1`, id).Scan(&raw); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var result agentNotifyOn
	_ = json.Unmarshal(raw, &result)
	c.JSON(http.StatusOK, result)
}
