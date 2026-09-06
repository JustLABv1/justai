package server

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"justai-backend/middleware"
)

// PublicError is the small, explicit error contract exposed by API handlers.
// Internal errors can still be wrapped and logged with the request id, but
// their implementation details never become a response body.
type PublicError struct {
	Code    string
	Message string
}

func (e PublicError) Error() string {
	return e.Message
}

func publicError(code, message string) error {
	return PublicError{Code: code, Message: message}
}

func writeError(c *gin.Context, status int, err error) {
	if err == nil {
		err = errors.New(http.StatusText(status))
	}
	message := strings.TrimSpace(err.Error())
	code := normalizedHTTPCode(status)
	var exposed PublicError
	if errors.As(err, &exposed) {
		if strings.TrimSpace(exposed.Code) != "" {
			code = exposed.Code
		}
		if strings.TrimSpace(exposed.Message) != "" {
			message = exposed.Message
		}
	}
	if status >= http.StatusInternalServerError {
		// Upstream response bodies, SQL errors, filesystem paths, and command
		// output are useful to operators but unsafe to return to a client.
		requestID := middleware.GetRequestID(c)
		slog.Error("request failed", "requestId", requestID, "status", status, "error", err)
		message = "internal server error"
		code = "internal_error"
	}
	c.JSON(status, gin.H{
		"error":     message,
		"message":   message,
		"code":      code,
		"requestId": middleware.GetRequestID(c),
	})
}

func normalizedHTTPCode(status int) string {
	return strings.ToLower(strings.ReplaceAll(http.StatusText(status), " ", "_"))
}

func safeFailureMessage(err error) string {
	if err == nil {
		return ""
	}
	var exposed PublicError
	if errors.As(err, &exposed) && strings.TrimSpace(exposed.Message) != "" {
		return exposed.Message
	}
	// Persist only a stable category. Detailed provider/SQL errors belong in
	// restricted logs, not in user-visible job rows or SSE payloads.
	return fmt.Sprintf("operation failed (%T)", err)
}
