package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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
	"justai-backend/rag"
)

type wsTicketRequest struct {
	Kind           string `json:"kind"`
	SessionID      string `json:"sessionId"`
	SourceID       string `json:"sourceId"`
	ConversationID string `json:"conversationId"`
}

type chatToolEvent struct {
	Kind       string    `json:"kind"`
	Status     string    `json:"status"`
	Round      int       `json:"round,omitempty"`
	ServerID   uuid.UUID `json:"serverId"`
	ServerName string    `json:"serverName"`
	IconURL    string    `json:"iconUrl,omitempty"`
	// ToolName is the original MCP name used when executing the tool. The
	// provider-facing name is kept separately because model tool definitions
	// must be unique and may be normalized for the provider.
	ToolName          string         `json:"toolName"`
	ProviderToolName  string         `json:"providerToolName,omitempty"`
	MCPAppResourceURI string         `json:"mcpAppResourceUri,omitempty"`
	MCPAppMIMEType    string         `json:"mcpAppMimeType,omitempty"`
	CallID            string         `json:"callId"`
	ApprovalID        string         `json:"approvalId,omitempty"`
	Arguments         map[string]any `json:"arguments"`
	Result            string         `json:"result,omitempty"`
	ResultPreview     string         `json:"resultPreview,omitempty"`
	Error             string         `json:"error,omitempty"`
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

func assistantUISourceIDsCSV(sourceIDs []uuid.UUID) string {
	values := make([]string, 0, len(sourceIDs))
	for _, sourceID := range sourceIDs {
		if sourceID != uuid.Nil {
			values = append(values, sourceID.String())
		}
	}
	return strings.Join(values, ",")
}

func (a *App) conversationHasIndexingKnowledge(ctx context.Context, conversationID uuid.UUID, selectedSourceIDs []uuid.UUID) (bool, error) {
	var indexing bool
	err := a.DB.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversation_knowledge_sources cks
			JOIN knowledge_sources ks ON ks.id = cks.source_id
			WHERE cks.conversation_id = $1
			  AND CASE WHEN $2 = '' THEN cks.context_scope = 'persistent'
			           ELSE cks.source_id = ANY(string_to_array($2, ',')::uuid[])
			      END
			  AND ks.status IN ('queued', 'processing')
		)`, conversationID, assistantUISourceIDsCSV(selectedSourceIDs)).Scan(&indexing)
	return indexing, err
}

func (a *App) conversationHasKnowledge(ctx context.Context, conversationID uuid.UUID, selectedSourceIDs []uuid.UUID) (bool, error) {
	var attached bool
	err := a.DB.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM conversation_knowledge_sources cks
			JOIN knowledge_sources ks ON ks.id = cks.source_id
			WHERE cks.conversation_id = $1
			  AND CASE WHEN $2 = '' THEN cks.context_scope = 'persistent'
			           ELSE cks.source_id = ANY(string_to_array($2, ',')::uuid[])
			      END
		) OR EXISTS (
			SELECT 1
			FROM conversation_notes cn
			WHERE cn.conversation_id = $1
		)`, conversationID, assistantUISourceIDsCSV(selectedSourceIDs)).Scan(&attached)
	return attached, err
}

func (a *App) searchKnowledge(ctx context.Context, organizationID, userID, conversationID uuid.UUID, query string, limit int, selectedSourceIDs []uuid.UUID, deepContext bool) ([]models.Citation, error) {
	if deepContext {
		limit = rag.DeepContextLimit
	}
	var citations []models.Citation
	var err error
	if len(selectedSourceIDs) > 0 {
		if deepContext {
			citations, err = a.RAG.SearchConversationSourcesDeepContext(ctx, conversationID, query, limit, selectedSourceIDs)
		} else {
			citations, err = a.RAG.SearchConversationSources(ctx, conversationID, query, limit, selectedSourceIDs)
		}
	} else {
		if deepContext {
			citations, err = a.RAG.SearchConversationDeepContext(ctx, conversationID, query, limit)
		} else {
			citations, err = a.RAG.SearchConversation(ctx, conversationID, query, limit)
		}
	}
	if err != nil {
		return nil, err
	}
	noteCitations, err := a.searchConversationNotes(ctx, conversationID, query, limit)
	if err != nil {
		return nil, err
	}
	// Notes are explicit conversation context, so keep their citations at the
	// front of the bounded result set. The model also receives the note content
	// through attachedNotesPrompt below, which handles broad requests such as
	// “summarize this note” that have no lexical hit.
	combined := append(noteCitations, citations...)
	if limit > 0 && len(combined) > limit {
		combined = combined[:limit]
	}
	return combined, nil
}

