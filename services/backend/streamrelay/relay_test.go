package streamrelay

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
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

func TestRingEvictionAndSlowClientsDoNotBlockCapture(t *testing.T) {
	r := testRelay(t)
	s := r.sources["radio"]
	for i := 0; i < 20; i++ {
		s.append(make([]byte, SegmentBytes))
	}
	if len(s.segments) != RetainedSegments || s.manifest.Oldest != 10 || s.manifest.Latest != 21 {
		t.Fatalf("unbounded/incorrect ring: %+v, %d", s.manifest, len(s.segments))
	}
	req := httptest.NewRequest("GET", "/v1/sources/radio/segments/21?epoch=test-epoch", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	w := &blockingWriter{header: make(http.Header), started: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() { r.ServeHTTP(w, req); close(done) }()
	<-w.started
	appended := make(chan struct{})
	go func() { s.append(make([]byte, SegmentBytes)); close(appended) }()
	select {
	case <-appended:
	case <-time.After(time.Second):
		close(w.release)
		t.Fatal("slow client blocked source capture")
	}
	close(w.release)
	<-done
}

type blockingWriter struct {
	header           http.Header
	started, release chan struct{}
}

func (w *blockingWriter) Header() http.Header { return w.header }
func (w *blockingWriter) WriteHeader(int)     {}
func (w *blockingWriter) Write(b []byte) (int, error) {
	close(w.started)
	<-w.release
	return len(b), nil
}

func TestMP3DecodeProducesCompleteSegments(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=11", "-f", "mp3", "pipe:1")
	mp3, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write(mp3)
	}))
	defer upstream.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	count := 0
	err = captureWithClient(ctx, upstream.URL, func(pcm []byte) {
		if len(pcm) != SegmentBytes {
			t.Errorf("incomplete segment: %d", len(pcm))
		}
		if bytes.Equal(pcm, make([]byte, SegmentBytes)) {
			t.Error("decoded audio is silent")
		}
		count++
	}, upstream.Client(), SegmentBytes)
	if err == nil || count != 2 {
		t.Fatalf("decoded %d complete segments; err=%v", count, err)
	}
}

func TestSourceListAndParsedNames(t *testing.T) {
	cfg, err := ParseSources("a=https://x.example/a.mp3,b=Plenary audio|https://x.example/b.mp3")
	if err != nil || cfg.Names["b"] != "Plenary audio" || cfg.Sources["b"] != "https://x.example/b.mp3" || cfg.Names["a"] != "" {
		t.Fatalf("unexpected parse result %+v err=%v", cfg, err)
	}
	r, err := New(cfg, testToken)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewTLSServer(r)
	defer srv.Close()
	configureClient(t, srv.URL)
	// ListSources needs the test server's CA, so exercise the handler directly.
	for _, tc := range []struct {
		auth string
		want int
	}{{"", 401}, {"Bearer " + testToken, 200}} {
		req := httptest.NewRequest("GET", "/v1/sources", nil)
		if tc.auth != "" {
			req.Header.Set("Authorization", tc.auth)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("auth %q: got %d", tc.auth, rec.Code)
		}
		if tc.want == 200 {
			body := rec.Body.String()
			if !strings.Contains(body, `{"id":"b","name":"Plenary audio","status":"offline"}`) || !strings.Contains(body, `{"id":"a","name":"a","status":"offline"}`) || strings.Contains(body, "x.example") {
				t.Fatalf("unexpected list %s", body)
			}
		}
	}
}

