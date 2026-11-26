package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

func TestTranscriptionChatIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	gin.SetMode(gin.TestMode)
	a := &App{DB: db}
	owner, reader, stranger, orgID, sessionID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, q := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'o@example.org', 'O'), ($2, 'r@example.org', 'R'), ($3, 's@example.org', 'S')`, []any{owner, reader, stranger}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		{`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member')`, []any{orgID, owner, reader, stranger}},
		{`INSERT INTO transcription_sessions (id, user_id, organization_id, title, status) VALUES ($1, $2, $3, '113. Sitzung', 'waiting')`, []any{sessionID, owner, orgID}},
		{`INSERT INTO transcription_readers (session_id, user_id, organization_id) VALUES ($1, $2, $3)`, []any{sessionID, reader, orgID}},
		{`INSERT INTO transcription_topics (session_id, topic_key, sort_order, kind, label, title, planned_start_at, starred) VALUES ($1, 'top1', 0, 'TOP', 'TOP I', 'Haushaltsgesetz 2027', '2026-11-27T11:35:00Z', TRUE)`, []any{sessionID}},
	} {
		if _, err := db.ExecContext(ctx, q.query, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	open := func(user uuid.UUID) (int, uuid.UUID) {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPost, "/", nil)
		c.Params = gin.Params{{Key: "id", Value: sessionID.String()}}
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: user})
		c.Set(middleware.OrgIDKey, orgID)
		a.openTranscriptionChat(c)
		var body struct {
			Conversation struct {
				ID uuid.UUID `json:"id"`
			} `json:"conversation"`
		}
		_ = json.Unmarshal(recorder.Body.Bytes(), &body)
		return recorder.Code, body.Conversation.ID
	}
	code, first := open(reader)
	if code != http.StatusCreated || first == uuid.Nil {
		t.Fatalf("first open = %d", code)
	}
	if code, again := open(reader); code != http.StatusOK || again != first {
		t.Fatalf("second open made another chat: %d %s", code, again)
	}
	if code, _ := open(stranger); code != http.StatusNotFound {
		t.Fatalf("a stranger opened the chat: %d", code)
	}

	// Before capture starts, the reader's chat reads the plan instead of failing.
	citations, err := a.selectedTranscriptContext(ctx, first, orgID, reader, []uuid.UUID{sessionID})
	if err != nil || len(citations) != 1 {
		t.Fatalf("context = %v %v", citations, err)
	}
	prompt := citations[0].PromptText
	for _, want := range []string{"not started yet", "TOP I Haushaltsgesetz 2027", "planned 2026-11-27 11:35", "selected by the user", "no transcript text yet"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	// Once lines arrive, the next message sees them.
	if _, err := db.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'live' WHERE id = $1; `, sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO transcription_segments (session_id, text, start_offset_ms, end_offset_ms) VALUES ($1, 'Ich rufe Tagesordnungspunkt I auf.', 1000, 3000)`, sessionID); err != nil {
		t.Fatal(err)
	}
	citations, _ = a.selectedTranscriptContext(ctx, first, orgID, reader, []uuid.UUID{sessionID})
	if !strings.Contains(citations[0].PromptText, "running now") || !strings.Contains(citations[0].PromptText, "Ich rufe Tagesordnungspunkt I auf.") {
		t.Fatalf("live prompt:\n%s", citations[0].PromptText)
	}
}

func TestTranscriptionChatToolsIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	a := &App{DB: db}
	a.Live = &TranscriptionManager{DB: db, app: a}
	owner, reader, orgID, sessionID, speakerID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	ownerChat, readerChat := uuid.New(), uuid.New()
	for _, q := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'o@example.org', 'O'), ($2, 'r@example.org', 'R')`, []any{owner, reader}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		{`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, []any{orgID, owner, reader}},
		{`INSERT INTO transcription_sessions (id, user_id, organization_id, title, status) VALUES ($1, $2, $3, '113. Sitzung', 'live')`, []any{sessionID, owner, orgID}},
		{`INSERT INTO transcription_readers (session_id, user_id, organization_id) VALUES ($1, $2, $3)`, []any{sessionID, reader, orgID}},
		{`INSERT INTO conversations (id, user_id, organization_id) VALUES ($1, $3, $5), ($2, $4, $5)`, []any{ownerChat, readerChat, owner, reader, orgID}},
		{`INSERT INTO conversation_transcription_sessions (conversation_id, session_id, added_by) VALUES ($1, $3, $4), ($2, $3, $5)`, []any{ownerChat, readerChat, sessionID, owner, reader}},
		{`INSERT INTO transcription_topics (session_id, topic_key, sort_order, kind, label, title, starred) VALUES
			($1, 'epl11', 0, 'EPL', 'EPL 11', 'Arbeit und Soziales', FALSE),
			($1, 'epl12', 1, 'EPL', 'EPL 12', 'Verkehr', FALSE),
			($1, 'epl32', 2, 'EPL', 'EPL 32, 60', 'Bundesschuld, Allgemeine Finanzverwaltung', FALSE),
			($1, 'top1', 3, 'TOP', 'TOP I', 'Haushaltsgesetz 2027 (2. Beratung), Finanzplan 2026 bis 2030', TRUE)`, []any{sessionID}},
		{`INSERT INTO transcription_speakers (id, session_id, label) VALUES ($1, $2, 'Speaker 2')`, []any{speakerID, sessionID}},
		{`INSERT INTO transcription_segments (session_id, speaker_id, text, start_offset_ms, end_offset_ms) VALUES ($1, $2, 'Frau Klökner hat das Wort.', 0, 2000), ($1, $2, 'Danke, Frau Präsidentin.', 2000, 4000)`, []any{sessionID, speakerID}},
	} {
		if _, err := db.ExecContext(ctx, q.query, q.args...); err != nil {
			t.Fatal(err)
		}
	}

	raw, err := a.transcriptionEditTool(ctx, owner, orgID, ownerChat, "update_transcription_topics", map[string]any{"select": []any{"EPL 12", "Einzelplan 60"}, "deselect": []any{"TOP I"}})
	if err != nil {
		t.Fatal(err)
	}
	var topics struct {
		Selected []string `json:"selected"`
	}
	_ = json.Unmarshal(raw, &topics)
	if strings.Join(topics.Selected, "|") != "EPL 12 Verkehr|EPL 32, 60 Bundesschuld, Allgemeine Finanzverwaltung" {
		t.Fatalf("selection = %s", raw)
	}
	if _, err := a.transcriptionEditTool(ctx, owner, orgID, ownerChat, "update_transcription_topics", map[string]any{"select": []any{"EPL 99"}}); err == nil {
		t.Fatal("an unknown item was accepted")
	}

	// A reader asks: nothing changes.
	if _, err := a.transcriptionEditTool(ctx, reader, orgID, readerChat, "update_transcription_topics", map[string]any{"select": []any{"EPL 11"}}); err == nil || !strings.Contains(err.Error(), "only the owner") {
		t.Fatalf("a reader changed the selection: %v", err)
	}

	if _, err := a.transcriptionEditTool(ctx, owner, orgID, ownerChat, "rename_transcription_speaker", map[string]any{"speaker": "speaker 2", "name": "Julia Klöckner"}); err != nil {
		t.Fatal(err)
	}
	raw, err = a.transcriptionEditTool(ctx, owner, orgID, ownerChat, "correct_transcript", map[string]any{"find": "Klökner", "replace": "Klöckner"})
	if err != nil || !strings.Contains(string(raw), `"changedLines":1`) {
		t.Fatalf("correct = %s %v", raw, err)
	}
	var name, edited, original string
	_ = db.QueryRowContext(ctx, `SELECT display_name FROM transcription_speakers WHERE id = $1`, speakerID).Scan(&name)
	_ = db.QueryRowContext(ctx, `SELECT edited_text, text FROM transcription_segments WHERE start_offset_ms = 0`).Scan(&edited, &original)
	if name != "Julia Klöckner" || edited != "Frau Klöckner hat das Wort." || original != "Frau Klökner hat das Wort." {
		t.Fatalf("name=%q edited=%q original=%q", name, edited, original)
	}
}
