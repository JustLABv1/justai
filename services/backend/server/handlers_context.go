package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/rag"
)

func (a *App) authorizeConversation(c *gin.Context, rawID string) (uuid.UUID, error) {
	id, err := uuid.Parse(rawID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("invalid conversation id")
	}
	principal, ok := middleware.GetPrincipal(c)
	organizationID, orgOK := middleware.GetOrganizationID(c)
	if !ok || !orgOK {
		return uuid.Nil, fmt.Errorf("organization context is required")
	}
	var exists bool
	if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND organization_id = $3 AND (user_id = $2 OR visibility = 'workspace'))`, id, principal.UserID, organizationID).Scan(&exists); err != nil {
		return uuid.Nil, err
	}
	if !exists {
		return uuid.Nil, fmt.Errorf("conversation not found")
	}
	return id, nil
}

func (a *App) conversationAccessibleBy(ctx context.Context, conversationID, userID, organizationID uuid.UUID) bool {
	var exists bool
	if err := a.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND organization_id = $3 AND (user_id = $2 OR visibility = 'workspace'))`, conversationID, userID, organizationID).Scan(&exists); err != nil {
		return false
	}
	return exists
}

func (a *App) getConversationContext(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	contextValue := models.ConversationContext{
		KnowledgeSources:      []models.KnowledgeSource{},
		Repositories:          []models.RepositoryContext{},
		MCPServers:            []models.MCPServer{},
		TranscriptionSessions: []models.TranscriptionSession{},
		Notes:                 []models.Note{},
	}
	if err := a.loadConversationKnowledge(c, conversationID, &contextValue); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := a.loadConversationRepositories(c, conversationID, &contextValue); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := a.loadConversationMCP(c, conversationID, &contextValue); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := a.loadConversationTranscription(c, conversationID, &contextValue); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := a.loadConversationNotes(c, conversationID, &contextValue); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	project, projectErr := a.loadConversationProject(c, conversationID, principal.UserID, organizationID)
	if projectErr != nil {
		writeError(c, http.StatusInternalServerError, projectErr)
		return
	}
	contextValue.Project = project
	c.JSON(http.StatusOK, contextValue)
}

func (a *App) loadConversationKnowledge(c *gin.Context, conversationID uuid.UUID, result *models.ConversationContext) error {
	rows, err := a.DB.QueryContext(c, `
		SELECT ks.id, ks.scope_type, ks.scope_id, cks.context_scope, ks.title, ks.source_type,
		       COALESCE(ks.source_url, ''), COALESCE(ks.mime_type, ''), ks.status,
		       COALESCE(ks.error_message, ''), COALESCE(ij.progress, 0),
		       COALESCE(ij.stage, ks.status), ks.created_at, ks.updated_at
		FROM conversation_knowledge_sources cks
		JOIN knowledge_sources ks ON ks.id = cks.source_id
		LEFT JOIN LATERAL (
			SELECT progress, stage
			FROM ingestion_jobs
			WHERE source_id = ks.id
			ORDER BY created_at DESC, id DESC
			LIMIT 1
		) ij ON TRUE
		WHERE cks.conversation_id = $1 AND ks.source_type <> 'repository' ORDER BY cks.created_at`, conversationID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var item models.KnowledgeSource
		if err := rows.Scan(&item.ID, &item.ScopeType, &item.ScopeID, &item.ContextScope, &item.Title, &item.SourceType, &item.SourceURL, &item.MimeType, &item.Status, &item.Error, &item.Progress, &item.Stage, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return err
		}
		result.KnowledgeSources = append(result.KnowledgeSources, item)
	}
	return rows.Err()
}

