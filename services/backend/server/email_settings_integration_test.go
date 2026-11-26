package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/config"
	"justai-backend/middleware"
	"justai-backend/security"
)

func TestPlatformEmailSettingsIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	gin.SetMode(gin.TestMode)
	admin := uuid.New()
	if _, err := db.ExecContext(ctx, `INSERT INTO users (id, email, display_name, is_platform_admin) VALUES ($1, 'admin@example.org', 'Admin', TRUE)`, admin); err != nil {
		t.Fatal(err)
	}
	a := &App{DB: db, Secrets: security.NewSecretBox(bytes.Repeat([]byte{7}, 32)), Config: config.Config{FrontendOrigins: []string{"http://localhost:3000"}}}

	put := func(isAdmin bool, body map[string]any) (int, emailSettingsResponse) {
		raw, _ := json.Marshal(body)
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPut, "/api/v1/admin/email", bytes.NewReader(raw))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: admin, PlatformAdmin: isAdmin})
		a.putPlatformEmailSettings(c)
		var result emailSettingsResponse
		_ = json.Unmarshal(recorder.Body.Bytes(), &result)
		return recorder.Code, result
	}

	if code, _ := put(false, map[string]any{"enabled": false}); code != http.StatusForbidden {
		t.Fatalf("a non-admin could change e-mail settings: %d", code)
	}
	if code, _ := put(true, map[string]any{"enabled": true, "host": "smtp.example.org", "port": 587, "from": "not an address"}); code != http.StatusBadRequest {
		t.Fatalf("an invalid sender was saved: %d", code)
	}
	code, saved := put(true, map[string]any{"enabled": true, "host": "smtp.example.org", "port": 465, "username": "justai", "password": "s3cret", "from": "JustAI <justai@example.org>", "security": "tls", "publicUrl": "https://justai.example.org/"})
	if code != http.StatusOK || !saved.PasswordSet || saved.PublicURL != "https://justai.example.org" {
		t.Fatalf("save = %d %+v", code, saved)
	}
	var stored []byte
	_ = db.QueryRowContext(ctx, `SELECT password_ciphertext FROM platform_email_settings`).Scan(&stored)
	if bytes.Contains(stored, []byte("s3cret")) {
		t.Fatal("the password is stored in plain text")
	}
	if smtp := a.effectiveSMTP(ctx); smtp.Host != "smtp.example.org" || smtp.Password != "s3cret" || smtp.Port != 465 || smtp.Security != "tls" {
		t.Fatalf("effective SMTP = %+v", smtp)
	}
	if got := a.effectivePublicURL(ctx); got != "https://justai.example.org" {
		t.Fatalf("public URL = %s", got)
	}

	// Saving without a password keeps the stored one; turning e-mail off stops it.
	if code, _ := put(true, map[string]any{"enabled": false, "host": "smtp.example.org", "port": 465, "username": "justai", "from": "JustAI <justai@example.org>", "security": "tls"}); code != http.StatusOK {
		t.Fatalf("disable = %d", code)
	}
	if smtp := a.effectiveSMTP(ctx); smtp.Host != "" {
		t.Fatalf("disabled e-mail is still used: %+v", smtp)
	}
	if _, saved = put(true, map[string]any{"enabled": true, "host": "smtp.example.org", "port": 465, "username": "justai", "from": "JustAI <justai@example.org>", "security": "tls"}); !saved.PasswordSet || a.effectiveSMTP(ctx).Password != "s3cret" {
		t.Fatalf("the password was lost: %+v", saved)
	}
	if got := a.effectivePublicURL(ctx); got != "http://localhost:3000" {
		t.Fatalf("cleared public URL falls back to %s", got)
	}

	// The server configuration wins and is shown as such, without its password.
	a.Config.SMTP = config.SMTPConfig{Host: "mail.pinned.example", Port: 587, Username: "pinned", Password: "from-env", From: "ops@pinned.example", Security: "starttls"}
	a.Config.PublicURL = "https://pinned.example"
	settings, err := a.loadEmailSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(settings)
	if !settings.SMTPFromConfig || !settings.URLFromConfig || settings.Host != "mail.pinned.example" || bytes.Contains(raw, []byte("from-env")) {
		t.Fatalf("pinned settings = %s", raw)
	}
	if a.effectiveSMTP(ctx).Host != "mail.pinned.example" || a.effectivePublicURL(ctx) != "https://pinned.example" {
		t.Fatal("the configuration did not take precedence")
	}
}
