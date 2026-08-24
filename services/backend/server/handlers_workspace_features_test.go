package server

import (
	"encoding/base64"
	"testing"
)

func TestValidateGeneratedImageChecksBytesAndDeclaredType(t *testing.T) {
	encoded := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if _, mimeType, err := validateGeneratedImage(data, "image/png"); err != nil || mimeType != "image/png" {
		t.Fatalf("valid PNG rejected: mime=%q err=%v", mimeType, err)
	}
	if _, _, err := validateGeneratedImage(data, "image/jpeg"); err == nil {
		t.Fatal("expected declared MIME mismatch to be rejected")
	}
	if _, _, err := validateGeneratedImage([]byte("not an image"), "image/png"); err == nil {
		t.Fatal("expected invalid image bytes to be rejected")
	}
}
