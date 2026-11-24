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
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// RetainedSegments is the ring size at the default 5-second segment length;
// other lengths keep about 60 seconds of audio.
const RetainedSegments = 12

const (
	DefaultSegmentSeconds = 5
	DefaultIdleSeconds    = 120
)

// Sources are an operator-owned allowlist, never supplied by API clients.
type Config struct {
	Sources map[string]string `json:"sources"`
	// Names are optional display names shown in the JustAI source picker.
	Names map[string]string `json:"names,omitempty"`
	// SegmentSeconds is the audio length of one segment (1-10, default 5). Shorter
	// segments lower latency at the cost of more polling requests.
	SegmentSeconds int `json:"segmentSeconds,omitempty"`
	// OnDemand captures a source only while the backend requests it, stopping
	// after IdleSeconds (default 120) without requests.
	OnDemand    bool `json:"onDemand,omitempty"`
	IdleSeconds int  `json:"idleSeconds,omitempty"`
}

// SourceInfo is the non-secret description of a source; upstream URLs are never listed.
type SourceInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Status is "live" (audio flowing), "idle" (on-demand, not capturing) or "offline".
	Status string `json:"status,omitempty"`
}
type source struct {
	sync.RWMutex
	id       string
	metrics  *metrics
	manifest Manifest
	segments map[uint64][]byte

	retained    int
	segSeconds  int
	capturing   bool
	lastRequest time.Time
	lastSegment time.Time
	wake        chan struct{}
}
type Relay struct {
	segmentSeconds int
	segBytes       int
	retained       int
	onDemand       bool
	idle           time.Duration
	tokens         [][32]byte
	throttle       *authThrottle
	sources        map[string]*source
	names          map[string]string
	slots          chan struct{}
	inflight       atomic.Int64
	metrics        *metrics
	log            *slog.Logger
}

var errBadUpstream = errors.New("upstream must return audio/mpeg or an HLS audio playlist with HTTP 200; redirects are forbidden")

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
	segSeconds := cfg.SegmentSeconds
	if segSeconds == 0 {
		segSeconds = DefaultSegmentSeconds
	}
	if segSeconds < 1 || segSeconds > 10 {
		return nil, fmt.Errorf("segment length must be between 1 and 10 seconds")
	}
	idleSeconds := cfg.IdleSeconds
	if idleSeconds == 0 {
		idleSeconds = DefaultIdleSeconds
	}
	if idleSeconds < 10 || idleSeconds > 3600 {
		return nil, fmt.Errorf("idle timeout must be between 10 and 3600 seconds")
	}
	r := &Relay{segmentSeconds: segSeconds, segBytes: 32000 * segSeconds, retained: (60 + segSeconds - 1) / segSeconds, onDemand: cfg.OnDemand, idle: time.Duration(idleSeconds) * time.Second, tokens: hashed, throttle: newAuthThrottle(), sources: make(map[string]*source), names: map[string]string{}, slots: make(chan struct{}, 32), metrics: newMetrics(), log: slog.Default()}
	for id, raw := range cfg.Sources {
		u, err := url.Parse(raw)
		if !sourceID.MatchString(id) || err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
			return nil, fmt.Errorf("source %q requires a direct HTTPS MP3 or HLS URL on port 443 without credentials", id)
		}
		if ip := net.ParseIP(u.Hostname()); ip != nil && !publicIP(ip) {
			return nil, fmt.Errorf("source %q has a forbidden address", id)
		}
		if name := strings.TrimSpace(cfg.Names[id]); name != "" {
			if len(name) > 80 || strings.ContainsAny(name, "\r\n\x00") {
				return nil, fmt.Errorf("source %q has an invalid display name", id)
			}
			r.names[id] = name
		}
		r.sources[id] = &source{id: id, metrics: r.metrics, segments: make(map[uint64][]byte), manifest: Manifest{Epoch: randomEpoch(), SegmentSeconds: segSeconds}, retained: r.retained, segSeconds: segSeconds, wake: make(chan struct{}, 1)}
		// Export every source from the start, so idle on-demand sources are listed too.
		r.metrics.set("relay_upstream_up", 0, "source", id)
		r.sources[id].setWanted(!r.onDemand)
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
	if req.URL.Path == "/v1/sources" && req.URL.RawQuery == "" {
		w.endpoint = "list"
		list := make([]SourceInfo, 0, len(r.sources))
		for id := range r.sources {
			name := r.names[id]
			if name == "" {
				name = id
			}
			list = append(list, SourceInfo{ID: id, Name: name, Status: r.sources[id].status(r.onDemand)})
		}
		sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
		body, _ := json.Marshal(struct {
			Sources []SourceInfo `json:"sources"`
		}{list})
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = w.Write(body)
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
	s.touch()
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
		go r.runSource(ctx, r.sources[id], raw)
	}
}

