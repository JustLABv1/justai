package server

import (
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

type agentConnectionRequest struct {
	ScopeType             string          `json:"scopeType"`
	ScopeID               *string         `json:"scopeId"`
	Name                  string          `json:"name"`
	EndpointURL           string          `json:"endpointUrl"`
	AuthType              string          `json:"authType"`
	Credential            string          `json:"credential"`
	Username              string          `json:"username"`
	Password              string          `json:"password"`
	AccessToken           string          `json:"accessToken"`
	RefreshToken          string          `json:"refreshToken"`
	ClientSecret          string          `json:"clientSecret"`
	Certificate           string          `json:"certificate"`
	PrivateKey            string          `json:"privateKey"`
	OAuthAuthorizationURL string          `json:"oauthAuthorizationUrl"`
	OAuthTokenURL         string          `json:"oauthTokenUrl"`
	OAuthIssuerURL        string          `json:"oauthIssuerUrl"`
	OAuthClientID         string          `json:"oauthClientId"`
	OAuthScopes           string          `json:"oauthScopes"`
	AgentCard             json.RawMessage `json:"agentCard"`
	Enabled               *bool           `json:"enabled"`
	TrustedReadOnly       *bool           `json:"trustedReadOnly"`
}

type agentDiscoverRequest struct {
	EndpointURL string `json:"endpointUrl"`
}

type agentRequest struct {
	Kind               string   `json:"kind"`
	Name               string   `json:"name"`
	Description        string   `json:"description"`
	Icon               string   `json:"icon"`
	Visibility         string   `json:"visibility"`
	Instructions       string   `json:"instructions"`
	EndpointID         *string  `json:"endpointId"`
	Model              string   `json:"model"`
	UseMemory          *bool    `json:"useMemory"`
	DeepContext        *bool    `json:"deepContext"`
	ConnectionID       *string  `json:"connectionId"`
	DelegationAgentIDs []string `json:"delegationAgentIds"`
}

func (a *App) listAgentConnections(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT id, scope_type, scope_id, name, protocol, endpoint_url, auth_type,
		       encrypted_credential IS NOT NULL OR encrypted_client_certificate IS NOT NULL,
		       agent_card, enabled, trusted_read_only, last_tested_at, last_error,
		       created_at, updated_at
		FROM agent_connections
		WHERE organization_id = $1 AND (scope_type = 'organization' OR (scope_type = 'user' AND scope_id = $2))
		ORDER BY updated_at DESC, name`, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	items := []models.AgentConnection{}
	for rows.Next() {
		item, scanErr := scanAgentConnection(rows, organizationID)
		if scanErr != nil {
			writeError(c, http.StatusInternalServerError, scanErr)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"connections": items})
}

func scanAgentConnection(scanner interface{ Scan(...any) error }, organizationID uuid.UUID) (models.AgentConnection, error) {
	var item models.AgentConnection
	var scopeID string
	var card []byte
	var lastTested sql.NullTime
	if err := scanner.Scan(&item.ID, &item.ScopeType, &scopeID, &item.Name, &item.Protocol, &item.EndpointURL, &item.AuthType, &item.CredentialConfigured, &card, &item.Enabled, &item.TrustedReadOnly, &lastTested, &item.LastError, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	item.OrganizationID = organizationID
	item.ScopeID = uuid.Nil
	if parsed, err := uuid.Parse(scopeID); err == nil {
		item.ScopeID = parsed
	}
	item.AgentCard = json.RawMessage(card)
	if lastTested.Valid {
		item.LastTestedAt = &lastTested.Time
	}
	return item, nil
}

func (a *App) createAgentConnection(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request agentConnectionRequest
	if !decodeJSON(c, &request) {
		return
	}
	scopeType, scopeID, err := a.authorizeAgentScope(c, principal, organizationID, request.ScopeType, request.ScopeID)
	if err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	if err := validateAgentConnectionRequest(a, request, true); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if strings.TrimSpace(request.AuthType) == "" {
		request.AuthType = "none"
	}
	secret := agentConnectionSecret{APIKey: strings.TrimSpace(request.Credential), Username: strings.TrimSpace(request.Username), Password: request.Password, AccessToken: strings.TrimSpace(request.AccessToken), RefreshToken: strings.TrimSpace(request.RefreshToken), ClientSecret: request.ClientSecret}
	var encryptedCredential, encryptedRefresh, encryptedCertificate, encryptedKey []byte
	if secret != (agentConnectionSecret{}) {
		credentialSecret := secret
		credentialSecret.RefreshToken = ""
		encryptedCredential, err = encryptAgentSecret(a.Secrets, credentialSecret)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if secret.RefreshToken != "" {
		encryptedRefresh, err = a.Secrets.Encrypt(secret.RefreshToken)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if strings.TrimSpace(request.Certificate) != "" {
		encryptedCertificate, err = a.Secrets.Encrypt(request.Certificate)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if strings.TrimSpace(request.PrivateKey) != "" {
		encryptedKey, err = a.Secrets.Encrypt(request.PrivateKey)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	card := request.AgentCard
	if len(card) == 0 {
		card = json.RawMessage(`{}`)
	}
	if len(card) > 0 && string(card) != "{}" {
		sanitized, _, sanitizeErr := sanitizeA2AAgentCard(card)
		if sanitizeErr != nil {
			writeError(c, http.StatusBadRequest, sanitizeErr)
			return
		}
		card = sanitized
	} else if !json.Valid(card) {
		writeError(c, http.StatusBadRequest, fmt.Errorf("agentCard must be valid JSON"))
		return
	}
	var connectionID uuid.UUID
	err = a.DB.QueryRowContext(c, `
		INSERT INTO agent_connections
			(organization_id,scope_type,scope_id,name,endpoint_url,auth_type,
			 encrypted_credential,encrypted_refresh_credential,encrypted_client_certificate,
			 encrypted_client_key,oauth_authorization_url,oauth_token_url,oauth_issuer_url,
			 oauth_client_id,oauth_scopes,agent_card,enabled,trusted_read_only,created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
		RETURNING id`, organizationID, scopeType, scopeID, strings.TrimSpace(request.Name), strings.TrimSpace(request.EndpointURL), request.AuthType, nullableBytes(encryptedCredential), nullableBytes(encryptedRefresh), nullableBytes(encryptedCertificate), nullableBytes(encryptedKey), nullableString(request.OAuthAuthorizationURL), nullableString(request.OAuthTokenURL), nullableString(request.OAuthIssuerURL), nullableString(request.OAuthClientID), nullableString(request.OAuthScopes), card, boolValue(request.Enabled, true), boolValue(request.TrustedReadOnly, false), principal.UserID).Scan(&connectionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	// Discovery is helpful but not a prerequisite for saving a connection. This
	// lets users finish an OAuth/mTLS wizard before the remote card is reachable.
	if connection, loadErr := a.loadRemoteAgentConnection(c, connectionID, principal.UserID, organizationID); loadErr == nil {
		if discovered, _, discoverErr := a.discoverA2AAgentCardForConnection(c, connection); discoverErr == nil {
			_, _ = a.DB.ExecContext(c, `UPDATE agent_connections SET agent_card = $2, discovered_at = now(), last_error = '', updated_at = now() WHERE id = $1`, connectionID, discovered)
		} else {
			_, _ = a.DB.ExecContext(c, `UPDATE agent_connections SET last_error = $2 WHERE id = $1`, connectionID, redactAgentError(discoverErr.Error()))
		}
	}
	item, err := a.getAgentConnection(c, connectionID, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.AgentWorker.auditAgentEvent(c, principal.UserID, organizationID, "agent.connection.created", "agent_connection", connectionID, map[string]any{"authType": request.AuthType, "scopeType": scopeType})
	c.JSON(http.StatusCreated, gin.H{"connection": item})
}

func (a *App) updateAgentConnection(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid agent connection id"))
		return
	}
	if err := a.authorizeAgentConnectionManage(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var request agentConnectionRequest
	if !decodeJSON(c, &request) {
		return
	}
	var current remoteAgentConnection
	if err := a.DB.QueryRowContext(c, `SELECT id,endpoint_url,auth_type,encrypted_credential,encrypted_refresh_credential,encrypted_client_certificate,encrypted_client_key,COALESCE(oauth_token_url,''),COALESCE(oauth_client_id,''),COALESCE(oauth_scopes,''),enabled,trusted_read_only,agent_card FROM agent_connections WHERE id=$1 AND organization_id=$2`, id, organizationID).Scan(&current.ID, &current.EndpointURL, &current.AuthType, &current.EncryptedCredential, &current.EncryptedRefresh, &current.EncryptedCertificate, &current.EncryptedPrivateKey, &current.OAuthTokenURL, &current.OAuthClientID, &current.OAuthScopes, &current.Enabled, &current.TrustedReadOnly, &current.AgentCard); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent connection not found"))
		return
	}
	endpoint := firstNonEmptyString(strings.TrimSpace(request.EndpointURL), current.EndpointURL)
	authType := firstNonEmptyString(strings.TrimSpace(request.AuthType), current.AuthType)
	name := strings.TrimSpace(request.Name)
	if name == "" {
		_ = a.DB.QueryRowContext(c, `SELECT name FROM agent_connections WHERE id=$1`, id).Scan(&name)
	}
	if err := validateAgentConnectionRequest(a, agentConnectionRequest{EndpointURL: endpoint, AuthType: authType, OAuthClientID: firstNonEmptyString(request.OAuthClientID, current.OAuthClientID)}, false); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	setCredential := request.Credential != "" || request.Username != "" || request.Password != "" || request.AccessToken != "" || request.ClientSecret != "" || request.AuthType == "none"
	var encryptedCredential []byte
	if setCredential {
		secret := agentConnectionSecret{APIKey: strings.TrimSpace(request.Credential), Username: strings.TrimSpace(request.Username), Password: request.Password, AccessToken: strings.TrimSpace(request.AccessToken), RefreshToken: strings.TrimSpace(request.RefreshToken), ClientSecret: request.ClientSecret}
		credentialSecret := secret
		credentialSecret.RefreshToken = ""
		encryptedCredential, err = encryptAgentSecret(a.Secrets, credentialSecret)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	var encryptedCertificate, encryptedKey []byte
	if request.Certificate != "" {
		encryptedCertificate, err = a.Secrets.Encrypt(request.Certificate)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if request.PrivateKey != "" {
		encryptedKey, err = a.Secrets.Encrypt(request.PrivateKey)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	card := request.AgentCard
	if len(card) == 0 {
		card = nil
	} else {
		sanitized, _, sanitizeErr := sanitizeA2AAgentCard(card)
		if sanitizeErr != nil {
			writeError(c, http.StatusBadRequest, sanitizeErr)
			return
		}
		card = sanitized
	}
	args := []any{id, name, endpoint, authType, request.OAuthAuthorizationURL, request.OAuthTokenURL, request.OAuthIssuerURL, request.OAuthClientID, request.OAuthScopes, card, encryptedCredential, encryptedCertificate, encryptedKey, nil, nil, organizationID}
	if request.Enabled != nil {
		args[13] = *request.Enabled
	}
	if request.TrustedReadOnly != nil {
		args[14] = *request.TrustedReadOnly
	}
	// Keep an explicit, fixed query for the common update path. It avoids
	// interpolating user values while allowing omitted fields to remain intact.
	_, err = a.DB.ExecContext(c, `
		UPDATE agent_connections SET
			name = COALESCE(NULLIF($2,''), name), endpoint_url = COALESCE(NULLIF($3,''), endpoint_url),
			auth_type = COALESCE(NULLIF($4,''), auth_type),
			oauth_authorization_url = COALESCE(NULLIF($5,''), oauth_authorization_url),
			oauth_token_url = COALESCE(NULLIF($6,''), oauth_token_url), oauth_issuer_url = COALESCE(NULLIF($7,''), oauth_issuer_url),
			oauth_client_id = COALESCE(NULLIF($8,''), oauth_client_id), oauth_scopes = COALESCE(NULLIF($9,''), oauth_scopes),
			agent_card = COALESCE($10, agent_card),
			encrypted_credential = CASE WHEN $11::bytea IS NULL THEN encrypted_credential ELSE $11 END,
			encrypted_client_certificate = CASE WHEN $12::bytea IS NULL THEN encrypted_client_certificate ELSE $12 END,
			encrypted_client_key = CASE WHEN $13::bytea IS NULL THEN encrypted_client_key ELSE $13 END,
			enabled = COALESCE($14, enabled), trusted_read_only = COALESCE($15, trusted_read_only),
			last_tested_at = NULL, last_error = '', updated_at = now()
		WHERE id=$1 AND organization_id=$16`, args...)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := a.getAgentConnection(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.AgentWorker.auditAgentEvent(c, principal.UserID, organizationID, "agent.connection.updated", "agent_connection", id, map[string]any{"authType": authType})
	c.JSON(http.StatusOK, gin.H{"connection": item})
}

func (a *App) deleteAgentConnection(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid agent connection id"))
		return
	}
	if err := a.authorizeAgentConnectionManage(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM agent_connections WHERE id=$1 AND organization_id=$2`, id, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent connection not found"))
		return
	}
	a.AgentWorker.auditAgentEvent(c, principal.UserID, organizationID, "agent.connection.deleted", "agent_connection", id, map[string]any{})
	c.Status(http.StatusNoContent)
}

func (a *App) discoverAgentConnection(c *gin.Context) {
	var request agentDiscoverRequest
	if !decodeJSON(c, &request) {
		return
	}
	if strings.TrimSpace(request.EndpointURL) == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("endpointUrl is required"))
		return
	}
	card, parsed, err := discoverA2AAgentCard(c, request.EndpointURL, a.Config.AllowPrivate)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"agentCard": card, "name": parsed.Name, "description": parsed.Description, "capabilities": parsed.Capabilities, "skills": parsed.Skills})
}

