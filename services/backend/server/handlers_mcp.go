package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gabriel-vasile/mimetype"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"justai-backend/mcp"
	"justai-backend/middleware"
	"justai-backend/models"
)

type mcpRequest struct {
	ScopeType             string   `json:"scopeType"`
	ScopeID               *string  `json:"scopeId"`
	Name                  string   `json:"name"`
	IconURL               *string  `json:"iconUrl"`
	EndpointURL           string   `json:"endpointUrl"`
	AuthType              string   `json:"authType"`
	Credential            string   `json:"credential"`
	OAuthAuthorizationURL string   `json:"oauthAuthorizationUrl"`
	OAuthTokenURL         string   `json:"oauthTokenUrl"`
	OAuthClientID         string   `json:"oauthClientId"`
	OAuthScopes           string   `json:"oauthScopes"`
	Enabled               *bool    `json:"enabled"`
	TrustedReadOnly       *bool    `json:"trustedReadOnly"`
	AutoDiscover          *bool    `json:"autoDiscover"`
	AllowedTools          []string `json:"allowedTools"`
}

func (a *App) listMCPServers(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, hasOrganization := middleware.GetOrganizationID(c)
	if !hasOrganization {
		organizationID, _, _ = middleware.ResolveOrganization(c, a.DB, principal)
	}
	rows, err := a.DB.QueryContext(c, `SELECT id, scope_type, scope_id, name, CASE WHEN EXISTS (SELECT 1 FROM mcp_server_icons msi WHERE msi.server_id = mcp_servers.id) THEN '/api/v1/mcp/servers/' || mcp_servers.id::text || '/icon' ELSE COALESCE(icon_url, '') END, endpoint_url, auth_type, encrypted_credential IS NOT NULL, enabled, allowed_tools, trusted_read_only, auto_discover, last_tested_at, COALESCE(last_error, ''), COALESCE(protocol_version, ''), (SELECT COUNT(*) FROM mcp_server_tools mst WHERE mst.server_id = mcp_servers.id), created_at, updated_at FROM mcp_servers WHERE (scope_type = 'global') OR (scope_type = 'organization' AND scope_id = $1) OR (scope_type = 'user' AND scope_id = $2) ORDER BY created_at DESC`, organizationID, principal.UserID)
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
	requestedScopeID, err := parseNullableUUID(request.ScopeID)
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid scopeId"))
		return
	}
	var scopeID any = organizationID
	if scopeType == "user" {
		if requestedScopeID != nil {
			if !principal.PlatformAdmin && *requestedScopeID != principal.UserID {
				writeError(c, http.StatusForbidden, fmt.Errorf("personal MCP scope belongs to another user"))
				return
			}
			scopeID = *requestedScopeID
		} else {
			scopeID = principal.UserID
		}
	} else if scopeType == "global" {
		if !principal.PlatformAdmin || !isPlatformCatalogRoute(c) {
			writeError(c, http.StatusForbidden, fmt.Errorf("global MCP servers can only be managed from the platform admin catalog"))
			return
		}
		scopeID = nil
	} else if scopeType != "organization" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("scopeType must be global, organization, or user"))
		return
	}
	if scopeType == "organization" {
		if requestedScopeID != nil {
			if !principal.PlatformAdmin && *requestedScopeID != organizationID {
				writeError(c, http.StatusForbidden, fmt.Errorf("organization MCP scope does not match the active organization"))
				return
			}
			organizationID = *requestedScopeID
			scopeID = organizationID
		}
		if organizationID == uuid.Nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("organization scope requires an organization id"))
			return
		}
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
	iconURL, err := normalizeMCPIconURL(request.IconURL)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
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
	if err := a.DB.QueryRowContext(c, `INSERT INTO mcp_servers (scope_type, scope_id, name, icon_url, endpoint_url, auth_type, encrypted_credential, oauth_authorization_url, oauth_token_url, oauth_client_id, oauth_scopes, enabled, allowed_tools, trusted_read_only, auto_discover, created_by) VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), $12, $13, $14, $15, $16) RETURNING id`, scopeType, scopeID, request.Name, iconURL, request.EndpointURL, request.AuthType, nullableBytes(credential), request.OAuthAuthorizationURL, request.OAuthTokenURL, request.OAuthClientID, request.OAuthScopes, boolValue(request.Enabled, true), jsonRaw(request.AllowedTools), trustedReadOnly, boolValue(request.AutoDiscover, false), principal.UserID).Scan(&serverID); err != nil {
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
	iconURL, err := normalizeMCPIconURL(request.IconURL)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	iconURLSet := request.IconURL != nil
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
		_, err = a.DB.ExecContext(c, `UPDATE mcp_servers SET name = COALESCE(NULLIF($2, ''), name), icon_url = CASE WHEN $3 THEN NULLIF($4, '') ELSE icon_url END, endpoint_url = COALESCE(NULLIF($5, ''), endpoint_url), auth_type = COALESCE(NULLIF($6, ''), auth_type), encrypted_credential = $7, oauth_refresh_credential = NULL, oauth_expires_at = NULL, oauth_authorization_url = COALESCE(NULLIF($8, ''), oauth_authorization_url), oauth_token_url = COALESCE(NULLIF($9, ''), oauth_token_url), oauth_client_id = COALESCE(NULLIF($10, ''), oauth_client_id), oauth_scopes = COALESCE(NULLIF($11, ''), oauth_scopes), enabled = COALESCE($12, enabled), allowed_tools = COALESCE($13, allowed_tools), trusted_read_only = COALESCE($14, trusted_read_only), auto_discover = COALESCE($15, auto_discover), last_tested_at = NULL, last_error = NULL, protocol_version = NULL, updated_at = now() WHERE id = $1`, id, request.Name, iconURLSet, iconURL, request.EndpointURL, request.AuthType, nullableBytes(requestCredential), request.OAuthAuthorizationURL, request.OAuthTokenURL, request.OAuthClientID, request.OAuthScopes, request.Enabled, allowedTools, request.TrustedReadOnly, request.AutoDiscover)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	} else if _, err := a.DB.ExecContext(c, `UPDATE mcp_servers SET name = COALESCE(NULLIF($2, ''), name), icon_url = CASE WHEN $3 THEN NULLIF($4, '') ELSE icon_url END, endpoint_url = COALESCE(NULLIF($5, ''), endpoint_url), auth_type = COALESCE(NULLIF($6, ''), auth_type), oauth_authorization_url = COALESCE(NULLIF($7, ''), oauth_authorization_url), oauth_token_url = COALESCE(NULLIF($8, ''), oauth_token_url), oauth_client_id = COALESCE(NULLIF($9, ''), oauth_client_id), oauth_scopes = COALESCE(NULLIF($10, ''), oauth_scopes), enabled = COALESCE($11, enabled), allowed_tools = COALESCE($12, allowed_tools), trusted_read_only = COALESCE($13, trusted_read_only), auto_discover = COALESCE($14, auto_discover), last_tested_at = NULL, last_error = NULL, protocol_version = NULL, updated_at = now() WHERE id = $1`, id, request.Name, iconURLSet, iconURL, request.EndpointURL, request.AuthType, request.OAuthAuthorizationURL, request.OAuthTokenURL, request.OAuthClientID, request.OAuthScopes, request.Enabled, allowedTools, request.TrustedReadOnly, request.AutoDiscover); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	toolConfigurationChanged := credentialProvided || request.EndpointURL != "" || request.AuthType != "" || request.OAuthAuthorizationURL != "" || request.OAuthTokenURL != "" || request.OAuthClientID != "" || request.OAuthScopes != "" || request.AllowedTools != nil
	if toolConfigurationChanged {
		// Connection, credential, or allowlist changes invalidate discovery.
		// Policy-only toggles (including automatic availability) deliberately
		// preserve the known-good catalog so they take effect immediately.
		if _, err := a.DB.ExecContext(c, `DELETE FROM mcp_server_tools WHERE server_id = $1`, id); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		_, _ = a.DB.ExecContext(c, `UPDATE mcp_servers SET tools_discovered_at = NULL WHERE id = $1`, id)
		mcp.Invalidate(id.String())
	}
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