func (r *Relay) runSource(ctx context.Context, s *source, raw string) {
	for ctx.Err() == nil {
		if r.onDemand {
			if !s.demanded(r.idle) {
				s.setWanted(false) // e.g. a failing capture nobody requests any more
			}
			if !s.waitDemand(ctx, r.idle) {
				return
			}
			s.setWanted(true)
		}
		capCtx, cancel := context.WithCancel(ctx)
		var idled atomic.Bool
		if r.onDemand {
			go s.watchIdle(capCtx, cancel, r.idle, &idled)
		}
		s.setCapturing(true)
		began := time.Now()
		segs0 := s.segmentCount()
		err := capture(capCtx, raw, s.append, r.segBytes)
		cancel()
		s.setCapturing(false)
		if ctx.Err() != nil {
			return
		}
		if idled.Load() {
			s.idleStopped(r.log, began, segs0)
			continue
		}
		s.sessionEnded(r.log, err, began, segs0)
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

func (s *source) touch() {
	s.Lock()
	s.lastRequest = time.Now()
	s.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *source) lastRequestAt() time.Time {
	s.RLock()
	defer s.RUnlock()
	return s.lastRequest
}

func (s *source) setCapturing(v bool) {
	s.Lock()
	s.capturing = v
	s.Unlock()
}

// setWanted exports whether the relay should be capturing this source: always
// without on-demand, otherwise while the backend requests it. Dashboards use it to
// tell an idle source from one that fails while it is needed.
func (s *source) setWanted(v bool) {
	value := 0.0
	if v {
		value = 1
	}
	s.metrics.set("relay_upstream_wanted", value, "source", s.id)
}

func (s *source) demanded(idle time.Duration) bool {
	at := s.lastRequestAt()
	return !at.IsZero() && time.Since(at) < idle
}

// waitDemand blocks until the backend has requested this source recently.
func (s *source) waitDemand(ctx context.Context, idle time.Duration) bool {
	for {
		if s.demanded(idle) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-s.wake:
		}
	}
}

func (s *source) watchIdle(ctx context.Context, cancel context.CancelFunc, idle time.Duration, idled *atomic.Bool) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if time.Since(s.lastRequestAt()) > idle {
				idled.Store(true)
				cancel()
				return
			}
		}
	}
}

// idleStopped ends an on-demand capture and starts a fresh epoch so the next
// reader never receives stale audio.
func (s *source) idleStopped(log *slog.Logger, began time.Time, segs0 uint64) {
	s.metrics.set("relay_upstream_up", 0, "source", s.id)
	s.setWanted(false)
	s.metrics.add("relay_upstream_sessions_total", 1, "source", s.id, "reason", "idle_stop")
	log.Info("on-demand capture stopped (no requests)", "source", s.id, "duration", time.Since(began), "segments", s.segmentCount()-segs0)
	s.Lock()
	s.manifest = Manifest{Epoch: randomEpoch(), SegmentSeconds: s.segSeconds}
	s.segments = make(map[uint64][]byte)
	s.lastSegment = time.Time{}
	s.Unlock()
}

