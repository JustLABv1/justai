package server

import (
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"strings"
	"testing"
	"time"

	"justai-backend/outbound"
)

func TestResolveLivestreamPages(t *testing.T) {
	var base string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/audio.mp3":
			w.Header().Set("Content-Type", "audio/mpeg")
			w.Write([]byte("audio"))
		case "/page":
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte(`<audio src="/audio.mp3"></audio>`))
		case "/script":
			w.Write([]byte(`<script>const stream="` + base + `/audio.mp3"</script>`))
		case "/frame":
			w.Write([]byte(`<iframe src="/page"></iframe>`))
		case "/ambiguous":
			w.Write([]byte(`<audio src="/audio.mp3"></audio><video src="/other.m3u8"></video>`))
		case "/loop":
			w.Write([]byte(`<source src="/loop">`))
		case "/offline":
			w.WriteHeader(503)
		default:
			w.Write([]byte(`<h1>No livestream</h1>`))
		}
	}))
	defer srv.Close()
	base = srv.URL
	for _, path := range []string{"/audio.mp3", "/page", "/script", "/frame"} {
		t.Run(path, func(t *testing.T) {
			got, err := resolveLiveStreamWithClient(context.Background(), base+path, true, srv.Client(), 0)
			if err != nil || got.URL != base+"/audio.mp3" {
				t.Fatalf("got %+v, %v", got, err)
			}
		})
	}
	for _, path := range []string{"/ambiguous", "/loop", "/offline", "/unknown"} {
		t.Run(path, func(t *testing.T) {
			if _, err := resolveLiveStreamWithClient(context.Background(), base+path, true, srv.Client(), 0); err == nil {
				t.Fatal("unsupported source accepted")
			}
		})
	}
	if _, err := resolveLiveStreamWithClient(context.Background(), base+"/page", false, srv.Client(), 0); err == nil {
		t.Fatal("private target accepted")
	}
}

func TestResolveBundestagUsesOfficialAudio(t *testing.T) {
	client := &http.Client{Transport: resolverTestTransport(func(r *http.Request) (*http.Response, error) {
		body, ct := `<a href="https://media.example/audio.mp3">Audio</a>`, "text/html"
		if r.URL.Host == "media.example" {
			body, ct = "audio", "audio/mpeg"
		} else if r.URL.String() != "https://www.bundestag.de/mediathek/276184-276184" {
			t.Fatalf("unexpected page %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{ct}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	got, err := resolveLiveStreamWithClient(context.Background(), "https://www.bundestag.de/mediathek/live", true, client, 0)
	if err != nil || got.URL != "https://media.example/audio.mp3" || got.Name != "Bundestag · Plenary audio" {
		t.Fatalf("got %+v, %v", got, err)
	}
}

type resolverTestTransport func(*http.Request) (*http.Response, error)

func (f resolverTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestLivestreamResolverAndCaptureThroughProxy(t *testing.T) {
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "REQUEST_METHOD"} {
		t.Setenv(key, "")
	}
	wav := append(liveStreamWAVHeader(), make([]byte, 3200)...)
	binary.LittleEndian.PutUint32(wav[4:8], uint32(len(wav)-8))
	binary.LittleEndian.PutUint32(wav[40:44], 3200)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if username, password, ok := r.BasicAuth(); ok || username != "" || password != "" {
			t.Error("proxy credentials sent as destination authorization")
		}
		if r.Header.Get("Proxy-Authorization") != "Basic dXNlcjpzZWNyZXQ=" {
			w.Header().Set("Proxy-Authenticate", `Basic realm="egress"`)
			w.WriteHeader(http.StatusProxyAuthRequired)
			return
		}
		if r.URL.Hostname() != "8.8.8.8" {
			t.Errorf("unexpected proxy target: %s", r.URL)
		}
		if r.URL.Path == "/page" {
			w.Write([]byte(`<audio src="/audio.wav"></audio>`))
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
		w.Write(wav)
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	proxyURL.User = url.UserPassword("user", "secret")
	t.Setenv("HTTP_PROXY", proxyURL.String())
	resolved, err := resolveLiveStream(context.Background(), "http://8.8.8.8/page", false)
	if err != nil || resolved.URL != "http://8.8.8.8/audio.wav" {
		t.Fatalf("resolution failed: %+v, %v", resolved, err)
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is required for capture test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", ffmpegLiveAudioArgs(resolved.URL, "http")...)
	cmd.Env, err = outbound.MediaProxyEnv(resolved.URL)
	if err != nil {
		t.Fatal(err)
	}
	pcm, err := cmd.Output()
	if err != nil {
		t.Fatalf("proxy capture failed: %v", err)
	}
	if len(pcm) != 3200 {
		t.Fatalf("decoded %d bytes, want 3200", len(pcm))
	}
}
