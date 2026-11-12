package provider

import (
	"errors"
	"testing"
)

func TestFlattenToolHistoryRemovesToolRolesAndEmptyMessages(t *testing.T) {
	out := flattenToolHistory([]ToolMessage{
		{Role: "user", Content: "hi"},
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "1", Name: "grafana"}}},
		{Role: "tool", ToolCallID: "1", Content: "result"},
		{Role: "assistant", Content: "done", ToolCalls: []ToolCall{{ID: "2", Name: "x"}}},
	})
	if len(out) != 3 || out[1].Role != "assistant" || out[1].Content != "Result of grafana:\nresult" || out[2].ToolCalls != nil {
		t.Fatalf("unexpected history: %+v", out)
	}
	for _, message := range out {
		if message.Role == "tool" || (message.Content == "" && len(message.ContentParts) == 0) {
			t.Fatalf("invalid message left: %+v", message)
		}
	}
}

func TestRejectsToolHistory(t *testing.T) {
	if !rejectsToolHistory(errors.New("provider request failed (400): history accepts non-empty user and assistant messages only")) {
		t.Fatal("expected rejection to be detected")
	}
	if rejectsToolHistory(errors.New("provider request failed (500): boom")) {
		t.Fatal("unexpected match")
	}
}

func TestTrimToolHistoryKeepsSystemAndStartsAtUser(t *testing.T) {
	out := trimToolHistory([]ToolMessage{
		{Role: "system", Content: "s"},
		{Role: "user", Content: "1"}, {Role: "assistant", Content: "2"},
		{Role: "user", Content: "3"}, {Role: "assistant", Content: "4"},
	}, 3)
	if len(out) != 3 || out[0].Role != "system" || out[1].Content != "3" {
		t.Fatalf("unexpected trim: %+v", out)
	}
	if !rejectsHistoryLimit(errors.New("provider request failed (400): history exceeds configured message limit")) {
		t.Fatal("limit error not detected")
	}
}
