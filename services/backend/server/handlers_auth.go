package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"golang.org/x/oauth2"

	"justai-backend/auth"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/security"
)

type credentialsRequest struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
}

type oidcIdentityClaims struct {
	Subject       string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	Nonce         string `json:"nonce"`
}

func (a *App) register(c *gin.Context) {
	var request credentialsRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.Email = strings.ToLower(strings.TrimSpace(request.Email))
	request.DisplayName = strings.TrimSpace(request.DisplayName)
	if request.Email == "" || !strings.Contains(request.Email, "@") {
		writeError(c, http.StatusBadRequest, fmt.Errorf("a valid email is required"))
		return
	}
	if request.DisplayName == "" {
		request.DisplayName = strings.Split(request.Email, "@")[0]
	}
	if !a.allowAuthAttempt(c, request.Email) {
		return
	}
	settings, settingsErr := a.readPlatformSettings(c)
	if settingsErr == nil && !settings.LocalAuthEnabled {
		message := strings.TrimSpace(settings.MaintenanceMessage)
		if message == "" {
			message = "Local password authentication is disabled by the platform administrator"
		}
		middleware.AbortError(c, http.StatusServiceUnavailable, "feature_disabled", message)
		return
	}
	if settingsErr == nil && !settings.SignupEnabled {
		message := strings.TrimSpace(settings.MaintenanceMessage)
		if message == "" {
			message = "Sign up is temporarily disabled by the platform administrator"
		}
		middleware.AbortError(c, http.StatusServiceUnavailable, "feature_disabled", message)
		return
	}
	release, ok := a.acquirePasswordSlot(c)
	if !ok {
		return
	}
	passwordHash, err := security.HashPassword(request.Password)
	release()
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	user, err := a.createUserWorkspace(c, request.Email, request.DisplayName, passwordHash)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			writeError(c, http.StatusConflict, fmt.Errorf("an account with that email already exists"))
			return
		}
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := a.issueSession(c, user); err != nil {
		writeError(c, http.StatusInternalServerError, err)
	}
}

func (a *App) login(c *gin.Context) {
	var request credentialsRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.Email = strings.ToLower(strings.TrimSpace(request.Email))
	if !a.allowAuthAttempt(c, request.Email) {
		return
	}
	var user models.User
	var passwordHash sql.NullString
	err := a.DB.QueryRowContext(c, `SELECT id, email, display_name, is_platform_admin, password_hash, COALESCE(status, 'active'), COALESCE(session_version, 0) FROM users WHERE email = $1`, request.Email).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PlatformAdmin, &passwordHash, &user.Status, &user.SessionVersion)
	if err != nil {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("invalid email or password"))
		return
	}
	if user.Status == "suspended" {
		writeError(c, http.StatusForbidden, fmt.Errorf("this account is suspended"))
		return
	}
	settings, settingsErr := a.readPlatformSettings(c)
	if settingsErr == nil && !localPasswordAuthAllowed(settings, user) {
		message := strings.TrimSpace(settings.MaintenanceMessage)
		if message == "" {
			message = "Local password authentication is disabled by the platform administrator"
		}
		middleware.AbortError(c, http.StatusServiceUnavailable, "feature_disabled", message)
		return
	}
	release, ok := a.acquirePasswordSlot(c)
	if !ok {
		return
	}
	passwordValid := passwordHash.Valid && security.CheckPassword(request.Password, passwordHash.String)
	release()
	if !passwordValid {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("invalid email or password"))
		return
	}
	if settingsErr == nil && !settings.LoginEnabled && !user.PlatformAdmin {
		message := strings.TrimSpace(settings.MaintenanceMessage)
		if message == "" {
			message = "Login is temporarily disabled by the platform administrator"
		}
		middleware.AbortError(c, http.StatusServiceUnavailable, "feature_disabled", message)
		return
	}
	_, _ = a.DB.ExecContext(c, `UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1`, user.ID)
	if err := a.issueSession(c, user); err != nil {
		writeError(c, http.StatusInternalServerError, err)
	}
}

func localPasswordAuthAllowed(settings platformSettings, user models.User) bool {
	return settings.LocalAuthEnabled || user.PlatformAdmin
}

