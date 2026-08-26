package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

func TestRenderGeneratedPDFCreatesValidMultiPageDocument(t *testing.T) {
	content := "# Executive summary\n\nA concise opening paragraph with typographic punctuation — including “quotes” and an ellipsis…\n\n## Recommendations\n\n- Keep the document readable\n- Make the download secure\n\n"
	content += strings.Repeat("## Detailed finding\n\nThis paragraph deliberately repeats enough prose to exercise line wrapping and page breaks in the PDF renderer. It should remain inside the page margins and continue cleanly onto subsequent pages.\n\n", 42)

	data, err := renderGeneratedPDF("JustAI PDF quality check", content)
	if err != nil {
		t.Fatalf("render PDF: %v", err)
	}
	if _, err := validateGeneratedPDF(data); err != nil {
		t.Fatalf("validate PDF: %v", err)
	}
	if pages := countGeneratedPDFPages(data); pages < 2 {
		t.Fatalf("expected a multi-page PDF, got %d page(s)", pages)
	}
	if output := os.Getenv("JUSTAI_PDF_QA_OUTPUT"); output != "" {
		if err := os.WriteFile(output, data, 0o600); err != nil {
			t.Fatalf("write visual QA PDF: %v", err)
		}
	}
}

func TestRenderGeneratedPDFWrapsLongDocumentTitle(t *testing.T) {
	title := strings.Repeat("Long document title ", 8)
	data, err := renderGeneratedPDF(title, "# Content\n\nThe body remains below the wrapped title header.")
	if err != nil {
		t.Fatalf("render PDF with long title: %v", err)
	}
	if _, err := validateGeneratedPDF(data); err != nil {
		t.Fatalf("validate PDF with long title: %v", err)
	}
	if output := os.Getenv("JUSTAI_PDF_QA_LONG_TITLE_OUTPUT"); output != "" {
		if err := os.WriteFile(output, data, 0o600); err != nil {
			t.Fatalf("write long-title visual QA PDF: %v", err)
		}
	}
}

func TestRenderGeneratedPDFRendersCommonMarkdownWithoutLeakingSyntax(t *testing.T) {
	content := strings.Join([]string{
		"# 🛡️ Security scan analysis report",
		"",
		"**Generated on:** August 4, 2026  ",
		"**Source:** JustScan Dev / Artifactory Xray",
		"",
		"---",
		"",
		"## 🎯 Executive summary",
		"",
		"The latest scan found a **significant vulnerability density** in the core `python:3.13-slim-bookworm` image.",
		"",
		"## Vulnerability distribution",
		"",
		"| Severity | Count | Action required |",
		"| :--- | ---: | :--- |",
		"| **CRITICAL** | **11** | Immediate patching |",
		"| **HIGH** | **40** | Scheduled update |",
		"| **MEDIUM** | **82** | Review and mitigate |",
		"",
		"---",
		"",
		"## Commands",
		"",
		"```",
		"justscan report --image python:3.13-slim-bookworm",
		"```",
	}, "\n")

	blocks := parseGeneratedPDFBlocks(content)
	hasRule, hasTable, hasCode := false, false, false
	for _, block := range blocks {
		switch block.kind {
		case "rule":
			hasRule = true
		case "table":
			hasTable = len(block.rows) == 4
		case "code":
			hasCode = strings.Contains(block.text, "justscan report")
		}
	}
	if !hasRule || !hasTable || !hasCode {
		t.Fatalf("Markdown blocks not recognized: rule=%v table=%v code=%v", hasRule, hasTable, hasCode)
	}

	data, err := renderGeneratedPDF("Professional Security Scan Analysis", content)
	if err != nil {
		t.Fatalf("render Markdown PDF: %v", err)
	}
	if _, err := validateGeneratedPDF(data); err != nil {
		t.Fatalf("validate Markdown PDF: %v", err)
	}
	if output := os.Getenv("JUSTAI_PDF_QA_MARKDOWN_OUTPUT"); output != "" {
		if err := os.WriteFile(output, data, 0o600); err != nil {
			t.Fatalf("write Markdown visual QA PDF: %v", err)
		}
	}
}

func TestCountGeneratedPDFPagesDoesNotCountPagesTree(t *testing.T) {
	data := []byte("%PDF-1.7\n1 0 obj << /Type /Pages >> endobj\n2 0 obj << /Type /Page >> endobj\nstartxref\n0\n%%EOF")
	if got := countGeneratedPDFPages(data); got != 1 {
		t.Fatalf("expected one page object, got %d", got)
	}
}

func TestValidateGeneratedPDFRejectsCorruptDocuments(t *testing.T) {
	tests := map[string][]byte{
		"empty":            nil,
		"wrong header":     []byte("not a PDF\nstartxref\n0\n%%EOF"),
		"missing crossref": []byte("%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF"),
		"missing EOF":      []byte("%PDF-1.7\n1 0 obj << /Type /Page >> endobj\nstartxref\n0"),
		"pages tree only":  []byte("%PDF-1.7\n1 0 obj << /Type /Pages >> endobj\nstartxref\n0\n%%EOF"),
	}
	for name, data := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := validateGeneratedPDF(data); err == nil {
				t.Fatal("expected corrupt PDF to be rejected")
			}
		})
	}
}

