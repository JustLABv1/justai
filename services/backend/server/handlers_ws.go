package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"justai-backend/auth"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
	"justai-backend/rag"
)

type wsTicketRequest struct {
	Kind           string `json:"kind"`
	SessionID      string `json:"sessionId"`
	SourceID       string `json:"sourceId"`
	ConversationID string `json:"conversationId"`
}

type chatEvent struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	Data      json.RawMessage `json:"data"`
}

type sessionStartData struct {
	ConversationID string `json:"conversationId"`
	EndpointID     string `json:"endpointId"`
}

type messageSendData struct {
	ConversationID string `json:"conversationId"`
	EndpointID     string `json:"endpointId"`
	Content        string `json:"content"`
}

type chatToolDecisionData struct {
	ApprovalID string `json:"approvalId"`
	Approved   bool   `json:"approved"`
}

type chatToolApproval struct {
	ID         string
	ServerID   uuid.UUID
	ServerName string
	ToolName   string
	CallID     string
	Arguments  map[string]any
	Decision   chan bool
}

type chatToolEvent struct {
	Kind       string         `json:"kind"`
	Status     string         `json:"status"`
	Round      int            `json:"round,omitempty"`
	ServerID   uuid.UUID      `json:"serverId"`
	ServerName string         `json:"serverName"`
	ToolName   string         `json:"toolName"`
	CallID     string         `json:"callId"`
	ApprovalID string         `json:"approvalId,omitempty"`
	Arguments  map[string]any `json:"arguments,omitempty"`
	Result     string         `json:"result,omitempty"`
	Error      string         `json:"error,omitempty"`
}

type chatState struct {
	conversationID uuid.UUID
	endpointID     uuid.UUID
	sequence       int64
	writeMu        sync.Mutex
	streamMu       sync.Mutex
	cancelStream   context.CancelFunc
	pendingMu      sync.Mutex
	pending        map[string]*chatToolApproval
}

var websocketUpgrader = websocket.Upgrader{
	ReadBufferSize:  16 * 1024,
	WriteBufferSize: 16 * 1024,
}

func (a *App) createWSTicket(c *gin.Context) {
	var request wsTicketRequest
	if !decodeJSON(c, &request) {
		return
	}
	if request.Kind != "chat" && request.Kind != "voice" && request.Kind != "transcription" && request.Kind != "transcription-viewer" && request.Kind != "transcription-capture" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("unsupported websocket ticket kind"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	if organizationID == uuid.Nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("organization context is required"))
		return
	}
	var conversationID, sessionID, sourceID any
	if request.Kind == "voice" {
		parsedConversation, err := uuid.Parse(request.ConversationID)
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("conversationId is required for voice tickets"))
			return
		}
		var allowed bool
		if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND organization_id = $3)`, parsedConversation, principal.UserID, organizationID).Scan(&allowed); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if !allowed {
			writeError(c, http.StatusForbidden, fmt.Errorf("conversation not found"))
			return
		}
		conversationID = parsedConversation
	}
	if request.Kind == "transcription" || request.Kind == "transcription-viewer" || request.Kind == "transcription-capture" {
		parsedSession, err := uuid.Parse(request.SessionID)
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("sessionId is required"))
			return
		}
		if err := a.authorizeTranscriptionSession(c, parsedSession, principal.UserID, organizationID); err != nil {
			writeError(c, http.StatusForbidden, err)
			return
		}
		sessionID = parsedSession
		if request.Kind == "transcription-capture" {
			parsedSource, err := uuid.Parse(request.SourceID)
			if err != nil {
				writeError(c, http.StatusBadRequest, fmt.Errorf("sourceId is required for capture tickets"))
				return
			}
			if err := a.authorizeTranscriptionSource(c, parsedSession, parsedSource, principal.UserID, organizationID); err != nil {
				writeError(c, http.StatusForbidden, err)
				return
			}
			sourceID = parsedSource
		}
	}
	value, hash, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	expiresAt := time.Now().Add(2 * time.Minute)
	if _, err := a.DB.ExecContext(c, `INSERT INTO ws_tickets (token_hash, user_id, organization_id, kind, conversation_id, session_id, source_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, hash, principal.UserID, organizationID, request.Kind, conversationID, sessionID, sourceID, expiresAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ticket": value, "expiresAt": expiresAt, "kind": request.Kind})
}

