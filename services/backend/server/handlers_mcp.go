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

	"justai-backend/mcp"
	"justai-backend/middleware"
	"justai-backend/models"
)

type mcpRequest struct {
	ScopeType             string   `json:"scopeType"`
	Name                  string   `json:"name"`
	EndpointURL           string   `json:"endpointUrl"`
	AuthType              string   `json:"authType"`
	Credential            string   `json:"credential"`
	OAuthAuthorizationURL string   `json:"oauthAuthorizationUrl"`
	OAuthTokenURL         string   `json:"oauthTokenUrl"`
	OAuthClientID         string   `json:"oauthClientId"`
	OAuthScopes           string   `json:"oauthScopes"`
	Enabled               *bool    `json:"enabled"`
	TrustedReadOnly       *bool    `json:"trustedReadOnly"`
	AllowedTools          []string `json:"allowedTools"`
}

func (a *App) listMCPServers(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	rows, err := a.DB.QueryContext(c, `SELECT id, scope_type, scope_id, name, endpoint_url, auth_type, encrypted_credential IS NOT NULL, enabled, allowed_tools, trusted_read_only, last_tested_at, COALESCE(last_error, ''), COALESCE(protocol_version, ''), (SELECT COUNT(*) FROM mcp_server_tools mst WHERE mst.server_id = mcp_servers.id), created_at, updated_at FROM mcp_servers WHERE (scope_type = 'organization' AND scope_id = $1) OR (scope_type = 'user' AND scope_id = $2) ORDER BY created_at DESC`, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := []models.MCPServer{}
	for rows.Next() {
		item, err := scanMCPServer(rows)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		result = append(result, item)
	}
	c.JSON(http.StatusOK, gin.H{"servers": result})
}

func (a *App) createMCPServer(c *gin.Context) {
	var request mcpRequest
	if !decodeJSON(c, &request) {
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	scopeType := request.ScopeType
	if scopeType == "" {
		scopeType = "organization"
	}
	scopeID := organizationID
	if scopeType == "user" {
		scopeID = principal.UserID
	} else if scopeType != "organization" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("scopeType must be organization or user"))
		return
	}
	if scopeType == "organization" {
		role := middleware.GetOrganizationRole(c)
		if role != "owner" && role != "admin" && !principal.PlatformAdmin {
			writeError(c, http.StatusForbidden, fmt.Errorf("organization MCP servers require owner or admin access"))
			return
		}
	}
	if request.Name == "" || request.EndpointURL == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("name and endpointUrl are required"))
		return
	}
	if request.AuthType == "" {
		request.AuthType = "none"
	}
	if request.AuthType != "none" && request.AuthType != "api_key" && request.AuthType != "oauth" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("authType must be none, api_key, or oauth"))
		return
	}
	if request.AuthType == "oauth" {
		if request.OAuthClientID == "" {
			writeError(c, http.StatusBadRequest, fmt.Errorf("OAuth requires a client ID"))
			return
		}
		if request.OAuthAuthorizationURL != "" {
			if err := (mcp.Server{EndpointURL: request.OAuthAuthorizationURL}).ValidateURL(a.Config.AllowPrivate); err != nil {
				writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OAuth authorization URL: %w", err))
				return
			}
		}
		if request.OAuthTokenURL != "" {
			if err := (mcp.Server{EndpointURL: request.OAuthTokenURL}).ValidateURL(a.Config.AllowPrivate); err != nil {
				writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OAuth token URL: %w", err))
				return
			}
		}
	}
	client := mcp.Server{EndpointURL: request.EndpointURL}
	if err := client.ValidateURL(a.Config.AllowPrivate); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var credential []byte
	var err error
	if request.Credential = strings.TrimSpace(request.Credential); request.Credential != "" {
		credential, err = a.Secrets.Encrypt(request.Credential)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	var serverID uuid.UUID
	trustedReadOnly := false
	if request.TrustedReadOnly != nil && *request.TrustedReadOnly && (middleware.GetOrganizationRole(c) == "owner" || middleware.GetOrganizationRole(c) == "admin" || principal.PlatformAdmin || scopeType == "user") {
		trustedReadOnly = true
	}
	if err := a.DB.QueryRowContext(c, `INSERT INTO mcp_servers (scope_type, scope_id, name, endpoint_url, auth_type, encrypted_credential, oauth_authorization_url, oauth_token_url, oauth_client_id, oauth_scopes, enabled, allowed_tools, trusted_read_only, created_by) VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), $11, $12, $13, $14) RETURNING id`, scopeType, scopeID, request.Name, request.EndpointURL, request.AuthType, nullableBytes(credential), request.OAuthAuthorizationURL, request.OAuthTokenURL, request.OAuthClientID, request.OAuthScopes, boolValue(request.Enabled, true), jsonRaw(request.AllowedTools), trustedReadOnly, principal.UserID).Scan(&serverID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := a.getMCPServer(c, serverID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, item)
}

func (a *App) updateMCPServer(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid MCP server id"))
		return
	}
	if err := a.authorizeMCPServerManage(c, id.String()); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var request mcpRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.Credential = strings.TrimSpace(request.Credential)
	if request.EndpointURL != "" {
		if err := (mcp.Server{EndpointURL: request.EndpointURL}).ValidateURL(a.Config.AllowPrivate); err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
	}
	if request.AuthType != "" && request.AuthType != "none" && request.AuthType != "api_key" && request.AuthType != "oauth" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("authType must be none, api_key, or oauth"))
		return
	}
	if request.AuthType == "oauth" {
		if request.OAuthAuthorizationURL != "" {
			if err := (mcp.Server{EndpointURL: request.OAuthAuthorizationURL}).ValidateURL(a.Config.AllowPrivate); err != nil {
				writeError(c, http.StatusBadRequest, err)
				return
			}
		}
		if request.OAuthTokenURL != "" {
			if err := (mcp.Server{EndpointURL: request.OAuthTokenURL}).ValidateURL(a.Config.AllowPrivate); err != nil {
				writeError(c, http.StatusBadRequest, err)
				return
			}
		}
	}
	allowedTools := nullableJSON(request.AllowedTools)
	var currentAuthType string
	if err := a.DB.QueryRowContext(c, `SELECT auth_type FROM mcp_servers WHERE id = $1`, id).Scan(&currentAuthType); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("MCP server not found"))
		return
	}
	authTypeChanged := request.AuthType != "" && request.AuthType != currentAuthType
	credentialProvided := request.Credential != "" || request.AuthType == "none" || authTypeChanged
	if credentialProvided {
		var requestCredential []byte
		if request.Credential != "" {
			requestCredential, err = a.Secrets.Encrypt(request.Credential)
			if err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
		}
		_, err = a.DB.ExecContext(c, `UPDATE mcp_servers SET name = COALESCE(NULLIF($2, ''), name), endpoint_url = COALESCE(NULLIF($3, ''), endpoint_url), auth_type = COALESCE(NULLIF($4, ''), auth_type), encrypted_credential = $5, oauth_refresh_credential = NULL, oauth_expires_at = NULL, oauth_authorization_url = COALESCE(NULLIF($6, ''), oauth_authorization_url), oauth_token_url = COALESCE(NULLIF($7, ''), oauth_token_url), oauth_client_id = COALESCE(NULLIF($8, ''), oauth_client_id), oauth_scopes = COALESCE(NULLIF($9, ''), oauth_scopes), enabled = COALESCE($10, enabled), allowed_tools = COALESCE($11, allowed_tools), trusted_read_only = COALESCE($12, trusted_read_only), last_tested_at = NULL, last_error = NULL, protocol_version = NULL, updated_at = now() WHERE id = $1`, id, request.Name, request.EndpointURL, request.AuthType, nullableBytes(requestCredential), request.OAuthAuthorizationURL, request.OAuthTokenURL, request.OAuthClientID, request.OAuthScopes, request.Enabled, allowedTools, request.TrustedReadOnly)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	} else if _, err := a.DB.ExecContext(c, `UPDATE mcp_servers SET name = COALESCE(NULLIF($2, ''), name), endpoint_url = COALESCE(NULLIF($3, ''), endpoint_url), auth_type = COALESCE(NULLIF($4, ''), auth_type), oauth_authorization_url = COALESCE(NULLIF($5, ''), oauth_authorization_url), oauth_token_url = COALESCE(NULLIF($6, ''), oauth_token_url), oauth_client_id = COALESCE(NULLIF($7, ''), oauth_client_id), oauth_scopes = COALESCE(NULLIF($8, ''), oauth_scopes), enabled = COALESCE($9, enabled), allowed_tools = COALESCE($10, allowed_tools), trusted_read_only = COALESCE($11, trusted_read_only), last_tested_at = NULL, last_error = NULL, protocol_version = NULL, updated_at = now() WHERE id = $1`, id, request.Name, request.EndpointURL, request.AuthType, request.OAuthAuthorizationURL, request.OAuthTokenURL, request.OAuthClientID, request.OAuthScopes, request.Enabled, allowedTools, request.TrustedReadOnly); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	// Configuration or credential changes invalidate the discovered tool cache.
	if _, err := a.DB.ExecContext(c, `DELETE FROM mcp_server_tools WHERE server_id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	_, _ = a.DB.ExecContext(c, `UPDATE mcp_servers SET tools_discovered_at = NULL WHERE id = $1`, id)
	mcp.Invalidate(id.String())
	item, err := a.getMCPServer(c, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (a *App) deleteMCPServer(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid MCP server id"))
		return
	}
	if err := a.authorizeMCPServerManage(c, id.String()); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM mcp_servers WHERE id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	mcp.Invalidate(id.String())
	c.Status(http.StatusNoContent)
}

func (a *App) testMCPServer(c *gin.Context) {
	if err := a.authorizeMCPServerManage(c, c.Param("id")); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	server, err := a.loadMCPServer(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	mcp.Invalidate(server.ID)
	tools, err := server.ListTools(c)
	serverID := serverIDFromParam(c.Param("id"))
	if err == nil {
		if cacheErr := a.cacheMCPTools(c, serverID, tools); cacheErr != nil {
			err = fmt.Errorf("MCP tools were discovered but could not be cached: %w", cacheErr)
		}
	}
	if err == nil {
		_, _ = a.DB.ExecContext(c, `UPDATE mcp_servers SET last_tested_at = now(), last_error = NULL, protocol_version = NULLIF($2, ''), updated_at = now() WHERE id = $1`, serverID, server.ProtocolVersion)
	} else {
		_, _ = a.DB.ExecContext(c, `UPDATE mcp_servers SET last_tested_at = now(), last_error = $2, updated_at = now() WHERE id = $1`, serverID, err.Error())
	}
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	updated, updateErr := a.getMCPServer(c, serverID)
	if updateErr != nil {
		c.JSON(http.StatusOK, gin.H{"ok": true, "tools": tools})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "tools": tools, "server": updated})
}

func (a *App) listMCPTools(c *gin.Context) {
	if err := a.authorizeMCPServerManage(c, c.Param("id")); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	server, err := a.loadMCPServer(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	mcp.Invalidate(server.ID)
	tools, err := server.ListTools(c)
	if err != nil {
		_, _ = a.DB.ExecContext(c, `UPDATE mcp_servers SET last_error = $2, updated_at = now() WHERE id = $1`, serverIDFromParam(c.Param("id")), err.Error())
		writeError(c, http.StatusBadGateway, err)
		return
	}
	serverID := serverIDFromParam(c.Param("id"))
	if err := a.cacheMCPTools(c, serverID, tools); err != nil {
		_, _ = a.DB.ExecContext(c, `UPDATE mcp_servers SET last_error = $2, updated_at = now() WHERE id = $1`, serverID, err.Error())
		writeError(c, http.StatusInternalServerError, fmt.Errorf("MCP tools could not be cached: %w", err))
		return
	}
	_, _ = a.DB.ExecContext(c, `UPDATE mcp_servers SET last_error = NULL, updated_at = now() WHERE id = $1`, serverID)
	c.JSON(http.StatusOK, gin.H{"tools": tools})
}

func (a *App) authorizeMCPServer(c *gin.Context, rawID string) error {
	id, err := uuid.Parse(rawID)
	if err != nil {
		return fmt.Errorf("invalid MCP server id")
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	var scopeType string
	var scopeID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT scope_type, scope_id FROM mcp_servers WHERE id = $1`, id).Scan(&scopeType, &scopeID); err != nil {
		return fmt.Errorf("MCP server not found")
	}
	if scopeType == "organization" && scopeID == organizationID {
		return nil
	}
	if scopeType == "user" && scopeID == principal.UserID {
		return nil
	}
	return fmt.Errorf("MCP server belongs to another scope")
}

