package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"log/slog"
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
// standard AI SDK UIMessage objects, while assistantId/conversationId/
// endpointId/model are host-owned routing fields added by AssistantChatTransport.
type assistantUIRequest struct {
	Messages            []json.RawMessage `json:"messages"`
	AssistantID         string            `json:"assistantId"`
	ConversationID      string            `json:"conversationId"`
	EndpointID          string            `json:"endpointId"`
	Model               string            `json:"model"`
	RequestID           string            `json:"requestId"`
	UseMemory           bool              `json:"useMemory"`
	DeepContext         bool              `json:"deepContext"`
	InheritRepositories bool              `json:"inheritRepositories"`
}

func assistantUIRetrievalMode(deepContext bool) string {
	if deepContext {
		return "deep-context"
	}
	return "quick"
}

type assistantUIMessage struct {
	ID       string            `json:"id"`
	Role     string            `json:"role"`
	Parts    []json.RawMessage `json:"parts"`
	Metadata json.RawMessage   `json:"metadata"`
}

type assistantUIQuote struct {
	MessageID string `json:"messageId"`
	Text      string `json:"text"`
}

type assistantUIPart struct {
	Type       string               `json:"type"`
	Name       string               `json:"name"`
	ApprovalID string               `json:"approvalId"`
	Approved   *bool                `json:"approved"`
	Text       string               `json:"text"`
	Image      string               `json:"image"`
	URL        string               `json:"url"`
	Filename   string               `json:"filename"`
	MimeType   string               `json:"mimeType"`
	MediaType  string               `json:"mediaType"`
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

type assistantUIToolDisplayBinding struct {
	ServerID   uuid.UUID
	ServerName string
	IconURL    string
	ToolName   string
}

// assistantUIToolGroup is the read-side representation used while legacy
// role=tool rows are folded into one Assistant UI assistant message. The
// final row's id is retained so the next persisted row can still point at the
// same branch head through parentId.
type assistantUIToolGroup struct {
	item   assistantUIRepositoryItem
	headID string
}

// Keep the ceiling across approval continuations, not just inside one HTTP
// request. Otherwise every approval can restart the local round counter and a
// model that keeps proposing the same MCP call can run indefinitely.
const maxAssistantUIToolRounds = 4

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
	case "error":
		return 5
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
	return json.Unmarshal([]byte(content), &event) == nil && isChatToolEventKind(event.Kind) && event.CallID != ""
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
	requestMessages := parseAssistantUIMessages(request.Messages)
	approval := findAssistantUIApproval(requestMessages)
	if approval != nil && !a.featureEnabled(c, "mcp") {
		return
	}
	latestUser := latestAssistantUserMessage(requestMessages)
	if approval == nil && latestUser == nil {
		// Never create an empty conversation or forward an empty message list to
		// an OpenAI-compatible gateway. vLLM/LiteLLM commonly reports this as the
		// misleading "list index out of range" error instead of identifying the
		// malformed request.
		writeError(c, http.StatusBadRequest, fmt.Errorf("a non-empty user message is required"))
		return
	}
	conversationID, err := a.ensureConversation(c, principal.UserID, organizationID, request.ConversationID, request.AssistantID, request.InheritRepositories)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	savedAssistant, err := a.savedAssistantForConversation(c, conversationID, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if savedAssistant != nil {
		// The saved profile owns memory and deep-context defaults. Endpoint and
		// model remain user-selectable when the client explicitly sends them.
		request.UseMemory = savedAssistant.UseMemory
		if savedAssistant.DeepContext {
			request.DeepContext = true
		}
		if strings.TrimSpace(request.EndpointID) == "" && savedAssistant.EndpointID != nil {
			request.EndpointID = savedAssistant.EndpointID.String()
		}
		if strings.TrimSpace(request.Model) == "" {
			request.Model = savedAssistant.Model
		}
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
	// Validate only the active user image. Older assistant-ui clients could
	// persist browser-supported formats that a hosted vision gateway cannot
	// decode; those stale parts are omitted when provider history is rebuilt.
	if latestUser != nil {
		latestUserMessage := assistantUIMessage{Role: "user", Parts: latestUser.Parts}
		if assistantUIMessageHasImages([]assistantUIMessage{latestUserMessage}) {
			if err := validateAssistantUIImageParts([]assistantUIMessage{latestUserMessage}); err != nil {
				writeError(c, http.StatusBadRequest, err)
				return
			}
		}
	}
	// The endpoint's configured chat model is the safe default. A model chosen
	// from discovery (or entered manually for a compatible gateway) is scoped to
	// this request and never changes the endpoint's persisted default. When the
	// history contains an image, switch to the endpoint's dedicated vision model
	// if one is configured; otherwise retain the chat model for providers where a
	// single multimodal model handles both modes.
	hasImages := assistantUIMessageHasProviderImages(requestMessages)
	endpoint, err = assistantUIEndpointForRequest(endpoint, request.Model, hasImages)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}

	runStatus := "complete"
	runToolCalls := 0
	runID := uuid.Nil
	runFinished := false
	finishRun := func() {
		if runID == uuid.Nil || runFinished {
			return
		}
		runFinished = true
		if c.Request.Context().Err() != nil {
			runStatus = "cancelled"
		}
		if err := a.finishChatRun(context.Background(), runID, runStatus, runToolCalls); err != nil {
			slog.Error("could not persist assistant UI run status", "runId", runID, "status", runStatus, "error", err)
		}
	}
	// Every Assistant UI request gets a durable run record. The browser sends a
	// stable per-turn id for idempotency; fall back to the server request id for
	// older clients so analytics still includes those turns.
	requestID := strings.TrimSpace(request.RequestID)
	if requestID == "" {
		requestID = middleware.GetRequestID(c)
	}
	if requestID != "" {
		var duplicate bool
		runID, duplicate, err = a.startChatRun(c, requestID, conversationID, principal.UserID, organizationID, endpointID, endpoint.ChatModel)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if duplicate {
			writeError(c, http.StatusConflict, fmt.Errorf("chat request is already being processed"))
			return
		}
	}
	defer finishRun()

	if approval == nil {
		if latestUser != nil {
			if err := a.persistAssistantUIUser(c, conversationID, *latestUser); err != nil {
				runStatus = "error"
				writeError(c, http.StatusInternalServerError, err)
				return
			}
		}
	}

	knowledgeEnabled := a.platformCapabilityEnabled(c, "knowledge")
	knowledgeAttached := false
	if knowledgeEnabled {
		selectedSourceIDs := latestUserAttachmentSourceIDs(latestUser)
		indexing, err := a.conversationHasIndexingKnowledge(c, conversationID, selectedSourceIDs)
		if err != nil {
			runStatus = "error"
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if indexing {
			runStatus = "error"
			writeError(c, http.StatusConflict, fmt.Errorf("attached Knowledge is still indexing; detach it or wait for indexing to finish"))
			return
		}
		if latestUser != nil {
			knowledgeAttached, err = a.conversationHasKnowledge(c, conversationID, selectedSourceIDs)
			if err != nil {
				runStatus = "error"
				writeError(c, http.StatusInternalServerError, err)
				return
			}
		}
	}
	attachedNotes, notesErr := a.attachedNotesPrompt(c, conversationID)
	if notesErr != nil {
		runStatus = "error"
		writeError(c, http.StatusInternalServerError, notesErr)
		return
	}
	projectContext, projectErr := a.projectPrompt(c, conversationID)
	if projectErr != nil {
		runStatus = "error"
		writeError(c, http.StatusInternalServerError, projectErr)
		return
	}
	streamID := uuid.New()
	if err := a.createChatStream(context.Background(), streamID, conversationID, principal.UserID, organizationID, runID); err != nil {
		runStatus = "error"
		writeError(c, http.StatusInternalServerError, fmt.Errorf("resumable chat stream could not be created: %w", err))
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
	writer.Header().Set("x-resumable-stream-id", streamID.String())
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
					if runID != uuid.Nil {
						_ = a.markChatRunFirstToken(context.Background(), runID, firstTokenAt)
					}
				}
			case "tool-input-available":
				toolCallCount++
				runToolCalls++
			case "error":
				runStatus = "error"
			case "tool-approval-request":
				runStatus = "requires-action"
			}
		}
		payload, marshalErr := json.Marshal(value)
		if marshalErr != nil {
			return marshalErr
		}
		// Persist before writing to the live connection. If the browser drops
		// between these operations, a reconnect still receives the event.
		if persistErr := a.appendChatStreamChunk(context.Background(), streamID, string(payload)); persistErr != nil {
			runStatus = "error"
			return persistErr
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
		streamStatus := runStatus
		if requestContext := c.Request.Context(); requestContext.Err() != nil {
			streamStatus = "cancelled"
			runStatus = streamStatus
			if payload, marshalErr := json.Marshal(map[string]any{"type": "abort", "reason": requestContext.Err().Error()}); marshalErr == nil {
				_ = a.appendChatStreamChunk(context.Background(), streamID, string(payload))
				_, _ = fmt.Fprintf(writer, "data: %s\n\n", payload)
			}
		}
		if streamStatus == "running" {
			streamStatus = "complete"
			runStatus = streamStatus
		}
		// Mark the run before publishing [DONE]. A fast follow-up (especially an
		// approval retry) must not observe the old row as still running during
		// the tiny window between the final stream event and the deferred cleanup.
		finishRun()
		_ = a.appendChatStreamChunk(context.Background(), streamID, "[DONE]")
		_, _ = fmt.Fprint(writer, "data: [DONE]\n\n")
		_ = a.finishChatStream(context.Background(), streamID, streamStatus)
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
	defer finishStream()
	if err := writeChunk(map[string]any{"type": "start", "messageId": assistantMessageID}); err != nil {
		runStatus = "error"
		return
	}
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
	if latestUser != nil && knowledgeEnabled && knowledgeAttached {
		_ = writeChunk(map[string]any{
			"type": "data-retrieval-status",
			"id":   "retrieval-status",
			"data": map[string]any{
				"status": "started",
				"mode":   assistantUIRetrievalMode(request.DeepContext),
				"query":  latestUser.Text,
			},
		})
		var retrievalErr error
		citations, retrievalErr = a.searchKnowledge(c, organizationID, principal.UserID, conversationID, latestUser.Text, 6, latestUser.AttachmentSourceIDs, request.DeepContext)
		if retrievalErr != nil {
			_ = writeChunk(map[string]any{
				"type": "data-retrieval-status",
				"id":   "retrieval-status",
				"data": map[string]any{"status": "failed", "mode": assistantUIRetrievalMode(request.DeepContext), "error": retrievalErr.Error()},
			})
		} else {
			_ = writeChunk(map[string]any{
				"type": "data-retrieval-status",
				"id":   "retrieval-status",
				"data": map[string]any{
					"status":        "completed",
					"mode":          assistantUIRetrievalMode(request.DeepContext),
					"citationCount": len(deduplicateAssistantUICitations(citations)),
					"sourceCount":   len(deduplicateAssistantUICitations(citations)),
					"passageCount":  len(citations),
				},
			})
		}
	}
	for _, citation := range deduplicateAssistantUICitations(citations) {
		_ = writeChunk(a.assistantUICitationPart(c, citation))
	}

	var outputParent any
	toolRoundOffset := 0
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
			if resumedEvent.Round > 0 {
				// A resumed approval is the result of the previous model step.
				// Continue numbering from that persisted step so provider history
				// keeps each approval continuation as a separate assistant/tool
				// exchange and the global round ceiling remains effective.
				toolRoundOffset = resumedEvent.Round
			}
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

	definitions := []provider.ToolDefinition{}
	bindings := map[string]voiceToolBinding{}
	builtInTools := assistantBuiltInToolDiscovery()
	definitions = append(definitions, builtInTools.Definitions...)
	for name, binding := range builtInTools.Bindings {
		bindings[name] = binding
	}
	if a.platformCapabilityEnabled(c, "mcp") {
		toolDiscovery := a.discoverConversationTools(c, principal.UserID, organizationID, conversationID)
		definitions = append(definitions, toolDiscovery.Definitions...)
		for name, binding := range toolDiscovery.Bindings {
			bindings[name] = binding
		}
	}
	if len(definitions) > 0 && !provider.SupportsToolCalling(endpoint) {
		definitions = nil
	}
	if err := writeChunk(map[string]any{"type": "start-step"}); err != nil {
		return
	}

	response := strings.Builder{}
	historyHead, hasHistoryHead := assistantUIParentUUID(outputParent)
	persistError := func(streamErr error) {
		if streamErr == nil {
			return
		}
		errorParts := append([]map[string]any(nil), toolParts...)
		errorParts = append(errorParts, assistantUIErrorPart(streamErr.Error()))
		metadata := writeTiming()
		metadata["errorText"] = streamErr.Error()
		_ = a.persistAssistantUIAssistantAtPartsStatus(c, conversationID, outputParent, assistantMessageID, response.String(), citations, errorParts, metadata, "error")
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
			persistError(historyErr)
			_ = writeChunk(map[string]any{"type": "error", "errorText": historyErr.Error()})
			return
		}
		if assistantPrompt := savedAssistantInstructions(savedAssistant); assistantPrompt != "" {
			toolHistory = append([]provider.ToolMessage{{Role: "system", Content: assistantPrompt}}, toolHistory...)
		}
		if request.UseMemory {
			memory, memoryErr := a.memoryPrompt(c, principal.UserID, organizationID)
			if memoryErr != nil {
				persistError(memoryErr)
				_ = writeChunk(map[string]any{"type": "error", "errorText": memoryErr.Error()})
				return
			}
			if strings.TrimSpace(memory) != "" {
				toolHistory = append([]provider.ToolMessage{{Role: "system", Content: memory}}, toolHistory...)
			}
		}
		if strings.TrimSpace(attachedNotes) != "" {
			toolHistory = append([]provider.ToolMessage{{Role: "system", Content: attachedNotes}}, toolHistory...)
		}
		if strings.TrimSpace(projectContext) != "" {
			toolHistory = append([]provider.ToolMessage{{Role: "system", Content: projectContext}}, toolHistory...)
		}
		toolHistory = append([]provider.ToolMessage{{Role: "system", Content: chatToolInstructions()}}, toolHistory...)
		if len(citations) > 0 {
			toolHistory = append([]provider.ToolMessage{{Role: "system", Content: citationPromptForMode(citations, request.DeepContext)}}, toolHistory...)
		}
		requiresAction, streamErr := a.streamAssistantUIWithTools(c, principal.UserID, organizationID, conversationID, runID, &outputParent, endpoint, toolHistory, definitions, bindings, latestUser, writeChunk, &response, assistantMessageID, textID, &toolParts, toolRoundOffset)
		if streamErr != nil {
			persistError(streamErr)
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
			persistError(historyErr)
			_ = writeChunk(map[string]any{"type": "error", "errorText": historyErr.Error()})
			return
		}
		if assistantPrompt := savedAssistantInstructions(savedAssistant); assistantPrompt != "" {
			history = append([]provider.Message{{Role: "system", Content: assistantPrompt}}, history...)
		}
		if request.UseMemory {
			memory, memoryErr := a.memoryPrompt(c, principal.UserID, organizationID)
			if memoryErr != nil {
				persistError(memoryErr)
				_ = writeChunk(map[string]any{"type": "error", "errorText": memoryErr.Error()})
				return
			}
			if strings.TrimSpace(memory) != "" {
				history = append([]provider.Message{{Role: "system", Content: memory}}, history...)
			}
		}
		if strings.TrimSpace(attachedNotes) != "" {
			history = append([]provider.Message{{Role: "system", Content: attachedNotes}}, history...)
		}
		if strings.TrimSpace(projectContext) != "" {
			history = append([]provider.Message{{Role: "system", Content: projectContext}}, history...)
		}
		if !provider.SupportsToolCalling(endpoint) {
			history = append([]provider.Message{{Role: "system", Content: chatBuiltInFallbackInstructions()}}, history...)
		}
		if len(citations) > 0 {
			history = append([]provider.Message{{Role: "system", Content: citationPromptForMode(citations, request.DeepContext)}}, history...)
		}
		streamErr := a.streamAssistantUIWithoutTools(c, principal.UserID, organizationID, conversationID, runID, &outputParent, endpoint, history, latestUser, writeChunk, &response, textID, &toolParts)
		if streamErr != nil {
			persistError(streamErr)
			_ = writeChunk(map[string]any{"type": "error", "errorText": streamErr.Error()})
			return
		}
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

func assistantUIEndpointForRequest(endpoint provider.Endpoint, requestedModel string, hasImages bool) (provider.Endpoint, error) {
	if model := strings.TrimSpace(requestedModel); model != "" {
		endpoint.ChatModel = model
	}
	if !hasImages {
		return endpoint, nil
	}
	if !provider.SupportsVision(endpoint) {
		return endpoint, fmt.Errorf("the selected endpoint does not support image messages")
	}
	if model := strings.TrimSpace(endpoint.VisionModel); model != "" {
		endpoint.ChatModel = model
	}
	return endpoint, nil
}

type assistantUserMessage struct {
	ID                  string
	Text                string
	ParentID            string
	Parts               []json.RawMessage
	Metadata            json.RawMessage
	AttachmentSourceIDs []uuid.UUID
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
		text := ""
		hasContent := false
		hasImage := false
		hasFile := false
		for _, rawPart := range messages[index].Parts {
			var part assistantUIPart
			if json.Unmarshal(rawPart, &part) != nil {
				continue
			}
			switch part.Type {
			case "text":
				if strings.TrimSpace(part.Text) != "" {
					text = strings.TrimSpace(part.Text)
					hasContent = true
				}
			case "image":
				if _, ok := assistantUIImageURL(part); ok {
					hasContent = true
					hasImage = true
				}
			case "file":
				hasFile = strings.TrimSpace(part.URL) != ""
				if hasFile {
					hasContent = true
				}
				if _, ok := assistantUIImageURL(part); ok {
					hasContent = true
					hasImage = true
				}
			}
		}
		attachmentSourceIDs := assistantUIAttachmentSourceIDs(messages[index])
		if len(attachmentSourceIDs) > 0 {
			hasContent = true
			hasFile = true
		}
		quote := assistantUIMessageQuote(messages[index])
		if !hasContent && quote == nil {
			continue
		}
		if text == "" {
			if hasImage && !hasFile {
				text = "Please inspect the attached image."
			} else if hasFile {
				text = "Please inspect the attached file."
			} else if hasContent {
				text = "Please inspect the attached image."
			} else {
				text = "Please respond to the quoted context."
			}
		}
		if quote != nil {
			text += "\n\nQuoted context:\n" + assistantUIQuoteBlock(quote.Text)
		}
		parentID := ""
		if index > 0 {
			parentID = messages[index-1].ID
		}
		return &assistantUserMessage{ID: messages[index].ID, Text: text, ParentID: parentID, Parts: messages[index].Parts, Metadata: messages[index].Metadata, AttachmentSourceIDs: attachmentSourceIDs}
	}
	return nil
}

func assistantUIAttachmentSourceIDs(message assistantUIMessage) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{})
	result := make([]uuid.UUID, 0)
	appendSource := func(raw string) {
		raw = strings.TrimSpace(raw)
		raw = strings.TrimPrefix(raw, "justai-source:")
		id, err := uuid.Parse(raw)
		if err != nil || id == uuid.Nil {
			return
		}
		if _, exists := seen[id]; exists {
			return
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	for _, rawPart := range message.Parts {
		var part assistantUIPart
		if json.Unmarshal(rawPart, &part) != nil {
			continue
		}
		if part.Type == "file" && strings.HasPrefix(strings.TrimSpace(part.URL), "justai-source:") {
			appendSource(part.URL)
		}
		if part.Type != "data-justai-attachment" && part.Name != "justai-attachment" {
			continue
		}
		if part.Data == nil {
			continue
		}
		if rawID, ok := part.Data["sourceId"].(string); ok {
			appendSource(rawID)
		}
	}
	return result
}

func latestUserAttachmentSourceIDs(message *assistantUserMessage) []uuid.UUID {
	if message == nil {
		return nil
	}
	return message.AttachmentSourceIDs
}

func assistantUIMessageQuote(message assistantUIMessage) *assistantUIQuote {
	if len(message.Metadata) == 0 || !json.Valid(message.Metadata) {
		return nil
	}
	var envelope struct {
		Custom struct {
			Quote *assistantUIQuote `json:"quote"`
		} `json:"custom"`
	}
	if json.Unmarshal(message.Metadata, &envelope) != nil || envelope.Custom.Quote == nil || strings.TrimSpace(envelope.Custom.Quote.Text) == "" {
		return nil
	}
	envelope.Custom.Quote.Text = strings.TrimSpace(envelope.Custom.Quote.Text)
	return envelope.Custom.Quote
}

func assistantUIQuoteBlock(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	for index, line := range lines {
		lines[index] = "> " + line
	}
	return strings.Join(lines, "\n")
}

func assistantUIMessageHasImages(messages []assistantUIMessage) bool {
	for _, message := range messages {
		if message.Role != "user" {
			continue
		}
		for _, rawPart := range message.Parts {
			var part assistantUIPart
			if json.Unmarshal(rawPart, &part) == nil {
				if _, ok := assistantUIImageURL(part); ok {
					return true
				}
			}
		}
	}
	return false
}

func assistantUIMessageHasProviderImages(messages []assistantUIMessage) bool {
	for _, message := range messages {
		if message.Role != "user" {
			continue
		}
		if len(assistantUIProviderImageParts(message.Parts)) > 0 {
			return true
		}
	}
	return false
}

func assistantUIProviderImageParts(rawParts []json.RawMessage) []provider.MessageContentPart {
	result := make([]provider.MessageContentPart, 0)
	for _, rawPart := range rawParts {
		var part assistantUIPart
		if json.Unmarshal(rawPart, &part) != nil {
			continue
		}
		imageURL, ok := assistantUIImageURL(part)
		if !ok {
			continue
		}
		normalized, normalizedOK := assistantUIProviderSafeImageURL(imageURL)
		if !normalizedOK {
			// Older conversations may contain a browser-supported format that the
			// configured provider cannot decode. Do not let one stale attachment
			// prevent a later text turn; the active user image is validated before
			// the request starts.
			continue
		}
		result = append(result, provider.MessageContentPart{
			Type:     "image_url",
			ImageURL: &provider.MessageImageURL{URL: normalized, Detail: "auto"},
		})
	}
	return result
}

func validateAssistantUIImageParts(messages []assistantUIMessage) error {
	for _, message := range messages {
		if message.Role != "user" {
			continue
		}
		for _, rawPart := range message.Parts {
			var part assistantUIPart
			if json.Unmarshal(rawPart, &part) != nil {
				continue
			}
			imageURL, ok := assistantUIImageURL(part)
			if !ok {
				continue
			}
			if _, ok := assistantUIProviderSafeImageURL(imageURL); !ok {
				return fmt.Errorf("image message data could not be decoded; please reattach the image")
			}
		}
	}
	return nil
}

func assistantUIImageDataURL(value string) (string, string, bool) {
	header, encoded, ok := strings.Cut(strings.TrimSpace(value), ",")
	if !ok {
		return "", "", false
	}
	parameters := strings.Split(header, ";")
	if len(parameters) < 2 {
		return "", "", false
	}
	scheme := strings.TrimSpace(parameters[0])
	if len(scheme) < len("data:") || !strings.EqualFold(scheme[:len("data:")], "data:") {
		return "", "", false
	}
	mimeType := strings.TrimSpace(scheme[len("data:"):])
	if !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		return "", "", false
	}
	hasBase64 := false
	for _, parameter := range parameters[1:] {
		if strings.EqualFold(strings.TrimSpace(parameter), "base64") {
			hasBase64 = true
			break
		}
	}
	if !hasBase64 {
		return "", "", false
	}
	return strings.ToLower(mimeType), strings.TrimSpace(encoded), true
}

