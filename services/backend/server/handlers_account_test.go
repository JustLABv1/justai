package server

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

func TestRevokeAccountSessionRejectsCurrentSession(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	defer func() {
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
	}()

	current := uuid.New()
	app := &App{DB: db}
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodDelete, "/api/v1/auth/sessions/"+current.String(), nil)
	context.Params = gin.Params{{Key: "id", Value: current.String()}}
	context.Set(middleware.PrincipalKey, middleware.Principal{UserID: uuid.New(), SessionID: current})
	app.revokeAccountSession(context)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestListAccountSessionsIncludesCurrentMarker(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	current := uuid.New()
	other := uuid.New()
	now := time.Now().UTC()
	expectation := mock.ExpectQuery(regexp.QuoteMeta("SELECT id, issued_at, expires_at, last_seen_at, user_agent FROM user_sessions"))
	expectation.WithArgs(sqlmock.AnyArg())
	expectation.WillReturnRows(
		sqlmock.NewRows([]string{"id", "issued_at", "expires_at", "last_seen_at", "user_agent"}).
			AddRow(current, now, now.Add(time.Hour), now, "current browser").
			AddRow(other, now.Add(-time.Hour), now.Add(time.Hour), now.Add(-time.Minute), "other browser"),
	)
	app := &App{DB: db}
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/sessions", nil)
	context.Set(middleware.PrincipalKey, middleware.Principal{UserID: uuid.New(), SessionID: current})
	app.listAccountSessions(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
