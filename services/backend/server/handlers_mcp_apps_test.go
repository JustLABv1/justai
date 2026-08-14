package server

import (
	"encoding/json"
	"testing"
)

func TestMCPAppResourceNormalizesTextResource(t *testing.T) {
	resource, err := mcpAppResource(json.RawMessage(`{
		"contents": [{
			"uri": "ui://weather/widget",
			"mimeType": "text/html;profile=mcp-app",
			"text": "<main>Sunny</main>",
			"_meta": {"prefersBorder": true}
		}]
	}`), "ui://weather/widget")
	if err != nil {
		t.Fatal(err)
	}
	if resource["uri"] != "ui://weather/widget" || resource["mimeType"] != mcpAppHTMLMIMEType || resource["html"] != "<main>Sunny</main>" {
		t.Fatalf("unexpected normalized resource: %+v", resource)
	}
	metadata, ok := resource["meta"].(map[string]any)
	if !ok || metadata["prefersBorder"] != true {
		t.Fatalf("expected resource metadata, got %+v", resource["meta"])
	}
}

func TestMCPAppResourceDecodesBlobAndRejectsNonWidgetContent(t *testing.T) {
	resource, err := mcpAppResource(json.RawMessage(`{"contents":[{"uri":"ui://blob/widget","mimeType":"text/html;profile=mcp-app","blob":"PG1haW4+T0s8L21haW4+"}]}`), "ui://blob/widget")
	if err != nil {
		t.Fatal(err)
	}
	if resource["html"] != "<main>OK</main>" {
		t.Fatalf("expected decoded HTML, got %+v", resource["html"])
	}
	if _, err := mcpAppResource(json.RawMessage(`{"contents":[{"uri":"https://example.test/widget","mimeType":"text/html","text":"<main>no</main>"}]}`), "ui://widget"); err == nil {
		t.Fatal("expected a non-ui resource to be rejected")
	}
	if _, err := mcpAppResource(json.RawMessage(`{"contents":[{"uri":"ui://other/widget","mimeType":"text/html;profile=mcp-app","text":"<main>wrong widget</main>"}]}`), "ui://requested/widget"); err == nil {
		t.Fatal("expected a resource for another URI to be rejected")
	}
}

func TestMCPAppServerIDRequiresUUID(t *testing.T) {
	if _, err := mcpAppServerID(map[string]any{}); err == nil {
		t.Fatal("expected missing server id to fail")
	}
	if _, err := mcpAppServerID(map[string]any{"serverId": "not-a-uuid"}); err == nil {
		t.Fatal("expected invalid server id to fail")
	}
}
