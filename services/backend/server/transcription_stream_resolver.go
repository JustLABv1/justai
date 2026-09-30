package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/html"
	"justai-backend/provider"
)

type resolvedLiveStream struct {
	URL  string `json:"-"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// Keep the original page URL at rest: media URLs may expire before capture starts.
func resolveLiveStream(ctx context.Context, raw string, allowPrivate bool) (resolvedLiveStream, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return resolveLiveStreamWithClient(ctx, strings.TrimSpace(raw), allowPrivate, provider.SafeHTTPClient(15*time.Second, allowPrivate), 0)
}

func resolveLiveStreamWithClient(ctx context.Context, raw string, allowPrivate bool, client *http.Client, depth int) (resolvedLiveStream, error) {
	if depth > 3 {
		return resolvedLiveStream{}, fmt.Errorf("the player could not be resolved to a direct stream")
	}
	if len(raw) == 0 || len(raw) > 16*1024 {
		return resolvedLiveStream{}, fmt.Errorf("enter a livestream page or direct stream link")
	}
	if err := provider.ValidateMediaSourceURL(raw, allowPrivate); err != nil {
		return resolvedLiveStream{}, err
	}
	u, _ := url.Parse(raw)
	if u.Scheme == "rtmp" || u.Scheme == "rtmps" {
		return resolvedLiveStream{URL: raw, Name: u.Hostname(), Kind: "direct"}, nil
	}
	// The official plenary player has a separately published, stable audio source.
	if depth == 0 && (strings.EqualFold(u.Hostname(), "www.bundestag.de") || strings.EqualFold(u.Hostname(), "bundestag.de")) && strings.TrimRight(u.Path, "/") == "/mediathek/live" {
		result, err := resolveLiveStreamWithClient(ctx, "https://www.bundestag.de/mediathek/276184-276184", allowPrivate, client, 1)
		if err != nil {
			return result, err
		}
		result.Name = "Bundestag · Plenary audio"
		result.Kind = "website"
		return result, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return resolvedLiveStream{}, err
	}
	req.Header.Set("User-Agent", "JustAI livestream resolver")
	resp, err := client.Do(req)
	if err != nil {
		return resolvedLiveStream{}, fmt.Errorf("livestream source could not be reached")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resolvedLiveStream{}, fmt.Errorf("livestream source returned HTTP %d", resp.StatusCode)
	}
	prefix, err := io.ReadAll(io.LimitReader(resp.Body, 512))
	if err != nil {
		return resolvedLiveStream{}, fmt.Errorf("livestream source could not be read")
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.HasPrefix(ct, "audio/") || strings.HasPrefix(ct, "video/") || strings.Contains(ct, "mpegurl") || strings.Contains(ct, "dash+xml") || strings.HasPrefix(strings.TrimSpace(string(prefix)), "#EXTM3U") {
		return resolvedLiveStream{URL: resp.Request.URL.String(), Name: u.Hostname(), Kind: "direct"}, nil
	}
	rest, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		return resolvedLiveStream{}, fmt.Errorf("livestream page could not be read")
	}
	body := append(prefix, rest...)
	if len(body) >= 2*1024*1024 {
		return resolvedLiveStream{}, fmt.Errorf("livestream page is too large to inspect")
	}
	candidates, frames := embeddedLiveMedia(string(body), resp.Request.URL)
	if len(candidates) == 1 {
		result, err := resolveLiveStreamWithClient(ctx, candidates[0], allowPrivate, client, depth+1)
		if err != nil {
			return result, err
		}
		result.Kind = "website"
		result.Name = u.Hostname()
		return result, nil
	}
	if len(candidates) > 1 {
		return resolvedLiveStream{}, fmt.Errorf("this page contains multiple streams; paste the link to the specific player or a direct stream")
	}
	if depth < 2 && len(frames) == 1 {
		return resolveLiveStreamWithClient(ctx, frames[0], allowPrivate, client, depth+1)
	}
	return resolvedLiveStream{}, fmt.Errorf("no supported public stream was found on this page; use a direct audio/HLS link or browser audio capture")
}

var embeddedMediaURL = regexp.MustCompile(`(?i)(?:https?:)?//[^\s"'<>\\]+\.(?:m3u8|mpd|mp3|aac|ogg)(?:\?[^\s"'<>\\]*)?`)

func embeddedLiveMedia(body string, base *url.URL) ([]string, []string) {
	media, frames := []string{}, []string{}
	add := func(target *[]string, raw string) {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || raw == "" {
			return
		}
		u = base.ResolveReference(u)
		u.Fragment = ""
		if u.Scheme != "https" && u.Scheme != "http" {
			return
		}
		value := u.String()
		for _, v := range *target {
			if v == value {
				return
			}
		}
		*target = append(*target, value)
	}
	z := html.NewTokenizer(strings.NewReader(body))
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		if tt != html.StartTagToken && tt != html.SelfClosingTagToken {
			continue
		}
		t := z.Token()
		attrs := map[string]string{}
		for _, a := range t.Attr {
			attrs[a.Key] = a.Val
		}
		switch t.Data {
		case "audio", "video", "source":
			add(&media, attrs["src"])
		case "iframe":
			add(&frames, attrs["src"])
		case "meta":
			if strings.HasPrefix(attrs["property"], "og:video") || strings.HasPrefix(attrs["property"], "og:audio") {
				if attrs["property"] != "og:video:type" && attrs["property"] != "og:audio:type" {
					add(&media, attrs["content"])
				}
			}
		}
	}
	for _, raw := range embeddedMediaURL.FindAllString(strings.ReplaceAll(body, `\/`, `/`), -1) {
		add(&media, html.UnescapeString(raw))
	}
	return media, frames
}

func (a *App) resolveTranscriptionStream(c *gin.Context) {
	var request struct {
		URL string `json:"url"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	result, err := resolveLiveStream(c, request.URL, a.Config.AllowPrivate)
	if err != nil {
		writeError(c, http.StatusUnprocessableEntity, err)
		return
	}
	c.JSON(http.StatusOK, result)
}
