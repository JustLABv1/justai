package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const RequestIDKey = "justai.request_id"

func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		value := strings.TrimSpace(c.GetHeader("X-Request-ID"))
		if value == "" || len(value) > 128 || strings.ContainsAny(value, "\r\n") {
			value = uuid.NewString()
		}
		c.Set(RequestIDKey, value)
		c.Header("X-Request-ID", value)
		c.Next()
	}
}

// MaxBodyBytes prevents malformed or accidental uploads from consuming the
// entire backend process. Attachment handlers apply their stricter per-type
// limits after multipart parsing.
func MaxBodyBytes(limit int64) gin.HandlerFunc {
	return MaxBodyBytesExcept(limit, nil)
}

// MaxBodyBytesExcept applies the default request limit unless skip returns
// true. Large streaming endpoints should opt out and enforce their own
// protocol-specific limit while forwarding the body to the upstream service.
func MaxBodyBytesExcept(limit int64, skip func(*gin.Context) bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		if skip != nil && skip(c) {
			c.Next()
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		c.Next()
	}
}

func AbortError(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{
		"error":     message,
		"message":   message,
		"code":      code,
		"requestId": GetRequestID(c),
	})
}

func GetRequestID(c *gin.Context) string {
	value, _ := c.Get(RequestIDKey)
	requestID, _ := value.(string)
	return requestID
}
