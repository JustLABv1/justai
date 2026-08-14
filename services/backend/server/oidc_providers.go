package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type oidcProviderRecord struct {
	ID                     uuid.UUID
	Slug                   string
	DisplayName            string
	Issuer                 string
	ClientID               string
	ClientSecretCiphertext []byte
	Scopes                 string
	Enabled                bool
	LastTestedAt           *time.Time
	LastError              string
}

type oidcProviderPublic struct {
	ID          uuid.UUID `json:"id"`
	Slug        string    `json:"slug"`
	DisplayName string    `json:"displayName"`
}

func (a *App) legacyOIDCProvider() (oidcProviderRecord, bool) {
	if !a.Config.OIDCEnabled() {
		return oidcProviderRecord{}, false
	}
	return oidcProviderRecord{
		Slug:        "legacy",
		DisplayName: "OIDC",
		Issuer:      a.Config.OIDC.Issuer,
		ClientID:    a.Config.OIDC.ClientID,
		Scopes:      "openid profile email",
		Enabled:     true,
	}, true
}

// syncLegacyOIDCProvider keeps deployments that configured the original
// single-provider YAML block working after the provider catalog migration.
// The secret is encrypted before it enters the database and the operation is
// idempotent by issuer.
func (a *App) syncLegacyOIDCProvider(ctx context.Context) error {
	legacy, ok := a.legacyOIDCProvider()
	if !ok || a.DB == nil || a.Secrets == nil {
		return nil
	}
	var existing uuid.UUID
	err := a.DB.QueryRowContext(ctx, `SELECT id FROM oidc_providers WHERE issuer = $1`, legacy.Issuer).Scan(&existing)
	if err == nil {
		return nil
	}
	if err != sql.ErrNoRows {
		return err
	}
	ciphertext, err := a.Secrets.Encrypt(a.Config.OIDC.ClientSecret)
	if err != nil {
		return err
	}
	_, err = a.DB.ExecContext(ctx, `INSERT INTO oidc_providers (slug, display_name, issuer, client_id, client_secret_ciphertext, scopes, enabled) VALUES ('legacy', $1, $2, $3, $4, $5, TRUE) ON CONFLICT (issuer) DO NOTHING`, legacy.DisplayName, legacy.Issuer, legacy.ClientID, ciphertext, legacy.Scopes)
	return err
}

// ImportLegacyOIDCProvider is called after migrations so deployments that use
// the original single-provider configuration are represented in the catalog
// before the first admin or login request.
func (a *App) ImportLegacyOIDCProvider(ctx context.Context) error {
	return a.syncLegacyOIDCProvider(ctx)
}

func (a *App) loadOIDCProvider(ctx context.Context, slug string, includeDisabled bool) (oidcProviderRecord, error) {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		slug = "legacy"
	}
	if a.DB == nil {
		if legacy, ok := a.legacyOIDCProvider(); ok && slug == "legacy" {
			return legacy, nil
		}
		return oidcProviderRecord{}, sql.ErrNoRows
	}
	_ = a.syncLegacyOIDCProvider(ctx)
	whereEnabled := ""
	if !includeDisabled {
		whereEnabled = " AND enabled = TRUE"
	}
	var provider oidcProviderRecord
	var lastTested sql.NullTime
	err := a.DB.QueryRowContext(ctx, `SELECT id, slug, display_name, issuer, client_id, client_secret_ciphertext, scopes, enabled, last_tested_at, last_error FROM oidc_providers WHERE slug = $1`+whereEnabled, slug).Scan(
		&provider.ID,
		&provider.Slug,
		&provider.DisplayName,
		&provider.Issuer,
		&provider.ClientID,
		&provider.ClientSecretCiphertext,
		&provider.Scopes,
		&provider.Enabled,
		&lastTested,
		&provider.LastError,
	)
	if err == nil {
		if lastTested.Valid {
			provider.LastTestedAt = &lastTested.Time
		}
		return provider, nil
	}
	if slug == "legacy" {
		if legacy, ok := a.legacyOIDCProvider(); ok {
			return legacy, nil
		}
	}
	return oidcProviderRecord{}, err
}

