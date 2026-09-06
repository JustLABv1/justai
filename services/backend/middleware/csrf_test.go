package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCSRFAllowsConfiguredOriginForCookieMutation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(CSRF([]string{"https://app.example"}))
	router.POST("/mutate", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	req := httptest.NewRequest(http.MethodPost, "/mutate", nil)
	req.AddCookie(&http.Cookie{Name: "justai_session", Value: "session"})
	req.Header.Set("Origin", "https://app.example")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("configured origin was rejected: %d", res.Code)
	}
}

func TestCSRFRejectsUntrustedCookieMutation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(CSRF([]string{"https://app.example"}))
	router.POST("/mutate", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	req := httptest.NewRequest(http.MethodPost, "/mutate", nil)
	req.AddCookie(&http.Cookie{Name: "justai_session", Value: "session"})
	req.Header.Set("Origin", "https://attacker.example")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("untrusted origin was accepted: %d", res.Code)
	}
}

func TestCSRFBearerMutationIsUnaffected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(CSRF(nil))
	router.POST("/mutate", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	req := httptest.NewRequest(http.MethodPost, "/mutate", nil)
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Origin", "https://attacker.example")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("bearer request was affected by CSRF middleware: %d", res.Code)
	}
}

func TestCSRFRequiresDoubleSubmitTokenWithoutOrigin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(CSRF([]string{"https://app.example"}))
	router.POST("/mutate", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	req := httptest.NewRequest(http.MethodPost, "/mutate", nil)
	req.AddCookie(&http.Cookie{Name: "justai_session", Value: "session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "token"})
	req.Header.Set(csrfHeaderName, "token")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("valid double-submit token was rejected: %d", res.Code)
	}
}
