package streamrelay

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParsePlaylistMasterAndMedia(t *testing.T) {
	master, err := parsePlaylist([]byte("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"de\",DEFAULT=YES,URI=\"audio/de.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS=\"avc1.4d401f,mp4a.40.2\",AUDIO=\"a\"\nvideo.m3u8\n"))
	if err != nil || !master.master {
		t.Fatalf("master not parsed: %+v %v", master, err)
	}
	if ref, _ := selectMediaPlaylist(master); ref != "audio/de.m3u8" {
		t.Fatalf("audio rendition not preferred: %q", ref)
	}
	variants, _ := parsePlaylist([]byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=131225,CODECS=\"mp4a.40.2\"\nlow.m3u8\n"))
	if ref, _ := selectMediaPlaylist(variants); ref != "low.m3u8" {
		t.Fatalf("lowest variant not chosen: %q", ref)
	}
	media, err := parsePlaylist([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:41\n#EXTINF:6.0,\na.aac\n#EXTINF:6.0,\nb.aac\n"))
	if err != nil || media.master || len(media.segments) != 2 || media.segments[1].sequence != 42 || media.targetDuration != 6*time.Second || media.ended {
		t.Fatalf("media playlist parsed wrong: %+v %v", media, err)
	}
	for _, bad := range []string{
		"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:6,\na.ts\n",
		"#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\na.m4s\n",
		"#EXTM3U\n#EXT-X-BYTERANGE:100@0\na.ts\n",
	} {
		if _, err := parsePlaylist([]byte(bad)); !errors.Is(err, errHLSUnsupported) {
			t.Errorf("unsupported playlist accepted: %q (%v)", bad, err)
		}
	}
	if _, err := parsePlaylist([]byte("<html>")); err == nil {
		t.Error("non-playlist accepted")
	}
}

func TestHLSReferencesFollowSourcePolicy(t *testing.T) {
	base, _ := url.Parse("https://cdn.example/live/playlist.m3u8")
	if u, err := resolveHLSRef(base, "chunks.m3u8"); err != nil || u.String() != "https://cdn.example/live/chunks.m3u8" {
		t.Fatalf("relative reference: %v %v", u, err)
	}
	for _, ref := range []string{"http://cdn.example/a.aac", "https://127.0.0.1/a.aac", "https://10.0.0.1/a.aac", "https://user:pw@cdn.example/a.aac", "https://cdn.example:8443/a.aac", "file:///etc/passwd"} {
		if _, err := resolveHLSRef(base, ref); err == nil {
			t.Errorf("forbidden reference accepted: %s", ref)
		}
	}
}

func TestStripID3AndSegmentFormat(t *testing.T) {
	adts := []byte{0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc}
	tagged := append([]byte{'I', 'D', '3', 4, 0, 0, 0, 0, 0, 3, 1, 2, 3}, adts...)
	if got := stripID3(tagged); !bytes.Equal(got, adts) {
		t.Fatalf("ID3 not stripped: %x", got)
	}
	if f, _ := segmentFormat(adts); f != "aac" {
		t.Fatalf("ADTS detected as %q", f)
	}
	if f, _ := segmentFormat([]byte{0xff, 0xfb, 0x90, 0x00}); f != "mp3" {
		t.Fatalf("MP3 detected as %q", f)
	}
	ts := make([]byte, 376)
	ts[0], ts[188] = 0x47, 0x47
	if f, _ := segmentFormat(ts); f != "mpegts" {
		t.Fatalf("TS detected as %q", f)
	}
	if _, err := segmentFormat([]byte("<html>")); err == nil {
		t.Fatal("HTML accepted as audio")
	}
}

// allowLoopbackHLS lets playlists reference the httptest TLS server.
func allowLoopbackHLS(t *testing.T) {
	t.Helper()
	strict := hlsRefPolicy
	hlsRefPolicy = func(u *url.URL) error {
		if u.Scheme == "https" && u.Hostname() == "127.0.0.1" {
			return nil
		}
		return strict(u)
	}
	t.Cleanup(func() { hlsRefPolicy = strict })
}

func encodeADTSSegments(t *testing.T, count int) [][]byte {
	t.Helper()
	allowLoopbackHLS(t)
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	segments := make([][]byte, count)
	for i := range segments {
		cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=%d:duration=4", 300+100*i), "-c:a", "aac", "-f", "adts", "pipe:1")
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		// Packed-audio HLS prefixes segments with an ID3 timestamp tag.
		segments[i] = append([]byte{'I', 'D', '3', 4, 0, 0, 0, 0, 0, 2, 0, 0}, out...)
	}
	return segments
}

func TestHLSMasterAndADTSSegmentsDecode(t *testing.T) {
	segments := encodeADTSSegments(t, 3)
	var mux http.ServeMux
	mux.HandleFunc("/playlist.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		fmt.Fprint(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=131225,CODECS=\"mp4a.40.2\"\nchunks.m3u8\n")
	})
	mux.HandleFunc("/chunks.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		var b strings.Builder
		b.WriteString("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:7\n")
		for i := range segments {
			fmt.Fprintf(&b, "#EXTINF:4.0,\nseg%d.aac\n", i)
		}
		b.WriteString("#EXT-X-ENDLIST\n")
		fmt.Fprint(w, b.String())
	})
	for i, seg := range segments {
		mux.HandleFunc(fmt.Sprintf("/seg%d.aac", i), func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "audio/aac")
			_, _ = w.Write(seg)
		})
	}
	upstream := httptest.NewTLSServer(&mux)
	defer upstream.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	count := 0
	err := captureWithClient(ctx, upstream.URL+"/playlist.m3u8", func(pcm []byte) {
		if len(pcm) != SegmentBytes {
			t.Errorf("incomplete segment: %d", len(pcm))
		}
		if bytes.Equal(pcm, make([]byte, SegmentBytes)) {
			t.Error("decoded audio is silent")
		}
		count++
	}, upstream.Client(), SegmentBytes)
	// 12 s of audio yields two complete 5 s segments before the playlist ends.
	if err == nil || count != 2 {
		t.Fatalf("decoded %d complete segments; err=%v", count, err)
	}
}

