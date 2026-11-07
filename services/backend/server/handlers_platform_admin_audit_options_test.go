package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

func TestAuditOptionsRequiresPlatformAdmin(t *testing.T) {
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit/options", nil)
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: uuid.New()})
	(&App{}).listPlatformAuditOptions(c)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestAuditOptionsIncludesCatalogValues(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectQuery("SELECT 'action' AS kind").WillReturnRows(sqlmock.NewRows([]string{"kind", "value"}).AddRow("action", "platform.user.updated").AddRow("action", "platform.workspace.created").AddRow("resourceType", "organization").AddRow("resourceType", "user"))
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit/options", nil)
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: uuid.New(), PlatformAdmin: true})
	(&App{DB: db}).listPlatformAuditOptions(c)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	var result struct {
		Actions       []string `json:"actions"`
		ResourceTypes []string `json:"resourceTypes"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Actions) != 2 || result.Actions[1] != "platform.workspace.created" || len(result.ResourceTypes) != 2 || result.ResourceTypes[0] != "organization" {
		t.Fatalf("unexpected options: %+v", result)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
