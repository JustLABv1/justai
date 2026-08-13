package server

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestFindAssistantUIApprovalReadsV7ResponsePart(t *testing.T) {
	approved := true
	rawPart, err := json.Marshal(map[string]any{
		"type":       "tool-approval-response",
		"approvalId": "approval-1",
		"toolCallId": "call-1",
		"toolName":   "mcp_search",
		"input":      map[string]any{"query": "assistant-ui"},
		"approved":   approved,
		"reason":     "trusted source",
	})
	if err != nil {
		t.Fatal(err)
	}
	approval := findAssistantUIApproval([]assistantUIMessage{{
		ID:    "assistant-1",
		Role:  "assistant",
		Parts: []json.RawMessage{rawPart},
	}})
	if approval == nil {
		t.Fatal("expected an approval response")
	}
	if approval.ApprovalID != "approval-1" || approval.CallID != "call-1" || !approval.Approved {
		t.Fatalf("unexpected approval: %+v", approval)
	}
	if approval.Arguments["query"] != "assistant-ui" {
		t.Fatalf("unexpected arguments: %+v", approval.Arguments)
	}
}

func TestFindAssistantUIApprovalDoesNotReplayHistory(t *testing.T) {
	rawPart, err := json.Marshal(map[string]any{
		"type":       "tool-approval-response",
		"approvalId": "old-approval",
		"approved":   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	approval := findAssistantUIApproval([]assistantUIMessage{
		{Role: "assistant", Parts: []json.RawMessage{rawPart}},
		{Role: "user", Parts: []json.RawMessage{json.RawMessage(`{"type":"text","text":"next turn"}`)}},
	})
	if approval != nil {
		t.Fatalf("did not expect a historical approval to resume: %+v", approval)
	}
}

func TestAssistantUIRunStatusForTool(t *testing.T) {
	cases := []struct {
		status string
		want   string
	}{
		{status: "running", want: "running"},
		{status: "awaiting_approval", want: "requires-action"},
		{status: "completed", want: "complete"},
		{status: "failed", want: "complete"},
	}
	for _, item := range cases {
		if got := assistantUIRunStatusForTool(chatToolEvent{Status: item.status}); got != item.want {
			t.Fatalf("status %q: expected %q, got %q", item.status, item.want, got)
		}
	}
}

func TestAssistantUIToolMessagePreservesApprovalAndResult(t *testing.T) {
	messageID := uuid.New()
	pending := assistantUIToolMessage(messageID, chatToolEvent{
		Kind:       "mcp_tool",
		Status:     "awaiting_approval",
		ToolName:   "mcp_lookup",
		CallID:     "call-2",
		ApprovalID: "approval-2",
		Arguments:  map[string]any{"id": "42"},
	})
	pendingParts := pending["parts"].([]any)
	pendingPart := pendingParts[0].(map[string]any)
	if pendingPart["state"] != "approval-requested" {
		t.Fatalf("expected approval state, got %+v", pendingPart)
	}

	completed := assistantUIToolMessage(messageID, chatToolEvent{
		Kind:     "mcp_tool",
		Status:   "completed",
		ToolName: "mcp_lookup",
		CallID:   "call-2",
		Result:   `{"value":"ok"}`,
	})
	completedParts := completed["parts"].([]any)
	completedPart := completedParts[0].(map[string]any)
	output, ok := completedPart["output"].(json.RawMessage)
	if completedPart["state"] != "output-available" || !ok || string(output) != `{"value":"ok"}` {
		t.Fatalf("expected completed output, got %+v", completedPart)
	}
	declined := assistantUIToolMessage(messageID, chatToolEvent{
		Kind:       "mcp_tool",
		Status:     "declined",
		ToolName:   "mcp_lookup",
		CallID:     "call-2",
		ApprovalID: "approval-2",
		Error:      "declined by user",
	})
	declinedPart := declined["parts"].([]any)[0].(map[string]any)
	approval := declinedPart["approval"].(map[string]any)
	if declinedPart["state"] != "output-denied" || approval["approved"] != false {
		t.Fatalf("expected a durable denied approval, got %+v", declinedPart)
	}
}

func TestMergeAssistantUIToolMessagePreservesPartsAndPendingStatus(t *testing.T) {
	target := map[string]any{
		"id": "call-1",
		"parts": []any{map[string]any{
			"type":  "dynamic-tool",
			"state": "output-available",
		}},
		"metadata": map[string]any{"runStatus": "complete"},
	}
	source := map[string]any{
		"id": "call-2",
		"parts": []any{map[string]any{
			"type":  "dynamic-tool",
			"state": "approval-requested",
		}},
		"metadata": map[string]any{"runStatus": "requires-action"},
	}
	mergeAssistantUIToolMessage(target, source)
	if target["id"] != "call-2" {
		t.Fatalf("expected the merged message to retain the latest branch id, got %+v", target["id"])
	}
	if parts := target["parts"].([]any); len(parts) != 2 {
		t.Fatalf("expected two coalesced tool parts, got %+v", parts)
	}
	metadata := target["metadata"].(map[string]any)
	if metadata["runStatus"] != "requires-action" {
		t.Fatalf("expected the pending status to win, got %+v", metadata)
	}
}

func TestFilterAssistantUIRepositoryToolsHidesCanonicalDuplicates(t *testing.T) {
	repository := assistantUIRepository{
		HeadID: "assistant-1",
		Messages: []assistantUIRepositoryItem{
			{
				ParentID: "",
				Message:  map[string]any{"id": "user-1", "role": "user", "parts": []any{map[string]any{"type": "text", "text": "look up"}}},
			},
			{
				ParentID:   "user-1",
				LegacyTool: true,
				Message: map[string]any{
					"id":    "tool-row-1",
					"role":  "assistant",
					"parts": []any{map[string]any{"type": "dynamic-tool", "toolCallId": "call-1", "state": "output-available"}},
				},
			},
			{
				ParentID: "tool-row-1",
				Message: map[string]any{
					"id":   "assistant-1",
					"role": "assistant",
					"parts": []any{
						map[string]any{"type": "dynamic-tool", "toolCallId": "call-1", "state": "output-available"},
						map[string]any{"type": "text", "text": "done"},
					},
				},
			},
		},
	}
	filterAssistantUIRepositoryTools(&repository)
	if len(repository.Messages) != 2 {
		t.Fatalf("expected canonical user and assistant messages, got %+v", repository.Messages)
	}
	if got := repository.Messages[1].ParentID; got != "user-1" {
		t.Fatalf("expected hidden tool parent to be rewired to user, got %q", got)
	}
	if got := repository.HeadID; got != "assistant-1" {
		t.Fatalf("expected canonical assistant head, got %q", got)
	}
}

func TestReplaceAssistantUIToolPartReturnsUpdatedSlice(t *testing.T) {
	parts := []map[string]any{{"type": "dynamic-tool", "toolCallId": "call-1", "state": "approval-requested"}}
	parts = replaceAssistantUIToolPart(parts, chatToolEvent{CallID: "call-1", ToolName: "lookup", Status: "completed", Result: `{"ok":true}`})
	if len(parts) != 1 || parts[0]["state"] != "output-available" {
		t.Fatalf("expected existing tool part to be replaced, got %+v", parts)
	}
	parts = replaceAssistantUIToolPart(parts, chatToolEvent{CallID: "call-2", ToolName: "lookup", Status: "failed", Error: "nope"})
	if len(parts) != 2 {
		t.Fatalf("expected a new tool part, got %+v", parts)
	}
}

func TestAssistantUIMessageContainsApproval(t *testing.T) {
	raw := []byte(`{"parts":[{"type":"dynamic-tool","toolCallId":"call-1","state":"approval-requested","approval":{"id":"approval-1"}}]}`)
	if !assistantUIMessageContainsApproval(raw, "approval-1", "call-1") {
		t.Fatal("expected the canonical message to contain the pending approval")
	}
	if assistantUIMessageContainsApproval(raw, "approval-1", "tampered-call") {
		t.Fatal("did not expect a mismatched call id to validate")
	}
}

func TestAssistantUIMessageRunStatusDefaultsSafely(t *testing.T) {
	if got := assistantUIMessageRunStatus(map[string]any{"metadata": map[string]any{"runStatus": "requires-action"}}); got != "requires-action" {
		t.Fatalf("expected requires-action, got %q", got)
	}
	if got := assistantUIMessageRunStatus(map[string]any{"metadata": map[string]any{"runStatus": "tampered"}}); got != "complete" {
		t.Fatalf("expected complete fallback, got %q", got)
	}
}