func (a *App) createUserWorkspace(ctx context.Context, email, displayName, passwordHash string) (models.User, error) {
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return models.User{}, err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return models.User{}, err
	}
	var count int
	if err := transaction.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
		return models.User{}, err
	}
	userID := uuid.New()
	user := models.User{ID: userID, Email: email, DisplayName: displayName, PlatformAdmin: count == 0, Status: "active"}
	if _, err := transaction.ExecContext(ctx, `INSERT INTO users (id, email, display_name, password_hash, is_platform_admin) VALUES ($1, $2, $3, $4, $5)`, user.ID, user.Email, user.DisplayName, passwordHash, user.PlatformAdmin); err != nil {
		return models.User{}, err
	}
	organizationID := uuid.New()
	slug := workspaceSlug(email, organizationID)
	if _, err := transaction.ExecContext(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, organizationID, displayName+"'s workspace", slug); err != nil {
		return models.User{}, err
	}
	if _, err := transaction.ExecContext(ctx, `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, organizationID, user.ID); err != nil {
		return models.User{}, err
	}
	if err := transaction.Commit(); err != nil {
		return models.User{}, err
	}
	return user, nil
}

func workspaceSlug(email string, organizationID uuid.UUID) string {
	local := strings.Split(email, "@")[0]
	local = strings.ToLower(local)
	var builder strings.Builder
	for _, character := range local {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-' {
			builder.WriteRune(character)
		}
	}
	slug := strings.Trim(builder.String(), "-")
	if slug == "" {
		slug = "workspace"
	}
	return slug + "-" + organizationID.String()[:8]
}

func (a *App) oidcStart(c *gin.Context) {
	slug := c.Param("provider")
	provider, err := a.loadOIDCProvider(c, slug, false)
	if err != nil || !provider.Enabled {
		writeError(c, http.StatusNotFound, fmt.Errorf("OIDC provider is not available"))
		return
	}
	if err := validateOIDCCallbackURL(a.Config.OIDC.RedirectURL); err != nil {
		writeError(c, http.StatusFailedDependency, err)
		return
	}
	state, _, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	nonce, _, err := auth.NewOpaqueToken()
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
	next := safeOIDCNext(c.Query("next"))
	if _, err := a.DB.ExecContext(c, `INSERT INTO oidc_auth_states (state, provider_id, nonce, code_verifier, next_path, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`, state, provider.ID, nonce, verifier, next, time.Now().Add(10*time.Minute)); err != nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("could not start OIDC authentication: %w", err))
		return
	}
	if a.Secrets == nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("OIDC provider secret store is unavailable"))
		return
	}
	secret, err := a.Secrets.Decrypt(provider.ClientSecretCiphertext)
	if err != nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("OIDC provider secret is invalid"))
		return
	}
	discovered, err := oidc.NewProvider(c, provider.Issuer)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	oauthConfig := &oauth2.Config{
		ClientID:     provider.ClientID,
		ClientSecret: secret,
		Endpoint:     discovered.Endpoint(),
		RedirectURL:  a.Config.OIDC.RedirectURL,
		Scopes:       strings.Fields(provider.Scopes),
	}
	c.Redirect(http.StatusFound, oauthConfig.AuthCodeURL(state,
		oauth2.SetAuthURLParam("nonce", nonce),
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	))
}

func (a *App) oidcCallback(c *gin.Context) {
	state := strings.TrimSpace(c.Query("state"))
	if state == "" || strings.TrimSpace(c.Query("code")) == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OIDC state or code"))
		return
	}
	var provider oidcProviderRecord
	var nonce, verifier, next string
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	if err := transaction.QueryRowContext(c, `SELECT p.id, p.slug, p.display_name, p.issuer, p.client_id, p.client_secret_ciphertext, p.scopes, p.enabled, p.last_error, s.nonce, s.code_verifier, s.next_path FROM oidc_auth_states s JOIN oidc_providers p ON p.id = s.provider_id WHERE s.state = $1 AND s.expires_at > now() FOR UPDATE`, state).Scan(&provider.ID, &provider.Slug, &provider.DisplayName, &provider.Issuer, &provider.ClientID, &provider.ClientSecretCiphertext, &provider.Scopes, &provider.Enabled, &provider.LastError, &nonce, &verifier, &next); err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid or expired OIDC state"))
		return
	}
	if _, err := transaction.ExecContext(c, `DELETE FROM oidc_auth_states WHERE state = $1`, state); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !provider.Enabled {
		writeError(c, http.StatusGone, fmt.Errorf("OIDC provider is disabled"))
		return
	}
	if a.Secrets == nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("OIDC provider secret store is unavailable"))
		return
	}
	secret, err := a.Secrets.Decrypt(provider.ClientSecretCiphertext)
	if err != nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("OIDC provider secret is invalid"))
		return
	}
	discovered, err := oidc.NewProvider(c, provider.Issuer)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	oauthConfig := &oauth2.Config{ClientID: provider.ClientID, ClientSecret: secret, Endpoint: discovered.Endpoint(), RedirectURL: a.Config.OIDC.RedirectURL, Scopes: strings.Fields(provider.Scopes)}
	token, err := oauthConfig.Exchange(c, c.Query("code"), oauth2.SetAuthURLParam("code_verifier", verifier))
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	idTokenValue, ok := token.Extra("id_token").(string)
	if !ok || idTokenValue == "" {
		writeError(c, http.StatusBadGateway, fmt.Errorf("OIDC provider did not return an id_token"))
		return
	}
	idToken, err := discovered.Verifier(&oidc.Config{ClientID: provider.ClientID}).Verify(c, idTokenValue)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	var claims oidcIdentityClaims
	if err := idToken.Claims(&claims); err != nil || !validOIDCIdentityClaims(claims, nonce) {
		writeError(c, http.StatusBadGateway, fmt.Errorf("OIDC identity did not include sub and email"))
		return
	}
	var identityExists bool
	if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM oidc_identities WHERE issuer = $1 AND subject = $2)`, provider.Issuer, claims.Subject).Scan(&identityExists); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	// An unverified email claim may still be used by an already-linked
	// identity, but it must never be sufficient to attach a new identity to an
	// existing account or create a new account. Otherwise an OIDC provider that
	// lets users change an unverified email becomes an account-takeover path.
	if !oidcIdentityMayProvision(identityExists, claims.EmailVerified) {
		writeError(c, http.StatusForbidden, fmt.Errorf("OIDC email address must be verified before first sign-in"))
		return
	}
	settings, settingsErr := a.readPlatformSettings(c)
	if settingsErr == nil && (!settings.LoginEnabled || (!settings.SignupEnabled && !identityExists)) {
		var existingAdmin bool
		_ = a.DB.QueryRowContext(c, `SELECT COALESCE(is_platform_admin, FALSE) FROM oidc_identities oi JOIN users u ON u.id = oi.user_id WHERE oi.issuer = $1 AND oi.subject = $2`, provider.Issuer, claims.Subject).Scan(&existingAdmin)
		if !existingAdmin {
			message := strings.TrimSpace(settings.MaintenanceMessage)
			if message == "" {
				message = "This sign-in is temporarily disabled by the platform administrator"
			}
			middleware.AbortError(c, http.StatusServiceUnavailable, "feature_disabled", message)
			return
		}
	}
	user, err := a.upsertOIDCUser(c, provider.Issuer, claims.Subject, claims.Email, claims.Name)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if user.Status == "suspended" {
		writeError(c, http.StatusForbidden, fmt.Errorf("this account is suspended"))
		return
	}
	_, _ = a.DB.ExecContext(c, `UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1`, user.ID)
	sessionToken, err := a.Tokens.Issue(user.ID, user.Email, user.PlatformAdmin, user.SessionVersion)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.setSessionCookie(c, sessionToken, 12*60*60)
	frontend := "/"
	if len(a.Config.FrontendOrigins) > 0 && a.Config.FrontendOrigins[0] != "*" {
		frontend = strings.TrimRight(a.Config.FrontendOrigins[0], "/")
	}
	c.Redirect(http.StatusFound, frontend+safeOIDCNext(next))
}

