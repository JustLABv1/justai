package streamrelay

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const RetainedSegments = 12

// Sources are an operator-owned allowlist, never supplied by API clients.
type Config struct {
	Sources map[string]string `json:"sources"`
}
type source struct {
	sync.RWMutex
	id       string
	metrics  *metrics
	manifest Manifest
	segments map[uint64][]byte
}
type Relay struct {
	tokens   [][32]byte
	throttle *authThrottle
	sources  map[string]*source
	slots    chan struct{}
	inflight atomic.Int64
	metrics  *metrics
	log      *slog.Logger
}

var errBadUpstream = errors.New("upstream must return audio/mpeg with HTTP 200; redirects are forbidden")

func New(cfg Config, token string) (*Relay, error) { return NewWithTokens(cfg, []string{token}) }

// NewWithTokens accepts up to four tokens so a new one can be rolled out
// before the old one is removed (rotation without downtime).
func NewWithTokens(cfg Config, tokens []string) (*Relay, error) {
	if len(tokens) == 0 || len(tokens) > 4 {
		return nil, fmt.Errorf("configure between one and four relay tokens")
	}
	hashed := make([][32]byte, 0, len(tokens))
	for _, token := range tokens {
		if len(token) < 32 || strings.ContainsAny(token, "\r\n") {
			return nil, fmt.Errorf("relay token must contain at least 32 characters without newlines")
		}
		hashed = append(hashed, sha256.Sum256([]byte(token)))
	}
	if len(cfg.Sources) == 0 || len(cfg.Sources) > 8 {
		return nil, fmt.Errorf("configure between one and eight sources")
	}
	r := &Relay{tokens: hashed, throttle: newAuthThrottle(), sources: make(map[string]*source), slots: make(chan struct{}, 32), metrics: newMetrics(), log: slog.Default()}
	for id, raw := range cfg.Sources {
		u, err := url.Parse(raw)
		if !sourceID.MatchString(id) || err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
			return nil, fmt.Errorf("source %q requires a direct HTTPS MP3 URL on port 443 without credentials", id)
		}
		if ip := net.ParseIP(u.Hostname()); ip != nil && !publicIP(ip) {
			return nil, fmt.Errorf("source %q has a forbidden address", id)
		}
		r.sources[id] = &source{id: id, metrics: r.metrics, segments: make(map[uint64][]byte), manifest: Manifest{Epoch: randomEpoch()}}
	}
	return r, nil
}
func randomEpoch() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// SetLogger replaces the structured logger (JSON on stdout by default in main).
func (r *Relay) SetLogger(l *slog.Logger) { r.log = l }

type recorder struct {
	http.ResponseWriter
	status   int
	bytes    int
	source   string // only ever a configured source ID or "none"
	endpoint string
	quiet    bool // throttled: counted in metrics but not logged per request
}

func (rec *recorder) WriteHeader(c int) { rec.status = c; rec.ResponseWriter.WriteHeader(c) }
func (rec *recorder) Write(b []byte) (int, error) {
	if rec.status == 0 {
		rec.status = 200
	}
	n, err := rec.ResponseWriter.Write(b)
	rec.bytes += n
	return n, err
}

var requestID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	start := time.Now()
	id := req.Header.Get("X-Request-ID")
	if !requestID.MatchString(id) {
		id = randomEpoch()[:16]
	}
	w.Header().Set("X-Request-ID", id)
	rec := &recorder{ResponseWriter: w, source: "none", endpoint: "other"}
	r.metrics.set("relay_http_inflight_requests", float64(r.inflight.Add(1)))
	defer func() { r.metrics.set("relay_http_inflight_requests", float64(r.inflight.Add(-1))) }()
	r.serve(rec, req)
	if rec.status == 0 {
		rec.status = 200
	}
	elapsed := time.Since(start)
	code := strconv.Itoa(rec.status)
	r.metrics.add("relay_http_requests_total", 1, "source", rec.source, "endpoint", rec.endpoint, "code", code)
	r.metrics.add("relay_http_response_bytes_total", float64(rec.bytes), "source", rec.source)
	r.metrics.observe("relay_http_request_duration_seconds", elapsed.Seconds(), "endpoint", rec.endpoint)
	if rec.quiet {
		return
	}
	// Never log the Authorization header, query string (epoch) or raw path.
	level := slog.LevelInfo
	if rec.endpoint == "health" && rec.status == 200 {
		level = slog.LevelDebug // frequent probes would drown real traffic
	}
	if rec.status == 401 || rec.status >= 500 {
		level = slog.LevelWarn
	}
	r.log.LogAttrs(req.Context(), level, "request", slog.String("request_id", id), slog.String("remote", remoteHost(req.RemoteAddr)),
		slog.String("source", rec.source), slog.String("endpoint", rec.endpoint), slog.Int("status", rec.status),
		slog.Int("bytes", rec.bytes), slog.Duration("duration", elapsed))
}

