package middleware

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestMaxBodyBytesExceptBypassesOnlySelectedStreamingRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	largeBody := bytes.Repeat([]byte("x"), 27*1024*1024)

	for _, test := range []struct {
		name       string
		path       string
		wantStatus int
		wantLength int
	}{
		{name: "video part", path: "/api/v1/transcription/video-uploads/id/parts/1", wantStatus: http.StatusOK, wantLength: len(largeBody)},
		{name: "regular route", path: "/api/v1/other", wantStatus: http.StatusRequestEntityTooLarge, wantLength: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			router := gin.New()
			router.Use(MaxBodyBytesExcept(26*1024*1024, func(c *gin.Context) bool {
				return c.Request.Method == http.MethodPut && c.FullPath() == "/api/v1/transcription/video-uploads/:id/parts/:partNumber"
			}))
			router.PUT("/api/v1/transcription/video-uploads/:id/parts/:partNumber", func(c *gin.Context) {
				body, err := io.ReadAll(c.Request.Body)
				if err != nil {
					c.Status(http.StatusRequestEntityTooLarge)
					return
				}
				c.Header("X-Body-Length", strconv.Itoa(len(body)))
				c.Status(http.StatusOK)
			})
			router.PUT("/api/v1/other", func(c *gin.Context) {
				body, err := io.ReadAll(c.Request.Body)
				if err != nil {
					c.Status(http.StatusRequestEntityTooLarge)
					return
				}
				c.Header("X-Body-Length", strconv.Itoa(len(body)))
				c.Status(http.StatusOK)
			})

			request := httptest.NewRequest(http.MethodPut, test.path, bytes.NewReader(largeBody))
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("expected status %d, got %d", test.wantStatus, response.Code)
			}
			if test.wantLength > 0 && response.Header().Get("X-Body-Length") != strconv.Itoa(test.wantLength) {
				t.Fatalf("expected streaming route to receive %d bytes, got %s", test.wantLength, response.Header().Get("X-Body-Length"))
			}
		})
	}
}
