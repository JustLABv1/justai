package rag

import (
	"context"
	"net"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"

	"justai-backend/models"
)

func TestExplicitAttachmentSearchDoesNotRequireKnowledgeCatalogRow(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	conversationID := uuid.New()
	sourceID := uuid.New()
	sourceIDs := sourceID.String()
	mock.ExpectQuery(`(?s)LEFT JOIN knowledge_items ki.+AND \(\$2 <> '' OR \(`).
		WithArgs(conversationID, sourceIDs, "summarize this file", "summarize | this | file", 12).
		WillReturnRows(sqlmock.NewRows([]string{"source_id", "title", "chunk_index", "content"}))
	mock.ExpectQuery(`(?s)FROM knowledge_chunks kc.+conversation_knowledge_sources.+cks.source_id = ANY`).
		WithArgs(conversationID, sourceIDs, AttachedDocumentContextLimit).
		WillReturnRows(sqlmock.NewRows([]string{"source_id", "title", "chunk_index", "content"}).
			AddRow(sourceID, "report.csv", 0, "headline,category\nExample,News"))

	citations, err := SearchConversationSources(
		context.Background(), database, conversationID, "summarize this file", 6, []uuid.UUID{sourceID},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(citations) != 1 || citations[0].SourceID != sourceID {
		t.Fatalf("expected explicit source coverage without a catalog row, got %+v", citations)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestExtractUploadContextAcceptsCSVWithGenericMIME(t *testing.T) {
	body := []byte("portal,title,url\nExample,Daily news,https://example.com/news\n")
	content, err := ExtractUploadContext(context.Background(), "daily-news.csv", "application/octet-stream", body)
	if err != nil {
		t.Fatalf("expected CSV upload to be accepted: %v", err)
	}
	if content != string(body[:len(body)-1]) {
		t.Fatalf("unexpected CSV content: %q", content)
	}
}

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
