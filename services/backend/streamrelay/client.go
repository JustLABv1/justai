// Package streamrelay implements bounded audio-file polling across inspecting proxies.
package streamrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// SegmentBytes is the default five-second segment: 16 kHz mono PCM16 little endian.
const SegmentBytes = 16000 * 2 * DefaultSegmentSeconds

var sourceID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

type Manifest struct {
	Epoch  string `json:"epoch"`
	Oldest uint64 `json:"oldest"`
	Latest uint64 `json:"latest"`
	// SegmentSeconds is the audio length of each segment; absent means 5 (older relays).
	SegmentSeconds int `json:"segmentSeconds,omitempty"`
}

func (m Manifest) segmentSeconds() int {
	if m.SegmentSeconds == 0 {
		return DefaultSegmentSeconds
	}
	return m.SegmentSeconds
}

type Client struct {
	URL, token, relay string
	http              *http.Client
}

// ForSource recognizes only an operator-configured HTTPS origin and exact source path.
// Secrets never appear in source URLs, browser responses or FFmpeg arguments.
func ForSource(raw string) (*Client, error) {
	eps := endpoints()
	origins := make([]*url.URL, len(eps))
	for i, e := range eps {
		b, err := e.origin()
		if err != nil {
			return nil, err
		}
		origins[i] = b
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, nil
	}
	for i, b := range origins {
		if !strings.EqualFold(u.Host, b.Host) || u.Scheme != b.Scheme {
			continue
		}
		id := strings.TrimPrefix(u.Path, "/v1/sources/")
		if !sourceID.MatchString(id) || u.Path != "/v1/sources/"+id || u.RawPath != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
			return nil, fmt.Errorf("invalid stream relay source URL")
		}
		return newClient(eps[i], b.String()+u.Path)
	}
	return nil, nil
}

// RelaySourceID returns the source ID when raw is a source URL of a configured
// relay. It needs no token, so it can be used to recognise relay links cheaply.
func RelaySourceID(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	for _, e := range endpoints() {
		b, originErr := e.origin()
		if originErr != nil || !strings.EqualFold(u.Host, b.Host) || u.Scheme != b.Scheme {
			continue
		}
		id := strings.TrimPrefix(u.Path, "/v1/sources/")
		if sourceID.MatchString(id) && u.Path == "/v1/sources/"+id && u.RawQuery == "" && u.Fragment == "" && u.User == nil {
			return id, true
		}
	}
	return "", false
}

