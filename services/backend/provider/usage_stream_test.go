package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func usageGateway(t *testing.T, rejectOption bool) (*httptest.Server, *[]bool) {
	t.Helper()
	asked := []bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		_, has := payload["stream_options"]
		asked = append(asked, has)
		if has && rejectOption {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"unknown field stream_options"}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"))
		if has {
			_, _ = w.Write([]byte("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10}}\n\n"))
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	t.Cleanup(server.Close)
	return server, &asked
}

func TestOpenAIStreamRequestsUsageFromGateways(t *testing.T) {
	server, asked := usageGateway(t, false)
	var got []Usage
	err := StreamChat(context.Background(), Endpoint{ProviderType: "openai-compatible", BaseURL: server.URL, ChatModel: "m", AllowPrivate: true, TimeoutSeconds: 5}, ChatOptions{
		Messages: []Message{{Role: "user", Content: "hi"}},
		OnUsage:  func(usage Usage) { got = append(got, usage) },
	}, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(*asked) != 1 || !(*asked)[0] {
		t.Fatalf("stream_options was not requested: %v", *asked)
	}
	if len(got) != 1 || got[0].TotalTokens != 10 || got[0].InputTokens != 7 {
		t.Fatalf("usage = %+v", got)
	}
}

func TestOpenAIStreamRetriesWithoutRejectedStreamOptions(t *testing.T) {
	server, asked := usageGateway(t, true)
	var text strings.Builder
	err := StreamChat(context.Background(), Endpoint{ProviderType: "openai-compatible", BaseURL: server.URL, ChatModel: "m", AllowPrivate: true, TimeoutSeconds: 5}, ChatOptions{
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, func(delta string) error { text.WriteString(delta); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(*asked) != 2 || !(*asked)[0] || (*asked)[1] || text.String() != "hi" {
		t.Fatalf("asked=%v text=%q", *asked, text.String())
	}
}
