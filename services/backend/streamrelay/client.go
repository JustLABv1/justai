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
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const SegmentBytes = 16000 * 2 * 5 // five seconds, mono PCM16 little endian
var sourceID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

type Manifest struct {
	Epoch  string `json:"epoch"`
	Oldest uint64 `json:"oldest"`
	Latest uint64 `json:"latest"`
}

type Client struct {
	URL, token string
	http       *http.Client
}

// ForSource recognizes only an operator-configured HTTPS origin and exact source path.
// Secrets never appear in source URLs, browser responses or FFmpeg arguments.
func ForSource(raw string) (*Client, error) {
	base := strings.TrimRight(os.Getenv("JUSTAI_STREAM_RELAY_URL"), "/")
	if base == "" {
		return nil, nil
	}
	b, err := url.Parse(base)
	if err != nil || b.Scheme != "https" || b.Host == "" || b.User != nil || b.RawQuery != "" || b.Fragment != "" || b.Path != "" {
		return nil, fmt.Errorf("invalid stream relay configuration: HTTPS origin required")
	}
	u, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(u.Host, b.Host) || u.Scheme != b.Scheme {
		return nil, nil
	}
	id := strings.TrimPrefix(u.Path, "/v1/sources/")
	if !sourceID.MatchString(id) || u.Path != "/v1/sources/"+id || u.RawPath != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return nil, fmt.Errorf("invalid stream relay source URL")
	}
	token, err := os.ReadFile(os.Getenv("JUSTAI_STREAM_RELAY_TOKEN_FILE"))
	if err != nil || len(strings.TrimSpace(string(token))) < 32 {
		return nil, fmt.Errorf("stream relay token file must contain at least 32 characters")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxConnsPerHost = 16
	tr.ResponseHeaderTimeout = 10 * time.Second
	return &Client{URL: b.String() + u.Path, token: strings.TrimSpace(string(token)), http: &http.Client{Transport: tr, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Client) get(ctx context.Context, path string, limit int64) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.URL+path, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("invalid relay request")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
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
	if err != nil || m.Epoch == "" || m.Latest < m.Oldest {
		return m, fmt.Errorf("stream relay manifest unavailable or invalid")
	}
	return m, nil
}

func (c *Client) Open(ctx context.Context) io.ReadCloser {
	ctx, cancel := context.WithCancel(ctx)
	r, w := io.Pipe()
	go func() { err := c.copy(ctx, w); _ = w.CloseWithError(err); c.http.CloseIdleConnections() }()
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
			body, status, err := c.get(ctx, "/segments/"+strconv.FormatUint(next, 10)+"?epoch="+url.QueryEscape(epoch), SegmentBytes+44)
			if err != nil {
				return fmt.Errorf("stream relay audio unavailable (HTTP %d)", status)
			}
			if len(body) != SegmentBytes+44 || !bytes.Equal(body[:44], wavHeader()) {
				return fmt.Errorf("stream relay returned invalid PCM audio")
			}
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
		case <-time.After(time.Second):
		}
	}
}

type audioReader struct {
	*io.PipeReader
	cancel context.CancelFunc
}

func (r *audioReader) Close() error { r.cancel(); return r.PipeReader.Close() }

func (c *Client) Close() { c.http.CloseIdleConnections() }
