package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"justai-backend/config"
	"justai-backend/middleware"
)

// Outgoing e-mail and the public address for links can be set by a platform admin.
// Values from the server configuration (config.yaml, JUSTAI_SMTP_*, JUSTAI_PUBLIC_URL)
// take precedence, so a deployment can pin them; the admin page then shows them read-only.

// effectiveSMTP returns the SMTP setup in use. An empty Host means e-mail is off.
func (a *App) effectiveSMTP(ctx context.Context) config.SMTPConfig {
	if a.Config.SMTP.Host != "" {
		return a.Config.SMTP
	}
	var enabled bool
	var result config.SMTPConfig
	var password []byte
	if err := a.DB.QueryRowContext(ctx, `SELECT enabled, host, port, username, password_ciphertext, from_address, security FROM platform_email_settings WHERE id`).
		Scan(&enabled, &result.Host, &result.Port, &result.Username, &password, &result.From, &result.Security); err != nil || !enabled {
		return config.SMTPConfig{}
	}
	if len(password) > 0 && a.Secrets != nil {
		value, err := a.Secrets.Decrypt(password)
		if err != nil {
			return config.SMTPConfig{} // the encryption key changed; the admin must enter it again
		}
		result.Password = value
	}
	if config.ValidateSMTP(result) != nil {
		return config.SMTPConfig{}
	}
	return result
}

// effectivePublicURL is where people open JustAI: configuration, then the admin
// setting, then the first frontend origin.
func (a *App) effectivePublicURL(ctx context.Context) string {
	if a.Config.PublicURL != "" {
		return a.Config.PublicURL
	}
	var stored string
	_ = a.DB.QueryRowContext(ctx, `SELECT public_url FROM platform_email_settings WHERE id`).Scan(&stored)
	if stored != "" {
		return stored
	}
	if len(a.Config.FrontendOrigins) > 0 {
		return strings.TrimRight(a.Config.FrontendOrigins[0], "/")
	}
	return ""
}

type emailSettingsResponse struct {
	Enabled        bool       `json:"enabled"`
	Host           string     `json:"host"`
	Port           int        `json:"port"`
	Username       string     `json:"username"`
	PasswordSet    bool       `json:"passwordSet"`
	From           string     `json:"from"`
	Security       string     `json:"security"`
	PublicURL      string     `json:"publicUrl"`
	SMTPFromConfig bool       `json:"smtpFromConfig"`
	URLFromConfig  bool       `json:"publicUrlFromConfig"`
	DefaultURL     string     `json:"defaultPublicUrl"`
	LastTestedAt   *time.Time `json:"lastTestedAt,omitempty"`
	LastError      string     `json:"lastError,omitempty"`
}

func (a *App) loadEmailSettings(ctx context.Context) (emailSettingsResponse, error) {
	var r emailSettingsResponse
	var password []byte
	var tested sql.NullTime
	err := a.DB.QueryRowContext(ctx, `SELECT enabled, host, port, username, password_ciphertext, from_address, security, public_url, last_tested_at, last_error FROM platform_email_settings WHERE id`).
		Scan(&r.Enabled, &r.Host, &r.Port, &r.Username, &password, &r.From, &r.Security, &r.PublicURL, &tested, &r.LastError)
	if err != nil {
		return r, err
	}
	r.PasswordSet = len(password) > 0
	if tested.Valid {
		r.LastTestedAt = &tested.Time
	}
	if len(a.Config.FrontendOrigins) > 0 {
		r.DefaultURL = strings.TrimRight(a.Config.FrontendOrigins[0], "/")
	}
	// Show what the configuration pins; its password never leaves the server.
	if a.Config.SMTP.Host != "" {
		cfg := a.Config.SMTP
		r.SMTPFromConfig, r.Enabled, r.Host, r.Port, r.Username, r.From, r.Security = true, true, cfg.Host, cfg.Port, cfg.Username, cfg.From, cfg.Security
		r.PasswordSet = cfg.Password != ""
	}
	if a.Config.PublicURL != "" {
		r.URLFromConfig, r.PublicURL = true, a.Config.PublicURL
	}
	return r, nil
}

func (a *App) getPlatformEmailSettings(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	settings, err := a.loadEmailSettings(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, settings)
}

