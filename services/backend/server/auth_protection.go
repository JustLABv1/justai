package server

import (
	"net"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"justai-backend/middleware"
)

const (
	authAttemptWindow = time.Minute
	authAttemptLimit  = 20
	authPeerLimit     = 120
	passwordHashLimit = 4
	maxAuthRateKeys   = 10000
)

type authAttempt struct {
	started time.Time
	count   int
}

// authAttemptLimiter is deliberately keyed by the directly connected peer.
// Gin's ClientIP may use forwarded headers depending on proxy configuration;
// unauthenticated rate limiting must not trust attacker-controlled headers.
type authAttemptLimiter struct {
	mu       sync.Mutex
	attempts map[string]authAttempt
	now      func() time.Time
	window   time.Duration
	limit    int
}

func newAuthAttemptLimiter() *authAttemptLimiter {
	return &authAttemptLimiter{
		attempts: make(map[string]authAttempt),
		now:      time.Now,
		window:   authAttemptWindow,
		limit:    authAttemptLimit,
	}
}

func (l *authAttemptLimiter) allow(key string) bool {
	if l == nil {
		return false
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	current, exists := l.attempts[key]
	if !exists || now.Before(current.started) || now.Sub(current.started) >= l.window {
		if len(l.attempts) >= maxAuthRateKeys {
			for candidate, attempt := range l.attempts {
				if now.Sub(attempt.started) >= l.window || now.Before(attempt.started) {
					delete(l.attempts, candidate)
				}
			}
			if len(l.attempts) >= maxAuthRateKeys {
				return false
			}
		}
		l.attempts[key] = authAttempt{started: now, count: 1}
		return true
	}
	limit := l.limit
	if strings.HasPrefix(key, "peer:") {
		limit = authPeerLimit
	}
	if current.count >= limit {
		return false
	}
	current.count++
	l.attempts[key] = current
	return true
}

func directPeer(c *gin.Context) string {
	if c == nil || c.Request == nil {
		return "unknown"
	}
	remote := strings.TrimSpace(c.Request.RemoteAddr)
	if host, _, err := net.SplitHostPort(remote); err == nil {
		return host
	}
	if remote == "" {
		return "unknown"
	}
	return remote
}

func (a *App) passwordProtection() (*authAttemptLimiter, chan struct{}) {
	a.authProtectionMu.Lock()
	defer a.authProtectionMu.Unlock()
	if a.authLimiter == nil {
		a.authLimiter = newAuthAttemptLimiter()
	}
	if a.passwordHashSlots == nil {
		a.passwordHashSlots = make(chan struct{}, passwordHashLimit)
	}
	return a.authLimiter, a.passwordHashSlots
}

func (a *App) allowAuthAttempt(c *gin.Context, email string) bool {
	limiter, _ := a.passwordProtection()
	peerKey := "peer:" + directPeer(c)
	accountKey := "account:" + directPeer(c) + ":" + strings.ToLower(strings.TrimSpace(email))
	if limiter.allow(peerKey) && limiter.allow(accountKey) {
		return true
	}
	c.Header("Retry-After", "60")
	middleware.AbortError(c, 429, "auth_rate_limited", "too many authentication attempts; try again later")
	return false
}

func (a *App) acquirePasswordSlot(c *gin.Context) (func(), bool) {
	_, slots := a.passwordProtection()
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, true
	default:
		c.Header("Retry-After", "1")
		middleware.AbortError(c, 429, "auth_busy", "authentication is temporarily busy; try again shortly")
		return nil, false
	}
}
