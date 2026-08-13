package server

import (
	"context"
	"database/sql"
	"time"

	"github.com/google/uuid"

	"justai-backend/provider"
)

func (a *App) startChatRun(ctx context.Context, requestID string, conversationID, userID, organizationID, endpointID uuid.UUID, model string) (uuid.UUID, bool, error) {
	runID := uuid.New()
	result, err := a.DB.ExecContext(ctx, `
		INSERT INTO chat_runs (id, client_request_id, conversation_id, user_id, organization_id, endpoint_id, model)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (conversation_id, client_request_id) DO NOTHING
	`, runID, requestID, conversationID, userID, organizationID, endpointID, model)
	if err != nil {
		return uuid.Nil, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return uuid.Nil, false, err
	}
	if affected > 0 {
		return runID, false, nil
	}
	var existingID uuid.UUID
	var status string
	if err := a.DB.QueryRowContext(ctx, `SELECT id, status FROM chat_runs WHERE conversation_id = $1 AND client_request_id = $2`, conversationID, requestID).Scan(&existingID, &status); err != nil {
		return uuid.Nil, false, err
	}
	return existingID, true, nil
}

func (a *App) markChatRunFirstToken(ctx context.Context, runID uuid.UUID, at time.Time) error {
	if runID == uuid.Nil {
		return nil
	}
	_, err := a.DB.ExecContext(ctx, `UPDATE chat_runs SET first_token_at = COALESCE(first_token_at, $2) WHERE id = $1`, runID, at)
	return err
}

func (a *App) finishChatRun(ctx context.Context, runID uuid.UUID, status string, toolCalls int) error {
	if runID == uuid.Nil {
		return nil
	}
	if status == "" {
		status = "complete"
	}
	_, err := a.DB.ExecContext(ctx, `UPDATE chat_runs SET status = $2, finished_at = now(), tool_call_count = $3 WHERE id = $1`, runID, status, toolCalls)
	return err
}

func (a *App) recordChatRunUsage(ctx context.Context, runID uuid.UUID, usage provider.Usage) error {
	if runID == uuid.Nil {
		return nil
	}
	_, err := a.DB.ExecContext(ctx, `
		UPDATE chat_runs
		SET input_tokens = $2, output_tokens = $3, total_tokens = $4
		WHERE id = $1
	`, runID, usage.InputTokens, usage.OutputTokens, usage.TotalTokens)
	return err
}

func nullableInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}
