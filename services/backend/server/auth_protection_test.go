package server

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestAuthAttemptLimiterSeparatesAccountsButBoundsPeerTraffic(t *testing.T) {
	now := time.Date(2026, time.August, 24, 12, 0, 0, 0, time.UTC)
	limiter := newAuthAttemptLimiter()
	limiter.limit = 2
	limiter.now = func() time.Time { return now }

	if !limiter.allow("account:proxy:one@example.com") || !limiter.allow("account:proxy:one@example.com") {
		t.Fatal("first two attempts for an account should be allowed")
	}
	if limiter.allow("account:proxy:one@example.com") {
		t.Fatal("account attempts exceeded the configured limit")
	}
	if !limiter.allow("account:proxy:two@example.com") {
		t.Fatal("a different account should not inherit the first account's limit")
	}

	for attempt := 0; attempt < authPeerLimit; attempt++ {
		if !limiter.allow("peer:proxy") {
			t.Fatalf("peer attempt %d was unexpectedly rejected", attempt+1)
		}
	}
	if limiter.allow("peer:proxy") {
		t.Fatal("peer attempts exceeded the global per-peer limit")
	}
}

func TestAuthRateLimitUsesDirectPeerNotForwardedHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	app := &App{authLimiter: &authAttemptLimiter{
		attempts: make(map[string]authAttempt),
		now:      time.Now,
		window:   time.Minute,
		limit:    1,
	}}

	first := httptest.NewRequest("POST", "/login", nil)
	first.RemoteAddr = "192.0.2.10:1000"
	first.Header.Set("X-Forwarded-For", "198.51.100.1")
	firstContext, _ := gin.CreateTestContext(httptest.NewRecorder())
	firstContext.Request = first
	if !app.allowAuthAttempt(firstContext, "user@example.com") {
		t.Fatal("first authentication attempt should be allowed")
	}

	second := httptest.NewRequest("POST", "/login", nil)
	second.RemoteAddr = "192.0.2.10:1000"
	second.Header.Set("X-Forwarded-For", "203.0.113.2")
	secondContext, _ := gin.CreateTestContext(httptest.NewRecorder())
	secondContext.Request = second
	if app.allowAuthAttempt(secondContext, "user@example.com") {
		t.Fatal("spoofing a forwarded address bypassed the direct-peer limit")
	}
}