func (a *App) searchConversationNotes(ctx context.Context, conversationID uuid.UUID, query string, limit int) ([]models.Citation, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 12 {
		limit = 6
	}
	rows, err := a.DB.QueryContext(ctx, `
		SELECT n.id, n.title, n.content
		FROM conversation_notes cn
		JOIN notes n ON n.id = cn.note_id
		WHERE cn.conversation_id = $1 AND btrim(n.content) <> ''
		ORDER BY
			CASE WHEN to_tsvector('simple', coalesce(n.title, '') || ' ' || n.content) @@ plainto_tsquery('simple', $2) THEN 0 ELSE 1 END,
			ts_rank(to_tsvector('simple', coalesce(n.title, '') || ' ' || n.content), plainto_tsquery('simple', $2)) DESC,
			cn.created_at
		LIMIT $3`, conversationID, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.Citation, 0, limit)
	for rows.Next() {
		var citation models.Citation
		var content string
		if err := rows.Scan(&citation.ResourceID, &citation.Title, &content); err != nil {
			return nil, err
		}
		citation.Kind = "note"
		citation.Snippet = noteSnippet(content)
		result = append(result, citation)
	}
	return result, rows.Err()
}

func noteSnippet(content string) string {
	content = strings.Join(strings.Fields(content), " ")
	const maxRunes = 1200
	runes := []rune(content)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes]) + "…"
	}
	return content
}

