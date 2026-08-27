package server

import (
	"bytes"
	"context"
	"encoding/xml"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/config"
	"justai-backend/models"
)

func TestNormalizeVideoUploadPartsRequiresEveryPartOnce(t *testing.T) {
	parts, err := normalizeVideoUploadParts([]videoUploadPart{
		{PartNumber: 2, ETag: `"etag-2"`},
		{PartNumber: 1, ETag: `"etag-1"`},
	}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if parts[0].PartNumber != 1 || parts[1].PartNumber != 2 {
		t.Fatalf("parts were not sorted: %+v", parts)
	}

	for name, value := range map[string][]videoUploadPart{
		"missing": {{PartNumber: 1, ETag: "etag"}},
		"duplicate": {
			{PartNumber: 1, ETag: "etag-1"},
			{PartNumber: 1, ETag: "etag-2"},
		},
		"empty etag": {
			{PartNumber: 1, ETag: ""},
			{PartNumber: 2, ETag: "etag-2"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := normalizeVideoUploadParts(value, 2); err == nil {
				t.Fatal("expected invalid multipart completion data to be rejected")
			}
		})
	}
}

func TestVideoUploadValidationAcceptsSupportedFormatsOnly(t *testing.T) {
	for _, fileName := range []string{"recording.mp4", "lecture.MOV", "camera.mkv", "clip.webm"} {
		if !validVideoFileName(fileName) {
			t.Fatalf("expected %s to be supported", fileName)
		}
		if !validVideoMimeType(fileName, "application/octet-stream") {
			t.Fatalf("expected %s to accept a browser fallback MIME type", fileName)
		}
	}
	for _, fileName := range []string{"audio.mp3", "document.pdf", "no-extension"} {
		if validVideoFileName(fileName) {
			t.Fatalf("expected %s to be rejected", fileName)
		}
	}
	if validVideoMimeType("recording.mp4", "audio/mpeg") {
		t.Fatal("audio MIME types must not be accepted for video uploads")
	}
}

func TestVideoUploadHasCompleteObject(t *testing.T) {
	if !videoUploadHasCompleteObject(models.TranscriptionVideoUpload{ExpectedBytes: 10, Bytes: 10}) {
		t.Fatal("expected an upload with all expected bytes to have a complete object")
	}
	for _, upload := range []models.TranscriptionVideoUpload{
		{ExpectedBytes: 10, Bytes: 9},
		{ExpectedBytes: 0, Bytes: 0},
		{ExpectedBytes: 10, Bytes: 0},
	} {
		if videoUploadHasCompleteObject(upload) {
			t.Fatalf("incomplete upload was treated as complete: %+v", upload)
		}
	}
}

func TestExpectedVideoUploadPartBytesValidatesPartBoundaries(t *testing.T) {
	const partSize = int64(5 * 1024 * 1024)
	if got, ok := expectedVideoUploadPartBytes(11*1024*1024, partSize, 3, 1); !ok || got != partSize {
		t.Fatalf("unexpected first part: %d, %t", got, ok)
	}
	if got, ok := expectedVideoUploadPartBytes(11*1024*1024, partSize, 3, 3); !ok || got != 1024*1024 {
		t.Fatalf("unexpected final part: %d, %t", got, ok)
	}
	for _, part := range []int{0, 4, -1} {
		if _, ok := expectedVideoUploadPartBytes(11*1024*1024, partSize, 3, part); ok {
			t.Fatalf("part %d should be rejected", part)
		}
	}
}

func TestVideoUploadPartContentTypeAllowsBrowserFallbackOnly(t *testing.T) {
	for _, value := range []string{"video/mp4", "video/mp4; charset=binary", "application/octet-stream"} {
		if !validVideoPartContentType("video/mp4", value) {
			t.Fatalf("expected content type %q to be accepted", value)
		}
	}
	for _, value := range []string{"text/plain", "audio/mpeg", "video"} {
		if validVideoPartContentType("video/mp4", value) {
			t.Fatalf("expected content type %q to be rejected", value)
		}
	}
	if validVideoPartContentType("video/mp4", "") {
		t.Fatal("missing content type should be rejected")
	}
	if !validVideoPartContentType("", "video/webm") {
		t.Fatal("video content type should be accepted when init used a filename fallback")
	}
}

func TestPersistVideoUploadPartPreservesAuthoritativeProgress(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	uploadID := uuid.New()
	record := videoUploadRecord{model: models.TranscriptionVideoUpload{
		ID: uploadID, Status: "uploading", ExpectedBytes: 10, PartCount: 2,
	}}
	updatedAt := time.Date(2026, 8, 27, 8, 0, 0, 0, time.UTC)
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT status, expires_at FROM transcription_video_uploads").
		WithArgs(uploadID).
		WillReturnRows(sqlmock.NewRows([]string{"status", "expires_at"}).AddRow("uploading", nil))
	mock.ExpectExec("INSERT INTO transcription_video_upload_parts").
		WithArgs(uploadID, 1, `"etag-1"`, int64(5)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("UPDATE transcription_video_uploads").
		WithArgs(uploadID).
		WillReturnRows(sqlmock.NewRows([]string{"bytes", "progress", "updated_at"}).AddRow(int64(5), 50, updatedAt))
	mock.ExpectCommit()

	application := &App{DB: db}
	got, err := application.persistVideoUploadPart(context.Background(), record, s3MultipartUploadResult{PartNumber: 1, ETag: `"etag-1"`, SizeBytes: 5})
	if err != nil {
		t.Fatal(err)
	}
	if got.Bytes != 5 || got.Progress != 50 || !got.UpdatedAt.Equal(updatedAt) {
		t.Fatalf("authoritative progress was not preserved: %+v", got)
	}
	if got.ID != uploadID || got.Status != "uploading" || got.ExpectedBytes != 10 {
		t.Fatalf("immutable upload metadata was not preserved: %+v", got)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestVideoUploadPartURLsAreSameOriginBackendRoutes(t *testing.T) {
	uploadID := uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	urls := (&App{}).videoUploadPartURLs(uploadID, 2)
	if len(urls) != 2 || urls[0].URL != "/api/v1/transcription/video-uploads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/parts/1" {
		t.Fatalf("unexpected same-origin part URLs: %+v", urls)
	}
}

func TestVideoUploadPartBypassMatchesOnlyTheRegisteredRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		if isVideoUploadPartRequest(c) {
			c.Header("X-Video-Part-Route", "true")
		}
		c.Next()
	})
	router.PUT(videoUploadPartRoutePattern, func(c *gin.Context) { c.Status(http.StatusNoContent) })

	request := httptest.NewRequest(http.MethodPut, "/api/v1/transcription/video-uploads/upload/parts/1", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Header().Get("X-Video-Part-Route") != "true" {
		t.Fatal("registered video part route was not recognized")
	}

	request = httptest.NewRequest(http.MethodPut, "/api/v1/transcription/video-uploads/upload/parts/1/other", nil)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Header().Get("X-Video-Part-Route") != "" {
		t.Fatal("unmatched path was treated as a streaming video part route")
	}
}

func TestS3UploadMultipartPartStreamsBodyAndReturnsETag(t *testing.T) {
	payload := bytes.Repeat([]byte("video-part"), 10000)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || request.URL.Query().Get("partNumber") != "2" || request.URL.Query().Get("uploadId") != "upload-123" {
			t.Fatalf("unexpected multipart request: %s %s", request.Method, request.URL.String())
		}
		if request.ContentLength != int64(len(payload)) {
			t.Fatalf("unexpected content length: %d", request.ContentLength)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read request body: %v", err)
		}
		if !bytes.Equal(body, payload) {
			t.Fatalf("S3 received a different part body")
		}
		response.Header().Set("ETag", `"part-2"`)
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	storage, err := newS3Storage(config.Config{Transcription: config.TranscriptionConfig{
		S3Endpoint:  server.URL,
		S3Region:    "us-east-1",
		S3Bucket:    "videos",
		S3AccessKey: "access",
		S3SecretKey: "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := storage.uploadMultipartPart(context.Background(), "video.mp4", "upload-123", 2, bytes.NewReader(payload), int64(len(payload)), "video/mp4")
	if err != nil {
		t.Fatal(err)
	}
	if result.PartNumber != 2 || result.ETag != `"part-2"` || result.SizeBytes != int64(len(payload)) {
		t.Fatalf("unexpected upload result: %+v", result)
	}
}

func TestCompleteMultipartReconcilesAnAlreadyCompletedObject(t *testing.T) {
	const expectedBytes = int64(1234)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodPost:
			http.Error(response, "multipart upload no longer exists", http.StatusNotFound)
		case http.MethodHead:
			response.Header().Set("Content-Length", "1234")
			response.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected reconciliation request: %s", request.Method)
		}
	}))
	defer server.Close()

	storage, err := newS3Storage(config.Config{Transcription: config.TranscriptionConfig{
		S3Endpoint: server.URL, S3Region: "us-east-1", S3Bucket: "videos",
		S3AccessKey: "access", S3SecretKey: "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.completeMultipartAndVerify(context.Background(), "video.mp4", "finished-upload", []s3MultipartPart{{PartNumber: 1, ETag: `"etag"`}}, expectedBytes); err != nil {
		t.Fatalf("expected completed object reconciliation to succeed: %v", err)
	}
}

func TestCompleteMultipartAcceptsSuccessfulCompletionWithoutObjectProbe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			t.Fatalf("successful multipart completion must not require %s, got %s", http.MethodHead, request.Method)
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	storage, err := newS3Storage(config.Config{Transcription: config.TranscriptionConfig{
		S3Endpoint: server.URL, S3Region: "us-east-1", S3Bucket: "videos",
		S3AccessKey: "access", S3SecretKey: "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.completeMultipartAndVerify(context.Background(), "video.mp4", "upload", []s3MultipartPart{{PartNumber: 1, ETag: `"etag"`}}, 1234); err != nil {
		t.Fatalf("successful completion should not depend on HEAD permissions: %v", err)
	}
}

func TestCompleteMultipartReconciliationUsesRangeGETWhenHeadIsForbidden(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodPost:
			http.Error(response, "upload is already finalized", http.StatusNotFound)
		case http.MethodHead:
			http.Error(response, "HEAD is not allowed", http.StatusForbidden)
		case http.MethodGet:
			if request.Header.Get("Range") != "bytes=0-0" {
				t.Fatalf("expected a bounded range probe, got %q", request.Header.Get("Range"))
			}
			response.Header().Set("Content-Range", "bytes 0-0/1234")
			response.WriteHeader(http.StatusPartialContent)
			_, _ = response.Write([]byte("x"))
		default:
			t.Fatalf("unexpected reconciliation request: %s", request.Method)
		}
	}))
	defer server.Close()

	storage, err := newS3Storage(config.Config{Transcription: config.TranscriptionConfig{
		S3Endpoint: server.URL, S3Region: "us-east-1", S3Bucket: "videos",
		S3AccessKey: "access", S3SecretKey: "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.completeMultipartAndVerify(context.Background(), "video.mp4", "finished-upload", []s3MultipartPart{{PartNumber: 1, ETag: `"etag"`}}, 1234); err != nil {
		t.Fatalf("expected ranged reconciliation to succeed: %v", err)
	}
}

func TestCompleteMultipartReconciliationUsesProcessingEndpointFallback(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodPost:
			http.Error(response, "upload is already finalized", http.StatusNotFound)
		case http.MethodHead, http.MethodGet:
			http.Error(response, "read denied on browser endpoint", http.StatusForbidden)
		default:
			t.Fatalf("unexpected primary request: %s", request.Method)
		}
	}))
	defer primary.Close()
	processing := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodHead {
			t.Fatalf("expected processing endpoint HEAD fallback, got %s", request.Method)
		}
		response.Header().Set("Content-Length", "1234")
		response.WriteHeader(http.StatusOK)
	}))
	defer processing.Close()

	storage, err := newS3Storage(config.Config{Transcription: config.TranscriptionConfig{
		S3Endpoint: primary.URL, S3ProcessingEndpoint: processing.URL, S3Region: "us-east-1", S3Bucket: "videos",
		S3AccessKey: "access", S3SecretKey: "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.completeMultipartAndVerify(context.Background(), "video.mp4", "finished-upload", []s3MultipartPart{{PartNumber: 1, ETag: `"etag"`}}, 1234); err != nil {
		t.Fatalf("expected processing endpoint reconciliation to succeed: %v", err)
	}
}

func TestCompleteMultipartDoesNotDeleteOnTransientVerificationFailure(t *testing.T) {
	deleteRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodPost:
			http.Error(response, "gateway timeout", http.StatusGatewayTimeout)
		case http.MethodHead, http.MethodGet:
			http.Error(response, "temporarily unavailable", http.StatusServiceUnavailable)
		case http.MethodDelete:
			deleteRequests++
			response.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected completion request: %s", request.Method)
		}
	}))
	defer server.Close()

	storage, err := newS3Storage(config.Config{Transcription: config.TranscriptionConfig{
		S3Endpoint: server.URL, S3Region: "us-east-1", S3Bucket: "videos",
		S3AccessKey: "access", S3SecretKey: "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.completeMultipartAndVerify(context.Background(), "video.mp4", "upload", []s3MultipartPart{{PartNumber: 1, ETag: `"etag"`}}, 1234); err == nil {
		t.Fatal("expected transient verification failure")
	}
	if deleteRequests != 0 {
		t.Fatalf("transient verification failure deleted the completed object %d time(s)", deleteRequests)
	}
}

func TestObjectSizeReportsActionableReadPermissionError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodHead && request.Method != http.MethodGet {
			t.Fatalf("unexpected object probe: %s", request.Method)
		}
		http.Error(response, "access denied", http.StatusForbidden)
	}))
	defer server.Close()

	storage, err := newS3Storage(config.Config{Transcription: config.TranscriptionConfig{
		S3Endpoint: server.URL, S3Region: "us-east-1", S3Bucket: "videos",
		S3AccessKey: "access", S3SecretKey: "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = storage.objectSize(context.Background(), "video.mp4")
	if err == nil || !strings.Contains(err.Error(), "s3:GetObject") {
		t.Fatalf("expected actionable read permission error, got %v", err)
	}
	if got := videoUploadCompletionErrorStatus(err); got != http.StatusFailedDependency {
		t.Fatalf("expected read permission failure status %d, got %d", http.StatusFailedDependency, got)
	}
}

func TestVideoUploadS3ErrorStatusAvoidsRetryingDeterministicFailures(t *testing.T) {
	if got := videoUploadS3ErrorStatus(&s3ResponseError{status: http.StatusNotFound}); got != http.StatusConflict {
		t.Fatalf("expected missing multipart upload to be non-retryable, got %d", got)
	}
	if got := videoUploadS3ErrorStatus(&s3ResponseError{status: http.StatusForbidden}); got != http.StatusFailedDependency {
		t.Fatalf("expected S3 authorization failure to be non-retryable, got %d", got)
	}
	if got := videoUploadS3ErrorStatus(&s3ResponseError{status: http.StatusServiceUnavailable}); got != http.StatusBadGateway {
		t.Fatalf("expected transient S3 failure to remain retryable, got %d", got)
	}
}

func TestVideoMultipartPresignIncludesUploadScope(t *testing.T) {
	storage, err := newS3Storage(config.Config{Transcription: config.TranscriptionConfig{
		S3Endpoint:  "https://storage.example.test",
		S3Region:    "eu-central-1",
		S3Bucket:    "videos",
		S3AccessKey: "access",
		S3SecretKey: "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	value := storage.presignMultipartPart("transcription-video/session/upload.mp4", "multipart-id", 3, 24*time.Hour, 16777216)
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if query.Get("partNumber") != "3" || query.Get("uploadId") != "multipart-id" {
		t.Fatalf("multipart scope missing from presigned URL: %s", value)
	}
	if query.Get("X-Amz-SignedHeaders") != "content-length;host" || query.Get("X-Amz-Signature") == "" {
		t.Fatalf("presigned URL is missing its signature: %s", value)
	}
	if !strings.Contains(value, "/videos/transcription-video/session/upload.mp4?") {
		t.Fatalf("presigned URL does not target the expected object: %s", value)
	}
}

func TestVideoPlaybackPresignUsesAuthorizedObjectKey(t *testing.T) {
	application := &App{Config: config.Config{Transcription: config.TranscriptionConfig{
		S3Endpoint:  "https://storage.example.test",
		S3Region:    "eu-central-1",
		S3Bucket:    "videos",
		S3AccessKey: "access",
		S3SecretKey: "secret",
	}}}
	value, expiresAt, err := application.videoPlaybackURL(nil, videoUploadRecord{
		storageDriver: "s3",
		storageKey:    "transcription-video/session/video.mp4",
	})
	if err != nil {
		t.Fatal(err)
	}
	if expiresAt.IsZero() || !expiresAt.After(time.Now()) {
		t.Fatalf("playback URL did not receive a future expiration: %s", expiresAt)
	}
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Path != "/videos/transcription-video/session/video.mp4" {
		t.Fatalf("playback URL does not target the expected object: %s", value)
	}
	query := parsed.Query()
	if query.Get("X-Amz-SignedHeaders") != "host" || query.Get("X-Amz-Signature") == "" {
		t.Fatalf("playback URL is missing its signature: %s", value)
	}
	if query.Get("X-Amz-Expires") != "86400" {
		t.Fatalf("unexpected playback URL lifetime: %s", value)
	}
}

func TestVideoDiarizationPresignUsesProcessingEndpoint(t *testing.T) {
	storage, err := newS3Storage(config.Config{Transcription: config.TranscriptionConfig{
		S3Endpoint:           "http://localhost:9000",
		S3ProcessingEndpoint: "http://host.containers.internal:9000",
		S3Region:             "us-east-1",
		S3Bucket:             "videos",
		S3AccessKey:          "access",
		S3SecretKey:          "secret",
	}})
	if err != nil {
		t.Fatal(err)
	}
	browserURL, err := url.Parse(storage.presignURL(http.MethodGet, "video.mp4", nil, time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	processingURL, err := url.Parse(storage.presignProcessingURL(http.MethodGet, "video.mp4", nil, time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if browserURL.Host != "localhost:9000" {
		t.Fatalf("browser presign changed endpoint: %s", browserURL)
	}
	if processingURL.Host != "host.containers.internal:9000" {
		t.Fatalf("processing presign did not use the container endpoint: %s", processingURL)
	}
	if processingURL.Query().Get("X-Amz-Signature") == "" {
		t.Fatalf("processing presign is missing its signature: %s", processingURL)
	}
}

func TestMultipartCompletionUsesS3RootElement(t *testing.T) {
	payload, err := xml.Marshal(s3MultipartCompletion{Parts: []s3MultipartPart{{PartNumber: 1, ETag: `"etag"`}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(payload), `<CompleteMultipartUpload>`) {
		t.Fatalf("unexpected multipart completion XML: %s", payload)
	}
}

func TestFFmpegVideoAudioArgsUseSeekableAudioInput(t *testing.T) {
	args := ffmpegVideoAudioArgs("https://storage.example.test/video.mp4")
	joined := strings.Join(args, " ")
	for _, expected := range []string{
		"-err_detect ignore_err",
		"-fflags +discardcorrupt",
		"-i https://storage.example.test/video.mp4",
		"-map 0:a:0?",
		"-f s16le pipe:1",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("ffmpeg args are missing %q: %s", expected, joined)
		}
	}
	if strings.Contains(joined, "pipe:0") {
		t.Fatalf("ffmpeg should not receive video through stdin: %s", joined)
	}
}

func TestChooseVideoDiarizationSpeakerUsesGreatestOverlap(t *testing.T) {
	intervals := []videoDiarizationInterval{
		{speaker: "SPEAKER_01", start: 0, end: 900},
		{speaker: "SPEAKER_00", start: 800, end: 2000},
	}
	if got := chooseVideoDiarizationSpeaker(700, 1500, intervals); got != "SPEAKER_00" {
		t.Fatalf("expected greatest-overlap speaker, got %q", got)
	}

	tie := []videoDiarizationInterval{
		{speaker: "SPEAKER_02", start: 0, end: 500},
		{speaker: "SPEAKER_01", start: 500, end: 1000},
	}
	if got := chooseVideoDiarizationSpeaker(0, 1000, tie); got != "SPEAKER_01" {
		t.Fatalf("expected deterministic tie-breaker, got %q", got)
	}
}
