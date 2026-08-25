package server

import (
	"context"
	"encoding/json"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"

	"justai-backend/mcp"
)

func TestAutomaticMCPToolScorePrefersRelevantNamesAndDescriptions(t *testing.T) {
	calendar := automaticMCPToolScore("What is on my calendar today?", "Google Calendar", mcp.Tool{Name: "list_events", Description: "List calendar events"})
	issues := automaticMCPToolScore("What is on my calendar today?", "Linear", mcp.Tool{Name: "list_issues", Description: "List assigned engineering issues"})
	if calendar <= issues || calendar == 0 {
		t.Fatalf("expected calendar tool to rank higher, got calendar=%d issues=%d", calendar, issues)
	}
}

func TestAutomaticMCPRouterIsMetadataOnly(t *testing.T) {
	discovery := automaticMCPRouterDiscovery()
	binding, ok := discovery.Bindings["discover_mcp_tools"]
	if !ok || !binding.Builtin || binding.RequiresApproval || binding.ServerID != uuid.Nil {
		t.Fatalf("unexpected router binding: %+v (ok=%v)", binding, ok)
	}
	if len(discovery.Definitions) != 1 {
		t.Fatalf("expected one bounded router definition, got %d", len(discovery.Definitions))
	}
}

func TestDiscoverAutomaticMCPToolResolvesExactShortName(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	userID := uuid.New()
	organizationID := uuid.New()
	serverID := uuid.New()
	rows := sqlmock.NewRows([]string{"id", "name", "icon", "allowed_tools", "tool_name", "description", "input_schema", "annotations", "metadata"}).
		AddRow(serverID, "Shell", "", []byte(`[]`), "ls", "List items", []byte(`{"type":"object"}`), []byte(`{}`), []byte(`{}`))
	mock.ExpectQuery(regexp.QuoteMeta("WHERE ms.id = $1 AND mst.name = $2")).
		WithArgs(serverID, "ls", userID, organizationID).
		WillReturnRows(rows)

	name, binding, ok := (&App{DB: database}).discoverAutomaticMCPTool(context.Background(), userID, organizationID, serverID, "ls")
	if !ok || name == "" || binding.ToolName != "ls" || !binding.Automatic || !binding.RequiresApproval {
		t.Fatalf("expected exact approval-gated short-name binding, got name=%q binding=%+v ok=%v", name, binding, ok)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoverHistoricalAutomaticMCPToolRestoresLaterTurnBinding(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	userID := uuid.New()
	organizationID := uuid.New()
	conversationID := uuid.New()
	headID := uuid.New()
	serverID := uuid.New()
	providerName := voiceToolName(serverID, "List Watchlists", nil) + "_2"
	event, err := json.Marshal(chatToolEvent{
		Kind:             "mcp_tool",
		Status:           "completed",
		ServerID:         serverID,
		ToolName:         "List Watchlists",
		ProviderToolName: providerName,
		CallID:           "call-previous-turn",
		Automatic:        true,
	})
	if err != nil {
		t.Fatal(err)
	}

	mock.ExpectQuery("WITH RECURSIVE branch AS").
		WithArgs(conversationID, headID).
		WillReturnRows(sqlmock.NewRows([]string{"role", "content", "ui_message"}).
			AddRow("tool", string(event), []byte(`{}`)).
			AddRow("user", "List them again", []byte(`{}`)))
	mock.ExpectQuery(regexp.QuoteMeta("WHERE ms.id = $1 AND mst.name = $2")).
		WithArgs(serverID, "List Watchlists", userID, organizationID).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "icon", "allowed_tools", "tool_name", "description", "input_schema", "annotations", "metadata"}).
			AddRow(serverID, "MCP", "", []byte(`[]`), "List Watchlists", "List saved watchlists", []byte(`{"type":"object"}`), []byte(`{}`), []byte(`{}`)))

	discovery := (&App{DB: database}).discoverHistoricalAutomaticMCPTool(context.Background(), userID, organizationID, conversationID, headID, providerName)
	binding, ok := discovery.Bindings[providerName]
	if !ok || binding.ServerID != serverID || binding.ToolName != "List Watchlists" || !binding.Automatic {
		t.Fatalf("expected the historical automatic binding to be restored, got %+v (ok=%v)", binding, ok)
	}
	if len(discovery.Definitions) != 1 || discovery.Definitions[0].Name != providerName {
		t.Fatalf("expected the historical provider name to be restored, got %+v", discovery.Definitions)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestHistoricalAutomaticMCPToolEventRejectsAmbiguousRawName(t *testing.T) {
	encode := func(event chatToolEvent) storedChatMessage {
		content, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		return storedChatMessage{Role: "tool", Content: string(content)}
	}
	stored := []storedChatMessage{
		encode(chatToolEvent{Kind: "mcp_tool", ServerID: uuid.New(), ToolName: "list", ProviderToolName: "mcp_one_list", CallID: "call-1", Automatic: true}),
		encode(chatToolEvent{Kind: "mcp_tool", ServerID: uuid.New(), ToolName: "list", ProviderToolName: "mcp_two_list", CallID: "call-2", Automatic: true}),
	}
	if _, ok := historicalAutomaticMCPToolEvent(stored, "list"); ok {
		t.Fatal("expected an ambiguous raw automatic tool name to be rejected")
	}
	if event, ok := historicalAutomaticMCPToolEvent(stored, "mcp_one_list"); !ok || event.ProviderToolName != "mcp_one_list" {
		t.Fatalf("expected an exact provider-safe name to resolve, got %+v (ok=%v)", event, ok)
	}
}

func TestHistoricalAutomaticMCPToolEventAcceptsUniqueNormalizedRawName(t *testing.T) {
	serverID := uuid.New()
	content, err := json.Marshal(chatToolEvent{Kind: "mcp_tool", ServerID: serverID, ToolName: "List Watchlists", ProviderToolName: voiceToolName(serverID, "List Watchlists", nil), CallID: "call-1", Automatic: true})
	if err != nil {
		t.Fatal(err)
	}
	event, ok := historicalAutomaticMCPToolEvent([]storedChatMessage{{Role: "tool", Content: string(content)}}, "list-watchlists")
	if !ok || event.ServerID != serverID {
		t.Fatalf("expected the unique normalized raw name to resolve, got %+v (ok=%v)", event, ok)
	}
}

func TestDiscoverAutomaticMCPToolsIsBoundedAndApprovalGated(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	userID := uuid.New()
	organizationID := uuid.New()
	serverID := uuid.New()
	rows := sqlmock.NewRows([]string{"id", "name", "icon", "allowed_tools", "tool_name", "description", "input_schema", "annotations", "metadata"})
	for index := 0; index < maxAutomaticMCPTools+3; index++ {
		rows.AddRow(serverID, "Calendar", "", []byte("[]"), "calendar_lookup_"+string(rune('a'+index)), "Look up calendar events and meetings", []byte(`{"type":"object"}`), []byte(`{"readOnlyHint":true,"destructiveHint":false}`), []byte(`{}`))
	}
	mock.ExpectQuery(regexp.QuoteMeta("FROM mcp_servers ms")).WithArgs(userID, organizationID).WillReturnRows(rows)

	discovery := (&App{DB: database}).discoverAutomaticMCPTools(context.Background(), userID, organizationID, "calendar meetings", nil)
	if len(discovery.Definitions) != maxAutomaticMCPTools {
		t.Fatalf("expected %d bounded definitions, got %d", maxAutomaticMCPTools, len(discovery.Definitions))
	}
	for name, binding := range discovery.Bindings {
		if !binding.Automatic || !binding.RequiresApproval {
			t.Fatalf("automatic binding %q must be approval gated: %+v", name, binding)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoverAutomaticMCPToolsRespectsAllowlistAndAttachedBindings(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	userID := uuid.New()
	organizationID := uuid.New()
	serverID := uuid.New()
	rows := sqlmock.NewRows([]string{"id", "name", "icon", "allowed_tools", "tool_name", "description", "input_schema", "annotations", "metadata"}).
		AddRow(serverID, "Mail", "", []byte(`["send_mail"]`), "send_mail", "Send an email message", []byte(`{"type":"object"}`), []byte(`{}`), []byte(`{}`)).
		AddRow(serverID, "Mail", "", []byte(`["send_mail"]`), "delete_mail", "Delete an email message", []byte(`{"type":"object"}`), []byte(`{}`), []byte(`{}`))
	mock.ExpectQuery(regexp.QuoteMeta("FROM mcp_servers ms")).WithArgs(userID, organizationID).WillReturnRows(rows)

	existingName := voiceToolName(serverID, "send_mail", nil)
	existing := map[string]voiceToolBinding{existingName: {ServerID: serverID, ToolName: "send_mail"}}
	discovery := (&App{DB: database}).discoverAutomaticMCPTools(context.Background(), userID, organizationID, "send or delete email", existing)
	if len(discovery.Definitions) != 0 {
		t.Fatalf("expected attached and disallowed tools to be excluded, got %+v", discovery.Definitions)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
