package server

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/auth"
	"justai-backend/mcp"
	"justai-backend/middleware"
)

func (a *App) mcpOAuthStart(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid MCP server id"))
		return
	}
	if err := a.authorizeMCPServerManage(c, id.String()); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	var endpointURL, clientID, scopes, authType string
	var authorizationURL, tokenURL sql.NullString
	if err := a.DB.QueryRowContext(c, `SELECT endpoint_url, oauth_authorization_url, oauth_token_url, oauth_client_id, COALESCE(oauth_scopes, ''), auth_type FROM mcp_servers WHERE id = $1 AND enabled = TRUE`, id).Scan(&endpointURL, &authorizationURL, &tokenURL, &clientID, &scopes, &authType); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("MCP server not found"))
		return
	}
	if authType != "oauth" || clientID == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("MCP OAuth requires a client id"))
		return
	}
	if !authorizationURL.Valid || !tokenURL.Valid || authorizationURL.String == "" || tokenURL.String == "" {
		metadata, metadataErr := mcp.DiscoverOAuthMetadata(c, endpointURL, a.Config.AllowPrivate)
		if metadataErr != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("MCP OAuth metadata discovery failed: %w", metadataErr))
			return
		}
		authorizationURL = sql.NullString{String: metadata.AuthorizationEndpoint, Valid: true}
		tokenURL = sql.NullString{String: metadata.TokenEndpoint, Valid: true}
		if strings.TrimSpace(scopes) == "" {
			scopes = strings.Join(metadata.Scopes, " ")
		}
		_, _ = a.DB.ExecContext(c, `UPDATE mcp_servers SET oauth_authorization_url = $2, oauth_token_url = $3, oauth_scopes = NULLIF($4, ''), updated_at = now() WHERE id = $1`, id, authorizationURL.String, tokenURL.String, scopes)
	}
	state, _, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	verifier, _, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	challengeSum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeSum[:])
	expiresAt := time.Now().Add(10 * time.Minute)
	if _, err := a.DB.ExecContext(c, `INSERT INTO mcp_oauth_states (state, server_id, user_id, code_verifier, expires_at) VALUES ($1, $2, $3, $4, $5)`, state, id, principal.UserID, verifier, expiresAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	parsed, err := url.Parse(authorizationURL.String)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	query := parsed.Query()
	query.Set("response_type", "code")
	query.Set("client_id", clientID)
	query.Set("redirect_uri", a.Config.MCPOAuthRedirectURL)
	query.Set("scope", strings.TrimSpace(scopes))
	query.Set("state", state)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	query.Set("resource", endpointURL)
	parsed.RawQuery = query.Encode()
	c.Redirect(http.StatusFound, parsed.String())
}

func (a *App) mcpOAuthCallback(c *gin.Context) {
	principal, ok := middleware.GetPrincipal(c)
	if !ok {
		c.Redirect(http.StatusFound, "/login")
		return
	}
	state := c.Query("state")
	code := c.Query("code")
	if state == "" || code == "" {
		a.redirectOAuthResult(c, "error")
		return
	}
	var serverID uuid.UUID
	var tokenURL, clientID, verifier, resource string
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	defer transaction.Rollback()
	if err := transaction.QueryRowContext(c, `SELECT s.id, s.oauth_token_url, s.oauth_client_id, s.endpoint_url, os.code_verifier FROM mcp_oauth_states os JOIN mcp_servers s ON s.id = os.server_id WHERE os.state = $1 AND os.user_id = $2 AND os.expires_at > now() FOR UPDATE`, state, principal.UserID).Scan(&serverID, &tokenURL, &clientID, &resource, &verifier); err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	if _, err := transaction.ExecContext(c, `DELETE FROM mcp_oauth_states WHERE state = $1`, state); err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	if err := transaction.Commit(); err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", a.Config.MCPOAuthRedirectURL)
	form.Set("client_id", clientID)
	form.Set("code_verifier", verifier)
	form.Set("resource", resource)
	client, err := mcp.SafeHTTPClient(tokenURL, a.Config.AllowPrivate)
	if err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	request, err := http.NewRequestWithContext(c, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := client.Do(request)
	if err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		a.redirectOAuthResult(c, "error")
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	var tokenResponse struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tokenResponse); err != nil || tokenResponse.AccessToken == "" {
		a.redirectOAuthResult(c, "error")
		return
	}
	credential, err := a.Secrets.Encrypt(tokenResponse.AccessToken)
	if err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	var refreshCredential any
	if tokenResponse.RefreshToken != "" {
		refreshCredential, err = a.Secrets.Encrypt(tokenResponse.RefreshToken)
		if err != nil {
			a.redirectOAuthResult(c, "error")
			return
		}
	}
	var expiresAt any
	if tokenResponse.ExpiresIn > 0 {
		expiresAt = time.Now().Add(time.Duration(tokenResponse.ExpiresIn) * time.Second)
	}
	if _, err := a.DB.ExecContext(c, `UPDATE mcp_servers SET encrypted_credential = $2, oauth_refresh_credential = COALESCE($3, oauth_refresh_credential), oauth_expires_at = $4, tools_discovered_at = NULL, last_tested_at = NULL, last_error = NULL, protocol_version = NULL, updated_at = now() WHERE id = $1`, serverID, credential, refreshCredential, expiresAt); err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM mcp_server_tools WHERE server_id = $1`, serverID); err != nil {
		a.redirectOAuthResult(c, "error")
		return
	}
	mcp.Invalidate(serverID.String())
	a.redirectOAuthResult(c, "connected")
}

func (a *App) redirectOAuthResult(c *gin.Context, result string) {
	base := "/"
	if len(a.Config.FrontendOrigins) > 0 && a.Config.FrontendOrigins[0] != "*" {
		base = a.Config.FrontendOrigins[0]
	}
	parsed, err := url.Parse(base)
	if err != nil {
		c.Redirect(http.StatusFound, "/?view=mcp&oauth="+url.QueryEscape(result))
		return
	}
	query := parsed.Query()
	query.Set("view", "mcp")
	query.Set("oauth", result)
	parsed.RawQuery = query.Encode()
	c.Redirect(http.StatusFound, parsed.String())
}
