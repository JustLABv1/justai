package rag

import (
	"testing"

	"github.com/google/uuid"

	"justai-backend/models"
)

func TestDiversifyCitationsSpreadsAcrossSources(t *testing.T) {
	sourceA := uuid.New()
	sourceB := uuid.New()
	sourceC := uuid.New()
	citations := []models.Citation{
		{Kind: "knowledge", ResourceID: sourceA, SourceID: sourceA, Title: "a.go", ChunkIndex: 0},
		{Kind: "knowledge", ResourceID: sourceA, SourceID: sourceA, Title: "a.go", ChunkIndex: 1},
		{Kind: "knowledge", ResourceID: sourceA, SourceID: sourceA, Title: "a.go", ChunkIndex: 2},
		{Kind: "knowledge", ResourceID: sourceB, SourceID: sourceB, Title: "b.go", ChunkIndex: 0},
		{Kind: "knowledge", ResourceID: sourceC, SourceID: sourceC, Title: "c.go", ChunkIndex: 0},
	}

	result := diversifyCitations(citations, 4)
	if len(result) != 4 {
		t.Fatalf("expected four citations, got %d", len(result))
	}
	if result[0].ResourceID != sourceA || result[1].ResourceID != sourceB || result[2].ResourceID != sourceC || result[3].ResourceID != sourceA {
		t.Fatalf("expected relevance-preserving source spread, got %+v", result)
	}
}

func TestDeepContextLimits(t *testing.T) {
	if got := normalizeConversationSearchLimit(20); got != defaultConversationSearchLimit {
		t.Fatalf("expected quick search to retain its default cap, got %d", got)
	}
	if got := normalizeDeepContextLimit(100); got != DeepContextLimit {
		t.Fatalf("expected deep-context limit to be capped at %d, got %d", DeepContextLimit, got)
	}
	if got := deepContextCandidateLimit(DeepContextLimit); got != 48 {
		t.Fatalf("expected twice as many deep-context candidates, got %d", got)
	}
	if got := normalizeAttachedDocumentSearchLimit(6); got != AttachedDocumentContextLimit {
		t.Fatalf("expected attached documents to use the broad context window, got %d", got)
	}
}