func (s *source) status(onDemand bool) string {
	s.RLock()
	defer s.RUnlock()
	if !s.lastSegment.IsZero() && time.Since(s.lastSegment) < time.Duration(2*s.segSeconds+10)*time.Second {
		return "live"
	}
	if onDemand && !s.capturing {
		return "idle"
	}
	return "offline"
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

func capture(ctx context.Context, raw string, emit func([]byte), segBytes int) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	tr := &http.Transport{DialContext: guardedDial, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second, MaxResponseHeaderBytes: 32 * 1024}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return captureWithClient(ctx, raw, emit, client, segBytes)
}
func captureWithClient(ctx context.Context, raw string, emit func([]byte), client *http.Client, segBytes int) error {
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
	if resp.StatusCode != 200 {
		return errBadUpstream
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	switch {
	case contentType == "audio/mpeg":
		return decodePCM(ctx, "mp3", func(feedCtx context.Context, w io.Writer) error {
			// Unblock a pending body read as soon as decoding stops.
			stop := context.AfterFunc(feedCtx, func() { _ = resp.Body.Close() })
			defer stop()
			_, err := io.Copy(w, resp.Body)
			return err
		}, emit, segBytes)
	case isHLSContentType(contentType):
		base := resp.Request.URL
		playlist, err := readPlaylist(resp.Body)
		_ = resp.Body.Close()
		if err != nil {
			return err
		}
		return captureHLS(ctx, client, base, playlist, emit, segBytes)
	default:
		return errBadUpstream
	}
}

// decodePCM feeds audio bytes of one container format into FFmpeg via stdin.
// FFmpeg only ever reads the pipe: it cannot open networks, playlists or files.
func decodePCM(ctx context.Context, format string, feed func(context.Context, io.Writer) error, emit func([]byte), segBytes int) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "pipe", "-threads", "1", "-f", format, "-i", "pipe:0", "-map", "0:a:0", "-threads", "1", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1")
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
	feedErr := make(chan error, 1)
	go func() { feedErr <- feed(ctx, input); _ = input.Close() }()
	defer func() {
		cancel()
		_ = input.Close()
		_ = output.Close()
		_ = cmd.Wait()
		<-feedErr
	}()
	for {
		buf := make([]byte, segBytes)
		if _, err = io.ReadFull(output, buf); err != nil {
			// Prefer the feeder's reason (e.g. a stale playlist) over FFmpeg's EOF.
			select {
			case fe := <-feedErr:
				feedErr <- fe
				if fe != nil && !errors.Is(fe, io.ErrClosedPipe) {
					return fe
				}
			default:
			}
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
	case errors.Is(err, errBadUpstream), errors.Is(err, errHLSUnsupported):
		reason = "rejected"
	case errors.Is(err, errHLSStale):
		reason = "stale"
	case errors.Is(err, errHLSRestarted):
		reason = "restarted"
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
	s.lastSegment = now
	s.segments[seq] = pcm
	keep := uint64(s.retained)
	if keep == 0 {
		keep = RetainedSegments
	}
	if seq > keep {
		delete(s.segments, seq-keep)
	}
	s.manifest.Oldest = 1
	if seq > keep {
		s.manifest.Oldest = seq - keep + 1
	}
}

func wavFile(pcm []byte) []byte {
	if pcm == nil {
		return nil
	}
	header := wavHeader(len(pcm))
	return append(header, pcm...)
}
func wavHeader(dataLen int) []byte {
	b := make([]byte, 44)
	copy(b, "RIFF")
	binary.LittleEndian.PutUint32(b[4:], uint32(dataLen)+36)
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:], 16)
	binary.LittleEndian.PutUint16(b[20:], 1)
	binary.LittleEndian.PutUint16(b[22:], 1)
	binary.LittleEndian.PutUint32(b[24:], 16000)
	binary.LittleEndian.PutUint32(b[28:], 32000)
	binary.LittleEndian.PutUint16(b[32:], 2)
	binary.LittleEndian.PutUint16(b[34:], 16)
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:], uint32(dataLen))
	return b
}