func remoteHost(addr string) string {
	if h, _, err := net.SplitHostPort(addr); err == nil {
		return h
	}
	return addr
}

func (r *Relay) serve(w *recorder, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Unauthenticated liveness probe for uptime monitors and load balancers. It
	// reveals nothing (no sources, versions or upstream state) and takes no slot.
	if req.URL.Path == "/healthz" {
		w.endpoint = "health"
		if req.Method != http.MethodGet && req.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", 405)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Length", "3")
		if req.Method == http.MethodGet {
			_, _ = w.Write([]byte("ok\n"))
		}
		return
	}
	supplied := sha256.Sum256([]byte(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")))
	valid := 0
	for i := range r.tokens { // no early exit: constant work per configured token
		valid |= subtle.ConstantTimeCompare(supplied[:], r.tokens[i][:])
	}
	if !strings.HasPrefix(req.Header.Get("Authorization"), "Bearer ") || valid != 1 {
		ip := remoteHost(req.RemoteAddr)
		if r.throttle.blocked(ip) {
			w.quiet = true
			w.Header().Set("Retry-After", strconv.Itoa(int(authBlockFor.Seconds())))
			http.Error(w, "too many failed attempts", 429)
			return
		}
		if r.throttle.fail(ip) {
			r.log.Warn("failed-auth threshold reached; throttling remote", "remote", ip, "for", authBlockFor)
		}
		http.Error(w, "unauthorized", 401)
		return
	}
	if req.Method != http.MethodGet {
		w.endpoint = "other"
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", 405)
		return
	}
	if req.URL.Path == "/metrics" {
		w.endpoint = "metrics"
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		r.metrics.write(w)
		return
	}
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	default:
		http.Error(w, "busy", 503)
		return
	}
	parts := strings.Split(strings.TrimPrefix(req.URL.Path, "/v1/sources/"), "/")
	if !strings.HasPrefix(req.URL.Path, "/v1/sources/") || len(parts) == 0 {
		http.NotFound(w, req)
		return
	}
	s := r.sources[parts[0]]
	if s == nil {
		http.NotFound(w, req)
		return
	}
	w.source = s.id
	w.endpoint = "manifest"
	if len(parts) == 3 {
		w.endpoint = "segment"
	}
	s.RLock()
	manifest := s.manifest
	segments := s.segments
	var segment []byte
	// Copy the reference while locked; stored segments are immutable.
	if len(parts) == 3 {
		seq, _ := strconv.ParseUint(parts[2], 10, 64)
		segment = segments[seq]
	}
	s.RUnlock()
	var body []byte
	if len(parts) == 1 && req.URL.RawQuery == "" {
		w.Header().Set("Content-Type", "application/json")
		body, _ = json.Marshal(manifest)
	} else if len(parts) == 3 && parts[1] == "segments" && req.URL.Query().Get("epoch") == manifest.Epoch {
		_, err := strconv.ParseUint(parts[2], 10, 64)
		if err != nil {
			http.NotFound(w, req)
			return
		}
		body = wavFile(segment)
		if body == nil {
			http.Error(w, "segment unavailable", 410)
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
	} else {
		http.NotFound(w, req)
		return
	}
	// Explicit finite length allows file-inspecting proxies to complete each response.
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	_, _ = w.Write(body)
}

func (r *Relay) Run(ctx context.Context, cfg Config) {
	for id, raw := range cfg.Sources {
		s := r.sources[id]
		go func() {
			for ctx.Err() == nil {
				began := time.Now()
				segs0 := s.segmentCount()
				err := capture(ctx, raw, s.append)
				if ctx.Err() != nil {
					return
				}
				s.sessionEnded(r.log, err, began, segs0)
				select {
				case <-ctx.Done():
					return
				case <-time.After(3 * time.Second):
				}
			}
		}()
	}
}

// Every DNS result is checked and the connection is pinned to the checked IP.
// No environment proxy: upstream policy must be enforced here, at the actual dial.
func guardedDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" {
		return nil, fmt.Errorf("forbidden upstream port")
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("upstream DNS failed")
	}
	for _, ip := range ips {
		if !publicIP(ip.IP) {
			return nil, fmt.Errorf("forbidden upstream address")
		}
	}
	d := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	conn, err := d.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	if err != nil {
		return nil, err
	}
	return &idleConn{Conn: conn}, nil
}