func (a *App) testAgentConnection(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid agent connection id"))
		return
	}
	if err := a.authorizeAgentConnectionManage(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	connection, err := a.loadRemoteAgentConnection(c, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent connection not found"))
		return
	}
	card, parsed, discoverErr := a.discoverA2AAgentCardForConnection(c, connection)
	status := http.StatusOK
	if discoverErr != nil {
		status = http.StatusBadGateway
		_, _ = a.DB.ExecContext(c, `UPDATE agent_connections SET last_tested_at = now(), last_error = $2, updated_at = now() WHERE id = $1`, id, redactAgentError(discoverErr.Error()))
	} else {
		_, _ = a.DB.ExecContext(c, `UPDATE agent_connections SET agent_card = $2, discovered_at = now(), last_tested_at = now(), last_error = '', updated_at = now() WHERE id = $1`, id, card)
	}
	response := gin.H{"ok": discoverErr == nil, "name": parsed.Name, "agentCard": card}
	if discoverErr != nil {
		response["error"] = redactAgentError(discoverErr.Error())
	}
	a.AgentWorker.auditAgentEvent(c, principal.UserID, organizationID, "agent.connection.tested", "agent_connection", id, map[string]any{"ok": discoverErr == nil})
	c.JSON(status, response)
}

type agentOAuthState struct {
	ConnectionID   uuid.UUID
	UserID         uuid.UUID
	OrganizationID uuid.UUID
	ExpiresAt      time.Time
	RedirectURI    string
}

