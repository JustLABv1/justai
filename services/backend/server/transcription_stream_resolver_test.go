package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
