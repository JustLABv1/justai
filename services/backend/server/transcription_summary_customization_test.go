package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
	"justai-backend/models"
)

func TestSummarySourceExclusions(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	segments := []models.TranscriptionSegment{{ID: a, Text: "Keep decision", StartOffsetMs: 4000}, {ID: b, Text: "Private discussion", StartOffsetMs: 9000}}
	filtered, err := excludeSummarySourceSegments(segments, []string{b.String(), b.String()})
	if err != nil || len(filtered) != 1 || filtered[0].ID != a || filtered[0].StartOffsetMs != 4000 {
		t.Fatalf("unexpected source scope: %+v, %v", filtered, err)
	}
	rows := transcriptionExportRows(filtered, nil)
	for _, chunk := range splitTranscriptionInsightRows(rows) {
		input := buildTranscriptionInsightChunkInput("Meeting", "en", chunk, 1, 1, 15000)
		if strings.Contains(input, "Private discussion") {
			t.Fatal("excluded source reached AI input")
		}
	}
	if len(segments) != 2 {
		t.Fatal("source filtering mutated transcript")
	}
	if _, err := excludeSummarySourceSegments(segments, []string{uuid.NewString()}); err == nil {
		t.Fatal("accepted foreign passage")
	}
	if _, err := excludeSummarySourceSegments(segments, []string{a.String(), b.String()}); err == nil {
		t.Fatal("accepted empty scope")
	}
	if !strings.Contains(summaryCustomInstructions([]string{"Focus on decisions"}), "Focus on decisions") || summaryCustomInstructions(nil) != "" {
		t.Fatal("custom instructions were lost")
	}
}

func TestSummaryExportDraft(t *testing.T) {
	now := time.Now().UTC()
	original := &models.TranscriptionInsights{UpdatedAt: now, Summary: "Original contribution", Chapters: []models.TranscriptionInsightChapter{{Title: "First"}, {Title: "Second"}}, Topics: []string{"A", "B"}, ActionItems: []string{"Do this"}}
	paragraphs := []string{"Edited contribution"}
	chapters, topics, actions := []int{1}, []int{0}, []int{}
	draft := transcriptionSummaryExportDraft{Revision: now.Format(time.RFC3339Nano), Summary: &paragraphs, Chapters: &chapters, Topics: &topics, ActionItems: &actions}
	result, err := applySummaryExportDraft(original, draft)
	if err != nil {
		t.Fatal(err)
	}
	if result.Summary != "Edited contribution" || len(result.Chapters) != 1 || result.Chapters[0].Title != "Second" || len(result.Topics) != 1 || len(result.ActionItems) != 0 {
		t.Fatalf("incorrect export draft: %+v", result)
	}
	if original.Summary != "Original contribution" || len(original.ActionItems) != 1 {
		t.Fatal("export edited stored insights")
	}
	draft.Revision = now.Add(-time.Second).Format(time.RFC3339Nano)
	if _, err := applySummaryExportDraft(original, draft); err == nil {
		t.Fatal("accepted stale draft")
	}
	invalid := []int{-1}
	if _, err := selectSummaryExportItems(original.Topics, &invalid); err == nil {
		t.Fatal("accepted invalid selection")
	}
	duplicate := []int{0, 0}
	if _, err := selectSummaryExportItems(original.Topics, &duplicate); err == nil {
		t.Fatal("accepted duplicate selection")
	}
}

func TestSummaryStandardIsPersonalAndPersistent(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	app := &App{DB: db}
	user := uuid.New()
	standard := transcriptionSummaryStandard{Name: "Decision report", Format: "docx", Instructions: "Omit small talk", Summary: true, ActionItems: true, BoldSpeakers: true}
	data, _ := json.Marshal(standard)
	contextFor := func(method string, body []byte) (*gin.Context, *httptest.ResponseRecorder) {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(method, "/api/v1/profile/transcription-summary-standard", bytes.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: user})
		return c, recorder
	}
	mock.ExpectExec("INSERT INTO transcription_summary_standards").WithArgs(user, string(data)).WillReturnResult(sqlmock.NewResult(0, 1))
	c, w := contextFor("PUT", data)
	app.saveTranscriptionSummaryStandard(c)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	mock.ExpectQuery("SELECT settings FROM transcription_summary_standards WHERE user_id").WithArgs(user).WillReturnRows(sqlmock.NewRows([]string{"settings"}).AddRow(data))
	c, w = contextFor("GET", nil)
	app.getTranscriptionSummaryStandard(c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Omit small talk") {
		t.Fatalf("load: %d %s", w.Code, w.Body.String())
	}
	// Another account cannot load the first user's standard.
	otherUser := uuid.New()
	mock.ExpectQuery("SELECT settings FROM transcription_summary_standards WHERE user_id").WithArgs(otherUser).WillReturnError(sql.ErrNoRows)
	c, w = contextFor("GET", nil)
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: otherUser})
	app.getTranscriptionSummaryStandard(c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"standard":null`) {
		t.Fatalf("other account: %s", w.Body.String())
	}
	mock.ExpectExec("DELETE FROM transcription_summary_standards WHERE user_id").WithArgs(user).WillReturnResult(sqlmock.NewResult(0, 1))
	c, w = contextFor("DELETE", nil)
	app.deleteTranscriptionSummaryStandard(c)
	c.Writer.WriteHeaderNow()
	if w.Code != 204 {
		t.Fatalf("delete: %d", w.Code)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSummarySourceScopeLoadsWithInsights(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	id, omitted := uuid.New(), uuid.NewString()
	customization, _ := json.Marshal(models.TranscriptionSummaryCustomization{Instructions: "Focus on decisions", ExcludedSegmentIDs: []string{omitted}})
	mock.ExpectQuery("SELECT COALESCE").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"duration"}).AddRow(30000))
	mock.ExpectQuery("SELECT language, status, summary").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"language", "status", "summary", "chapters", "topics", "action_items", "error_message", "generated_at", "updated_at", "customization"}).AddRow("en", "completed", "Decision report", []byte(`[]`), []byte(`[]`), []byte(`[]`), nil, time.Now(), time.Now(), customization))
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	result, err := loadTranscriptionInsights(c, db, id)
	if err != nil {
		t.Fatal(err)
	}
	if result.Customization.Instructions != "Focus on decisions" || len(result.Customization.ExcludedSegmentIDs) != 1 || result.Customization.ExcludedSegmentIDs[0] != omitted {
		t.Fatalf("lost source scope: %+v", result.Customization)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
