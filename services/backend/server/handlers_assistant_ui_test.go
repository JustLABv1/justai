package server

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"justai-backend/models"
	"justai-backend/provider"
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

func TestFindAssistantUIApprovalAcceptsProtocolResponseWithoutToolMetadata(t *testing.T) {
	rawPart := json.RawMessage(`{"type":"tool-approval-response","approvalId":"approval-1","approved":true}`)
	approval := findAssistantUIApproval([]assistantUIMessage{{
		ID:    "assistant-1",
		Role:  "assistant",
		Parts: []json.RawMessage{rawPart},
	}})
	if approval == nil {
		t.Fatal("expected an approval response")
	}
	if approval.ApprovalID != "approval-1" || !approval.Approved {
		t.Fatalf("unexpected approval: %+v", approval)
	}
	if approval.CallID != "" || approval.ToolName != "" || approval.Arguments != nil {
		t.Fatalf("expected tool metadata to be resolved from the pending event, got %+v", approval)
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

func TestAssistantUIApprovalArgumentsMatchTreatsEmptyObjectsAsEqual(t *testing.T) {
	if !assistantUIApprovalArgumentsMatch(nil, map[string]any{}) {
		t.Fatal("expected nil and empty arguments to match")
	}
	if !assistantUIApprovalArgumentsMatch(map[string]any{}, nil) {
		t.Fatal("expected empty and nil arguments to match")
	}
	if assistantUIApprovalArgumentsMatch(map[string]any{"query": "one"}, map[string]any{"query": "two"}) {
		t.Fatal("expected different arguments not to match")
	}
}

func TestAssistantBuiltinToolDiscoveryIncludesChatCapabilities(t *testing.T) {
	discovery := assistantBuiltInToolDiscovery()
	for _, name := range []string{"web_search", "browse_url", "generate_image", "edit_image"} {
		binding, ok := discovery.Bindings[name]
		if !ok || !binding.Builtin {
			t.Fatalf("expected built-in binding for %q: %+v", name, binding)
		}
		if len(binding.Definition.Parameters) == 0 || !json.Valid(binding.Definition.Parameters) {
			t.Fatalf("expected valid JSON schema for %q", name)
		}
	}
}

func TestParseAssistantBuiltinAction(t *testing.T) {
	toolName, arguments, ok := parseAssistantBuiltinAction(`{
  "action": "dalle.text2im",
  "action_input": "{ \"prompt\": \"a raccoon\" }",
  "thought": "generate it"
}`)
	if !ok || toolName != "generate_image" || arguments["prompt"] != "a raccoon" {
		t.Fatalf("unexpected parsed action: %q %+v %v", toolName, arguments, ok)
	}

	toolName, arguments, ok = parseAssistantBuiltinAction(`{"action":"web_search","action_input":{"q":"latest news"}}`)
	if !ok || toolName != "web_search" || arguments["query"] != "latest news" {
		t.Fatalf("unexpected web action: %q %+v %v", toolName, arguments, ok)
	}

	toolName, arguments, ok = parseAssistantBuiltinAction(`{ "action": "dalle.text2im", "action_input": "{ "prompt": "A raccoon" }", "thought": "generate it" }`)
	if !ok || toolName != "generate_image" || arguments["prompt"] != "A raccoon" {
		t.Fatalf("unexpected malformed action: %q %+v %v", toolName, arguments, ok)
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

func TestAssistantUIToolNameUsesProviderSafeName(t *testing.T) {
	event := chatToolEvent{
		ToolName:         "search_plain_docs",
		ProviderToolName: "mcp_12345678_search_plain_docs",
	}
	if got := assistantUIToolName(event); got != event.ProviderToolName {
		t.Fatalf("expected the provider-safe tool name, got %q", got)
	}
	if !assistantUIApprovalToolNameMatchesEvent(event.ProviderToolName, event) {
		t.Fatal("expected a provider-safe approval name to match")
	}
	if !assistantUIApprovalToolNameMatchesEvent(event.ToolName, event) {
		t.Fatal("expected the raw approval name to remain backwards compatible")
	}
	if assistantUIApprovalToolNameMatchesEvent("mcp_other_tool", event) {
		t.Fatal("did not expect an unrelated tool name to match")
	}
}

func TestAssistantUIToolPartCarriesDisplayMetadata(t *testing.T) {
	part := assistantUIDynamicToolPart(chatToolEvent{
		Kind:             "mcp_tool",
		Status:           "completed",
		ServerID:         uuid.MustParse("bcf5f2e0-031c-4172-9ea1-3e73c4e42da1"),
		ServerName:       "Kairos",
		ToolName:         "getCheckHistory",
		ProviderToolName: "mcp_bcf5f2e0_getcheckhistory",
		CallID:           "call-display",
	})
	providerMetadata, ok := part["callProviderMetadata"].(map[string]any)
	if !ok {
		t.Fatalf("expected display provider metadata, got %+v", part)
	}
	details, ok := providerMetadata["justai"].(map[string]any)
	if !ok || details["serverName"] != "Kairos" || details["toolName"] != "getCheckHistory" {
		t.Fatalf("unexpected display provider metadata: %+v", providerMetadata)
	}
}

func TestAssistantUIFindToolDisplayBindingMatchesProviderSafeName(t *testing.T) {
	binding := assistantUIToolDisplayBinding{
		ServerID:   uuid.MustParse("bcf5f2e0-031c-4172-9ea1-3e73c4e42da1"),
		ServerName: "Kairos",
		ToolName:   "getCheckHistory",
	}

	matched, ok := assistantUIFindToolDisplayBinding("mcp_bcf5f2e0_getcheckhistory", []assistantUIToolDisplayBinding{binding})
	if !ok || matched != binding {
		t.Fatalf("expected provider-safe name to match %+v, got %+v, ok=%v", binding, matched, ok)
	}
}

func TestAssistantUIFindToolDisplayBindingMatchesNormalizedName(t *testing.T) {
	binding := assistantUIToolDisplayBinding{
		ServerID:   uuid.MustParse("bcf5f2e0-031c-4172-9ea1-3e73c4e42da1"),
		ServerName: "Kairos",
		ToolName:   "getCheckHistory",
	}

	matched, ok := assistantUIFindToolDisplayBinding("getcheckhistory", []assistantUIToolDisplayBinding{binding})
	if !ok || matched != binding {
		t.Fatalf("expected normalized name to match %+v, got %+v, ok=%v", binding, matched, ok)
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
					"id":   "tool-row-1",
					"role": "assistant",
					"parts": []any{map[string]any{
						"type":       "dynamic-tool",
						"toolCallId": "call-1",
						"state":      "output-available",
						"callProviderMetadata": map[string]any{"justai": map[string]any{
							"serverName": "Kairos",
							"toolName":   "getCheckHistory",
						}},
					}},
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
	canonicalParts := repository.Messages[1].Message["parts"].([]any)
	canonicalToolPart := canonicalParts[0].(map[string]any)
	providerMetadata, ok := canonicalToolPart["callProviderMetadata"].(map[string]any)
	if !ok {
		t.Fatalf("expected legacy display metadata to be copied to canonical message, got %+v", canonicalToolPart)
	}
	details := providerMetadata["justai"].(map[string]any)
	if details["serverName"] != "Kairos" || details["toolName"] != "getCheckHistory" {
		t.Fatalf("unexpected copied display metadata: %+v", providerMetadata)
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
	if !assistantUIMessageContainsApproval(raw, "approval-1", "") {
		t.Fatal("expected an approval-only response to resolve by approval id")
	}
	if assistantUIMessageContainsApproval(raw, "approval-1", "tampered-call") {
		t.Fatal("did not expect a mismatched call id to validate")
	}
}

func TestAssistantUIApprovalEventTerminalStates(t *testing.T) {
	for _, status := range []string{"completed", "failed", "declined"} {
		if !assistantUIApprovalEventIsTerminal(status) {
			t.Fatalf("expected %q to be terminal", status)
		}
	}
	for _, status := range []string{"awaiting_approval", "running", ""} {
		if assistantUIApprovalEventIsTerminal(status) {
			t.Fatalf("did not expect %q to be terminal", status)
		}
	}
}

func TestAssistantUIMessageRunStatusDefaultsSafely(t *testing.T) {
	if got := assistantUIMessageRunStatus(map[string]any{"metadata": map[string]any{"runStatus": "requires-action"}}); got != "requires-action" {
		t.Fatalf("expected requires-action, got %q", got)
	}
	if got := assistantUIMessageRunStatus(map[string]any{"metadata": map[string]any{"runStatus": "error"}}); got != "error" {
		t.Fatalf("expected error, got %q", got)
	}
	if got := assistantUIMessageRunStatus(map[string]any{"metadata": map[string]any{"runStatus": "tampered"}}); got != "complete" {
		t.Fatalf("expected complete fallback, got %q", got)
	}
}

func TestCollapseAssistantUIRetrievalStatusesKeepsLatestState(t *testing.T) {
	message := map[string]any{
		"parts": []any{
			map[string]any{
				"type": "data-retrieval-status",
				"data": map[string]any{"status": "started"},
			},
			map[string]any{
				"type": "data-retrieval-status",
				"data": map[string]any{"status": "completed", "citationCount": 2},
			},
			map[string]any{"type": "text", "text": "Answer"},
		},
	}

	collapseAssistantUIRetrievalStatuses(message)
	parts := message["parts"].([]any)
	if len(parts) != 2 {
		t.Fatalf("expected one status and one text part, got %+v", parts)
	}
	statusPart := parts[0].(map[string]any)
	statusData := statusPart["data"].(map[string]any)
	if statusData["status"] != "completed" {
		t.Fatalf("expected the latest retrieval status, got %+v", statusData)
	}
}

func TestRemoveAssistantUIRetrievalStatuses(t *testing.T) {
	message := map[string]any{
		"parts": []any{
			map[string]any{"type": "data-retrieval-status"},
			map[string]any{"type": "text", "text": "Answer"},
		},
	}

	removeAssistantUIRetrievalStatuses(message)
	parts := message["parts"].([]any)
	if len(parts) != 1 || parts[0].(map[string]any)["type"] != "text" {
		t.Fatalf("expected retrieval status to be removed, got %+v", parts)
	}
}

func TestAssistantUIMessageHasSourceParts(t *testing.T) {
	if !assistantUIMessageHasSourceParts(map[string]any{
		"parts": []any{map[string]any{"type": "source-document", "sourceId": "source-1"}},
	}) {
		t.Fatal("expected source-document part to mark a message as grounded")
	}
	if assistantUIMessageHasSourceParts(map[string]any{
		"parts": []any{map[string]any{"type": "text", "text": "Answer"}},
	}) {
		t.Fatal("did not expect a text-only message to be marked as grounded")
	}
}

func TestDeduplicateAssistantUICitationsKeepsOneEntryPerResource(t *testing.T) {
	sourceID := uuid.New()
	otherSourceID := uuid.New()
	citations := []models.Citation{
		{Kind: "knowledge", ResourceID: sourceID, Title: "README.md", ChunkIndex: 0},
		{Kind: "knowledge", ResourceID: sourceID, Title: "README.md", ChunkIndex: 1},
		{Kind: "knowledge", ResourceID: otherSourceID, Title: "START-HERE.md", ChunkIndex: 0},
	}

	unique := deduplicateAssistantUICitations(citations)
	if len(unique) != 2 {
		t.Fatalf("expected two unique source entries, got %+v", unique)
	}
	if unique[0].ChunkIndex != 0 || unique[1].ResourceID != otherSourceID {
		t.Fatalf("expected the first citation per resource to be retained, got %+v", unique)
	}
}

func TestDeduplicateAssistantUISourcePartsRemovesRepeatedResourceRows(t *testing.T) {
	sourceID := uuid.New().String()
	message := map[string]any{
		"parts": []any{
			map[string]any{"type": "text", "text": "Answer"},
			map[string]any{"type": "source-document", "sourceId": sourceID, "title": "README.md"},
			map[string]any{"type": "source-document", "sourceId": sourceID, "title": "README.md"},
			map[string]any{"type": "source-url", "sourceId": uuid.New().String(), "title": "Docs"},
		},
	}

	deduplicateAssistantUISourceParts(message)
	parts := message["parts"].([]any)
	if len(parts) != 3 {
		t.Fatalf("expected repeated source row to be removed, got %+v", parts)
	}
}

func TestAssistantUIToolPartCarriesMCPAppMetadata(t *testing.T) {
	part := assistantUIDynamicToolPart(chatToolEvent{
		Status:            "completed",
		ServerID:          uuid.New(),
		ToolName:          "weather",
		MCPAppResourceURI: "ui://weather/widget",
		CallID:            "call-app",
		Result:            `{"temperature":22}`,
	})
	mcpMetadata, ok := part["mcp"].(map[string]any)
	if !ok {
		t.Fatalf("expected MCP metadata, got %+v", part)
	}
	appMetadata, ok := mcpMetadata["app"].(map[string]any)
	if !ok || appMetadata["resourceUri"] != "ui://weather/widget" {
		t.Fatalf("unexpected MCP app metadata: %+v", mcpMetadata)
	}
}

func TestLatestAssistantUserMessageIncludesQuotedContextWithoutTextPart(t *testing.T) {
	message := latestAssistantUserMessage([]assistantUIMessage{{
		ID:       "user-quote",
		Role:     "user",
		Metadata: json.RawMessage(`{"custom":{"quote":{"messageId":"source-1","text":"A decision was made."}}}`),
	}})
	if message == nil {
		t.Fatal("expected a quote-only user message")
	}
	if message.Text != "Please respond to the quoted context.\n\nQuoted context:\n> A decision was made." {
		t.Fatalf("unexpected quoted prompt: %q", message.Text)
	}
}

func TestLatestAssistantUserMessageCarriesMessageScopedAttachmentSource(t *testing.T) {
	sourceID := uuid.New()
	message := latestAssistantUserMessage([]assistantUIMessage{{
		ID:   "user-file",
		Role: "user",
		Parts: []json.RawMessage{
			json.RawMessage(`{"type":"file","url":"justai-source:` + sourceID.String() + `","mediaType":"text/plain","filename":"notes.txt"}`),
			json.RawMessage(`{"type":"data-justai-attachment","data":{"sourceId":"` + sourceID.String() + `","contextScope":"message"}}`),
		},
	}})
	if message == nil {
		t.Fatal("expected a file-only user message")
	}
	if message.Text != "Please inspect the attached file." {
		t.Fatalf("unexpected file prompt: %q", message.Text)
	}
	if len(message.AttachmentSourceIDs) != 1 || message.AttachmentSourceIDs[0] != sourceID {
		t.Fatalf("unexpected attachment source ids: %+v", message.AttachmentSourceIDs)
	}
}

func TestAssistantUIImageHelpersAcceptAISDKFileParts(t *testing.T) {
	validPNG := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	messages := []assistantUIMessage{{
		Role:  "user",
		Parts: []json.RawMessage{json.RawMessage(`{"type":"file","url":"data:image/png;base64,` + validPNG + `","mediaType":"image/png"}`)},
	}}
	if !assistantUIMessageHasImages(messages) {
		t.Fatal("expected an AI SDK file part with an image media type to be detected")
	}
	parts := assistantUIProviderImageParts(messages[0].Parts)
	if len(parts) != 1 || parts[0].ImageURL == nil || parts[0].ImageURL.URL != "data:image/png;base64,"+validPNG {
		t.Fatalf("unexpected provider image parts: %+v", parts)
	}
}

func TestAssistantUIProviderImagePartsSkipsInvalidHistoricalImages(t *testing.T) {
	validPNG := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	parts := assistantUIProviderImageParts([]json.RawMessage{
		json.RawMessage(`{"type":"file","url":"data:image/png;base64,aGVsbG8=","mediaType":"image/png"}`),
		json.RawMessage(`{"type":"file","url":"data:image/png;base64,` + validPNG + `","mediaType":"image/png"}`),
	})
	if len(parts) != 1 || parts[0].ImageURL == nil || parts[0].ImageURL.URL != "data:image/png;base64,"+validPNG {
		t.Fatalf("expected only the decodable image to reach the provider, got %+v", parts)
	}
}

func TestValidateAssistantUIImagePartsChecksImageBytes(t *testing.T) {
	validPNG := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	valid := []assistantUIMessage{{
		Role:  "user",
		Parts: []json.RawMessage{json.RawMessage(`{"type":"file","url":"data:image/png;base64,` + validPNG + `","mediaType":"image/png"}`)},
	}}
	if err := validateAssistantUIImageParts(valid); err != nil {
		t.Fatalf("expected a valid PNG to pass validation: %v", err)
	}

	invalid := []assistantUIMessage{{
		Role:  "user",
		Parts: []json.RawMessage{json.RawMessage(`{"type":"file","url":"data:image/png;base64,aGVsbG8=","mediaType":"image/png"}`)},
	}}
	if err := validateAssistantUIImageParts(invalid); err == nil {
		t.Fatal("expected invalid image bytes to be rejected")
	}
}

func TestAssistantUIErrorPartIsDurableData(t *testing.T) {
	part := assistantUIErrorPart("provider unavailable")
	if part["type"] != "data-justai-error" {
		t.Fatalf("unexpected error part type: %+v", part)
	}
	data, ok := part["data"].(map[string]any)
	if !ok || data["message"] != "provider unavailable" {
		t.Fatalf("unexpected error part data: %+v", part)
	}
}

func TestAssistantUIEndpointForRequestSelectsVisionModel(t *testing.T) {
	endpoint := provider.Endpoint{
		ChatModel:   "text-model",
		VisionModel: "vision-model",
		Capabilities: map[string]bool{
			"chat":   true,
			"vision": true,
		},
	}

	selected, err := assistantUIEndpointForRequest(endpoint, "request-model", true)
	if err != nil {
		t.Fatal(err)
	}
	if selected.ChatModel != "vision-model" {
		t.Fatalf("expected the configured vision model, got %q", selected.ChatModel)
	}

	selected, err = assistantUIEndpointForRequest(endpoint, "request-model", false)
	if err != nil {
		t.Fatal(err)
	}
	if selected.ChatModel != "request-model" {
		t.Fatalf("expected an explicit text request model, got %q", selected.ChatModel)
	}
}

func TestAssistantUIEndpointForRequestRejectsImagesWithoutVision(t *testing.T) {
	_, err := assistantUIEndpointForRequest(provider.Endpoint{
		ChatModel:    "text-model",
		Capabilities: map[string]bool{"chat": true},
	}, "", true)
	if err == nil {
		t.Fatal("expected image requests to be rejected for a text-only endpoint")
	}
}
