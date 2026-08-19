package server

import (
	"context"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
)

func TestNormalizeMCPIconURL(t *testing.T) {
	valid := " https://cdn.example.test/icons/kairos.svg "
	tooLong := "https://example.test/" + string(make([]byte, 2049))
	tests := []struct {
		name    string
		raw     *string
		want    string
		wantErr bool
	}{
		{name: "unset", want: ""},
		{name: "blank", raw: stringPtr("  "), want: ""},
		{name: "http and https are supported", raw: &valid, want: "https://cdn.example.test/icons/kairos.svg"},
		{name: "relative URL", raw: stringPtr("/icons/kairos.svg"), wantErr: true},
		{name: "javascript URL", raw: stringPtr("javascript:alert(1)"), wantErr: true},
		{name: "userinfo is rejected", raw: stringPtr("https://user:pass@example.test/icon.svg"), wantErr: true},
		{name: "too long", raw: &tooLong, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeMCPIconURL(tt.raw)
			if (err != nil) != tt.wantErr {
				t.Fatalf("normalizeMCPIconURL() error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("normalizeMCPIconURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func stringPtr(value string) *string {
	return &value
}

func TestLoadMCPServerAllowsUnsetOAuthTokenURL(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	serverID := uuid.New()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id, endpoint_url, auth_type, encrypted_credential, oauth_refresh_credential, COALESCE(oauth_token_url, ''), COALESCE(oauth_client_id, ''), oauth_expires_at, allowed_tools, trusted_read_only, COALESCE(protocol_version, '') FROM mcp_servers WHERE id = $1 AND enabled = TRUE")).
		WithArgs(serverID).
		WillReturnRows(sqlmock.NewRows([]string{
			"id",
			"endpoint_url",
			"auth_type",
			"encrypted_credential",
			"oauth_refresh_credential",
			"oauth_token_url",
			"oauth_client_id",
			"oauth_expires_at",
			"allowed_tools",
			"trusted_read_only",
			"protocol_version",
		}).AddRow(
			serverID,
			"https://mcp.example.test/sse",
			"none",
			nil,
			nil,
			"",
			"",
			nil,
			[]byte("[]"),
			false,
			"",
		))

	app := &App{DB: db}
	loaded, err := app.loadMCPServer(context.Background(), serverID.String())
	if err != nil {
		t.Fatalf("expected a NULL OAuth token URL to load as empty, got: %v", err)
	}
	if loaded.ID != serverID.String() || loaded.OAuthTokenURL != "" {
		t.Fatalf("unexpected loaded MCP server: %+v", loaded)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
