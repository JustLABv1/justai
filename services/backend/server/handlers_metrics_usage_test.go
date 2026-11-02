package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"justai-backend/config"
)

func usageMetricsRequest(app *App, header string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/metrics/usage", app.usageMetricsHandler)
	req := httptest.NewRequest(http.MethodGet, "/metrics/usage", nil)
	if header != "" {
		req.Header.Set("Authorization", header)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestUsageMetricsRequiresConfiguredToken(t *testing.T) {
	if rec := usageMetricsRequest(&App{}, "Bearer anything"); rec.Code != http.StatusNotFound {
		t.Fatalf("unset token: got %d want 404", rec.Code)
	}
	app := &App{Config: config.Config{MetricsToken: "0123456789abcdef"}}
	for _, header := range []string{"", "Bearer wrong-token-value-1", "0123456789abcdef", "Basic 0123456789abcdef"} {
		if rec := usageMetricsRequest(app, header); rec.Code != http.StatusUnauthorized {
			t.Fatalf("header %q: got %d want 401", header, rec.Code)
		}
	}
}

func TestMetricLabelEscapes(t *testing.T) {
	if got := metricLabel("a\"b\\c\nd"); got != `"a\"b\\c\nd"` {
		t.Fatalf("got %s", got)
	}
}
