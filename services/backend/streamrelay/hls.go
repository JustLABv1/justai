package streamrelay

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// HLS support: the relay itself fetches playlists and segments with the same
// guarded client as MP3 sources and pipes only segment bytes into FFmpeg, so
// FFmpeg never opens network URLs or playlists on its own.

const (
	maxPlaylistBytes = 2 << 20
	maxSegmentBytes  = 16 << 20
	// hlsLiveEdgeSegments is how far behind the live edge capture starts.
	hlsLiveEdgeSegments = 3
)

var (
	errHLSUnsupported = errors.New("HLS source uses an unsupported feature (encryption, fMP4, byte ranges or non-audio segments)")
	errHLSStale       = errors.New("HLS playlist stopped advancing")
	errHLSRestarted   = errors.New("HLS playlist restarted")
)

func isHLSContentType(contentType string) bool {
	switch contentType {
	case "application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl":
		return true
	}
	return false
}

type hlsSegment struct {
	sequence uint64
	uri      string
}

type hlsPlaylist struct {
	master         bool
	variants       []hlsVariant
	audioURI       string
	targetDuration time.Duration
	segments       []hlsSegment
	ended          bool
}

type hlsVariant struct {
	uri       string
	bandwidth int64
}

func readPlaylist(body io.Reader) (hlsPlaylist, error) {
	data, err := io.ReadAll(io.LimitReader(body, maxPlaylistBytes+1))
	if err != nil {
		return hlsPlaylist{}, err
	}
	if len(data) > maxPlaylistBytes {
		return hlsPlaylist{}, fmt.Errorf("HLS playlist is too large")
	}
	return parsePlaylist(data)
}

func parsePlaylist(data []byte) (hlsPlaylist, error) {
	var p hlsPlaylist
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 64*1024), 64*1024)
	first := true
	var sequence uint64
	pendingVariant := false
	var variantBandwidth int64
	defaultAudio := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if first {
			if !strings.HasPrefix(line, "#EXTM3U") {
				return p, fmt.Errorf("upstream did not return an HLS playlist")
			}
			first = false
			continue
		}
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "#") {
			if pendingVariant {
				p.variants = append(p.variants, hlsVariant{uri: line, bandwidth: variantBandwidth})
				pendingVariant = false
				continue
			}
			p.segments = append(p.segments, hlsSegment{sequence: sequence, uri: line})
			sequence++
			continue
		}
		tag, value, _ := strings.Cut(line, ":")
		switch tag {
		case "#EXT-X-STREAM-INF":
			p.master = true
			pendingVariant = true
			variantBandwidth, _ = strconv.ParseInt(playlistAttr(value, "BANDWIDTH"), 10, 64)
		case "#EXT-X-MEDIA":
			if playlistAttr(value, "TYPE") == "AUDIO" {
				if uri := playlistAttr(value, "URI"); uri != "" && (p.audioURI == "" || (!defaultAudio && playlistAttr(value, "DEFAULT") == "YES")) {
					p.audioURI = uri
					defaultAudio = playlistAttr(value, "DEFAULT") == "YES"
				}
			}
		case "#EXT-X-TARGETDURATION":
			if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds > 0 && seconds <= 60 {
				p.targetDuration = time.Duration(seconds * float64(time.Second))
			}
		case "#EXT-X-MEDIA-SEQUENCE":
			n, err := strconv.ParseUint(value, 10, 64)
			if err != nil {
				return p, fmt.Errorf("HLS playlist has an invalid media sequence")
			}
			sequence = n
		case "#EXT-X-ENDLIST":
			p.ended = true
		case "#EXT-X-KEY":
			if method := playlistAttr(value, "METHOD"); method != "" && method != "NONE" {
				return p, errHLSUnsupported
			}
		case "#EXT-X-MAP", "#EXT-X-BYTERANGE":
			return p, errHLSUnsupported
		}
	}
	if err := scanner.Err(); err != nil {
		return p, fmt.Errorf("HLS playlist could not be read")
	}
	if first {
		return p, fmt.Errorf("upstream did not return an HLS playlist")
	}
	if p.targetDuration == 0 {
		p.targetDuration = 6 * time.Second
	}
	return p, nil
}

// playlistAttr reads one attribute from an HLS attribute list (KEY=value,KEY="quoted").
func playlistAttr(list, key string) string {
	for len(list) > 0 {
		name, rest, ok := strings.Cut(list, "=")
		if !ok {
			return ""
		}
		var value string
		if strings.HasPrefix(rest, `"`) {
			end := strings.Index(rest[1:], `"`)
			if end < 0 {
				return ""
			}
			value, rest = rest[1:end+1], rest[end+2:]
		} else {
			value, rest, _ = strings.Cut(rest, ",")
			rest = "," + rest
		}
		if strings.TrimSpace(name) == key {
			return value
		}
		rest = strings.TrimPrefix(rest, ",")
		list = rest
	}
	return ""
}

// resolveHLSRef applies the same rules as configured sources to every URL a
// playlist points at: HTTPS on port 443, no credentials, no literal private IPs.
func resolveHLSRef(base *url.URL, ref string) (*url.URL, error) {
	parsed, err := url.Parse(ref)
	if err != nil {
		return nil, errBadUpstream
	}
	u := base.ResolveReference(parsed)
	u.Fragment = ""
	if err := hlsRefPolicy(u); err != nil {
		return nil, err
	}
	return u, nil
}

// hlsRefPolicy is a variable only so tests can reach loopback TLS servers.
var hlsRefPolicy = func(u *url.URL) error {
	if u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return errBadUpstream
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !publicIP(ip) {
		return errBadUpstream
	}
	return nil
}

