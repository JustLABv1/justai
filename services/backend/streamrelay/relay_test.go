package streamrelay

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testToken = "test-only-token-with-more-than-32-characters"

func testRelay(t *testing.T) *Relay {
	t.Helper()
	r, err := New(Config{Sources: map[string]string{"radio": "https://radio.example/live.mp3"}}, testToken)
	if err != nil {
		t.Fatal(err)
	}
	s := r.sources["radio"]
	s.manifest = Manifest{Epoch: "test-epoch", Oldest: 1, Latest: 1}
	s.segments[1] = bytes.Repeat([]byte{1, 2}, SegmentBytes/2)
	return r
}
func TestAuthenticatedFiniteResponses(t *testing.T) {
	r := testRelay(t)
	for _, tc := range []struct {
		method, path, token string
		status              int
	}{
		{"GET", "/v1/sources/radio", "", 401},
		{"GET", "/v1/sources/radio", "wrong", 401},
		{"POST", "/v1/sources/radio", testToken, 405},
		{"GET", "/v1/sources/missing", testToken, 404},
		{"GET", "/v1/sources/radio", testToken, 200},
		{"GET", "/v1/sources/radio/segments/1?epoch=test-epoch", testToken, 200},
		{"GET", "/v1/sources/radio/segments/1?epoch=old", testToken, 404},
		{"GET", "/v1/sources/radio/segments/2?epoch=test-epoch", testToken, 410},
		{"GET", "/v1/sources/radio?url=https://attacker.example", testToken, 404},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.Header.Set("Authorization", "Bearer "+tc.token)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != tc.status {
			t.Errorf("%s %s: %d", tc.method, tc.path, w.Code)
		}
		if tc.status == 200 && (w.Header().Get("Content-Length") == "" || w.Header().Get("Cache-Control") != "no-store") {
			t.Error("response must be finite and uncached")
		}
	}
}
func TestPublicAddressPolicy(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::"} {
		if publicIP(net.ParseIP(ip)) {
			t.Errorf("allowed %s", ip)
		}
	}
	for _, ip := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		if !publicIP(net.ParseIP(ip)) {
			t.Errorf("blocked public %s", ip)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if conn, err := guardedDial(ctx, "tcp", "127.0.0.1:443"); err == nil {
		conn.Close()
		t.Fatal("loopback dial allowed")
	}
}
func TestConfigurationFailsClosed(t *testing.T) {
	for _, raw := range []string{"http://radio.example/live", "https://user:secret@radio.example/live", "https://127.0.0.1/live", "https://radio.example:8080/live", "file:///etc/passwd"} {
		if _, err := New(Config{Sources: map[string]string{"radio": raw}}, testToken); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	if _, err := New(Config{Sources: map[string]string{"radio": "https://radio.example/live"}}, "short"); err == nil {
		t.Fatal("short token accepted")
	}
}
func configureClient(t *testing.T, base string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(testToken), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JUSTAI_STREAM_RELAY_URL", base)
	t.Setenv("JUSTAI_STREAM_RELAY_TOKEN_FILE", path)
}
func TestClientPollsFiniteAudioAndCancels(t *testing.T) {
	srv := httptest.NewTLSServer(testRelay(t))
	defer srv.Close()
	configureClient(t, srv.URL)
	c, err := ForSource(srv.URL + "/v1/sources/radio")
	if err != nil {
		t.Fatal(err)
	}
	c.http = srv.Client()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader := c.Open(ctx)
	defer reader.Close()
	pcm := make([]byte, SegmentBytes)
	if _, err = io.ReadFull(reader, pcm); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pcm, bytes.Repeat([]byte{1, 2}, SegmentBytes/2)) {
		t.Fatal("audio changed")
	}
	cancel()
	done := make(chan error, 1)
	go func() { _, err := reader.Read(make([]byte, 1)); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("reader did not cancel")
	}
}
func TestClientOriginAndPathIsolation(t *testing.T) {
	configureClient(t, "https://relay.example")
	for _, raw := range []string{"https://relay.example/v1/sources/a?token=secret", "https://relay.example/v1/sources/../admin", "https://user:secret@relay.example/v1/sources/a", "https://relay.example/v1/sources/a/segments/1"} {
		if _, err := ForSource(raw); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	c, err := ForSource("https://other.example/v1/sources/a")
	if c != nil || err != nil {
		t.Fatal("unrelated URL treated as relay")
	}
}
func TestClientRejectsUntrustedTLSAndRedirects(t *testing.T) {
	srv := httptest.NewTLSServer(testRelay(t))
	defer srv.Close()
	configureClient(t, srv.URL)
	c, _ := ForSource(srv.URL + "/v1/sources/radio")
	if _, err := c.Manifest(context.Background()); err == nil {
		t.Fatal("untrusted TLS accepted")
	}
	var leaked bool
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true; w.WriteHeader(200) }))
	defer other.Close()
	redirect := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, 302) }))
	defer redirect.Close()
	configureClient(t, redirect.URL)
	c, _ = ForSource(redirect.URL + "/v1/sources/radio")
	// Trust the test CA while retaining the production redirect policy.
	c.http.Transport = redirect.Client().Transport
	if _, err := c.Manifest(context.Background()); err == nil {
		t.Fatal("redirect accepted")
	}
	if leaked {
		t.Fatal("authorization sent to redirect target")
	}
}
func TestClientRejectsTruncatedAudio(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/segments/") {
			_, _ = w.Write([]byte("bad"))
			return
		}
		_, _ = io.WriteString(w, `{"epoch":"e","oldest":1,"latest":1}`)
	}))
	defer srv.Close()
	configureClient(t, srv.URL)
	c, _ := ForSource(srv.URL + "/v1/sources/radio")
	c.http = srv.Client()
	reader := c.Open(context.Background())
	defer reader.Close()
	if _, err := io.ReadAll(reader); err == nil {
		t.Fatal("truncated audio accepted")
	}
}
