package server

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestTopicTranscriptCopiesTheTopicIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	a := &App{DB: db}

	userID, orgID, sessionID, sourceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	speakerA, speakerB, speakerMerged := uuid.New(), uuid.New(), uuid.New()
	topicID, missedID := uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'ada@example.com', 'Ada')`, []any{userID}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		{`INSERT INTO transcription_sessions (id, user_id, organization_id, title, status, started_at) VALUES ($1, $2, $3, '112. Sitzung', 'live', '2026-11-26T09:00:00Z')`, []any{sessionID, userID, orgID}},
		{`INSERT INTO transcription_sources (id, session_id, name, kind) VALUES ($1, $2, 'Bundestag', 'stream')`, []any{sourceID, sessionID}},
		{`INSERT INTO transcription_speakers (id, session_id, label, display_name) VALUES ($1, $3, 'S1', 'Präsidentin'), ($2, $3, 'S2', 'Abgeordneter')`, []any{speakerA, speakerB, sessionID}},
		{`INSERT INTO transcription_speakers (id, session_id, label, merged_into) VALUES ($1, $2, 'S3', $3)`, []any{speakerMerged, sessionID, speakerB}},
		{`INSERT INTO transcription_segments (session_id, source_id, speaker_id, text, start_offset_ms, end_offset_ms) VALUES
			($1, $2, $3, 'before', 1000, 2000),
			($1, $2, $3, 'Ich rufe auf', 10000, 12000),
			($1, $2, $4, 'Rede', 12000, 15000),
			($1, $2, $5, 'Zwischenruf', 15000, 16000),
			($1, $2, $3, 'after', 20000, 21000)`, []any{sessionID, sourceID, speakerA, speakerB, speakerMerged}},
		{`INSERT INTO transcription_topics (id, session_id, source_id, topic_key, title, label, status, started_offset_ms, ended_offset_ms, detected_by) VALUES
			($1, $3, $4, 'epl10', 'Landwirtschaft', 'EPL 10', 'done', 10000, 20000, 'announcement'),
			($2, $3, $4, 'epl17', 'Bildung', 'EPL 17', 'done', NULL, NULL, 'missed')`, []any{topicID, missedID, sessionID, sourceID}},
	} {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := a.syncTopicTranscript(ctx, missedID, false); err != errTopicNotRecorded {
		t.Fatalf("missed topic: err = %v", err)
	}
	copyID, err := a.syncTopicTranscript(ctx, topicID, false)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := a.syncTopicTranscript(ctx, topicID, false); err != nil || again != copyID {
		t.Fatalf("second call made another transcript: %v %v", again, err)
	}

	var title, status string
	var owner uuid.UUID
	if err := db.QueryRowContext(ctx, `SELECT title, status, user_id FROM transcription_sessions WHERE id = $1`, copyID).Scan(&title, &status, &owner); err != nil {
		t.Fatal(err)
	}
	if title != "Landwirtschaft (EPL 10) · 112. Sitzung" || status != "completed" || owner != userID {
		t.Fatalf("copy session = %q %q %v", title, status, owner)
	}
	lines := func() map[string][2]any {
		rows, err := db.QueryContext(ctx, `SELECT s.text, s.start_offset_ms, COALESCE(sp.display_name, '') FROM transcription_segments s LEFT JOIN transcription_speakers sp ON sp.id = s.speaker_id WHERE s.session_id = $1`, copyID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		got := map[string][2]any{}
		for rows.Next() {
			var text, speaker string
			var start int64
			if err := rows.Scan(&text, &start, &speaker); err != nil {
				t.Fatal(err)
			}
			got[text] = [2]any{start, speaker}
		}
		return got
	}
	got := lines()
	want := map[string][2]any{"Ich rufe auf": {int64(0), "Präsidentin"}, "Rede": {int64(2000), "Abgeordneter"}, "Zwischenruf": {int64(5000), "Abgeordneter"}}
	if len(got) != len(want) {
		t.Fatalf("lines = %v", got)
	}
	for text, line := range want {
		if got[text] != line {
			t.Fatalf("line %q = %v, want %v (all %v)", text, got[text], line, got)
		}
	}
	var speakers int
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM transcription_speakers WHERE session_id = $1`, copyID).Scan(&speakers)
	if speakers != 2 {
		t.Fatalf("copied %d speakers, want 2", speakers)
	}

	// Final processing rewrote the sitting: an untouched copy follows it.
	if _, err := db.ExecContext(ctx, `UPDATE transcription_segments SET text = 'Rede (bereinigt)' WHERE session_id = $1 AND text = 'Rede'`, sessionID); err != nil {
		t.Fatal(err)
	}
	a.refreshTopicTranscripts(ctx, sessionID)
	if _, ok := lines()["Rede (bereinigt)"]; !ok {
		t.Fatalf("untouched copy was not refreshed: %v", lines())
	}
	// Once someone edited the copy, it is left alone.
	if _, err := db.ExecContext(ctx, `UPDATE transcription_speakers SET display_name = 'Julia Klöckner', name_source = 'manual', updated_at = now() WHERE session_id = $1 AND display_name = 'Präsidentin'`, copyID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE transcription_segments SET text = 'Rede (neu)' WHERE session_id = $1 AND text = 'Rede (bereinigt)'`, sessionID); err != nil {
		t.Fatal(err)
	}
	a.refreshTopicTranscripts(ctx, sessionID)
	if line := lines()["Ich rufe auf"]; line[1] != "Julia Klöckner" {
		t.Fatalf("edited copy was overwritten: %v", lines())
	}
}
