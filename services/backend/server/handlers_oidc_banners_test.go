package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/config"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/security"
)

func TestValidateOIDCProviderInput(t *testing.T) {
	tests := []struct {
		name    string
		slug    string
		issuer  string
		wantErr bool
	}{
		{name: "valid", slug: "company-sso", issuer: "https://login.example.com", wantErr: false},
		{name: "invalid slug", slug: "company/sso", issuer: "https://login.example.com", wantErr: true},
		{name: "relative issuer", slug: "company-sso", issuer: "/issuer", wantErr: true},
		{name: "missing scopes", slug: "company-sso", issuer: "https://login.example.com", wantErr: true},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			err := validateOIDCProviderInput("Company SSO", testCase.slug, testCase.issuer, "client-id", map[bool]string{true: "openid", false: ""}[testCase.name == "valid"])
			if (err != nil) != testCase.wantErr {
				t.Fatalf("validateOIDCProviderInput() error = %v, wantErr %v", err, testCase.wantErr)
			}
		})
	}
}

func TestValidatePlatformBanner(t *testing.T) {
	start := time.Date(2026, time.August, 14, 12, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	if err := validatePlatformBanner("Scheduled maintenance", "warning", "https://status.example.com", start, &end); err != nil {
		t.Fatalf("valid banner rejected: %v", err)
	}
	if err := validatePlatformBanner("", "warning", "", start, nil); err == nil {
		t.Fatal("empty banner message was accepted")
	}
	if err := validatePlatformBanner("message", "warning", "javascript:alert(1)", start, nil); err == nil {
		t.Fatal("unsafe banner link was accepted")
	}
	if err := validatePlatformBanner("message", "warning", "", start, &start); err == nil {
		t.Fatal("non-increasing banner window was accepted")
	}
}

func TestSafeOIDCNextRejectsExternalAndControlCharacterTargets(t *testing.T) {
	for _, value := range []string{"https://attacker.example", "//attacker.example", "\\\\attacker", "/safe\nheader"} {
		if got := safeOIDCNext(value); got != "/" {
			t.Fatalf("safeOIDCNext(%q) = %q, want /", value, got)
		}
	}
	if got := safeOIDCNext("/admin?tab=authentication"); got != "/admin?tab=authentication" {
		t.Fatalf("safeOIDCNext() = %q", got)
	}
}

func TestOIDCIdentityClaimsRequireMatchingNonce(t *testing.T) {
	claims := oidcIdentityClaims{Subject: "subject", Email: "user@example.com", Nonce: "nonce"}
	if !validOIDCIdentityClaims(claims, "nonce") {
		t.Fatal("valid OIDC claims were rejected")
	}
	for _, invalid := range []oidcIdentityClaims{
		{Subject: "", Email: "user@example.com", Nonce: "nonce"},
		{Subject: "subject", Email: "", Nonce: "nonce"},
		{Subject: "subject", Email: "user@example.com", Nonce: "wrong"},
	} {
		if validOIDCIdentityClaims(invalid, "nonce") {
			t.Fatalf("invalid OIDC claims were accepted: %+v", invalid)
		}
	}
}

func TestOIDCIdentityProvisionRequiresVerifiedEmailForNewIdentity(t *testing.T) {
	if oidcIdentityMayProvision(false, false) {
		t.Fatal("unverified email was allowed to provision a new identity")
	}
	if !oidcIdentityMayProvision(false, true) {
		t.Fatal("verified email was rejected for a new identity")
	}
	if !oidcIdentityMayProvision(true, false) {
		t.Fatal("an existing linked identity should remain usable")
	}
}

func TestOIDCCallbackRejectsMissingExpiredOrReplayedState(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	query := "SELECT p.id, p.slug, p.display_name, p.issuer, p.client_id, p.client_secret_ciphertext, p.scopes, p.enabled, p.last_error, s.nonce, s.code_verifier, s.next_path"
	for _, state := range []string{"expired-state", "replayed-state"} {
		mock.ExpectBegin()
		mock.ExpectQuery(regexp.QuoteMeta(query)).WithArgs(state).WillReturnError(sql.ErrNoRows)
		mock.ExpectRollback()
		recorder := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(recorder)
		context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/callback?state="+state+"&code=code", nil)
		(&App{DB: db}).oidcCallback(context)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("state %q returned %d, want 400", state, recorder.Code)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalPasswordAuthKeepsPlatformAdminBreakGlass(t *testing.T) {
	settings := platformSettings{LocalAuthEnabled: false}
	regular := models.User{}
	admin := models.User{PlatformAdmin: true}
	if localPasswordAuthAllowed(settings, regular) {
		t.Fatal("regular password authentication remained enabled")
	}
	if !localPasswordAuthAllowed(settings, admin) {
		t.Fatal("platform-admin break-glass password authentication was disabled")
	}
}

func TestLoginReturnsFeatureDisabledForRegularUserWhenLocalAuthIsOff(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	userID := uuid.New()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id, email, display_name, is_platform_admin, password_hash")).WithArgs("user@example.com").WillReturnRows(
		sqlmock.NewRows([]string{"id", "email", "display_name", "is_platform_admin", "password_hash", "status", "session_version"}).AddRow(userID, "user@example.com", "User", false, "password-hash", "active", 0),
	)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT login_enabled, local_auth_enabled")).WillReturnRows(
		sqlmock.NewRows([]string{"login_enabled", "local_auth_enabled", "signup_enabled", "ai_enabled", "voice_enabled", "transcription_enabled", "mcp_enabled", "knowledge_enabled", "attachments_enabled", "maintenance_message", "updated_by", "updated_at"}).AddRow(true, false, true, true, true, true, true, true, true, "", nil, nil),
	)

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"user@example.com","password":"password"}`))
	context.Request.Header.Set("Content-Type", "application/json")
	(&App{DB: db}).login(context)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "Local password authentication is disabled") {
		t.Fatalf("expected a clear feature-disabled response, got %s", recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAuthConfigIncludesProviderSummariesAndActiveBannersWithoutSecrets(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	providerID := uuid.New()
	bannerID := uuid.New()
	now := time.Now().UTC().Truncate(time.Microsecond)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT login_enabled, local_auth_enabled")).WillReturnRows(
		sqlmock.NewRows([]string{"login_enabled", "local_auth_enabled", "signup_enabled", "ai_enabled", "voice_enabled", "transcription_enabled", "mcp_enabled", "knowledge_enabled", "attachments_enabled", "maintenance_message", "updated_by", "updated_at"}).AddRow(true, false, true, true, true, true, true, true, true, "", nil, nil),
	)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id, slug, display_name, issuer")).WillReturnRows(
		sqlmock.NewRows([]string{"id", "slug", "display_name", "issuer", "client_id", "client_secret_ciphertext", "scopes", "enabled", "last_tested_at", "last_error"}).AddRow(providerID, "company", "Company SSO", "https://login.example.com", "client-id", []byte("encrypted-secret"), "openid profile email", true, nil, ""),
	)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id, message, severity")).WillReturnRows(
		sqlmock.NewRows([]string{"id", "message", "severity", "coalesce", "priority", "enabled", "dismissible", "starts_at", "ends_at", "created_at", "updated_at"}).AddRow(bannerID, "Maintenance tonight", "warning", "", 10, true, true, now.Add(-time.Hour), nil, now, now),
	)

	app := &App{DB: db}
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/config", nil)
	app.authConfig(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "encrypted-secret") || strings.Contains(recorder.Body.String(), "clientSecret") {
		t.Fatalf("auth config leaked provider secret: %s", recorder.Body.String())
	}
	var response struct {
		Providers []oidcProviderPublic `json:"oidcProviders"`
		LocalAuth bool                 `json:"localAuthEnabled"`
		Banners   []platformBanner     `json:"banners"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Providers) != 1 || response.Providers[0].Slug != "company" {
		t.Fatalf("unexpected provider summaries: %+v", response.Providers)
	}
	if response.LocalAuth {
		t.Fatal("local auth setting was not returned")
	}
	if len(response.Banners) != 1 || response.Banners[0].ID != bannerID {
		t.Fatalf("unexpected active banners: %+v", response.Banners)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateOIDCProviderEncryptsSecretAndReturnsRedactedMetadata(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	userID := uuid.New()
	providerID := uuid.New()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO oidc_providers (id, slug, display_name, issuer, client_id, client_secret_ciphertext, scopes, enabled, created_by, updated_by)")).WithArgs(
		sqlmock.AnyArg(), "company", "Company SSO", "https://login.example.com", "client-id", sqlmock.AnyArg(), "openid profile email", true, userID,
	).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO audit_events (user_id, organization_id, action, resource_type, resource_id, details)")).WithArgs(
		userID, nil, "platform.oidc_provider.created", "oidc_provider", sqlmock.AnyArg(), sqlmock.AnyArg(),
	).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id, slug, display_name, issuer, client_id, client_secret_ciphertext")).WithArgs("company").WillReturnRows(
		sqlmock.NewRows([]string{"id", "slug", "display_name", "issuer", "client_id", "client_secret_ciphertext", "scopes", "enabled", "last_tested_at", "last_error"}).AddRow(providerID, "company", "Company SSO", "https://login.example.com", "client-id", []byte("encrypted-secret"), "openid profile email", true, nil, ""),
	)

	app := &App{
		DB:      db,
		Config:  config.Config{OIDC: config.OIDCConfig{RedirectURL: "http://localhost:8080/api/v1/auth/oidc/callback"}},
		Secrets: security.NewSecretBox([]byte("01234567890123456789012345678901")),
	}
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodPost, "/api/v1/admin/oidc/providers", strings.NewReader(`{"slug":"company","displayName":"Company SSO","issuer":"https://login.example.com/","clientId":"client-id","clientSecret":"super-secret"}`))
	context.Request.Header.Set("Content-Type", "application/json")
	context.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID, PlatformAdmin: true})
	app.createPlatformOIDCProvider(context)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "super-secret") || strings.Contains(recorder.Body.String(), "clientSecret") {
		t.Fatalf("provider response leaked secret: %s", recorder.Body.String())
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(`"secretConfigured":true`)) {
		t.Fatalf("provider response did not report configured secret: %s", recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestImportLegacyOIDCProviderIsIdempotent(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{
		DB: db,
		Config: config.Config{OIDC: config.OIDCConfig{
			Issuer:       "https://legacy.example.com",
			ClientID:     "legacy-client",
			ClientSecret: "legacy-secret",
			RedirectURL:  "http://localhost:8080/api/v1/auth/oidc/callback",
		}},
		Secrets: security.NewSecretBox([]byte("01234567890123456789012345678901")),
	}
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id FROM oidc_providers WHERE issuer = $1")).WithArgs("https://legacy.example.com").WillReturnError(sql.ErrNoRows)
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO oidc_providers (slug, display_name, issuer, client_id, client_secret_ciphertext, scopes, enabled)")).WithArgs(
		"OIDC", "https://legacy.example.com", "legacy-client", sqlmock.AnyArg(), "openid profile email",
	).WillReturnResult(sqlmock.NewResult(0, 1))
	if err := app.ImportLegacyOIDCProvider(context.Background()); err != nil {
		t.Fatal(err)
	}
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id FROM oidc_providers WHERE issuer = $1")).WithArgs("https://legacy.example.com").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(uuid.New()))
	if err := app.ImportLegacyOIDCProvider(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAdminOIDCAndBannerEndpointsRequirePlatformAdmin(t *testing.T) {
	for _, handler := range []func(*gin.Context){
		(&App{}).listPlatformOIDCProviders,
		(&App{}).listPlatformBanners,
	} {
		recorder := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(recorder)
		context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/admin", nil)
		handler(context)
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("expected platform-admin authorization failure, got %d", recorder.Code)
		}
	}
}