func (a *App) listMCPResources(c *gin.Context) {
	if err := a.authorizeMCPServer(c, c.Param("id")); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	server, err := a.loadMCPServer(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	result, err := server.ListResources(c)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", result)
}

func (a *App) readMCPResource(c *gin.Context) {
	if err := a.authorizeMCPServer(c, c.Param("id")); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var request struct {
		URI string `json:"uri"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if strings.TrimSpace(request.URI) == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("uri is required"))
		return
	}
	server, err := a.loadMCPServer(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	result, err := server.ReadResource(c, strings.TrimSpace(request.URI))
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", result)
}

func (a *App) listMCPPrompts(c *gin.Context) {
	if err := a.authorizeMCPServer(c, c.Param("id")); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	server, err := a.loadMCPServer(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	result, err := server.ListPrompts(c)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", result)
}

func (a *App) getMCPPrompt(c *gin.Context) {
	if err := a.authorizeMCPServer(c, c.Param("id")); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var request struct {
		Name      string            `json:"name"`
		Arguments map[string]string `json:"arguments"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if strings.TrimSpace(request.Name) == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("name is required"))
		return
	}
	server, err := a.loadMCPServer(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	result, err := server.GetPrompt(c, strings.TrimSpace(request.Name), request.Arguments)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", result)
}

func (a *App) authorizeMCPServer(c *gin.Context, rawID string) error {
	id, err := uuid.Parse(rawID)
	if err != nil {
		return fmt.Errorf("invalid MCP server id")
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, hasOrganization := middleware.GetOrganizationID(c)
	if !hasOrganization {
		organizationID, _, _ = middleware.ResolveOrganization(c, a.DB, principal)
	}
	var scopeType string
	var scopeID sql.NullString
	if err := a.DB.QueryRowContext(c, `SELECT scope_type, scope_id FROM mcp_servers WHERE id = $1`, id).Scan(&scopeType, &scopeID); err != nil {
		return fmt.Errorf("MCP server not found")
	}
	parsedScopeID := parseMCPScopeID(scopeID)
	if principal.PlatformAdmin {
		return nil
	}
	if scopeType == "global" {
		return nil
	}
	if scopeType == "organization" && parsedScopeID != nil && *parsedScopeID == organizationID {
		return nil
	}
	if scopeType == "user" && parsedScopeID != nil && *parsedScopeID == principal.UserID {
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
	var scopeID sql.NullString
	if err := a.DB.QueryRowContext(c, `SELECT scope_type, scope_id FROM mcp_servers WHERE id = $1`, id).Scan(&scopeType, &scopeID); err != nil {
		return fmt.Errorf("MCP server not found")
	}
	parsedScopeID := parseMCPScopeID(scopeID)
	// Personal servers are private even to organization administrators. An
	// organization owner/admin (or platform admin) can manage only servers in
	// the active organization scope.
	if scopeType == "user" {
		if parsedScopeID == nil || *parsedScopeID != principal.UserID {
			return fmt.Errorf("personal MCP servers can only be managed by their owner")
		}
		return nil
	}
	if scopeType == "global" {
		if principal.PlatformAdmin && isPlatformCatalogRoute(c) {
			return nil
		}
		return fmt.Errorf("global MCP servers can only be managed from the platform admin catalog")
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
	var scopeID sql.NullString
	var allowed []byte
	if err := scanner.Scan(&item.ID, &item.ScopeType, &scopeID, &item.Name, &item.IconURL, &item.EndpointURL, &item.AuthType, &item.CredentialConfigured, &item.Enabled, &allowed, &item.TrustedReadOnly, &item.AutoDiscover, &item.LastTestedAt, &item.LastError, &item.ProtocolVersion, &item.ToolCount, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	item.ScopeID = parseMCPScopeID(scopeID)
	if len(allowed) == 0 || string(allowed) == "null" {
		allowed = []byte("[]")
	}
	item.AllowedTools = json.RawMessage(allowed)
	return item, nil
}

func parseMCPScopeID(value sql.NullString) *uuid.UUID {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil
	}
	id, err := uuid.Parse(value.String)
	if err != nil {
		return nil
	}
	return &id
}

func (a *App) getMCPServer(ctx context.Context, id uuid.UUID) (models.MCPServer, error) {
	return scanMCPServer(a.DB.QueryRowContext(ctx, `SELECT id, scope_type, scope_id, name, CASE WHEN EXISTS (SELECT 1 FROM mcp_server_icons msi WHERE msi.server_id = mcp_servers.id) THEN '/api/v1/mcp/servers/' || mcp_servers.id::text || '/icon' ELSE COALESCE(icon_url, '') END, endpoint_url, auth_type, encrypted_credential IS NOT NULL, enabled, allowed_tools, trusted_read_only, auto_discover, last_tested_at, COALESCE(last_error, ''), COALESCE(protocol_version, ''), (SELECT COUNT(*) FROM mcp_server_tools mst WHERE mst.server_id = mcp_servers.id), created_at, updated_at FROM mcp_servers WHERE id = $1`, id))
}

const (
	maxMCPServerIconUploadBytes = 2 * 1024 * 1024
	maxMCPServerIconStoredBytes = 512 * 1024
	maxMCPServerIconDimension   = 256
	maxMCPServerIconPixels      = 16 * 1024 * 1024
)

var allowedMCPServerIconTypes = map[string]bool{
	"image/gif":                true,
	"image/jpeg":               true,
	"image/png":                true,
	"image/vnd.microsoft.icon": true,
	"image/webp":               true,
	"image/x-icon":             true,
}

func normalizeMCPServerIcon(data []byte, mimeType string) ([]byte, string, error) {
	if mimeType == "image/vnd.microsoft.icon" || mimeType == "image/x-icon" {
		if len(data) <= maxMCPServerIconStoredBytes {
			return data, mimeType, nil
		}
		source, err := decodeMCPServerICO(data)
		if err != nil {
			return nil, "", fmt.Errorf("MCP ICO icon could not be optimized; use a valid PNG, JPEG, GIF, WebP, or ICO image")
		}
		optimized, err := encodeMCPServerIcon(source)
		if err != nil {
			return nil, "", err
		}
		return optimized, "image/png", nil
	}

	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, "", fmt.Errorf("MCP icon could not be decoded; use a valid PNG, JPEG, GIF, WebP, or ICO image")
	}
	if config.Width <= 0 || config.Height <= 0 {
		return nil, "", fmt.Errorf("MCP icon has invalid dimensions")
	}
	if config.Width > maxMCPServerIconPixels/config.Height {
		return nil, "", fmt.Errorf("MCP icon dimensions are too large")
	}

	if len(data) <= maxMCPServerIconStoredBytes &&
		config.Width <= maxMCPServerIconDimension &&
		config.Height <= maxMCPServerIconDimension {
		return data, mimeType, nil
	}

	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", fmt.Errorf("MCP icon could not be optimized; use a valid PNG, JPEG, GIF, WebP, or ICO image")
	}
	optimized, err := encodeMCPServerIcon(source)
	if err != nil {
		return nil, "", err
	}
	return optimized, "image/png", nil
}

func decodeMCPServerICO(data []byte) (image.Image, error) {
	if len(data) < 6 || binary.LittleEndian.Uint16(data[0:2]) != 0 || binary.LittleEndian.Uint16(data[2:4]) != 1 {
		return nil, fmt.Errorf("invalid ICO header")
	}
	entryCount := int(binary.LittleEndian.Uint16(data[4:6]))
	if entryCount == 0 || entryCount > 128 || len(data) < 6+entryCount*16 {
		return nil, fmt.Errorf("invalid ICO entries")
	}

	type icoEntry struct {
		width    int
		height   int
		bitDepth int
		size     uint32
		offset   uint32
	}
	entries := make([]icoEntry, 0, entryCount)
	for index := 0; index < entryCount; index++ {
		entry := data[6+index*16 : 6+(index+1)*16]
		width := int(entry[0])
		height := int(entry[1])
		if width == 0 {
			width = 256
		}
		if height == 0 {
			height = 256
		}
		entries = append(entries, icoEntry{
			width:    width,
			height:   height,
			bitDepth: int(binary.LittleEndian.Uint16(entry[6:8])),
			size:     binary.LittleEndian.Uint32(entry[8:12]),
			offset:   binary.LittleEndian.Uint32(entry[12:16]),
		})
	}

	for candidate := 0; candidate < len(entries); candidate++ {
		bestIndex := candidate
		for index := candidate + 1; index < len(entries); index++ {
			best := entries[bestIndex]
			current := entries[index]
			bestScore := best.width * best.height * max(1, best.bitDepth)
			currentScore := current.width * current.height * max(1, current.bitDepth)
			if currentScore > bestScore {
				bestIndex = index
			}
		}
		entries[candidate], entries[bestIndex] = entries[bestIndex], entries[candidate]
	}

	for _, entry := range entries {
		end := uint64(entry.offset) + uint64(entry.size)
		if entry.size == 0 || uint64(entry.offset) >= uint64(len(data)) || end > uint64(len(data)) {
			continue
		}
		payload := data[entry.offset:end]
		if len(payload) >= 8 && bytes.Equal(payload[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
			config, _, err := image.DecodeConfig(bytes.NewReader(payload))
			if err != nil || !validMCPServerIconDimensions(config.Width, config.Height) {
				continue
			}
			decoded, _, err := image.Decode(bytes.NewReader(payload))
			if err == nil {
				return decoded, nil
			}
			continue
		}

		decoded, err := decodeMCPServerICODIB(payload)
		if err == nil {
			return decoded, nil
		}
	}
	return nil, fmt.Errorf("ICO contains no supported image")
}

func decodeMCPServerICODIB(data []byte) (image.Image, error) {
	if len(data) < 40 {
		return nil, fmt.Errorf("invalid ICO bitmap")
	}
	headerSize := int(binary.LittleEndian.Uint32(data[0:4]))
	if headerSize < 40 || headerSize > len(data) {
		return nil, fmt.Errorf("invalid ICO bitmap header")
	}
	width := int64(int32(binary.LittleEndian.Uint32(data[4:8])))
	rawHeight := int64(int32(binary.LittleEndian.Uint32(data[8:12])))
	if width <= 0 || rawHeight == 0 {
		return nil, fmt.Errorf("invalid ICO bitmap dimensions")
	}
	height := rawHeight
	if height < 0 {
		height = -height
	}
	if height%2 != 0 {
		return nil, fmt.Errorf("invalid ICO bitmap height")
	}
	height /= 2
	if !validMCPServerIconDimensions(int(width), int(height)) {
		return nil, fmt.Errorf("ICO bitmap dimensions are too large")
	}

	bitDepth := int64(binary.LittleEndian.Uint16(data[14:16]))
	if bitDepth != 1 && bitDepth != 2 && bitDepth != 4 && bitDepth != 8 && bitDepth != 24 && bitDepth != 32 {
		return nil, fmt.Errorf("unsupported ICO bitmap depth")
	}
	if binary.LittleEndian.Uint32(data[16:20]) != 0 {
		return nil, fmt.Errorf("compressed ICO bitmaps are not supported")
	}

	paletteSize := int64(0)
	if bitDepth <= 8 {
		colors := int64(binary.LittleEndian.Uint32(data[32:36]))
		if colors == 0 {
			colors = 1 << bitDepth
		}
		paletteSize = colors * 4
	}
	rowSize := ((width*bitDepth + 31) / 32) * 4
	pixelOffset := int64(headerSize) + paletteSize
	pixelBytes := rowSize * height
	if pixelOffset < 0 || pixelBytes < 0 || pixelOffset+pixelBytes > int64(len(data)) {
		return nil, fmt.Errorf("truncated ICO bitmap")
	}

	dibSize := int(pixelOffset + pixelBytes)
	dib := make([]byte, dibSize)
	copy(dib, data[:dibSize])
	binary.LittleEndian.PutUint32(dib[8:12], uint32(height))

	bmpOffset := 14 + int(pixelOffset)
	bmpSize := bmpOffset + int(pixelBytes)
	bmpData := make([]byte, bmpSize)
	bmpData[0] = 'B'
	bmpData[1] = 'M'
	binary.LittleEndian.PutUint32(bmpData[2:6], uint32(bmpSize))
	binary.LittleEndian.PutUint32(bmpData[10:14], uint32(bmpOffset))
	copy(bmpData[14:], dib)
	return bmp.Decode(bytes.NewReader(bmpData))
}

func validMCPServerIconDimensions(width, height int) bool {
	return width > 0 && height > 0 && width <= maxMCPServerIconPixels/height
}

func encodeMCPServerIcon(source image.Image) ([]byte, error) {
	width := source.Bounds().Dx()
	height := source.Bounds().Dy()
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("MCP icon has invalid dimensions")
	}

	scale := math.Min(
		1,
		math.Min(
			float64(maxMCPServerIconDimension)/float64(width),
			float64(maxMCPServerIconDimension)/float64(height),
		),
	)
	width = max(1, int(math.Round(float64(width)*scale)))
	height = max(1, int(math.Round(float64(height)*scale)))

	for {
		resized := image.NewRGBA(image.Rect(0, 0, width, height))
		draw.CatmullRom.Scale(resized, resized.Bounds(), source, source.Bounds(), draw.Over, nil)

		var output bytes.Buffer
		encoder := png.Encoder{CompressionLevel: png.BestCompression}
		if err := encoder.Encode(&output, resized); err != nil {
			return nil, fmt.Errorf("MCP icon could not be encoded: %w", err)
		}
		if output.Len() <= maxMCPServerIconStoredBytes {
			return output.Bytes(), nil
		}
		if width <= 32 && height <= 32 {
			return nil, fmt.Errorf("MCP icon could not be compressed below 512 KB")
		}

		width = max(1, int(math.Floor(float64(width)*0.8)))
		height = max(1, int(math.Floor(float64(height)*0.8)))
	}
}

func (a *App) uploadPlatformMCPServerIcon(c *gin.Context) {
	markPlatformCatalogRoute(c)
	a.uploadMCPServerIcon(c)
}

func (a *App) deletePlatformMCPServerIcon(c *gin.Context) {
	markPlatformCatalogRoute(c)
	a.deleteMCPServerIcon(c)
}

func (a *App) uploadMCPServerIcon(c *gin.Context) {
	serverID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid MCP server id"))
		return
	}
	if err := a.authorizeMCPServerManage(c, serverID.String()); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	fileHeader, err := c.FormFile("icon")
	if err != nil || fileHeader.Size <= 0 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("an icon file is required"))
		return
	}
	if fileHeader.Size > maxMCPServerIconUploadBytes {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("MCP icons are limited to 2 MB"))
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxMCPServerIconUploadBytes+1))
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if len(data) == 0 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("an icon file is required"))
		return
	}
	if len(data) > maxMCPServerIconUploadBytes {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("MCP icons are limited to 2 MB"))
		return
	}
	mimeType := mimetype.Detect(data).String()
	if !allowedMCPServerIconTypes[mimeType] {
		writeError(c, http.StatusUnsupportedMediaType, fmt.Errorf("use a PNG, JPEG, GIF, WebP, or ICO image"))
		return
	}
	normalizedData, normalizedMimeType, err := normalizeMCPServerIcon(data, mimeType)
	if err != nil {
		writeError(c, http.StatusUnprocessableEntity, err)
		return
	}
	_, err = a.DB.ExecContext(c, `INSERT INTO mcp_server_icons (server_id, mime_type, image_data, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (server_id) DO UPDATE SET mime_type = EXCLUDED.mime_type, image_data = EXCLUDED.image_data, updated_at = now()`, serverID, normalizedMimeType, normalizedData)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE mcp_servers SET icon_url = NULL, updated_at = now() WHERE id = $1`, serverID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := a.getMCPServer(c, serverID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (a *App) deleteMCPServerIcon(c *gin.Context) {
	serverID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid MCP server id"))
		return
	}
	if err := a.authorizeMCPServerManage(c, serverID.String()); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM mcp_server_icons WHERE server_id = $1`, serverID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE mcp_servers SET icon_url = NULL, updated_at = now() WHERE id = $1`, serverID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := a.getMCPServer(c, serverID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (a *App) serveMCPServerIcon(c *gin.Context) {
	serverID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid MCP server id"))
		return
	}
	if err := a.authorizeMCPServerIcon(c, serverID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var mimeType string
	var data []byte
	err = a.DB.QueryRowContext(c, `SELECT mime_type, image_data FROM mcp_server_icons WHERE server_id = $1`, serverID).Scan(&mimeType, &data)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("MCP server icon not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Header("Cache-Control", "private, max-age=3600")
	c.Data(http.StatusOK, mimeType, data)
}

func (a *App) authorizeMCPServerIcon(c *gin.Context, serverID uuid.UUID) error {
	principal, ok := middleware.GetPrincipal(c)
	if !ok {
		return fmt.Errorf("authentication required")
	}
	var scopeType string
	var scopeID sql.NullString
	if err := a.DB.QueryRowContext(c, `SELECT scope_type, scope_id FROM mcp_servers WHERE id = $1`, serverID).Scan(&scopeType, &scopeID); err != nil {
		return fmt.Errorf("MCP server not found")
	}
	if principal.PlatformAdmin || scopeType == "global" {
		return nil
	}
	parsedScopeID := parseMCPScopeID(scopeID)
	if parsedScopeID == nil {
		return fmt.Errorf("MCP server scope is invalid")
	}
	if scopeType == "user" {
		if *parsedScopeID == principal.UserID {
			return nil
		}
		return fmt.Errorf("MCP server belongs to another scope")
	}
	if scopeType != "organization" {
		return fmt.Errorf("MCP server scope is invalid")
	}
	var member bool
	if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2)`, *parsedScopeID, principal.UserID).Scan(&member); err != nil {
		return err
	}
	if !member {
		return fmt.Errorf("MCP server belongs to another scope")
	}
	return nil
}

