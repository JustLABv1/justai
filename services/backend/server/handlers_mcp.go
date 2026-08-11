package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

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
	AllowedTools          []string `json:"allowedTools"`
}

type toolCallRequest struct {
	Arguments map[string]any `json:"arguments"`
	Approved  bool           `json:"approved"`
}

func (a *App) listMCPServers(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	rows, err := a.DB.QueryContext(c, `SELECT id, scope_type, scope_id, name, endpoint_url, auth_type, encrypted_credential IS NOT NULL, enabled, allowed_tools, created_at, updated_at FROM mcp_servers WHERE (scope_type = 'organization' AND scope_id = $1) OR (scope_type = 'user' AND scope_id = $2) ORDER BY created_at DESC`, organizationID, principal.UserID)
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
		if request.OAuthAuthorizationURL == "" || request.OAuthTokenURL == "" || request.OAuthClientID == "" {
			writeError(c, http.StatusBadRequest, fmt.Errorf("OAuth requires authorization URL, token URL, and client ID"))
			return
		}
		if err := (mcp.Server{EndpointURL: request.OAuthAuthorizationURL}).ValidateURL(a.Config.AllowPrivate); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OAuth authorization URL: %w", err))
			return
		}
		if err := (mcp.Server{EndpointURL: request.OAuthTokenURL}).ValidateURL(a.Config.AllowPrivate); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OAuth token URL: %w", err))
			return
		}
	}
	client := mcp.Server{EndpointURL: request.EndpointURL}
	if err := client.ValidateURL(a.Config.AllowPrivate); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	credential, err := a.Secrets.Encrypt(request.Credential)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var serverID uuid.UUID
	if err := a.DB.QueryRowContext(c, `INSERT INTO mcp_servers (scope_type, scope_id, name, endpoint_url, auth_type, encrypted_credential, oauth_authorization_url, oauth_token_url, oauth_client_id, oauth_scopes, enabled, allowed_tools, created_by) VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), $11, $12, $13) RETURNING id`, scopeType, scopeID, request.Name, request.EndpointURL, request.AuthType, nullableBytes(credential), request.OAuthAuthorizationURL, request.OAuthTokenURL, request.OAuthClientID, request.OAuthScopes, boolValue(request.Enabled, true), jsonRaw(request.AllowedTools), principal.UserID).Scan(&serverID); err != nil {
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
	if err := a.authorizeMCPServer(c, id.String()); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var request mcpRequest
	if !decodeJSON(c, &request) {
		return
	}
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
	if request.Credential != "" {
		requestCredential, err := a.Secrets.Encrypt(request.Credential)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		_, err = a.DB.ExecContext(c, `UPDATE mcp_servers SET name = COALESCE(NULLIF($2, ''), name), endpoint_url = COALESCE(NULLIF($3, ''), endpoint_url), auth_type = COALESCE(NULLIF($4, ''), auth_type), encrypted_credential = $5, oauth_authorization_url = COALESCE(NULLIF($6, ''), oauth_authorization_url), oauth_token_url = COALESCE(NULLIF($7, ''), oauth_token_url), oauth_client_id = COALESCE(NULLIF($8, ''), oauth_client_id), oauth_scopes = COALESCE(NULLIF($9, ''), oauth_scopes), enabled = $10, allowed_tools = $11, updated_at = now() WHERE id = $1`, id, request.Name, request.EndpointURL, request.AuthType, requestCredential, request.OAuthAuthorizationURL, request.OAuthTokenURL, request.OAuthClientID, request.OAuthScopes, boolValue(request.Enabled, true), jsonRaw(request.AllowedTools))
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	} else if _, err := a.DB.ExecContext(c, `UPDATE mcp_servers SET name = COALESCE(NULLIF($2, ''), name), endpoint_url = COALESCE(NULLIF($3, ''), endpoint_url), auth_type = COALESCE(NULLIF($4, ''), auth_type), oauth_authorization_url = COALESCE(NULLIF($5, ''), oauth_authorization_url), oauth_token_url = COALESCE(NULLIF($6, ''), oauth_token_url), oauth_client_id = COALESCE(NULLIF($7, ''), oauth_client_id), oauth_scopes = COALESCE(NULLIF($8, ''), oauth_scopes), enabled = $9, allowed_tools = $10, updated_at = now() WHERE id = $1`, id, request.Name, request.EndpointURL, request.AuthType, request.OAuthAuthorizationURL, request.OAuthTokenURL, request.OAuthClientID, request.OAuthScopes, boolValue(request.Enabled, true), jsonRaw(request.AllowedTools)); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *App) deleteMCPServer(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid MCP server id"))
		return
	}
	if err := a.authorizeMCPServer(c, id.String()); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM mcp_servers WHERE id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) testMCPServer(c *gin.Context) {
	if err := a.authorizeMCPServer(c, c.Param("id")); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	server, err := a.loadMCPServer(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	tools, err := server.ListTools(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "tools": tools})
}

func (a *App) listMCPTools(c *gin.Context) {
	if err := a.authorizeMCPServer(c, c.Param("id")); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	server, err := a.loadMCPServer(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	tools, err := server.ListTools(c)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"tools": tools})
}

func (a *App) callMCPTool(c *gin.Context) {
	var request toolCallRequest
	if !decodeJSON(c, &request) {
		return
	}
	if !request.Approved {
		writeError(c, http.StatusPreconditionRequired, fmt.Errorf("mutating MCP tools require explicit approval"))
		return
	}
	if err := a.authorizeMCPServer(c, c.Param("id")); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	server, err := a.loadMCPServer(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	result, err := server.CallTool(c, c.Param("tool"), request.Arguments)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"result": json.RawMessage(result)})
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

func scanMCPServer(scanner interface{ Scan(dest ...any) error }) (models.MCPServer, error) {
	var item models.MCPServer
	var scopeID uuid.UUID
	var allowed []byte
	if err := scanner.Scan(&item.ID, &item.ScopeType, &scopeID, &item.Name, &item.EndpointURL, &item.AuthType, &item.CredentialConfigured, &item.Enabled, &allowed, &item.CreatedAt, &item.UpdatedAt); err != nil {
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
	return scanMCPServer(a.DB.QueryRowContext(ctx, `SELECT id, scope_type, scope_id, name, endpoint_url, auth_type, encrypted_credential IS NOT NULL, enabled, allowed_tools, created_at, updated_at FROM mcp_servers WHERE id = $1`, id))
}

func (a *App) loadMCPServer(ctx context.Context, rawID string) (mcp.Server, error) {
	id, err := uuid.Parse(rawID)
	if err != nil {
		return mcp.Server{}, fmt.Errorf("invalid MCP server id")
	}
	var server mcp.Server
	var credential []byte
	var allowed []byte
	if err := a.DB.QueryRowContext(ctx, `SELECT endpoint_url, auth_type, encrypted_credential, allowed_tools FROM mcp_servers WHERE id = $1 AND enabled = TRUE`, id).Scan(&server.EndpointURL, &server.AuthType, &credential, &allowed); err != nil {
		return server, err
	}
	if len(credential) > 0 {
		server.Credential, err = a.Secrets.Decrypt(credential)
		if err != nil {
			return server, err
		}
	}
	var allowedNames []string
	_ = json.Unmarshal(allowed, &allowedNames)
	server.Allowed = map[string]bool{}
	for _, name := range allowedNames {
		server.Allowed[name] = true
	}
	return server, nil
}
