package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
	"justai-backend/rag"
)

type voiceTicket struct {
	OrganizationID uuid.UUID
	ConversationID uuid.UUID
}

type voiceEvent struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	Data      json.RawMessage `json:"data"`
}

type voiceSessionStartData struct {
	ConversationID          string `json:"conversationId"`
	EndpointID              string `json:"endpointId"`
	TranscriptionEndpointID string `json:"transcriptionEndpointId"`
	Language                string `json:"language"`
}

type voiceApprovalData struct {
	ApprovalID string `json:"approvalId"`
	Approved   bool   `json:"approved"`
}

type voiceApproval struct {
	ID         string
	ServerID   uuid.UUID
	ServerName string
	ToolName   string
	CallID     string
	Arguments  map[string]any
	Decision   chan bool
}

type voiceToolBinding struct {
	ServerID   uuid.UUID
	ServerName string
	ToolName   string
	Definition provider.ToolDefinition
}

type voiceState struct {
	conversationID          uuid.UUID
	endpointID              uuid.UUID
	transcriptionEndpointID uuid.UUID
	language                string
	sequence                int64
	writeMu                 sync.Mutex
	turnMu                  sync.Mutex
	cancelTurn              context.CancelFunc
	turnDone                chan struct{}
	pendingMu               sync.Mutex
	pending                 map[string]*voiceApproval
	transcription           provider.TranscriptionStream
	transcriptionDone       chan struct{}
	voiceActive             bool
	lastVoiceAt             time.Time
}

func (a *App) voiceWebSocket(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	ticket, err := a.consumeVoiceTicket(c.Request.Context(), c.Query("ticket"), principal.UserID)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	connection, err := a.upgradeWebSocket(c)
	if err != nil {
		return
	}
	defer connection.Close()
	a.runVoiceSocket(c.Request.Context(), connection, principal.UserID, ticket.OrganizationID, ticket.ConversationID)
}

func (a *App) consumeVoiceTicket(ctx context.Context, value string, userID uuid.UUID) (voiceTicket, error) {
	if value == "" {
		return voiceTicket{}, fmt.Errorf("websocket ticket is required")
	}
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return voiceTicket{}, err
	}
	defer transaction.Rollback()
	var ticket voiceTicket
	var ticketUser uuid.UUID
	var conversationID uuid.NullUUID
	err = transaction.QueryRowContext(ctx, `SELECT organization_id, user_id, conversation_id FROM ws_tickets WHERE token_hash = $1 AND kind = 'voice' AND expires_at > now() AND used_at IS NULL FOR UPDATE`, hashToken(value)).Scan(&ticket.OrganizationID, &ticketUser, &conversationID)
	if err != nil || ticketUser != userID || !conversationID.Valid {
		return voiceTicket{}, fmt.Errorf("invalid or expired websocket ticket")
	}
	ticket.ConversationID = conversationID.UUID
	var allowed bool
	if err := transaction.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND organization_id = $3)`, ticket.ConversationID, userID, ticket.OrganizationID).Scan(&allowed); err != nil || !allowed {
		return voiceTicket{}, fmt.Errorf("conversation is not available")
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE ws_tickets SET used_at = now() WHERE token_hash = $1`, hashToken(value)); err != nil {
		return voiceTicket{}, err
	}
	if err := transaction.Commit(); err != nil {
		return voiceTicket{}, err
	}
	return ticket, nil
}

