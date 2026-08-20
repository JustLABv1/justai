package server

import (
	"encoding/xml"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

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
	value := storage.presignMultipartPart("transcription-video/session/upload.mp4", "multipart-id", 3, 24*time.Hour)
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if query.Get("partNumber") != "3" || query.Get("uploadId") != "multipart-id" {
		t.Fatalf("multipart scope missing from presigned URL: %s", value)
	}
	if query.Get("X-Amz-SignedHeaders") != "host" || query.Get("X-Amz-Signature") == "" {
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