func (a *App) startAgentConnectionOAuth(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid agent connection id"))
		return
	}
	if err := a.authorizeAgentConnectionManage(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var authType, authorizationURL, clientID, scopes string
	if err := a.DB.QueryRowContext(c, `SELECT auth_type,COALESCE(oauth_authorization_url,''),COALESCE(oauth_client_id,''),COALESCE(oauth_scopes,'') FROM agent_connections WHERE id=$1 AND organization_id=$2 AND (scope_type='organization' OR (scope_type='user' AND scope_id=$3))`, id, organizationID, principal.UserID).Scan(&authType, &authorizationURL, &clientID, &scopes); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent connection not found"))
		return
	}
	if authType != "oauth2" && authType != "oidc" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("connection does not use OAuth2/OIDC"))
		return
	}
	if authorizationURL == "" || clientID == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("OAuth authorization URL and client id are required"))
		return
	}
	redirectURI := a.Config.MCPOAuthRedirectURL
	if redirectURI == "" {
		redirectURI = strings.TrimRight(requestOrigin(c), "/") + "/api/v1/agent-connections/" + id.String() + "/oauth/callback"
	}
	parsed, err := url.Parse(authorizationURL)
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OAuth authorization URL"))
		return
	}
	if err := provider.ValidateRequestURL(parsed.String(), a.Config.AllowPrivate); err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OAuth authorization URL: %w", err))
		return
	}
	state := uuid.NewString()
	if a.AgentWorker != nil {
		a.AgentWorker.oauth.Store(state, agentOAuthState{ConnectionID: id, UserID: principal.UserID, OrganizationID: organizationID, ExpiresAt: time.Now().Add(10 * time.Minute), RedirectURI: redirectURI})
	}
	query := parsed.Query()
	query.Set("response_type", "code")
	query.Set("client_id", clientID)
	query.Set("redirect_uri", redirectURI)
	query.Set("state", state)
	if scopes != "" {
		query.Set("scope", scopes)
	}
	parsed.RawQuery = query.Encode()
	c.JSON(http.StatusOK, gin.H{"authorizationUrl": parsed.String(), "state": state})
}