func (a *App) runVoiceSocket(ctx context.Context, connection *websocket.Conn, userID, organizationID, ticketConversationID uuid.UUID) {
	state := &voiceState{pending: map[string]*voiceApproval{}}
	defer func() {
		state.turnMu.Lock()
		if state.cancelTurn != nil {
			state.cancelTurn()
		}
		state.turnMu.Unlock()
		if state.transcription != nil {
			state.transcription.Close()
			if state.transcriptionDone != nil {
				select {
				case <-state.transcriptionDone:
				case <-time.After(2 * time.Second):
				}
			}
		}
	}()

	for {
		messageType, payload, err := connection.ReadMessage()
		if err != nil {
			return
		}
		if messageType == websocket.BinaryMessage {
			if state.transcription == nil {
				_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", Data: gin.H{"message": "voice session has not started"}})
				continue
			}
			frame := parseAudioFrame(payload)
			if len(frame.PCM) == 0 {
				continue
			}
			pcm16 := provider.ResamplePCM16(frame.PCM, frame.SampleRate, 16000)
			if provider.PCM16HasSpeech(pcm16) {
				state.voiceActive = true
				state.lastVoiceAt = time.Now()
			} else if !state.voiceActive || time.Since(state.lastVoiceAt) > 650*time.Millisecond {
				state.voiceActive = false
				continue
			}
			if err := state.transcription.SendPCM(ctx, frame.PCM, frame.SampleRate); err != nil && ctx.Err() == nil {
				_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", Data: gin.H{"message": "voice audio transport failed: " + err.Error()}})
			}
			continue
		}
		if messageType != websocket.TextMessage {
			continue
		}
		var event voiceEvent
		if err := json.Unmarshal(payload, &event); err != nil {
			_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", Data: gin.H{"message": "invalid voice event"}})
			continue
		}
		switch event.Type {
		case "session.start":
			var data voiceSessionStartData
			if err := json.Unmarshal(event.Data, &data); err != nil {
				_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "invalid session.start payload"}})
				continue
			}
			if err := a.startVoiceSession(ctx, connection, state, userID, organizationID, ticketConversationID, event.RequestID, data); err != nil {
				_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": err.Error()}})
			}
		case "tool.approve", "tool.reject", "tool.decision":
			var data voiceApprovalData
			if err := json.Unmarshal(event.Data, &data); err != nil || data.ApprovalID == "" {
				_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "approvalId is required"}})
				continue
			}
			if event.Type == "tool.reject" {
				data.Approved = false
			}
			if !a.decideVoiceApproval(state, data.ApprovalID, data.Approved) {
				_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "approval is no longer pending"}})
			}
		case "turn.cancel", "cancel":
			if a.cancelVoiceTurn(state) {
				_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "turn.cancelled", RequestID: event.RequestID, Data: gin.H{"message": "voice turn cancelled"}})
			}
		case "session.stop":
			if state.transcription != nil {
				if err := state.transcription.Commit(); err != nil {
					_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "voice finalization failed: " + err.Error()}})
				}
			}
		case "source.level", "input.level":
			// Audio levels are rendered locally; accepting the event keeps the
			// protocol compatible with the existing transcription worklet.
		default:
			_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: event.RequestID, Data: gin.H{"message": "unsupported voice event: " + event.Type}})
		}
	}
}

func (a *App) startVoiceSession(ctx context.Context, connection *websocket.Conn, state *voiceState, userID, organizationID, ticketConversationID uuid.UUID, requestID string, data voiceSessionStartData) error {
	if state.transcription != nil {
		return fmt.Errorf("voice session has already started")
	}
	conversationID := ticketConversationID
	if data.ConversationID != "" {
		parsed, err := uuid.Parse(data.ConversationID)
		if err != nil || parsed != ticketConversationID {
			return fmt.Errorf("conversation is outside the voice ticket scope")
		}
		conversationID = parsed
	}
	endpointID, err := a.resolveEndpoint(ctx, userID, organizationID, data.EndpointID)
	if err != nil {
		return err
	}
	transcriptionEndpointID, err := a.resolveTranscriptionEndpoint(ctx, userID, organizationID, data.TranscriptionEndpointID, "transcription")
	if err != nil {
		return err
	}
	transcriptionEndpoint, err := a.providerEndpoint(ctx, transcriptionEndpointID)
	if err != nil {
		return fmt.Errorf("transcription endpoint could not be loaded: %w", err)
	}
	mode := transcriptionMode(transcriptionEndpoint)
	if mode == "" {
		return fmt.Errorf("provider %s does not support a compatible transcription transport", transcriptionEndpoint.ProviderType)
	}
	language := strings.TrimSpace(data.Language)
	if language == "" {
		language = "auto"
	}
	var stream provider.TranscriptionStream
	if mode == "chunked" {
		stream, err = provider.OpenChunked(ctx, transcriptionEndpoint, transcriptionEndpoint.TranscriptionModel, language, provider.ChunkedOptions{
			Window:         time.Duration(a.Config.Transcription.StreamingChunkMs) * time.Millisecond,
			Overlap:        time.Duration(a.Config.Transcription.StreamingOverlapMs) * time.Millisecond,
			PromptMaxChars: a.Config.Transcription.StreamingPromptChars,
		})
	} else {
		stream, err = provider.OpenRealtime(ctx, transcriptionEndpoint, transcriptionEndpoint.TranscriptionModel, language)
	}
	if err != nil {
		return fmt.Errorf("transcription provider connection failed: %w", err)
	}
	chatEndpoint, err := a.providerEndpoint(ctx, endpointID)
	if err != nil {
		stream.Close()
		return fmt.Errorf("chat endpoint could not be loaded: %w", err)
	}
	state.conversationID = conversationID
	state.endpointID = endpointID
	state.transcriptionEndpointID = transcriptionEndpointID
	state.language = language
	state.transcription = stream
	state.transcriptionDone = make(chan struct{})
	go a.readVoiceTranscription(ctx, connection, state, userID, organizationID, stream)
	_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "session.ready", RequestID: requestID, Data: gin.H{
		"conversationId":          conversationID,
		"endpointId":              endpointID,
		"transcriptionEndpointId": transcriptionEndpointID,
		"mode":                    mode,
		"toolCalling":             provider.SupportsToolCalling(chatEndpoint),
		"tts":                     chatEndpoint.ProviderType == "openai" || chatEndpoint.ProviderType == "openai-compatible",
	}})
	return nil
}

