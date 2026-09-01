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

	"justai-backend/models"
)

// assistantUIRemoteChat adapts a first-class remote agent to the existing AI
// SDK UI-message stream. The run itself remains the durable source of truth;
// this adapter only projects progress into the originating conversation.
func (a *App) assistantUIRemoteChat(c *gin.Context, userID, organizationID, conversationID uuid.UUID, request assistantUIRequest, messages []assistantUIMessage, latestUser *assistantUserMessage, agent models.Agent) {
	if latestUser == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("a non-empty user message is required"))
		return
	}
	if err := a.persistAssistantUIUser(c, conversationID, *latestUser); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	input, _ := json.Marshal(map[string]any{"text": latestUser.Text, "messageId": latestUser.ID})
	instruction := remoteAgentConversationPrompt(messages, latestUser.Text)
	run, err := a.AgentWorker.CreateDirectAgentRun(c, userID, organizationID, conversationID, agent.ID, instruction, input)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	go a.AgentWorker.executeDirectRun(context.Background(), run.ID)

	streamID := uuid.New()
	if err := a.createChatStream(context.Background(), streamID, conversationID, userID, organizationID, uuid.Nil); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	writer := c.Writer
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-transform")
	writer.Header().Set("Connection", "keep-alive")
	writer.Header().Set("X-Accel-Buffering", "no")
	writer.Header().Set("x-vercel-ai-ui-message-stream", "v1")
	writer.Header().Set("x-resumable-stream-id", streamID.String())
	writer.WriteHeader(http.StatusOK)
	flusher, _ := writer.(http.Flusher)
	writeChunk := func(value any) error {
		payload, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if err := a.appendChatStreamChunk(context.Background(), streamID, string(payload)); err != nil {
			return err
		}
		if _, err := fmt.Fprintf(writer, "data: %s\n\n", payload); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	finish := func(status string) {
		if status == "running" || status == "queued" {
			status = "complete"
		}
		_ = a.appendChatStreamChunk(context.Background(), streamID, "[DONE]")
		_, _ = fmt.Fprint(writer, "data: [DONE]\n\n")
		_ = a.finishChatStream(context.Background(), streamID, status)
		if flusher != nil {
			flusher.Flush()
		}
	}
	defer func() {
		if c.Request.Context().Err() != nil {
			_, _ = a.DB.ExecContext(context.Background(), `UPDATE agent_runs SET cancel_requested=TRUE WHERE id=$1 AND status IN ('queued','running')`, run.ID)
		}
	}()
	assistantMessageID := uuid.NewString()
	textID := assistantMessageID + ":text"
	_ = writeChunk(map[string]any{"type": "start", "messageId": assistantMessageID})
	_ = writeChunk(map[string]any{"type": "start-step"})
	var response strings.Builder
	textStarted := false
	toolParts := []map[string]any{}
	lastEventID := int64(0)
	status := "running"
	deadline := time.Now().Add(maxAgentRunTimeout)
	for time.Now().Before(deadline) {
		rows, queryErr := a.DB.QueryContext(c, `SELECT id,event_type,payload FROM agent_run_events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT 100`, run.ID, lastEventID)
		if queryErr != nil {
			status = "error"
			break
		}
		for rows.Next() {
			var id int64
			var eventType string
			var payload []byte
			if rows.Scan(&id, &eventType, &payload) != nil {
				continue
			}
			lastEventID = id
			if eventType == "node.progress" {
				var value map[string]any
				_ = json.Unmarshal(payload, &value)
				delta, _ := value["delta"].(string)
				if delta != "" {
					if !textStarted {
						textStarted = true
						_ = writeChunk(map[string]any{"type": "text-start", "id": textID})
					}
					response.WriteString(delta)
					if err := writeChunk(map[string]any{"type": "text-delta", "id": textID, "delta": delta}); err != nil {
						status = "error"
					}
				}
			}
		}
		rows.Close()
		var runStatus string
		if a.DB.QueryRowContext(c, `SELECT status FROM agent_runs WHERE id=$1`, run.ID).Scan(&runStatus) == nil {
			status = runStatus
		}
		if status == "waiting_approval" {
			message := "This remote agent is waiting for approval. Review the action in the run workspace before it continues."
			if !textStarted {
				textStarted = true
				_ = writeChunk(map[string]any{"type": "text-start", "id": textID})
				response.WriteString(message)
				_ = writeChunk(map[string]any{"type": "text-delta", "id": textID, "delta": message})
			}
			if pending := pendingAgentApproval(latestRunApprovals(a, run.ID)); pending != nil {
				approvalData := map[string]any{
					"runId":        run.ID.String(),
					"status":       status,
					"approvalId":   pending.ID.String(),
					"action":       json.RawMessage(pending.Action),
					"argumentHash": pending.ArgumentHash,
					"expiresAt":    pending.ExpiresAt,
				}
				toolParts = append(toolParts, map[string]any{"type": "data-agent-run", "data": approvalData})
				_ = writeChunk(map[string]any{"type": "data-agent-run", "id": "agent-run-approval", "data": approvalData})
			} else {
				_ = writeChunk(map[string]any{"type": "data-agent-run", "id": "agent-run", "data": map[string]any{"runId": run.ID.String(), "status": status}})
			}
			break
		}
		if status == "completed" || status == "failed" || status == "cancelled" {
			break
		}
		select {
		case <-c.Request.Context().Done():
			status = "cancelled"
			break
		case <-time.After(250 * time.Millisecond):
		}
		if status == "cancelled" {
			break
		}
	}
	if !textStarted {
		latest, _ := a.AgentWorker.loadAgentRun(context.Background(), run.ID)
		if latest.Summary != "" {
			textStarted = true
			response.WriteString(latest.Summary)
			_ = writeChunk(map[string]any{"type": "text-start", "id": textID})
			_ = writeChunk(map[string]any{"type": "text-delta", "id": textID, "delta": latest.Summary})
		}
	}
	if textStarted {
		_ = writeChunk(map[string]any{"type": "text-end", "id": textID})
	}
	_ = writeChunk(map[string]any{"type": "message-metadata", "messageMetadata": map[string]any{"agentRunId": run.ID.String(), "runStatus": status}})
	_ = writeChunk(map[string]any{"type": "finish-step"})
	finishReason := "stop"
	streamStatus := "complete"
	if status == "waiting_approval" {
		finishReason = "tool-calls"
		streamStatus = "requires-action"
	} else if status == "failed" || status == "cancelled" || status == "error" {
		finishReason = "error"
		streamStatus = status
	}
	_ = writeChunk(map[string]any{"type": "finish", "finishReason": finishReason})
	parent, _ := a.conversationHead(c, conversationID)
	metadata := map[string]any{"agentRunId": run.ID.String(), "runStatus": status}
	_ = a.persistAssistantUIAssistantAtPartsStatus(context.Background(), conversationID, parent, assistantMessageID, response.String(), nil, toolParts, metadata, statusForAssistantMessage(status))
	finish(streamStatus)
	_ = messages
	_ = request
}

