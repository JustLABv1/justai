package middleware

import (
	"database/sql"
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
		if path == "/api/v1/health" {
			return
		}
		go func() {
			_, _ = db.Exec(`INSERT INTO api_request_logs (user_id, organization_id, method, path, status_code, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)`, nullableUUID(principal.UserID), nullableUUID(organizationID), c.Request.Method, path, c.Writer.Status(), float64(time.Since(started).Microseconds())/1000)
		}()
	}
}

func nullableUUID(value interface{ String() string }) any {
	if value == nil || value.String() == "00000000-0000-0000-0000-000000000000" {
		return nil
	}
	return value
}
