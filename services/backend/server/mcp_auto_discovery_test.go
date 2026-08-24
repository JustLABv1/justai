package server

import (
	"context"
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
