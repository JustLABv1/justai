package server

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

type oidcProviderRequest struct {
	Slug         string `json:"slug"`
	DisplayName  string `json:"displayName"`
	Issuer       string `json:"issuer"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	Scopes       string `json:"scopes"`
	Enabled      *bool  `json:"enabled"`
}

func (a *App) listPlatformOIDCProviders(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	providers, err := a.listOIDCProviders(c, false)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	result := make([]gin.H, 0, len(providers))
	for _, provider := range providers {
		result = append(result, oidcProviderPublicJSON(provider, a.Config.OIDC.RedirectURL))
	}
	c.JSON(http.StatusOK, gin.H{"providers": result, "callbackUrl": a.Config.OIDC.RedirectURL})
}

func (a *App) createPlatformOIDCProvider(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	if err := validateOIDCCallbackURL(a.Config.OIDC.RedirectURL); err != nil {
		writeError(c, http.StatusFailedDependency, fmt.Errorf("configure the backend OIDC redirect URL before adding a provider: %w", err))
		return
	}
	var request oidcProviderRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.Slug = strings.TrimSpace(request.Slug)
	request.DisplayName = strings.TrimSpace(request.DisplayName)
	request.Issuer = strings.TrimRight(strings.TrimSpace(request.Issuer), "/")
	request.ClientID = strings.TrimSpace(request.ClientID)
	request.ClientSecret = strings.TrimSpace(request.ClientSecret)
	request.Scopes = strings.TrimSpace(request.Scopes)
	if request.Scopes == "" {
		request.Scopes = "openid profile email"
	}
	if err := validateOIDCProviderInput(request.DisplayName, request.Slug, request.Issuer, request.ClientID, request.Scopes); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if request.ClientSecret == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("client secret is required"))
		return
	}
	if a.Secrets == nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("OIDC provider secret store is unavailable"))
		return
	}
	ciphertext, err := a.Secrets.Encrypt(request.ClientSecret)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	providerID := uuid.New()
	enabled := request.Enabled == nil || *request.Enabled
	_, err = a.DB.ExecContext(c, `INSERT INTO oidc_providers (id, slug, display_name, issuer, client_id, client_secret_ciphertext, scopes, enabled, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`, providerID, request.Slug, request.DisplayName, request.Issuer, request.ClientID, ciphertext, request.Scopes, enabled, principal.UserID)
	if err != nil {
		writeError(c, http.StatusConflict, fmt.Errorf("OIDC provider could not be created: %w", err))
		return
	}
	a.writePlatformAudit(c, "platform.oidc_provider.created", "oidc_provider", &providerID, gin.H{"slug": request.Slug})
	provider, err := a.loadOIDCProvider(c, request.Slug, true)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, oidcProviderPublicJSON(provider, a.Config.OIDC.RedirectURL))
}

func (a *App) updatePlatformOIDCProvider(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OIDC provider id"))
		return
	}
	var request oidcProviderRequest
	if !decodeJSON(c, &request) {
		return
	}
	var current oidcProviderRecord
	var lastTested sql.NullTime
	if err := a.DB.QueryRowContext(c, `SELECT id, slug, display_name, issuer, client_id, client_secret_ciphertext, scopes, enabled, last_tested_at, last_error FROM oidc_providers WHERE id = $1`, id).Scan(&current.ID, &current.Slug, &current.DisplayName, &current.Issuer, &current.ClientID, &current.ClientSecretCiphertext, &current.Scopes, &current.Enabled, &lastTested, &current.LastError); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("OIDC provider not found"))
		return
	}
	if lastTested.Valid {
		current.LastTestedAt = &lastTested.Time
	}
	if strings.TrimSpace(request.Slug) != "" {
		current.Slug = strings.TrimSpace(request.Slug)
	}
	if strings.TrimSpace(request.DisplayName) != "" {
		current.DisplayName = strings.TrimSpace(request.DisplayName)
	}
	if strings.TrimSpace(request.Issuer) != "" {
		current.Issuer = strings.TrimRight(strings.TrimSpace(request.Issuer), "/")
	}
	if strings.TrimSpace(request.ClientID) != "" {
		current.ClientID = strings.TrimSpace(request.ClientID)
	}
	if strings.TrimSpace(request.Scopes) != "" {
		current.Scopes = strings.TrimSpace(request.Scopes)
	}
	if request.Enabled != nil {
		current.Enabled = *request.Enabled
	}
	if err := validateOIDCProviderInput(current.DisplayName, current.Slug, current.Issuer, current.ClientID, current.Scopes); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	secret := current.ClientSecretCiphertext
	if value := strings.TrimSpace(request.ClientSecret); value != "" {
		if a.Secrets == nil {
			writeError(c, http.StatusInternalServerError, fmt.Errorf("OIDC provider secret store is unavailable"))
			return
		}
		secret, err = a.Secrets.Encrypt(value)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	principal, _ := middleware.GetPrincipal(c)
	_, err = a.DB.ExecContext(c, `UPDATE oidc_providers SET slug = $2, display_name = $3, issuer = $4, client_id = $5, client_secret_ciphertext = $6, scopes = $7, enabled = $8, updated_by = $9, updated_at = now() WHERE id = $1`, id, current.Slug, current.DisplayName, current.Issuer, current.ClientID, secret, current.Scopes, current.Enabled, principal.UserID)
	if err != nil {
		writeError(c, http.StatusConflict, fmt.Errorf("OIDC provider could not be updated: %w", err))
		return
	}
	a.writePlatformAudit(c, "platform.oidc_provider.updated", "oidc_provider", &id, gin.H{"slug": current.Slug})
	provider, err := a.loadOIDCProvider(c, current.Slug, true)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, oidcProviderPublicJSON(provider, a.Config.OIDC.RedirectURL))
}

func (a *App) deletePlatformOIDCProvider(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OIDC provider id"))
		return
	}
	var issuer string
	if err := a.DB.QueryRowContext(c, `SELECT issuer FROM oidc_providers WHERE id = $1`, id).Scan(&issuer); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("OIDC provider not found"))
		return
	}
	var identities int
	if err := a.DB.QueryRowContext(c, `SELECT COUNT(*) FROM oidc_identities WHERE issuer = $1`, issuer).Scan(&identities); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if identities > 0 {
		writeError(c, http.StatusConflict, fmt.Errorf("provider has linked identities; disable it instead of deleting it"))
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM oidc_providers WHERE id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.oidc_provider.deleted", "oidc_provider", &id, nil)
	c.Status(http.StatusNoContent)
}

func (a *App) testPlatformOIDCProvider(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid OIDC provider id"))
		return
	}
	var slug string
	if err := a.DB.QueryRowContext(c, `SELECT slug FROM oidc_providers WHERE id = $1`, id).Scan(&slug); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("OIDC provider not found"))
		return
	}
	provider, err := a.loadOIDCProvider(c, slug, true)
	if err == nil {
		_, err = oidc.NewProvider(c, provider.Issuer)
	}
	if err != nil {
		_, _ = a.DB.ExecContext(c, `UPDATE oidc_providers SET last_tested_at = now(), last_error = $2, updated_at = now() WHERE id = $1`, id, err.Error())
		writeError(c, http.StatusBadGateway, fmt.Errorf("OIDC discovery failed: %w", err))
		return
	}
	_, _ = a.DB.ExecContext(c, `UPDATE oidc_providers SET last_tested_at = now(), last_error = '', updated_at = now() WHERE id = $1`, id)
	a.writePlatformAudit(c, "platform.oidc_provider.tested", "oidc_provider", &id, nil)
	c.JSON(http.StatusOK, gin.H{"ok": true, "message": "OIDC discovery succeeded"})
}
