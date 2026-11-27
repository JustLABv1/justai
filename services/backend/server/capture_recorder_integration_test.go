package server

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"justai-backend/config"
	"justai-backend/security"
)

// A meeting bot uploads no recording itself; the backend records it, aligned with the
// transcript's offsets, so speaker separation works after the session.
func TestMeetingBotCaptureIsRecordedIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	cfg := config.Config{Transcription: config.TranscriptionConfig{StorageDriver: "local", LocalStoragePath: t.TempDir(), AudioRetentionDays: 1}}
	m := NewTranscriptionManager(cfg, db, security.NewSecretBox(bytes.Repeat([]byte{4}, 32)))

	userID, orgID, sessionID := uuid.New(), uuid.New(), uuid.New()
	botID, micID := uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'ada@example.com', 'Ada')`, []any{userID}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		{`INSERT INTO transcription_sessions (id, user_id, organization_id, title, status, record_audio) VALUES ($1, $2, $3, 'Besprechung', 'live', TRUE)`, []any{sessionID, userID, orgID}},
		{`INSERT INTO transcription_sources (id, session_id, name, kind) VALUES ($1, $3, 'Bot', 'meeting-bot'), ($2, $3, 'Mic', 'microphone')`, []any{botID, micID, sessionID}},
	} {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if m.newCaptureRecorder(ctx, sessionID, micID) != nil {
		t.Fatal("browser sources upload their own recording")
	}

	// Another source's first frame arrived half a second before the bot's.
	m.captureOffset(sessionID, micID, time.Now().UnixMilli())
	time.Sleep(500 * time.Millisecond)
	now := time.Now().UnixMilli()
	recorder := m.newCaptureRecorder(ctx, sessionID, botID)
	if recorder == nil {
		t.Fatal("a meeting bot of a recording session must be recorded")
	}
	tone := bytes.Repeat([]byte{0x10, 0x20}, 1600) // 100 ms
	for i := range 30 {
		recorder.write(tone, now+int64(i*100))
	}
	recorder.silence(3200, now+3000) // 100 ms while paused
	recorder.close()

	recordings, err := loadTranscriptionRecordings(ctx, db, sessionID)
	if err != nil || len(recordings) != 1 || recordings[0].SourceID != botID || recordings[0].CompletedAt == nil {
		t.Fatalf("recordings = %+v, %v", recordings, err)
	}
	var pcm bytes.Buffer
	if _, err := m.decodeRecordingPCM(ctx, recordings[0].ID, &pcm); err != nil {
		t.Fatal(err)
	}
	// About 500 ms of padding, 3 s of audio, 100 ms of silence (16 kHz PCM16: 32 bytes/ms).
	padding := pcm.Len() - 30*len(tone) - 3200
	if padding < 400*32 || padding > 700*32 || padding%2 != 0 {
		t.Fatalf("padding = %d bytes (%d ms), want about 500 ms", padding, padding/32)
	}
	if !bytes.Equal(pcm.Bytes()[padding:padding+len(tone)], tone) || !bytes.Equal(pcm.Bytes()[pcm.Len()-3200:], make([]byte, 3200)) {
		t.Fatal("recorded audio does not match what was written")
	}
}
