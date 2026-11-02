package server

import (
	"bytes"
	"context"
	"database/sql"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func TestVideoThumbnailIsAuthorizedBeforeCacheAccess(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	app := &App{DB: db}
	id, user, org := uuid.New(), uuid.New(), uuid.New()
	var encoded bytes.Buffer
	if err = jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 16, 9)), nil); err != nil {
		t.Fatal(err)
	}
	_, err = app.videoThumbnails.get(context.Background(), id, nil, func(context.Context) ([]byte, error) { return encoded.Bytes(), nil })
	if err != nil {
		t.Fatal(err)
	}
	query := `(?s)FROM transcription_video_uploads video JOIN transcription_sessions s.*WHERE video.id=\$1 AND s.user_id=\$2 AND s.organization_id=\$3 AND s.archived_at IS NULL`
	columns := []string{"storage_key", "storage_driver", "status", "expected_bytes", "bytes", "duration_ms", "expires_at"}
	mock.ExpectQuery(query).WithArgs(id, user, org).WillReturnRows(sqlmock.NewRows(columns).AddRow("private-source", "s3", "completed", 100, 100, 10000, time.Now().Add(time.Hour)))
	c, w := videoLibraryTestContext("/", user, org)
	c.Params = gin.Params{{Key: "id", Value: id.String()}}
	app.videoTranscriptionThumbnail(c)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/jpeg" || !bytes.Equal(w.Body.Bytes(), encoded.Bytes()) {
		t.Fatalf("cached thumbnail: %d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal("private images must not enter a shared browser/CDN cache")
	}
	otherOrg := uuid.New()
	mock.ExpectQuery(query).WithArgs(id, user, otherOrg).WillReturnError(sql.ErrNoRows)
	c, w = videoLibraryTestContext("/", user, otherOrg)
	c.Params = gin.Params{{Key: "id", Value: id.String()}}
	app.videoTranscriptionThumbnail(c)
	if w.Code != 404 || bytes.Equal(w.Body.Bytes(), encoded.Bytes()) {
		t.Fatal("cache bypassed workspace authorization")
	}
	mock.ExpectQuery(query).WithArgs(id, user, org).WillReturnRows(sqlmock.NewRows(columns).AddRow("private-source", "s3", "completed", 100, 100, 10000, time.Now().Add(-time.Second)))
	c, w = videoLibraryTestContext("/", user, org)
	c.Params = gin.Params{{Key: "id", Value: id.String()}}
	app.videoTranscriptionThumbnail(c)
	if w.Code != 410 {
		t.Fatalf("expired source served from cache: %d", w.Code)
	}
	mock.ExpectQuery(query).WithArgs(id, user, org).WillReturnRows(sqlmock.NewRows(columns).AddRow("private-source", "s3", "uploading", 100, 50, 0, nil))
	c, w = videoLibraryTestContext("/", user, org)
	c.Params = gin.Params{{Key: "id", Value: id.String()}}
	app.videoTranscriptionThumbnail(c)
	if w.Code != 404 {
		t.Fatalf("incomplete upload served from cache: %d", w.Code)
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestVideoThumbnailCacheCoalescesRequestsAndStaysBounded(t *testing.T) {
	var cache videoThumbnailCache
	id := uuid.New()
	var loads atomic.Int32
	started, finish := make(chan struct{}), make(chan struct{})
	load := func(context.Context) ([]byte, error) {
		if loads.Add(1) == 1 {
			close(started)
		}
		<-finish
		return []byte("preview"), nil
	}
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			data, err := cache.get(context.Background(), id, nil, load)
			if err != nil || string(data) != "preview" {
				t.Errorf("bad cached result: %q %v", data, err)
			}
		}()
	}
	<-started
	close(finish)
	wg.Wait()
	if loads.Load() != 1 {
		t.Fatalf("extracted the same video %d times", loads.Load())
	}
	for range videoThumbnailCacheSize + 5 {
		_, err := cache.get(context.Background(), uuid.New(), nil, func(context.Context) ([]byte, error) { return []byte("preview"), nil })
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(cache.entries) > videoThumbnailCacheSize {
		t.Fatal("thumbnail cache grew beyond its memory bound")
	}
	expiry := time.Now().Add(time.Minute)
	newID := uuid.New()
	_, err := cache.get(context.Background(), newID, &expiry, func(context.Context) ([]byte, error) { return []byte("preview"), nil })
	if err != nil {
		t.Fatal(err)
	}
	if cache.entries[newID].expires.After(expiry) {
		t.Fatal("image cache outlives the source expiry")
	}
	cache.entries[newID] = cachedVideoThumbnail{data: []byte("old"), expires: time.Now().Add(-time.Second)}
	data, err := cache.get(context.Background(), newID, nil, func(context.Context) ([]byte, error) { return []byte("new"), nil })
	if err != nil || string(data) != "new" {
		t.Fatal("stale thumbnail was reused")
	}
}

func TestVideoThumbnailFrameKeepsTheWholeVideo(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is unavailable")
	}
	path := filepath.Join(t.TempDir(), "source.mp4")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=1", "-vf", "drawbox=x=0:y=90:w=320:h=90:color=blue:t=fill", "-c:v", "mpeg4", "-an", "-y", path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create test video: %v %s", err, output)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, path) }))
	defer server.Close()
	data, err := extractVideoThumbnailFrame(ctx, server.URL+"/source.mp4", 100)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Bounds().Dx() != 480 || decoded.Bounds().Dy() != 270 {
		t.Fatalf("wrong preview dimensions: %v", decoded.Bounds())
	}
	topR, _, topB, _ := decoded.At(240, 30).RGBA()
	bottomR, _, bottomB, _ := decoded.At(240, 240).RGBA()
	if topR < 40000 || topB > 20000 || bottomB < 40000 || bottomR > 20000 {
		t.Fatal("thumbnail cropped away part of the source video")
	}
	args := strings.Join(videoThumbnailFFmpegArgs("https://storage.invalid/source", 100), " ")
	if strings.Contains(args, "crop=") {
		t.Fatal("reused the speaker-caption crop for a full-video thumbnail")
	}
	if videoThumbnailOffset(240000) != 10000 || videoThumbnailOffset(1000) != 100 {
		t.Fatal("thumbnail time must stay inside short recordings")
	}
}
