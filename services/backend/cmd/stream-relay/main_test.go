package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"justai-backend/streamrelay"
)

func TestHTTPIngressModeWithoutCertificatesRetainsAuthentication(t *testing.T) {
	const token = "test-only-relay-token-at-least-32-characters"
	relay, err := streamrelay.New(streamrelay.Config{Sources: map[string]string{"radio": "https://radio.example/live.mp3"}}, token)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: relay, ReadHeaderTimeout: time.Second}
	done := make(chan error, 1)
	go func() { done <- serveRelay(srv, listener, true, "/nonexistent/tls.crt", "/nonexistent/tls.key") }()
	t.Cleanup(func() {
		_ = srv.Close()
		if err := <-done; err != http.ErrServerClosed {
			t.Errorf("HTTP server: %v", err)
		}
	})
	client := &http.Client{Timeout: 2 * time.Second}
	defer client.CloseIdleConnections()
	for _, auth := range []bool{false, true} {
		req, err := http.NewRequestWithContext(context.Background(), "GET", "http://"+listener.Addr().String()+"/v1/sources/radio", nil)
		if err != nil {
			t.Fatal(err)
		}
		// Forwarded headers must not bypass application authentication.
		req.Header.Set("X-Forwarded-Proto", "https")
		if auth {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		want := http.StatusUnauthorized
		if auth {
			want = http.StatusOK
		}
		if resp.StatusCode != want {
			t.Fatalf("authenticated=%v: got HTTP %d, want %d", auth, resp.StatusCode, want)
		}
	}
}

func TestHTTPSModeDoesNotFallBackWhenCertificatesAreMissing(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	srv := &http.Server{ReadHeaderTimeout: time.Second}
	defer srv.Close()
	if err := serveRelay(srv, listener, false, "/nonexistent/tls.crt", "/nonexistent/tls.key"); err == nil {
		t.Fatal("HTTPS mode must fail without certificates rather than serve plaintext")
	}
}