func (a *App) finishAgentConnectionOAuth(c *gin.Context) {
	state := strings.TrimSpace(c.Query("state"))
	code := strings.TrimSpace(c.Query("code"))
	if state == "" || code == "" || a.AgentWorker == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("OAuth state and code are required"))
		return
	}
	value, ok := a.AgentWorker.oauth.LoadAndDelete(state)
	if !ok {
		writeError(c, http.StatusBadRequest, fmt.Errorf("OAuth state is invalid or expired"))
		return
	}
	oauthState := value.(agentOAuthState)
	if time.Now().After(oauthState.ExpiresAt) {
		writeError(c, http.StatusBadRequest, fmt.Errorf("OAuth state is expired"))
		return
	}
	principal, ok := middleware.GetPrincipal(c)
	if !ok {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("authentication required"))
		return
	}
	if oauthState.UserID != principal.UserID {
		writeError(c, http.StatusForbidden, fmt.Errorf("OAuth state belongs to another user"))
		return
	}
	organizationID := oauthState.OrganizationID
	if organizationID == uuid.Nil {
		// States created before the workspace binding was added are only
		// possible during a live process upgrade. Preserve compatibility for
		// those states while all new states remain bound to their origin.
		var scopeErr error
		_, organizationID, scopeErr = workspaceScope(c)
		if scopeErr != nil {
			writeError(c, http.StatusBadRequest, scopeErr)
			return
		}
	} else if !principal.PlatformAdmin {
		var role string
		if err := a.DB.QueryRowContext(c, `SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2`, organizationID, principal.UserID).Scan(&role); err != nil {
			writeError(c, http.StatusForbidden, fmt.Errorf("OAuth workspace access is no longer available"))
			return
		}
		// authorizeAgentConnectionManage uses the request-scoped role. The
		// callback may not carry the original X-Organization-ID header, so
		// restore the role from the state-bound workspace after membership is
		// verified.
		c.Set(middleware.OrgIDKey, organizationID)
		c.Set(middleware.OrgRoleKey, role)
	} else {
		c.Set(middleware.OrgIDKey, organizationID)
		c.Set(middleware.OrgRoleKey, "owner")
	}
	if err := a.authorizeAgentConnectionManage(c, oauthState.ConnectionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	connection, err := a.loadRemoteAgentConnection(c, oauthState.ConnectionID, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent connection not found"))
		return
	}
	var tokenURL, clientID string
	if err := a.DB.QueryRowContext(c, `SELECT COALESCE(oauth_token_url,''),COALESCE(oauth_client_id,'') FROM agent_connections WHERE id=$1`, connection.ID).Scan(&tokenURL, &clientID); err != nil || tokenURL == "" || clientID == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("OAuth token endpoint is not configured"))
		return
	}
	secret, decryptErr := a.decryptAgentSecret(connection)
	if decryptErr != nil {
		writeError(c, http.StatusInternalServerError, decryptErr)
		return
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {clientID}, "redirect_uri": {oauthState.RedirectURI}}
	if secret.ClientSecret != "" {
		form.Set("client_secret", secret.ClientSecret)
	}
	request, err := http.NewRequestWithContext(c, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client, err := safeOAuthClient(tokenURL, a.Config.AllowPrivate)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	response, err := client.Do(request)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		writeError(c, http.StatusBadGateway, fmt.Errorf("OAuth token exchange returned HTTP %d", response.StatusCode))
		return
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	limited := io.LimitReader(response.Body, 256*1024)
	if err := json.NewDecoder(limited).Decode(&token); err != nil || token.AccessToken == "" {
		writeError(c, http.StatusBadGateway, fmt.Errorf("OAuth token response did not contain an access token"))
		return
	}
	secret.AccessToken, secret.RefreshToken = token.AccessToken, token.RefreshToken
	credentialSecret := secret
	credentialSecret.RefreshToken = ""
	encrypted, err := encryptAgentSecret(a.Secrets, credentialSecret)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var refresh []byte
	if token.RefreshToken != "" {
		refresh, _ = a.Secrets.Encrypt(token.RefreshToken)
	}
	_, err = a.DB.ExecContext(c, `UPDATE agent_connections SET encrypted_credential=$2, encrypted_refresh_credential=$3, last_error='', updated_at=now() WHERE id=$1`, connection.ID, encrypted, nullableBytes(refresh))
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *App) configureAgentConnectionMTLS(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid agent connection id"))
		return
	}
	if err := a.authorizeAgentConnectionManage(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var request struct {
		Certificate string `json:"certificate"`
		PrivateKey  string `json:"privateKey"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if strings.TrimSpace(request.Certificate) == "" || strings.TrimSpace(request.PrivateKey) == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("certificate and privateKey are required"))
		return
	}
	if _, err := tls.X509KeyPair([]byte(request.Certificate), []byte(request.PrivateKey)); err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("certificate and privateKey must form a valid mTLS key pair"))
		return
	}
	certificate, err := a.Secrets.Encrypt(request.Certificate)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	privateKey, err := a.Secrets.Encrypt(request.PrivateKey)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE agent_connections SET auth_type='mtls', encrypted_client_certificate=$2, encrypted_client_key=$3, updated_at=now() WHERE id=$1 AND organization_id=$4`, id, certificate, privateKey, organizationID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.AgentWorker.auditAgentEvent(c, principal.UserID, organizationID, "agent.connection.mtls_configured", "agent_connection", id, map[string]any{})
	c.JSON(http.StatusOK, gin.H{"ok": true, "credentialConfigured": true})
}

func validateAgentConnectionRequest(a *App, request agentConnectionRequest, requireName bool) error {
	if requireName {
		name := strings.TrimSpace(request.Name)
		if name == "" {
			return fmt.Errorf("name is required")
		}
		if len([]rune(name)) > 120 {
			return fmt.Errorf("name must be 120 characters or fewer")
		}
	}
	if strings.TrimSpace(request.EndpointURL) == "" {
		return fmt.Errorf("endpointUrl is required")
	}
	if len([]rune(request.EndpointURL)) > 2048 {
		return fmt.Errorf("endpointUrl must be 2048 characters or fewer")
	}
	if err := providerValidateURL(request.EndpointURL, a.Config.AllowPrivate); err != nil {
		return err
	}
	authType := strings.ToLower(strings.TrimSpace(request.AuthType))
	if authType == "" {
		authType = "none"
	}
	switch authType {
	case "none", "api_key", "http", "oauth2", "oidc", "mtls":
	default:
		return fmt.Errorf("authType must be none, api_key, http, oauth2, oidc, or mtls")
	}
	if authType == "oauth2" || authType == "oidc" {
		if strings.TrimSpace(request.OAuthClientID) == "" && requireName {
			return fmt.Errorf("OAuth2/OIDC requires oauthClientId")
		}
	}
	if authType == "api_key" && requireName && strings.TrimSpace(request.Credential) == "" {
		return fmt.Errorf("api_key authentication requires a credential")
	}
	if authType == "http" && requireName && strings.TrimSpace(request.Credential) == "" && strings.TrimSpace(request.Username) == "" {
		return fmt.Errorf("HTTP authentication requires a credential or username")
	}
	if authType == "mtls" && requireName && (strings.TrimSpace(request.Certificate) == "" || strings.TrimSpace(request.PrivateKey) == "") {
		return fmt.Errorf("mTLS requires certificate and privateKey")
	}
	return nil
}

func providerValidateURL(raw string, allowPrivate bool) error {
	// Keep the A2A URL policy identical to provider endpoints without importing
	// the MCP implementation into the handler layer.
	return provider.ValidateEndpointURL(raw, allowPrivate)
}

func (a *App) authorizeAgentScope(c *gin.Context, principal middleware.Principal, organizationID uuid.UUID, requestedType string, requestedID *string) (string, any, error) {
	scopeType := strings.ToLower(strings.TrimSpace(requestedType))
	if scopeType == "" {
		scopeType = "organization"
	}
	var parsedID *uuid.UUID
	if requestedID != nil && strings.TrimSpace(*requestedID) != "" {
		value, err := uuid.Parse(strings.TrimSpace(*requestedID))
		if err != nil {
			return "", nil, fmt.Errorf("invalid scopeId")
		}
		parsedID = &value
	}
	switch scopeType {
	case "organization":
		if role := middleware.GetOrganizationRole(c); role != "owner" && role != "admin" && !principal.PlatformAdmin {
			return "", nil, fmt.Errorf("organization agent connections require owner or admin access")
		}
		if parsedID != nil && *parsedID != organizationID && !principal.PlatformAdmin {
			return "", nil, fmt.Errorf("organization scope does not match the active organization")
		}
		return scopeType, organizationID, nil
	case "user":
		if parsedID != nil && *parsedID != principal.UserID && !principal.PlatformAdmin {
			return "", nil, fmt.Errorf("personal agent connection belongs to another user")
		}
		return scopeType, principal.UserID, nil
	default:
		return "", nil, fmt.Errorf("scopeType must be organization or user")
	}
}

func (a *App) authorizeAgentConnectionManage(c *gin.Context, id, userID, organizationID uuid.UUID) error {
	var scopeType string
	var scopeID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT scope_type,scope_id FROM agent_connections WHERE id=$1 AND organization_id=$2`, id, organizationID).Scan(&scopeType, &scopeID); err != nil {
		return fmt.Errorf("agent connection not found")
	}
	if scopeType == "user" && scopeID == userID {
		return nil
	}
	role := middleware.GetOrganizationRole(c)
	if role == "owner" || role == "admin" {
		return nil
	}
	return fmt.Errorf("agent connection requires owner access")
}

func (a *App) getAgentConnection(c *gin.Context, id, userID, organizationID uuid.UUID) (models.AgentConnection, error) {
	row := a.DB.QueryRowContext(c, `
		SELECT id,scope_type,scope_id,name,protocol,endpoint_url,auth_type,
		       encrypted_credential IS NOT NULL OR encrypted_client_certificate IS NOT NULL,
		       agent_card,enabled,trusted_read_only,last_tested_at,last_error,created_at,updated_at
		FROM agent_connections WHERE id=$1 AND organization_id=$2 AND (scope_type='organization' OR (scope_type='user' AND scope_id=$3))`, id, organizationID, userID)
	return scanAgentConnection(row, organizationID)
}

func (a *App) listAgents(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT a.id,a.agent_kind,a.name,a.description,a.icon,a.visibility,
		       v.id,v.version,v.instructions,v.endpoint_id,v.model,v.use_memory,v.deep_context,
		       a.connection_id,a.delegation_agent_ids,COALESCE(c.agent_card,'{}'::jsonb),
		       COALESCE(c.agent_card->'capabilities','{}'::jsonb),COALESCE(c.agent_card->'skills','[]'::jsonb),
		       CASE WHEN a.agent_kind='remote' AND (c.enabled IS FALSE OR c.id IS NULL) THEN 'disabled'
		            WHEN a.agent_kind='remote' AND COALESCE(c.last_error,'')<>'' THEN 'degraded' ELSE 'ready' END,
		       COALESCE(c.encrypted_credential IS NOT NULL OR c.encrypted_client_certificate IS NOT NULL,FALSE),
		       a.created_at,a.updated_at
		FROM saved_assistants a
		LEFT JOIN saved_assistant_versions v ON v.assistant_id=a.id AND v.version=a.current_version
		LEFT JOIN agent_connections c ON c.id=a.connection_id
		WHERE a.organization_id=$1 AND a.deleted_at IS NULL AND (a.visibility='workspace' OR a.user_id=$2)
		ORDER BY a.updated_at DESC,a.name`, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	items := []models.Agent{}
	for rows.Next() {
		item, scanErr := scanAgent(rows)
		if scanErr != nil {
			writeError(c, http.StatusInternalServerError, scanErr)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"agents":        items,
		"agentsEnabled": a.platformCapabilityEnabled(c, "agents"),
	})
}

func (a *App) getAgent(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid agent id"))
		return
	}
	item, err := a.AgentWorker.loadAgent(c, id, principal.UserID, organizationID, nil)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent not found"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"agent": item})
}