func TestSegmentSecondsAndStatus(t *testing.T) {
	r, err := New(Config{Sources: map[string]string{"radio": "https://radio.example/live.mp3"}, SegmentSeconds: 2}, testToken)
	if err != nil {
		t.Fatal(err)
	}
	if r.segBytes != 64000 || r.retained != 30 {
		t.Fatalf("segBytes=%d retained=%d", r.segBytes, r.retained)
	}
	s := r.sources["radio"]
	if s.status(false) != "offline" || s.status(true) != "idle" {
		t.Fatal("unexpected initial status")
	}
	s.append(make([]byte, r.segBytes))
	if s.status(true) != "live" {
		t.Fatal("expected live after a segment")
	}
	req := httptest.NewRequest("GET", "/v1/sources/radio", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"segmentSeconds":2`) {
		t.Fatalf("manifest %s", rec.Body.String())
	}
	req = httptest.NewRequest("GET", "/v1/sources/radio/segments/1?epoch="+s.manifest.Epoch, nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Body.Len() != 64044 {
		t.Fatalf("segment size %d", rec.Body.Len())
	}
	for _, bad := range []int{-1, 11} {
		if _, err := New(Config{Sources: map[string]string{"a": "https://radio.example/a.mp3"}, SegmentSeconds: bad}, testToken); err == nil {
			t.Fatalf("segment length %d accepted", bad)
		}
	}
}

func TestOnDemandWakesAndIdlesWithFreshEpoch(t *testing.T) {
	r, err := New(Config{Sources: map[string]string{"radio": "https://radio.example/live.mp3"}, OnDemand: true, IdleSeconds: 10}, testToken)
	if err != nil {
		t.Fatal(err)
	}
	s := r.sources["radio"]
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if s.waitDemand(ctx, 10*time.Second) {
		t.Fatal("capture started without any request")
	}
	s.touch()
	if !s.waitDemand(context.Background(), 10*time.Second) {
		t.Fatal("request did not wake the source")
	}
	// An old request no longer counts as demand.
	s.Lock()
	s.lastRequest = time.Now().Add(-time.Minute)
	s.Unlock()
	ctx2, cancel2 := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel2()
	if s.waitDemand(ctx2, 10*time.Second) {
		t.Fatal("stale request woke the source")
	}
	s.append(make([]byte, r.segBytes))
	old := s.manifest.Epoch
	s.setWanted(true)
	s.idleStopped(r.log, time.Now(), 0)
	if s.manifest.Epoch == old || s.manifest.Latest != 0 || len(s.segments) != 0 || s.status(true) != "idle" {
		t.Fatalf("idle stop did not reset: %+v", s.manifest)
	}
	if r.metrics.gauge("relay_upstream_wanted", "source", "radio") != 0 || r.metrics.gauge("relay_upstream_up", "source", "radio") != 0 {
		t.Fatal("an idle source must not count as wanted or up")
	}
}

func TestEverySourceExportsUpAndWanted(t *testing.T) {
	for _, onDemand := range []bool{false, true} {
		r, err := New(Config{Sources: map[string]string{"radio": "https://radio.example/live.mp3"}, OnDemand: onDemand}, testToken)
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		r.metrics.write(&out)
		wanted := `relay_upstream_wanted{source="radio"} 1`
		if onDemand {
			wanted = `relay_upstream_wanted{source="radio"} 0`
		}
		if !strings.Contains(out.String(), `relay_upstream_up{source="radio"} 0`) || !strings.Contains(out.String(), wanted) {
			t.Fatalf("on-demand=%v: missing initial source metrics:\n%s", onDemand, out.String())
		}
	}
}

func TestMultipleRelaysAndMetrics(t *testing.T) {
	good := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"sources":[{"id":"a","name":"Alpha","status":"live"},{"id":"../x","name":"bad"}]}`)
	}))
	defer good.Close()
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(testToken), 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = Configure(Endpoint{}, nil) })
	if err := Configure(Endpoint{Name: "One", URL: "https://one.example", TokenFile: path}, []Endpoint{{Name: "Two", URL: "https://two.example", Token: testToken}}); err != nil {
		t.Fatal(err)
	}
	if err := Configure(Endpoint{URL: "https://one.example", TokenFile: path}, []Endpoint{{URL: "https://ONE.example", Token: testToken}}); err == nil {
		t.Fatal("duplicate relay accepted")
	}
	if err := Configure(Endpoint{Name: "One", URL: "https://one.example", TokenFile: path}, []Endpoint{{Name: "Two", URL: "https://two.example", Token: testToken}}); err != nil {
		t.Fatal(err)
	}
	// Each relay's own token and origin are used for matching sources.
	c, err := ForSource("https://two.example/v1/sources/radio")
	if err != nil || c == nil || c.relay != "Two" {
		t.Fatalf("client=%v err=%v", c, err)
	}
	if c, err = ForSource("https://three.example/v1/sources/radio"); c != nil || err != nil {
		t.Fatal("unconfigured relay matched")
	}
	// Unreachable relays are reported, not fatal, and counted in metrics.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := ListSources(ctx); err == nil {
		t.Fatal("expected an error when no relay is reachable")
	}
	var out strings.Builder
	WriteClientMetrics(&out)
	if !strings.Contains(out.String(), `justai_stream_relay_list_errors_total{relay="One"} 1`) || !strings.Contains(out.String(), `justai_stream_relay_list_errors_total{relay="Two"} 1`) {
		t.Fatalf("metrics:\n%s", out.String())
	}
}
