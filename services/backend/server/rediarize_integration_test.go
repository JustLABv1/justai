package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

func TestSpeakersCanBeSeparatedAgainIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	a := &App{DB: db}
	a.Live = &TranscriptionManager{DB: db, app: a}

	userID, orgID, sessionID, sourceID, endpointID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	speakerA, speakerB := uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'ada@example.com', 'Ada')`, []any{userID}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		{`INSERT INTO endpoint_settings (id, scope_type, provider_type, name, base_url) VALUES ($1, 'global', 'openai-compatible', 'Diarization', 'http://diarizer:8000')`, []any{endpointID}},
		{`INSERT INTO transcription_sessions (id, user_id, organization_id, title, status, record_audio, diarization_endpoint_id, started_at, ended_at) VALUES ($1, $2, $3, 'Besprechung', 'completed', TRUE, $4, now() - interval '1 minute', now())`, []any{sessionID, userID, orgID, endpointID}},
		{`INSERT INTO transcription_sources (id, session_id, name, kind) VALUES ($1, $2, 'Bot', 'meeting-bot')`, []any{sourceID, sessionID}},
		{`INSERT INTO transcription_speakers (id, session_id, label, display_name, name_source) VALUES ($1, $3, 'Source 1 · SPEAKER_00', 'Justin', 'manual'), ($2, $3, 'Source 1 · SPEAKER_01', '', '')`, []any{speakerA, speakerB, sessionID}},
		{`INSERT INTO transcription_segments (session_id, source_id, speaker_id, text, edited_text, start_offset_ms, end_offset_ms) VALUES ($1, $2, $3, 'Hallo', 'Hallo zusammen', 0, 1000), ($1, $2, $4, 'Test', '', 1000, 2000)`, []any{sessionID, sourceID, speakerA, speakerB}},
		{`INSERT INTO transcription_recordings (session_id, source_id, mime_type, storage_driver, storage_key, wrapped_key, bytes, completed_at) VALUES ($1, $2, 'audio/wav', 'local', 'k', 'w', 64044, now())`, []any{sessionID, sourceID}},
		{`INSERT INTO transcription_live_processing (session_id, status, stage, diarization_status, polish_status) VALUES ($1, 'completed', 'completed', 'completed', 'completed')`, []any{sessionID}},
	} {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	rediarize := func() (int, string) {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPost, "/?action=rediarize", nil)
		c.Params = gin.Params{{Key: "id", Value: sessionID.String()}}
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
		c.Set(middleware.OrgIDKey, orgID)
		a.controlLiveProcessing(c)
		var body struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.Unmarshal(recorder.Body.Bytes(), &body)
		return recorder.Code, recorder.Body.String()
	}

	if code, body := rediarize(); code != http.StatusOK {
		t.Fatalf("rediarize: %d %s", code, body)
	}
	var status, stage, diarization, polish string
	if err := db.QueryRowContext(ctx, `SELECT status, stage, diarization_status, polish_status FROM transcription_live_processing WHERE session_id = $1`, sessionID).Scan(&status, &stage, &diarization, &polish); err != nil {
		t.Fatal(err)
	}
	// Queued for the worker; polishing is not repeated.
	if status != "queued" || stage != "diarization" || diarization != "queued" || polish != "completed" {
		t.Fatalf("processing = %s/%s/%s/%s", status, stage, diarization, polish)
	}
	var speakers, assigned int
	var edited string
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM transcription_speakers WHERE session_id = $1`, sessionID).Scan(&speakers)
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FILTER (WHERE speaker_id IS NOT NULL), max(edited_text) FROM transcription_segments WHERE session_id = $1`, sessionID).Scan(&assigned, &edited)
	if speakers != 0 || assigned != 0 || edited != "Hallo zusammen" {
		t.Fatalf("speakers %d, assigned segments %d, edited text %q", speakers, assigned, edited)
	}

	// While it waits or runs, it cannot be started again.
	if code, _ := rediarize(); code != http.StatusConflict {
		t.Fatalf("second rediarize while queued: %d", code)
	}
	// Without a recording there is nothing to separate.
	_, _ = db.ExecContext(ctx, `UPDATE transcription_live_processing SET status = 'completed' WHERE session_id = $1`, sessionID)
	_, _ = db.ExecContext(ctx, `DELETE FROM transcription_recordings WHERE session_id = $1`, sessionID)
	if code, body := rediarize(); code != http.StatusConflict || !bytes.Contains([]byte(body), []byte("no audio recording")) {
		t.Fatalf("rediarize without a recording: %d %s", code, body)
	}
}
