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

type chatState struct {
	conversationID uuid.UUID
	endpointID     uuid.UUID
	sequence       int64
	writeMu        sync.Mutex
	streamMu       sync.Mutex
	cancelStream   context.CancelFunc
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
	state := &chatState{}
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
			streamContext, cancelStream := context.WithCancel(ctx)
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
	citations, err := rag.Search(ctx, a.DB, organizationID, userID, content, 6)
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
	err = provider.StreamChat(ctx, endpoint, provider.ChatOptions{Messages: history}, func(delta string) error {
		response.WriteString(delta)
		return a.sendSocket(connection, state, models.SocketEnvelope{Type: "message.delta", RequestID: requestID, Data: gin.H{"delta": delta}})
	})
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
	rows, err := a.DB.QueryContext(ctx, `SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20`, conversationID)
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
