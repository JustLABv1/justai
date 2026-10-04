package server

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
)

func TestChatTranscriptionReadRequiresOwnership(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, org, session := uuid.New(), uuid.New(), uuid.New()
	mock.ExpectQuery("SELECT transcription_enabled").WillReturnRows(sqlmock.NewRows([]string{"enabled"}).AddRow(true))
	mock.ExpectQuery("SELECT EXISTS").WithArgs(session, user, org).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	_, err = (&App{DB: db}).transcriptionChatTool(context.Background(), user, org, "get_transcription", map[string]any{"sessionId": session.String()})
	if err == nil {
		t.Fatal("expected an inaccessible transcript to be rejected")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestChatTranscriptionReadsCanonicalEditedText(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, org, session := uuid.New(), uuid.New(), uuid.New()
	mock.ExpectQuery("SELECT transcription_enabled").WillReturnRows(sqlmock.NewRows([]string{"enabled"}).AddRow(true))
	mock.ExpectQuery("SELECT EXISTS").WithArgs(session, user, org).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectQuery("SELECT title, status").WithArgs(session).WillReturnRows(sqlmock.NewRows([]string{"title", "status"}).AddRow("Meeting", "completed"))
	mock.ExpectQuery("SELECT COALESCE.*canonical = TRUE ORDER BY start_offset_ms, id").WithArgs(session).WillReturnRows(sqlmock.NewRows([]string{"text"}).AddRow("Corrected transcript"))
	raw, err := (&App{DB: db}).transcriptionChatTool(context.Background(), user, org, "get_transcription", map[string]any{"sessionId": session.String()})
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result["transcript"] != "Corrected transcript\n" || result["status"] != "completed" {
		t.Fatalf("unexpected transcript: %s", raw)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
