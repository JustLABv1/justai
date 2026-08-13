package server

import (
	"context"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
)

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