func (a *App) readVoiceTranscription(ctx context.Context, connection *websocket.Conn, state *voiceState, userID, organizationID uuid.UUID, stream provider.TranscriptionStream) {
	defer close(state.transcriptionDone)
	for event := range stream.Events() {
		if event.Err != nil {
			if ctx.Err() == nil {
				_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", Data: gin.H{"message": "transcription provider error: " + event.Err.Error()}})
			}
			continue
		}
		text := strings.TrimSpace(provider.CleanTranscriptText(event.Text))
		if text == "" || isTranscriptionProtocolPayload(text) {
			continue
		}
		switch event.Kind {
		case "partial":
			_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "input.transcript.partial", Data: gin.H{"text": text}})
		case "final":
			_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "input.transcript.final", Data: gin.H{"text": text}})
			a.queueVoiceTurn(ctx, connection, state, userID, organizationID, text)
		}
	}
}

func (a *App) queueVoiceTurn(ctx context.Context, connection *websocket.Conn, state *voiceState, userID, organizationID uuid.UUID, content string) {
	content = strings.TrimSpace(content)
	if content == "" {
		return
	}
	state.turnMu.Lock()
	if state.cancelTurn != nil {
		state.cancelTurn()
		done := state.turnDone
		state.turnMu.Unlock()
		go func() {
			select {
			case <-done:
				a.queueVoiceTurn(ctx, connection, state, userID, organizationID, content)
			case <-ctx.Done():
			}
		}()
		return
	}
	turnContext, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	state.cancelTurn = cancel
	state.turnDone = done
	state.turnMu.Unlock()
	go func() {
		defer func() {
			state.turnMu.Lock()
			if state.turnDone == done {
				state.cancelTurn = nil
				state.turnDone = nil
				close(done)
			}
			state.turnMu.Unlock()
		}()
		a.runVoiceTurn(turnContext, connection, state, userID, organizationID, content)
	}()
}

func (a *App) cancelVoiceTurn(state *voiceState) bool {
	state.turnMu.Lock()
	defer state.turnMu.Unlock()
	if state.cancelTurn == nil {
		return false
	}
	state.cancelTurn()
	return true
}

