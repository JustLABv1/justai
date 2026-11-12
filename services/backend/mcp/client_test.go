package mcp

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMCPProxyOnlyDNS(t *testing.T) {
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "REQUEST_METHOD"} {
		t.Setenv(key, "")
	}
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("metadata")) }))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	const endpoint = "http://mcp.proxy-only.invalid/mcp"
	client, err := SafeHTTPClient(endpoint, false)
	if err != nil {
		t.Fatalf("MCP validation required local DNS: %v", err)
	}
	defer client.CloseIdleConnections()
	resp, err := client.Get(endpoint)
	if err != nil {
		t.Fatalf("MCP request required local DNS: %v", err)
	}
	resp.Body.Close()
	if err := (Server{EndpointURL: "http://api.internal/mcp"}).ValidateURL(false); err == nil {
		t.Fatal("local MCP hostname accepted through proxy")
	}
	t.Setenv("NO_PROXY", ".proxy-only.invalid")
	if _, err := SafeHTTPClient(endpoint, false); err == nil {
		t.Fatal("MCP NO_PROXY bypass should retain DNS validation")
	}
}

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

func TestLiteLLMAuthAndRedirects(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("x-litellm-api-key") != "" || r.Header.Get("Authorization") != "" {
				t.Error("credential leaked across origins")
			}
		}))
		origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("x-litellm-api-key") != "Bearer sk-test" {
				t.Error("missing LiteLLM credential")
			}
			if r.Header.Get("Authorization") != "" {
				t.Error("unexpected Authorization")
			}
			if r.URL.Path == "/mcp" {
				http.Redirect(w, r, "/next", 307)
			} else {
				http.Redirect(w, r, foreign.URL, 307)
			}
		}))
		server := Server{EndpointURL: origin.URL + "/mcp", AuthType: "litellm", Credential: "sk-test", AllowPrivate: true}
		request, _ := http.NewRequest("GET", server.EndpointURL, nil)
		if explicit {
			server.setAuth(request)
		}
		client := server.httpClient()
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		client.CloseIdleConnections()
		origin.Close()
		foreign.Close()
	}
}

func TestServerToolAllowedHonoursDenylist(t *testing.T) {
	tools := []Tool{{Name: "search"}, {Name: "create"}, {Name: "delete"}}
	cases := []struct {
		name    string
		server  Server
		visible []string
	}{
		{"no policy", Server{}, []string{"search", "create", "delete"}},
		{"deny only", Server{Denied: map[string]bool{"delete": true}}, []string{"search", "create"}},
		{"allow only", Server{Allowed: map[string]bool{"search": true}}, []string{"search"}},
		{"deny wins over allow", Server{Allowed: map[string]bool{"search": true, "delete": true}, Denied: map[string]bool{"delete": true}}, []string{"search"}},
	}
	for _, tc := range cases {
		got := tc.server.filterTools(tools)
		if len(got) != len(tc.visible) {
			t.Fatalf("%s: got %d tools, want %d", tc.name, len(got), len(tc.visible))
		}
		for i, tool := range got {
			if tool.Name != tc.visible[i] {
				t.Fatalf("%s: got %s, want %s", tc.name, tool.Name, tc.visible[i])
			}
		}
	}
	denied := Server{Denied: map[string]bool{"delete": true}}
	if _, err := denied.CallTool(t.Context(), "delete", nil); err == nil {
		t.Fatal("expected denied tool call to be rejected")
	}
}
