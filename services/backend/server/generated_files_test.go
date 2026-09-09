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
)

func TestCreateFileBuiltInToolReturnsScopedCSVResult(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	userID := uuid.New()
	organizationID := uuid.New()
	fileID := uuid.New()
	createdAt := time.Now().UTC()
	mock.ExpectQuery(regexp.QuoteMeta("INSERT INTO generated_chat_files (user_id, organization_id, title, filename, mime_type, size_bytes, file_data)")).
		WithArgs(userID, organizationID, "Revenue", "revenue.csv", "text/csv", sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "title", "filename", "mime_type", "size_bytes", "created_at"}).
			AddRow(fileID, "Revenue", "revenue.csv", "text/csv", int64(28), createdAt))

	result, err := (&App{DB: database}).executeBuiltInChatTool(t.Context(), userID, organizationID, uuid.New(), "create_file", map[string]any{
		"format":   "csv",
		"title":    "Revenue",
		"filename": "revenue.csv",
		"content":  "month,revenue\nJanuary,120\n",
	}, nil)
	if err != nil {
		t.Fatalf("execute create_file: %v", err)
	}
	var decoded struct {
		File struct {
			ID       uuid.UUID `json:"id"`
			URL      string    `json:"url"`
			Filename string    `json:"filename"`
			MimeType string    `json:"mimeType"`
		} `json:"file"`
	}
	if err := json.Unmarshal(result, &decoded); err != nil {
		t.Fatalf("decode tool result: %v", err)
	}
	if decoded.File.ID != fileID || decoded.File.URL != "/api/v1/files/"+fileID.String() || decoded.File.Filename != "revenue.csv" || decoded.File.MimeType != "text/csv" {
		t.Fatalf("unexpected file result: %+v", decoded.File)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestParseCreateFileFallbackAction(t *testing.T) {
	toolName, arguments, ok := parseAssistantBuiltinAction(`{"action":"create_file","action_input":{"format":"csv","content":"month,revenue\\nJanuary,120","filename":"revenue.csv"}}`)
	if !ok || toolName != "create_file" || stringToolArgument(arguments, "format") != "csv" {
		t.Fatalf("unexpected parsed file action: %q %#v", toolName, arguments)
	}
}

func TestServeGeneratedChatFileScopesDownloadAndSetsSafeHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	userID := uuid.New()
	organizationID := uuid.New()
	fileID := uuid.New()
	data := []byte("month,revenue\nJanuary,120\n")
	mock.ExpectQuery(regexp.QuoteMeta("SELECT file_data, filename, mime_type FROM generated_chat_files WHERE id = $1 AND user_id = $2 AND organization_id = $3")).
		WithArgs(fileID, userID, organizationID).
		WillReturnRows(sqlmock.NewRows([]string{"file_data", "filename", "mime_type"}).AddRow(data, "revenue\r\n.csv", "text/csv"))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/files/"+fileID.String(), nil)
	context.Params = gin.Params{{Key: "id", Value: fileID.String()}}
	context.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
	context.Set(middleware.OrgIDKey, organizationID)

	(&App{DB: database}).serveGeneratedChatFile(context)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/csv") {
		t.Fatalf("unexpected content type %q", got)
	}
	if got := recorder.Header().Get("Content-Disposition"); strings.ContainsAny(got, "\r\n") {
		t.Fatalf("unsafe content disposition %q", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("missing nosniff header %q", got)
	}
	if string(recorder.Body.Bytes()) != string(data) {
		t.Fatalf("unexpected file content %q", recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
