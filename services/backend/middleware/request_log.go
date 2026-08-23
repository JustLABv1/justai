package middleware

import (
	"context"
	"database/sql"
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	requestLogWriteTimeout        = 2 * time.Second
	requestLogMaxConcurrentWrites = 8
)

func RequestLog(db *sql.DB) gin.HandlerFunc {
	// Keep capacity local to this middleware/database pair so a slow database
	// cannot cause an unrelated App instance to drop its audit records.
	writeSlots := make(chan struct{}, requestLogMaxConcurrentWrites)
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
			select {
			case writeSlots <- struct{}{}:
				go func() {
					defer func() { <-writeSlots }()
					ctx, cancel := context.WithTimeout(context.Background(), requestLogWriteTimeout)
					defer cancel()
					if _, err := db.ExecContext(ctx, `INSERT INTO api_request_logs (user_id, organization_id, method, path, status_code, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)`, userID, organizationIDValue, method, path, status, durationMS); err != nil {
						slog.Warn("api_request_log_write_failed", "requestId", requestID, "error", err)
					}
				}()
			default:
				slog.Warn("api_request_log_dropped", "requestId", requestID, "reason", "writer capacity exhausted")
			}
		}
	}
}

func nullableUUID(value interface{ String() string }) any {
	if value == nil || value.String() == "00000000-0000-0000-0000-000000000000" {
		return nil
	}
	return value
}
