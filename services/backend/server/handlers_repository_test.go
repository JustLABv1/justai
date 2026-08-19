package server

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
	"github.com/lib/pq"
)

func TestAttachUserRepositoriesOnlyCreatesConversationMappings(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	conversationID := uuid.New()
	userID := uuid.New()
	mock.ExpectExec("INSERT INTO conversation_repository_contexts").
		WithArgs(conversationID, userID).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectExec("INSERT INTO conversation_knowledge_sources").
		WithArgs(conversationID, userID).
		WillReturnResult(sqlmock.NewResult(0, 200))

	if err := attachUserRepositories(context.Background(), db, conversationID, userID); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRepositoryFailureMessageKeepsStorageErrorsActionable(t *testing.T) {
	tests := []struct {
		name      string
		operation string
		cause     error
		contains  string
	}{
		{
			name:      "missing migration table",
			operation: "store repository file metadata",
			cause:     &pq.Error{Code: "42P01"},
			contains:  "Restart the backend",
		},
		{
			name:      "duplicate path",
			operation: "store repository file metadata",
			cause:     &pq.Error{Code: "23505"},
			contains:  "duplicate file metadata",
		},
		{
			name:      "unknown storage error",
			operation: "store repository file metadata",
			cause:     errors.New("database unavailable"),
			contains:  "Check the backend logs",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := repositoryFailureMessage(test.operation, test.cause)
			if !strings.Contains(message, test.contains) {
				t.Fatalf("expected %q to contain %q", message, test.contains)
			}
		})
	}
}
