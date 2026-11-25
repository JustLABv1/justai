package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"

	"github.com/google/uuid"

	"justai-backend/provider"
)

// transcriptionChatEndpoint picks the chat model used for AI features on a
// transcript (summaries, topic summaries, exclusion rules, speaker names).
// The session's grammar endpoint is preferred so existing sessions keep their
// model. Grammar polish is optional, so a session without it falls back to the
// owner's default chat endpoint instead of blocking these features.
func (a *App) transcriptionChatEndpoint(ctx context.Context, sessionID uuid.UUID) (provider.Endpoint, int, error) {
	var endpointID uuid.NullUUID
	var grammarModel string
	var ownerID, organizationID uuid.UUID
	if err := a.DB.QueryRowContext(ctx, `SELECT grammar_endpoint_id, COALESCE(grammar_model, ''), user_id, organization_id FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&endpointID, &grammarModel, &ownerID, &organizationID); err != nil {
		if err == sql.ErrNoRows {
			return provider.Endpoint{}, http.StatusNotFound, fmt.Errorf("transcription session not found")
		}
		return provider.Endpoint{}, http.StatusInternalServerError, err
	}
	if endpointID.Valid {
		endpoint, err := a.providerEndpoint(ctx, endpointID.UUID)
		if err == nil && endpointSupports(endpoint, "chat") {
			endpoint.ChatModel = firstNonEmptyString(grammarModel, endpoint.ChatModel)
			return endpoint, http.StatusOK, nil
		}
	}
	fallbackID, err := a.resolveTranscriptionEndpoint(ctx, ownerID, organizationID, "", "chat")
	if err != nil {
		return provider.Endpoint{}, http.StatusBadRequest, fmt.Errorf("configure an enabled chat endpoint in Settings → Endpoints to use AI features")
	}
	endpoint, err := a.providerEndpoint(ctx, fallbackID)
	if err != nil || !endpointSupports(endpoint, "chat") {
		return provider.Endpoint{}, http.StatusBadRequest, fmt.Errorf("configure an enabled chat endpoint in Settings → Endpoints to use AI features")
	}
	return endpoint, http.StatusOK, nil
}