func newClient(e Endpoint, target string) (*Client, error) {
	token, err := e.readToken()
	if err != nil || len(strings.TrimSpace(string(token))) < 32 {
		return nil, fmt.Errorf("stream relay token file must contain at least 32 characters")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxConnsPerHost = 16
	tr.ResponseHeaderTimeout = 10 * time.Second
	return &Client{URL: target, relay: e.displayName(), token: strings.TrimSpace(string(token)), http: &http.Client{Transport: tr, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// Source is a relay source as offered to JustAI users.
type Source struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	URL    string `json:"url"`
	Relay  string `json:"relay"`
	Status string `json:"status"`
}

// SourceList is the result of listing every configured relay.
type SourceList struct {
	Enabled     bool     `json:"enabled"`
	Sources     []Source `json:"sources"`
	Unavailable []string `json:"unavailable"` // relays that could not be reached
}

// ListSources returns the sources offered by every configured relay. It fails
// only when relays are configured and none of them could be listed. Each
// source's URL is the value users enter as the livestream link.
func ListSources(ctx context.Context) (SourceList, error) {
	eps := endpoints()
	result := SourceList{Sources: []Source{}, Unavailable: []string{}}
	if len(eps) == 0 {
		return result, nil
	}
	result.Enabled = true
	var firstErr error
	for _, e := range eps {
		list, err := listEndpoint(ctx, e)
		if err != nil {
			countClient("justai_stream_relay_list_errors_total", e.displayName())
			result.Unavailable = append(result.Unavailable, e.displayName())
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		markClientSuccess(e.displayName())
		result.Sources = append(result.Sources, list...)
	}
	if len(result.Unavailable) == len(eps) {
		return SourceList{}, firstErr
	}
	return result, nil
}

func listEndpoint(ctx context.Context, e Endpoint) ([]Source, error) {
	b, err := e.origin()
	if err != nil {
		return nil, err
	}
	c, err := newClient(e, b.String()+"/v1/sources")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	body, _, err := c.get(ctx, "", 64*1024)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Sources []SourceInfo `json:"sources"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || len(payload.Sources) > 64 {
		return nil, fmt.Errorf("stream relay source list unavailable or invalid")
	}
	out := make([]Source, 0, len(payload.Sources))
	for _, s := range payload.Sources {
		if !sourceID.MatchString(s.ID) {
			continue
		}
		name := strings.TrimSpace(s.Name)
		if name == "" || len(name) > 80 {
			name = s.ID
		}
		status := s.Status
		if status != "live" && status != "idle" {
			status = "offline"
		}
		out = append(out, Source{ID: s.ID, Name: name, URL: b.String() + "/v1/sources/" + s.ID, Relay: e.displayName(), Status: status})
	}
	return out, nil
}

func (c *Client) get(ctx context.Context, path string, limit int64) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.URL+path, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("invalid relay request")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Request-ID", randomEpoch()[:16])
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("stream relay connection failed (check TLS, proxy and connectivity)")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("stream relay returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, resp.StatusCode, fmt.Errorf("invalid stream relay response")
	}
	return body, resp.StatusCode, nil
}

func (c *Client) Manifest(ctx context.Context) (Manifest, error) {
	body, _, err := c.get(ctx, "", 4096)
	var m Manifest
	if err == nil {
		err = json.Unmarshal(body, &m)
	}
	if err != nil || m.Epoch == "" || m.Latest < m.Oldest || m.SegmentSeconds < 0 || m.SegmentSeconds > 10 {
		countClient("justai_stream_relay_manifest_errors_total", c.relay)
		return m, fmt.Errorf("stream relay manifest unavailable or invalid")
	}
	markClientSuccess(c.relay)
	return m, nil
}

func (c *Client) Open(ctx context.Context) io.ReadCloser {
	ctx, cancel := context.WithCancel(ctx)
	r, w := io.Pipe()
	go func() {
		err := c.copy(ctx, w)
		if err != nil && ctx.Err() == nil {
			countClient("justai_stream_relay_reconnects_total", c.relay)
		}
		_ = w.CloseWithError(err)
		c.http.CloseIdleConnections()
	}()
	return &audioReader{PipeReader: r, cancel: cancel}
}
func (c *Client) copy(ctx context.Context, w io.Writer) error {
	var epoch string
	var next uint64
	lastAudio := time.Now()
	for {
		m, err := c.Manifest(ctx)
		if err != nil {
			return err
		}
		segBytes := 32000 * m.segmentSeconds()
		if epoch == "" {
			epoch = m.Epoch
			next = m.Latest
			if next == 0 {
				next = 1
			}
		}
		if m.Epoch != epoch || (m.Oldest > 0 && next < m.Oldest) {
			return fmt.Errorf("stream relay restarted or audio expired; reconnect required")
		}
		for next <= m.Latest {
			body, status, err := c.get(ctx, "/segments/"+strconv.FormatUint(next, 10)+"?epoch="+url.QueryEscape(epoch), int64(segBytes+44))
			if err != nil {
				countClient("justai_stream_relay_segment_errors_total", c.relay)
				return fmt.Errorf("stream relay audio unavailable (HTTP %d)", status)
			}
			if len(body) != segBytes+44 || !bytes.Equal(body[:44], wavHeader(segBytes)) {
				countClient("justai_stream_relay_segment_errors_total", c.relay)
				return fmt.Errorf("stream relay returned invalid PCM audio")
			}
			countClient("justai_stream_relay_segments_received_total", c.relay)
			markClientSuccess(c.relay)
			if _, err := w.Write(body[44:]); err != nil {
				return err
			}
			lastAudio = time.Now()
			next++
		}
		if time.Since(lastAudio) > 30*time.Second {
			return fmt.Errorf("stream relay audio timed out")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval(m.segmentSeconds())):
		}
	}
}

// pollInterval checks about four times per segment, between 250 ms and 1 s.
func pollInterval(segmentSeconds int) time.Duration {
	d := time.Duration(segmentSeconds) * time.Second / 4
	if d < 250*time.Millisecond {
		d = 250 * time.Millisecond
	}
	if d > time.Second {
		d = time.Second
	}
	return d
}

type audioReader struct {
	*io.PipeReader
	cancel context.CancelFunc
}

func (r *audioReader) Close() error { r.cancel(); return r.PipeReader.Close() }

func (c *Client) Close() { c.http.CloseIdleConnections() }
