package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	csrfCookieName = "justai_csrf"
	csrfHeaderName = "X-CSRF-Token"
)

// CSRF protects browser-cookie authenticated mutations. Bearer-token clients
// are deliberately left alone: they already present an explicit credential
// on every request and are commonly used by integrations without browser
// Origin headers.
func CSRF(allowedOrigins []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !unsafeMethod(c.Request.Method) || bearerAuthorization(c) || !hasSessionCookie(c) {
			c.Next()
			return
		}

		origin := strings.TrimSpace(c.GetHeader("Origin"))
		if origin != "" {
			if originAllowed(origin, allowedOrigins) {
				c.Next()
				return
			}
			AbortError(c, http.StatusForbidden, "csrf_origin_rejected", "request origin is not allowed")
			return
		}

		// Non-browser clients may omit Origin. Require the non-HttpOnly
		// double-submit token in that case instead of accepting an ambiguous
		// cookie-only mutation.
		cookie, err := c.Cookie(csrfCookieName)
		header := strings.TrimSpace(c.GetHeader(csrfHeaderName))
		if err != nil || cookie == "" || header == "" || len(cookie) != len(header) || subtle.ConstantTimeCompare([]byte(cookie), []byte(header)) != 1 {
			AbortError(c, http.StatusForbidden, "csrf_token_required", "a CSRF token is required for this request")
			return
		}
		c.Next()
	}
}

func unsafeMethod(method string) bool {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
		return false
	default:
		return true
	}
}

func bearerAuthorization(c *gin.Context) bool {
	return strings.HasPrefix(strings.TrimSpace(c.GetHeader("Authorization")), "Bearer ")
}

func hasSessionCookie(c *gin.Context) bool {
	value, err := c.Cookie("justai_session")
	return err == nil && strings.TrimSpace(value) != ""
}

func originAllowed(origin string, allowed []string) bool {
	for _, configured := range allowed {
		configured = strings.TrimRight(strings.TrimSpace(configured), "/")
		if configured != "" && configured != "*" && strings.TrimRight(origin, "/") == configured {
			return true
		}
	}
	return false
}
