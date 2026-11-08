package server

import (
	"context"
	"encoding/json"
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
	"testing"
)

func TestJustAIControlDiscoveryAndFallback(t *testing.T) {
	d := assistantBuiltInToolDiscovery()
	for _, name := range []string{"get_justai_help", "list_justai_tools", "navigate_justai", "start_live_transcription"} {
		b, ok := d.Bindings[name]
		if !ok || !b.Builtin || !isAssistantBuiltInToolName(name) || !json.Valid(b.Definition.Parameters) {
			t.Fatalf("missing control %s", name)
		}
		parsed, args, ok := parseAssistantBuiltinAction(`{"action":"` + name + `","action_input":{"destination":"profile"}}`)
		if !ok || parsed != name || args["destination"] != "profile" {
			t.Fatalf("fallback did not parse %s", name)
		}
	}
}
func TestJustAIPageRejectsUnknownDestinationsAndTabs(t *testing.T) {
	for _, pair := range [][2]string{{"https://evil.test", ""}, {"profile", "audit"}, {"workspace_settings", "../../admin"}, {"agents", "authentication"}} {
		if _, _, err := justAIPage(pair[0], pair[1]); err == nil {
			t.Fatalf("accepted invalid page %+v", pair)
		}
	}
	href, _, err := justAIPage("admin", "audit")
	if err != nil || href != "/admin?tab=audit" {
		t.Fatalf("bad route %s %v", href, err)
	}
}
func TestJustAIHelpAndActionsDoNotClaimExecution(t *testing.T) {
	a := &App{}
	raw, err := a.executeJustAIControl(context.Background(), uuid.New(), "get_justai_help", map[string]any{"topic": "transcription"})
	if err != nil || !json.Valid(raw) {
		t.Fatal(err)
	}
	raw, err = a.executeJustAIControl(context.Background(), uuid.New(), "navigate_justai", map[string]any{"destination": "profile"})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Status string `json:"status"`
		Action struct {
			Href string `json:"href"`
		} `json:"action"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Status != "ready_to_open" || result.Action.Href != "/profile" {
		t.Fatalf("invalid action %s", raw)
	}
	if _, err = a.executeJustAIControl(context.Background(), uuid.New(), "navigate_justai", map[string]any{"destination": "admin"}); err == nil {
		t.Fatal("admin route bypassed access check")
	}
}
func TestJustAILiveSetupHonorsPlatformControl(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatal(err)
		}
		mock.ExpectQuery("SELECT transcription_enabled").WillReturnRows(sqlmock.NewRows([]string{"enabled"}).AddRow(enabled))
		raw, callErr := (&App{DB: db}).executeJustAIControl(context.Background(), uuid.New(), "start_live_transcription", nil)
		if enabled {
			var r map[string]any
			if callErr != nil || json.Unmarshal(raw, &r) != nil || r["status"] != "ready_to_open" {
				t.Fatalf("bad live setup: %s %v", raw, callErr)
			}
		} else if callErr == nil {
			t.Fatal("disabled transcription allowed")
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
		db.Close()
	}
}
func TestJustAIAdminNavigationRequiresActiveAdmin(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user := uuid.New()
	mock.ExpectQuery("SELECT is_platform_admin FROM users").WithArgs(user).WillReturnRows(sqlmock.NewRows([]string{"admin"}).AddRow(false))
	if _, err := (&App{DB: db}).executeJustAIControl(context.Background(), user, "navigate_justai", map[string]any{"destination": "admin"}); err == nil {
		t.Fatal("member allowed admin navigation")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
func TestJustAICatalogUsesOnlyCurrentBindings(t *testing.T) {
	d := assistantBuiltInToolDiscovery()
	delete(d.Bindings, "start_live_transcription")
	raw, err := justAIToolCatalog(d.Definitions, d.Bindings)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	for _, tool := range result.Tools {
		if tool.Name == "start_live_transcription" {
			t.Fatal("catalog exposed absent binding")
		}
	}
}
func TestJustAIControlsRespectSelectedSourceRestriction(t *testing.T) {
	for _, name := range []string{"get_justai_help", "list_justai_tools", "navigate_justai", "start_live_transcription"} {
		_, err := (&App{}).executeBuiltInChatTool(context.Background(), uuid.New(), uuid.New(), uuid.New(), name, nil, &assistantUserMessage{SelectedOnlyContext: true})
		if err == nil {
			t.Fatalf("restricted mode allowed %s", name)
		}
	}
}