// Include non-public special-purpose ranges beyond net.IP's private predicates.
var blocked = []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16", "64:ff9b::/96", "64:ff9b:1::/48"}

func publicIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, raw := range blocked {
		_, subnet, _ := net.ParseCIDR(raw)
		if subnet.Contains(ip) {
			return false
		}
	}
	return true
}

type idleConn struct{ net.Conn }

func (c *idleConn) Read(b []byte) (int, error) {
	_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
	return c.Conn.Read(b)
}

func capture(ctx context.Context, raw string, emit func([]byte)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	tr := &http.Transport{DialContext: guardedDial, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second, MaxResponseHeaderBytes: 32 * 1024}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return captureWithClient(ctx, raw, emit, client)
}
func captureWithClient(ctx context.Context, raw string, emit func([]byte), client *http.Client) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0])) != "audio/mpeg" {
		return errBadUpstream
	}
	// Only MP3 bytes enter FFmpeg. It cannot open networks, playlists or local files.
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "pipe", "-threads", "1", "-f", "mp3", "-i", "pipe:0", "-map", "0:a:0", "-threads", "1", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1")
	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	copied := make(chan struct{})
	go func() { defer close(copied); _, _ = io.Copy(input, resp.Body); _ = input.Close() }()
	defer func() {
		cancel()
		_ = resp.Body.Close()
		_ = input.Close()
		_ = output.Close()
		_ = cmd.Wait()
		<-copied
	}()
	for {
		buf := make([]byte, SegmentBytes)
		if _, err = io.ReadFull(output, buf); err != nil {
			return err
		}
		emit(buf)
	}
}

func (s *source) segmentCount() uint64 {
	s.RLock()
	defer s.RUnlock()
	return s.manifest.Latest
}

// sessionEnded classifies why capture stopped. Error text is deliberately not
// logged: client errors embed the upstream URL, which may carry secrets.
func (s *source) sessionEnded(log *slog.Logger, err error, began time.Time, segs0 uint64) {
	reason := "error"
	switch {
	case errors.Is(err, errBadUpstream):
		reason = "rejected"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		reason = "eof"
	case errors.Is(err, os.ErrDeadlineExceeded):
		reason = "idle_timeout"
	}
	s.metrics.set("relay_upstream_up", 0, "source", s.id)
	s.metrics.add("relay_upstream_sessions_total", 1, "source", s.id, "reason", reason)
	log.Warn("upstream session ended", "source", s.id, "reason", reason, "duration", time.Since(began), "segments", s.segmentCount()-segs0)
}

func (s *source) append(pcm []byte) {
	s.Lock()
	defer s.Unlock()
	s.manifest.Latest++
	seq := s.manifest.Latest
	now := time.Now()
	if seq == 1 || s.metrics.gauge("relay_upstream_up", "source", s.id) == 0 {
		s.metrics.set("relay_upstream_session_start_timestamp_seconds", float64(now.Unix()), "source", s.id)
	}
	s.metrics.set("relay_upstream_up", 1, "source", s.id)
	s.metrics.add("relay_upstream_segments_total", 1, "source", s.id)
	s.metrics.set("relay_upstream_latest_sequence", float64(seq), "source", s.id)
	s.metrics.set("relay_upstream_last_segment_timestamp_seconds", float64(now.Unix()), "source", s.id)
	s.segments[seq] = pcm
	if seq > RetainedSegments {
		delete(s.segments, seq-RetainedSegments)
	}
	s.manifest.Oldest = 1
	if seq > RetainedSegments {
		s.manifest.Oldest = seq - RetainedSegments + 1
	}
}

func wavFile(pcm []byte) []byte {
	if pcm == nil {
		return nil
	}
	header := wavHeader()
	return append(header, pcm...)
}
func wavHeader() []byte {
	b := make([]byte, 44)
	copy(b, "RIFF")
	binary.LittleEndian.PutUint32(b[4:], SegmentBytes+36)
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:], 16)
	binary.LittleEndian.PutUint16(b[20:], 1)
	binary.LittleEndian.PutUint16(b[22:], 1)
	binary.LittleEndian.PutUint32(b[24:], 16000)
	binary.LittleEndian.PutUint32(b[28:], 32000)
	binary.LittleEndian.PutUint16(b[32:], 2)
	binary.LittleEndian.PutUint16(b[34:], 16)
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:], SegmentBytes)
	return b
}
