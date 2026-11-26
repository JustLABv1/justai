package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/provider"
)

// Webhooks deliver a user's notifications to other tools: as signed JSON for their own
// systems (n8n, Zapier, scripts), or as a ready message for Slack, Microsoft Teams
// (Workflows), Mattermost and Discord.

const (
	webhookMaxPerUser = 5
	// After this many failures in a row a webhook is turned off; the user sees why.
	webhookMaxFailures = 20
	webhookTimeout     = 10 * time.Second
)

var webhookFormats = map[string]bool{"json": true, "slack": true, "mattermost": true, "teams": true, "discord": true}

// webhookMessage is what every format is built from.
type webhookMessage struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	URL       string    `json:"url"`
	LinkLabel string    `json:"-"`
	CreatedAt time.Time `json:"createdAt"`
}

// webhookPayload renders the message for a format.
func webhookPayload(format string, msg webhookMessage) ([]byte, error) {
	switch format {
	case "slack":
		text := "*" + msg.Title + "*"
		if msg.Body != "" {
			text += "\n" + msg.Body
		}
		if msg.URL != "" {
			text += "\n<" + msg.URL + "|" + msg.LinkLabel + ">"
		}
		return marshalPlain(map[string]any{"text": text})
	case "mattermost":
		// Mattermost renders Markdown; a link is [label](url).
		escape := strings.NewReplacer("[", "\\[", "]", "\\]")
		text := "**" + msg.Title + "**"
		if msg.Body != "" {
			text += "\n" + msg.Body
		}
		if msg.URL != "" {
			text += "\n[" + escape.Replace(msg.LinkLabel) + "](" + msg.URL + ")"
		}
		return marshalPlain(map[string]any{"text": text, "username": "JustAI"})
	case "teams":
		body := []map[string]any{{"type": "TextBlock", "text": msg.Title, "weight": "Bolder", "size": "Medium", "wrap": true}}
		if msg.Body != "" {
			body = append(body, map[string]any{"type": "TextBlock", "text": msg.Body, "wrap": true})
		}
		card := map[string]any{"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard", "version": "1.4", "body": body}
		if msg.URL != "" {
			card["actions"] = []map[string]any{{"type": "Action.OpenUrl", "title": msg.LinkLabel, "url": msg.URL}}
		}
		return marshalPlain(map[string]any{"type": "message", "attachments": []map[string]any{{"contentType": "application/vnd.microsoft.card.adaptive", "content": card}}})
	case "discord":
		embed := map[string]any{"title": truncateRunes(msg.Title, 256), "description": truncateRunes(msg.Body, 4000)}
		if msg.URL != "" {
			embed["url"] = msg.URL
		}
		return marshalPlain(map[string]any{"embeds": []map[string]any{embed}, "allowed_mentions": map[string]any{"parse": []string{}}})
	default:
		return marshalPlain(msg)
	}
}

// marshalPlain encodes JSON without escaping <, > and &, which Slack link syntax uses.
func marshalPlain(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

// webhookSignature signs "<timestamp>.<body>", so a receiver can check origin and
// reject replays.
func webhookSignature(secret string, timestamp int64, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(timestamp, 10) + "."))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func (a *App) webhookClient() *http.Client {
	client := provider.SafeHTTPClient(webhookTimeout, a.Config.AllowPrivate)
	// A webhook answers where it was set up; following a redirect could post elsewhere.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client
}

// postWebhook sends one message. It returns an error that is safe to show the user.
func (a *App) postWebhook(ctx context.Context, format, target, secret string, msg webhookMessage) error {
	if err := provider.ValidateRequestURL(target, a.Config.AllowPrivate); err != nil {
		return errors.New("the webhook address is not allowed")
	}
	body, err := webhookPayload(format, msg)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return errors.New("the webhook address is invalid")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "JustAI-Webhook/1")
	if format == "json" {
		timestamp := time.Now().Unix()
		request.Header.Set("X-JustAI-Event", msg.Type)
		request.Header.Set("X-JustAI-Delivery", msg.ID)
		request.Header.Set("X-JustAI-Timestamp", strconv.FormatInt(timestamp, 10))
		if secret != "" {
			request.Header.Set("X-JustAI-Signature", webhookSignature(secret, timestamp, body))
		}
	}
	response, err := a.webhookClient().Do(request)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) && urlErr.Timeout() {
			return errors.New("the webhook did not answer in time")
		}
		return errors.New("the webhook could not be reached")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("the webhook answered with HTTP %d", response.StatusCode)
	}
	return nil
}

type storedWebhook struct {
	ID     uuid.UUID
	Format string
	URL    string
	Secret string
}

func (a *App) loadWebhook(ciphertext, secretCiphertext []byte) (string, string, error) {
	target, err := a.Secrets.Decrypt(ciphertext)
	if err != nil {
		return "", "", err
	}
	secret := ""
	if len(secretCiphertext) > 0 {
		if secret, err = a.Secrets.Decrypt(secretCiphertext); err != nil {
			return "", "", err
		}
	}
	return target, secret, nil
}

