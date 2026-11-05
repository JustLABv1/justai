package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

func summaryTemplateTestContext(method, path string, body any, org, user uuid.UUID, role string) (*gin.Context, *httptest.ResponseRecorder) {
	data, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(method, path, bytes.NewReader(data))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: user})
	c.Set(middleware.OrgIDKey, org)
	c.Set(middleware.OrgRoleKey, role)
	return c, w
}

func TestSummaryTemplatesAreScopedToTeamAndProtectSharedEdits(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	app := &App{DB: db}
	org, user, id := uuid.New(), uuid.New(), uuid.New()
	now := time.Now().UTC()
	settings := transcriptionSummaryTemplateSettings{transcriptionSummaryStandard: transcriptionSummaryStandard{Name: "Plenardebatte", Format: "pdf", Summary: true, Chapters: true}, ExclusionRules: "Nur organisatorische Eröffnungen weglassen. Inhaltliche Aussagen behalten."}
	data, _ := json.Marshal(settings)
	mock.ExpectQuery("INSERT INTO transcription_summary_templates").WithArgs(sqlmock.AnyArg(), org, user, string(data)).WillReturnRows(sqlmock.NewRows([]string{"updated_at"}).AddRow(now))
	c, w := summaryTemplateTestContext("POST", "/", settings, org, user, "member")
	app.saveTranscriptionSummaryTemplate(c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"canEdit":true`) {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	mock.ExpectQuery("FROM transcription_summary_templates WHERE organization_id").WithArgs(org).WillReturnRows(sqlmock.NewRows([]string{"id", "created_by", "settings", "updated_at"}).AddRow(id, user, data, now))
	mock.ExpectQuery("SELECT template_id FROM transcription_summary_template_choices").WithArgs(org, user).WillReturnRows(sqlmock.NewRows([]string{"template_id"}).AddRow(id))
	c, w = summaryTemplateTestContext("GET", "/", nil, org, user, "member")
	app.listTranscriptionSummaryTemplates(c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), id.String()) {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	foreignOrg := uuid.New()
	mock.ExpectQuery("FROM transcription_summary_templates WHERE id").WithArgs(id, foreignOrg).WillReturnError(sql.ErrNoRows)
	c, w = summaryTemplateTestContext("PUT", "/", map[string]string{"templateId": id.String()}, foreignOrg, user, "member")
	app.chooseTranscriptionSummaryTemplate(c)
	if w.Code != 404 {
		t.Fatalf("cross-team choice was accepted: %d", w.Code)
	}
	otherMember := uuid.New()
	body := map[string]any{}
	_ = json.Unmarshal(data, &body)
	body["revision"] = now.Format(time.RFC3339Nano)
	mock.ExpectQuery("UPDATE transcription_summary_templates").WithArgs(id, org, string(data), otherMember, false, now).WillReturnError(sql.ErrNoRows)
	c, w = summaryTemplateTestContext("PUT", "/", body, org, otherMember, "member")
	c.Params = gin.Params{{Key: "templateId", Value: id.String()}}
	app.saveTranscriptionSummaryTemplate(c)
	if w.Code != 409 {
		t.Fatalf("unowned shared edit accepted: %d %s", w.Code, w.Body.String())
	}
	mock.ExpectQuery("UPDATE transcription_summary_templates").WithArgs(id, org, string(data), otherMember, true, now).WillReturnRows(sqlmock.NewRows([]string{"updated_at"}).AddRow(now.Add(time.Second)))
	c, w = summaryTemplateTestContext("PUT", "/", body, org, otherMember, "admin")
	c.Params = gin.Params{{Key: "templateId", Value: id.String()}}
	app.saveTranscriptionSummaryTemplate(c)
	if w.Code != 200 {
		t.Fatalf("admin edit denied: %d %s", w.Code, w.Body.String())
	}
	mock.ExpectExec("DELETE FROM transcription_summary_templates").WithArgs(id, org, otherMember, false).WillReturnResult(sqlmock.NewResult(0, 0))
	c, w = summaryTemplateTestContext("DELETE", "/", nil, org, otherMember, "member")
	c.Params = gin.Params{{Key: "templateId", Value: id.String()}}
	app.deleteTranscriptionSummaryTemplate(c)
	if w.Code != 404 {
		t.Fatalf("unowned delete accepted: %d", w.Code)
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSummaryTemplateValidation(t *testing.T) {
	settings := transcriptionSummaryTemplateSettings{transcriptionSummaryStandard: transcriptionSummaryStandard{Name: "Team", Format: "pdf", Summary: true}}
	if err := validateSummaryTemplate(&settings); err != nil {
		t.Fatal(err)
	}
	settings.ExclusionRules = strings.Repeat("x", 6001)
	if validateSummaryTemplate(&settings) == nil {
		t.Fatal("accepted oversized rules")
	}
	settings.ExclusionRules = ""
	settings.Name = " "
	if validateSummaryTemplate(&settings) == nil {
		t.Fatal("accepted missing name")
	}
}

func TestSummaryOmissionDecisionsPreserveSourcesAndRestorations(t *testing.T) {
	opening, substantive, closing := uuid.New(), uuid.New(), uuid.New()
	rows := []transcriptionExportRow{{SegmentID: opening, Speaker: "Chair", Text: "I open the sitting.", StartOffsetMs: 0, EndOffsetMs: 1000}, {SegmentID: substantive, Speaker: "Chair", Text: "I oppose this policy because it undermines accountability.", StartOffsetMs: 1000, EndOffsetMs: 5000}, {SegmentID: closing, Speaker: "Chair", Text: "The sitting is closed.", StartOffsetMs: 5000, EndOffsetMs: 6000}}
	decisions := []summaryOmissionDecision{{SegmentIDs: []string{opening.String(), closing.String()}, Reason: "Organizational contribution"}}
	kept, audit, err := applySummaryOmissionDecisions(rows, decisions, map[string]bool{opening.String(): true})
	if err != nil {
		t.Fatal(err)
	}
	if len(kept) != 2 || !kept[0].SummaryRequired || kept[1].SegmentID != substantive {
		t.Fatalf("restoration or substantive chair statement was lost: %+v", kept)
	}
	if len(audit) != 1 || audit[0].Text != rows[2].Text || audit[0].SegmentIDs[0] != closing.String() {
		t.Fatalf("audit must use actual source text: %+v", audit)
	}
	if len(rows) != 3 {
		t.Fatal("changed original transcript")
	}
	if _, _, err = applySummaryOmissionDecisions(rows, []summaryOmissionDecision{{SegmentIDs: []string{uuid.NewString()}, Reason: "No"}}, nil); err == nil {
		t.Fatal("accepted fabricated source ID")
	}
	if _, _, err = applySummaryOmissionDecisions(rows, []summaryOmissionDecision{decisions[0], {SegmentIDs: []string{opening.String()}, Reason: "Different reason"}}, nil); err == nil {
		t.Fatal("accepted conflicting exclusion explanations")
	}
	if _, err = validateSummaryRestorations(rows, []string{uuid.NewString()}); err == nil {
		t.Fatal("accepted missing restored source")
	}
}

func TestSummaryOmissionDecisionsDeduplicateIdenticalExclusions(t *testing.T) {
	omitted, retained := uuid.New(), uuid.New()
	rows := []transcriptionExportRow{
		{SegmentID: omitted, Text: "The sitting is open.", EndOffsetMs: 1000},
		{SegmentID: retained, Text: "A substantive contribution.", StartOffsetMs: 1000, EndOffsetMs: 2000},
	}
	for _, restore := range []bool{false, true} {
		t.Run(fmt.Sprint("restore=", restore), func(t *testing.T) {
			decisions := []summaryOmissionDecision{
				{SegmentIDs: []string{omitted.String(), omitted.String()}, Reason: "Procedural"},
				{SegmentIDs: []string{omitted.String()}, Reason: " Procedural "},
			}
			kept, audit, err := applySummaryOmissionDecisions(rows, decisions, map[string]bool{omitted.String(): restore})
			if err != nil {
				t.Fatal(err)
			}
			if restore {
				if len(kept) != 2 || !kept[0].SummaryRequired || len(audit) != 0 {
					t.Fatalf("duplicate exclusions overrode restoration: kept=%+v audit=%+v", kept, audit)
				}
			} else if len(kept) != 1 || kept[0].SegmentID != retained || len(audit) != 1 || len(audit[0].SegmentIDs) != 1 || audit[0].Text != rows[0].Text {
				t.Fatalf("duplicate exclusions changed source or audit: kept=%+v audit=%+v", kept, audit)
			}
		})
	}
}

func TestSummaryTemplatePipelineExcludesProceduralSourceBeforeEveryOutput(t *testing.T) {
	for _, restoreOpening := range []bool{false, true} {
		t.Run(fmt.Sprint("restore=", restoreOpening), func(t *testing.T) {
			opening, substantive, closing := uuid.New(), uuid.New(), uuid.New()
			rows := []transcriptionExportRow{{SegmentID: opening, Speaker: "SPEAKER_01", Text: "I open the sitting and hand over the floor.", EndOffsetMs: 1000}, {SegmentID: substantive, Speaker: "SPEAKER_01", Text: "The proposal threatens democratic accountability.", StartOffsetMs: 1000, EndOffsetMs: 5000}, {SegmentID: closing, Speaker: "SPEAKER_01", Text: "The sitting is closed.", StartOffsetMs: 5000, EndOffsetMs: 6000}}
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload struct {
					Messages []struct {
						Role    string `json:"role"`
						Content string `json:"content"`
					} `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
					return
				}
				requests++
				var response any
				if requests == 1 {
					if !strings.Contains(payload.Messages[0].Content, "A chairperson's substantive statements must be kept") {
						t.Error("missing substantive-content safeguard")
					}
					response = map[string]any{"omissions": []summaryOmissionDecision{{SegmentIDs: []string{opening.String()}, Reason: "Organizational opening"}, {SegmentIDs: []string{closing.String()}, Reason: "Organizational closing"}}}
				} else {
					input := payload.Messages[1].Content
					if strings.Contains(input, rows[2].Text) || (!restoreOpening && strings.Contains(input, rows[0].Text)) {
						t.Error("excluded source reached summary generation")
					}
					if !strings.Contains(input, rows[1].Text) {
						t.Error("substantive statement of the same speaker was excluded")
					}
					if restoreOpening && (!strings.Contains(input, rows[0].Text) || !strings.Contains(input, "EXPLICITLY RESTORED")) {
						t.Error("restored source not marked for inclusion")
					}
					response = transcriptionInsightResponse{Summary: "The chair criticizes the policy.", Chapters: []models.TranscriptionInsightChapter{}, Topics: []string{"Democracy"}, ActionItems: []string{}}
				}
				content, _ := json.Marshal(response)
				event, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": string(content)}}}})
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", event)
			}))
			defer server.Close()
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			app := &App{DB: db}
			sessionID := uuid.New()
			mock.ExpectExec("UPDATE transcription_insights SET customization").WithArgs(sessionID, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectExec("UPDATE transcription_insights SET language").WithArgs(sessionID, "en", "The chair criticizes the policy.", sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
			customization := models.TranscriptionSummaryCustomization{TemplateID: uuid.NewString(), TemplateName: "Plenary", ExclusionRules: "Exclude purely organizational openings and closings; preserve substantive statements."}
			if restoreOpening {
				customization.RestoredSegmentIDs = []string{opening.String()}
			}
			app.runTranscriptionInsights(context.Background(), sessionID, provider.Endpoint{ProviderType: "openai-compatible", BaseURL: server.URL, AllowPrivate: true, ChatModel: "test", TimeoutSeconds: 10}, "Debate", "en", "en", 6000, splitTranscriptionInsightRows(rows), customization)
			if requests != 2 {
				t.Fatalf("expected classification then summary, got %d requests", requests)
			}
			if err = mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