func (a *App) decideVoiceApproval(state *voiceState, approvalID string, approved bool) bool {
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

func (a *App) runVoiceTurn(ctx context.Context, connection *websocket.Conn, state *voiceState, userID, organizationID uuid.UUID, content string) {
	requestID := "voice-" + uuid.NewString()
	conversationID := state.conversationID
	endpointID := state.endpointID
	if _, err := a.DB.ExecContext(ctx, `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)`, conversationID, content); err != nil {
		if ctx.Err() == nil {
			_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": err.Error()}})
		}
		return
	}
	if _, err := a.DB.ExecContext(ctx, `UPDATE conversations SET title = CASE WHEN title = $2 THEN $3 ELSE title END, updated_at = now() WHERE id = $1`, conversationID, defaultConversationTitle, conversationTitle(content)); err != nil {
		if ctx.Err() == nil {
			_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": err.Error()}})
		}
		return
	}
	_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "message.accepted", RequestID: requestID, Data: gin.H{"conversationId": conversationID}})
	_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "retrieval.started", RequestID: requestID, Data: gin.H{"query": content}})
	citations, err := rag.Search(ctx, a.DB, organizationID, userID, content, 6)
	if err != nil {
		citations = nil
	}
	_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "retrieval.completed", RequestID: requestID, Data: gin.H{"citations": citations}})
	history, err := a.conversationHistory(ctx, conversationID)
	if err != nil {
		if ctx.Err() == nil {
			_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": err.Error()}})
		}
		return
	}
	if len(citations) > 0 {
		history = append([]provider.Message{{Role: "system", Content: citationPrompt(citations)}}, history...)
	}
	endpoint, err := a.providerEndpoint(ctx, endpointID)
	if err != nil {
		if ctx.Err() == nil {
			_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": "endpoint could not be loaded: " + err.Error()}})
		}
		return
	}
	var response strings.Builder
	if provider.SupportsToolCalling(endpoint) {
		definitions, bindings := a.loadVoiceTools(ctx, userID, organizationID)
		if len(definitions) > 0 {
			toolMessages := voiceToolMessages(history)
			toolRounds := 0
			lastHadTools := false
			for toolRounds < 4 {
				response.Reset()
				calls := []provider.ToolCall{}
				err = provider.StreamChatWithTools(ctx, endpoint, provider.ToolChatOptions{Messages: toolMessages, Tools: definitions, Model: endpoint.ChatModel}, func(event provider.ToolChatEvent) error {
					if event.Delta != "" {
						response.WriteString(event.Delta)
						return a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "message.delta", RequestID: requestID, Data: gin.H{"delta": event.Delta}})
					}
					if len(event.ToolCalls) > 0 {
						calls = append(calls, event.ToolCalls...)
					}
					return nil
				})
				if err != nil {
					if ctx.Err() == nil {
						_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": err.Error()}})
					}
					return
				}
				if len(calls) == 0 {
					lastHadTools = false
					break
				}
				lastHadTools = true
				toolRounds++
				toolMessages = append(toolMessages, provider.ToolMessage{Role: "assistant", Content: response.String(), ToolCalls: calls})
				for _, call := range calls {
					binding, exists := bindings[call.Name]
					if !exists {
						toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: "The requested tool is not allowlisted."})
						continue
					}
					arguments := map[string]any{}
					if strings.TrimSpace(call.Arguments) != "" {
						if err := json.Unmarshal([]byte(call.Arguments), &arguments); err != nil {
							toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: "The tool arguments were invalid JSON."})
							continue
						}
					}
					approvalID, approved, approvalErr := a.awaitVoiceApproval(ctx, connection, state, userID, organizationID, requestID, binding, call, arguments, toolRounds)
					if approvalErr != nil {
						return
					}
					if !approved {
						_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "tool.completed", RequestID: requestID, Data: gin.H{"approvalId": approvalID, "callId": call.ID, "toolName": binding.ToolName, "success": false, "error": "declined by user"}})
						toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: "The user declined this Home Assistant action."})
						continue
					}
					result, callErr := a.executeVoiceTool(ctx, userID, organizationID, conversationID, binding, arguments)
					if callErr != nil {
						_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "tool.completed", RequestID: requestID, Data: gin.H{"approvalId": approvalID, "callId": call.ID, "toolName": binding.ToolName, "success": false, "error": callErr.Error()}})
						toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: "The Home Assistant tool failed: " + callErr.Error()})
						continue
					}
					_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "tool.completed", RequestID: requestID, Data: gin.H{"approvalId": approvalID, "callId": call.ID, "toolName": binding.ToolName, "success": true}})
					toolMessages = append(toolMessages, provider.ToolMessage{Role: "tool", ToolCallID: call.ID, Content: string(result)})
				}
			}
			if lastHadTools && strings.TrimSpace(response.String()) == "" {
				response.WriteString("I stopped after four Home Assistant actions to keep this turn safe.")
				_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "message.delta", RequestID: requestID, Data: gin.H{"delta": response.String()}})
			}
		} else {
			err = a.streamVoiceWithoutTools(ctx, connection, state, requestID, endpoint, history, &response)
		}
	} else {
		err = a.streamVoiceWithoutTools(ctx, connection, state, requestID, endpoint, history, &response)
	}
	if err != nil || ctx.Err() != nil {
		return
	}
	assistantContent := strings.TrimSpace(response.String())
	if assistantContent == "" {
		assistantContent = "I couldn't produce a response for that request."
	}
	if _, err := a.DB.ExecContext(ctx, `INSERT INTO messages (conversation_id, role, content, citations) VALUES ($1, 'assistant', $2, $3)`, conversationID, assistantContent, jsonRaw(citations)); err != nil {
		_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "error", RequestID: requestID, Data: gin.H{"message": err.Error()}})
		return
	}
	_, _ = a.DB.ExecContext(ctx, `UPDATE conversations SET endpoint_id = $2, updated_at = now() WHERE id = $1`, conversationID, endpointID)
	_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "message.completed", RequestID: requestID, Data: gin.H{"conversationId": conversationID, "content": assistantContent, "citations": citations}})
}