func (a *App) chatWebSocket(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, err := a.consumeTicket(c, c.Query("ticket"), "chat", principal.UserID)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	connection, err := a.upgradeWebSocket(c)
	if err != nil {
		return
	}
	defer connection.Close()
	a.runChatSocket(c, connection, principal.UserID, organizationID)
}

func (a *App) upgradeWebSocket(c *gin.Context) (*websocket.Conn, error) {
	upgrader := websocketUpgrader
	upgrader.CheckOrigin = func(request *http.Request) bool {
		origin := request.Header.Get("Origin")
		if origin == "" {
			return true
		}
		for _, allowed := range a.Config.FrontendOrigins {
			if allowed == "*" || allowed == origin {
				return true
			}
		}
		return false
	}
	return upgrader.Upgrade(c.Writer, c.Request, nil)
}

func (a *App) consumeTicket(ctx context.Context, value, kind string, userID uuid.UUID) (uuid.UUID, error) {
	if value == "" {
		return uuid.Nil, fmt.Errorf("websocket ticket is required")
	}
	hash := hashToken(value)
	var organizationID uuid.UUID
	var ticketUser uuid.UUID
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return uuid.Nil, err
	}
	defer transaction.Rollback()
	err = transaction.QueryRowContext(ctx, `SELECT organization_id, user_id FROM ws_tickets WHERE token_hash = $1 AND kind = $2 AND expires_at > now() AND used_at IS NULL FOR UPDATE`, hash, kind).Scan(&organizationID, &ticketUser)
	if err != nil || ticketUser != userID {
		return uuid.Nil, fmt.Errorf("invalid or expired websocket ticket")
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE ws_tickets SET used_at = now() WHERE token_hash = $1`, hash); err != nil {
		return uuid.Nil, err
	}
	if err := transaction.Commit(); err != nil {
		return uuid.Nil, err
	}
	return organizationID, nil
}

func (a *App) runChatSocket(ctx *gin.Context, connection *websocket.Conn, userID, organizationID uuid.UUID) {
	state := &chatState{pending: map[string]*chatToolApproval{}}
	socketContext, cancelSocket := context.WithCancel(ctx)
	defer cancelSocket()
	for {
		messageType, payload, err := connection.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.TextMessage {
			_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", Data: gin.H{"message": "chat messages must be JSON text"}})
			continue
		}
		var event chatEvent
		if err := json.Unmarshal(payload, &event); err != nil {
			_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", Data: gin.H{"message": "invalid chat event"}})
			continue
		}
		switch event.Type {
		case "session.start":
			var data sessionStartData
			if err := json.Unmarshal(event.Data, &data); err != nil {
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "invalid session.start payload"}})
				continue
			}
			conversationID, err := a.ensureConversation(ctx, userID, organizationID, data.ConversationID)
			if err != nil {
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": err.Error()}})
				continue
			}
			endpointID, err := a.resolveEndpoint(ctx, userID, organizationID, data.EndpointID)
			if err != nil {
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": err.Error()}})
				continue
			}
			state.conversationID, state.endpointID = conversationID, endpointID
			_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "session.ready", RequestID: event.RequestID, Data: gin.H{"conversationId": conversationID, "endpointId": endpointID}})
		case "message.send":
			var data messageSendData
			if err := json.Unmarshal(event.Data, &data); err != nil || strings.TrimSpace(data.Content) == "" {
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "message content is required"}})
				continue
			}
			conversationID := state.conversationID
			if data.ConversationID != "" {
				conversationID, err = a.ensureConversation(ctx, userID, organizationID, data.ConversationID)
				if err != nil {
					_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": err.Error()}})
					continue
				}
			}
			if conversationID == uuid.Nil {
				conversationID, err = a.ensureConversation(ctx, userID, organizationID, "")
				if err != nil {
					_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": err.Error()}})
					continue
				}
				state.conversationID = conversationID
			}
			state.conversationID = conversationID
			endpointID := state.endpointID
			if data.EndpointID != "" {
				endpointID, err = a.resolveEndpoint(ctx, userID, organizationID, data.EndpointID)
				if err != nil {
					_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": err.Error()}})
					continue
				}
				state.endpointID = endpointID
			}
			state.streamMu.Lock()
			if state.cancelStream != nil {
				state.streamMu.Unlock()
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "a response is already streaming"}})
				continue
			}
			streamContext, cancelStream := context.WithCancel(socketContext)
			state.cancelStream = cancelStream
			state.streamMu.Unlock()
			go func() {
				defer func() {
					state.streamMu.Lock()
					state.cancelStream = nil
					state.streamMu.Unlock()
				}()
				a.streamChatMessage(streamContext, connection, state, userID, organizationID, endpointID, conversationID, event.RequestID, strings.TrimSpace(data.Content))
			}()
		case "tool.approve", "tool.reject", "tool.decision":
			var data chatToolDecisionData
			if err := json.Unmarshal(event.Data, &data); err != nil || data.ApprovalID == "" {
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "approvalId is required"}})
				continue
			}
			if event.Type == "tool.reject" {
				data.Approved = false
			}
			if !decideChatApproval(state, data.ApprovalID, data.Approved) {
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "approval is no longer pending"}})
			}
		case "cancel":
			state.streamMu.Lock()
			cancelStream := state.cancelStream
			state.streamMu.Unlock()
			if cancelStream == nil {
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "cancelled", RequestID: event.RequestID, Data: gin.H{"message": "No active stream"}})
			} else {
				cancelStream()
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "cancelled", RequestID: event.RequestID, Data: gin.H{"message": "Response cancelled"}})
			}
		default:
			_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "unsupported chat event: " + event.Type}})
		}
	}
}

func (a *App) streamChatMessage(ctx context.Context, connection *websocket.Conn, state *chatState, userID, organizationID, endpointID, conversationID uuid.UUID, requestID, content string) {
	if _, err := a.DB.ExecContext(ctx, `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)`, conversationID, content); err != nil {
		_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": err.Error()}})
		return
	}
	if _, err := a.DB.ExecContext(ctx, `
		UPDATE conversations
		SET title = CASE WHEN title = $2 THEN $3 ELSE title END, updated_at = now()
		WHERE id = $1
	`, conversationID, defaultConversationTitle, conversationTitle(content)); err != nil {
		_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": err.Error()}})
		return
	}
	_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "message.accepted", RequestID: requestID, Data: gin.H{"conversationId": conversationID}})
	_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "retrieval.started", RequestID: requestID, Data: gin.H{"query": content}})
	citations, err := a.searchKnowledge(ctx, organizationID, userID, content, 6)
	if err != nil {
		citations = nil
	}
	_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "retrieval.completed", RequestID: requestID, Data: gin.H{"citations": citations}})

	history, err := a.conversationHistory(ctx, conversationID)
	if err != nil {
		_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": err.Error()}})
		return
	}
	if len(citations) > 0 {
		history = append([]provider.Message{{Role: "system", Content: citationPrompt(citations)}}, history...)
	}
	endpoint, err := a.providerEndpoint(ctx, endpointID)
	if err != nil {
		_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": "endpoint could not be loaded: " + err.Error()}})
		return
	}
	var response strings.Builder
	discovery := a.discoverVoiceTools(ctx, userID, organizationID)
	definitions, bindings := discovery.Definitions, discovery.Bindings
	if len(definitions) > 0 {
		_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tools.ready", RequestID: requestID, Data: gin.H{"count": len(definitions)}})
	} else if discovery.ServerCount > 0 || len(discovery.Errors) > 0 {
		message := "MCP servers are configured, but no tools were discovered."
		if len(discovery.Errors) > 0 {
			message += " " + strings.Join(discovery.Errors, "; ")
		}
		_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tools.unavailable", RequestID: requestID, Data: gin.H{"message": message}})
	}
	if len(definitions) > 0 && provider.SupportsToolCalling(endpoint) {
		toolHistory, historyErr := a.conversationToolHistory(ctx, conversationID)
		if historyErr != nil {
			_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": historyErr.Error()}})
			return
		}
		toolHistory = append([]provider.ToolMessage{{Role: "system", Content: chatToolInstructions()}}, toolHistory...)
		if len(citations) > 0 {
			toolHistory = append([]provider.ToolMessage{{Role: "system", Content: citationPrompt(citations)}}, toolHistory...)
		}
		err = a.streamChatWithTools(ctx, connection, state, userID, organizationID, conversationID, requestID, endpoint, toolHistory, definitions, bindings, &response)
	} else {
		if len(definitions) > 0 {
			_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tools.unavailable", RequestID: requestID, Data: gin.H{"count": len(definitions), "message": "MCP tools are connected, but this endpoint does not have tool calling enabled. Enable the tool-calling capability for the selected endpoint."}})
		}
		err = provider.StreamChat(ctx, endpoint, provider.ChatOptions{Messages: history}, func(delta string) error {
			response.WriteString(delta)
			return a.sendSocket(connection, state, models.SocketEnvelope{Type: "message.delta", RequestID: requestID, Data: gin.H{"delta": delta}})
		})
	}
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": err.Error()}})
		return
	}
	assistantContent := response.String()
	if _, err := a.DB.ExecContext(ctx, `INSERT INTO messages (conversation_id, role, content, citations) VALUES ($1, 'assistant', $2, $3)`, conversationID, assistantContent, jsonRaw(citations)); err != nil {
		_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": err.Error()}})
		return
	}
	_, _ = a.DB.ExecContext(ctx, `UPDATE conversations SET endpoint_id = $2, updated_at = now() WHERE id = $1`, conversationID, endpointID)
	_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "message.completed", RequestID: requestID, Data: gin.H{"conversationId": conversationID, "content": assistantContent, "citations": citations}})
}

func (a *App) searchKnowledge(ctx context.Context, organizationID, userID uuid.UUID, query string, limit int) ([]models.Citation, error) {
	if a.RAG != nil {
		return a.RAG.Search(ctx, organizationID, userID, query, limit)
	}
	return rag.Search(ctx, a.DB, organizationID, userID, query, limit)
}

func chatToolInstructions() string {
	return "Use the connected MCP tools whenever they can provide relevant information for the user's question. Re-evaluate the current question on every turn and make a fresh tool call when the answer may depend on connected sources; do not rely only on an earlier tool result. If a prior call failed or returned incomplete information, try the relevant tool again. Do not claim that you searched a source unless you actually called the tool."
}

type storedChatMessage struct {
	Role    string
	Content string
}

func (a *App) conversationToolHistory(ctx context.Context, conversationID uuid.UUID) ([]provider.ToolMessage, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 500`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stored := []storedChatMessage{}
	for rows.Next() {
		var item storedChatMessage
		if err := rows.Scan(&item.Role, &item.Content); err != nil {
			return nil, err
		}
		stored = append(stored, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return buildConversationToolHistory(stored), nil
}

func buildConversationToolHistory(stored []storedChatMessage) []provider.ToolMessage {
	const maxConversationMessages = 20
	nonToolMessages := 0
	for _, item := range stored {
		if item.Role != "tool" {
			nonToolMessages++
		}
	}
	if nonToolMessages > maxConversationMessages {
		remaining := nonToolMessages
		for index, item := range stored {
			if item.Role == "tool" {
				continue
			}
			remaining--
			if remaining == maxConversationMessages {
				stored = stored[index:]
				break
			}
		}
	}

	history := make([]provider.ToolMessage, 0, len(stored))
	for index := 0; index < len(stored); {
		item := stored[index]
		if item.Role != "tool" {
			history = append(history, provider.ToolMessage{Role: item.Role, Content: item.Content})
			index++
			continue
		}

		firstEvent, ok := parseChatToolEvent(item.Content)
		if !ok {
			// Do not send an unstructured tool row to a provider. It would be
			// invalid without the corresponding assistant tool_calls message.
			index++
			continue
		}
		group := []chatToolEvent{firstEvent}
		index++
		for index < len(stored) && stored[index].Role == "tool" {
			next, nextOK := parseChatToolEvent(stored[index].Content)
			if !nextOK || (firstEvent.Round > 0 && next.Round != firstEvent.Round) {
				break
			}
			group = append(group, next)
			index++
		}

		calls := make([]provider.ToolCall, 0, len(group))
		for _, event := range group {
			arguments := "{}"
			if event.Arguments != nil {
				if encoded, err := json.Marshal(event.Arguments); err == nil {
					arguments = string(encoded)
				}
			}
			calls = append(calls, provider.ToolCall{ID: event.CallID, Name: event.ToolName, Arguments: arguments})
		}
		history = append(history, provider.ToolMessage{Role: "assistant", ToolCalls: calls})
		for _, event := range group {
			content := event.Result
			if content == "" {
				content = event.Error
			}
			if content == "" {
				content = "The MCP tool did not return a result."
			}
			history = append(history, provider.ToolMessage{Role: "tool", ToolCallID: event.CallID, Content: content})
		}
	}
	return history
}

func parseChatToolEvent(content string) (chatToolEvent, bool) {
	var event chatToolEvent
	if err := json.Unmarshal([]byte(content), &event); err != nil || event.Kind != "mcp_tool" || event.CallID == "" || event.ToolName == "" {
		return chatToolEvent{}, false
	}
	return event, true
}

func (a *App) persistChatToolEvent(ctx context.Context, conversationID uuid.UUID, event chatToolEvent) uuid.UUID {
	content, err := json.Marshal(event)
	if err != nil {
		return uuid.Nil
	}
	var messageID uuid.UUID
	if err := a.DB.QueryRowContext(ctx, `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'tool', $2) RETURNING id`, conversationID, string(content)).Scan(&messageID); err != nil {
		return uuid.Nil
	}
	return messageID
}

func (a *App) updateChatToolEvent(ctx context.Context, conversationID, messageID uuid.UUID, event chatToolEvent) {
	if messageID == uuid.Nil {
		return
	}
	content, err := json.Marshal(event)
	if err != nil {
		return
	}
	_, _ = a.DB.ExecContext(ctx, `UPDATE messages SET content = $3 WHERE id = $1 AND conversation_id = $2 AND role = 'tool'`, messageID, conversationID, string(content))
}

func chatToolEventData(messageID uuid.UUID, event chatToolEvent) gin.H {
	data := gin.H{
		"messageId":  messageID,
		"kind":       event.Kind,
		"status":     event.Status,
		"serverId":   event.ServerID,
		"serverName": event.ServerName,
		"toolName":   event.ToolName,
		"callId":     event.CallID,
	}
	if event.ApprovalID != "" {
		data["approvalId"] = event.ApprovalID
	}
	if event.Arguments != nil {
		data["arguments"] = event.Arguments
	}
	if event.Result != "" {
		data["result"] = event.Result
	}
	if event.Error != "" {
		data["error"] = event.Error
	}
	return data
}

func toolResultPreview(result json.RawMessage) string {
	const maxRunes = 4000
	value := []rune(string(result))
	if len(value) <= maxRunes {
		return string(value)
	}
	return string(value[:maxRunes]) + "…"
}

func (a *App) streamChatWithTools(ctx context.Context, connection *websocket.Conn, state *chatState, userID, organizationID, conversationID uuid.UUID, requestID string, endpoint provider.Endpoint, history []provider.ToolMessage, definitions []provider.ToolDefinition, bindings map[string]voiceToolBinding, response *strings.Builder) error {
	toolMessages := append([]provider.ToolMessage(nil), history...)
	for round := 1; round <= 4; round++ {
		var roundResponse strings.Builder
		calls := []provider.ToolCall{}
		err := provider.StreamChatWithTools(ctx, endpoint, provider.ToolChatOptions{Messages: toolMessages, Tools: definitions, Model: endpoint.ChatModel}, func(event provider.ToolChatEvent) error {
			if event.Delta != "" {
				roundResponse.WriteString(event.Delta)
				response.WriteString(event.Delta)
				return a.sendSocket(connection, state, models.SocketEnvelope{Type: "message.delta", RequestID: requestID, Data: gin.H{"delta": event.Delta}})
			}
			if len(event.ToolCalls) > 0 {
				calls = append(calls, event.ToolCalls...)
			}
			return nil
		})
		if err != nil {
			return err
		}
		if len(calls) == 0 {
			return nil
		}

		toolMessages = append(toolMessages, provider.ToolMessage{Role: "assistant", Content: roundResponse.String(), ToolCalls: calls})
		for _, call := range calls {
			arguments := map[string]any{}
			if strings.TrimSpace(call.Arguments) != "" {
				if err := json.Unmarshal([]byte(call.Arguments), &arguments); err != nil {
					event := chatToolEvent{Kind: "mcp_tool", Status: "failed", Round: round, ServerName: "MCP server", ToolName: call.Name, CallID: call.ID, Error: "The MCP tool arguments were invalid JSON."}
					messageID := a.persistChatToolEvent(ctx, conversationID, event)
					_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tool.call", RequestID: requestID, Data: chatToolEventData(messageID, event)})
					toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: "The MCP tool arguments were invalid JSON."})
					continue
				}
			}
			binding, exists := bindings[call.Name]
			if !exists {
				event := chatToolEvent{Kind: "mcp_tool", Status: "failed", Round: round, ServerName: "MCP server", ToolName: call.Name, CallID: call.ID, Arguments: arguments, Error: "The requested MCP tool is not available."}
				messageID := a.persistChatToolEvent(ctx, conversationID, event)
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tool.call", RequestID: requestID, Data: chatToolEventData(messageID, event)})
				toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: "The requested MCP tool is not available."})
				continue
			}

			event := chatToolEvent{Kind: "mcp_tool", Status: "running", Round: round, ServerID: binding.ServerID, ServerName: binding.ServerName, ToolName: binding.ToolName, CallID: call.ID, Arguments: arguments}
			if binding.RequiresApproval {
				event.Status = "awaiting_approval"
			}
			messageID := a.persistChatToolEvent(ctx, conversationID, event)
			_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tool.call", RequestID: requestID, Data: chatToolEventData(messageID, event)})

			approved := true
			approvalID := ""
			var approvalErr error
			if binding.RequiresApproval {
				approvalID, approved, approvalErr = a.awaitChatApproval(ctx, connection, state, userID, organizationID, requestID, messageID, binding, call, arguments, round)
				event.ApprovalID = approvalID
				if approvalErr != nil {
					event.Status = "failed"
					event.Error = approvalErr.Error()
					a.updateChatToolEvent(ctx, conversationID, messageID, event)
					_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tool.completed", RequestID: requestID, Data: chatToolEventData(messageID, event)})
					return approvalErr
				}
			}
			if !approved {
				event.Status = "declined"
				event.Error = "declined by user"
				a.updateChatToolEvent(ctx, conversationID, messageID, event)
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tool.completed", RequestID: requestID, Data: chatToolEventData(messageID, event)})
				toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: "The user declined this MCP tool call."})
				continue
			}
			if binding.RequiresApproval {
				event.Status = "running"
				a.updateChatToolEvent(ctx, conversationID, messageID, event)
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tool.updated", RequestID: requestID, Data: chatToolEventData(messageID, event)})
			}

			result, callErr := a.executeChatMCPTool(ctx, userID, organizationID, conversationID, binding, arguments)
			if callErr != nil {
				event.Status = "failed"
				event.Error = callErr.Error()
				a.updateChatToolEvent(ctx, conversationID, messageID, event)
				_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tool.completed", RequestID: requestID, Data: chatToolEventData(messageID, event)})
				toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: "The MCP tool failed: " + callErr.Error()})
				continue
			}
			event.Status = "completed"
			event.Result = toolResultPreview(result)
			a.updateChatToolEvent(ctx, conversationID, messageID, event)
			_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tool.completed", RequestID: requestID, Data: chatToolEventData(messageID, event)})
			toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: string(result)})
		}
		if round == 4 {
			message := "\n\nI stopped after four MCP tool rounds to keep this turn bounded."
			response.WriteString(message)
			_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "message.delta", RequestID: requestID, Data: gin.H{"delta": message}})
			return nil
		}
	}
	return nil
}

