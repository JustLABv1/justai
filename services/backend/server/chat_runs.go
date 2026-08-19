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
	var streamStatus string
	if err := a.DB.QueryRowContext(ctx, `
		SELECT run.id, run.status, COALESCE((
			SELECT stream.status
			FROM chat_streams stream
			WHERE stream.run_id = run.id
			ORDER BY stream.created_at DESC
			LIMIT 1
		), '')
		FROM chat_runs run
		WHERE run.conversation_id = $1 AND run.client_request_id = $2
	`, conversationID, requestID).Scan(&existingID, &status, &streamStatus); err != nil {
		return uuid.Nil, false, err
	}
	// The stream is the durable source of truth for requests that made it far
	// enough to send an SSE response. Reconcile a run left at "running" when a
	// process restart or a failed status write happened after its stream had
	// already reached a terminal state. This prevents a dead stream from making
	// the request id return conflicts forever.
	if status == "running" && isTerminalChatStreamStatus(streamStatus) {
		result, err := a.DB.ExecContext(ctx, `
			UPDATE chat_runs
			SET status = $2, finished_at = COALESCE(finished_at, now())
			WHERE id = $1 AND status = 'running'
		`, existingID, streamStatus)
		if err != nil {
			return uuid.Nil, false, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return uuid.Nil, false, err
		}
		if affected > 0 {
			status = streamStatus
		} else if err := a.DB.QueryRowContext(ctx, `SELECT status FROM chat_runs WHERE id = $1`, existingID).Scan(&status); err != nil {
			return uuid.Nil, false, err
		}
	}
	// A failed, cancelled, or incomplete request can be retried with the same
	// client id. Reopening the existing row preserves idempotency for concurrent
	// submissions while allowing the user to recover from a transient provider
	// or MCP failure without receiving a permanent duplicate-run conflict.
	if status == "error" || status == "cancelled" || status == "incomplete" {
		result, err := a.DB.ExecContext(ctx, `
			UPDATE chat_runs
			SET status = 'running', started_at = now(), first_token_at = NULL,
			    finished_at = NULL, input_tokens = NULL, output_tokens = NULL,
			    total_tokens = NULL, tool_call_count = 0, error_message = NULL,
			    user_id = $2, organization_id = $3, endpoint_id = $4, model = $5
			WHERE id = $1 AND status IN ('error', 'cancelled', 'incomplete')
		`, existingID, userID, organizationID, endpointID, model)
		if err != nil {
			return uuid.Nil, false, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return uuid.Nil, false, err
		}
		if affected > 0 {
			return existingID, false, nil
		}

		// Another retry won the conditional update. Read the current status so
		// the caller treats it as a duplicate instead of starting a second run.
		if err := a.DB.QueryRowContext(ctx, `SELECT status FROM chat_runs WHERE id = $1`, existingID).Scan(&status); err != nil {
			return uuid.Nil, false, err
		}
	}
	return existingID, true, nil
}

func isTerminalChatStreamStatus(status string) bool {
	switch status {
	case "complete", "requires-action", "error", "cancelled":
		return true
	default:
		return false
	}
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