// recordWebhookResult keeps the last outcome and turns off a webhook that keeps failing.
func (a *App) recordWebhookResult(ctx context.Context, id uuid.UUID, sendErr error) {
	if sendErr == nil {
		_, _ = a.DB.ExecContext(ctx, `UPDATE notification_webhooks SET last_success_at = now(), failure_count = 0 WHERE id = $1`, id)
		return
	}
	_, _ = a.DB.ExecContext(ctx, `UPDATE notification_webhooks SET last_error = $2, last_error_at = now(), failure_count = failure_count + 1,
		enabled = enabled AND failure_count + 1 < $3 WHERE id = $1`, id, truncateRunes(sendErr.Error(), 300), webhookMaxFailures)
}

// deliverWebhooks posts a notification to every enabled webhook of the user and returns
// how many accepted it.
func (a *App) deliverWebhooks(ctx context.Context, userID uuid.UUID, msg webhookMessage) int {
	if a.Secrets == nil {
		return 0
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT id, format, url_ciphertext, secret_ciphertext FROM notification_webhooks WHERE user_id = $1 AND enabled`, userID)
	if err != nil {
		return 0
	}
	var hooks []storedWebhook
	for rows.Next() {
		var hook storedWebhook
		var urlCiphertext, secretCiphertext []byte
		if rows.Scan(&hook.ID, &hook.Format, &urlCiphertext, &secretCiphertext) != nil {
			continue
		}
		if hook.URL, hook.Secret, err = a.loadWebhook(urlCiphertext, secretCiphertext); err != nil {
			a.recordWebhookResult(ctx, hook.ID, errors.New("the webhook could not be decrypted; enter its address again"))
			continue
		}
		hooks = append(hooks, hook)
	}
	rows.Close()
	sent := 0
	for _, hook := range hooks {
		err := a.postWebhook(ctx, hook.Format, hook.URL, hook.Secret, msg)
		if err != nil {
			slog.Warn("notification webhook failed", "webhookId", hook.ID, "error", err)
		} else {
			sent++
		}
		a.recordWebhookResult(ctx, hook.ID, err)
	}
	return sent
}

// ---- HTTP ----

type webhookResponse struct {
	ID            uuid.UUID  `json:"id"`
	Name          string     `json:"name"`
	Format        string     `json:"format"`
	URLHint       string     `json:"urlHint"`
	Enabled       bool       `json:"enabled"`
	Signed        bool       `json:"signed"`
	CreatedAt     time.Time  `json:"createdAt"`
	LastSuccessAt *time.Time `json:"lastSuccessAt,omitempty"`
	LastError     string     `json:"lastError,omitempty"`
	LastErrorAt   *time.Time `json:"lastErrorAt,omitempty"`
	FailureCount  int        `json:"failureCount"`
	// Secret is shown once, when a json webhook is created.
	Secret string `json:"secret,omitempty"`
}

const webhookColumns = `id, name, format, url_hint, enabled, secret_ciphertext IS NOT NULL, created_at, last_success_at, last_error, last_error_at, failure_count`

func scanWebhook(scan func(...any) error) (webhookResponse, error) {
	var w webhookResponse
	var success, errorAt sql.NullTime
	if err := scan(&w.ID, &w.Name, &w.Format, &w.URLHint, &w.Enabled, &w.Signed, &w.CreatedAt, &success, &w.LastError, &errorAt, &w.FailureCount); err != nil {
		return w, err
	}
	if success.Valid {
		w.LastSuccessAt = &success.Time
	}
	if errorAt.Valid {
		w.LastErrorAt = &errorAt.Time
	}
	return w, nil
}

func (a *App) listWebhooks(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	rows, err := a.DB.QueryContext(c, `SELECT `+webhookColumns+` FROM notification_webhooks WHERE user_id = $1 ORDER BY created_at`, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	items := []webhookResponse{}
	for rows.Next() {
		item, err := scanWebhook(rows.Scan)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		items = append(items, item)
	}
	c.JSON(http.StatusOK, gin.H{"webhooks": items, "max": webhookMaxPerUser})
}

// checkWebhookTarget validates an address the user entered.
func (a *App) checkWebhookTarget(raw string) (string, string, error) {
	target := strings.TrimSpace(raw)
	parsed, err := url.Parse(target)
	if err != nil || parsed.Host == "" || parsed.User != nil || len(target) > 2048 || (parsed.Scheme != "https" && !(a.Config.AllowPrivate && parsed.Scheme == "http")) {
		return "", "", errors.New("the webhook address must be an https URL")
	}
	if err := provider.ValidateRequestURL(target, a.Config.AllowPrivate); err != nil {
		return "", "", errors.New("the webhook address must point to a public host")
	}
	return target, parsed.Hostname(), nil
}

func (a *App) createWebhook(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	var request struct {
		Name   string `json:"name"`
		Format string `json:"format"`
		URL    string `json:"url"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	name := strings.TrimSpace(request.Name)
	if name == "" || len([]rune(name)) > 80 || !webhookFormats[request.Format] {
		writeError(c, http.StatusBadRequest, fmt.Errorf("give a name of up to 80 characters and a format: json, slack, mattermost, teams or discord"))
		return
	}
	target, hint, err := a.checkWebhookTarget(request.URL)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var count int
	_ = a.DB.QueryRowContext(c, `SELECT COUNT(*) FROM notification_webhooks WHERE user_id = $1`, principal.UserID).Scan(&count)
	if count >= webhookMaxPerUser {
		writeError(c, http.StatusConflict, fmt.Errorf("you can add up to %d webhooks", webhookMaxPerUser))
		return
	}
	if a.Secrets == nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("the secret store is unavailable"))
		return
	}
	urlCiphertext, err := a.Secrets.Encrypt(target)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	secret := ""
	var secretCiphertext []byte
	if request.Format == "json" {
		raw := make([]byte, 32)
		_, _ = rand.Read(raw)
		secret = "whsec_" + hex.EncodeToString(raw)
		if secretCiphertext, err = a.Secrets.Encrypt(secret); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	row := a.DB.QueryRowContext(c, `INSERT INTO notification_webhooks (user_id, name, format, url_ciphertext, url_hint, secret_ciphertext)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING `+webhookColumns, principal.UserID, name, request.Format, urlCiphertext, hint, secretCiphertext)
	item, err := scanWebhook(row.Scan)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.Secret = secret
	c.JSON(http.StatusCreated, item)
}

