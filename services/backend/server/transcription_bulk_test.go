package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func TestBulkUpdateTranscriptionSessionsIsScopedToUserAndOrganization(t *testing.T) {
	app, mock, cleanup := newConversationTestApp(t)
	defer cleanup()
	userID, organizationID, first, second := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	mock.ExpectExec("UPDATE transcription_sessions").
		WithArgs(sqlmock.AnyArg(), userID, organizationID, nil, true).
		WillReturnResult(sqlmock.NewResult(0, 2))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	body := `{"ids":["` + first.String() + `","` + second.String() + `"],"done":true}`
	context.Request = httptest.NewRequest(http.MethodPatch, "/api/v1/transcription/sessions", strings.NewReader(body))
	context.Request.Header.Set("Content-Type", "application/json")
	setConversationPrincipal(context, userID, organizationID)
	app.bulkUpdateTranscriptionSessions(context)

	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"updated":2`) {
		t.Fatalf("unexpected response %d %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestBulkUpdateTranscriptionSessionsValidatesInput(t *testing.T) {
	app, _, cleanup := newConversationTestApp(t)
	defer cleanup()
	for name, body := range map[string]string{
		"no ids":    `{"ids":[],"done":true}`,
		"no fields": `{"ids":["` + uuid.NewString() + `"]}`,
	} {
		recorder := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(recorder)
		context.Request = httptest.NewRequest(http.MethodPatch, "/api/v1/transcription/sessions", strings.NewReader(body))
		context.Request.Header.Set("Content-Type", "application/json")
		setConversationPrincipal(context, uuid.New(), uuid.New())
		app.bulkUpdateTranscriptionSessions(context)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d", name, recorder.Code)
		}
	}
}