func validOIDCIdentityClaims(claims oidcIdentityClaims, expectedNonce string) bool {
	return claims.Subject != "" && claims.Email != "" && expectedNonce != "" && claims.Nonce == expectedNonce
}

func oidcIdentityMayProvision(identityExists, emailVerified bool) bool {
	return identityExists || emailVerified
}

func safeOIDCNext(value string) string {
	value = strings.TrimSpace(value)
	parsed, err := url.Parse(value)
	if err != nil || value == "" || strings.ContainsAny(value, "\\\r\n") || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || parsed.IsAbs() || parsed.Host != "" {
		return "/"
	}
	return value
}

func (a *App) upsertOIDCUser(ctx context.Context, issuer, subject, email, name string) (models.User, error) {
	var user models.User
	err := a.DB.QueryRowContext(ctx, `SELECT u.id, u.email, u.display_name, u.is_platform_admin, COALESCE(u.status, 'active'), COALESCE(u.session_version, 0) FROM oidc_identities oi JOIN users u ON u.id = oi.user_id WHERE oi.issuer = $1 AND oi.subject = $2`, issuer, subject).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PlatformAdmin, &user.Status, &user.SessionVersion)
	if err == nil {
		return user, nil
	}
	if err != sql.ErrNoRows {
		return models.User{}, err
	}
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return models.User{}, err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return models.User{}, err
	}
	// Re-check the identity after taking the bootstrap lock. Two concurrent
	// callbacks can both miss the identity in the pool query above; only the
	// transaction that wins the lock may create or attach it.
	err = transaction.QueryRowContext(ctx, `SELECT u.id, u.email, u.display_name, u.is_platform_admin, COALESCE(u.status, 'active'), COALESCE(u.session_version, 0) FROM oidc_identities oi JOIN users u ON u.id = oi.user_id WHERE oi.issuer = $1 AND oi.subject = $2 FOR UPDATE`, issuer, subject).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PlatformAdmin, &user.Status, &user.SessionVersion)
	if err == nil {
		if err := transaction.Commit(); err != nil {
			return models.User{}, err
		}
		return user, nil
	}
	if err != sql.ErrNoRows {
		return models.User{}, err
	}
	var existingID uuid.UUID
	err = transaction.QueryRowContext(ctx, `SELECT id FROM users WHERE email = $1`, strings.ToLower(email)).Scan(&existingID)
	if err == nil {
		// Read through the same transaction. Using the pool while this
		// transaction is open can deadlock deployments configured with a small
		// connection limit and could observe a partially committed identity.
		if err := transaction.QueryRowContext(ctx, `SELECT id, email, display_name, is_platform_admin, COALESCE(status, 'active'), COALESCE(session_version, 0) FROM users WHERE id = $1`, existingID).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PlatformAdmin, &user.Status, &user.SessionVersion); err != nil {
			return models.User{}, err
		}
	} else if err == sql.ErrNoRows {
		var count int
		if err := transaction.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
			return models.User{}, err
		}
		user = models.User{ID: uuid.New(), Email: strings.ToLower(email), DisplayName: name, PlatformAdmin: count == 0, Status: "active"}
		if _, err := transaction.ExecContext(ctx, `INSERT INTO users (id, email, display_name, is_platform_admin) VALUES ($1, $2, $3, $4)`, user.ID, user.Email, user.DisplayName, user.PlatformAdmin); err != nil {
			return models.User{}, err
		}
		organizationID := uuid.New()
		if _, err := transaction.ExecContext(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, organizationID, name+"'s workspace", workspaceSlug(email, organizationID)); err != nil {
			return models.User{}, err
		}
		if _, err := transaction.ExecContext(ctx, `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, organizationID, user.ID); err != nil {
			return models.User{}, err
		}
	} else {
		return models.User{}, err
	}
	if _, err := transaction.ExecContext(ctx, `INSERT INTO oidc_identities (issuer, subject, user_id, email) VALUES ($1, $2, $3, $4) ON CONFLICT (issuer, subject) DO UPDATE SET email = EXCLUDED.email`, issuer, subject, user.ID, email); err != nil {
		return models.User{}, err
	}
	if err := transaction.Commit(); err != nil {
		return models.User{}, err
	}
	return user, nil
}