func TestGeneratedPDFArgumentsAndFilenameAreBounded(t *testing.T) {
	content, title, filename, err := parseGeneratedPDFArguments(map[string]any{
		"content":  "# Quarterly Review\n\nRevenue improved.",
		"filename": "../../Quarterly Review?.PDF",
	})
	if err != nil {
		t.Fatalf("parse arguments: %v", err)
	}
	if content == "" || title != "Quarterly Review" || filename != "Quarterly-Review.pdf" {
		t.Fatalf("unexpected normalized values: content=%q title=%q filename=%q", content, title, filename)
	}
	if _, _, _, err := parseGeneratedPDFArguments(map[string]any{"content": ""}); err == nil {
		t.Fatal("expected empty content to be rejected")
	}
}

func TestCreatePDFBuiltInToolReturnsStableFileResult(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	userID := uuid.New()
	organizationID := uuid.New()
	fileID := uuid.New()
	createdAt := time.Now().UTC()
	mock.ExpectQuery(regexp.QuoteMeta("INSERT INTO generated_pdfs (user_id, organization_id, title, filename, mime_type, size_bytes, pdf_data)")).
		WithArgs(userID, organizationID, "Release Notes", "release-notes.pdf", generatedPDFMimeType, sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "title", "filename", "mime_type", "size_bytes", "created_at"}).
			AddRow(fileID, "Release Notes", "release-notes.pdf", generatedPDFMimeType, int64(2048), createdAt))

	app := &App{DB: database}
	result, err := app.executeBuiltInChatTool(t.Context(), userID, organizationID, uuid.New(), "create_pdf", map[string]any{
		"title":    "Release Notes",
		"filename": "release-notes.pdf",
		"content":  "# Release Notes\n\n- PDF generation is available.",
	}, nil)
	if err != nil {
		t.Fatalf("execute create_pdf: %v", err)
	}
	var decoded struct {
		File struct {
			ID       uuid.UUID `json:"id"`
			URL      string    `json:"url"`
			Filename string    `json:"filename"`
			MimeType string    `json:"mimeType"`
			Size     int64     `json:"size"`
		} `json:"file"`
	}
	if err := json.Unmarshal(result, &decoded); err != nil {
		t.Fatalf("decode tool result: %v", err)
	}
	if decoded.File.ID != fileID || decoded.File.URL != "/api/v1/pdfs/"+fileID.String() || decoded.File.Filename != "release-notes.pdf" || decoded.File.MimeType != generatedPDFMimeType || decoded.File.Size != 2048 {
		t.Fatalf("unexpected file result: %+v", decoded.File)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestServeGeneratedPDFScopesDownloadAndSetsSafeHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	data, err := renderGeneratedPDF("Scoped report", "# Scoped report\n\nPrivate workspace content.")
	if err != nil {
		t.Fatal(err)
	}
	userID := uuid.New()
	organizationID := uuid.New()
	fileID := uuid.New()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT pdf_data, filename FROM generated_pdfs WHERE id = $1 AND user_id = $2 AND organization_id = $3")).
		WithArgs(fileID, userID, organizationID).
		WillReturnRows(sqlmock.NewRows([]string{"pdf_data", "filename"}).AddRow(data, "report\r\nInjected.pdf"))

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/pdfs/"+fileID.String(), nil)
	context.Params = gin.Params{{Key: "id", Value: fileID.String()}}
	context.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
	context.Set(middleware.OrgIDKey, organizationID)

	(&App{DB: database}).serveGeneratedPDF(context)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, generatedPDFMimeType) {
		t.Fatalf("unexpected content type %q", got)
	}
	if got := recorder.Header().Get("Content-Disposition"); got != "attachment; filename=report-Injected.pdf" {
		t.Fatalf("unexpected content disposition %q", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("missing nosniff header: %q", got)
	}
	if recorder.Body.Len() != len(data) {
		t.Fatalf("unexpected response size: got %d want %d", recorder.Body.Len(), len(data))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestServeGeneratedPDFDoesNotCrossWorkspaceScope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	fileID := uuid.New()
	storedUserID := uuid.New()
	storedOrganizationID := uuid.New()
	tests := []struct {
		name          string
		requestUserID uuid.UUID
		requestOrgID  uuid.UUID
	}{
		{name: "wrong user", requestUserID: uuid.New(), requestOrgID: storedOrganizationID},
		{name: "wrong organization", requestUserID: storedUserID, requestOrgID: uuid.New()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			database, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()

			mock.ExpectQuery(regexp.QuoteMeta("SELECT pdf_data, filename FROM generated_pdfs WHERE id = $1 AND user_id = $2 AND organization_id = $3")).
				WithArgs(fileID, test.requestUserID, test.requestOrgID).
				WillReturnError(sql.ErrNoRows)

			recorder := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(recorder)
			context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/pdfs/"+fileID.String(), nil)
			context.Params = gin.Params{{Key: "id", Value: fileID.String()}}
			context.Set(middleware.PrincipalKey, middleware.Principal{UserID: test.requestUserID})
			context.Set(middleware.OrgIDKey, test.requestOrgID)

			(&App{DB: database}).serveGeneratedPDF(context)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("expected 404, got %d: %s", recorder.Code, recorder.Body.String())
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestParseAssistantBuiltinActionRecognizesCreatePDF(t *testing.T) {
	toolName, arguments, ok := parseAssistantBuiltinAction(`{"action":"create_pdf","action_input":{"content":"# Report\\n\\nComplete text","filename":"report.pdf"}}`)
	if !ok || toolName != "create_pdf" || stringToolArgument(arguments, "content") == "" {
		t.Fatalf("unexpected fallback parse: ok=%v tool=%q arguments=%v", ok, toolName, arguments)
	}
}
