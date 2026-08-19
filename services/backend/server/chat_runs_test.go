package server

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
)

func TestStartChatRunReopensRetryableTerminalRun(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{DB: db}
	requestID := "approval:assistant-message"
	conversationID := uuid.New()
	userID := uuid.New()
	organizationID := uuid.New()
	endpointID := uuid.New()
	existingID := uuid.New()

	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO chat_runs (id, client_request_id, conversation_id, user_id, organization_id, endpoint_id, model)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (conversation_id, client_request_id) DO NOTHING
	`)).WithArgs(sqlmock.AnyArg(), requestID, conversationID, userID, organizationID, endpointID, "kairos").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT run.id, run.status, COALESCE`).
		WithArgs(conversationID, requestID).
		WillReturnRows(sqlmock.NewRows([]string{"id", "status", "stream_status"}).AddRow(existingID, "error", "error"))
	mock.ExpectExec(regexp.QuoteMeta(`
			UPDATE chat_runs
			SET status = 'running', started_at = now(), first_token_at = NULL,
			    finished_at = NULL, input_tokens = NULL, output_tokens = NULL,
			    total_tokens = NULL, tool_call_count = 0, error_message = NULL,
			    user_id = $2, organization_id = $3, endpoint_id = $4, model = $5
			WHERE id = $1 AND status IN ('error', 'cancelled', 'incomplete')
		`)).WithArgs(existingID, userID, organizationID, endpointID, "kairos").
		WillReturnResult(sqlmock.NewResult(0, 1))

	gotID, duplicate, err := app.startChatRun(t.Context(), requestID, conversationID, userID, organizationID, endpointID, "kairos")
	if err != nil {
		t.Fatal(err)
	}
	if gotID != existingID || duplicate {
		t.Fatalf("expected retryable run %s to be reopened, got %s duplicate=%v", existingID, gotID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestStartChatRunKeepsActiveDuplicateBlocked(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{DB: db}
	requestID := "turn:user-message"
	conversationID := uuid.New()
	userID := uuid.New()
	organizationID := uuid.New()
	endpointID := uuid.New()
	existingID := uuid.New()

	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO chat_runs (id, client_request_id, conversation_id, user_id, organization_id, endpoint_id, model)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (conversation_id, client_request_id) DO NOTHING
	`)).WithArgs(sqlmock.AnyArg(), requestID, conversationID, userID, organizationID, endpointID, "kairos").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT run.id, run.status, COALESCE`).
		WithArgs(conversationID, requestID).
		WillReturnRows(sqlmock.NewRows([]string{"id", "status", "stream_status"}).AddRow(existingID, "running", "streaming"))

	gotID, duplicate, err := app.startChatRun(t.Context(), requestID, conversationID, userID, organizationID, endpointID, "kairos")
	if err != nil {
		t.Fatal(err)
	}
	if gotID != existingID || !duplicate {
		t.Fatalf("expected active run %s to remain a duplicate, got %s duplicate=%v", existingID, gotID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestStartChatRunReconcilesTerminalStream(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{DB: db}
	requestID := "approval:assistant-message:approval-1"
	conversationID := uuid.New()
	userID := uuid.New()
	organizationID := uuid.New()
	endpointID := uuid.New()
	existingID := uuid.New()

	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO chat_runs (id, client_request_id, conversation_id, user_id, organization_id, endpoint_id, model)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (conversation_id, client_request_id) DO NOTHING
	`)).WithArgs(sqlmock.AnyArg(), requestID, conversationID, userID, organizationID, endpointID, "kairos").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT run.id, run.status, COALESCE`).
		WithArgs(conversationID, requestID).
		WillReturnRows(sqlmock.NewRows([]string{"id", "status", "stream_status"}).AddRow(existingID, "running", "requires-action"))
	mock.ExpectExec(`UPDATE chat_runs\s+SET status = \$2, finished_at = COALESCE`).
		WithArgs(existingID, "requires-action").
		WillReturnResult(sqlmock.NewResult(0, 1))

	gotID, duplicate, err := app.startChatRun(t.Context(), requestID, conversationID, userID, organizationID, endpointID, "kairos")
	if err != nil {
		t.Fatal(err)
	}
	if gotID != existingID || !duplicate {
		t.Fatalf("expected reconciled requires-action run %s to remain idempotent, got %s duplicate=%v", existingID, gotID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
