package server

import (
	"testing"

	"github.com/google/uuid"
)

func TestAgentMCPToolSelectedScopesQualifiedNamesToTheirServer(t *testing.T) {
	first, second := uuid.New(), uuid.New()
	cases := []struct {
		name     string
		selected []string
		server   uuid.UUID
		tool     string
		want     bool
	}{
		{"nothing selected allows all", nil, first, "search", true},
		{"qualified match", []string{first.String() + ":search"}, first, "search", true},
		{"qualified narrows its own server", []string{first.String() + ":search"}, first, "fetch", false},
		{"other server keeps every tool", []string{first.String() + ":search"}, second, "fetch", true},
		{"plain name filters every server", []string{"search"}, second, "fetch", false},
		{"plain name matches", []string{"search"}, second, "search", true},
		{"dot and slash separators", []string{first.String() + "/search", first.String() + ".fetch"}, first, "fetch", true},
	}
	for _, tc := range cases {
		if got := agentMCPToolSelected(tc.selected, tc.server, tc.tool); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
