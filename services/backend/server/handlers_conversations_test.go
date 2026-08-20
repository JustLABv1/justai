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

	"justai-backend/auth"
	"justai-backend/middleware"
	"justai-backend/models"
)

func TestConversationRoutesRequireAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{DB: db, Tokens: auth.NewTokenManager([]byte("test-secret"))}
	router := gin.New()
	router.Use(middleware.RequireAuth(app.Tokens, db))
	router.GET("/api/v1/conversations", app.listConversations)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/conversations", nil)
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", recorder.Code)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateConversationDoesNotInheritRepositoriesByDefault(t *testing.T) {
	app, mock, cleanup := newConversationTestApp(t)
	defer cleanup()

	userID := uuid.New()
	organizationID := uuid.New()
	conversationID := uuid.New()
	createdAt := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO conversations").
		WithArgs(userID, organizationID, nil, nil).
		WillReturnRows(sqlmock.NewRows([]string{"id", "title", "endpoint_id", "created_at", "updated_at"}).
			AddRow(conversationID, defaultConversationTitle, nil, createdAt, createdAt))
	mock.ExpectCommit()

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodPost, "/api/v1/conversations", nil)
	setConversationPrincipal(context, userID, organizationID)
	app.createConversation(context)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", recorder.Code)
	}
	var response struct {
		Conversation models.Conversation `json:"conversation"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Conversation.ID != conversationID {
		t.Fatalf("expected conversation %s, got %s", conversationID, response.Conversation.ID)
	}
	if response.Conversation.EndpointID != nil {
		t.Fatal("expected a nil endpoint id")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateConversationCanSkipRepositoryInheritance(t *testing.T) {
	app, mock, cleanup := newConversationTestApp(t)
	defer cleanup()

	userID := uuid.New()
	organizationID := uuid.New()
	conversationID := uuid.New()
	createdAt := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO conversations").
		WithArgs(userID, organizationID, nil, nil).
		WillReturnRows(sqlmock.NewRows([]string{"id", "title", "endpoint_id", "created_at", "updated_at"}).
			AddRow(conversationID, defaultConversationTitle, nil, createdAt, createdAt))
	mock.ExpectCommit()

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/conversations",
		strings.NewReader(`{"inheritRepositories":false}`),
	)
	context.Request.Header.Set("Content-Type", "application/json")
	setConversationPrincipal(context, userID, organizationID)
	app.createConversation(context)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateConversationCanInheritRepositoryLibraryWhenRequested(t *testing.T) {
	app, mock, cleanup := newConversationTestApp(t)
	defer cleanup()

	userID := uuid.New()
	organizationID := uuid.New()
	conversationID := uuid.New()
	createdAt := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO conversations").
		WithArgs(userID, organizationID, nil, nil).
		WillReturnRows(sqlmock.NewRows([]string{"id", "title", "endpoint_id", "created_at", "updated_at"}).
			AddRow(conversationID, defaultConversationTitle, nil, createdAt, createdAt))
	mock.ExpectExec("INSERT INTO conversation_repository_contexts").
		WithArgs(conversationID, userID).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("INSERT INTO conversation_knowledge_sources").
		WithArgs(conversationID, userID).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/conversations",
		strings.NewReader(`{"inheritRepositories":true}`),
	)
	context.Request.Header.Set("Content-Type", "application/json")
	setConversationPrincipal(context, userID, organizationID)
	app.createConversation(context)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestListConversationsReturnsCountsAndScopesRows(t *testing.T) {
	app, mock, cleanup := newConversationTestApp(t)
	defer cleanup()

	userID := uuid.New()
	organizationID := uuid.New()
	conversationID := uuid.New()
	updatedAt := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	mock.ExpectQuery("SELECT\\s+c\\.id").
		WithArgs(userID, organizationID, 51).
		WillReturnRows(sqlmock.NewRows([]string{"id", "title", "endpoint_id", "assistant_id", "assistant_version_id", "created_at", "updated_at", "archived_at", "message_count"}).
			AddRow(conversationID, "Provider routing", "", "", "", updatedAt, updatedAt, nil, 4))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/conversations", nil)
	setConversationPrincipal(context, userID, organizationID)
	app.listConversations(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}
	var response struct {
		Conversations []models.Conversation `json:"conversations"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Conversations) != 1 || response.Conversations[0].MessageCount != 4 {
		t.Fatalf("unexpected conversation response: %+v", response.Conversations)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateConversationArchiveIsScopedToUserAndOrganization(t *testing.T) {
	app, mock, cleanup := newConversationTestApp(t)
	defer cleanup()

	userID := uuid.New()
	organizationID := uuid.New()
	conversationID := uuid.New()
	mock.ExpectExec("UPDATE conversations").
		WithArgs(conversationID, userID, organizationID, true).
		WillReturnResult(sqlmock.NewResult(0, 1))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodPatch, "/api/v1/conversations/"+conversationID.String(), strings.NewReader(`{"archived":true}`))
	context.Request.Header.Set("Content-Type", "application/json")
	context.Params = gin.Params{{Key: "id", Value: conversationID.String()}}
	setConversationPrincipal(context, userID, organizationID)
	app.updateConversation(context)

	if context.Writer.Status() != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", context.Writer.Status())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteConversationRejectsRowsOutsideScope(t *testing.T) {
	app, mock, cleanup := newConversationTestApp(t)
	defer cleanup()

	userID := uuid.New()
	organizationID := uuid.New()
	conversationID := uuid.New()
	mock.ExpectExec("DELETE FROM conversations").
		WithArgs(conversationID, userID, organizationID).
		WillReturnResult(sqlmock.NewResult(0, 0))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodDelete, "/api/v1/conversations/"+conversationID.String(), nil)
	context.Params = gin.Params{{Key: "id", Value: conversationID.String()}}
	setConversationPrincipal(context, userID, organizationID)
	app.deleteConversation(context)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", recorder.Code)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestListConversationMessagesReturnsChronologicalCitations(t *testing.T) {
	app, mock, cleanup := newConversationTestApp(t)
	defer cleanup()

	userID := uuid.New()
	organizationID := uuid.New()
	conversationID := uuid.New()
	userMessageID := uuid.New()
	assistantMessageID := uuid.New()
	sourceID := uuid.New()
	firstAt := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	secondAt := firstAt.Add(time.Minute)

	mock.ExpectQuery("SELECT EXISTS").
		WithArgs(conversationID, userID, organizationID).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id, role, content, citations, created_at")).
		WithArgs(conversationID).
		WillReturnRows(sqlmock.NewRows([]string{"id", "role", "content", "citations", "created_at"}).
			AddRow(userMessageID, "user", "What is RAG?", []byte(`[]`), firstAt).
			AddRow(assistantMessageID, "assistant", "Retrieval augmented generation.", []byte(`[{"sourceId":"`+sourceID.String()+`","title":"Guide","chunkIndex":1,"snippet":"A guide"}]`), secondAt))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/conversations/"+conversationID.String()+"/messages", nil)
	context.Params = gin.Params{{Key: "id", Value: conversationID.String()}}
	setConversationPrincipal(context, userID, organizationID)
	app.listConversationMessages(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}
	var response struct {
		Messages []models.Message `json:"messages"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Messages) != 2 || response.Messages[0].ID != userMessageID || response.Messages[1].ID != assistantMessageID {
		t.Fatalf("messages were not returned in order: %+v", response.Messages)
	}
	if len(response.Messages[1].Citations) != 1 || response.Messages[1].Citations[0].SourceID != sourceID {
		t.Fatalf("citation was not decoded: %+v", response.Messages[1].Citations)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestListConversationMessagesRejectsOtherUsersConversation(t *testing.T) {
	app, mock, cleanup := newConversationTestApp(t)
	defer cleanup()

	userID := uuid.New()
	organizationID := uuid.New()
	conversationID := uuid.New()
	mock.ExpectQuery("SELECT EXISTS").
		WithArgs(conversationID, userID, organizationID).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/conversations/"+conversationID.String()+"/messages", nil)
	context.Params = gin.Params{{Key: "id", Value: conversationID.String()}}
	setConversationPrincipal(context, userID, organizationID)
	app.listConversationMessages(context)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", recorder.Code)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestConversationTitleNormalizesAndTruncatesPrompt(t *testing.T) {
	if got := conversationTitle("  A\nnew   conversation "); got != "A new conversation" {
		t.Fatalf("unexpected normalized title: %q", got)
	}
	long := "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"
	if got := conversationTitle(long); len([]rune(got)) != 73 {
		t.Fatalf("expected a 72-rune title plus ellipsis, got %d runes", len([]rune(got)))
	}
}

func TestConversationCursorRoundTripsTimestampAndID(t *testing.T) {
	updatedAt := time.Date(2026, 8, 14, 12, 34, 56, 123456789, time.FixedZone("CEST", 2*60*60))
	id := uuid.New()
	cursor := encodeConversationCursor(updatedAt, id)
	decoded, err := decodeConversationCursor(cursor)
	if err != nil {
		t.Fatal(err)
	}
	if !decoded.UpdatedAt.Equal(updatedAt) || decoded.ID != id {
		t.Fatalf("cursor did not round-trip: %+v", decoded)
	}
}

func newConversationTestApp(t *testing.T) (*App, sqlmock.Sqlmock, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	return &App{DB: db}, mock, func() { _ = db.Close() }
}

func setConversationPrincipal(context *gin.Context, userID, organizationID uuid.UUID) {
	context.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
	context.Set(middleware.OrgIDKey, organizationID)
}