func (a *App) loadConversationMCP(c *gin.Context, conversationID uuid.UUID, result *models.ConversationContext) error {
	rows, err := a.DB.QueryContext(c, `
		SELECT ms.id, ms.scope_type, ms.scope_id, ms.name, ms.endpoint_url, ms.auth_type,
		       CASE WHEN EXISTS (SELECT 1 FROM mcp_server_icons msi WHERE msi.server_id = ms.id) THEN '/api/v1/mcp/servers/' || ms.id::text || '/icon' ELSE COALESCE(ms.icon_url, '') END,
		       ms.encrypted_credential IS NOT NULL, ms.enabled, ms.allowed_tools,
		       ms.trusted_read_only, ms.last_tested_at, COALESCE(ms.last_error, ''),
		       COALESCE(ms.protocol_version, ''),
		       (SELECT COUNT(*) FROM mcp_server_tools mst WHERE mst.server_id = ms.id),
		       ms.created_at, ms.updated_at
		FROM conversation_mcp_servers cms
		JOIN mcp_servers ms ON ms.id = cms.server_id
		WHERE cms.conversation_id = $1 ORDER BY cms.created_at`, conversationID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanMCPServerContext(rows)
		if err != nil {
			return err
		}
		result.MCPServers = append(result.MCPServers, item)
	}
	return rows.Err()
}

func (a *App) loadConversationTranscription(c *gin.Context, conversationID uuid.UUID, result *models.ConversationContext) error {
	rows, err := a.DB.QueryContext(c, `
		SELECT ts.id, ts.title, ts.status, ts.transcription_endpoint_id,
		       ts.diarization_endpoint_id, ts.language, ts.record_audio,
		       ts.created_at, ts.updated_at, ts.archived_at,
		       (SELECT COUNT(*) FROM transcription_sources tss WHERE tss.session_id = ts.id),
		       (SELECT COUNT(*) FROM transcription_segments tsg WHERE tsg.session_id = ts.id)
		FROM conversation_transcription_sessions cts
		JOIN transcription_sessions ts ON ts.id = cts.session_id
		WHERE cts.conversation_id = $1 ORDER BY cts.created_at`, conversationID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var item models.TranscriptionSession
		if err := rows.Scan(&item.ID, &item.Title, &item.Status, &item.TranscriptionEndpoint, &item.DiarizationEndpoint, &item.Language, &item.RecordAudio, &item.CreatedAt, &item.UpdatedAt, &item.ArchivedAt, &item.SourceCount, &item.SegmentCount); err != nil {
			return err
		}
		result.TranscriptionSessions = append(result.TranscriptionSessions, item)
	}
	return rows.Err()
}

func (a *App) loadConversationNotes(c *gin.Context, conversationID uuid.UUID, result *models.ConversationContext) error {
	rows, err := a.DB.QueryContext(c, `
		SELECT n.id, n.title, n.content, n.source_conversation_id, n.pinned_at,
		       n.created_at, n.updated_at
		FROM conversation_notes cn
		JOIN notes n ON n.id = cn.note_id
		WHERE cn.conversation_id = $1
		ORDER BY cn.created_at`, conversationID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var item models.Note
		var sourceID sql.NullString
		if err := rows.Scan(&item.ID, &item.Title, &item.Content, &sourceID, &item.PinnedAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return err
		}
		item.SourceConversationID = parseOptionalUUIDString(sourceID.String)
		result.Notes = append(result.Notes, item)
	}
	return rows.Err()
}