func (a *App) createAgent(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request agentRequest
	if !decodeJSON(c, &request) {
		return
	}
	item, err := a.createOrUpdateAgent(c, principal, organizationID, uuid.Nil, request, false)
	if err != nil {
		writeError(c, agentErrorStatus(err), err)
		return
	}
	a.AgentWorker.auditAgentEvent(c, principal.UserID, organizationID, "agent.created", "agent", item.ID, map[string]any{"kind": item.Kind})
	c.JSON(http.StatusCreated, gin.H{"agent": item})
}

func (a *App) updateAgent(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid agent id"))
		return
	}
	if err := a.authorizeAgentManage(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var request agentRequest
	if !decodeJSON(c, &request) {
		return
	}
	item, err := a.createOrUpdateAgent(c, principal, organizationID, id, request, true)
	if err != nil {
		writeError(c, agentErrorStatus(err), err)
		return
	}
	a.AgentWorker.auditAgentEvent(c, principal.UserID, organizationID, "agent.updated", "agent", id, map[string]any{"kind": item.Kind})
	c.JSON(http.StatusOK, gin.H{"agent": item})
}

func (a *App) deleteAgent(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid agent id"))
		return
	}
	if err := a.authorizeAgentManage(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	result, err := a.DB.ExecContext(c, `UPDATE saved_assistants SET deleted_at=now(),updated_at=now() WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, id, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("agent not found"))
		return
	}
	a.AgentWorker.auditAgentEvent(c, principal.UserID, organizationID, "agent.deleted", "agent", id, map[string]any{})
	c.Status(http.StatusNoContent)
}

func (a *App) createOrUpdateAgent(c *gin.Context, principal middleware.Principal, organizationID, id uuid.UUID, request agentRequest, updating bool) (models.Agent, error) {
	kind := strings.ToLower(strings.TrimSpace(request.Kind))
	current := models.Agent{}
	if updating {
		var err error
		current, err = a.AgentWorker.loadAgent(c, id, principal.UserID, organizationID, nil)
		if err != nil {
			return current, fmt.Errorf("agent not found")
		}
	}
	if kind == "" {
		kind = current.Kind
	}
	if kind != "native" && kind != "remote" {
		return current, fmt.Errorf("kind must be native or remote")
	}
	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = current.Name
	}
	if name == "" {
		return current, fmt.Errorf("name is required")
	}
	if len([]rune(name)) > 80 {
		return current, fmt.Errorf("name must be 80 characters or fewer")
	}
	description, icon, visibility := strings.TrimSpace(request.Description), strings.TrimSpace(request.Icon), strings.TrimSpace(request.Visibility)
	if updating {
		if description == "" {
			description = current.Description
		}
		if icon == "" {
			icon = current.Icon
		}
		if visibility == "" {
			visibility = current.Visibility
		}
	}
	if icon == "" {
		icon = "sparkles"
	}
	if len([]rune(description)) > 300 {
		return current, fmt.Errorf("description must be 300 characters or fewer")
	}
	if len([]rune(icon)) > 40 {
		return current, fmt.Errorf("icon must be 40 characters or fewer")
	}
	if visibility == "" {
		visibility = "private"
	}
	if visibility != "private" && visibility != "workspace" {
		return current, fmt.Errorf("visibility must be private or workspace")
	}
	connectionID, err := parseOptionalRequestUUID(request.ConnectionID)
	if err != nil {
		return current, fmt.Errorf("invalid connectionId")
	}
	if kind == "remote" && connectionID == nil {
		connectionID = current.ConnectionID
	}
	if kind == "remote" && connectionID == nil {
		return current, fmt.Errorf("remote agents require connectionId")
	}
	if connectionID != nil {
		if kind == "native" {
			connectionID = nil
		} else if _, err := a.loadRemoteAgentConnection(c, *connectionID, principal.UserID, organizationID); err != nil {
			return current, fmt.Errorf("agent connection is not available")
		} else if visibility == "workspace" {
			var scopeType string
			if err := a.DB.QueryRowContext(c, `SELECT scope_type FROM agent_connections WHERE id=$1 AND organization_id=$2`, *connectionID, organizationID).Scan(&scopeType); err != nil {
				return current, fmt.Errorf("agent connection is not available")
			}
			if scopeType != "organization" {
				return current, fmt.Errorf("workspace remote agents require an organization-scoped connection")
			}
		}
	}
	endpointID, err := parseOptionalRequestUUID(request.EndpointID)
	if err != nil {
		return current, fmt.Errorf("invalid endpointId")
	}
	if kind == "native" && endpointID == nil && updating {
		endpointID = current.EndpointID
	}
	if kind == "native" {
		if err := a.validateSavedAssistantEndpoint(c, endpointID, principal.UserID, organizationID); err != nil {
			return current, err
		}
	}
	instructions, model := strings.TrimSpace(request.Instructions), strings.TrimSpace(request.Model)
	useMemory, deepContext := true, false
	if updating {
		instructions, model, useMemory, deepContext = current.Instructions, current.Model, current.UseMemory, current.DeepContext
	}
	if request.Instructions != "" {
		instructions = strings.TrimSpace(request.Instructions)
	}
	if request.Model != "" {
		model = strings.TrimSpace(request.Model)
	}
	if len([]rune(instructions)) > 30000 {
		return current, fmt.Errorf("instructions must be 30000 characters or fewer")
	}
	if len([]rune(model)) > 200 {
		return current, fmt.Errorf("model must be 200 characters or fewer")
	}
	if request.UseMemory != nil {
		useMemory = *request.UseMemory
	}
	if request.DeepContext != nil {
		deepContext = *request.DeepContext
	}
	delegation := []uuid.UUID{}
	if updating {
		delegation = append(delegation, current.DelegationAgentIDs...)
	}
	if request.DelegationAgentIDs != nil {
		delegation = []uuid.UUID{}
		if len(request.DelegationAgentIDs) > maxAgentWorkflowNodes {
			return current, fmt.Errorf("delegation allowlist cannot contain more than %d agents", maxAgentWorkflowNodes)
		}
		for _, raw := range request.DelegationAgentIDs {
			parsed, parseErr := uuid.Parse(strings.TrimSpace(raw))
			if parseErr != nil {
				return current, fmt.Errorf("invalid delegation agent id")
			}
			if _, loadErr := a.AgentWorker.loadAgent(c, parsed, principal.UserID, organizationID, nil); loadErr != nil {
				return current, fmt.Errorf("delegation agent is not available")
			}
			delegation = append(delegation, parsed)
		}
	}
	delegationRaw, _ := json.Marshal(delegation)
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		return current, err
	}
	defer transaction.Rollback()
	if !updating {
		if err := transaction.QueryRowContext(c, `INSERT INTO saved_assistants (user_id,organization_id,name,description,icon,visibility,current_version,agent_kind,connection_id,delegation_agent_ids) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9) RETURNING id`, principal.UserID, organizationID, name, description, icon, visibility, kind, connectionID, delegationRaw).Scan(&id); err != nil {
			return current, err
		}
		if _, err := transaction.ExecContext(c, `INSERT INTO saved_assistant_versions (assistant_id,version,instructions,endpoint_id,model,use_memory,deep_context,created_by) VALUES ($1,1,$2,$3,$4,$5,$6,$7)`, id, instructions, endpointID, model, useMemory, deepContext, principal.UserID); err != nil {
			return current, err
		}
	} else {
		version := current.Version + 1
		if version < 1 {
			version = 1
		}
		if _, err := transaction.ExecContext(c, `UPDATE saved_assistants SET name=$2,description=$3,icon=$4,visibility=$5,current_version=$6,agent_kind=$7,connection_id=$8,delegation_agent_ids=$9,updated_at=now() WHERE id=$1 AND organization_id=$10`, id, name, description, icon, visibility, version, kind, connectionID, delegationRaw, organizationID); err != nil {
			return current, err
		}
		if _, err := transaction.ExecContext(c, `INSERT INTO saved_assistant_versions (assistant_id,version,instructions,endpoint_id,model,use_memory,deep_context,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, id, version, instructions, endpointID, model, useMemory, deepContext, principal.UserID); err != nil {
			return current, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return current, err
	}
	return a.AgentWorker.loadAgent(c, id, principal.UserID, organizationID, nil)
}