func normalizeMCPIconURL(raw *string) (string, error) {
	if raw == nil {
		return "", nil
	}
	value := strings.TrimSpace(*raw)
	if value == "" {
		return "", nil
	}
	if len(value) > 2048 {
		return "", fmt.Errorf("icon URL must be 2048 characters or fewer")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return "", fmt.Errorf("icon URL must be an absolute HTTP or HTTPS URL")
	}
	return parsed.String(), nil
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
	if err := a.DB.QueryRowContext(ctx, `SELECT id, endpoint_url, auth_type, encrypted_credential, oauth_refresh_credential, COALESCE(oauth_token_url, ''), COALESCE(oauth_client_id, ''), oauth_expires_at, allowed_tools, trusted_read_only, COALESCE(protocol_version, '') FROM mcp_servers WHERE id = $1 AND enabled = TRUE`, id).Scan(&server.ID, &server.EndpointURL, &server.AuthType, &credential, &refreshCredential, &server.OAuthTokenURL, &server.OAuthClientID, &expiresAt, &allowed, &server.TrustedReadOnly, &server.ProtocolVersion); err != nil {
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
	// Do not replace a known-good tool snapshot with an empty response. A
	// transient disconnect or a server that is still starting can legitimately
	// make tools/list return no tools; marking that response fresh would make
	// every chat turn believe the server has no tools until the cache expires.
	// Keep the old rows as a stale fallback and force the next discovery.
	if len(tools) == 0 {
		_, err := a.DB.ExecContext(ctx, `UPDATE mcp_servers SET tools_discovered_at = NULL WHERE id = $1`, serverID)
		return err
	}
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `DELETE FROM mcp_server_tools WHERE server_id = $1`, serverID); err != nil {
		return err
	}
	for _, tool := range tools {
		_, err := transaction.ExecContext(ctx, `INSERT INTO mcp_server_tools (server_id, name, description, input_schema, annotations, metadata) VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6) ON CONFLICT (server_id, name) DO UPDATE SET description = EXCLUDED.description, input_schema = EXCLUDED.input_schema, annotations = EXCLUDED.annotations, metadata = EXCLUDED.metadata, discovered_at = now()`, serverID, tool.Name, tool.Description, jsonRaw(tool.InputSchema), jsonRaw(tool.Annotations), jsonRaw(tool.Meta))
		if err != nil {
			return err
		}
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE mcp_servers SET tools_discovered_at = now(), updated_at = now() WHERE id = $1`, serverID); err != nil {
		return err
	}
	return transaction.Commit()
}

func (a *App) refreshMCPTools(ctx context.Context, server mcp.Server, serverID uuid.UUID) ([]mcp.Tool, error) {
	// A forced discovery is also a connection reset. This is the same recovery
	// operation exposed by the MCP configuration screen, but it is now safe to
	// perform automatically when a chat detects stale bindings.
	mcp.Invalidate(server.ID)
	tools, err := server.ListTools(ctx)
	if err != nil {
		return nil, err
	}
	if err := a.cacheMCPTools(ctx, serverID, tools); err != nil {
		return nil, fmt.Errorf("MCP tools were discovered but could not be cached: %w", err)
	}
	return tools, nil
}

func (a *App) cachedMCPTools(ctx context.Context, serverID uuid.UUID) ([]mcp.Tool, bool, error) {
	var cached bool
	if err := a.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM mcp_servers WHERE id = $1 AND tools_discovered_at > now() - interval '10 minutes')`, serverID).Scan(&cached); err != nil {
		return nil, false, err
	}
	// Always load the last known tool snapshot. When the marker is stale, the
	// caller refreshes it, but these rows keep the chat usable if discovery is
	// temporarily unavailable. An empty snapshot remains a cache miss.
	rows, err := a.DB.QueryContext(ctx, `SELECT name, COALESCE(description, ''), input_schema, annotations, metadata FROM mcp_server_tools WHERE server_id = $1 ORDER BY name`, serverID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	tools := make([]mcp.Tool, 0)
	for rows.Next() {
		var tool mcp.Tool
		var inputSchema, annotations, metadata []byte
		if err := rows.Scan(&tool.Name, &tool.Description, &inputSchema, &annotations, &metadata); err != nil {
			return nil, false, err
		}
		tool.InputSchema = json.RawMessage(inputSchema)
		if len(annotations) > 0 {
			if err := json.Unmarshal(annotations, &tool.Annotations); err != nil {
				return nil, false, err
			}
		}
		if len(metadata) > 0 && string(metadata) != "null" {
			tool.Meta = json.RawMessage(metadata)
		}
		tools = append(tools, tool)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return tools, cached && len(tools) > 0, nil
}

func nullableJSON(value []string) any {
	if value == nil {
		return nil
	}
	return jsonRaw(value)
}
