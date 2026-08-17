package server

import (
	"encoding/xml"
	"net/url"
	"strings"
	"testing"
	"time"

	"justai-backend/config"
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

func TestMultipartCompletionUsesS3RootElement(t *testing.T) {
	payload, err := xml.Marshal(s3MultipartCompletion{Parts: []s3MultipartPart{{PartNumber: 1, ETag: `"etag"`}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(payload), `<CompleteMultipartUpload>`) {
		t.Fatalf("unexpected multipart completion XML: %s", payload)
	}
}
