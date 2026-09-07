package server

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"justai-backend/models"
)

type knowledgeSnapshotChunk struct {
	Kind       string    `json:"kind"`
	ResourceID uuid.UUID `json:"resourceId,omitempty"`
	SourceID   uuid.UUID `json:"sourceId,omitempty"`
	ChunkIndex int       `json:"chunkIndex,omitempty"`
	Locator    string    `json:"locator,omitempty"`
}

// persistKnowledgeContextSnapshot stores identifiers and scores' locators,
// never retrieved private text. It is best effort so a migration in progress
// cannot make an otherwise valid chat turn fail.
func (a *App) persistKnowledgeContextSnapshot(ctx context.Context, runID, conversationID uuid.UUID, userMessageID string, resolution knowledgeContextResolution, citations []models.Citation, includeIDs, excludeIDs []uuid.UUID, retrievalStatus string) error {
	if a.DB == nil || runID == uuid.Nil || conversationID == uuid.Nil {
		return nil
	}
	resourceIDs := make([]uuid.UUID, 0, len(citations))
	chunks := make([]knowledgeSnapshotChunk, 0, len(citations))
	seenResources := make(map[uuid.UUID]struct{})
	for _, citation := range citations {
		resourceID := citation.ResourceID
		if resourceID == uuid.Nil {
			resourceID = citation.SourceID
		}
		if resourceID != uuid.Nil {
			if _, exists := seenResources[resourceID]; !exists {
				seenResources[resourceID] = struct{}{}
				resourceIDs = append(resourceIDs, resourceID)
			}
		}
		chunks = append(chunks, knowledgeSnapshotChunk{
			Kind: citation.Kind, ResourceID: citation.ResourceID, SourceID: citation.SourceID,
			ChunkIndex: citation.ChunkIndex, Locator: citation.Locator,
		})
	}
	itemIDs := make([]uuid.UUID, 0, len(resourceIDs))
	if len(resourceIDs) > 0 {
		rows, err := a.DB.QueryContext(ctx, `SELECT id FROM knowledge_items WHERE organization_id = (SELECT organization_id FROM conversations WHERE id=$2) AND resource_id = ANY($1::uuid[])`, pq.Array(resourceIDs), conversationID)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var id uuid.UUID
				if rows.Scan(&id) == nil {
					itemIDs = append(itemIDs, id)
				}
			}
		}
	}
	chunkJSON, err := json.Marshal(chunks)
	if err != nil {
		return err
	}
	overrides, err := json.Marshal(map[string]any{
		"includeSpaceIds": includeIDs,
		"excludeSpaceIds": excludeIDs,
	})
	if err != nil {
		return err
	}
	status := retrievalStatus
	if status == "" {
		status = "completed"
	}
	_, err = a.DB.ExecContext(ctx, `
		INSERT INTO chat_context_snapshots
			(run_id, conversation_id, user_message_id, selected_space_ids, selected_item_ids, selected_chunks, overrides, routing_version, retrieval_status)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,$6::jsonb,$7::jsonb,'catalog-v1',$8)
		ON CONFLICT (run_id) DO UPDATE SET
			selected_space_ids=EXCLUDED.selected_space_ids,
			selected_item_ids=EXCLUDED.selected_item_ids,
			selected_chunks=EXCLUDED.selected_chunks,
			overrides=EXCLUDED.overrides,
			retrieval_status=EXCLUDED.retrieval_status`,
		runID, conversationID, userMessageID,
		pq.Array(resolvedKnowledgeSpaceUUIDs(resolution)), pq.Array(itemIDs), string(chunkJSON), string(overrides), status)
	return err
}

func resolvedKnowledgeSpaceUUIDs(resolution knowledgeContextResolution) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(resolution.Spaces))
	for _, space := range resolution.Spaces {
		ids = append(ids, space.ID)
	}
	return ids
}