func (a *App) putPlatformEmailSettings(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	var request struct {
		Enabled       bool    `json:"enabled"`
		Host          string  `json:"host"`
		Port          int     `json:"port"`
		Username      string  `json:"username"`
		Password      *string `json:"password"` // nil or "" keeps the stored one
		ClearPassword bool    `json:"clearPassword"`
		From          string  `json:"from"`
		Security      string  `json:"security"`
		PublicURL     string  `json:"publicUrl"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	candidate := config.SMTPConfig{
		Host:     strings.TrimSpace(request.Host),
		Port:     request.Port,
		Username: strings.TrimSpace(request.Username),
		From:     strings.TrimSpace(request.From),
		Security: strings.ToLower(strings.TrimSpace(request.Security)),
	}
	if candidate.Port == 0 {
		candidate.Port = 587
	}
	if candidate.Security == "" {
		candidate.Security = "starttls"
	}
	// A disabled setup may be incomplete; an enabled one must work.
	if a.Config.SMTP.Host == "" && (request.Enabled || candidate.Host != "") {
		if err := config.ValidateSMTP(candidate); err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
	}
	publicURL := strings.TrimRight(strings.TrimSpace(request.PublicURL), "/")
	if publicURL != "" {
		if parsed, err := url.Parse(publicURL); err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("the public address must be an absolute http(s) URL"))
			return
		}
	}
	var ciphertext []byte
	keepPassword := !request.ClearPassword && (request.Password == nil || *request.Password == "")
	if !keepPassword && !request.ClearPassword {
		if a.Secrets == nil {
			writeError(c, http.StatusInternalServerError, fmt.Errorf("the secret store is unavailable"))
			return
		}
		encrypted, err := a.Secrets.Encrypt(*request.Password)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		ciphertext = encrypted
	}
	principal, _ := middleware.GetPrincipal(c)
	if a.Config.SMTP.Host != "" {
		// SMTP is pinned by the configuration; only the public address can change here.
		if _, err := a.DB.ExecContext(c, `UPDATE platform_email_settings SET public_url = $1, updated_by = $2, updated_at = now() WHERE id`, publicURL, principal.UserID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		a.writePlatformAudit(c, "platform.email_settings.updated", "platform_email_settings", nil, gin.H{"publicUrl": publicURL})
		settings, err := a.loadEmailSettings(c)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		c.JSON(http.StatusOK, settings)
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE platform_email_settings SET enabled = $1, host = $2, port = $3, username = $4,
		password_ciphertext = CASE WHEN $5 THEN password_ciphertext ELSE $6 END, from_address = $7, security = $8, public_url = $9,
		updated_by = $10, updated_at = now(), last_tested_at = NULL, last_error = '' WHERE id`,
		request.Enabled, candidate.Host, candidate.Port, candidate.Username, keepPassword, ciphertext, candidate.From, candidate.Security, publicURL, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.email_settings.updated", "platform_email_settings", nil, gin.H{"enabled": request.Enabled, "host": candidate.Host, "passwordChanged": !keepPassword})
	settings, err := a.loadEmailSettings(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, settings)
}

// testPlatformEmailSettings sends a test e-mail with the settings in use to the admin.
func (a *App) testPlatformEmailSettings(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	smtp := a.effectiveSMTP(c)
	if smtp.Host == "" {
		writeError(c, http.StatusConflict, fmt.Errorf("e-mail is not set up or turned off"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	var email string
	if err := a.DB.QueryRowContext(c, `SELECT email FROM users WHERE id = $1`, principal.UserID).Scan(&email); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	sendErr := sendMail(smtp, mailMessage{
		To:        email,
		Subject:   "JustAI: test e-mail / Test-E-Mail",
		Text:      "E-mail from JustAI works.\nE-Mails von JustAI kommen an.",
		LinkLabel: "JustAI",
		Link:      a.effectivePublicURL(c),
	})
	lastError := ""
	if sendErr != nil {
		lastError = sendErr.Error()
	}
	_, _ = a.DB.ExecContext(c, `UPDATE platform_email_settings SET last_tested_at = now(), last_error = $1 WHERE id`, lastError)
	if sendErr != nil {
		writeError(c, http.StatusBadGateway, fmt.Errorf("the test e-mail failed: %w", sendErr))
		return
	}
	c.JSON(http.StatusOK, gin.H{"sentTo": email})
}
