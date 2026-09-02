package server

import (
	"strings"
	"testing"
)

func TestSanitizeA2AAgentCardDropsUntrustedExtensionData(t *testing.T) {
	raw := []byte(`{"name":"Research agent","description":"  Finds sources  ","url":"https://agent.example/a2a","version":"1","capabilities":{"streaming":true},"skills":[{"id":"research"}],"secret":"do not persist"}`)
	sanitized, card, err := sanitizeA2AAgentCard(raw)
	if err != nil {
		t.Fatalf("sanitize Agent Card: %v", err)
	}
	if card.Name != "Research agent" || card.Description != "Finds sources" {
		t.Fatalf("unexpected parsed card: %+v", card)
	}
	if strings.Contains(string(sanitized), "do not persist") || strings.Contains(string(sanitized), "secret") {
		t.Fatalf("sanitized card retained unknown data: %s", sanitized)
	}
}

func TestParseA2AJSONFindsTaskIDAndText(t *testing.T) {
	result, err := parseA2AJSON([]byte(`{"jsonrpc":"2.0","id":"request-id","result":{"id":"task-42","status":{"state":"working"},"message":{"parts":[{"kind":"text","text":"Working"}]}}}`), nil)
	if err != nil {
		t.Fatalf("parse A2A response: %v", err)
	}
	if result.TaskID != "task-42" || result.Summary != "Working" || taskStatusFromCard(result.ResponseMetadata) != "working" {
		t.Fatalf("unexpected A2A result: %+v", result)
	}
}

func TestShouldPollA2ATaskUsesTerminalStatus(t *testing.T) {
	if !shouldPollA2ATask(a2aExecutionResult{TaskID: "task-1", ResponseMetadata: map[string]any{"status": "working"}}) {
		t.Fatal("expected working task to be polled")
	}
	if shouldPollA2ATask(a2aExecutionResult{TaskID: "task-1", Summary: "done", ResponseMetadata: map[string]any{"status": "completed"}}) {
		t.Fatal("did not expect completed task to be polled")
	}
}

func TestA2A1TransportSelectionAndStatusNormalization(t *testing.T) {
	selection := selectA2ATransport(remoteAgentConnection{
		EndpointURL: "https://agent.example/rpc",
		AgentCard:   []byte(`{"supportedInterfaces":[{"url":"https://agent.example/a2a/v1","protocolBinding":"HTTP+JSON","protocolVersion":"1.0","tenant":"workspace-1"}]}`),
	})
	if selection.Kind != a2aTransportHTTPJSON || selection.Endpoint != "https://agent.example/a2a/v1" || selection.Tenant != "workspace-1" {
		t.Fatalf("unexpected A2A transport selection: %+v", selection)
	}
	if normalizeA2AStatus("TASK_STATE_INPUT_REQUIRED") != "input-required" || !isTerminalA2AStatus(normalizeA2AStatus("TASK_STATE_COMPLETED")) {
		t.Fatal("expected A2A 1.0 task state enums to normalize")
	}
}

func TestA2AHTTPJSONOperationURL(t *testing.T) {
	messageURL, err := a2AHTTPJSONOperationURL("https://agent.example/a2a/v1", "message/stream", "")
	if err != nil || messageURL != "https://agent.example/a2a/v1/message:stream" {
		t.Fatalf("unexpected message operation URL: %q (%v)", messageURL, err)
	}
	taskURL, err := a2AHTTPJSONOperationURL("https://agent.example/a2a/v1", "tasks/get", "task-42")
	if err != nil || taskURL != "https://agent.example/a2a/v1/tasks/task-42" {
		t.Fatalf("unexpected task operation URL: %q (%v)", taskURL, err)
	}
}

func TestParseA2AArtifactParts(t *testing.T) {
	result, err := parseA2AJSON([]byte(`{"task":{"id":"task-42","artifacts":[{"name":"report.txt","parts":[{"text":"hello"}]},{"name":"data.json","parts":[{"raw":"aGVsbG8=","filename":"data.json","mediaType":"application/json"}]}]}}`), nil)
	if err != nil {
		t.Fatalf("parse A2A artifacts: %v", err)
	}
	if len(result.Artifacts) != 2 || string(result.Artifacts[0].Content) != "hello" || string(result.Artifacts[1].Content) != "hello" {
		t.Fatalf("unexpected artifacts: %+v", result.Artifacts)
	}
}

func TestParseA2ASSEAccumulatesProgressAndTask(t *testing.T) {
	stream := "event: status\ndata: " +
		`{"result":{"id":"task-7","message":{"parts":[{"kind":"text","text":"Hello"}]}}}` + "\n\n" +
		"data: " +
		`{"result":{"id":"task-7","message":{"parts":[{"kind":"text","text":"Hello world"}]}}}` + "\n\n" +
		"data: [DONE]\n\n"
	var progress []string
	result, err := parseA2ASSE(strings.NewReader(stream), func(value string) error {
		progress = append(progress, value)
		return nil
	})
	if err != nil {
		t.Fatalf("parse A2A SSE: %v", err)
	}
	if result.TaskID != "task-7" || result.Summary != "Hello world" {
		t.Fatalf("unexpected streamed result: %+v", result)
	}
	if len(progress) != 2 {
		t.Fatalf("expected two progress updates, got %d", len(progress))
	}
}