func (a *App) streamVoiceWithoutTools(ctx context.Context, connection *websocket.Conn, state *voiceState, requestID string, endpoint provider.Endpoint, history []provider.Message, response *strings.Builder) error {
	return provider.StreamChat(ctx, endpoint, provider.ChatOptions{Messages: history}, func(delta string) error {
		response.WriteString(delta)
		return a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "message.delta", RequestID: requestID, Data: gin.H{"delta": delta}})
	})
}

func voiceToolMessages(history []provider.Message) []provider.ToolMessage {
	result := make([]provider.ToolMessage, 0, len(history))
	for _, message := range history {
		result = append(result, provider.ToolMessage{Role: message.Role, Content: message.Content})
	}
	return result
}

func (a *App) loadVoiceTools(ctx context.Context, userID, organizationID uuid.UUID) ([]provider.ToolDefinition, map[string]voiceToolBinding) {
	rows, err := a.DB.QueryContext(ctx, `SELECT id, name FROM mcp_servers WHERE enabled = TRUE AND ((scope_type = 'organization' AND scope_id = $1) OR (scope_type = 'user' AND scope_id = $2)) ORDER BY created_at`, organizationID, userID)
	if err != nil {
		return nil, map[string]voiceToolBinding{}
	}
	defer rows.Close()
	definitions := []provider.ToolDefinition{}
	bindings := map[string]voiceToolBinding{}
	for rows.Next() {
		var serverID uuid.UUID
		var serverName string
		if err := rows.Scan(&serverID, &serverName); err != nil {
			continue
		}
		server, err := a.loadMCPServer(ctx, serverID.String())
		if err != nil || len(server.Allowed) == 0 {
			continue
		}
		tools, err := server.ListTools(ctx)
		if err != nil {
			continue
		}
		for _, tool := range tools {
			if !server.Allowed[tool.Name] {
				continue
			}
			name := voiceToolName(serverID, tool.Name, bindings)
			parameters := tool.InputSchema
			if len(parameters) == 0 || !json.Valid(parameters) {
				parameters = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			definition := provider.ToolDefinition{Name: name, Description: tool.Description, Parameters: parameters}
			definitions = append(definitions, definition)
			bindings[name] = voiceToolBinding{ServerID: serverID, ServerName: serverName, ToolName: tool.Name, Definition: definition}
		}
	}
	return definitions, bindings
}

func voiceToolName(serverID uuid.UUID, toolName string, existing map[string]voiceToolBinding) string {
	serverPart := normalizeVoiceToolPart(serverID.String())
	if len(serverPart) > 8 {
		serverPart = serverPart[:8]
	}
	toolPart := normalizeVoiceToolPart(toolName)
	if toolPart == "" {
		toolPart = "tool"
	}
	base := "mcp_" + serverPart + "_" + toolPart
	if len(base) > 64 {
		base = base[:64]
	}
	name := base
	for index := 2; existing[name].ToolName != ""; index++ {
		suffix := fmt.Sprintf("_%d", index)
		name = base
		if len(name)+len(suffix) > 64 {
			name = name[:64-len(suffix)]
		}
		name += suffix
	}
	return name
}

func normalizeVoiceToolPart(value string) string {
	var builder strings.Builder
	for _, character := range strings.ToLower(value) {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '_' {
			builder.WriteRune(character)
		} else {
			builder.WriteByte('_')
		}
	}
	return strings.Trim(builder.String(), "_")
}

func (a *App) awaitVoiceApproval(ctx context.Context, connection *websocket.Conn, state *voiceState, userID, organizationID uuid.UUID, requestID string, binding voiceToolBinding, call provider.ToolCall, arguments map[string]any, round int) (string, bool, error) {
	approvalID := uuid.NewString()
	pending := &voiceApproval{ID: approvalID, ServerID: binding.ServerID, ServerName: binding.ServerName, ToolName: binding.ToolName, CallID: call.ID, Arguments: arguments, Decision: make(chan bool, 1)}
	state.pendingMu.Lock()
	state.pending[approvalID] = pending
	state.pendingMu.Unlock()
	_ = a.sendVoiceSocket(connection, state, models.SocketEnvelope{Type: "tool.approval_required", RequestID: requestID, Data: gin.H{"approvalId": approvalID, "callId": call.ID, "serverId": binding.ServerID, "serverName": binding.ServerName, "toolName": binding.ToolName, "arguments": arguments, "round": round}})
	select {
	case approved := <-pending.Decision:
		auditDetails := map[string]any{"conversationId": state.conversationID, "serverId": binding.ServerID, "serverName": binding.ServerName, "tool": binding.ToolName, "arguments": arguments, "approved": approved}
		a.auditVoiceTool(ctx, userID, organizationID, "voice.mcp.approval", binding.ServerID, auditDetails)
		return approvalID, approved, nil
	case <-ctx.Done():
		state.pendingMu.Lock()
		delete(state.pending, approvalID)
		state.pendingMu.Unlock()
		return approvalID, false, ctx.Err()
	}
}

func (a *App) executeVoiceTool(ctx context.Context, userID, organizationID, conversationID uuid.UUID, binding voiceToolBinding, arguments map[string]any) (json.RawMessage, error) {
	server, err := a.loadMCPServer(ctx, binding.ServerID.String())
	if err != nil {
		a.auditVoiceTool(ctx, userID, organizationID, "voice.mcp.completed", binding.ServerID, map[string]any{
			"conversationId": conversationID,
			"serverId":       binding.ServerID,
			"serverName":     binding.ServerName,
			"tool":           binding.ToolName,
			"arguments":      arguments,
			"success":        false,
			"error":          err.Error(),
		})
		return nil, err
	}
	result, err := server.CallTool(ctx, binding.ToolName, arguments)
	details := map[string]any{"conversationId": conversationID, "serverId": binding.ServerID, "serverName": binding.ServerName, "tool": binding.ToolName, "arguments": arguments, "success": err == nil}
	if err != nil {
		details["error"] = err.Error()
	}
	a.auditVoiceTool(ctx, userID, organizationID, "voice.mcp.completed", binding.ServerID, details)
	return result, err
}

func (a *App) auditVoiceTool(_ context.Context, userID, organizationID uuid.UUID, action string, resourceID uuid.UUID, details map[string]any) {
	auditContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = a.DB.ExecContext(auditContext, `INSERT INTO audit_events (user_id, organization_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, 'mcp_tool', $4, $5)`, userID, organizationID, action, resourceID, jsonRaw(details))
}

func (a *App) sendVoiceSocket(connection *websocket.Conn, state *voiceState, envelope models.SocketEnvelope) error {
	state.writeMu.Lock()
	defer state.writeMu.Unlock()
	state.sequence++
	envelope.Sequence = state.sequence
	return connection.WriteJSON(envelope)
}

type voiceSpeechRequest struct {
	Text       string `json:"text"`
	EndpointID string `json:"endpointId"`
	Voice      string `json:"voice"`
}

func (a *App) synthesizeVoiceSpeech(c *gin.Context) {
	var request voiceSpeechRequest
	if !decodeJSON(c, &request) {
		return
	}
	text := strings.TrimSpace(request.Text)
	if text == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("text is required"))
		return
	}
	if len([]rune(text)) > 8000 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("text is too long for speech synthesis"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	endpointID, err := a.resolveEndpoint(c, principal.UserID, organizationID, request.EndpointID)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	endpoint, err := a.providerEndpoint(c, endpointID)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	data, contentType, err := provider.SynthesizeSpeech(c, endpoint, text, request.Voice)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "fallback": true})
		return
	}
	c.Data(http.StatusOK, contentType, data)
}
