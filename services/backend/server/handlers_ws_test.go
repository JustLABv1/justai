package server

import (
	"encoding/json"
	"testing"
)

func TestBuildConversationToolHistoryReconstructsProviderToolSequence(t *testing.T) {
	encode := func(event chatToolEvent) string {
		content, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		return string(content)
	}

	history := buildConversationToolHistory([]storedChatMessage{
		{Role: "user", Content: "Find the setup instructions."},
		{Role: "tool", Content: encode(chatToolEvent{
			Kind:       "mcp_tool",
			Status:     "completed",
			Round:      1,
			ServerName: "Knowledge",
			ToolName:   "search_plain_docs",
			CallID:     "call_1",
			Arguments:  map[string]any{"query": "setup"},
			Result:     `{"content":[{"text":"Use uv sync."}]}`,
		})},
		{Role: "assistant", Content: "Use uv sync."},
		{Role: "user", Content: "What about CI?"},
	})

	if len(history) != 5 {
		t.Fatalf("expected five provider messages, got %d: %+v", len(history), history)
	}
	if history[1].Role != "assistant" || len(history[1].ToolCalls) != 1 {
		t.Fatalf("expected a provider assistant tool call message, got %+v", history[1])
	}
	if history[1].ToolCalls[0].ID != "call_1" || history[1].ToolCalls[0].Name != "search_plain_docs" {
		t.Fatalf("unexpected reconstructed tool call: %+v", history[1].ToolCalls[0])
	}
	if history[2].Role != "tool" || history[2].ToolCallID != "call_1" {
		t.Fatalf("expected the matching provider tool result, got %+v", history[2])
	}
	if history[3].Content != "Use uv sync." || history[4].Content != "What about CI?" {
		t.Fatalf("conversation order was not preserved: %+v", history)
	}
}
