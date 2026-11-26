package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"justai-backend/models"
	"justai-backend/provider"
)

func TestAskTopicBoundaryReadsTheModelAnswer(t *testing.T) {
	var prompt string
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []struct{ Content string } `json:"messages"`
		}
		_ = json.Unmarshal(body, &payload)
		prompt = payload.Messages[1].Content
		w.Header().Set("Content-Type", "text/event-stream")
		if calls == 1 { // the first answer is empty and must be retried
			_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
			return
		}
		answer, _ := json.Marshal(`Sure: {"found": true, "item": 1, "line": 2, "quote": "Wir kommen jetzt zum Einzelplan 17.", "reason": "Die Präsidentin ruft EPL 17 auf."}`)
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":" + string(answer) + "}}]}\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()
	endpoint := provider.Endpoint{ProviderType: "openai-compatible", BaseURL: server.URL, ChatModel: "m", AllowPrivate: true, TimeoutSeconds: 5}
	topic := models.TranscriptionTopic{Label: "EPL 10", Title: "Landwirtschaft"}
	following := []topicAIItem{{Label: "EPL 17", Title: "Bildung, Familie, Senioren, Frauen und Jugend"}}
	lines := []topicAILine{{StartMs: 7357760, Text: "zur Abstimmung über den Einzelplan."}, {StartMs: 7375760, Text: "ist damit angenommen. Wir kommen"}, {StartMs: 7377760, Text: "jetzt zum Einzelplan 17."}}
	answer, err := askTopicBoundary(context.Background(), endpoint, topic, following, lines)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || !answer.Found || answer.Item != 1 || answer.Line != 2 {
		t.Fatalf("calls=%d answer=%+v", calls, answer)
	}
	if !strings.Contains(prompt, "1. EPL 17 – Bildung") || !strings.Contains(prompt, "2 | 2:02:55 | ist damit angenommen. Wir kommen") {
		t.Fatalf("prompt:\n%s", prompt)
	}
}
