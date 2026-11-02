package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"net/http"
	"os/exec"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
	"justai-backend/outbound"
)

const videoThumbnailMaxBytes = 256 * 1024
const videoThumbnailCacheSize = 64

var videoThumbnailSlots = make(chan struct{}, 2)

type cachedVideoThumbnail struct {
	data    []byte
	expires time.Time
}
type videoThumbnailFlight struct {
	done chan struct{}
	data []byte
	err  error
}
type videoThumbnailCache struct {
	mu      sync.Mutex
	entries map[uuid.UUID]cachedVideoThumbnail
	flights map[uuid.UUID]*videoThumbnailFlight
}

// Images are bounded, short-lived and private to this application instance.
// Authorization is checked separately on every request, including cache hits.
func (cache *videoThumbnailCache) get(ctx context.Context, id uuid.UUID, sourceExpiry *time.Time, load func(context.Context) ([]byte, error)) ([]byte, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		cache.mu.Lock()
		if entry, ok := cache.entries[id]; ok && time.Now().Before(entry.expires) {
			cache.mu.Unlock()
			return entry.data, nil
		}
		if flight, ok := cache.flights[id]; ok {
			cache.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-flight.done:
				if errors.Is(flight.err, context.Canceled) && ctx.Err() == nil {
					continue
				}
				return flight.data, flight.err
			}
		}
		flight := &videoThumbnailFlight{done: make(chan struct{})}
		if cache.flights == nil {
			cache.flights = make(map[uuid.UUID]*videoThumbnailFlight)
		}
		cache.flights[id] = flight
		cache.mu.Unlock()
		data, err := load(ctx)
		cache.mu.Lock()
		if err == nil && len(data) > 0 && len(data) <= videoThumbnailMaxBytes {
			if cache.entries == nil {
				cache.entries = make(map[uuid.UUID]cachedVideoThumbnail)
			}
			now := time.Now()
			for key, entry := range cache.entries {
				if !now.Before(entry.expires) {
					delete(cache.entries, key)
				}
			}
			if len(cache.entries) >= videoThumbnailCacheSize {
				var oldest uuid.UUID
				var oldestTime time.Time
				for key, entry := range cache.entries {
					if oldestTime.IsZero() || entry.expires.Before(oldestTime) {
						oldest = key
						oldestTime = entry.expires
					}
				}
				delete(cache.entries, oldest)
			}
			expires := now.Add(10 * time.Minute)
			if sourceExpiry != nil && sourceExpiry.Before(expires) {
				expires = *sourceExpiry
			}
			cache.entries[id] = cachedVideoThumbnail{data: data, expires: expires}
		}
		flight.data, flight.err = data, err
		delete(cache.flights, id)
		close(flight.done)
		cache.mu.Unlock()
		return data, err
	}
}

func videoThumbnailOffset(durationMs int64) int64 {
	return min(int64(10000), max(int64(0), durationMs/10))
}
func videoThumbnailFFmpegArgs(url string, offsetMs int64) []string {
	args := captionFFmpegArgs(url, offsetMs)
	for i, arg := range args {
		if arg == "-vf" && i+1 < len(args) {
			args[i+1] = "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2"
		}
	}
	return args
}

func extractVideoThumbnailFrame(ctx context.Context, url string, offsetMs int64) ([]byte, error) {
	select {
	case videoThumbnailSlots <- struct{}{}:
		defer func() { <-videoThumbnailSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	command := exec.CommandContext(ctx, "ffmpeg", videoThumbnailFFmpegArgs(url, offsetMs)...)
	environment, err := outbound.MediaProxyEnv(url)
	if err != nil {
		return nil, fmt.Errorf("video processing origin is unavailable")
	}
	command.Env = environment
	output := &captionLimitedBuffer{limit: videoThumbnailMaxBytes}
	diagnostic := &captionLimitedBuffer{limit: 2048, discard: true}
	command.Stdout = output
	command.Stderr = diagnostic
	if err = command.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("video preview is unavailable")
	}
	data := output.Bytes()
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != "jpeg" || cfg.Width < 1 || cfg.Width > 480 || cfg.Height < 1 || cfg.Height > 270 {
		return nil, fmt.Errorf("video produced an invalid preview")
	}
	return data, nil
}

func (a *App) videoTranscriptionThumbnail(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid upload id"))
		return
	}
	var key, driver, status string
	var expected, size, duration int64
	var expires sql.NullTime
	// A cached image is never an authorization shortcut. Archived and foreign
	// recordings are inaccessible here just as they are in the library.
	err = a.DB.QueryRowContext(c, `SELECT video.storage_key,video.storage_driver,video.status,video.expected_bytes,video.bytes,video.duration_ms,video.expires_at
 FROM transcription_video_uploads video JOIN transcription_sessions s ON s.id=video.session_id
 WHERE video.id=$1 AND s.user_id=$2 AND s.organization_id=$3 AND s.archived_at IS NULL`, id, principal.UserID, organizationID).Scan(&key, &driver, &status, &expected, &size, &duration, &expires)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("recording not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if expires.Valid && !expires.Time.After(time.Now()) {
		writeError(c, http.StatusGone, fmt.Errorf("source recording has expired"))
		return
	}
	if driver != "s3" || key == "" || status == "uploading" || expected <= 0 || size < expected {
		writeError(c, http.StatusNotFound, fmt.Errorf("video preview is not ready"))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	var expiry *time.Time
	if expires.Valid {
		expiry = &expires.Time
	}
	data, err := a.videoThumbnails.get(ctx, id, expiry, func(ctx context.Context) ([]byte, error) {
		storage, storageErr := newS3Storage(a.Config)
		if storageErr != nil {
			return nil, fmt.Errorf("video storage is unavailable")
		}
		url := storage.presignProcessingURL(http.MethodGet, key, nil, videoProcessingURLLifetime)
		return extractVideoThumbnailFrame(ctx, url, videoThumbnailOffset(duration))
	})
	if err != nil {
		writeError(c, http.StatusBadGateway, err)
		return
	}
	if expires.Valid && !expires.Time.After(time.Now()) {
		writeError(c, http.StatusGone, fmt.Errorf("source recording has expired"))
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, "image/jpeg", data)
}
