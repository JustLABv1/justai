package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/url"
	"strings"

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

func (a *App) register(c *gin.Context) {
	settings, settingsErr := a.readPlatformSettings(c)
	if settingsErr == nil && !settings.SignupEnabled {
		message := strings.TrimSpace(settings.MaintenanceMessage)
		if message == "" {
			message = "Sign up is temporarily disabled by the platform administrator"
		}
		middleware.AbortError(c, http.StatusServiceUnavailable, "feature_disabled", message)
		return
	}
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
	passwordHash, err := security.HashPassword(request.Password)
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
	var user models.User
	var passwordHash sql.NullString
	err := a.DB.QueryRowContext(c, `SELECT id, email, display_name, is_platform_admin, password_hash, COALESCE(status, 'active'), COALESCE(session_version, 0) FROM users WHERE email = $1`, request.Email).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PlatformAdmin, &passwordHash, &user.Status, &user.SessionVersion)
	if err != nil || !passwordHash.Valid || !security.CheckPassword(request.Password, passwordHash.String) {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("invalid email or password"))
		return
	}
	if user.Status == "suspended" {
		writeError(c, http.StatusForbidden, fmt.Errorf("this account is suspended"))
		return
	}
	settings, settingsErr := a.readPlatformSettings(c)
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

func (a *App) createUserWorkspace(ctx context.Context, email, displayName, passwordHash string) (models.User, error) {
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return models.User{}, err
	}
	defer transaction.Rollback()
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
	// Do not gate the authorization redirect itself. The callback can identify
	// an existing platform administrator and still allow recovery while login
	// is disabled; non-admin and first-time identities are rejected there.
	if !a.Config.OIDCEnabled() {
		writeError(c, http.StatusNotFound, fmt.Errorf("OIDC is not configured"))
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
	c.SetSameSite(a.cookieSameSite())
	c.SetCookie("justai_oidc_state", state, 600, "/", a.Config.CookieDomain, a.Config.SecureCookies, true)
	c.SetCookie("justai_oidc_nonce", nonce, 600, "/", a.Config.CookieDomain, a.Config.SecureCookies, true)
	next := safeOIDCNext(c.Query("next"))
	c.SetCookie("justai_oidc_next", next, 600, "/", a.Config.CookieDomain, a.Config.SecureCookies, true)
	provider, err := oidc.NewProvider(c, a.Config.OIDC.Issuer)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	oauthConfig := &oauth2.Config{
		ClientID:     a.Config.OIDC.ClientID,
		ClientSecret: a.Config.OIDC.ClientSecret,
		Endpoint:     provider.Endpoint(),
		RedirectURL:  a.Config.OIDC.RedirectURL,
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}
	c.Redirect(http.StatusFound, oauthConfig.AuthCodeURL(state, oauth2.SetAuthURLParam("nonce", nonce)))
}

