package server

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

const liveTranscriptionPolishTimeout = 15 * time.Minute

// polishTranscriptionSession applies the same transcript-preserving grammar
// pass used by video sessions to completed live sessions. Keeping the work on
// the session rather than the capture source makes the transcript workspace
// independent from how the audio was collected.
func (m *TranscriptionManager) polishTranscriptionSession(ctx context.Context, sessionID uuid.UUID) error {
	if m.app == nil {
		return fmt.Errorf("transcription manager is not attached to the app")
	}
	var endpointID uuid.NullUUID
	var model string
	if err := m.DB.QueryRowContext(ctx, `SELECT grammar_endpoint_id, COALESCE(grammar_model, '') FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&endpointID, &model); err != nil {
		return err
	}
	if !endpointID.Valid {
		return fmt.Errorf("configure a grammar/chat endpoint before polishing this transcript")
	}
	endpoint, err := m.app.providerEndpoint(ctx, endpointID.UUID)
	if err != nil {
		return fmt.Errorf("grammar endpoint could not be loaded: %w", err)
	}
	endpoint.ChatModel = firstNonEmptyString(model, endpoint.ChatModel)
	if !endpointSupports(endpoint, "chat") {
		return fmt.Errorf("grammar endpoint does not support chat")
	}
	segments, err := loadTranscriptionSegments(ctx, m.DB, sessionID)
	if err != nil {
		return err
	}
	setStatus := func(status string) {
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_sessions SET polish_status = $2, updated_at = now() WHERE id = $1`, sessionID, status)
		m.broadcast(sessionID, "transcription.polish", ginData{"status": status})
	}
	setStatus("processing")
	if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_segments SET polished_text = NULL, updated_at = now() WHERE session_id = $1`, sessionID); err != nil {
		setStatus("failed")
		return err
	}
	if len(segments) == 0 {
		setStatus("completed")
		return nil
	}

	for index := 0; index < len(segments); {
		start := index
		characters := 0
		for index < len(segments) && index-start < 20 {
			segment := segments[index]
			raw := strings.TrimSpace(segment.Text)
			if raw == "" {
				raw = strings.TrimSpace(segment.RawText)
			}
			if raw == "" {
				index++
				continue
			}
			if index > start && characters+len(raw) > 9000 {
				break
			}
			characters += len(raw)
			index++
		}
		if index == start {
			index++
			continue
		}
		if err := m.polishVideoTranscriptBatch(ctx, endpoint, sessionID, segments[start:index]); err != nil {
			setStatus("failed")
			return err
		}
	}
	setStatus("completed")
	return nil
}

func (a *App) polishTranscriptionSession(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, 400, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, 404, err)
		return
	}
	session, err := loadTranscriptionSession(c, a.DB, sessionID)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	if session.Kind != "live" {
		writeError(c, 400, fmt.Errorf("grammar polish for video sessions is managed by the video pipeline"))
		return
	}
	if session.Status != "completed" {
		writeError(c, 400, fmt.Errorf("polish the transcript after the live session is complete"))
		return
	}
	polishContext, cancel := context.WithTimeout(c.Request.Context(), liveTranscriptionPolishTimeout)
	defer cancel()
	if err := a.Live.polishTranscriptionSession(polishContext, sessionID); err != nil {
		writeError(c, 502, err)
		return
	}
	snapshot, err := a.transcriptionSnapshot(c, sessionID)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	c.JSON(200, gin.H{"snapshot": snapshot})
}