// updateWebhook: PATCH {"name"?, "enabled"?, "url"?}. Turning one back on clears its
// failure count.
func (a *App) updateWebhook(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid webhook id"))
		return
	}
	var request struct {
		Name    *string `json:"name"`
		Enabled *bool   `json:"enabled"`
		URL     *string `json:"url"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	var name sql.NullString
	if request.Name != nil {
		value := strings.TrimSpace(*request.Name)
		if value == "" || len([]rune(value)) > 80 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("the name must be 1 to 80 characters"))
			return
		}
		name = sql.NullString{String: value, Valid: true}
	}
	var urlCiphertext []byte
	var hint sql.NullString
	if request.URL != nil {
		target, host, err := a.checkWebhookTarget(*request.URL)
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
		if urlCiphertext, err = a.Secrets.Encrypt(target); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		hint = sql.NullString{String: host, Valid: true}
	}
	row := a.DB.QueryRowContext(c, `UPDATE notification_webhooks SET name = COALESCE($3::text, name), url_ciphertext = COALESCE($4::bytea, url_ciphertext), url_hint = COALESCE($5::text, url_hint),
		enabled = COALESCE($6::boolean, enabled), failure_count = CASE WHEN $6::boolean THEN 0 ELSE failure_count END
		WHERE id = $1 AND user_id = $2 RETURNING `+webhookColumns, id, principal.UserID, name, urlCiphertext, hint, request.Enabled)
	item, err := scanWebhook(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(c, http.StatusNotFound, fmt.Errorf("webhook not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (a *App) deleteWebhook(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid webhook id"))
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM notification_webhooks WHERE id = $1 AND user_id = $2`, id, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// testWebhook posts a sample message and reports the outcome.
func (a *App) testWebhook(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid webhook id"))
		return
	}
	var format string
	var urlCiphertext, secretCiphertext []byte
	if err := a.DB.QueryRowContext(c, `SELECT format, url_ciphertext, secret_ciphertext FROM notification_webhooks WHERE id = $1 AND user_id = $2`, id, principal.UserID).Scan(&format, &urlCiphertext, &secretCiphertext); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("webhook not found"))
		return
	}
	target, secret, err := a.loadWebhook(urlCiphertext, secretCiphertext)
	if err != nil {
		writeError(c, http.StatusConflict, fmt.Errorf("the webhook could not be decrypted; enter its address again"))
		return
	}
	var locale string
	_ = a.DB.QueryRowContext(c, `SELECT locale FROM notification_settings WHERE user_id = $1`, principal.UserID).Scan(&locale)
	msg := webhookMessage{ID: uuid.NewString(), Type: "test", Title: "JustAI test notification", Body: "Notifications reach you here.", URL: a.publicLink(c, "/"), LinkLabel: "Open JustAI", CreatedAt: time.Now().UTC()}
	if strings.HasPrefix(locale, "de") {
		msg.Title, msg.Body, msg.LinkLabel = "JustAI-Testbenachrichtigung", "Benachrichtigungen kommen hier an.", "JustAI öffnen"
	}
	sendErr := a.postWebhook(c, format, target, secret, msg)
	a.recordWebhookResult(c, id, sendErr)
	if sendErr != nil {
		writeError(c, http.StatusBadGateway, sendErr)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