func (a *App) attachedNotesPrompt(ctx context.Context, conversationID uuid.UUID) (string, error) {
	rows, err := a.DB.QueryContext(ctx, `
		SELECT n.title, n.content
		FROM conversation_notes cn
		JOIN notes n ON n.id = cn.note_id
		WHERE cn.conversation_id = $1 AND btrim(n.content) <> ''
		ORDER BY cn.created_at`, conversationID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	const maxNoteRunes = 12000
	const maxTotalRunes = 30000
	var prompt strings.Builder
	usedRunes := 0
	for rows.Next() {
		var title, content string
		if err := rows.Scan(&title, &content); err != nil {
			return "", err
		}
		contentRunes := []rune(content)
		if len(contentRunes) > maxNoteRunes {
			contentRunes = contentRunes[:maxNoteRunes]
		}
		if usedRunes+len(contentRunes) > maxTotalRunes {
			remaining := maxTotalRunes - usedRunes
			if remaining <= 0 {
				break
			}
			contentRunes = contentRunes[:remaining]
		}
		if len(contentRunes) == 0 {
			continue
		}
		if prompt.Len() == 0 {
			prompt.WriteString("Attached workspace notes are authoritative user-provided context. Use them when relevant, and do not claim they are external sources.\n\n")
		}
		prompt.WriteString("Note: ")
		prompt.WriteString(strings.TrimSpace(title))
		prompt.WriteString("\n")
		prompt.WriteString(string(contentRunes))
		prompt.WriteString("\n\n")
		usedRunes += len(contentRunes)
		if usedRunes >= maxTotalRunes {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return strings.TrimSpace(prompt.String()), nil
}

func chatToolInstructions() string {
	return "Use JustAI's built-in tools when they match the user's request: call web_search for current or external web information, browse_url for a specific URL, generate_image when the user asks to create an image, and edit_image when the user asks to change an attached image. Use connected MCP tools whenever they can provide relevant information. Re-evaluate the current question on every turn and make a fresh tool call when the answer may depend on external or connected sources; do not rely only on an earlier tool result. If a prior call failed or returned incomplete information, try the relevant tool again. Do not claim that you searched, browsed, generated, or edited anything unless you actually called the corresponding tool. Never emit action-shaped JSON such as dalle.text2im as plain assistant text; invoke the tool instead."
}

type storedChatMessage struct {
	Role      string
	Content   string
	UIMessage []byte
}

func (a *App) conversationToolHistory(ctx context.Context, conversationID uuid.UUID) ([]provider.ToolMessage, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT role, content, ui_message FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 500`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stored := []storedChatMessage{}
	for rows.Next() {
		var item storedChatMessage
		if err := rows.Scan(&item.Role, &item.Content, &item.UIMessage); err != nil {
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
			SELECT id, parent_id, role, content, ui_message, created_at
			FROM messages
			WHERE conversation_id = $1 AND id = $2
			UNION ALL
			SELECT message.id, message.parent_id, message.role, message.content, message.ui_message, message.created_at
			FROM messages message
			JOIN branch current ON current.parent_id = message.id
			WHERE message.conversation_id = $1
		)
		SELECT role, content, ui_message
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
		if err := rows.Scan(&item.Role, &item.Content, &item.UIMessage); err != nil {
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
			message := providerMessageFromStored(item)
			history = append(history, provider.ToolMessage{Role: message.Role, Content: message.Content, ContentParts: message.ContentParts})
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
	if err := json.Unmarshal([]byte(content), &event); err != nil || !isChatToolEventKind(event.Kind) || event.CallID == "" || event.ToolName == "" {
		return chatToolEvent{}, false
	}
	return event, true
}

func isChatToolEventKind(kind string) bool {
	return kind == "mcp_tool" || kind == "builtin_tool"
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
		VALUES ($1, $2, 'tool', $3, 'ai-sdk-ui', $4, $5::uuid, $6, now())
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
		"iconUrl":    event.IconURL,
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
	if err != nil && !binding.RequiresApproval {
		// Trusted read-only tools can be safely retried after a forced
		// rediscovery. This repairs both stale transport sessions and a tool
		// snapshot that changed upstream without duplicating a destructive call.
		if tools, refreshErr := a.refreshMCPTools(ctx, server, binding.ServerID); refreshErr == nil {
			for _, tool := range tools {
				if tool.Name != binding.ToolName || !mcpToolAllowed(server.Allowed, tool.Name) {
					continue
				}
				result, err = server.CallTool(ctx, binding.ToolName, arguments)
				break
			}
		}
	}
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
			  AND (ms.scope_type = 'global' OR (ms.scope_type = 'organization' AND ms.scope_id = $4) OR (ms.scope_type = 'user' AND ms.scope_id = $3))
		)`, conversationID, serverID, userID, organizationID).Scan(&attached)
	return attached, err
}

func (a *App) ensureConversation(ctx context.Context, userID, organizationID uuid.UUID, rawID, rawAssistantID string) (uuid.UUID, error) {
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
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return uuid.Nil, err
	}
	defer transaction.Rollback()
	var assistantID, assistantVersionID any
	if rawAssistantID = strings.TrimSpace(rawAssistantID); rawAssistantID != "" {
		parsedAssistantID, parseErr := uuid.Parse(rawAssistantID)
		if parseErr != nil {
			return uuid.Nil, fmt.Errorf("invalid assistant id")
		}
		assistant, assistantErr := loadSavedAssistant(ctx, transaction, parsedAssistantID, userID, organizationID)
		if errors.Is(assistantErr, sql.ErrNoRows) {
			return uuid.Nil, fmt.Errorf("assistant is not available")
		}
		if assistantErr != nil {
			return uuid.Nil, assistantErr
		}
		assistantID = assistant.ID
		assistantVersionID = assistant.VersionID
	}
	var id uuid.UUID
	if err := transaction.QueryRowContext(ctx, `
		INSERT INTO conversations (user_id, organization_id, assistant_id, assistant_version_id)
		VALUES ($1, $2, $3, $4)
		RETURNING id`, userID, organizationID, assistantID, assistantVersionID).Scan(&id); err != nil {
		return uuid.Nil, err
	}
	if err := attachUserRepositories(ctx, transaction, id, userID); err != nil {
		return uuid.Nil, err
	}
	if err := transaction.Commit(); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

func (a *App) conversationHistory(ctx context.Context, conversationID uuid.UUID) ([]provider.Message, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT role, content, ui_message FROM messages WHERE conversation_id = $1 AND role IN ('user', 'assistant') ORDER BY created_at DESC LIMIT 20`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []provider.Message{}
	for rows.Next() {
		var role, content string
		var rawUIMessage []byte
		if err := rows.Scan(&role, &content, &rawUIMessage); err != nil {
			return nil, err
		}
		result = append(result, providerMessageFromStored(storedChatMessage{Role: role, Content: content, UIMessage: rawUIMessage}))
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
			result = append(result, providerMessageFromStored(item))
		}
	}
	return result, nil
}

func providerMessageFromStored(item storedChatMessage) provider.Message {
	message := provider.Message{Role: item.Role, Content: item.Content}
	if len(item.UIMessage) == 0 {
		return message
	}
	var envelope struct {
		Parts []json.RawMessage `json:"parts"`
	}
	if json.Unmarshal(item.UIMessage, &envelope) == nil {
		message.ContentParts = assistantUIProviderImageParts(envelope.Parts)
	}
	return message
}

func (a *App) resolveEndpoint(ctx context.Context, userID, organizationID uuid.UUID, rawID string) (uuid.UUID, error) {
	if rawID != "" {
		id, err := uuid.Parse(rawID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("invalid endpoint id")
		}
		var scopeType string
		var scopeID sql.NullString
		if err := a.DB.QueryRowContext(ctx, `SELECT scope_type, scope_id::text FROM endpoint_settings WHERE id = $1 AND enabled = TRUE AND (capabilities->>'chat') = 'true'`, id).Scan(&scopeType, &scopeID); err != nil {
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
	if err := a.DB.QueryRowContext(ctx, `
		SELECT e.id
		FROM organization_default_endpoints defaults
		JOIN endpoint_settings e ON e.id = defaults.endpoint_id
		WHERE defaults.organization_id = $1
		  AND e.enabled = TRUE
		  AND (e.capabilities->>'chat') = 'true'`, organizationID).Scan(&id); err == nil {
		return id, nil
	} else if err != sql.ErrNoRows {
		return uuid.Nil, err
	}
	if err := a.DB.QueryRowContext(ctx, `SELECT id FROM endpoint_settings WHERE enabled = TRUE AND (capabilities->>'chat') = 'true' AND ((scope_type = 'user' AND scope_id = $1) OR (scope_type = 'organization' AND scope_id = $2) OR scope_type = 'global') ORDER BY CASE WHEN scope_type = 'user' THEN 1 WHEN scope_type = 'organization' THEN 2 ELSE 3 END, is_default DESC, created_at LIMIT 1`, userID, organizationID).Scan(&id); err != nil {
		return uuid.Nil, fmt.Errorf("no enabled chat endpoint is configured")
	}
	return id, nil
}

func citationPrompt(citations []models.Citation) string {
	return citationPromptForMode(citations, false)
}

func citationPromptForMode(citations []models.Citation, deepContext bool) string {
	var builder strings.Builder
	if deepContext {
		builder.WriteString("Deep context mode is active. Synthesize evidence across the retrieved context and explain how the pieces relate. Treat these passages as a relevant sample, not an exhaustive dump of the available context. Name files or notes when useful, distinguish direct evidence from inference, and say when the retrieved context is insufficient. Do not invent relationships.\n")
	} else {
		builder.WriteString("Use the following retrieved context when it helps. Cite source titles naturally.\n")
	}
	for _, citation := range citations {
		builder.WriteString("[")
		builder.WriteString(citation.Title)
		builder.WriteString("] ")
		builder.WriteString(citation.Snippet)
		builder.WriteByte('\n')
	}
	return builder.String()
}