func assistantUICanonicalImageURL(value string) (string, bool) {
	mimeType, encoded, ok := assistantUIImageDataURL(value)
	if !ok {
		return "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", false
	}
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(decoded), true
}

func assistantUIProviderSafeImageURL(value string) (string, bool) {
	const maxImageBytes = 12 * 1024 * 1024

	normalized, ok := assistantUICanonicalImageURL(value)
	if !ok {
		return "", false
	}
	_, encoded, ok := assistantUIImageDataURL(normalized)
	if !ok {
		return "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(decoded) > maxImageBytes {
		return "", false
	}
	if _, _, err := image.DecodeConfig(bytes.NewReader(decoded)); err != nil {
		return "", false
	}
	return normalized, true
}

func assistantUIImageURL(part assistantUIPart) (string, bool) {
	imageURL := strings.TrimSpace(part.Image)
	if part.Type == "file" {
		imageURL = strings.TrimSpace(part.URL)
	}
	if imageURL == "" || !strings.HasPrefix(strings.ToLower(imageURL), "data:image/") {
		return "", false
	}
	mimeType := strings.ToLower(strings.TrimSpace(firstAssistantUIString(part.MimeType, part.MediaType)))
	if part.Type == "file" && mimeType != "" && !strings.HasPrefix(mimeType, "image/") {
		return "", false
	}
	return imageURL, true
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
	uiMessage := map[string]any{
		"id":    message.ID,
		"role":  "user",
		"parts": message.Parts,
	}
	if len(message.Metadata) > 0 && json.Valid(message.Metadata) {
		uiMessage["metadata"] = json.RawMessage(message.Metadata)
	}
	encodedUIMessage, err := json.Marshal(uiMessage)
	if err != nil {
		return err
	}
	_, err = a.DB.ExecContext(ctx, `
		INSERT INTO messages (conversation_id, role, content, format, ui_message, parent_id, run_status, updated_at)
		VALUES ($1, 'user', $2::text, 'ai-sdk-ui', $4::jsonb, $3::uuid, 'complete', now())
	`, conversationID, message.Text, parentID, encodedUIMessage)
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
	for _, citation := range deduplicateAssistantUICitations(citations) {
		parts = append(parts, a.assistantUICitationPart(ctx, citation))
	}
	payload, err := json.Marshal(map[string]any{"id": messageID.String(), "role": role, "parts": parts})
	if err != nil {
		return uuid.Nil, err
	}
	_, err = a.DB.ExecContext(ctx, `
		INSERT INTO messages (id, conversation_id, role, content, citations, format, ui_message, parent_id, run_status, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'ai-sdk-ui', $6, $7::uuid, 'complete', now())
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
		"toolName":   assistantUIToolName(event),
		"toolCallId": event.CallID,
		"input":      event.Arguments,
		"state":      state,
		"dynamic":    true,
	}
	if providerMetadata := assistantUIToolProviderMetadata(event); providerMetadata != nil {
		part["callProviderMetadata"] = providerMetadata
	}
	if app := assistantUIMCPAppMetadata(event); app != nil {
		part["mcp"] = map[string]any{"app": app}
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

func assistantUIToolName(event chatToolEvent) string {
	return firstNonEmptyChatToolString(event.ProviderToolName, event.ToolName)
}

// assistantUIToolProviderMetadata carries display-only MCP identity alongside
// the provider-safe tool name. The safe name remains the canonical toolName
// used for model calls and approval matching; the frontend uses this metadata
// to render the saved server and raw MCP tool names in chat history.
func assistantUIToolProviderMetadata(event chatToolEvent) map[string]any {
	if event.ServerID == uuid.Nil {
		return nil
	}
	details := map[string]any{"serverId": event.ServerID.String()}
	if strings.TrimSpace(event.ServerName) != "" {
		details["serverName"] = event.ServerName
	}
	if strings.TrimSpace(event.ToolName) != "" {
		details["toolName"] = event.ToolName
	}
	if strings.TrimSpace(event.IconURL) != "" {
		details["iconUrl"] = event.IconURL
	}
	return map[string]any{"justai": details}
}

func assistantUIApprovalToolNameMatchesEvent(approvalToolName string, event chatToolEvent) bool {
	return approvalToolName != "" && (approvalToolName == event.ToolName || (event.ProviderToolName != "" && approvalToolName == event.ProviderToolName))
}

func assistantUIMCPAppMetadata(event chatToolEvent) map[string]any {
	resourceURI := strings.TrimSpace(event.MCPAppResourceURI)
	if resourceURI == "" || !strings.HasPrefix(resourceURI, "ui://") {
		return nil
	}
	mimeType := strings.TrimSpace(event.MCPAppMIMEType)
	if mimeType == "" {
		mimeType = "text/html;profile=mcp-app"
	}
	metadata := map[string]any{
		"resourceUri": resourceURI,
		"mimeType":    mimeType,
	}
	if event.ServerID != uuid.Nil {
		metadata["serverId"] = event.ServerID.String()
	}
	return metadata
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

func assistantUIAttachToolProviderMetadata(message map[string]any, event chatToolEvent) {
	providerMetadata := assistantUIToolProviderMetadata(event)
	if providerMetadata == nil {
		return
	}
	parts, _ := message["parts"].([]any)
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		partType, _ := part["type"].(string)
		callID, _ := part["toolCallId"].(string)
		if (partType != "dynamic-tool" && !strings.HasPrefix(partType, "tool-")) || callID != event.CallID {
			continue
		}
		if _, exists := part["callProviderMetadata"]; !exists {
			part["callProviderMetadata"] = providerMetadata
		}
	}
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
		if (callID == "" || part.ToolCall == callID) && part.State == "approval-requested" && part.Approval != nil && part.Approval.ID == approvalID {
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

func assistantUIErrorPart(message string) map[string]any {
	return map[string]any{
		"type": "data-justai-error",
		"data": map[string]any{"message": message},
	}
}

func (a *App) persistAssistantUIAssistantAtPartsStatus(ctx context.Context, conversationID uuid.UUID, parentID any, messageID, content string, citations []models.Citation, toolParts []map[string]any, metadata map[string]any, runStatus string) error {
	displayCitations := deduplicateAssistantUICitations(citations)
	parts := make([]any, 0, 1+len(toolParts)+len(displayCitations))
	if strings.TrimSpace(content) != "" {
		parts = append(parts, map[string]any{"type": "text", "text": content})
	}
	for _, toolPart := range toolParts {
		parts = append(parts, toolPart)
	}
	for _, citation := range displayCitations {
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
		VALUES ($1, $2, 'assistant', $3, $4, 'ai-sdk-ui', $5, $6::uuid, $7, now())
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
		if json.Unmarshal([]byte(content), &candidate) == nil && candidate.ApprovalID == approval.ApprovalID {
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
	// The standard UI-message approval response only carries approvalId,
	// approved, and an optional reason. Resolve omitted call/tool/argument
	// fields from the server-side pending event instead of requiring the
	// browser to echo metadata that it does not own.
	if approval.CallID == "" {
		approval.CallID = event.CallID
	}
	if approval.ToolName == "" {
		approval.ToolName = assistantUIToolName(event)
	}
	if approval.Arguments == nil {
		approval.Arguments = event.Arguments
	}
	if approval.CallID == "" || approval.CallID != event.CallID {
		return nil, uuid.Nil, fmt.Errorf("approval call does not match the pending tool")
	}
	var bindings map[string]voiceToolBinding
	var providerToolName string
	var pendingBinding voiceToolBinding
	var pendingBindingFound bool
	if !assistantUIApprovalToolNameMatchesEvent(approval.ToolName, event) && event.ServerID != uuid.Nil {
		bindings = a.discoverConversationTools(ctx, userID, organizationID, conversationID).Bindings
		providerToolName, pendingBinding, pendingBindingFound = findMCPBindingWithProviderName(bindings, event.ServerID, event.ToolName)
	}
	if !assistantUIApprovalToolNameMatchesEvent(approval.ToolName, event) && (!pendingBindingFound || approval.ToolName != providerToolName) {
		return nil, uuid.Nil, fmt.Errorf("approval tool does not match the pending tool")
	}
	if !assistantUIApprovalArgumentsMatch(event.Arguments, approval.Arguments) {
		return nil, uuid.Nil, fmt.Errorf("approval arguments do not match the pending tool")
	}
	// A retry may arrive after the MCP side effect was persisted but before the
	// resumed model stream completed. Reuse that durable result instead of
	// executing the tool again or trapping the UI in a non-retryable state.
	if assistantUIApprovalEventIsTerminal(event.Status) {
		return &event, messageID, nil
	}
	if event.Status != "awaiting_approval" {
		return nil, uuid.Nil, fmt.Errorf("approval is already being processed")
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
	if bindings == nil {
		bindings = a.discoverConversationTools(ctx, userID, organizationID, conversationID).Bindings
	}
	// Discovery uses provider-safe names as map keys (for example,
	// mcp_<server>_<tool>), while chat events intentionally persist the raw
	// MCP tool name so the history remains readable and stable. Resolve the
	// pending tool by both its attached server and raw MCP name rather than
	// treating the raw name as a provider name.
	if !pendingBindingFound {
		providerToolName, pendingBinding, pendingBindingFound = findMCPBindingWithProviderName(bindings, event.ServerID, event.ToolName)
	}
	binding, ok := pendingBinding, pendingBindingFound
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

func assistantUIApprovalEventIsTerminal(status string) bool {
	switch status {
	case "completed", "failed", "declined":
		return true
	default:
		return false
	}
}

func assistantUIApprovalArgumentsMatch(expected, actual map[string]any) bool {
	// A tool with no arguments may be represented as either a nil map (for
	// legacy events persisted with omitempty) or an empty JSON object (the
	// shape sent back by the UI runtime). Those representations are equivalent
	// for an MCP tool call.
	if len(expected) == 0 && len(actual) == 0 {
		return true
	}
	expectedJSON, err := json.Marshal(expected)
	if err != nil {
		return false
	}
	actualJSON, err := json.Marshal(actual)
	if err != nil {
		return false
	}
	return bytes.Equal(expectedJSON, actualJSON)
}

func (a *App) streamAssistantUIWithTools(ctx context.Context, userID, organizationID, conversationID, runID uuid.UUID, parentID *any, endpoint provider.Endpoint, history []provider.ToolMessage, definitions []provider.ToolDefinition, bindings map[string]voiceToolBinding, latestUser *assistantUserMessage, writeChunk func(any) error, response *strings.Builder, messageID, textID string, toolParts *[]map[string]any, roundOffset int) (bool, error) {
	toolMessages := append([]provider.ToolMessage(nil), history...)
	textStarted := false
	freshDiscoveryAttempted := false
	if roundOffset >= maxAssistantUIToolRounds {
		message := "\n\nI stopped after four MCP tool rounds to keep this turn bounded."
		if err := writeChunk(map[string]any{"type": "text-start", "id": textID}); err != nil {
			return false, err
		}
		response.WriteString(message)
		if err := writeChunk(map[string]any{"type": "text-delta", "id": textID, "delta": message}); err != nil {
			return false, err
		}
		if err := writeChunk(map[string]any{"type": "text-end", "id": textID}); err != nil {
			return false, err
		}
		return false, nil
	}
	for round := roundOffset + 1; round <= maxAssistantUIToolRounds; round++ {
		if round > 1 {
			if err := writeChunk(map[string]any{"type": "start-step"}); err != nil {
				return false, err
			}
		}
		var roundResponse strings.Builder
		calls := []provider.ToolCall{}
		err := provider.StreamChatWithTools(ctx, endpoint, provider.ToolChatOptions{
			Messages: toolMessages,
			Tools:    definitions,
			Model:    endpoint.ChatModel,
			OnUsage: func(usage provider.Usage) {
				_ = a.recordChatRunUsage(context.Background(), runID, usage)
			},
		}, func(event provider.ToolChatEvent) error {
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
					errorText := "The tool arguments were invalid JSON."
					event := chatToolEvent{Kind: chatToolEventKindForName(call.Name), Status: "failed", Round: round, ToolName: call.Name, ProviderToolName: call.Name, CallID: call.ID, Error: errorText}
					messageRowID := a.persistChatToolEventAt(ctx, conversationID, dereferenceAssistantUIParent(parentID), event)
					if messageRowID != uuid.Nil {
						*parentID = messageRowID
					}
					*toolParts = replaceAssistantUIToolPart(*toolParts, event)
					_ = writeChunk(map[string]any{"type": "tool-input-error", "toolCallId": call.ID, "toolName": call.Name, "input": map[string]any{}, "errorText": errorText, "dynamic": true, "toolMetadata": map[string]any{"messageId": messageRowID.String()}})
					toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: errorText})
					continue
				}
			}
			binding, exists := findVoiceToolBinding(bindings, call.Name)
			if !exists && !freshDiscoveryAttempted {
				freshDiscoveryAttempted = true
				fresh := a.discoverConversationToolsFresh(ctx, userID, organizationID, conversationID)
				definitions = mergeVoiceToolDiscovery(definitions, bindings, fresh)
				binding, exists = findVoiceToolBinding(bindings, call.Name)
			}
			if !exists {
				errorText := "The requested tool is not available."
				event := chatToolEvent{Kind: chatToolEventKindForName(call.Name), Status: "failed", Round: round, ToolName: call.Name, ProviderToolName: call.Name, CallID: call.ID, Arguments: arguments, Error: errorText}
				messageRowID := a.persistChatToolEventAt(ctx, conversationID, dereferenceAssistantUIParent(parentID), event)
				if messageRowID != uuid.Nil {
					*parentID = messageRowID
				}
				*toolParts = replaceAssistantUIToolPart(*toolParts, event)
				_ = writeChunk(map[string]any{"type": "tool-input-error", "toolCallId": call.ID, "toolName": call.Name, "input": arguments, "errorText": errorText, "dynamic": true, "toolMetadata": map[string]any{"messageId": messageRowID.String()}})
				toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: errorText})
				continue
			}
			eventKind := "mcp_tool"
			if binding.Builtin {
				eventKind = "builtin_tool"
			}
			event := chatToolEvent{Kind: eventKind, Status: "running", Round: round, ServerID: binding.ServerID, ServerName: binding.ServerName, IconURL: binding.IconURL, ToolName: binding.ToolName, ProviderToolName: call.Name, MCPAppResourceURI: binding.MCPAppResourceURI, MCPAppMIMEType: binding.MCPAppMIMEType, CallID: call.ID, Arguments: arguments}
			messageRowID := a.persistChatToolEventAt(ctx, conversationID, dereferenceAssistantUIParent(parentID), event)
			if messageRowID != uuid.Nil {
				*parentID = messageRowID
			}
			toolMetadata := map[string]any{"messageId": messageRowID.String()}
			if !binding.Builtin {
				toolMetadata["serverId"] = binding.ServerID.String()
				toolMetadata["serverName"] = binding.ServerName
				if strings.TrimSpace(binding.IconURL) != "" {
					toolMetadata["iconUrl"] = binding.IconURL
				}
			}
			toolInput := map[string]any{"type": "tool-input-available", "toolCallId": call.ID, "toolName": call.Name, "input": arguments, "dynamic": true, "toolMetadata": toolMetadata}
			if providerMetadata := assistantUIToolProviderMetadata(event); providerMetadata != nil {
				toolInput["providerMetadata"] = providerMetadata
			}
			if app := assistantUIMCPAppMetadata(event); app != nil {
				toolInput["mcp"] = map[string]any{"app": app}
			}
			if err := writeChunk(toolInput); err != nil {
				return false, err
			}
			if binding.RequiresApproval {
				event.Status = "awaiting_approval"
				event.ApprovalID = uuid.NewString()
				a.updateChatToolEvent(ctx, conversationID, messageRowID, event)
				*toolParts = replaceAssistantUIToolPart(*toolParts, event)
				if err := writeChunk(map[string]any{"type": "tool-approval-request", "approvalId": event.ApprovalID, "toolCallId": call.ID}); err != nil {
					return false, err
				}
				return true, nil
			}
			var result json.RawMessage
			var callErr error
			if binding.Builtin {
				result, callErr = a.executeBuiltInChatTool(ctx, userID, organizationID, conversationID, binding.ToolName, arguments, latestUser)
			} else {
				a.auditVoiceTool(ctx, userID, organizationID, "chat.mcp.auto_approved", binding.ServerID, map[string]any{
					"conversationId": conversationID,
					"serverId":       binding.ServerID,
					"serverName":     binding.ServerName,
					"tool":           binding.ToolName,
					"arguments":      arguments,
					"reason":         "trusted_read_only",
				})
				result, callErr = a.executeChatMCPTool(ctx, userID, organizationID, conversationID, binding, arguments)
			}
			if callErr != nil {
				event.Status = "failed"
				event.Error = callErr.Error()
				a.updateChatToolEvent(ctx, conversationID, messageRowID, event)
				*toolParts = replaceAssistantUIToolPart(*toolParts, event)
				_ = writeChunk(map[string]any{"type": "tool-output-error", "toolCallId": call.ID, "errorText": callErr.Error(), "dynamic": true})
				toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: "The tool failed: " + callErr.Error()})
				continue
			}
			event.Status = "completed"
			event.Result = string(result)
			event.ResultPreview = toolResultPreview(result)
			a.updateChatToolEvent(ctx, conversationID, messageRowID, event)
			*toolParts = replaceAssistantUIToolPart(*toolParts, event)
			if err := writeChunk(map[string]any{"type": "tool-output-available", "toolCallId": call.ID, "output": json.RawMessage(result), "dynamic": true}); err != nil {
				return false, err
			}
			toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: string(result)})
		}
		if round == maxAssistantUIToolRounds {
			message := "\n\nI stopped after four tool rounds to keep this turn bounded."
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
	if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND organization_id = $3 AND (user_id = $2 OR visibility = 'workspace'))`, conversationID, principal.UserID, organizationID).Scan(&exists); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !exists {
		writeError(c, http.StatusNotFound, fmt.Errorf("conversation not found"))
		return
	}
	knowledgeAttached, err := a.conversationHasKnowledge(c, conversationID, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
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
			messageKnowledgeAttached := knowledgeAttached || assistantUIMessageHasSourceParts(message)
			if messageKnowledgeAttached {
				collapseAssistantUIRetrievalStatuses(message)
			} else {
				removeAssistantUIRetrievalStatuses(message)
			}
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
			var event chatToolEvent
			if json.Unmarshal([]byte(content), &event) == nil {
				assistantUIAttachToolProviderMetadata(message, event)
			}
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
	a.enrichAssistantUIToolDisplayMetadata(c, conversationID, &repository)
	filterAssistantUIRepositoryTools(&repository)
	c.JSON(http.StatusOK, gin.H{"repository": repository})
}

func collapseAssistantUIRetrievalStatuses(message map[string]any) {
	parts, ok := message["parts"].([]any)
	if !ok {
		return
	}

	lastStatusIndex := -1
	for index, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if !ok {
			continue
		}
		if partType, _ := part["type"].(string); partType == "data-retrieval-status" {
			lastStatusIndex = index
		}
	}
	if lastStatusIndex < 0 {
		return
	}

	collapsed := make([]any, 0, len(parts))
	for index, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if ok {
			if partType, _ := part["type"].(string); partType == "data-retrieval-status" && index != lastStatusIndex {
				continue
			}
		}
		collapsed = append(collapsed, rawPart)
	}
	message["parts"] = collapsed
}