func (a *App) oidcCallback(c *gin.Context) {
	if !a.Config.OIDCEnabled() {
		writeError(c, http.StatusNotFound, fmt.Errorf("OIDC is not configured"))
		return
	}
	state, err := c.Cookie("justai_oidc_state")
	if err != nil || state == "" || state != c.Query("state") {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OIDC state"))
		return
	}
	next, _ := c.Cookie("justai_oidc_next")
	next = safeOIDCNext(next)
	nonce, _ := c.Cookie("justai_oidc_nonce")
	provider, err := oidc.NewProvider(c, a.Config.OIDC.Issuer)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	oauthConfig := &oauth2.Config{ClientID: a.Config.OIDC.ClientID, ClientSecret: a.Config.OIDC.ClientSecret, Endpoint: provider.Endpoint(), RedirectURL: a.Config.OIDC.RedirectURL}
	token, err := oauthConfig.Exchange(c, c.Query("code"))
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	idTokenValue, ok := token.Extra("id_token").(string)
	if !ok || idTokenValue == "" {
		writeError(c, http.StatusBadGateway, fmt.Errorf("OIDC provider did not return an id_token"))
		return
	}
	idToken, err := provider.Verifier(&oidc.Config{ClientID: a.Config.OIDC.ClientID}).Verify(c, idTokenValue)
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	var claims struct {
		Subject string `json:"sub"`
		Email   string `json:"email"`
		Name    string `json:"name"`
		Nonce   string `json:"nonce"`
	}
	if err := idToken.Claims(&claims); err != nil || claims.Subject == "" || claims.Email == "" || nonce == "" || claims.Nonce != nonce {
		writeError(c, http.StatusBadGateway, fmt.Errorf("OIDC identity did not include sub and email"))
		return
	}
	var identityExists bool
	_ = a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM oidc_identities WHERE issuer = $1 AND subject = $2)`, a.Config.OIDC.Issuer, claims.Subject).Scan(&identityExists)
	settings, settingsErr := a.readPlatformSettings(c)
	if settingsErr == nil && (!settings.LoginEnabled || (!settings.SignupEnabled && !identityExists)) {
		var existingAdmin bool
		_ = a.DB.QueryRowContext(c, `SELECT COALESCE(is_platform_admin, FALSE) FROM oidc_identities oi JOIN users u ON u.id = oi.user_id WHERE oi.issuer = $1 AND oi.subject = $2`, a.Config.OIDC.Issuer, claims.Subject).Scan(&existingAdmin)
		if !existingAdmin {
			message := strings.TrimSpace(settings.MaintenanceMessage)
			if message == "" {
				message = "This sign-in is temporarily disabled by the platform administrator"
			}
			middleware.AbortError(c, http.StatusServiceUnavailable, "feature_disabled", message)
			return
		}
	}
	user, err := a.upsertOIDCUser(c, claims.Subject, claims.Email, claims.Name)
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
	c.SetCookie("justai_oidc_state", "", -1, "/", a.Config.CookieDomain, a.Config.SecureCookies, true)
	c.SetCookie("justai_oidc_nonce", "", -1, "/", a.Config.CookieDomain, a.Config.SecureCookies, true)
	c.SetCookie("justai_oidc_next", "", -1, "/", a.Config.CookieDomain, a.Config.SecureCookies, true)
	frontend := "/"
	if len(a.Config.FrontendOrigins) > 0 && a.Config.FrontendOrigins[0] != "*" {
		frontend = strings.TrimRight(a.Config.FrontendOrigins[0], "/")
	}
	c.Redirect(http.StatusFound, frontend+next)
}

func safeOIDCNext(value string) string {
	value = strings.TrimSpace(value)
	parsed, err := url.Parse(value)
	if err != nil || value == "" || strings.ContainsAny(value, "\\\r\n") || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || parsed.IsAbs() || parsed.Host != "" {
		return "/"
	}
	return value
}

func (a *App) upsertOIDCUser(ctx context.Context, subject, email, name string) (models.User, error) {
	var user models.User
	err := a.DB.QueryRowContext(ctx, `SELECT u.id, u.email, u.display_name, u.is_platform_admin, COALESCE(u.status, 'active'), COALESCE(u.session_version, 0) FROM oidc_identities oi JOIN users u ON u.id = oi.user_id WHERE oi.issuer = $1 AND oi.subject = $2`, a.Config.OIDC.Issuer, subject).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PlatformAdmin, &user.Status, &user.SessionVersion)
	if err == nil {
		return user, nil
	}
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return models.User{}, err
	}
	defer transaction.Rollback()
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
	if _, err := transaction.ExecContext(ctx, `INSERT INTO oidc_identities (issuer, subject, user_id, email) VALUES ($1, $2, $3, $4) ON CONFLICT (issuer, subject) DO UPDATE SET email = EXCLUDED.email`, a.Config.OIDC.Issuer, subject, user.ID, email); err != nil {
		return models.User{}, err
	}
	if err := transaction.Commit(); err != nil {
		return models.User{}, err
	}
	return user, nil
}