func fetchLimited(ctx context.Context, client *http.Client, u *url.URL, limit int64) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("HLS request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("HLS upstream returned HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, "", fmt.Errorf("HLS response could not be read")
	}
	if int64(len(data)) > limit {
		return nil, "", fmt.Errorf("HLS response is too large")
	}
	return data, strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0])), nil
}

func fetchPlaylist(ctx context.Context, client *http.Client, u *url.URL) (hlsPlaylist, error) {
	data, contentType, err := fetchLimited(ctx, client, u, maxPlaylistBytes)
	if err != nil {
		return hlsPlaylist{}, err
	}
	if contentType != "" && !isHLSContentType(contentType) && contentType != "application/octet-stream" && contentType != "text/plain" {
		return hlsPlaylist{}, errBadUpstream
	}
	return parsePlaylist(data)
}

// selectMediaPlaylist picks an audio rendition when the master offers one,
// otherwise the lowest-bandwidth variant (audio is muxed into every variant).
func selectMediaPlaylist(p hlsPlaylist) (string, error) {
	if p.audioURI != "" {
		return p.audioURI, nil
	}
	if len(p.variants) == 0 {
		return "", fmt.Errorf("HLS master playlist has no variants")
	}
	best := p.variants[0]
	for _, v := range p.variants[1:] {
		if v.bandwidth > 0 && (best.bandwidth == 0 || v.bandwidth < best.bandwidth) {
			best = v
		}
	}
	return best.uri, nil
}

// stripID3 removes leading ID3v2 tags, which packed-audio HLS puts in front of
// each segment for timestamps. Concatenated mid-stream they would corrupt ADTS.
func stripID3(data []byte) []byte {
	for len(data) >= 10 && string(data[:3]) == "ID3" {
		size := int(data[6]&0x7f)<<21 | int(data[7]&0x7f)<<14 | int(data[8]&0x7f)<<7 | int(data[9]&0x7f)
		total := 10 + size
		if data[5]&0x10 != 0 {
			total += 10 // footer
		}
		if total > len(data) {
			return nil
		}
		data = data[total:]
	}
	return data
}

// segmentFormat names the FFmpeg demuxer for a segment's payload.
func segmentFormat(data []byte) (string, error) {
	if len(data) >= 189 && data[0] == 0x47 && data[188] == 0x47 {
		return "mpegts", nil
	}
	if len(data) >= 2 && data[0] == 0xff && data[1]&0xf0 == 0xf0 {
		if data[1]&0x06 == 0 {
			return "aac", nil // ADTS: layer bits are 00
		}
		return "mp3", nil
	}
	if len(data) >= 2 && data[0] == 0xff && data[1]&0xe0 == 0xe0 {
		return "mp3", nil
	}
	return "", errHLSUnsupported
}

func captureHLS(ctx context.Context, client *http.Client, base *url.URL, playlist hlsPlaylist, emit func([]byte), segBytes int) error {
	mediaURL := base
	if playlist.master {
		ref, err := selectMediaPlaylist(playlist)
		if err != nil {
			return err
		}
		if mediaURL, err = resolveHLSRef(base, ref); err != nil {
			return err
		}
		if playlist, err = fetchPlaylist(ctx, client, mediaURL); err != nil {
			return err
		}
		if playlist.master {
			return fmt.Errorf("HLS master playlists may not be nested")
		}
	}
	segments := playlist.segments
	if !playlist.ended && len(segments) > hlsLiveEdgeSegments {
		segments = segments[len(segments)-hlsLiveEdgeSegments:]
	}
	if len(segments) == 0 {
		return errHLSStale
	}
	fetchSegment := func(seg hlsSegment) ([]byte, error) {
		u, err := resolveHLSRef(mediaURL, seg.uri)
		if err != nil {
			return nil, err
		}
		data, _, err := fetchLimited(ctx, client, u, maxSegmentBytes)
		if err != nil {
			return nil, err
		}
		return stripID3(data), nil
	}
	first, err := fetchSegment(segments[0])
	if err != nil {
		return err
	}
	format, err := segmentFormat(first)
	if err != nil {
		return err
	}
	return decodePCM(ctx, format, func(feedCtx context.Context, w io.Writer) error {
		write := func(data []byte) error {
			if f, err := segmentFormat(data); err != nil || f != format {
				return errHLSUnsupported
			}
			_, err := w.Write(data)
			return err
		}
		if err := write(first); err != nil {
			return err
		}
		last := segments[0].sequence
		for _, seg := range segments[1:] {
			data, err := fetchSegment(seg)
			if err != nil {
				return err
			}
			if err := write(data); err != nil {
				return err
			}
			last = seg.sequence
		}
		ended := playlist.ended
		target := playlist.targetDuration
		lastProgress := time.Now()
		for !ended {
			interval := target / 2
			interval = max(interval, time.Second)
			interval = min(interval, 5*time.Second)
			select {
			case <-feedCtx.Done():
				return feedCtx.Err()
			case <-time.After(interval):
			}
			current, err := fetchPlaylist(feedCtx, client, mediaURL)
			if err != nil {
				return err
			}
			if current.master {
				return errBadUpstream
			}
			ended, target = current.ended, current.targetDuration
			if n := len(current.segments); n > 0 && current.segments[n-1].sequence < last {
				return errHLSRestarted
			}
			for _, seg := range current.segments {
				if seg.sequence <= last {
					continue
				}
				data, err := fetchSegment(seg)
				if err != nil {
					return err
				}
				if err := write(data); err != nil {
					return err
				}
				last = seg.sequence
				lastProgress = time.Now()
			}
			if time.Since(lastProgress) > max(30*time.Second, 3*target) {
				return errHLSStale
			}
		}
		return nil
	}, emit, segBytes)
}