func removeAssistantUIRetrievalStatuses(message map[string]any) {
	parts, ok := message["parts"].([]any)
	if !ok {
		return
	}

	filtered := make([]any, 0, len(parts))
	for _, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if ok {
			if partType, _ := part["type"].(string); partType == "data-retrieval-status" {
				continue
			}
		}
		filtered = append(filtered, rawPart)
	}
	message["parts"] = filtered
}

func assistantUIMessageHasSourceParts(message map[string]any) bool {
	parts, ok := message["parts"].([]any)
	if !ok {
		return false
	}
	for _, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if !ok {
			continue
		}
		partType, _ := part["type"].(string)
		if partType == "source-document" || partType == "source-url" {
			return true
		}
	}
	return false
}

func assistantUIAppendMissingCitations(ctx context.Context, message map[string]any, raw []byte, app *App) {
	deduplicateAssistantUISourceParts(message)
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
	deduplicateAssistantUISourceParts(message)
}

// deduplicateAssistantUICitations keeps all retrieved passages available to
// the model while exposing one source entry per resource in the UI. A single
// file can contribute several chunks to one answer, but repeating its filename
// for every chunk makes the grounding state look broken.
func deduplicateAssistantUICitations(citations []models.Citation) []models.Citation {
	if len(citations) < 2 {
		return citations
	}

	seen := make(map[string]struct{}, len(citations))
	result := make([]models.Citation, 0, len(citations))
	for _, citation := range citations {
		resourceID := citation.ResourceID
		if resourceID == uuid.Nil {
			resourceID = citation.SourceID
		}
		key := citation.Kind + ":" + resourceID.String()
		if resourceID == uuid.Nil {
			key = citation.Kind + ":" + citation.Title + ":" + citation.Locator
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, citation)
	}
	return result
}

