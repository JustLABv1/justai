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
	"github.com/gorilla/websocket"

	"justai-backend/auth"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

type wsTicketRequest struct {
	Kind           string `json:"kind"`
	SessionID      string `json:"sessionId"`
	SourceID       string `json:"sourceId"`
	ConversationID string `json:"conversationId"`
}

type chatToolEvent struct {
	Kind          string         `json:"kind"`
	Status        string         `json:"status"`
	Round         int            `json:"round,omitempty"`
	ServerID      uuid.UUID      `json:"serverId"`
	ServerName    string         `json:"serverName"`
	ToolName      string         `json:"toolName"`
	CallID        string         `json:"callId"`
	ApprovalID    string         `json:"approvalId,omitempty"`
	Arguments     map[string]any `json:"arguments,omitempty"`
	Result        string         `json:"result,omitempty"`
	ResultPreview string         `json:"resultPreview,omitempty"`
	Error         string         `json:"error,omitempty"`
}

var websocketUpgrader = websocket.Upgrader{
	ReadBufferSize:  16 * 1024,
	WriteBufferSize: 16 * 1024,
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

func (a *App) createWSTicket(c *gin.Context) {
	var request wsTicketRequest
	if !decodeJSON(c, &request) {
		return
	}
	if request.Kind != "voice" && request.Kind != "transcription" && request.Kind != "transcription-viewer" && request.Kind != "transcription-capture" {
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
		if request.Kind != "transcription-viewer" {
			var sessionStatus string
			if err := a.DB.QueryRowContext(c, `SELECT status FROM transcription_sessions WHERE id = $1`, parsedSession).Scan(&sessionStatus); err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			if sessionStatus == "completed" || sessionStatus == "processing" {
				writeError(c, http.StatusConflict, fmt.Errorf("transcription session is no longer live"))
				return
			}
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

func (a *App) conversationHasIndexingKnowledge(ctx context.Context, conversationID uuid.UUID) (bool, error) {
	var indexing bool
	err := a.DB.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversation_knowledge_sources cks
			JOIN knowledge_sources ks ON ks.id = cks.source_id
			WHERE cks.conversation_id = $1 AND ks.status IN ('queued', 'processing')
		)`, conversationID).Scan(&indexing)
	return indexing, err
}

func (a *App) searchKnowledge(ctx context.Context, organizationID, userID, conversationID uuid.UUID, query string, limit int) ([]models.Citation, error) {
	return a.RAG.SearchConversation(ctx, conversationID, query, limit)
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

func (a *App) conversationToolHistoryFromHead(ctx context.Context, conversationID, headID uuid.UUID) ([]provider.ToolMessage, error) {
	stored, err := a.conversationBranchMessages(ctx, conversationID, headID)
	if err != nil {
		return nil, err
	}
	return buildConversationToolHistory(stored), nil
}

func (a *App) conversationBranchMessages(ctx context.Context, conversationID, headID uuid.UUID) ([]storedChatMessage, error) {
	if headID == uuid.Nil {
		return []storedChatMessage{}, nil
	}
	rows, err := a.DB.QueryContext(ctx, `
		WITH RECURSIVE branch AS (
			SELECT id, parent_id, role, content, created_at
			FROM messages
			WHERE conversation_id = $1 AND id = $2
			UNION ALL
			SELECT message.id, message.parent_id, message.role, message.content, message.created_at
			FROM messages message
			JOIN branch current ON current.parent_id = message.id
			WHERE message.conversation_id = $1
		)
		SELECT role, content
		FROM branch
		ORDER BY created_at ASC, id ASC
	`, conversationID, headID)
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
	return stored, rows.Err()
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
	parentID, err := a.conversationHead(ctx, conversationID)
	if err != nil {
		return uuid.Nil
	}
	return a.persistChatToolEventAt(ctx, conversationID, parentID, event)
}

func (a *App) persistChatToolEventAt(ctx context.Context, conversationID uuid.UUID, parentID any, event chatToolEvent) uuid.UUID {
	content, err := json.Marshal(event)
	if err != nil {
		return uuid.Nil
	}
	messageID := uuid.New()
	uiMessage, err := json.Marshal(assistantUIToolMessage(messageID, event))
	if err != nil {
		return uuid.Nil
	}
	if _, err := a.DB.ExecContext(ctx, `
		INSERT INTO messages (id, conversation_id, role, content, format, ui_message, parent_id, run_status, updated_at)
		VALUES ($1, $2, 'tool', $3, 'ai-sdk-ui', $4, $5, $6, now())
	`, messageID, conversationID, string(content), uiMessage, parentID, assistantUIRunStatusForTool(event)); err != nil {
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
	uiMessage, err := json.Marshal(assistantUIToolMessage(messageID, event))
	if err != nil {
		return
	}
	_, _ = a.DB.ExecContext(ctx, `
		UPDATE messages
		SET content = $3, format = 'ai-sdk-ui', ui_message = $4, run_status = $5, updated_at = now()
		WHERE id = $1 AND conversation_id = $2 AND role = 'tool'
	`, messageID, conversationID, string(content), uiMessage, assistantUIRunStatusForTool(event))
}

func assistantUIRunStatusForTool(event chatToolEvent) string {
	switch event.Status {
	case "awaiting_approval":
		return "requires-action"
	case "running":
		return "running"
	default:
		return "complete"
	}
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
	if event.Result != "" || event.ResultPreview != "" {
		data["result"] = firstNonEmptyChatToolString(event.ResultPreview, event.Result)
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

func firstNonEmptyChatToolString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func (a *App) executeChatMCPTool(ctx context.Context, userID, organizationID, conversationID uuid.UUID, binding voiceToolBinding, arguments map[string]any) (json.RawMessage, error) {
	attached, err := a.conversationHasMCPServer(ctx, userID, organizationID, conversationID, binding.ServerID)
	if err != nil {
		return nil, err
	}
	if !attached {
		return nil, fmt.Errorf("MCP server is no longer attached to this conversation")
	}
	server, err := a.loadMCPServer(ctx, binding.ServerID.String())
	if err != nil {
		a.auditVoiceTool(ctx, userID, organizationID, "chat.mcp.completed", binding.ServerID, map[string]any{"conversationId": conversationID, "serverId": binding.ServerID, "serverName": binding.ServerName, "tool": binding.ToolName, "arguments": arguments, "success": false, "error": err.Error()})
		return nil, err
	}
	a.auditVoiceTool(ctx, userID, organizationID, "chat.mcp.execution", binding.ServerID, map[string]any{
		"conversationId": conversationID,
		"serverId":       binding.ServerID,
		"serverName":     binding.ServerName,
		"tool":           binding.ToolName,
		"arguments":      arguments,
	})
	result, err := server.CallTool(ctx, binding.ToolName, arguments)
	details := map[string]any{"conversationId": conversationID, "serverId": binding.ServerID, "serverName": binding.ServerName, "tool": binding.ToolName, "arguments": arguments, "success": err == nil}
	if err != nil {
		details["error"] = err.Error()
	}
	a.auditVoiceTool(ctx, userID, organizationID, "chat.mcp.completed", binding.ServerID, details)
	return result, err
}

func (a *App) conversationHasMCPServer(ctx context.Context, userID, organizationID, conversationID, serverID uuid.UUID) (bool, error) {
	var attached bool
	err := a.DB.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversation_mcp_servers cms
			JOIN conversations c ON c.id = cms.conversation_id
			JOIN mcp_servers ms ON ms.id = cms.server_id
			WHERE cms.conversation_id = $1 AND cms.server_id = $2
			  AND c.user_id = $3 AND c.organization_id = $4
			  AND ms.enabled = TRUE
			  AND ((ms.scope_type = 'organization' AND ms.scope_id = $4) OR (ms.scope_type = 'user' AND ms.scope_id = $3))
		)`, conversationID, serverID, userID, organizationID).Scan(&attached)
	return attached, err
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

func (a *App) conversationHistoryFromHead(ctx context.Context, conversationID, headID uuid.UUID) ([]provider.Message, error) {
	stored, err := a.conversationBranchMessages(ctx, conversationID, headID)
	if err != nil {
		return nil, err
	}
	result := make([]provider.Message, 0, len(stored))
	for _, item := range stored {
		if item.Role == "user" || item.Role == "assistant" {
			result = append(result, provider.Message{Role: item.Role, Content: item.Content})
		}
	}
	return result, nil
}

func (a *App) resolveEndpoint(ctx context.Context, userID, organizationID uuid.UUID, rawID string) (uuid.UUID, error) {
	if rawID != "" {
		id, err := uuid.Parse(rawID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("invalid endpoint id")
		}
		var scopeType string
		var scopeID sql.NullString
		if err := a.DB.QueryRowContext(ctx, `SELECT scope_type, scope_id::text FROM endpoint_settings WHERE id = $1 AND enabled = TRUE AND capabilities ? 'chat'`, id).Scan(&scopeType, &scopeID); err != nil {
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
	if err := a.DB.QueryRowContext(ctx, `SELECT id FROM endpoint_settings WHERE enabled = TRUE AND capabilities ? 'chat' AND ((scope_type = 'user' AND scope_id = $1) OR (scope_type = 'organization' AND scope_id = $2) OR scope_type = 'global') ORDER BY CASE WHEN scope_type = 'user' THEN 1 WHEN scope_type = 'organization' THEN 2 ELSE 3 END, is_default DESC, created_at LIMIT 1`, userID, organizationID).Scan(&id); err != nil {
		return uuid.Nil, fmt.Errorf("no enabled chat endpoint is configured")
	}
	return id, nil
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
