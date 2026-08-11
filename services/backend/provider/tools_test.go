package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func encodeToolChunk(index int, id, name, arguments string) string {
	payload := map[string]any{
		"choices": []any{
			map[string]any{
				"delta": map[string]any{
					"tool_calls": []any{
						map[string]any{
							"index": index,
							"id":    id,
							"function": map[string]string{
								"name":      name,
								"arguments": arguments,
							},
						},
					},
				},
			},
		},
	}
	encoded, _ := json.Marshal(payload)
	return string(encoded)
}

func TestStreamChatWithToolsAggregatesOpenAIChunks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/chat/completions" {
			t.Fatalf("unexpected chat path: %s", request.URL.Path)
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprintln(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"Checking. \"}}]}")
		_, _ = fmt.Fprintln(writer, "data: "+encodeToolChunk(0, "call_1", "mcp_light_on", "{\"entity_id\":\"light.kitchen\""))
		_, _ = fmt.Fprintln(writer, "data: "+encodeToolChunk(0, "", "", "}"))
		_, _ = fmt.Fprintln(writer, "data: [DONE]")
	}))
	defer server.Close()

	var text strings.Builder
	var calls []ToolCall
	err := StreamChatWithTools(context.Background(), Endpoint{ProviderType: "openai-compatible", BaseURL: server.URL + "/v1", Capabilities: map[string]bool{"tool-calling": true}}, ToolChatOptions{
		Messages: []ToolMessage{{Role: "user", Content: "Turn on the kitchen light."}},
		Tools:    []ToolDefinition{{Name: "mcp_light_on", Parameters: []byte("{\"type\":\"object\"}")}},
	}, func(event ToolChatEvent) error {
		text.WriteString(event.Delta)
		calls = append(calls, event.ToolCalls...)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if text.String() != "Checking. " {
		t.Fatalf("unexpected streamed text: %q", text.String())
	}
	if len(calls) != 1 || calls[0].ID != "call_1" || calls[0].Name != "mcp_light_on" || calls[0].Arguments != "{\"entity_id\":\"light.kitchen\"}" {
		t.Fatalf("unexpected normalized tool calls: %+v", calls)
	}
}

func TestSynthesizeSpeechUsesConfiguredSpeechModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/audio/speech" {
			t.Fatalf("unexpected speech path: %s", request.URL.Path)
		}
		body, _ := io.ReadAll(request.Body)
		if !strings.Contains(string(body), "\"model\":\"voice-model\"") {
			t.Fatalf("speech model was not sent: %s", body)
		}
		writer.Header().Set("Content-Type", "audio/mpeg")
		_, _ = writer.Write([]byte("audio"))
	}))
	defer server.Close()

	data, contentType, err := SynthesizeSpeech(context.Background(), Endpoint{ProviderType: "openai-compatible", BaseURL: server.URL + "/v1", SpeechModel: "voice-model"}, "Hello", "alloy")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "audio" || contentType != "audio/mpeg" {
		t.Fatalf("unexpected speech response: %q %q", data, contentType)
	}
}

func TestSynthesizeSpeechRejectsUnsupportedProvider(t *testing.T) {
	if _, _, err := SynthesizeSpeech(context.Background(), Endpoint{ProviderType: "gemini"}, "Hello", "alloy"); err == nil {
		t.Fatal("expected unsupported provider error")
	}
}