func deduplicateAssistantUISourceParts(message map[string]any) {
	parts, ok := message["parts"].([]any)
	if !ok || len(parts) < 2 {
		return
	}

	seen := make(map[string]struct{}, len(parts))
	filtered := make([]any, 0, len(parts))
	for _, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if !ok {
			filtered = append(filtered, rawPart)
			continue
		}
		partType, _ := part["type"].(string)
		if partType == "source-document" || partType == "source-url" {
			sourceID, _ := part["sourceId"].(string)
			if sourceID != "" {
				if _, exists := seen[sourceID]; exists {
					continue
				}
				seen[sourceID] = struct{}{}
			}
		}
		filtered = append(filtered, rawPart)
	}
	message["parts"] = filtered
}

func filterAssistantUIRepositoryTools(repository *assistantUIRepository) {
	mergeAssistantUIToolDisplayMetadata(repository)
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

func mergeAssistantUIToolDisplayMetadata(repository *assistantUIRepository) {
	metadataByCallID := make(map[string]map[string]any)
	for _, item := range repository.Messages {
		if !item.LegacyTool {
			continue
		}
		parts, _ := item.Message["parts"].([]any)
		for _, rawPart := range parts {
			part, _ := rawPart.(map[string]any)
			callID, _ := part["toolCallId"].(string)
			providerMetadata, _ := part["callProviderMetadata"].(map[string]any)
			if callID != "" && providerMetadata != nil {
				metadataByCallID[callID] = providerMetadata
			}
		}
	}
	if len(metadataByCallID) == 0 {
		return
	}
	for _, item := range repository.Messages {
		if item.LegacyTool {
			continue
		}
		parts, _ := item.Message["parts"].([]any)
		for _, rawPart := range parts {
			part, _ := rawPart.(map[string]any)
			callID, _ := part["toolCallId"].(string)
			if _, exists := part["callProviderMetadata"]; exists {
				continue
			}
			if providerMetadata := metadataByCallID[callID]; providerMetadata != nil {
				part["callProviderMetadata"] = providerMetadata
			}
		}
	}
}

// enrichAssistantUIToolDisplayMetadata repairs older tool rows that were
// persisted before display metadata was added. The provider-facing name is
// intentionally kept as the part's toolName; this only adds presentation
// metadata by matching the call against tools attached to the conversation.
func (a *App) enrichAssistantUIToolDisplayMetadata(ctx context.Context, conversationID uuid.UUID, repository *assistantUIRepository) {
	rows, err := a.DB.QueryContext(ctx, `
		SELECT ms.id, ms.name, CASE WHEN EXISTS (SELECT 1 FROM mcp_server_icons msi WHERE msi.server_id = ms.id) THEN '/api/v1/mcp/servers/' || ms.id::text || '/icon' ELSE COALESCE(ms.icon_url, '') END, COALESCE(mst.name, '')
		FROM conversation_mcp_servers cms
		JOIN mcp_servers ms ON ms.id = cms.server_id AND ms.enabled = TRUE
		LEFT JOIN mcp_server_tools mst ON mst.server_id = ms.id
		WHERE cms.conversation_id = $1
		ORDER BY cms.created_at, mst.name
	`, conversationID)
	if err != nil {
		// Display enrichment is best effort. A history request should still
		// succeed when an older deployment does not have the tool cache table
		// or the cache is temporarily unavailable.
		return
	}
	defer rows.Close()

	bindings := make([]assistantUIToolDisplayBinding, 0)
	for rows.Next() {
		var binding assistantUIToolDisplayBinding
		if err := rows.Scan(&binding.ServerID, &binding.ServerName, &binding.IconURL, &binding.ToolName); err != nil {
			return
		}
		bindings = append(bindings, binding)
	}
	if err := rows.Err(); err != nil || len(bindings) == 0 {
		return
	}

	for _, item := range repository.Messages {
		parts, _ := item.Message["parts"].([]any)
		for _, rawPart := range parts {
			part, _ := rawPart.(map[string]any)
			assistantUIEnrichToolPartDisplayMetadata(part, bindings)
		}
	}
}

func assistantUIEnrichToolPartDisplayMetadata(part map[string]any, bindings []assistantUIToolDisplayBinding) {
	if part == nil {
		return
	}
	partType, _ := part["type"].(string)
	if partType != "dynamic-tool" && !strings.HasPrefix(partType, "tool-") {
		return
	}
	toolName, _ := part["toolName"].(string)
	match, ok := assistantUIFindToolDisplayBinding(toolName, bindings)
	if !ok {
		return
	}

	providerMetadata, _ := part["callProviderMetadata"].(map[string]any)
	if providerMetadata == nil {
		providerMetadata = map[string]any{}
	}
	details, _ := providerMetadata["justai"].(map[string]any)
	if details == nil {
		details = map[string]any{}
	}
	if _, exists := details["serverId"]; !exists && match.ServerID != uuid.Nil {
		details["serverId"] = match.ServerID.String()
	}
	if current, _ := details["serverName"].(string); strings.TrimSpace(current) == "" && strings.TrimSpace(match.ServerName) != "" {
		details["serverName"] = match.ServerName
	}
	if current, _ := details["toolName"].(string); strings.TrimSpace(current) == "" && strings.TrimSpace(match.ToolName) != "" {
		details["toolName"] = match.ToolName
	}
	if current, _ := details["iconUrl"].(string); strings.TrimSpace(current) == "" && strings.TrimSpace(match.IconURL) != "" {
		details["iconUrl"] = match.IconURL
	}
	providerMetadata["justai"] = details
	part["callProviderMetadata"] = providerMetadata
}

func assistantUIFindToolDisplayBinding(toolName string, bindings []assistantUIToolDisplayBinding) (assistantUIToolDisplayBinding, bool) {
	toolName = strings.TrimSpace(toolName)
	if toolName == "" {
		return assistantUIToolDisplayBinding{}, false
	}

	var providerMatch *assistantUIToolDisplayBinding
	for index := range bindings {
		binding := bindings[index]
		if binding.ToolName == "" || !assistantUIProviderToolNameMatches(toolName, binding) {
			continue
		}
		if providerMatch != nil {
			return assistantUIToolDisplayBinding{}, false
		}
		providerMatch = &bindings[index]
	}
	if providerMatch != nil {
		return *providerMatch, true
	}

	normalized := normalizeVoiceToolPart(toolName)
	var rawMatch *assistantUIToolDisplayBinding
	for index := range bindings {
		binding := bindings[index]
		if binding.ToolName == "" || normalizeVoiceToolPart(binding.ToolName) != normalized {
			continue
		}
		if rawMatch != nil {
			return assistantUIToolDisplayBinding{}, false
		}
		rawMatch = &bindings[index]
	}
	if rawMatch == nil {
		return assistantUIToolDisplayBinding{}, false
	}
	return *rawMatch, true
}

func assistantUIProviderToolNameMatches(toolName string, binding assistantUIToolDisplayBinding) bool {
	base := voiceToolName(binding.ServerID, binding.ToolName, map[string]voiceToolBinding{})
	if toolName == base {
		return true
	}
	if !strings.HasPrefix(toolName, base+"_") {
		return false
	}
	suffix := strings.TrimPrefix(toolName, base+"_")
	if suffix == "" {
		return false
	}
	for _, character := range suffix {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
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
		if json.Unmarshal([]byte(content), &event) == nil && isChatToolEventKind(event.Kind) {
			state := "output-available"
			part := map[string]any{"type": "dynamic-tool", "toolName": assistantUIToolName(event), "toolCallId": event.CallID, "input": event.Arguments, "state": state, "dynamic": true}
			if providerMetadata := assistantUIToolProviderMetadata(event); providerMetadata != nil {
				part["callProviderMetadata"] = providerMetadata
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
			for _, citation := range deduplicateAssistantUICitations(items) {
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
	if !a.conversationAccessibleBy(c, conversationID, principal.UserID, organizationID) {
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
	if lookupErr == nil {
		var existingRunStatus string
		if err := a.DB.QueryRowContext(c, `SELECT run_status FROM messages WHERE id = $1 AND conversation_id = $2`, messageID, conversationID).Scan(&existingRunStatus); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		// The stream handler writes the durable error part before the AI SDK's
		// terminal history callback runs. That callback only knows about the
		// runtime status and would otherwise overwrite the richer persisted
		// error with a plain, empty UI message.
		if existingRunStatus == "error" {
			c.Status(http.StatusNoContent)
			return
		}
	}
	_, err = a.DB.ExecContext(c, `
		INSERT INTO messages AS existing (id, conversation_id, role, content, format, ui_message, parent_id, run_status, updated_at)
		VALUES ($1, $2, $3, $4, 'ai-sdk-ui', $5, $6::uuid, $7, now())
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
	if !a.conversationAccessibleBy(c, conversationID, principal.UserID, organizationID) {
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
	case "running", "requires-action", "complete", "incomplete", "error":
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
