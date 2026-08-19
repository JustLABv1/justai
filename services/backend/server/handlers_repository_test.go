package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"

	"justai-backend/middleware"
	"justai-backend/models"
)

func TestAttachUserRepositoriesOnlyCreatesConversationMappings(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	conversationID := uuid.New()
	userID := uuid.New()
	mock.ExpectExec("INSERT INTO conversation_repository_contexts").
		WithArgs(conversationID, userID).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectExec("INSERT INTO conversation_knowledge_sources").
		WithArgs(conversationID, userID).
		WillReturnResult(sqlmock.NewResult(0, 200))

	if err := attachUserRepositories(context.Background(), db, conversationID, userID); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestListUserRepositoryContextsReadsThePersistentLibrary(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	gin.SetMode(gin.TestMode)
	app := &App{DB: db}
	userID := uuid.New()
	organizationID := uuid.New()
	repositoryID := uuid.New()
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT rc.id, rc.conversation_id, rc.scope_type")).
		WithArgs(userID).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "conversation_id", "scope_type", "scope_id", "provider",
			"repository_url", "owner", "repository", "ref", "resolved_ref",
			"title", "context_scope", "status", "error", "file_count",
			"ready_file_count", "skipped_file_count", "total_bytes", "progress",
			"created_at", "updated_at",
		}).AddRow(
			repositoryID, nil, "user", userID, "github",
			"https://github.com/example/project", "example", "project", "HEAD", "main",
			"example/project", "persistent", "ready", "", 200, 200, 872, int64(4096), 100,
			now, now,
		))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/repositories", nil)
	context, _ := gin.CreateTestContext(recorder)
	context.Request = request
	context.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
	context.Set(middleware.OrgIDKey, organizationID)

	app.listUserRepositoryContexts(context)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Repositories []models.RepositoryContext `json:"repositories"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Repositories) != 1 || response.Repositories[0].ID != repositoryID {
		t.Fatalf("expected one persistent repository, got %+v", response.Repositories)
	}
	if response.Repositories[0].ConversationID != nil {
		t.Fatalf("expected a library repository without a conversation id")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRepositoryFailureMessageKeepsStorageErrorsActionable(t *testing.T) {
	tests := []struct {
		name      string
		operation string
		cause     error
		contains  string
	}{
		{
			name:      "missing migration table",
			operation: "store repository file metadata",
			cause:     &pq.Error{Code: "42P01"},
			contains:  "Restart the backend",
		},
		{
			name:      "duplicate path",
			operation: "store repository file metadata",
			cause:     &pq.Error{Code: "23505"},
			contains:  "duplicate file metadata",
		},
		{
			name:      "unknown storage error",
			operation: "store repository file metadata",
			cause:     errors.New("database unavailable"),
			contains:  "Check the backend logs",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := repositoryFailureMessage(test.operation, test.cause)
			if !strings.Contains(message, test.contains) {
				t.Fatalf("expected %q to contain %q", message, test.contains)
			}
		})
	}
}
