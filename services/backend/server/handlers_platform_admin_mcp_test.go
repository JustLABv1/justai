package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
	"justai-backend/models"
)

func TestListPlatformMCPServersIncludesOAuthExpiry(t *testing.T) {
	for _, oauth := range []bool{false, true} {
		name := "without OAuth expiry"
		if oauth {
			name = "with OAuth expiry"
		}
		t.Run(name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			serverID := uuid.New()
			now := time.Date(2026, 10, 30, 10, 0, 0, 0, time.UTC)
			var expiry any
			if oauth {
				expiry = now.Add(time.Hour)
			}
			mock.ExpectQuery(regexp.QuoteMeta("trusted_read_only, auto_discover, oauth_expires_at, last_tested_at")).
				WithArgs("global", "").
				WillReturnRows(sqlmock.NewRows(strings.Fields("id scope_type scope_id name icon_url endpoint_url auth_type credential_configured enabled allowed_tools trusted_read_only auto_discover oauth_expires_at last_tested_at last_error protocol_version tool_count created_at updated_at")).
					AddRow(serverID, "global", nil, "Global MCP", "", "https://mcp.example.test", "oauth", true, true, []byte(`[]`), false, true, expiry, nil, "", "2025-06-18", 3, now, now))
			response := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(response)
			c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/servers?scope=global", nil)
			c.Set(middleware.PrincipalKey, middleware.Principal{UserID: uuid.New(), PlatformAdmin: true})
			(&App{DB: db}).listPlatformMCPServers(c)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			var result struct {
				Servers []models.MCPServer `json:"servers"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if len(result.Servers) != 1 {
				t.Fatalf("servers = %+v", result.Servers)
			}
			server := result.Servers[0]
			if server.ID != serverID || server.ScopeID != nil || !server.AutoDiscover || server.ToolCount != 3 {
				t.Fatalf("unexpected server: %+v", server)
			}
			if oauth {
				if server.OAuthExpiresAt == nil || !server.OAuthExpiresAt.Equal(expiry.(time.Time)) {
					t.Fatalf("OAuth expiry = %v, want %v", server.OAuthExpiresAt, expiry)
				}
			} else if server.OAuthExpiresAt != nil {
				t.Fatalf("OAuth expiry = %v, want nil", server.OAuthExpiresAt)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
