package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"justai-backend/provider"
)

func TestSummaryJSONRetriesMalformedResponses(t *testing.T) {
	for _, test := range []struct {
		name      string
		responses []string
		wantCalls int
		wantError bool
	}{
		{"valid", []string{`{"omissions":[]}`}, 1, false},
		{"fenced", []string{"```json\n{\"omissions\":[]}\n```"}, 1, false},
		{"trailing quote", []string{`{"omissions":[]} "extra"`, `{"omissions":[]}`}, 2, false},
		{"truncated", []string{`{"omissions":[`, `{"omissions":[]}`}, 2, false},
		{"exhausted", []string{`{"omissions":[]} "extra"`}, 3, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload struct {
					Messages []provider.Message `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if len(payload.Messages) != 2 || payload.Messages[1].Content != "original transcript" {
					t.Errorf("retry lost original input: %+v", payload.Messages)
				}
				if calls > 0 && !strings.Contains(payload.Messages[0].Content, "previous response was not valid JSON") {
					t.Error("retry missing JSON correction instruction")
				}
				index := min(calls, len(test.responses)-1)
				calls++
				event, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": test.responses[index]}}}})
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", event)
			}))
			defer server.Close()
			var result struct {
				Omissions *[]summaryOmissionDecision `json:"omissions"`
			}
			err := requestSummaryJSON(context.Background(), provider.Endpoint{ProviderType: "openai-compatible", BaseURL: server.URL, AllowPrivate: true, ChatModel: "test", TimeoutSeconds: 10}, summaryExclusionClassifierPrompt, "original transcript", &result)
			if (err != nil) != test.wantError || calls != test.wantCalls {
				t.Fatalf("calls=%d error=%v", calls, err)
			}
			if test.wantError {
				if result.Omissions != nil {
					t.Fatal("malformed response modified target")
				}
			} else if result.Omissions == nil || len(*result.Omissions) != 0 {
				t.Fatalf("unexpected omissions: %+v", result)
			}
		})
	}
}