func (a *App) awaitChatApproval(ctx context.Context, connection *websocket.Conn, state *chatState, userID, organizationID uuid.UUID, requestID string, messageID uuid.UUID, binding voiceToolBinding, call provider.ToolCall, arguments map[string]any, round int) (string, bool, error) {
	approvalID := uuid.NewString()
	pending := &chatToolApproval{ID: approvalID, ServerID: binding.ServerID, ServerName: binding.ServerName, ToolName: binding.ToolName, CallID: call.ID, Arguments: arguments, Decision: make(chan bool, 1)}
	state.pendingMu.Lock()
	state.pending[approvalID] = pending
	state.pendingMu.Unlock()
	_ = a.sendSocket(connection, state, models.SocketEnvelope{Type: "tool.approval_required", RequestID: requestID, Data: gin.H{"approvalId": approvalID, "messageId": messageID, "callId": call.ID, "serverId": binding.ServerID, "serverName": binding.ServerName, "toolName": binding.ToolName, "arguments": arguments, "round": round}})
	select {
	case approved := <-pending.Decision:
		state.pendingMu.Lock()
		delete(state.pending, approvalID)
		state.pendingMu.Unlock()
		a.auditVoiceTool(ctx, userID, organizationID, "chat.mcp.approval", binding.ServerID, map[string]any{"conversationId": state.conversationID, "serverId": binding.ServerID, "serverName": binding.ServerName, "tool": binding.ToolName, "arguments": arguments, "approved": approved})
		return approvalID, approved, nil
	case <-ctx.Done():
		state.pendingMu.Lock()
		delete(state.pending, approvalID)
		state.pendingMu.Unlock()
		return approvalID, false, ctx.Err()
	}
}