func (a *App) authorizeMCPServerManage(c *gin.Context, rawID string) error {
	if err := a.authorizeMCPServer(c, rawID); err != nil {
		return err
	}
	principal, _ := middleware.GetPrincipal(c)
	id, _ := uuid.Parse(rawID)
	var scopeType string
	var scopeID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT scope_type, scope_id FROM mcp_servers WHERE id = $1`, id).Scan(&scopeType, &scopeID); err != nil {
		return fmt.Errorf("MCP server not found")
	}
	// Personal servers are private even to organization administrators. An
	// organization owner/admin (or platform admin) can manage only servers in
	// the active organization scope.
	if scopeType == "user" {
		if scopeID != principal.UserID {
			return fmt.Errorf("personal MCP servers can only be managed by their owner")
		}
		return nil
	}
	if principal.PlatformAdmin {
		return nil
	}
	if role := middleware.GetOrganizationRole(c); role != "owner" && role != "admin" {
		return fmt.Errorf("organization MCP servers require owner or admin access")
	}
	return nil
}

func scanMCPServer(scanner interface{ Scan(dest ...any) error }) (models.MCPServer, error) {
	var item models.MCPServer
	var scopeID uuid.UUID
	var allowed []byte
	if err := scanner.Scan(&item.ID, &item.ScopeType, &scopeID, &item.Name, &item.EndpointURL, &item.AuthType, &item.CredentialConfigured, &item.Enabled, &allowed, &item.TrustedReadOnly, &item.LastTestedAt, &item.LastError, &item.ProtocolVersion, &item.ToolCount, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	item.ScopeID = scopeID
	if len(allowed) == 0 || string(allowed) == "null" {
		allowed = []byte("[]")
	}
	item.AllowedTools = json.RawMessage(allowed)
	return item, nil
}

func (a *App) getMCPServer(ctx context.Context, id uuid.UUID) (models.MCPServer, error) {
	return scanMCPServer(a.DB.QueryRowContext(ctx, `SELECT id, scope_type, scope_id, name, endpoint_url, auth_type, encrypted_credential IS NOT NULL, enabled, allowed_tools, trusted_read_only, last_tested_at, COALESCE(last_error, ''), COALESCE(protocol_version, ''), (SELECT COUNT(*) FROM mcp_server_tools mst WHERE mst.server_id = mcp_servers.id), created_at, updated_at FROM mcp_servers WHERE id = $1`, id))
}

func (a *App) loadMCPServer(ctx context.Context, rawID string) (mcp.Server, error) {
	id, err := uuid.Parse(rawID)
	if err != nil {
		return mcp.Server{}, fmt.Errorf("invalid MCP server id")
	}
	var server mcp.Server
	var credential []byte
	var refreshCredential []byte
	var expiresAt sql.NullTime
	var allowed []byte
	if err := a.DB.QueryRowContext(ctx, `SELECT id, endpoint_url, auth_type, encrypted_credential, oauth_refresh_credential, oauth_token_url, COALESCE(oauth_client_id, ''), oauth_expires_at, allowed_tools, trusted_read_only, COALESCE(protocol_version, '') FROM mcp_servers WHERE id = $1 AND enabled = TRUE`, id).Scan(&server.ID, &server.EndpointURL, &server.AuthType, &credential, &refreshCredential, &server.OAuthTokenURL, &server.OAuthClientID, &expiresAt, &allowed, &server.TrustedReadOnly, &server.ProtocolVersion); err != nil {
		return server, err
	}
	if len(credential) > 0 {
		server.Credential, err = a.Secrets.Decrypt(credential)
		if err != nil {
			return server, err
		}
	}
	if len(refreshCredential) > 0 {
		server.OAuthRefreshToken, err = a.Secrets.Decrypt(refreshCredential)
		if err != nil {
			return server, err
		}
	}
	if expiresAt.Valid {
		server.OAuthExpiresAt = expiresAt.Time
	}
	var allowedNames []string
	_ = json.Unmarshal(allowed, &allowedNames)
	server.Allowed = map[string]bool{}
	server.AllowPrivate = a.Config.AllowPrivate
	server.OnTokenRefresh = func(accessToken, refreshToken string, refreshedAt time.Time) {
		if a.Secrets == nil || a.DB == nil {
			return
		}
		accessCiphertext, encryptErr := a.Secrets.Encrypt(accessToken)
		if encryptErr != nil {
			return
		}
		var refreshCiphertext any
		if refreshToken != "" {
			if value, encryptErr := a.Secrets.Encrypt(refreshToken); encryptErr == nil {
				refreshCiphertext = value
			}
		}
		var expires any
		if !refreshedAt.IsZero() {
			expires = refreshedAt
		}
		_, _ = a.DB.ExecContext(context.Background(), `UPDATE mcp_servers SET encrypted_credential = $2, oauth_refresh_credential = COALESCE($3, oauth_refresh_credential), oauth_expires_at = $4, tools_discovered_at = NULL, last_tested_at = NULL, last_error = NULL, protocol_version = NULL, updated_at = now() WHERE id = $1`, id, accessCiphertext, refreshCiphertext, expires)
		_, _ = a.DB.ExecContext(context.Background(), `DELETE FROM mcp_server_tools WHERE server_id = $1`, id)
		mcp.Invalidate(id.String())
	}
	for _, name := range allowedNames {
		server.Allowed[name] = true
	}
	return server, nil
}

func serverIDFromParam(raw string) uuid.UUID {
	id, _ := uuid.Parse(raw)
	return id
}

func (a *App) cacheMCPTools(ctx context.Context, serverID uuid.UUID, tools []mcp.Tool) error {
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `DELETE FROM mcp_server_tools WHERE server_id = $1`, serverID); err != nil {
		return err
	}
	for _, tool := range tools {
		_, err := transaction.ExecContext(ctx, `INSERT INTO mcp_server_tools (server_id, name, description, input_schema, annotations) VALUES ($1, $2, NULLIF($3, ''), $4, $5) ON CONFLICT (server_id, name) DO UPDATE SET description = EXCLUDED.description, input_schema = EXCLUDED.input_schema, annotations = EXCLUDED.annotations, discovered_at = now()`, serverID, tool.Name, tool.Description, jsonRaw(tool.InputSchema), jsonRaw(tool.Annotations))
		if err != nil {
			return err
		}
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE mcp_servers SET tools_discovered_at = now(), updated_at = now() WHERE id = $1`, serverID); err != nil {
		return err
	}
	return transaction.Commit()
}

