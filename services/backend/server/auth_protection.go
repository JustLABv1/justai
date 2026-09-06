package server

import (
	"crypto/sha256"
	"encoding/hex"
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
	if a.DB != nil {
		peerAllowed, peerAvailable := a.allowSharedRateBucket(c, peerKey, authPeerLimit)
		accountAllowed, accountAvailable := a.allowSharedRateBucket(c, accountKey, authAttemptLimit)
		if peerAvailable && accountAvailable {
			if peerAllowed && accountAllowed {
				return true
			}
			c.Header("Retry-After", "60")
			middleware.AbortError(c, 429, "auth_rate_limited", "too many authentication attempts; try again later")
			return false
		}
	}
	if limiter.allow(peerKey) && limiter.allow(accountKey) {
		return true
	}
	c.Header("Retry-After", "60")
	middleware.AbortError(c, 429, "auth_rate_limited", "too many authentication attempts; try again later")
	return false
}

// allowSharedRateBucket uses one atomic Postgres upsert per bucket. If the
// reliability migration is not available yet, callers fall back to the
// bounded in-process limiter rather than failing authentication closed.
func (a *App) allowSharedRateBucket(c *gin.Context, key string, limit int) (allowed, available bool) {
	if a == nil || a.DB == nil {
		return false, false
	}
	var result bool
	hash := sha256.Sum256([]byte(key))
	key = hex.EncodeToString(hash[:])
	err := a.DB.QueryRowContext(c, `INSERT INTO api_rate_limit_buckets (bucket_key, window_started_at, count, expires_at) VALUES ($1, date_trunc('minute', now()), 1, date_trunc('minute', now()) + interval '2 minutes') ON CONFLICT (bucket_key) DO UPDATE SET count = CASE WHEN api_rate_limit_buckets.window_started_at < date_trunc('minute', now()) THEN 1 ELSE api_rate_limit_buckets.count + 1 END, window_started_at = CASE WHEN api_rate_limit_buckets.window_started_at < date_trunc('minute', now()) THEN date_trunc('minute', now()) ELSE api_rate_limit_buckets.window_started_at END, expires_at = date_trunc('minute', now()) + interval '2 minutes' RETURNING count <= $2`, key, limit).Scan(&result)
	if err != nil {
		return false, false
	}
	return result, true
}

// scopedRateLimit applies a shared per-user/workspace budget to expensive
// operations. The in-memory limiter remains a safe fallback during a rolling
// migration or a transient database outage.
func (a *App) scopedRateLimit(scope string, limit int) gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, _ := middleware.GetPrincipal(c)
		organizationID, _ := middleware.GetOrganizationID(c)
		key := strings.TrimSpace(scope) + ":" + organizationID.String() + ":" + principal.UserID.String()
		if allowed, available := a.allowSharedRateBucket(c, key, limit); available {
			if allowed {
				c.Next()
				return
			}
			c.Header("Retry-After", "60")
			middleware.AbortError(c, 429, "rate_limited", "this operation is temporarily rate limited")
			return
		}
		limiter, _ := a.passwordProtection()
		if limiter.allow("account:" + key) {
			c.Next()
			return
		}
		c.Header("Retry-After", "60")
		middleware.AbortError(c, 429, "rate_limited", "this operation is temporarily rate limited")
	}
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