func decideChatApproval(state *chatState, approvalID string, approved bool) bool {
	state.pendingMu.Lock()
	pending, ok := state.pending[approvalID]
	if ok {
		delete(state.pending, approvalID)
	}
	state.pendingMu.Unlock()
	if !ok {
		return false
	}
	pending.Decision <- approved
	return true
}

func (a *App) executeChatMCPTool(ctx context.Context, userID, organizationID, conversationID uuid.UUID, binding voiceToolBinding, arguments map[string]any) (json.RawMessage, error) {
	server, err := a.loadMCPServer(ctx, binding.ServerID.String())
	if err != nil {
		a.auditVoiceTool(ctx, userID, organizationID, "chat.mcp.completed", binding.ServerID, map[string]any{"conversationId": conversationID, "serverId": binding.ServerID, "serverName": binding.ServerName, "tool": binding.ToolName, "arguments": arguments, "success": false, "error": err.Error()})
		return nil, err
	}
	result, err := server.CallTool(ctx, binding.ToolName, arguments)
	details := map[string]any{"conversationId": conversationID, "serverId": binding.ServerID, "serverName": binding.ServerName, "tool": binding.ToolName, "arguments": arguments, "success": err == nil}
	if err != nil {
		details["error"] = err.Error()
	}
	a.auditVoiceTool(ctx, userID, organizationID, "chat.mcp.completed", binding.ServerID, details)
	return result, err
}

