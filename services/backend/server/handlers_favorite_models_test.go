package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

func TestFavoriteModelsRoundTrip(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	userID := uuid.New()
	mock.ExpectExec("UPDATE users SET favorite_models").WithArgs(userID, []byte(`["e1::a","e2::b"]`)).WillReturnResult(sqlmock.NewResult(0, 1))
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPut, "/api/v1/profile/favorite-models", strings.NewReader(`{"favorites":["e1::a","","e2::b","e1::a"]}`))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
	(&App{DB: db}).saveFavoriteModels(c)
	if recorder.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", recorder.Code)
	}

	mock.ExpectQuery("SELECT favorite_models FROM users").WithArgs(userID).WillReturnRows(sqlmock.NewRows([]string{"favorite_models"}).AddRow([]byte(`["e1::a","e2::b"]`)))
	recorder = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/profile/favorite-models", nil)
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
	(&App{DB: db}).getFavoriteModels(c)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `["e1::a","e2::b"]`) {
		t.Fatalf("got %d %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
