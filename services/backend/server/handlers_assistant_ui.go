package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

// assistantUIRequest is intentionally provider-neutral. The browser sends
// standard AI SDK UIMessage objects, while conversationId/endpointId/model are
// host-owned routing fields added by AssistantChatTransport.
type assistantUIRequest struct {
	Messages       []json.RawMessage `json:"messages"`
	ConversationID string            `json:"conversationId"`
	EndpointID     string            `json:"endpointId"`
	Model          string            `json:"model"`
}

type assistantUIMessage struct {
	ID    string            `json:"id"`
	Role  string            `json:"role"`
	Parts []json.RawMessage `json:"parts"`
}

type assistantUIPart struct {
	Type       string               `json:"type"`
	ApprovalID string               `json:"approvalId"`
	Approved   *bool                `json:"approved"`
	Text       string               `json:"text"`
	State      string               `json:"state"`
	ToolCallID string               `json:"toolCallId"`
	ToolName   string               `json:"toolName"`
	Input      map[string]any       `json:"input"`
	Output     any                  `json:"output"`
	ErrorText  string               `json:"errorText"`
	Reason     string               `json:"reason"`
	Approval   *assistantUIApproval `json:"approval"`
	Data       map[string]any       `json:"data"`
}

type assistantUIApproval struct {
	ID       string `json:"id"`
	Approved *bool  `json:"approved"`
	Reason   string `json:"reason"`
}

type assistantUIApprovalResponse struct {
	MessageID  string
	ApprovalID string
	CallID     string
	ToolName   string
	Arguments  map[string]any
	Approved   bool
	Reason     string
}

type assistantUIRepositoryItem struct {
	ParentID string         `json:"parentId"`
	Message  map[string]any `json:"message"`
	// LegacyTool is an internal marker used to hide the old role=tool event
	// rows when the canonical Assistant UI assistant message already contains
	// the same dynamic tool parts. It is never serialized in the repository.
	LegacyTool bool `json:"-"`
}

type assistantUIRepository struct {
	HeadID   string                      `json:"headId,omitempty"`
	Messages []assistantUIRepositoryItem `json:"messages"`
}

// assistantUIToolGroup is the read-side representation used while legacy
// role=tool rows are folded into one Assistant UI assistant message. The
// final row's id is retained so the next persisted row can still point at the
// same branch head through parentId.
type assistantUIToolGroup struct {
	item   assistantUIRepositoryItem
	headID string
}

func mergeAssistantUIToolMessage(target, source map[string]any) {
	targetParts, _ := target["parts"].([]any)
	sourceParts, _ := source["parts"].([]any)
	if len(sourceParts) > 0 {
		target["parts"] = append(targetParts, sourceParts...)
	}
	if sourceID, ok := source["id"].(string); ok && sourceID != "" {
		target["id"] = sourceID
	}
	// Keep the most actionable status when a group contains a pending call.
	// This ensures a resumed/loaded branch still exposes the approval gate.
	targetMetadata, _ := target["metadata"].(map[string]any)
	sourceMetadata, _ := source["metadata"].(map[string]any)
	if sourceMetadata == nil {
		return
	}
	if targetMetadata == nil {
		targetMetadata = map[string]any{}
		target["metadata"] = targetMetadata
	}
	targetStatus, _ := targetMetadata["runStatus"].(string)
	sourceStatus, _ := sourceMetadata["runStatus"].(string)
	if assistantUIRunStatusPriority(sourceStatus) > assistantUIRunStatusPriority(targetStatus) {
		targetMetadata["runStatus"] = sourceStatus
	}
}

func assistantUIRunStatusPriority(status string) int {
	switch status {
	case "requires-action":
		return 4
	case "running":
		return 3
	case "incomplete":
		return 2
	case "complete":
		return 1
	default:
		return 0
	}
}

func isAssistantUIMCPToolRow(role, content string) bool {
	if role != "tool" {
		return false
	}
	var event chatToolEvent
	return json.Unmarshal([]byte(content), &event) == nil && event.Kind == "mcp_tool" && event.CallID != ""
}

