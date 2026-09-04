package provider

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestMockChatStreams(t *testing.T) {
	var response strings.Builder
	err := StreamChat(context.Background(), Endpoint{ProviderType: "mock"}, ChatOptions{}, func(delta string) error {
		response.WriteString(delta)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(response.String(), "JustAI is ready") {
		t.Fatalf("unexpected mock response: %q", response.String())
	}
}

func TestIsPublicIPRejectsSpecialUseRanges(t *testing.T) {
	for _, raw := range []string{"100.64.0.1", "192.88.99.1", "198.18.0.1", "240.0.0.1", "224.0.0.1", "2001:db8::1", "2002::1", "3fff::1", "5f00::1", "64:ff9b::1", "64:ff9b:1::1"} {
		if isPublicIP(net.ParseIP(raw)) {
			t.Errorf("expected %s to be rejected as non-public", raw)
		}
	}
	if !isPublicIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("expected public IPv4 address to remain allowed")
	}
}

func TestValidateEndpointURLBlocksPrivateAndCredentialURLs(t *testing.T) {
	for _, raw := range []string{"http://127.0.0.1:8080", "http://100.64.0.1", "http://user:secret@example.com", "http://example.com?credential=secret"} {
		if err := ValidateEndpointURL(raw, false); err == nil {
			t.Errorf("expected endpoint URL %q to be rejected", raw)
		}
	}
	if err := ValidateEndpointURL("http://127.0.0.1:8080", true); err != nil {
		t.Fatalf("operator private-target gate should allow explicit local endpoint: %v", err)
	}
}

func TestValidateMediaSourceURLSupportsNetworkMediaAndBlocksUnsafeInputs(t *testing.T) {
	for _, raw := range []string{
		"file:///tmp/audio.wav",
		"ftp://example.com/live",
		"https://user:secret@example.com/live.m3u8",
		"https://8.8.8.8/live.m3u8#fragment",
		"https://www.youtube.com/watch?v=live-video",
	} {
		if err := ValidateMediaSourceURL(raw, false); err == nil {
			t.Errorf("expected media source URL %q to be rejected", raw)
		}
	}
	for _, raw := range []string{
		"https://8.8.8.8/live.m3u8?token=secret",
		"rtmps://8.8.8.8/live/channel",
	} {
		if err := ValidateMediaSourceURL(raw, false); err != nil {
			t.Errorf("expected media source URL %q to be accepted: %v", raw, err)
		}
	}
	if err := ValidateMediaSourceURL("http://127.0.0.1:8080/live.m3u8", true); err != nil {
		t.Fatalf("operator private-target gate should allow local media source: %v", err)
	}
}

func TestSafeHTTPClientStripsSecretsAndRefererAcrossOrigins(t *testing.T) {
	client := SafeHTTPClientForOrigin(time.Second, true, "https://1.1.1.1")
	previous := &http.Request{URL: &url.URL{Scheme: "https", Host: "1.1.1.1", RawQuery: "key=secret"}}
	next := &http.Request{
		URL: &url.URL{Scheme: "https", Host: "8.8.8.8", Path: "/redirected"},
		Header: http.Header{
			"Authorization": []string{"Bearer secret"},
			"Referer":       []string{"https://1.1.1.1?key=secret"},
			"X-Api-Key":     []string{"secret"},
		},
	}
	if err := client.CheckRedirect(next, []*http.Request{previous}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Authorization", "Referer", "X-Api-Key"} {
		if value := next.Header.Get(name); value != "" {
			t.Fatalf("cross-origin redirect retained %s: %q", name, value)
		}
	}
}

func TestOpenAIMessageContentIncludesImageParts(t *testing.T) {
	content := openAIMessageContent(Message{
		Content: "What is this?",
		ContentParts: []MessageContentPart{{
			Type:     "image_url",
			ImageURL: &MessageImageURL{URL: "data:image/png;base64,aGVsbG8=", Detail: "auto"},
		}},
	})
	encoded, err := json.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	var parts []map[string]any
	if err := json.Unmarshal(encoded, &parts); err != nil {
		t.Fatal(err)
	}
	if len(parts) != 2 || parts[0]["type"] != "text" || parts[0]["text"] != "What is this?" || parts[1]["type"] != "image_url" {
		t.Fatalf("unexpected OpenAI content: %s", encoded)
	}
	image, ok := parts[1]["image_url"].(map[string]any)
	if !ok || image["url"] != "data:image/png;base64,aGVsbG8=" {
		t.Fatalf("unexpected image part: %+v", parts[1])
	}
}