func (a *App) cachedMCPTools(ctx context.Context, serverID uuid.UUID) ([]mcp.Tool, bool, error) {
	var cached bool
	if err := a.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM mcp_servers WHERE id = $1 AND tools_discovered_at > now() - interval '10 minutes')`, serverID).Scan(&cached); err != nil {
		return nil, false, err
	}
	// A successful discovery can legitimately return zero tools. Use the
	// discovery timestamp as the cache marker instead of treating an empty
	// result as a cache miss and repeatedly reconnecting to the server.
	if !cached {
		return nil, false, nil
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT name, COALESCE(description, ''), input_schema, annotations FROM mcp_server_tools WHERE server_id = $1 AND discovered_at > now() - interval '10 minutes' ORDER BY name`, serverID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	tools := make([]mcp.Tool, 0)
	for rows.Next() {
		var tool mcp.Tool
		var inputSchema, annotations []byte
		if err := rows.Scan(&tool.Name, &tool.Description, &inputSchema, &annotations); err != nil {
			return nil, false, err
		}
		tool.InputSchema = json.RawMessage(inputSchema)
		if len(annotations) > 0 {
			if err := json.Unmarshal(annotations, &tool.Annotations); err != nil {
				return nil, false, err
			}
		}
		tools = append(tools, tool)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return tools, true, nil
}

func nullableJSON(value []string) any {
	if value == nil {
		return nil
	}
	return jsonRaw(value)
}
