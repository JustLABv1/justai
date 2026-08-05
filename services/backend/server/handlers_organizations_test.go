package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
)

func TestCreateOrganizationAddsCurrentUserAsOwner(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{DB: db}
	userID := uuid.New()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)")).WithArgs(sqlmock.AnyArg(), "Design team", sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')")).WithArgs(sqlmock.AnyArg(), userID).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodPost, "/api/v1/organizations", strings.NewReader(`{"name":"Design team"}`))
	context.Request.Header.Set("Content-Type", "application/json")
	context.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
	app.createOrganization(context)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Organization models.Organization `json:"organization"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Organization.Name != "Design team" || response.Organization.Role != "owner" {
		t.Fatalf("unexpected organization response: %+v", response.Organization)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateOrganizationRequiresCurrentOrganizationAndUpdatesName(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{DB: db}
	organizationID := uuid.New()
	mock.ExpectQuery(regexp.QuoteMeta("UPDATE organizations SET name = $2 WHERE id = $1 RETURNING id, name, slug")).WithArgs(organizationID, "Renamed workspace").WillReturnRows(sqlmock.NewRows([]string{"id", "name", "slug"}).AddRow(organizationID, "Renamed workspace", "renamed-workspace-12345678"))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodPatch, "/api/v1/organizations/"+organizationID.String(), strings.NewReader(`{"name":"Renamed workspace"}`))
	context.Request.Header.Set("Content-Type", "application/json")
	context.Params = gin.Params{{Key: "id", Value: organizationID.String()}}
	context.Set(middleware.OrgIDKey, organizationID)
	context.Set(middleware.OrgRoleKey, "owner")
	app.updateOrganization(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAdminCannotChangeOwnerRole(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{DB: db}
	organizationID := uuid.New()
	targetID := uuid.New()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2")).WithArgs(organizationID, targetID).WillReturnRows(sqlmock.NewRows([]string{"role"}).AddRow("owner"))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodPatch, "/api/v1/organizations/"+organizationID.String()+"/members/"+targetID.String(), strings.NewReader(`{"role":"member"}`))
	context.Request.Header.Set("Content-Type", "application/json")
	context.Params = gin.Params{{Key: "id", Value: organizationID.String()}, {Key: "userId", Value: targetID.String()}}
	context.Set(middleware.OrgIDKey, organizationID)
	context.Set(middleware.OrgRoleKey, "admin")
	app.updateOrganizationMember(context)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
