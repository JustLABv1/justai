package server

import (
	"context"
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
	"testing"
	"time"
)

func TestSkipVideoPolishRejectsOtherStages(t *testing.T) {
	for _, stage := range []string{"transcribing", "diarizing", "finalizing"} {
		t.Run(stage, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			manager := &TranscriptionManager{DB: db}
			uploadID, sessionID := uuid.New(), uuid.New()
			mock.ExpectBegin()
			mock.ExpectQuery("SELECT session_id, status, stage, pipeline_steps").WithArgs(uploadID).WillReturnRows(sqlmock.NewRows([]string{"session_id", "status", "stage", "pipeline_steps"}).AddRow(sessionID, "processing", stage, []byte(`[]`)))
			mock.ExpectRollback()
			if _, err := manager.skipVideoPolish(context.Background(), uploadID); err == nil {
				t.Fatal("expected rejection outside polishing")
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSkipVideoPolishDoesNotCancelBeforeCommit(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	manager := &TranscriptionManager{DB: db}
	uploadID, sessionID := uuid.New(), uuid.New()
	cancelled := false
	unregister := manager.registerVideoDiarizationCancel(uploadID, func() { cancelled = true })
	defer unregister()
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT session_id, status, stage, pipeline_steps").WithArgs(uploadID).WillReturnRows(sqlmock.NewRows([]string{"session_id", "status", "stage", "pipeline_steps"}).AddRow(sessionID, "processing", "polishing", []byte(`[]`)))
	mock.ExpectExec("UPDATE transcription_sessions SET grammar_endpoint_id = NULL").WithArgs(sessionID).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE transcription_segments SET polished_text = NULL").WithArgs(sessionID).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE transcription_video_uploads SET pipeline_steps").WithArgs(uploadID, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit().WillReturnError(context.DeadlineExceeded)
	if _, err := manager.skipVideoPolish(context.Background(), uploadID); err == nil {
		t.Fatal("expected commit failure")
	}
	if cancelled {
		t.Fatal("provider was cancelled without durable opt-out")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSkipVideoPolishCommitsBeforeCancellingProvider(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	manager := &TranscriptionManager{DB: db}
	uploadID, sessionID := uuid.New(), uuid.New()
	cancelled := false
	unregister := manager.registerVideoDiarizationCancel(uploadID, func() { cancelled = true })
	defer unregister()
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT session_id, status, stage, pipeline_steps").WithArgs(uploadID).WillReturnRows(sqlmock.NewRows([]string{"session_id", "status", "stage", "pipeline_steps"}).AddRow(sessionID, "processing", "polishing", []byte(`[]`)))
	mock.ExpectExec("UPDATE transcription_sessions SET grammar_endpoint_id = NULL").WithArgs(sessionID).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE transcription_segments SET polished_text = NULL").WithArgs(sessionID).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE transcription_video_uploads SET pipeline_steps").WithArgs(uploadID, videoPipelineStatusMatcher{"grammar": "skipped"}).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	now := time.Now().UTC()
	mock.ExpectQuery("SELECT id, session_id, file_name").WithArgs(uploadID).WillReturnRows(sqlmock.NewRows([]string{"id", "session_id", "file_name", "mime_type", "expected_bytes", "bytes", "part_size", "part_count", "status", "progress", "stage", "duration_ms", "error_message", "created_at", "updated_at", "completed_at", "expires_at", "pipeline_steps"}).AddRow(uploadID, sessionID, "test.mp4", "video/mp4", 100, 100, 100, 1, "processing", 95, "polishing", 1000, "", now, now, nil, now.Add(time.Hour), []byte(`[]`)))
	if _, err := manager.skipVideoPolish(context.Background(), uploadID); err != nil {
		t.Fatal(err)
	}
	if !cancelled {
		t.Fatal("provider request was not cancelled")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