func (a *App) assistantUIChat(c *gin.Context) {
	principal, ok := middleware.GetPrincipal(c)
	if !ok {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("authentication required"))
		return
	}
	organizationID, ok := middleware.GetOrganizationID(c)
	if !ok || organizationID == uuid.Nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("organization context is required"))
		return
	}

	var request assistantUIRequest
	if !decodeJSON(c, &request) {
		return
	}
	conversationID, err := a.ensureConversation(c, principal.UserID, organizationID, request.ConversationID)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	endpointID, err := a.resolveEndpoint(c, principal.UserID, organizationID, request.EndpointID)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	endpoint, err := a.providerEndpoint(c, endpointID)
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("endpoint could not be loaded: %w", err))
		return
	}
	// The endpoint's configured chat model is the safe default. A model chosen
	// from discovery (or entered manually for a compatible gateway) is scoped to
	// this request and never changes the endpoint's persisted default.
	if model := strings.TrimSpace(request.Model); model != "" {
		endpoint.ChatModel = model
	}

	requestMessages := parseAssistantUIMessages(request.Messages)
	approval := findAssistantUIApproval(requestMessages)
	latestUser := latestAssistantUserMessage(requestMessages)
	if approval == nil {
		if latestUser != nil {
			if err := a.persistAssistantUIUser(c, conversationID, *latestUser); err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
		}
	}

	indexing, err := a.conversationHasIndexingKnowledge(c, conversationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if indexing {
		writeError(c, http.StatusConflict, fmt.Errorf("attached Knowledge is still indexing; detach it or wait for indexing to finish"))
		return
	}

	// The UI Message Stream is deliberately emitted directly from Go. This
	// keeps provider credentials and MCP execution on the backend while making
	// the browser transport interchangeable with the AI SDK runtime.
	writer := c.Writer
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-transform")
	writer.Header().Set("Connection", "keep-alive")
	writer.Header().Set("X-Accel-Buffering", "no")
	writer.Header().Set("x-vercel-ai-ui-message-stream", "v1")
	writer.WriteHeader(http.StatusOK)
	flusher, _ := writer.(http.Flusher)
	start := time.Now()
	var firstTokenAt time.Time
	streamChunkCount := 0
	toolCallCount := 0
	writeChunk := func(value any) error {
		streamChunkCount++
		if chunk, ok := value.(map[string]any); ok {
			switch chunk["type"] {
			case "text-delta", "reasoning-delta":
				if firstTokenAt.IsZero() {
					firstTokenAt = time.Now()
				}
			case "tool-input-available":
				toolCallCount++
			}
		}
		payload, marshalErr := json.Marshal(value)
		if marshalErr != nil {
			return marshalErr
		}
		if _, writeErr := fmt.Fprintf(writer, "data: %s\n\n", payload); writeErr != nil {
			return writeErr
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	finishStream := func() {
		if requestContext := c.Request.Context(); requestContext.Err() != nil {
			if payload, marshalErr := json.Marshal(map[string]any{"type": "abort", "reason": requestContext.Err().Error()}); marshalErr == nil {
				_, _ = fmt.Fprintf(writer, "data: %s\n\n", payload)
			}
		}
		_, _ = fmt.Fprint(writer, "data: [DONE]\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}

	assistantMessageID := uuid.NewString()
	if approval != nil {
		// The AI SDK resubmits the same assistant message when an approval is
		// answered. Reusing that id makes the stream completion and the history
		// adapter upsert the same durable message instead of creating a sibling.
		if parsed, parseErr := uuid.Parse(approval.MessageID); parseErr == nil {
			assistantMessageID = parsed.String()
		}
	}
	textID := assistantMessageID + ":text"
	if err := writeChunk(map[string]any{"type": "start", "messageId": assistantMessageID}); err != nil {
		return
	}
	defer finishStream()
	writeTiming := func() map[string]any {
		timing := map[string]any{
			"streamStartTime": start.UnixMilli(),
			"totalStreamTime": time.Since(start).Milliseconds(),
			"totalChunks":     streamChunkCount,
			"toolCallCount":   toolCallCount,
		}
		if !firstTokenAt.IsZero() {
			timing["firstTokenTime"] = firstTokenAt.UnixMilli()
		}
		return map[string]any{"timing": timing}
	}

	var citations []models.Citation
	if latestUser != nil {
		_ = writeChunk(map[string]any{
			"type": "data-retrieval-status",
			"data": map[string]any{"status": "started", "query": latestUser.Text},
		})
		var retrievalErr error
		citations, retrievalErr = a.searchKnowledge(c, organizationID, principal.UserID, conversationID, latestUser.Text, 6)
		if retrievalErr != nil {
			_ = writeChunk(map[string]any{
				"type": "data-retrieval-status",
				"data": map[string]any{"status": "failed", "error": retrievalErr.Error()},
			})
		} else {
			_ = writeChunk(map[string]any{
				"type": "data-retrieval-status",
				"data": map[string]any{"status": "completed", "citationCount": len(citations)},
			})
		}
	}
	for _, citation := range citations {
		_ = writeChunk(a.assistantUICitationPart(c, citation))
	}

	var outputParent any
	toolParts := assistantUIApprovalToolParts(requestMessages)
	if approval != nil {
		resumedEvent, resumedMessageID, resumeErr := a.resumeAssistantUIApproval(c, principal.UserID, organizationID, conversationID, *approval)
		if resumeErr != nil {
			_ = writeChunk(map[string]any{"type": "error", "errorText": resumeErr.Error()})
			_ = writeChunk(map[string]any{"type": "finish", "finishReason": "error"})
			return
		}
		if resumedMessageID != uuid.Nil {
			outputParent = resumedMessageID
		}
		if resumedEvent != nil {
			toolParts = replaceAssistantUIToolPart(toolParts, *resumedEvent)
			switch resumedEvent.Status {
			case "completed":
				_ = writeChunk(map[string]any{"type": "tool-output-available", "toolCallId": resumedEvent.CallID, "output": assistantUIJSONValue(resumedEvent.Result), "dynamic": true})
			case "declined":
				_ = writeChunk(map[string]any{"type": "tool-output-denied", "toolCallId": resumedEvent.CallID})
			case "failed":
				_ = writeChunk(map[string]any{"type": "tool-output-error", "toolCallId": resumedEvent.CallID, "errorText": resumedEvent.Error, "dynamic": true})
			}
		}
	}
	if outputParent == nil && latestUser != nil {
		if userRecordID, lookupErr := a.assistantUIMessageRecordID(c, conversationID, latestUser.ID); lookupErr == nil {
			outputParent = userRecordID
		}
	}
	if outputParent == nil {
		outputParent, _ = a.conversationHead(c, conversationID)
	}

	toolDiscovery := a.discoverConversationTools(c, principal.UserID, organizationID, conversationID)
	definitions, bindings := toolDiscovery.Definitions, toolDiscovery.Bindings
	if len(definitions) > 0 && !provider.SupportsToolCalling(endpoint) {
		definitions = nil
	}
	if err := writeChunk(map[string]any{"type": "start-step"}); err != nil {
		return
	}

	response := strings.Builder{}
	historyHead, hasHistoryHead := assistantUIParentUUID(outputParent)
	persistIncomplete := func() {
		if response.Len() == 0 && len(toolParts) == 0 {
			return
		}
		_ = a.persistAssistantUIAssistantAtPartsStatus(c, conversationID, outputParent, assistantMessageID, response.String(), citations, toolParts, writeTiming(), "incomplete")
	}
	if len(definitions) > 0 && provider.SupportsToolCalling(endpoint) {
		var toolHistory []provider.ToolMessage
		var historyErr error
		if hasHistoryHead {
			toolHistory, historyErr = a.conversationToolHistoryFromHead(c, conversationID, historyHead)
		} else {
			toolHistory, historyErr = a.conversationToolHistory(c, conversationID)
		}
		if historyErr != nil {
			persistIncomplete()
			_ = writeChunk(map[string]any{"type": "error", "errorText": historyErr.Error()})
			return
		}
		toolHistory = append([]provider.ToolMessage{{Role: "system", Content: chatToolInstructions()}}, toolHistory...)
		if len(citations) > 0 {
			toolHistory = append([]provider.ToolMessage{{Role: "system", Content: citationPrompt(citations)}}, toolHistory...)
		}
		requiresAction, streamErr := a.streamAssistantUIWithTools(c, principal.UserID, organizationID, conversationID, &outputParent, endpoint, toolHistory, definitions, bindings, writeChunk, &response, assistantMessageID, textID, &toolParts)
		if streamErr != nil {
			persistIncomplete()
			_ = writeChunk(map[string]any{"type": "error", "errorText": streamErr.Error()})
			return
		}
		if requiresAction {
			// Persist the paused Assistant UI message as well as the audit/event
			// row. The browser can safely PUT this exact id after the stream and a
			// reload still has a first-class approval part to render.
			_ = a.persistAssistantUIAssistantAtPartsStatus(c, conversationID, outputParent, assistantMessageID, response.String(), citations, toolParts, writeTiming(), "requires-action")
			_ = writeChunk(map[string]any{"type": "message-metadata", "messageMetadata": writeTiming()})
			_ = writeChunk(map[string]any{"type": "finish-step"})
			_ = writeChunk(map[string]any{"type": "finish", "finishReason": "tool-calls"})
			return
		}
	} else {
		var history []provider.Message
		var historyErr error
		if hasHistoryHead {
			history, historyErr = a.conversationHistoryFromHead(c, conversationID, historyHead)
		} else {
			history, historyErr = a.conversationHistory(c, conversationID)
		}
		if historyErr != nil {
			persistIncomplete()
			_ = writeChunk(map[string]any{"type": "error", "errorText": historyErr.Error()})
			return
		}
		if len(citations) > 0 {
			history = append([]provider.Message{{Role: "system", Content: citationPrompt(citations)}}, history...)
		}
		if err := writeChunk(map[string]any{"type": "text-start", "id": textID}); err != nil {
			return
		}
		streamErr := provider.StreamChat(c, endpoint, provider.ChatOptions{Messages: history, Model: endpoint.ChatModel}, func(delta string) error {
			response.WriteString(delta)
			return writeChunk(map[string]any{"type": "text-delta", "id": textID, "delta": delta})
		})
		if streamErr != nil {
			persistIncomplete()
			_ = writeChunk(map[string]any{"type": "error", "errorText": streamErr.Error()})
			return
		}
		_ = writeChunk(map[string]any{"type": "text-end", "id": textID})
	}

	timingMetadata := writeTiming()
	_ = writeChunk(map[string]any{"type": "message-metadata", "messageMetadata": timingMetadata})
	_ = writeChunk(map[string]any{"type": "finish-step"})
	_ = writeChunk(map[string]any{"type": "finish", "finishReason": "stop"})
	if response.Len() > 0 || len(toolParts) > 0 {
		_ = a.persistAssistantUIAssistantAtParts(c, conversationID, outputParent, assistantMessageID, response.String(), citations, toolParts, timingMetadata)
	}
	_, _ = a.DB.ExecContext(c, `UPDATE conversations SET endpoint_id = $2, updated_at = now() WHERE id = $1`, conversationID, endpointID)
	_ = start
}

type assistantUserMessage struct {
	ID       string
	Text     string
	ParentID string
}

func parseAssistantUIMessages(raw []json.RawMessage) []assistantUIMessage {
	result := make([]assistantUIMessage, 0, len(raw))
	for _, item := range raw {
		var message assistantUIMessage
		if json.Unmarshal(item, &message) == nil {
			result = append(result, message)
		}
	}
	return result
}

func latestAssistantUserMessage(messages []assistantUIMessage) *assistantUserMessage {
	for index := len(messages) - 1; index >= 0; index-- {
		if messages[index].Role != "user" {
			continue
		}
		for _, rawPart := range messages[index].Parts {
			var part assistantUIPart
			if json.Unmarshal(rawPart, &part) == nil && part.Type == "text" && strings.TrimSpace(part.Text) != "" {
				parentID := ""
				if index > 0 {
					parentID = messages[index-1].ID
				}
				return &assistantUserMessage{ID: messages[index].ID, Text: part.Text, ParentID: parentID}
			}
		}
	}
	return nil
}

func findAssistantUIApproval(messages []assistantUIMessage) *assistantUIApprovalResponse {
	if len(messages) == 0 {
		return nil
	}
	// Approval responses are appended to the assistant tool-call message. Only
	// inspect the current tail; scanning the entire history would replay an old
	// approval every time a later user turn is sent.
	for _, rawPart := range messages[len(messages)-1].Parts {
		var part assistantUIPart
		if json.Unmarshal(rawPart, &part) != nil {
			continue
		}
		if part.Type == "tool-approval-response" {
			approved := false
			if part.Approved != nil {
				approved = *part.Approved
			}
			if part.Approval != nil && part.Approval.Approved != nil {
				approved = *part.Approval.Approved
			}
			approvalID := part.ApprovalID
			if part.Approval != nil {
				approvalID = firstAssistantUIString(approvalID, part.Approval.ID)
			}
			return &assistantUIApprovalResponse{MessageID: messages[len(messages)-1].ID, ApprovalID: approvalID, CallID: part.ToolCallID, ToolName: part.ToolName, Arguments: part.Input, Approved: approved, Reason: firstAssistantUIString(part.Reason, part.ErrorText)}
		}
		if part.Approval == nil || part.Approval.ID == "" || part.Approval.Approved == nil || part.State != "approval-responded" {
			continue
		}
		return &assistantUIApprovalResponse{MessageID: messages[len(messages)-1].ID, ApprovalID: part.Approval.ID, CallID: part.ToolCallID, ToolName: part.ToolName, Arguments: part.Input, Approved: *part.Approval.Approved, Reason: part.Approval.Reason}
	}
	return nil
}

func (a *App) persistAssistantUIUser(ctx context.Context, conversationID uuid.UUID, message assistantUserMessage) error {
	if message.ID != "" {
		var exists bool
		if err := a.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1 AND ui_message->>'id' = $2)`, conversationID, message.ID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return nil
		}
	}
	parentID, err := a.assistantUIParentID(ctx, conversationID, message.ParentID)
	if err != nil {
		return err
	}
	if parentID == nil {
		head, headErr := a.conversationHead(ctx, conversationID)
		if headErr != nil {
			return headErr
		}
		parentID = head
	}
	_, err = a.DB.ExecContext(ctx, `
		INSERT INTO messages (conversation_id, role, content, format, ui_message, parent_id, run_status, updated_at)
		VALUES ($1, 'user', $2, 'ai-sdk-ui', jsonb_build_object('id', $3, 'role', 'user', 'parts', jsonb_build_array(jsonb_build_object('type', 'text', 'text', $2))), $4, 'complete', now())
	`, conversationID, message.Text, message.ID, parentID)
	if err != nil {
		return err
	}
	_, _ = a.DB.ExecContext(ctx, `UPDATE conversations SET title = CASE WHEN title = $2 THEN $3 ELSE title END, updated_at = now() WHERE id = $1`, conversationID, defaultConversationTitle, conversationTitle(message.Text))
	return nil
}

// persistAssistantUITextMessage keeps the voice runtime and any remaining
// internal provider callers on the same UI-message representation as the HTTP
// Assistant UI stream. The legacy role/content columns remain populated for
// provider history and backwards-compatible reads.
func (a *App) persistAssistantUITextMessage(ctx context.Context, conversationID uuid.UUID, role, content string, citations []models.Citation) (uuid.UUID, error) {
	messageID := uuid.New()
	parentID, err := a.conversationHead(ctx, conversationID)
	if err != nil {
		return uuid.Nil, err
	}
	parts := []map[string]any{{"type": "text", "text": content}}
	for _, citation := range citations {
		parts = append(parts, a.assistantUICitationPart(ctx, citation))
	}
	payload, err := json.Marshal(map[string]any{"id": messageID.String(), "role": role, "parts": parts})
	if err != nil {
		return uuid.Nil, err
	}
	_, err = a.DB.ExecContext(ctx, `
		INSERT INTO messages (id, conversation_id, role, content, citations, format, ui_message, parent_id, run_status, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'ai-sdk-ui', $6, $7, 'complete', now())
	`, messageID, conversationID, role, content, jsonRaw(citations), payload, parentID)
	return messageID, err
}

func assistantUIToolMessage(messageID uuid.UUID, event chatToolEvent) map[string]any {
	return map[string]any{
		"id":       messageID.String(),
		"role":     "assistant",
		"parts":    []any{assistantUIDynamicToolPart(event)},
		"metadata": map[string]any{"runStatus": assistantUIRunStatusForTool(event)},
	}
}

func assistantUIDynamicToolPart(event chatToolEvent) map[string]any {
	state := "output-available"
	part := map[string]any{
		"type":       "dynamic-tool",
		"toolName":   event.ToolName,
		"toolCallId": event.CallID,
		"input":      event.Arguments,
		"state":      state,
		"dynamic":    true,
	}
	switch event.Status {
	case "awaiting_approval":
		part["state"] = "approval-requested"
		part["approval"] = map[string]any{"id": event.ApprovalID}
	case "declined":
		part["state"] = "output-denied"
		part["errorText"] = event.Error
		part["approval"] = map[string]any{"id": event.ApprovalID, "approved": false, "reason": event.Error}
	case "failed":
		part["state"] = "output-error"
		part["errorText"] = event.Error
	case "running":
		part["state"] = "input-available"
		if event.ApprovalID != "" {
			part["approval"] = map[string]any{"id": event.ApprovalID, "approved": true}
		}
	default:
		result := firstNonEmptyChatToolString(event.Result, event.ResultPreview)
		part["output"] = assistantUIJSONValue(result)
		if event.ApprovalID != "" {
			part["approval"] = map[string]any{"id": event.ApprovalID, "approved": true}
		}
	}
	return part
}

func assistantUIJSONValue(value string) any {
	if json.Valid([]byte(value)) {
		return json.RawMessage(value)
	}
	return value
}

func assistantUIApprovalToolParts(messages []assistantUIMessage) []map[string]any {
	if len(messages) == 0 {
		return nil
	}
	parts := make([]map[string]any, 0)
	for _, rawPart := range messages[len(messages)-1].Parts {
		var part map[string]any
		if json.Unmarshal(rawPart, &part) != nil {
			continue
		}
		partType, _ := part["type"].(string)
		if partType == "dynamic-tool" || strings.HasPrefix(partType, "tool-") {
			parts = append(parts, part)
		}
	}
	return parts
}

func assistantUIMessageContainsApproval(raw []byte, approvalID, callID string) bool {
	var message struct {
		Parts []struct {
			Type     string `json:"type"`
			ToolCall string `json:"toolCallId"`
			State    string `json:"state"`
			Approval *struct {
				ID string `json:"id"`
			} `json:"approval"`
		} `json:"parts"`
	}
	if json.Unmarshal(raw, &message) != nil {
		return false
	}
	for _, part := range message.Parts {
		if part.Type != "dynamic-tool" && !strings.HasPrefix(part.Type, "tool-") {
			continue
		}
		if part.ToolCall == callID && part.State == "approval-requested" && part.Approval != nil && part.Approval.ID == approvalID {
			return true
		}
	}
	return false
}

func replaceAssistantUIToolPart(parts []map[string]any, event chatToolEvent) []map[string]any {
	for index, part := range parts {
		callID, _ := part["toolCallId"].(string)
		if callID == event.CallID {
			parts[index] = assistantUIDynamicToolPart(event)
			return parts
		}
	}
	return append(parts, assistantUIDynamicToolPart(event))
}

func (a *App) persistAssistantUIAssistantAt(ctx context.Context, conversationID uuid.UUID, parentID any, messageID, content string, citations []models.Citation, metadata map[string]any) error {
	return a.persistAssistantUIAssistantAtParts(ctx, conversationID, parentID, messageID, content, citations, nil, metadata)
}

func (a *App) persistAssistantUIAssistantAtStatus(ctx context.Context, conversationID uuid.UUID, parentID any, messageID, content string, citations []models.Citation, metadata map[string]any, runStatus string) error {
	return a.persistAssistantUIAssistantAtPartsStatus(ctx, conversationID, parentID, messageID, content, citations, nil, metadata, runStatus)
}

func (a *App) persistAssistantUIAssistantAtParts(ctx context.Context, conversationID uuid.UUID, parentID any, messageID, content string, citations []models.Citation, toolParts []map[string]any, metadata map[string]any) error {
	return a.persistAssistantUIAssistantAtPartsStatus(ctx, conversationID, parentID, messageID, content, citations, toolParts, metadata, "complete")
}

func (a *App) persistAssistantUIAssistantAtPartsStatus(ctx context.Context, conversationID uuid.UUID, parentID any, messageID, content string, citations []models.Citation, toolParts []map[string]any, metadata map[string]any, runStatus string) error {
	parts := make([]any, 0, 1+len(toolParts)+len(citations))
	if strings.TrimSpace(content) != "" {
		parts = append(parts, map[string]any{"type": "text", "text": content})
	}
	for _, toolPart := range toolParts {
		parts = append(parts, toolPart)
	}
	for _, citation := range citations {
		parts = append(parts, a.assistantUICitationPart(ctx, citation))
	}
	payload := map[string]any{"id": messageID, "role": "assistant", "parts": parts}
	messageMetadata := map[string]any{"runStatus": runStatus}
	for key, value := range metadata {
		messageMetadata[key] = value
	}
	if len(messageMetadata) > 0 {
		payload["metadata"] = messageMetadata
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = a.DB.ExecContext(ctx, `
		INSERT INTO messages (id, conversation_id, role, content, citations, format, ui_message, parent_id, run_status, updated_at)
		VALUES ($1, $2, 'assistant', $3, $4, 'ai-sdk-ui', $5, $6, $7, now())
		ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, citations = EXCLUDED.citations, format = EXCLUDED.format, ui_message = EXCLUDED.ui_message, parent_id = EXCLUDED.parent_id, run_status = EXCLUDED.run_status, updated_at = now()
	`, messageID, conversationID, content, jsonRaw(citations), raw, parentID, firstAssistantUIString(runStatus, "complete"))
	return err
}

func (a *App) conversationHead(ctx context.Context, conversationID uuid.UUID) (any, error) {
	var id uuid.UUID
	err := a.DB.QueryRowContext(ctx, `SELECT id FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, conversationID).Scan(&id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return id, err
}

func (a *App) assistantUICitationPart(ctx context.Context, citation models.Citation) map[string]any {
	metadata := map[string]any{
		"justai": map[string]any{
			"kind":       citation.Kind,
			"locator":    citation.Locator,
			"snippet":    citation.Snippet,
			"chunkIndex": citation.ChunkIndex,
		},
	}
	if citation.Kind == "knowledge" {
		var sourceURL sql.NullString
		if err := a.DB.QueryRowContext(ctx, `SELECT source_url FROM knowledge_sources WHERE id = $1`, citation.ResourceID).Scan(&sourceURL); err == nil && sourceURL.Valid && strings.TrimSpace(sourceURL.String) != "" {
			return map[string]any{
				"type":             "source-url",
				"sourceId":         citation.ResourceID.String(),
				"url":              sourceURL.String,
				"title":            citation.Title,
				"providerMetadata": metadata,
			}
		}
	}
	mediaType := "text/plain"
	if citation.Kind == "knowledge" {
		mediaType = "text/markdown"
	}
	return map[string]any{
		"type":             "source-document",
		"sourceId":         citation.ResourceID.String(),
		"mediaType":        mediaType,
		"title":            citation.Title,
		"providerMetadata": metadata,
	}
}

func (a *App) resumeAssistantUIApproval(ctx context.Context, userID, organizationID, conversationID uuid.UUID, approval assistantUIApprovalResponse) (*chatToolEvent, uuid.UUID, error) {
	if approval.ApprovalID == "" {
		return nil, uuid.Nil, fmt.Errorf("approval id is required")
	}
	if approval.MessageID == "" {
		return nil, uuid.Nil, fmt.Errorf("approval message id is required")
	}
	var approvalMessage []byte
	if err := a.DB.QueryRowContext(ctx, `
		SELECT ui_message
		FROM messages
		WHERE conversation_id = $1 AND role = 'assistant' AND ui_message->>'id' = $2
		LIMIT 1
	`, conversationID, approval.MessageID).Scan(&approvalMessage); err != nil {
		if err == sql.ErrNoRows {
			return nil, uuid.Nil, fmt.Errorf("approval message is not part of this conversation")
		}
		return nil, uuid.Nil, err
	}
	if !assistantUIMessageContainsApproval(approvalMessage, approval.ApprovalID, approval.CallID) {
		return nil, uuid.Nil, fmt.Errorf("approval message does not match the pending tool")
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT id, content FROM messages WHERE conversation_id = $1 AND role = 'tool' ORDER BY created_at DESC LIMIT 100`, conversationID)
	if err != nil {
		return nil, uuid.Nil, err
	}
	defer rows.Close()
	var messageID uuid.UUID
	var event chatToolEvent
	found := false
	for rows.Next() {
		var id uuid.UUID
		var content string
		if err := rows.Scan(&id, &content); err != nil {
			return nil, uuid.Nil, err
		}
		var candidate chatToolEvent
		if json.Unmarshal([]byte(content), &candidate) == nil && candidate.ApprovalID == approval.ApprovalID && candidate.Status == "awaiting_approval" {
			messageID, event, found = id, candidate, true
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, uuid.Nil, err
	}
	if !found {
		return nil, uuid.Nil, fmt.Errorf("approval is no longer pending")
	}
	if approval.CallID == "" || approval.CallID != event.CallID {
		return nil, uuid.Nil, fmt.Errorf("approval call does not match the pending tool")
	}
	if approval.ToolName == "" || approval.ToolName != event.ToolName {
		return nil, uuid.Nil, fmt.Errorf("approval tool does not match the pending tool")
	}
	expected, _ := json.Marshal(event.Arguments)
	actual, _ := json.Marshal(approval.Arguments)
	if string(expected) != string(actual) {
		return nil, uuid.Nil, fmt.Errorf("approval arguments do not match the pending tool")
	}
	if event.ServerID == uuid.Nil {
		return nil, uuid.Nil, fmt.Errorf("pending tool server is invalid")
	}
	attached, err := a.conversationHasMCPServer(ctx, userID, organizationID, conversationID, event.ServerID)
	if err != nil {
		return nil, uuid.Nil, err
	}
	if !attached {
		return nil, uuid.Nil, fmt.Errorf("MCP server is no longer attached to this conversation")
	}
	if !approval.Approved {
		event.Status = "declined"
		event.Error = firstAssistantUIString(approval.Reason, "declined by user")
		a.updateChatToolEvent(ctx, conversationID, messageID, event)
		a.auditVoiceTool(ctx, userID, organizationID, "chat.mcp.approval", event.ServerID, map[string]any{"conversationId": conversationID, "serverId": event.ServerID, "tool": event.ToolName, "approved": false, "reason": event.Error})
		return &event, messageID, nil
	}
	bindings := a.discoverConversationTools(ctx, userID, organizationID, conversationID).Bindings
	binding, ok := bindings[event.ToolName]
	if !ok {
		return nil, uuid.Nil, fmt.Errorf("the requested MCP tool is no longer available")
	}
	if binding.ServerID != event.ServerID || binding.ToolName != event.ToolName || !binding.RequiresApproval {
		return nil, uuid.Nil, fmt.Errorf("the MCP tool approval policy has changed")
	}
	result, callErr := a.executeChatMCPTool(ctx, userID, organizationID, conversationID, binding, event.Arguments)
	if callErr != nil {
		event.Status = "failed"
		event.Error = callErr.Error()
		a.updateChatToolEvent(ctx, conversationID, messageID, event)
		return &event, messageID, nil
	}
	event.Status = "completed"
	event.Result = string(result)
	event.ResultPreview = toolResultPreview(result)
	event.Error = ""
	a.updateChatToolEvent(ctx, conversationID, messageID, event)
	a.auditVoiceTool(ctx, userID, organizationID, "chat.mcp.approval", event.ServerID, map[string]any{"conversationId": conversationID, "serverId": event.ServerID, "tool": event.ToolName, "approved": true})
	return &event, messageID, nil
}

func (a *App) streamAssistantUIWithTools(ctx context.Context, userID, organizationID, conversationID uuid.UUID, parentID *any, endpoint provider.Endpoint, history []provider.ToolMessage, definitions []provider.ToolDefinition, bindings map[string]voiceToolBinding, writeChunk func(any) error, response *strings.Builder, messageID, textID string, toolParts *[]map[string]any) (bool, error) {
	toolMessages := append([]provider.ToolMessage(nil), history...)
	textStarted := false
	for round := 1; round <= 4; round++ {
		if round > 1 {
			if err := writeChunk(map[string]any{"type": "start-step"}); err != nil {
				return false, err
			}
		}
		var roundResponse strings.Builder
		calls := []provider.ToolCall{}
		err := provider.StreamChatWithTools(ctx, endpoint, provider.ToolChatOptions{Messages: toolMessages, Tools: definitions, Model: endpoint.ChatModel}, func(event provider.ToolChatEvent) error {
			if event.Delta == "" {
				calls = append(calls, event.ToolCalls...)
				return nil
			}
			if !textStarted {
				textStarted = true
				if err := writeChunk(map[string]any{"type": "text-start", "id": textID}); err != nil {
					return err
				}
			}
			roundResponse.WriteString(event.Delta)
			response.WriteString(event.Delta)
			return writeChunk(map[string]any{"type": "text-delta", "id": textID, "delta": event.Delta})
		})
		if err != nil {
			return false, err
		}
		if len(calls) == 0 {
			if textStarted {
				if err := writeChunk(map[string]any{"type": "text-end", "id": textID}); err != nil {
					return false, err
				}
				textStarted = false
			}
			return false, nil
		}
		if textStarted {
			if err := writeChunk(map[string]any{"type": "text-end", "id": textID}); err != nil {
				return false, err
			}
			textStarted = false
		}
		toolMessages = append(toolMessages, provider.ToolMessage{Role: "assistant", Content: roundResponse.String(), ToolCalls: calls})
		for _, call := range calls {
			arguments := map[string]any{}
			if strings.TrimSpace(call.Arguments) != "" {
				if err := json.Unmarshal([]byte(call.Arguments), &arguments); err != nil {
					errorText := "The MCP tool arguments were invalid JSON."
					event := chatToolEvent{Kind: "mcp_tool", Status: "failed", Round: round, ToolName: call.Name, CallID: call.ID, Error: errorText}
					messageRowID := a.persistChatToolEventAt(ctx, conversationID, dereferenceAssistantUIParent(parentID), event)
					if messageRowID != uuid.Nil {
						*parentID = messageRowID
					}
					*toolParts = append(*toolParts, assistantUIDynamicToolPart(event))
					_ = writeChunk(map[string]any{"type": "tool-input-error", "toolCallId": call.ID, "toolName": call.Name, "input": map[string]any{}, "errorText": errorText, "dynamic": true, "toolMetadata": map[string]any{"messageId": messageRowID.String()}})
					toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: errorText})
					continue
				}
			}
			binding, exists := bindings[call.Name]
			if !exists {
				errorText := "The requested MCP tool is not available."
				event := chatToolEvent{Kind: "mcp_tool", Status: "failed", Round: round, ToolName: call.Name, CallID: call.ID, Arguments: arguments, Error: errorText}
				messageRowID := a.persistChatToolEventAt(ctx, conversationID, dereferenceAssistantUIParent(parentID), event)
				if messageRowID != uuid.Nil {
					*parentID = messageRowID
				}
				*toolParts = append(*toolParts, assistantUIDynamicToolPart(event))
				_ = writeChunk(map[string]any{"type": "tool-input-error", "toolCallId": call.ID, "toolName": call.Name, "input": arguments, "errorText": errorText, "dynamic": true, "toolMetadata": map[string]any{"messageId": messageRowID.String()}})
				toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: errorText})
				continue
			}
			event := chatToolEvent{Kind: "mcp_tool", Status: "running", Round: round, ServerID: binding.ServerID, ServerName: binding.ServerName, ToolName: binding.ToolName, CallID: call.ID, Arguments: arguments}
			messageRowID := a.persistChatToolEventAt(ctx, conversationID, dereferenceAssistantUIParent(parentID), event)
			if messageRowID != uuid.Nil {
				*parentID = messageRowID
			}
			if err := writeChunk(map[string]any{"type": "tool-input-available", "toolCallId": call.ID, "toolName": call.Name, "input": arguments, "dynamic": true, "toolMetadata": map[string]any{"serverId": binding.ServerID.String(), "serverName": binding.ServerName, "messageId": messageRowID.String()}}); err != nil {
				return false, err
			}
			if binding.RequiresApproval {
				event.Status = "awaiting_approval"
				event.ApprovalID = uuid.NewString()
				a.updateChatToolEvent(ctx, conversationID, messageRowID, event)
				*toolParts = append(*toolParts, assistantUIDynamicToolPart(event))
				if err := writeChunk(map[string]any{"type": "tool-approval-request", "approvalId": event.ApprovalID, "toolCallId": call.ID}); err != nil {
					return false, err
				}
				return true, nil
			}
			a.auditVoiceTool(ctx, userID, organizationID, "chat.mcp.auto_approved", binding.ServerID, map[string]any{
				"conversationId": conversationID,
				"serverId":       binding.ServerID,
				"serverName":     binding.ServerName,
				"tool":           binding.ToolName,
				"arguments":      arguments,
				"reason":         "trusted_read_only",
			})
			result, callErr := a.executeChatMCPTool(ctx, userID, organizationID, conversationID, binding, arguments)
			if callErr != nil {
				event.Status = "failed"
				event.Error = callErr.Error()
				a.updateChatToolEvent(ctx, conversationID, messageRowID, event)
				*toolParts = append(*toolParts, assistantUIDynamicToolPart(event))
				_ = writeChunk(map[string]any{"type": "tool-output-error", "toolCallId": call.ID, "errorText": callErr.Error(), "dynamic": true})
				toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: "The MCP tool failed: " + callErr.Error()})
				continue
			}
			event.Status = "completed"
			event.Result = string(result)
			event.ResultPreview = toolResultPreview(result)
			a.updateChatToolEvent(ctx, conversationID, messageRowID, event)
			*toolParts = append(*toolParts, assistantUIDynamicToolPart(event))
			if err := writeChunk(map[string]any{"type": "tool-output-available", "toolCallId": call.ID, "output": json.RawMessage(result), "dynamic": true}); err != nil {
				return false, err
			}
			toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: string(result)})
		}
		if round == 4 {
			message := "\n\nI stopped after four MCP tool rounds to keep this turn bounded."
			if !textStarted {
				textStarted = true
				_ = writeChunk(map[string]any{"type": "text-start", "id": textID})
			}
			response.WriteString(message)
			_ = writeChunk(map[string]any{"type": "text-delta", "id": textID, "delta": message})
			_ = writeChunk(map[string]any{"type": "text-end", "id": textID})
			return false, nil
		}
		if err := writeChunk(map[string]any{"type": "finish-step"}); err != nil {
			return false, err
		}
	}
	return false, nil
}

func (a *App) listAssistantUIMessages(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	conversationID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid conversation id"))
		return
	}
	var exists bool
	if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND organization_id = $3)`, conversationID, principal.UserID, organizationID).Scan(&exists); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !exists {
		writeError(c, http.StatusNotFound, fmt.Errorf("conversation not found"))
		return
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT m.id, m.role, m.content, m.citations, m.format, m.ui_message, m.parent_id,
		       COALESCE(parent.ui_message->>'id', ''), m.run_status, m.feedback
		FROM messages m
		LEFT JOIN messages parent ON parent.id = m.parent_id
		WHERE m.conversation_id = $1
		ORDER BY m.created_at ASC, m.id ASC
		LIMIT 500
	`, conversationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	repository := assistantUIRepository{Messages: []assistantUIRepositoryItem{}}
	var pendingTools *assistantUIToolGroup
	flushPendingTools := func() {
		if pendingTools == nil {
			return
		}
		pendingTools.item.LegacyTool = true
		repository.Messages = append(repository.Messages, pendingTools.item)
		repository.HeadID = pendingTools.headID
		pendingTools = nil
	}
	for rows.Next() {
		var id uuid.UUID
		var role, content, format, runStatus string
		var citations, rawMessage []byte
		var parentID sql.NullString
		var parentUIID sql.NullString
		var feedback sql.NullString
		if err := rows.Scan(&id, &role, &content, &citations, &format, &rawMessage, &parentID, &parentUIID, &runStatus, &feedback); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		var message map[string]any
		if len(rawMessage) > 0 {
			_ = json.Unmarshal(rawMessage, &message)
		}
		if message == nil {
			message = a.legacyAssistantUIMessage(c, id, role, content, citations, runStatus, feedback)
		} else {
			metadata, _ := message["metadata"].(map[string]any)
			if metadata == nil {
				metadata = map[string]any{}
			}
			if runStatus != "" {
				metadata["runStatus"] = runStatus
			}
			if feedback.Valid {
				metadata["feedback"] = feedback.String
			}
			if len(metadata) > 0 {
				message["metadata"] = metadata
			}
		}
		assistantUIAppendMissingCitations(c, message, citations, a)
		parent := ""
		if parentUIID.Valid && parentUIID.String != "" {
			parent = parentUIID.String
		} else if parentID.Valid {
			parent = parentID.String
		}
		if isAssistantUIMCPToolRow(role, content) {
			messageID, _ := message["id"].(string)
			if messageID == "" {
				messageID = id.String()
				message["id"] = messageID
			}
			if pendingTools == nil {
				pendingTools = &assistantUIToolGroup{
					item:   assistantUIRepositoryItem{ParentID: parent, Message: message, LegacyTool: true},
					headID: messageID,
				}
			} else {
				mergeAssistantUIToolMessage(pendingTools.item.Message, message)
				pendingTools.headID = messageID
			}
			continue
		}
		flushPendingTools()
		repository.Messages = append(repository.Messages, assistantUIRepositoryItem{ParentID: parent, Message: message})
		if messageID, ok := message["id"].(string); ok && messageID != "" {
			repository.HeadID = messageID
		} else {
			repository.HeadID = id.String()
		}
	}
	flushPendingTools()
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	filterAssistantUIRepositoryTools(&repository)
	c.JSON(http.StatusOK, gin.H{"repository": repository})
}

func assistantUIAppendMissingCitations(ctx context.Context, message map[string]any, raw []byte, app *App) {
	if len(raw) == 0 {
		return
	}
	var citations []models.Citation
	if json.Unmarshal(raw, &citations) != nil || len(citations) == 0 {
		return
	}
	parts, _ := message["parts"].([]any)
	present := make(map[string]struct{})
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		if sourceID, ok := part["sourceId"].(string); ok && sourceID != "" {
			present[sourceID] = struct{}{}
		}
	}
	for _, citation := range citations {
		id := citation.ResourceID.String()
		if _, ok := present[id]; ok {
			continue
		}
		parts = append(parts, app.assistantUICitationPart(ctx, citation))
		present[id] = struct{}{}
	}
	message["parts"] = parts
}

func filterAssistantUIRepositoryTools(repository *assistantUIRepository) {
	canonicalCallIDs := make(map[string]struct{})
	for _, item := range repository.Messages {
		if item.LegacyTool {
			continue
		}
		for _, callID := range assistantUIToolCallIDs(item.Message) {
			canonicalCallIDs[callID] = struct{}{}
		}
	}
	if len(canonicalCallIDs) == 0 {
		return
	}
	legacyParents := make(map[string]string)
	for _, item := range repository.Messages {
		if !item.LegacyTool {
			continue
		}
		if id, ok := item.Message["id"].(string); ok && id != "" {
			legacyParents[id] = item.ParentID
		}
	}
	filtered := make([]assistantUIRepositoryItem, 0, len(repository.Messages))
	for _, item := range repository.Messages {
		if !item.LegacyTool {
			item.ParentID = assistantUIVisibleParent(item.ParentID, legacyParents)
			filtered = append(filtered, item)
			continue
		}
		parts, _ := item.Message["parts"].([]any)
		kept := make([]any, 0, len(parts))
		for _, rawPart := range parts {
			part, _ := rawPart.(map[string]any)
			callID, _ := part["toolCallId"].(string)
			if _, duplicate := canonicalCallIDs[callID]; duplicate {
				continue
			}
			kept = append(kept, rawPart)
		}
		if len(kept) == 0 {
			continue
		}
		item.ParentID = assistantUIVisibleParent(item.ParentID, legacyParents)
		item.Message["parts"] = kept
		filtered = append(filtered, item)
	}
	repository.Messages = filtered
	if len(filtered) == 0 {
		repository.HeadID = ""
		return
	}
	last := filtered[len(filtered)-1].Message
	if id, ok := last["id"].(string); ok {
		repository.HeadID = id
	}
}

func assistantUIVisibleParent(parent string, removedParents map[string]string) string {
	visited := make(map[string]struct{})
	for parent != "" {
		if _, seen := visited[parent]; seen {
			return ""
		}
		visited[parent] = struct{}{}
		replacement, removed := removedParents[parent]
		if !removed {
			return parent
		}
		parent = replacement
	}
	return ""
}

func assistantUIToolCallIDs(message map[string]any) []string {
	parts, _ := message["parts"].([]any)
	ids := make([]string, 0)
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		partType, _ := part["type"].(string)
		if partType != "dynamic-tool" && !strings.HasPrefix(partType, "tool-") {
			continue
		}
		if callID, ok := part["toolCallId"].(string); ok && callID != "" {
			ids = append(ids, callID)
		}
	}
	return ids
}

func (a *App) legacyAssistantUIMessage(ctx context.Context, id uuid.UUID, role, content string, citations []byte, runStatus string, feedback sql.NullString) map[string]any {
	if role == "tool" {
		var event chatToolEvent
		if json.Unmarshal([]byte(content), &event) == nil && event.Kind == "mcp_tool" {
			state := "output-available"
			part := map[string]any{"type": "dynamic-tool", "toolName": event.ToolName, "toolCallId": event.CallID, "input": event.Arguments, "state": state, "dynamic": true}
			switch event.Status {
			case "awaiting_approval":
				part["state"] = "approval-requested"
				part["approval"] = map[string]any{"id": event.ApprovalID}
			case "declined":
				part["state"] = "output-denied"
				part["errorText"] = event.Error
				part["approval"] = map[string]any{"id": event.ApprovalID, "approved": false, "reason": event.Error}
			case "failed":
				part["state"] = "output-error"
				part["errorText"] = event.Error
			case "running":
				part["state"] = "input-available"
			default:
				part["output"] = assistantUIJSONValue(firstNonEmptyChatToolString(event.Result, event.ResultPreview))
				if event.ApprovalID != "" {
					part["approval"] = map[string]any{"id": event.ApprovalID, "approved": true}
				}
			}
			return map[string]any{"id": id.String(), "role": "assistant", "parts": []any{part}}
		}
	}
	parts := []any{}
	if content != "" {
		parts = append(parts, map[string]any{"type": "text", "text": content})
	}
	if len(citations) > 0 {
		var items []models.Citation
		if json.Unmarshal(citations, &items) == nil {
			for _, citation := range items {
				parts = append(parts, a.assistantUICitationPart(ctx, citation))
			}
		}
	}
	message := map[string]any{"id": id.String(), "role": role, "parts": parts}
	metadata := map[string]any{}
	if runStatus != "" {
		metadata["runStatus"] = runStatus
	}
	if feedback.Valid {
		metadata["feedback"] = feedback.String
	}
	if len(metadata) > 0 {
		message["metadata"] = metadata
	}
	return message
}

func (a *App) upsertAssistantMessage(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	conversationID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid conversation id"))
		return
	}
	messageKey := strings.TrimSpace(c.Param("messageId"))
	if messageKey == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("message id is required"))
		return
	}
	if !a.conversationOwnedBy(c, conversationID, principal.UserID, organizationID) {
		writeError(c, http.StatusNotFound, fmt.Errorf("conversation not found"))
		return
	}
	var body struct {
		ParentID string         `json:"parentId"`
		Message  map[string]any `json:"message"`
	}
	if !decodeJSON(c, &body) {
		return
	}
	if body.Message == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("message is required"))
		return
	}
	bodyMessageID, _ := body.Message["id"].(string)
	if bodyMessageID == "" || bodyMessageID != messageKey {
		writeError(c, http.StatusBadRequest, fmt.Errorf("message id does not match the request path"))
		return
	}
	raw, err := json.Marshal(body.Message)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	role, _ := body.Message["role"].(string)
	if role != "user" && role != "assistant" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("message role must be user or assistant"))
		return
	}
	content := assistantUIText(body.Message)
	runStatus := assistantUIMessageRunStatus(body.Message)
	parent, err := a.assistantUIParentID(c, conversationID, body.ParentID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	messageID, lookupErr := a.assistantUIMessageRecordID(c, conversationID, messageKey)
	if lookupErr == sql.ErrNoRows {
		if parsedID, parseErr := uuid.Parse(messageKey); parseErr == nil {
			messageID = parsedID
		} else {
			messageID = uuid.New()
		}
	} else if lookupErr != nil {
		writeError(c, http.StatusInternalServerError, lookupErr)
		return
	}
	_, err = a.DB.ExecContext(c, `
		INSERT INTO messages AS existing (id, conversation_id, role, content, format, ui_message, parent_id, run_status, updated_at)
		VALUES ($1, $2, $3, $4, 'ai-sdk-ui', $5, $6, $7, now())
		ON CONFLICT (id) DO UPDATE SET
			role = EXCLUDED.role,
			content = EXCLUDED.content,
			format = EXCLUDED.format,
			ui_message = EXCLUDED.ui_message,
			parent_id = CASE
				WHEN existing.parent_id IS NOT NULL AND EXISTS (
					SELECT 1 FROM messages parent_tool
					WHERE parent_tool.id = existing.parent_id AND parent_tool.role = 'tool'
				) THEN existing.parent_id
				ELSE EXCLUDED.parent_id
			END,
			run_status = EXCLUDED.run_status,
			updated_at = now()
	`, messageID, conversationID, firstAssistantUIString(role, "assistant"), content, raw, parent, runStatus)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) assistantUIMessageRecordID(ctx context.Context, conversationID uuid.UUID, messageKey string) (uuid.UUID, error) {
	var id uuid.UUID
	if parsed, err := uuid.Parse(messageKey); err == nil {
		err = a.DB.QueryRowContext(ctx, `
			SELECT id FROM messages
			WHERE conversation_id = $1 AND (id = $2 OR ui_message->>'id' = $3)
			LIMIT 1
		`, conversationID, parsed, messageKey).Scan(&id)
		return id, err
	}
	err := a.DB.QueryRowContext(ctx, `
		SELECT id FROM messages
		WHERE conversation_id = $1 AND ui_message->>'id' = $2
		LIMIT 1
	`, conversationID, messageKey).Scan(&id)
	return id, err
}

func (a *App) assistantUIParentID(ctx context.Context, conversationID uuid.UUID, parentKey string) (any, error) {
	if strings.TrimSpace(parentKey) == "" {
		return nil, nil
	}
	var id uuid.UUID
	if parsed, err := uuid.Parse(parentKey); err == nil {
		err = a.DB.QueryRowContext(ctx, `
			SELECT id FROM messages
			WHERE conversation_id = $1 AND (id = $2 OR ui_message->>'id' = $3)
			LIMIT 1
		`, conversationID, parsed, parentKey).Scan(&id)
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return id, err
	}
	err := a.DB.QueryRowContext(ctx, `
		SELECT id FROM messages
		WHERE conversation_id = $1 AND ui_message->>'id' = $2
		LIMIT 1
	`, conversationID, parentKey).Scan(&id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return id, err
}

func (a *App) updateAssistantMessage(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	conversationID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid conversation id"))
		return
	}
	messageKey := strings.TrimSpace(c.Param("messageId"))
	if messageKey == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("message id is required"))
		return
	}
	if !a.conversationOwnedBy(c, conversationID, principal.UserID, organizationID) {
		writeError(c, http.StatusNotFound, fmt.Errorf("conversation not found"))
		return
	}
	var body struct {
		Feedback *string `json:"feedback"`
	}
	if !decodeJSON(c, &body) {
		return
	}
	if body.Feedback == nil || (*body.Feedback != "positive" && *body.Feedback != "negative") {
		writeError(c, http.StatusBadRequest, fmt.Errorf("feedback must be positive or negative"))
		return
	}
	messageID, err := a.assistantUIMessageRecordID(c, conversationID, messageKey)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("message not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	result, err := a.DB.ExecContext(c, `UPDATE messages SET feedback = $3, updated_at = now() WHERE id = $1 AND conversation_id = $2 AND role = 'assistant'`, messageID, conversationID, *body.Feedback)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("message not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func assistantUIText(message map[string]any) string {
	parts, _ := message["parts"].([]any)
	var builder strings.Builder
	for _, raw := range parts {
		part, _ := raw.(map[string]any)
		if text, ok := part["text"].(string); ok {
			builder.WriteString(text)
		}
	}
	return builder.String()
}

func assistantUIMessageRunStatus(message map[string]any) string {
	metadata, _ := message["metadata"].(map[string]any)
	status, _ := metadata["runStatus"].(string)
	switch status {
	case "running", "requires-action", "complete", "incomplete":
		return status
	default:
		return "complete"
	}
}

func firstAssistantUIString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func dereferenceAssistantUIParent(parent *any) any {
	if parent == nil {
		return nil
	}
	return *parent
}

func assistantUIParentUUID(parent any) (uuid.UUID, bool) {
	switch value := parent.(type) {
	case uuid.UUID:
		return value, value != uuid.Nil
	case *uuid.UUID:
		if value != nil && *value != uuid.Nil {
			return *value, true
		}
	}
	return uuid.Nil, false
}

func (a *App) conversationOwnedBy(ctx context.Context, conversationID, userID, organizationID uuid.UUID) bool {
	var exists bool
	if err := a.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND organization_id = $3)`, conversationID, userID, organizationID).Scan(&exists); err != nil {
		return false
	}
	return exists
}
