package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/config"
	"justai-backend/middleware"
	"justai-backend/security"
)

func TestWebhookPayloadFormats(t *testing.T) {
	msg := webhookMessage{ID: "n1", Type: "topic_done", Title: "„Landwirtschaft“ ist fertig", Body: "Transkript bereit.", URL: "https://justai.example.org/x", LinkLabel: "Thema öffnen"}
	for format, want := range map[string]string{
		"json":       `"type":"topic_done"`,
		"slack":      `<https://justai.example.org/x|Thema öffnen>`,
		"teams":      `"contentType":"application/vnd.microsoft.card.adaptive"`,
		"mattermost": `"text":"**„Landwirtschaft“ ist fertig**\nTranskript bereit.\n[Thema öffnen](https://justai.example.org/x)"`,
		"discord":    `"allowed_mentions":{"parse":[]}`,
	} {
		raw, err := webhookPayload(format, msg)
		if err != nil || !json.Valid(raw) || !strings.Contains(string(raw), want) {
			t.Errorf("%s: %s (%v)", format, raw, err)
		}
	}
	// The signature covers the timestamp, so a replay with another time fails.
	if webhookSignature("whsec_x", 1700000000, []byte(`{"a":1}`)) == webhookSignature("whsec_x", 1700000001, []byte(`{"a":1}`)) {
		t.Fatal("the timestamp is not signed")
	}
}

func TestWebhooksDeliverAndProtectIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	gin.SetMode(gin.TestMode)

	var mu sync.Mutex
	var received []*http.Request
	var bodies [][]byte
	status := http.StatusOK
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		received, bodies = append(received, r), append(bodies, body)
		code := status
		mu.Unlock()
		w.WriteHeader(code)
	}))
	defer receiver.Close()

	owner, stranger := uuid.New(), uuid.New()
	if _, err := db.ExecContext(ctx, `INSERT INTO users (id, email, display_name) VALUES ($1, 'ada@example.org', 'Ada'), ($2, 'eve@example.org', 'Eve')`, owner, stranger); err != nil {
		t.Fatal(err)
	}
	a := &App{DB: db, Secrets: security.NewSecretBox(bytes.Repeat([]byte{3}, 32)), Config: config.Config{AllowPrivate: true, FrontendOrigins: []string{"http://localhost:3000"}}}
	call := func(user uuid.UUID, method, path string, body any, handler gin.HandlerFunc, params ...gin.Param) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(method, path, bytes.NewReader(raw))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Params = params
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: user})
		handler(c)
		return recorder
	}

	created := call(owner, http.MethodPost, "/", map[string]any{"name": "n8n", "format": "json", "url": receiver.URL + "/hook?token=abc"}, a.createWebhook)
	var hook webhookResponse
	_ = json.Unmarshal(created.Body.Bytes(), &hook)
	if created.Code != http.StatusCreated || !strings.HasPrefix(hook.Secret, "whsec_") || hook.URLHint != "127.0.0.1" {
		t.Fatalf("create = %d %s", created.Code, created.Body)
	}
	var stored []byte
	_ = db.QueryRowContext(ctx, `SELECT url_ciphertext FROM notification_webhooks`).Scan(&stored)
	if bytes.Contains(stored, []byte("token=abc")) {
		t.Fatal("the webhook URL is stored in plain text")
	}
	listed := call(owner, http.MethodGet, "/", nil, a.listWebhooks)
	if strings.Contains(listed.Body.String(), "whsec_") || strings.Contains(listed.Body.String(), "token=abc") {
		t.Fatalf("the list reveals the secret or URL: %s", listed.Body)
	}

	// A notification arrives signed.
	if sent := a.deliverWebhooks(ctx, owner, webhookMessage{ID: "n1", Type: "reminder", Title: "Erinnerung", Body: "Kaffee", URL: "http://localhost:3000/", CreatedAt: time.Now()}); sent != 1 {
		t.Fatalf("sent = %d", sent)
	}
	mu.Lock()
	request, body := received[0], bodies[0]
	mu.Unlock()
	timestamp, _ := strconv.ParseInt(request.Header.Get("X-JustAI-Timestamp"), 10, 64)
	if request.URL.RawQuery != "token=abc" || request.Header.Get("X-JustAI-Event") != "reminder" || request.Header.Get("X-JustAI-Signature") != webhookSignature(hook.Secret, timestamp, body) {
		t.Fatalf("delivery headers = %v", request.Header)
	}

	// Others cannot touch it.
	param := gin.Param{Key: "id", Value: hook.ID.String()}
	if code := call(stranger, http.MethodPatch, "/", map[string]any{"enabled": false}, a.updateWebhook, param).Code; code != http.StatusNotFound {
		t.Fatalf("a stranger changed the webhook: %d", code)
	}
	call(stranger, http.MethodDelete, "/", nil, a.deleteWebhook, param)
	var count int
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM notification_webhooks`).Scan(&count)
	if count != 1 {
		t.Fatal("a stranger deleted the webhook")
	}

	// A receiver that keeps failing is turned off, and the error is kept.
	mu.Lock()
	status = http.StatusInternalServerError
	mu.Unlock()
	if code := call(owner, http.MethodPost, "/", nil, a.testWebhook, param).Code; code != http.StatusBadGateway {
		t.Fatalf("failed test = %d", code)
	}
	for i := 0; i < webhookMaxFailures; i++ {
		a.deliverWebhooks(ctx, owner, webhookMessage{ID: "n", Type: "x", Title: "t"})
	}
	var enabled bool
	var lastError string
	_ = db.QueryRowContext(ctx, `SELECT enabled, last_error FROM notification_webhooks`).Scan(&enabled, &lastError)
	if enabled || lastError != "the webhook answered with HTTP 500" {
		t.Fatalf("enabled=%v lastError=%q", enabled, lastError)
	}
	// Turning it on again resets the count.
	updated := call(owner, http.MethodPatch, "/", map[string]any{"enabled": true}, a.updateWebhook, param)
	if !strings.Contains(updated.Body.String(), `"failureCount":0`) || !strings.Contains(updated.Body.String(), `"enabled":true`) {
		t.Fatalf("re-enable = %s", updated.Body)
	}

	// Without allow_private_targets, internal addresses are refused.
	a.Config.AllowPrivate = false
	if code := call(owner, http.MethodPost, "/", map[string]any{"name": "intern", "format": "slack", "url": "https://10.0.0.5/hook"}, a.createWebhook).Code; code != http.StatusBadRequest {
		t.Fatalf("a private address was accepted: %d", code)
	}
}