func (a *App) listOIDCProviders(ctx context.Context, enabledOnly bool) ([]oidcProviderRecord, error) {
	if a.DB == nil {
		if legacy, ok := a.legacyOIDCProvider(); ok {
			return []oidcProviderRecord{legacy}, nil
		}
		return []oidcProviderRecord{}, nil
	}
	_ = a.syncLegacyOIDCProvider(ctx)
	whereEnabled := ""
	if enabledOnly {
		whereEnabled = " WHERE enabled = TRUE"
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT id, slug, display_name, issuer, client_id, client_secret_ciphertext, scopes, enabled, last_tested_at, last_error FROM oidc_providers`+whereEnabled+` ORDER BY display_name, created_at`)
	if err != nil {
		if legacy, ok := a.legacyOIDCProvider(); ok {
			return []oidcProviderRecord{legacy}, nil
		}
		return nil, err
	}
	defer rows.Close()
	providers := []oidcProviderRecord{}
	for rows.Next() {
		var provider oidcProviderRecord
		var lastTested sql.NullTime
		if err := rows.Scan(&provider.ID, &provider.Slug, &provider.DisplayName, &provider.Issuer, &provider.ClientID, &provider.ClientSecretCiphertext, &provider.Scopes, &provider.Enabled, &lastTested, &provider.LastError); err != nil {
			return nil, err
		}
		if lastTested.Valid {
			provider.LastTestedAt = &lastTested.Time
		}
		providers = append(providers, provider)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(providers) == 0 && enabledOnly {
		if legacy, ok := a.legacyOIDCProvider(); ok {
			return []oidcProviderRecord{legacy}, nil
		}
	}
	return providers, nil
}

func (a *App) publicOIDCProviders(ctx context.Context) []oidcProviderPublic {
	providers, err := a.listOIDCProviders(ctx, true)
	if err != nil {
		return nil
	}
	result := make([]oidcProviderPublic, 0, len(providers))
	for _, provider := range providers {
		result = append(result, oidcProviderPublic{ID: provider.ID, Slug: provider.Slug, DisplayName: provider.DisplayName})
	}
	return result
}

func oidcProviderPublicJSON(provider oidcProviderRecord, callbackURL string) gin.H {
	return gin.H{
		"id":               provider.ID,
		"slug":             provider.Slug,
		"displayName":      provider.DisplayName,
		"issuer":           provider.Issuer,
		"clientId":         provider.ClientID,
		"scopes":           provider.Scopes,
		"enabled":          provider.Enabled,
		"secretConfigured": len(provider.ClientSecretCiphertext) > 0,
		"lastTestedAt":     provider.LastTestedAt,
		"lastError":        provider.LastError,
		"callbackUrl":      callbackURL,
	}
}

func validateOIDCProviderInput(displayName, slug, issuer, clientID, scopes string) error {
	if strings.TrimSpace(displayName) == "" {
		return fmt.Errorf("display name is required")
	}
	if strings.TrimSpace(slug) == "" {
		return fmt.Errorf("slug is required")
	}
	if len(slug) > 64 || strings.Trim(slug, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ ") != "" {
		return fmt.Errorf("slug may contain only letters, numbers, hyphens, and underscores")
	}
	parsed, err := url.Parse(strings.TrimSpace(issuer))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return fmt.Errorf("issuer must be an absolute http(s) URL")
	}
	if strings.TrimSpace(clientID) == "" {
		return fmt.Errorf("client id is required")
	}
	if strings.TrimSpace(scopes) == "" {
		return fmt.Errorf("at least one OIDC scope is required")
	}
	hasOpenID := false
	for _, scope := range strings.Fields(scopes) {
		if strings.EqualFold(scope, "openid") {
			hasOpenID = true
			break
		}
	}
	if !hasOpenID {
		return fmt.Errorf("OIDC scopes must include openid")
	}
	return nil
}

func validateOIDCCallbackURL(value string) error {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return fmt.Errorf("OIDC redirect URL must be an absolute http(s) URL")
	}
	return nil
}