func remoteAgentConversationPrompt(messages []assistantUIMessage, latest string) string {
	const maxMessages = 12
	const maxPromptRunes = 24_000
	start := 0
	if len(messages) > maxMessages {
		start = len(messages) - maxMessages
	}
	var builder strings.Builder
	for _, message := range messages[start:] {
		if message.Role != "user" && message.Role != "assistant" {
			continue
		}
		text := assistantUITextFromParts(message.Parts)
		if strings.TrimSpace(text) == "" {
			continue
		}
		role := strings.ToUpper(message.Role[:1]) + message.Role[1:]
		builder.WriteString(role)
		builder.WriteString(": ")
		builder.WriteString(strings.TrimSpace(text))
		builder.WriteString("\n\n")
	}
	prompt := strings.TrimSpace(builder.String())
	if prompt == "" {
		prompt = strings.TrimSpace(latest)
	}
	if len([]rune(prompt)) > maxPromptRunes {
		prompt = string([]rune(prompt)[len([]rune(prompt))-maxPromptRunes:])
	}
	return prompt
}

func assistantUITextFromParts(parts []json.RawMessage) string {
	var builder strings.Builder
	for _, raw := range parts {
		var part assistantUIPart
		if json.Unmarshal(raw, &part) != nil || part.Type != "text" {
			continue
		}
		builder.WriteString(part.Text)
	}
	return builder.String()
}

func latestRunApprovals(a *App, runID uuid.UUID) []models.AgentApproval {
	if a == nil || a.AgentWorker == nil {
		return nil
	}
	run, err := a.AgentWorker.loadAgentRun(context.Background(), runID)
	if err != nil {
		return nil
	}
	return run.Approvals
}

func pendingAgentApproval(approvals []models.AgentApproval) *models.AgentApproval {
	for index := range approvals {
		if approvals[index].Status == "pending" {
			return &approvals[index]
		}
	}
	return nil
}

func statusForAssistantMessage(status string) string {
	switch status {
	case "waiting_approval":
		return "requires-action"
	case "failed", "cancelled", "error":
		return "error"
	default:
		return "complete"
	}
}