func (a *App) attachConversationKnowledge(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	sourceID, err := uuid.Parse(c.Param("sourceId"))
	if err != nil || !a.canUseKnowledgeSource(c, sourceID, conversationID) {
		writeError(c, http.StatusForbidden, fmt.Errorf("knowledge source is not available"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	if _, err := a.DB.ExecContext(c, `INSERT INTO conversation_knowledge_sources (conversation_id, source_id, added_by, context_scope) VALUES ($1, $2, $3, 'persistent') ON CONFLICT (conversation_id, source_id) DO UPDATE SET context_scope = 'persistent'`, conversationID, sourceID, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) updateConversationKnowledge(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	sourceID, err := uuid.Parse(c.Param("sourceId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid context resource id"))
		return
	}
	var request struct {
		ContextScope string `json:"contextScope"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	request.ContextScope = strings.TrimSpace(request.ContextScope)
	if request.ContextScope != "persistent" && request.ContextScope != "message" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("contextScope must be persistent or message"))
		return
	}
	result, err := a.DB.ExecContext(c, `UPDATE conversation_knowledge_sources SET context_scope = $3 WHERE conversation_id = $1 AND source_id = $2`, conversationID, sourceID, request.ContextScope)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, rowsErr := result.RowsAffected(); rowsErr != nil {
		writeError(c, http.StatusInternalServerError, rowsErr)
		return
	} else if affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("knowledge source is not attached to this conversation"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) detachConversationKnowledge(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	sourceID, err := uuid.Parse(c.Param("sourceId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid context resource id"))
		return
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(c, `DELETE FROM conversation_knowledge_sources WHERE conversation_id = $1 AND source_id = $2`, conversationID, sourceID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	// Conversation-owned imports are disposable. Library sources have a NULL
	// conversation_id and remain reusable after detaching.
	if _, err := transaction.ExecContext(c, `DELETE FROM knowledge_sources WHERE id = $1 AND conversation_id = $2`, sourceID, conversationID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) attachConversationNote(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	noteID, err := uuid.Parse(c.Param("noteId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid note id"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	var available bool
	if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM notes WHERE id = $1 AND organization_id = $3 AND (user_id = $2 OR visibility = 'workspace'))`, noteID, principal.UserID, organizationID).Scan(&available); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !available {
		writeError(c, http.StatusForbidden, fmt.Errorf("note is not available"))
		return
	}
	if _, err := a.DB.ExecContext(c, `INSERT INTO conversation_notes (conversation_id, note_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, conversationID, noteID, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) detachConversationNote(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	noteID, err := uuid.Parse(c.Param("noteId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid note id"))
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM conversation_notes WHERE conversation_id = $1 AND note_id = $2`, conversationID, noteID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) attachConversationMCP(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	serverID, err := uuid.Parse(c.Param("serverId"))
	if err != nil || a.authorizeMCPServer(c, serverID.String()) != nil {
		writeError(c, http.StatusForbidden, fmt.Errorf("MCP server is not available"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	if _, err := a.DB.ExecContext(c, `INSERT INTO conversation_mcp_servers (conversation_id, server_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, conversationID, serverID, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) detachConversationMCP(c *gin.Context) {
	a.detachContextRow(c, "conversation_mcp_servers", "server_id")
}

func (a *App) attachConversationTranscription(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	sessionID, err := uuid.Parse(c.Param("sessionId"))
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	if err != nil || a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID) != nil {
		writeError(c, http.StatusForbidden, fmt.Errorf("transcription session is not available"))
		return
	}
	if _, err := a.DB.ExecContext(c, `INSERT INTO conversation_transcription_sessions (conversation_id, session_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, conversationID, sessionID, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) detachConversationTranscription(c *gin.Context) {
	a.detachContextRow(c, "conversation_transcription_sessions", "session_id")
}

func (a *App) detachContextRow(c *gin.Context, table, column string) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	resourceID := c.Param("sourceId")
	if resourceID == "" {
		resourceID = c.Param("serverId")
	}
	if resourceID == "" {
		resourceID = c.Param("sessionId")
	}
	parsed, err := uuid.Parse(resourceID)
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid context resource id"))
		return
	}
	// Table/column are fixed internal call sites, not user-controlled SQL.
	if _, err := a.DB.ExecContext(c, `DELETE FROM `+table+` WHERE conversation_id = $1 AND `+column+` = $2`, conversationID, parsed); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) canUseKnowledgeSource(c *gin.Context, sourceID, targetConversationID uuid.UUID) bool {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	var scopeType string
	var scopeID uuid.UUID
	var status string
	var sourceConversationID sql.NullString
	if err := a.DB.QueryRowContext(c, `SELECT scope_type, scope_id, status, conversation_id::text FROM knowledge_sources WHERE id = $1`, sourceID).Scan(&scopeType, &scopeID, &status, &sourceConversationID); err != nil {
		return false
	}
	if sourceConversationID.Valid && sourceConversationID.String != targetConversationID.String() {
		return false
	}
	// Queued and processing sources are attachable so the context pane can show
	// live indexing state and chat/voice can block until the source is ready.
	// Failed sources remain detached until the user retries indexing.
	return (status == "queued" || status == "processing" || status == "ready") && ((scopeType == "organization" && scopeID == organizationID) || (scopeType == "user" && scopeID == principal.UserID))
}

func scanMCPServerContext(scanner interface{ Scan(dest ...any) error }) (models.MCPServer, error) {
	var item models.MCPServer
	var scopeID sql.NullString
	var allowed []byte
	if err := scanner.Scan(&item.ID, &item.ScopeType, &scopeID, &item.Name, &item.EndpointURL, &item.AuthType, &item.IconURL, &item.CredentialConfigured, &item.Enabled, &allowed, &item.TrustedReadOnly, &item.LastTestedAt, &item.LastError, &item.ProtocolVersion, &item.ToolCount, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	item.ScopeID = parseMCPScopeID(scopeID)
	if len(allowed) == 0 {
		allowed = []byte("[]")
	}
	item.AllowedTools = allowed
	return item, nil
}

func (a *App) createConversationAttachment(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("file is required"))
		return
	}
	if fileHeader.Size > 25*1024*1024 {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("files are limited to 25 MB"))
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	defer file.Close()
	body, err := readUpload(file, fileHeader.Size)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	content, err := rag.ExtractUploadContext(c, fileHeader.Filename, fileHeader.Header.Get("Content-Type"), body)
	if err != nil {
		writeError(c, http.StatusUnprocessableEntity, err)
		return
	}
	if strings.TrimSpace(content) == "" {
		writeError(c, http.StatusUnprocessableEntity, fmt.Errorf("attachment contains no readable text"))
		return
	}
	item, err := rag.NewSource(c, a.DB, "user", principal.UserID, principal.UserID, fileHeader.Filename, "upload", "", fileHeader.Header.Get("Content-Type"), content)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.ContextScope = "message"
	if err := a.attachConversationSource(c, conversationID, item.ID, principal.UserID, "message"); err != nil {
		_, _ = a.DB.ExecContext(c, `DELETE FROM knowledge_sources WHERE id = $1 AND created_by = $2`, item.ID, principal.UserID)
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusAccepted, item)
}

func (a *App) createConversationURLAttachment(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	var request struct {
		Title string `json:"title"`
		URL   string `json:"url"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	request.URL = strings.TrimSpace(request.URL)
	if request.URL == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("url is required"))
		return
	}
	item, err := rag.NewSource(c, a.DB, "user", principal.UserID, principal.UserID, strings.TrimSpace(request.Title), "url", request.URL, "text/html", "")
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	item.ContextScope = "persistent"
	if err := a.attachConversationSource(c, conversationID, item.ID, principal.UserID, "persistent"); err != nil {
		_, _ = a.DB.ExecContext(c, `DELETE FROM knowledge_sources WHERE id = $1 AND created_by = $2`, item.ID, principal.UserID)
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusAccepted, item)
}

func (a *App) createConversationTextAttachment(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	var request struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if strings.TrimSpace(request.Content) == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("content is required"))
		return
	}
	if len(request.Content) > 10*1024*1024 {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("text attachments are limited to 10 MB"))
		return
	}
	item, err := rag.NewSource(c, a.DB, "user", principal.UserID, principal.UserID, strings.TrimSpace(request.Title), "text", "", "text/plain", request.Content)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.ContextScope = "persistent"
	if err := a.attachConversationSource(c, conversationID, item.ID, principal.UserID, "persistent"); err != nil {
		_, _ = a.DB.ExecContext(c, `DELETE FROM knowledge_sources WHERE id = $1 AND created_by = $2`, item.ID, principal.UserID)
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusAccepted, item)
}

func (a *App) attachConversationSource(ctx context.Context, conversationID, sourceID, userID uuid.UUID, contextScope string) error {
	if contextScope != "persistent" && contextScope != "message" {
		return fmt.Errorf("invalid conversation context scope")
	}
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `UPDATE knowledge_sources SET conversation_id = $1, updated_at = now() WHERE id = $2 AND created_by = $3`, conversationID, sourceID, userID); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `INSERT INTO conversation_knowledge_sources (conversation_id, source_id, added_by, context_scope) VALUES ($1, $2, $3, $4)`, conversationID, sourceID, userID, contextScope); err != nil {
		return err
	}
	return transaction.Commit()
}
