package server

import (
	"context"
	"encoding/json"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
)

func TestEnsureConversationPersistsAssistantForEmptyExistingConversation(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	app := &App{DB: db}
	conversationID := uuid.New()
	userID := uuid.New()
	organizationID := uuid.New()
	assistantID := uuid.New()
	assistantVersionID := uuid.New()
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)

	mock.ExpectQuery("SELECT EXISTS").
		WithArgs(conversationID, userID, organizationID).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT EXISTS").
		WithArgs(conversationID).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT a.id, v.id, v.version, a.name, a.description, a.icon, a.visibility")).
		WithArgs(assistantID, organizationID, userID).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "version_id", "version", "name", "description", "icon", "visibility",
			"instructions", "endpoint_id", "model", "use_memory", "deep_context", "created_at", "updated_at",
		}).AddRow(
			assistantID, assistantVersionID, 1, "Meeting Editor", "Edit meeting transcripts", "sparkles", "private",
			"Turn raw transcripts into clear meeting notes.", "", "model", true, false, now, now,
		))
	mock.ExpectExec("UPDATE conversations").
		WithArgs(conversationID, assistantID, assistantVersionID, userID, organizationID).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	got, err := app.ensureConversation(
		context.Background(),
		userID,
		organizationID,
		conversationID.String(),
		assistantID.String(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if got != conversationID {
		t.Fatalf("expected conversation %s, got %s", conversationID, got)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestBuildConversationToolHistoryReconstructsProviderToolSequence(t *testing.T) {
	encode := func(event chatToolEvent) string {
		content, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		return string(content)
	}

	history := buildConversationToolHistory([]storedChatMessage{
		{Role: "user", Content: "Find the setup instructions."},
		{Role: "tool", Content: encode(chatToolEvent{
			Kind:       "mcp_tool",
			Status:     "completed",
			Round:      1,
			ServerName: "Knowledge",
			ToolName:   "search_plain_docs",
			CallID:     "call_1",
			Arguments:  map[string]any{"query": "setup"},
			Result:     `{"content":[{"text":"Use uv sync."}]}`,
		})},
		{Role: "assistant", Content: "Use uv sync."},
		{Role: "user", Content: "What about CI?"},
	})

	if len(history) != 5 {
		t.Fatalf("expected five provider messages, got %d: %+v", len(history), history)
	}
	if history[1].Role != "assistant" || len(history[1].ToolCalls) != 1 {
		t.Fatalf("expected a provider assistant tool call message, got %+v", history[1])
	}
	if history[1].ToolCalls[0].ID != "call_1" || history[1].ToolCalls[0].Name != "search_plain_docs" {
		t.Fatalf("unexpected reconstructed tool call: %+v", history[1].ToolCalls[0])
	}
	if history[2].Role != "tool" || history[2].ToolCallID != "call_1" {
		t.Fatalf("expected the matching provider tool result, got %+v", history[2])
	}
	if history[3].Content != "Use uv sync." || history[4].Content != "What about CI?" {
		t.Fatalf("conversation order was not preserved: %+v", history)
	}
}
