package rag

import (
	"net"
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

func TestIsPublicIPRejectsSpecialUseRanges(t *testing.T) {
	for _, raw := range []string{"100.64.0.1", "192.88.99.1", "198.18.0.1", "240.0.0.1", "224.0.0.1", "2001:db8::1", "2002::1", "3fff::1", "5f00::1", "64:ff9b::1", "64:ff9b:1::1"} {
		if isPublicIP(net.ParseIP(raw)) {
			t.Errorf("expected %s to be rejected as non-public", raw)
		}
	}
	if !isPublicIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("expected public IPv4 address to remain allowed")
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
