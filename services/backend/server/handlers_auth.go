package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"golang.org/x/oauth2"

	"justai-backend/auth"
	"justai-backend/models"
	"justai-backend/security"
)

type credentialsRequest struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
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
	err := a.DB.QueryRowContext(c, `SELECT id, email, display_name, is_platform_admin, password_hash FROM users WHERE email = $1`, request.Email).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PlatformAdmin, &passwordHash)
	if err != nil || !passwordHash.Valid || !security.CheckPassword(request.Password, passwordHash.String) {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("invalid email or password"))
		return
	}
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
	user := models.User{ID: userID, Email: email, DisplayName: displayName, PlatformAdmin: count == 0}
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
	if !a.Config.OIDCEnabled() {
		writeError(c, http.StatusNotFound, fmt.Errorf("OIDC is not configured"))
		return
	}
	state, _, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("justai_oidc_state", state, 600, "/", "", false, true)
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
	c.Redirect(http.StatusFound, oauthConfig.AuthCodeURL(state))
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
	}
	if err := idToken.Claims(&claims); err != nil || claims.Subject == "" || claims.Email == "" {
		writeError(c, http.StatusBadGateway, fmt.Errorf("OIDC identity did not include sub and email"))
		return
	}
	user, err := a.upsertOIDCUser(c, claims.Subject, claims.Email, claims.Name)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := a.issueSession(c, user); err != nil {
		writeError(c, http.StatusInternalServerError, err)
	}
}

func (a *App) upsertOIDCUser(ctx context.Context, subject, email, name string) (models.User, error) {
	var user models.User
	err := a.DB.QueryRowContext(ctx, `SELECT u.id, u.email, u.display_name, u.is_platform_admin FROM oidc_identities oi JOIN users u ON u.id = oi.user_id WHERE oi.issuer = $1 AND oi.subject = $2`, a.Config.OIDC.Issuer, subject).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PlatformAdmin)
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
		user, err = a.userByID(ctx, existingID)
		if err != nil {
			return models.User{}, err
		}
	} else if err == sql.ErrNoRows {
		var count int
		if err := transaction.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
			return models.User{}, err
		}
		user = models.User{ID: uuid.New(), Email: strings.ToLower(email), DisplayName: name, PlatformAdmin: count == 0}
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
