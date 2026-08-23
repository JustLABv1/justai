package mcp

import (
	"encoding/json"
	"net"
	"testing"
)

func TestParseToolAppMetadataSupportsKnownNamespaces(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "ui", raw: `{"ui":{"resourceUri":"ui://search/result","mimeType":"text/html;profile=mcp-app"}}`, want: "ui://search/result"},
		{name: "legacy namespace", raw: `{"modelcontextprotocol/ui":{"resourceUri":"ui://legacy/widget"}}`, want: "ui://legacy/widget"},
		{name: "direct", raw: `{"resourceUri":"ui://direct/widget"}`, want: "ui://direct/widget"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			metadata := ParseToolAppMetadata(json.RawMessage(item.raw))
			if metadata.ResourceURI != item.want {
				t.Fatalf("expected %q, got %+v", item.want, metadata)
			}
		})
	}
}

func TestPrivateIPRejectsSpecialUseRanges(t *testing.T) {
	for _, raw := range []string{"100.64.0.1", "192.88.99.1", "198.18.0.1", "240.0.0.1", "224.0.0.1", "2001:db8::1", "2002::1", "3fff::1", "5f00::1", "64:ff9b::1", "64:ff9b:1::1"} {
		if !privateIP(net.ParseIP(raw)) {
			t.Errorf("expected %s to be rejected as non-public", raw)
		}
	}
	if privateIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("expected public IPv4 address to remain allowed")
	}
}

func TestParseToolAppMetadataRejectsNonWidgetURI(t *testing.T) {
	metadata := ParseToolAppMetadata(json.RawMessage(`{"ui":{"resourceUri":"https://example.test/widget"}}`))
	if metadata.ResourceURI != "" || metadata.MIMEType != "" {
		t.Fatalf("expected non-widget metadata to be ignored, got %+v", metadata)
	}
}
