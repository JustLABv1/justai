package server

import (
	"context"
	"encoding/binary"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"

	"justai-backend/mcp"
	"justai-backend/provider"
)

func TestVoiceToolNamesAreProviderSafeAndUnique(t *testing.T) {
	serverID := uuid.MustParse("12345678-1234-1234-1234-123456789abc")
	existing := map[string]voiceToolBinding{}
	first := voiceToolName(serverID, "light.turn-on", existing)
	existing[first] = voiceToolBinding{ToolName: "light.turn-on"}
	second := voiceToolName(serverID, "light/turn-on", existing)
	if first == second || len(second) > 64 {
		t.Fatalf("expected unique bounded names, got %q and %q", first, second)
	}
	if first != "mcp_12345678_light_turn_on" || second != "mcp_12345678_light_turn_on_2" {
		t.Fatalf("unexpected normalized names: %q %q", first, second)
	}
}

func TestVoiceAudioFramePreservesHeaderAndPCM(t *testing.T) {
	payload := make([]byte, 17+4)
	payload[0] = 1
	binary.LittleEndian.PutUint64(payload[1:9], 1234)
	binary.LittleEndian.PutUint32(payload[9:13], 7)
	binary.LittleEndian.PutUint32(payload[13:17], 48000)
	copy(payload[17:], []byte{1, 2, 3, 4})
	frame := parseAudioFrame(payload)
	if frame.CaptureTimestamp != 1234 || frame.Sequence != 7 || frame.SampleRate != 48000 || string(frame.PCM) != string([]byte{1, 2, 3, 4}) {
		t.Fatalf("unexpected voice frame: %+v", frame)
	}
}

func TestVoiceToolCallingCapabilityIsExplicitForCompatibleProviders(t *testing.T) {
	if !provider.SupportsToolCalling(provider.Endpoint{ProviderType: "openai"}) {
		t.Fatal("native OpenAI should support tool calling")
	}
	if provider.SupportsToolCalling(provider.Endpoint{ProviderType: "openai-compatible"}) {
		t.Fatal("compatible providers must opt into tool calling")
	}
	if !provider.SupportsToolCalling(provider.Endpoint{ProviderType: "openai-compatible", Capabilities: map[string]bool{"tool-calling": true}}) {
		t.Fatal("explicit compatible tool calling capability was ignored")
	}
}

func TestMCPToolAllowlistTreatsEmptyAsAll(t *testing.T) {
	if !mcpToolAllowed(nil, "search_plain_docs") {
		t.Fatal("an empty allowlist should allow discovered tools")
	}
	if !mcpToolAllowed(map[string]bool{}, "search_plain_docs") {
		t.Fatal("an empty map allowlist should allow discovered tools")
	}
	if !mcpToolAllowed(map[string]bool{"search_plain_docs": true}, "search_plain_docs") {
		t.Fatal("an explicitly allowlisted tool should be allowed")
	}
	if mcpToolAllowed(map[string]bool{"other_tool": true}, "search_plain_docs") {
		t.Fatal("a non-allowlisted tool should be rejected")
	}
}

func TestFindMCPBindingMatchesRawToolNameAndServer(t *testing.T) {
	serverID := uuid.MustParse("12345678-1234-1234-1234-123456789abc")
	otherServerID := uuid.MustParse("abcdefab-cdef-abcd-efab-cdefabcdefab")
	bindings := map[string]voiceToolBinding{
		"mcp_12345678_search_plain_docs": {
			ServerID: serverID,
			ToolName: "search_plain_docs",
		},
		"mcp_abcdefab_search_plain_docs": {
			ServerID: otherServerID,
			ToolName: "search_plain_docs",
		},
	}

	found, ok := findMCPBinding(bindings, serverID, "search_plain_docs")
	if !ok || found.ServerID != serverID {
		t.Fatalf("expected the binding for %s, got %+v (ok=%v)", serverID, found, ok)
	}
	if _, ok := findMCPBinding(bindings, serverID, "missing_tool"); ok {
		t.Fatal("an unknown MCP tool should not resolve")
	}
	if _, ok := findMCPBinding(bindings, uuid.New(), "search_plain_docs"); ok {
		t.Fatal("a tool on another server should not resolve")
	}
}

