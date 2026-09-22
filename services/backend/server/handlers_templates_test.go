package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"mime/multipart"
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

func TestTemplateProcessorRoundTripAndMissingFields(t *testing.T) {
	inspection, err := runTemplateProcessor(t.Context(), "letter.txt", []byte("Hello {{name}}"), "inspect", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(inspection), `"name"`) {
		t.Fatalf("missing placeholder: %s", inspection)
	}
	_, err = runTemplateProcessor(t.Context(), "letter.txt", []byte("Hello {{name}}"), "render", map[string]any{"values": map[string]any{"wrong": "Ada"}})
	if err == nil {
		t.Fatal("unknown fields accepted")
	}
}

func TestTemplateToolScopesReadsAndRejectsStaleRevision(t *testing.T) {
	for _, test := range []struct {
		name     string
		revision float64
		missing  bool
	}{{"stale", 1, false}, {"missing", 2, true}, {"fill", 2, false}} {
		t.Run(test.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			user, org, id := uuid.New(), uuid.New(), uuid.New()
			expectation := mock.ExpectQuery(regexp.QuoteMeta("FROM document_templates WHERE id=$1 AND user_id=$2 AND organization_id=$3")).WithArgs(id, user, org)
			if test.missing {
				expectation.WillReturnError(sql.ErrNoRows)
			} else {
				expectation.WillReturnRows(sqlmock.NewRows([]string{"id", "name", "instructions", "filename", "mime_type", "revision", "inspection", "updated_at", "file_data"}).AddRow(id, "Letter", "Ask for name", "letter.txt", "text/plain", 2, []byte(`{"mode":"editable"}`), time.Now(), []byte("Hello {{name}}")))
			}
			_, artifact, err := (&App{DB: db}).templateTool(t.Context(), user, org, "fill_template", map[string]any{"templateId": id.String(), "revision": test.revision, "values": map[string]any{"name": "Ada"}})
			if test.name == "fill" {
				if err != nil {
					t.Fatal(err)
				}
				if string(artifact.Content) != "Hello Ada" || artifact.Name != "letter-filled.txt" {
					t.Fatalf("wrong output: %+v", artifact)
				}
			} else if err == nil {
				t.Fatal("expected inaccessible or stale template to fail")
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTemplateDownloadIsScopedAndAttachmentOnly(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, org, id := uuid.New(), uuid.New(), uuid.New()
	mock.ExpectQuery("FROM document_templates WHERE id=\\$1 AND user_id=\\$2 AND organization_id=\\$3").WithArgs(id, user, org).WillReturnRows(sqlmock.NewRows([]string{"id", "name", "instructions", "filename", "mime_type", "revision", "inspection", "updated_at", "file_data"}).AddRow(id, "Report", "", "report.html", "text/html", 1, []byte(`{}`), time.Now(), []byte("<script>alert(1)</script>")))
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: user})
		c.Set(middleware.OrgIDKey, org)
		c.Next()
	})
	router.GET("/templates/:id/file", (&App{DB: db}).getDocumentTemplate)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest("GET", "/templates/"+id.String()+"/file", nil))
	if recorder.Code != 200 {
		t.Fatalf("download failed %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.HasPrefix(recorder.Header().Get("Content-Disposition"), "attachment;") || recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("unsafe headers: %v", recorder.Header())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestTemplateToolsAreDiscoverable(t *testing.T) {
	discovery := assistantBuiltInToolDiscovery()
	for _, name := range []string{"list_templates", "read_template", "fill_template"} {
		b, ok := discovery.Bindings[name]
		if !ok || !b.Builtin || !isAssistantBuiltInToolName(name) || !json.Valid(b.Definition.Parameters) {
			t.Fatalf("missing tool %s", name)
		}
	}
}

func TestReadAttachmentUsesScopedOrderedPages(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, org, conversation, source := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	mock.ExpectQuery(regexp.QuoteMeta(`substring(COALESCE(ks.content,'') FROM $5 FOR 16000)`)).WithArgs(conversation, user, org, source, 16001).WillReturnRows(sqlmock.NewRows([]string{"title", "mime", "status", "length", "content"}).AddRow("Receipt", "application/pdf", "ready", 32001, "second page"))
	result, err := (&App{DB: db}).readAttachmentTool(t.Context(), user, org, conversation, "read_attachment", map[string]any{"sourceId": source.String(), "offset": float64(16000)})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(result), `"nextOffset":32000`) {
		t.Fatalf("missing continuation: %s", result)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestTemplateUploadStoresOriginalAndInspection(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, org, id := uuid.New(), uuid.New(), uuid.New()
	original := []byte("Hello {{name}}")
	mock.ExpectQuery(regexp.QuoteMeta("INSERT INTO document_templates (user_id,organization_id,name,instructions,filename,mime_type,file_data,inspection)")).WithArgs(user, org, "Letter", "Ask for name", "letter.txt", "text/plain", original, sqlmock.AnyArg()).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(id))
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("name", "Letter")
	_ = writer.WriteField("instructions", "Ask for name")
	file, err := writer.CreateFormFile("file", "letter.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write(original)
	_ = writer.Close()
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: user})
		c.Set(middleware.OrgIDKey, org)
		c.Next()
	})
	router.POST("/templates", (&App{DB: db}).saveDocumentTemplate)
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/templates", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	router.ServeHTTP(recorder, req)
	if recorder.Code != 200 {
		t.Fatalf("upload failed: %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), id.String()) {
		t.Fatal("missing saved id")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
