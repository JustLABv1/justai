package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

func (a *App) createChatStream(ctx context.Context, streamID, conversationID, userID, organizationID, runID uuid.UUID) error {
	// Expired chunks are never useful to a reconnecting browser. Prune them at
	// write time so the stream tables remain bounded without a second worker.
	if _, err := a.DB.ExecContext(ctx, `DELETE FROM chat_streams WHERE expires_at < now()`); err != nil {
		return err
	}
	_, err := a.DB.ExecContext(ctx, `
		INSERT INTO chat_streams (id, conversation_id, user_id, organization_id, run_id, expires_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, '')::uuid, now() + INTERVAL '24 hours')
	`, streamID, conversationID, userID, organizationID, nullableChatStreamUUID(runID))
	return err
}

func nullableChatStreamUUID(value uuid.UUID) string {
	if value == uuid.Nil {
		return ""
	}
	return value.String()
}

func (a *App) appendChatStreamChunk(ctx context.Context, streamID uuid.UUID, payload string) error {
	if streamID == uuid.Nil || payload == "" {
		return nil
	}
	_, err := a.DB.ExecContext(ctx, `
		INSERT INTO chat_stream_chunks (stream_id, payload)
		SELECT $1, $2
		WHERE EXISTS (
			SELECT 1 FROM chat_streams
			WHERE id = $1 AND expires_at > now()
		)
	`, streamID, payload)
	return err
}

func (a *App) finishChatStream(ctx context.Context, streamID uuid.UUID, status string) error {
	if streamID == uuid.Nil {
		return nil
	}
	if status == "" {
		status = "complete"
	} else {
		switch status {
		case "complete", "requires-action", "error", "cancelled":
			// valid terminal states
		default:
			status = "error"
		}
	}
	_, err := a.DB.ExecContext(ctx, `
		UPDATE chat_streams
		SET status = $2, finished_at = now(), expires_at = GREATEST(expires_at, now() + INTERVAL '15 minutes')
		WHERE id = $1
	`, streamID, status)
	return err
}

func (a *App) resumeChatStream(c *gin.Context) {
	principal, ok := middleware.GetPrincipal(c)
	if !ok {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("authentication required"))
		return
	}
	organizationID, ok := middleware.GetOrganizationID(c)
	if !ok || organizationID == uuid.Nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("organization context is required"))
		return
	}
	streamID, err := uuid.Parse(c.Param("streamId"))
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("stream not found"))
		return
	}

	var conversationID, ownerID, streamOrganizationID uuid.UUID
	var status string
	if err := a.DB.QueryRowContext(c, `
		SELECT conversation_id, user_id, organization_id, status
		FROM chat_streams
		WHERE id = $1 AND expires_at > now()
	`, streamID).Scan(&conversationID, &ownerID, &streamOrganizationID, &status); err != nil {
		if err == sql.ErrNoRows {
			writeError(c, http.StatusNotFound, fmt.Errorf("stream not found or expired"))
			return
		}
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if ownerID != principal.UserID || streamOrganizationID != organizationID {
		// Do not reveal whether a stream id belongs to another tenant.
		writeError(c, http.StatusNotFound, fmt.Errorf("stream not found"))
		return
	}
	_ = conversationID // The ownership check above is intentionally stream-scoped.

	writer := c.Writer
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-transform")
	writer.Header().Set("Connection", "keep-alive")
	writer.Header().Set("X-Accel-Buffering", "no")
	writer.Header().Set("x-vercel-ai-ui-message-stream", "v1")
	writer.Header().Set("x-resumable-stream-id", streamID.String())
	writer.WriteHeader(http.StatusOK)
	flusher, _ := writer.(http.Flusher)

	lastChunkID := int64(0)
	for {
		rows, queryErr := a.DB.QueryContext(c, `
			SELECT id, payload
			FROM chat_stream_chunks
			WHERE stream_id = $1 AND id > $2
			ORDER BY id
		`, streamID, lastChunkID)
		if queryErr != nil {
			return
		}
		for rows.Next() {
			var chunkID int64
			var payload string
			if scanErr := rows.Scan(&chunkID, &payload); scanErr != nil {
				_ = rows.Close()
				return
			}
			if _, writeErr := fmt.Fprintf(writer, "data: %s\n\n", payload); writeErr != nil {
				_ = rows.Close()
				return
			}
			lastChunkID = chunkID
			if flusher != nil {
				flusher.Flush()
			}
		}
		_ = rows.Close()

		if status != "streaming" {
			return
		}
		if err := a.DB.QueryRowContext(c, `SELECT status FROM chat_streams WHERE id = $1 AND expires_at > now()`, streamID).Scan(&status); err != nil {
			return
		}
		if status != "streaming" {
			continue
		}
		timer := time.NewTimer(250 * time.Millisecond)
		select {
		case <-c.Request.Context().Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		case <-timer.C:
		}
	}
}
