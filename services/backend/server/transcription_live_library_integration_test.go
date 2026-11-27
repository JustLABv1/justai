package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

func TestLiveLibraryDescribesSessionsIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	a := &App{DB: db}
	userID, orgID := uuid.New(), uuid.New()
	meeting, quiet, stream := uuid.New(), uuid.New(), uuid.New()
	speakerA, speakerB, merged := uuid.New(), uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'ada@example.com', 'Ada')`, []any{userID}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		{`INSERT INTO transcription_sessions (id, user_id, organization_id, title, status, created_at) VALUES
			($1, $4, $5, 'Besprechung 27.11.', 'completed', now()),
			($2, $4, $5, 'Aufnahme 27.11.', 'completed', now() - interval '1 hour'),
			($3, $4, $5, 'Bundestag', 'completed', now() - interval '1 day')`, []any{meeting, quiet, stream, userID, orgID}},
		{`INSERT INTO transcription_sources (session_id, name, kind) VALUES ($1, 'Cisco Meeting Server', 'meeting-bot'), ($2, 'Dieser Laptop', 'browser'), ($3, 'Bundestag', 'stream')`, []any{meeting, quiet, stream}},
		{`INSERT INTO transcription_speakers (id, session_id, label) VALUES ($1, $4, 'A'), ($2, $4, 'B'), ($3, $4, 'C')`, []any{speakerA, speakerB, merged, meeting}},
		{`UPDATE transcription_speakers SET merged_into = $1 WHERE id = $2`, []any{speakerB, merged}},
		{`INSERT INTO transcription_segments (session_id, speaker_id, text, start_offset_ms, end_offset_ms) VALUES
			($1, $2, 'Hallo zusammen', 0, 1000), ($1, $3, 'Guten Tag', 1000, 2000), ($1, $4, 'Noch einmal', 2000, 3000)`, []any{meeting, speakerA, speakerB, merged}},
		{`INSERT INTO transcription_segments (session_id, text, edited_text, start_offset_ms, end_offset_ms) VALUES ($1, 'test eins', 'Test eins.', 0, 1000), ($1, 'Test zwei.', '', 1000, 2000)`, []any{quiet}},
		{`INSERT INTO transcription_insights (session_id, status, summary) VALUES ($1, 'completed', '## Überblick' || chr(10) || '- Das Team testet den **Meeting-Bot**.')`, []any{meeting}},
	} {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	type page struct {
		Items  []videoTranscriptionLibraryItem `json:"items"`
		Counts map[string]int                  `json:"counts"`
	}
	list := func(query string) page {
		t.Helper()
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodGet, "/?"+query, nil)
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
		c.Set(middleware.OrgIDKey, orgID)
		a.listLiveTranscriptionLibrary(c)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", query, recorder.Code, recorder.Body)
		}
		var result page
		_ = json.Unmarshal(recorder.Body.Bytes(), &result)
		return result
	}

	all := list("")
	if len(all.Items) != 3 || all.Counts["meetings"] != 2 || all.Counts["streams"] != 1 {
		t.Fatalf("all: %d items, counts %v", len(all.Items), all.Counts)
	}
	byID := map[uuid.UUID]videoTranscriptionLibraryItem{}
	for _, item := range all.Items {
		byID[item.ID] = item
	}
	if got := byID[meeting]; got.Excerpt != "Das Team testet den Meeting-Bot." || got.SpeakerCount != 2 {
		t.Fatalf("meeting: excerpt %q, %d speakers (a merged speaker counts once)", got.Excerpt, got.SpeakerCount)
	}
	if got := byID[quiet]; got.Excerpt != "Test eins. Test zwei." || got.SpeakerCount != 0 {
		t.Fatalf("without summary: excerpt %q, %d speakers", got.Excerpt, got.SpeakerCount)
	}

	meetings := list("source=meetings")
	if len(meetings.Items) != 2 || meetings.Counts["all"] != 2 || meetings.Counts["streams"] != 1 {
		t.Fatalf("meetings: %d items, counts %v", len(meetings.Items), meetings.Counts)
	}
	if streams := list("source=streams"); len(streams.Items) != 1 || streams.Items[0].ID != stream {
		t.Fatalf("streams: %+v", streams.Items)
	}
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/?source=podcasts", nil)
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
	c.Set(middleware.OrgIDKey, orgID)
	a.listLiveTranscriptionLibrary(c)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unknown source filter: %d", recorder.Code)
	}
}