func TestHLSLiveStartsAtEdgeAndFollowsNewSegments(t *testing.T) {
	segments := encodeADTSSegments(t, 6)
	var next atomic.Int64
	next.Store(5) // segments 0..4 are published at start
	var fetched [6]atomic.Bool
	var mux http.ServeMux
	mux.HandleFunc("/live.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		n := int(next.Load())
		var b strings.Builder
		b.WriteString("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n")
		for i := 0; i < n; i++ {
			fmt.Fprintf(&b, "#EXTINF:4.0,\nseg%d.aac\n", i)
		}
		if n == len(segments) {
			b.WriteString("#EXT-X-ENDLIST\n")
		}
		fmt.Fprint(w, b.String())
	})
	for i, seg := range segments {
		mux.HandleFunc(fmt.Sprintf("/seg%d.aac", i), func(w http.ResponseWriter, r *http.Request) {
			fetched[i].Store(true)
			_, _ = w.Write(seg)
		})
	}
	upstream := httptest.NewTLSServer(&mux)
	defer upstream.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { time.Sleep(1500 * time.Millisecond); next.Store(6) }()
	count := 0
	_ = captureWithClient(ctx, upstream.URL+"/live.m3u8", func([]byte) { count++ }, upstream.Client(), SegmentBytes)
	if fetched[0].Load() || fetched[1].Load() {
		t.Error("capture started before the live edge")
	}
	if !fetched[2].Load() || !fetched[5].Load() {
		t.Error("live edge or newly published segment was not fetched")
	}
	if count != 3 { // 4 segments x 4 s = 16 s -> three complete 5 s segments
		t.Fatalf("decoded %d segments", count)
	}
}

func TestHLSRejectsForeignContent(t *testing.T) {
	allowLoopbackHLS(t)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/p.m3u8" {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			fmt.Fprint(w, "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nx.aac\n#EXT-X-ENDLIST\n")
			return
		}
		fmt.Fprint(w, "<html>not audio</html>")
	}))
	defer upstream.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := captureWithClient(ctx, upstream.URL+"/p.m3u8", func([]byte) {}, upstream.Client(), SegmentBytes)
	if !errors.Is(err, errHLSUnsupported) {
		t.Fatalf("expected unsupported content error, got %v", err)
	}
}
