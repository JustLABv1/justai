package middleware

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestLogRequestUsesReadableFieldsAndStatusLevel(t *testing.T) {
	previous := slog.Default()
	defer slog.SetDefault(previous)

	var output bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	logRequest(503, "POST", "/api/v1/chat", "request-123", 125*time.Millisecond)

	line := output.String()
	for _, expected := range []string{
		"level=ERROR",
		"msg=\"HTTP request\"",
		"method=POST",
		"route=/api/v1/chat",
		"status=503",
		"duration=125ms",
		"requestId=request-123",
	} {
		if !strings.Contains(line, expected) {
			t.Fatalf("expected %q in request log %q", expected, line)
		}
	}
}