func (a *App) authorizeAgentManage(c *gin.Context, id, userID, organizationID uuid.UUID) error {
	var owner uuid.UUID
	var visibility string
	if err := a.DB.QueryRowContext(c, `SELECT user_id,visibility FROM saved_assistants WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, id, organizationID).Scan(&owner, &visibility); err != nil {
		return fmt.Errorf("agent not found")
	}
	if owner == userID {
		return nil
	}
	role := middleware.GetOrganizationRole(c)
	if visibility == "workspace" && (role == "owner" || role == "admin") {
		return nil
	}
	return fmt.Errorf("agent can only be managed by its owner or a workspace administrator")
}

func parseOptionalRequestUUID(raw *string) (*uuid.UUID, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, nil
	}
	parsed, err := uuid.Parse(strings.TrimSpace(*raw))
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func agentErrorStatus(err error) int {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "not found") {
		return http.StatusNotFound
	}
	for _, marker := range []string{"required", "invalid", "must be", "cannot be", "only ", "available", "connection"} {
		if strings.Contains(message, marker) {
			return http.StatusBadRequest
		}
	}
	if strings.Contains(message, "duplicate") {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

func requestOrigin(c *gin.Context) string {
	if origin := strings.TrimSpace(c.GetHeader("Origin")); origin != "" {
		return origin
	}
	if scheme := c.GetHeader("X-Forwarded-Proto"); scheme != "" {
		return scheme + "://" + c.Request.Host
	}
	return "http://" + c.Request.Host
}

func safeOAuthClient(rawURL string, allowPrivate bool) (*http.Client, error) {
	return safeAgentHTTPClient(rawURL, allowPrivate, 45*time.Second)
}