func TestFindMCPBindingReturnsProviderSafeName(t *testing.T) {
	serverID := uuid.MustParse("12345678-1234-1234-1234-123456789abc")
	providerName, binding, ok := findMCPBindingWithProviderName(map[string]voiceToolBinding{
		"mcp_12345678_search_plain_docs": {
			ServerID: serverID,
			ToolName: "search_plain_docs",
		},
	}, serverID, "search_plain_docs")
	if !ok || providerName != "mcp_12345678_search_plain_docs" || binding.ToolName != "search_plain_docs" {
		t.Fatalf("unexpected MCP binding lookup: %q %+v (ok=%v)", providerName, binding, ok)
	}
}

func TestFindVoiceToolBindingAcceptsRawAndNormalizedNames(t *testing.T) {
	serverID := uuid.MustParse("12345678-1234-1234-1234-123456789abc")
	bindings := map[string]voiceToolBinding{
		"mcp_12345678_getcheckhistory": {
			ServerID: serverID,
			ToolName: "getCheckHistory",
		},
	}

	for _, name := range []string{"mcp_12345678_getcheckhistory", "getCheckHistory", "getcheckhistory"} {
		binding, ok := findVoiceToolBinding(bindings, name)
		if !ok || binding.ServerID != serverID || binding.ToolName != "getCheckHistory" {
			t.Fatalf("expected %q to resolve to the MCP binding, got %+v (ok=%v)", name, binding, ok)
		}
	}
}

func TestFindVoiceToolBindingRejectsAmbiguousNormalizedNames(t *testing.T) {
	bindings := map[string]voiceToolBinding{
		"mcp_12345678_getcheckhistory": {
			ServerID: uuid.MustParse("12345678-1234-1234-1234-123456789abc"),
			ToolName: "getCheckHistory",
		},
		"mcp_abcdefab_getcheckhistory": {
			ServerID: uuid.MustParse("abcdefab-cdef-abcd-efab-cdefabcdefab"),
			ToolName: "GETCHECKHISTORY",
		},
	}
	if _, ok := findVoiceToolBinding(bindings, "getcheckhistory"); ok {
		t.Fatal("expected an ambiguous normalized MCP name to be rejected")
	}
}

func TestCacheMCPToolsDoesNotMarkEmptyDiscoveryFresh(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	serverID := uuid.New()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE mcp_servers SET tools_discovered_at = NULL WHERE id = $1")).
		WithArgs(serverID).
		WillReturnResult(sqlmock.NewResult(0, 1))

	app := &App{DB: db}
	if err := app.cacheMCPTools(context.Background(), serverID, nil); err != nil {
		t.Fatalf("expected empty discovery to invalidate the marker, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestMCPToolsAfterRefreshKeepsStaleSnapshotOnEmptySuccess(t *testing.T) {
	stale := []mcp.Tool{{Name: "List Watchlists"}}
	tools, usingStale := mcpToolsAfterRefresh(stale, nil)
	if !usingStale || len(tools) != 1 || tools[0].Name != "List Watchlists" {
		t.Fatalf("expected the stale snapshot to remain available, got %+v (usingStale=%v)", tools, usingStale)
	}

	fresh := []mcp.Tool{{Name: "List Scans"}}
	tools, usingStale = mcpToolsAfterRefresh(stale, fresh)
	if usingStale || len(tools) != 1 || tools[0].Name != "List Scans" {
		t.Fatalf("expected a non-empty refresh to replace the snapshot, got %+v (usingStale=%v)", tools, usingStale)
	}
}
