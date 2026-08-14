package mcp

import (
	"encoding/json"
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

func TestParseToolAppMetadataRejectsNonWidgetURI(t *testing.T) {
	metadata := ParseToolAppMetadata(json.RawMessage(`{"ui":{"resourceUri":"https://example.test/widget"}}`))
	if metadata.ResourceURI != "" || metadata.MIMEType != "" {
		t.Fatalf("expected non-widget metadata to be ignored, got %+v", metadata)
	}
}