func (a *App) ensureConversation(ctx context.Context, userID, organizationID uuid.UUID, rawID string) (uuid.UUID, error) {
	if rawID != "" {
		id, err := uuid.Parse(rawID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("invalid conversation id")
		}
		var exists bool
		if err := a.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND organization_id = $3)`, id, userID, organizationID).Scan(&exists); err != nil {
			return uuid.Nil, err
		}
		if !exists {
			return uuid.Nil, fmt.Errorf("conversation not found")
		}
		return id, nil
	}
	var id uuid.UUID
	err := a.DB.QueryRowContext(ctx, `INSERT INTO conversations (user_id, organization_id) VALUES ($1, $2) RETURNING id`, userID, organizationID).Scan(&id)
	return id, err
}

func (a *App) conversationHistory(ctx context.Context, conversationID uuid.UUID) ([]provider.Message, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT role, content FROM messages WHERE conversation_id = $1 AND role IN ('user', 'assistant') ORDER BY created_at DESC LIMIT 20`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []provider.Message{}
	for rows.Next() {
		var item provider.Message
		if err := rows.Scan(&item.Role, &item.Content); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
		result[left], result[right] = result[right], result[left]
	}
	return result, rows.Err()
}

func (a *App) resolveEndpoint(ctx context.Context, userID, organizationID uuid.UUID, rawID string) (uuid.UUID, error) {
	if rawID != "" {
		id, err := uuid.Parse(rawID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("invalid endpoint id")
		}
		var scopeType string
		var scopeID sql.NullString
		if err := a.DB.QueryRowContext(ctx, `SELECT scope_type, scope_id::text FROM endpoint_settings WHERE id = $1 AND enabled = TRUE`, id).Scan(&scopeType, &scopeID); err != nil {
			return uuid.Nil, fmt.Errorf("endpoint not found")
		}
		if scopeType == "global" {
			return id, nil
		}
		if !scopeID.Valid {
			return uuid.Nil, fmt.Errorf("endpoint scope is invalid")
		}
		if (scopeType == "user" && scopeID.String == userID.String()) || (scopeType == "organization" && scopeID.String == organizationID.String()) {
			return id, nil
		}
		return uuid.Nil, fmt.Errorf("endpoint is outside the current scope")
	}
	var id uuid.UUID
	if err := a.DB.QueryRowContext(ctx, `SELECT id FROM endpoint_settings WHERE enabled = TRUE AND ((scope_type = 'user' AND scope_id = $1) OR (scope_type = 'organization' AND scope_id = $2) OR scope_type = 'global') ORDER BY CASE WHEN scope_type = 'user' THEN 1 WHEN scope_type = 'organization' THEN 2 ELSE 3 END, is_default DESC, created_at LIMIT 1`, userID, organizationID).Scan(&id); err != nil {
		return uuid.Nil, fmt.Errorf("no enabled chat endpoint is configured")
	}
	return id, nil
}

func (a *App) sendSocket(connection *websocket.Conn, state *chatState, envelope models.SocketEnvelope) error {
	state.writeMu.Lock()
	defer state.writeMu.Unlock()
	state.sequence++
	envelope.Sequence = state.sequence
	return connection.WriteJSON(envelope)
}

func citationPrompt(citations []models.Citation) string {
	var builder strings.Builder
	builder.WriteString("Use the following retrieved context when it helps. Cite source titles naturally.\n")
	for _, citation := range citations {
		builder.WriteString("[")
		builder.WriteString(citation.Title)
		builder.WriteString("] ")
		builder.WriteString(citation.Snippet)
		builder.WriteByte('\n')
	}
	return builder.String()
}
