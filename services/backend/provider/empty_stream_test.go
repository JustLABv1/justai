package provider

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpenAIStreamExplainsEmptyAnswer(t *testing.T) {
	for name, tc := range map[string]struct {
		stream string
		want   string
	}{
		"reasoning used the budget": {"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hmm\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n", "reasoning"},
		"in-stream error":           {"data: {\"error\":{\"message\":\"context too long\"}}\n\n", "context too long"},
		"content filter":            {"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\n", "content filter"},
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte(tc.stream + "data: [DONE]\n\n"))
			}))
			defer server.Close()
			err := StreamChat(context.Background(), Endpoint{ProviderType: "openai-compatible", BaseURL: server.URL, ChatModel: "m", AllowPrivate: true, TimeoutSeconds: 5}, ChatOptions{
				Messages: []Message{{Role: "user", Content: "hi"}},
			}, func(string) error { return nil })
			if !errors.Is(err, ErrNoChatContent) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want ErrNoChatContent mentioning %q", err, tc.want)
			}
		})
	}
}
