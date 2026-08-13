package middleware

import (
	"database/sql"
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
)

func RequestLog(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		started := time.Now()
		c.Next()
		principal, _ := GetPrincipal(c)
		organizationID, _ := GetOrganizationID(c)
		path := c.FullPath()
		if path == "" {
			path = c.Request.URL.Path
		}
		if path == "/api/v1/health" || path == "/api/v1/health/live" || path == "/api/v1/health/ready" || path == "/health/live" || path == "/health/ready" {
			return
		}
		method := c.Request.Method
		status := c.Writer.Status()
		durationMS := float64(time.Since(started).Microseconds()) / 1000
		requestID := GetRequestID(c)
		userID := nullableUUID(principal.UserID)
		organizationIDValue := nullableUUID(organizationID)
		slog.Info("http_request", "requestId", requestID, "method", method, "path", path, "status", status, "durationMs", durationMS)
		if db != nil {
			go func() {
				_, _ = db.Exec(`INSERT INTO api_request_logs (user_id, organization_id, method, path, status_code, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)`, userID, organizationIDValue, method, path, status, durationMS)
			}()
		}
	}
}

func nullableUUID(value interface{ String() string }) any {
	if value == nil || value.String() == "00000000-0000-0000-0000-000000000000" {
		return nil
	}
	return value
}
