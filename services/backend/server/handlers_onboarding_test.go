package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

func TestOnboardingUserCannotSelectInstallationSteps(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	userID := uuid.New()
	mock.ExpectQuery("SELECT onboarding_step, onboarding_completed_at FROM users").WithArgs(userID).WillReturnRows(sqlmock.NewRows([]string{"step", "completed"}).AddRow("welcome", nil))
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPut, "/api/v1/onboarding", strings.NewReader(`{"step":"authentication"}`))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
	(&App{DB: db}).updateOnboarding(c)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", recorder.Code)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestOnboardingAdminCompletionIsAtomic(t *testing.T) {
	for _, failUser := range []bool{false, true} {
		t.Run(map[bool]string{true: "rollback", false: "commit"}[failUser], func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			userID := uuid.New()
			mock.ExpectQuery("SELECT step, completed_at FROM installation_setup").WillReturnRows(sqlmock.NewRows([]string{"step", "completed"}).AddRow("ready", nil))
			mock.ExpectBegin()
			mock.ExpectExec("UPDATE installation_setup").WithArgs("ready", true).WillReturnResult(sqlmock.NewResult(0, 1))
			update := mock.ExpectExec("UPDATE users SET onboarding_step").WithArgs(userID, "ready", true)
			if failUser {
				update.WillReturnError(http.ErrAbortHandler)
				mock.ExpectRollback()
			} else {
				update.WillReturnResult(sqlmock.NewResult(0, 1))
				mock.ExpectCommit()
			}
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodPut, "/api/v1/onboarding", strings.NewReader(`{"step":"ready","complete":true}`))
			c.Request.Header.Set("Content-Type", "application/json")
			c.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID, PlatformAdmin: true})
			(&App{DB: db}).updateOnboarding(c)
			expected := http.StatusOK
			if failUser {
				expected = http.StatusInternalServerError
			}
			if recorder.Code != expected {
				t.Fatalf("got %d, want %d", recorder.Code, expected)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestOnboardingExistingAdminUsesPersonalProgress(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	userID := uuid.New()
	mock.ExpectQuery("SELECT step, completed_at FROM installation_setup").WillReturnRows(sqlmock.NewRows([]string{"step", "completed"}).AddRow("ready", time.Now()))
	mock.ExpectQuery("SELECT onboarding_step, onboarding_completed_at FROM users").WithArgs(userID).WillReturnRows(sqlmock.NewRows([]string{"step", "completed"}).AddRow("workspace", nil))
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/onboarding", nil)
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID, PlatformAdmin: true})
	state, err := (&App{DB: db}).readOnboarding(c)
	if err != nil || state.Installation || state.Completed || state.Step != "workspace" {
		t.Fatalf("unexpected progress: %+v, %v", state, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
