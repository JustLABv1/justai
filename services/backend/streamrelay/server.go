package streamrelay

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const RetainedSegments = 12

// Sources are an operator-owned allowlist, never supplied by API clients.
type Config struct {
	Sources map[string]string `json:"sources"`
}
type source struct {
	sync.RWMutex
	manifest Manifest
	segments map[uint64][]byte
}
type Relay struct {
	token   [32]byte
	sources map[string]*source
	slots   chan struct{}
}

func New(cfg Config, token string) (*Relay, error) {
	if len(token) < 32 || strings.ContainsAny(token, "\r\n") {
		return nil, fmt.Errorf("relay token must contain at least 32 characters without newlines")
	}
	if len(cfg.Sources) == 0 || len(cfg.Sources) > 8 {
		return nil, fmt.Errorf("configure between one and eight sources")
	}
	r := &Relay{token: sha256.Sum256([]byte(token)), sources: make(map[string]*source), slots: make(chan struct{}, 32)}
	for id, raw := range cfg.Sources {
		u, err := url.Parse(raw)
		if !sourceID.MatchString(id) || err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
			return nil, fmt.Errorf("source %q requires a direct HTTPS MP3 URL on port 443 without credentials", id)
		}
		if ip := net.ParseIP(u.Hostname()); ip != nil && !publicIP(ip) {
			return nil, fmt.Errorf("source %q has a forbidden address", id)
		}
		r.sources[id] = &source{segments: make(map[uint64][]byte), manifest: Manifest{Epoch: randomEpoch()}}
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

func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	supplied := sha256.Sum256([]byte(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")))
	if !strings.HasPrefix(req.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare(supplied[:], r.token[:]) != 1 {
		http.Error(w, "unauthorized", 401)
		return
	}
	if req.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", 405)
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
				_ = capture(ctx, raw, s.append)
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
		return fmt.Errorf("upstream must return audio/mpeg with HTTP 200; redirects are forbidden")
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

func (s *source) append(pcm []byte) {
	s.Lock()
	defer s.Unlock()
	s.manifest.Latest++
	seq := s.manifest.Latest
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
