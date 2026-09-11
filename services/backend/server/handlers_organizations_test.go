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

func TestListOrganizationMembersKeepsUUIDParameterTypedAsUUID(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{DB: db}
	organizationID := uuid.New()
	userID := uuid.New()
	query := `SELECT u.id, u.email, u.display_name, om.role, om.created_at, CASE WHEN ua.user_id IS NULL THEN '' ELSE '/api/v1/organizations/' || om.organization_id::text || '/members/' || u.id::text || '/avatar' END, COALESCE(floor(extract(epoch FROM ua.updated_at) * 1000000)::text, '') FROM organization_members om JOIN users u ON u.id = om.user_id LEFT JOIN user_avatars ua ON ua.user_id = u.id WHERE om.organization_id = $1 ORDER BY CASE om.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, u.display_name`
	mock.ExpectQuery(regexp.QuoteMeta(query)).
		WithArgs(organizationID).
		WillReturnRows(sqlmock.NewRows([]string{"id", "email", "display_name", "role", "created_at", "avatar_url", "avatar_version"}).
			AddRow(userID, "member@example.com", "Member", "member", time.Now(), "", ""))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/organizations/"+organizationID.String()+"/members", nil)
	context.Params = gin.Params{{Key: "id", Value: organizationID.String()}}
	context.Set(middleware.OrgIDKey, organizationID)
	app.listOrganizationMembers(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

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

func TestOwnerTransferDemotesExistingOwnerAtomically(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{DB: db}
	organizationID := uuid.New()
	targetID := uuid.New()
	ownerID := uuid.New()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2")).
		WithArgs(organizationID, targetID).
		WillReturnRows(sqlmock.NewRows([]string{"role"}).AddRow("member"))
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")).
		WithArgs(organizationID).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(organizationID))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 FOR UPDATE")).
		WithArgs(organizationID, targetID).
		WillReturnRows(sqlmock.NewRows([]string{"role"}).AddRow("member"))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE organization_members SET role = 'admin' WHERE organization_id = $1 AND role = 'owner'")).
		WithArgs(organizationID).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2")).
		WithArgs(organizationID, targetID).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodPatch, "/api/v1/organizations/"+organizationID.String()+"/members/"+targetID.String(), strings.NewReader(`{"role":"owner"}`))
	context.Request.Header.Set("Content-Type", "application/json")
	context.Params = gin.Params{{Key: "id", Value: organizationID.String()}, {Key: "userId", Value: targetID.String()}}
	context.Set(middleware.OrgIDKey, organizationID)
	context.Set(middleware.OrgRoleKey, "owner")
	context.Set(middleware.PrincipalKey, middleware.Principal{UserID: ownerID})
	app.updateOrganizationMember(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
