package server

import (
	"testing"

	"github.com/google/uuid"
)

func TestStorageReferenceIDsReadsStableDirectiveIDs(t *testing.T) {
	first := uuid.New()
	second := uuid.New()
	text := ":knowledge[Quarterly [final].pdf]{name=knowledge:" + first.String() + "} and :knowledge[Briefing]{name=\"knowledge:" + second.String() + "} and :knowledge[again]{name=knowledge:" + first.String() + "}"

	got := storageReferenceIDs(text)
	if len(got) != 2 || got[0] != first || got[1] != second {
		t.Fatalf("unexpected referenced source ids: %#v", got)
	}
}

func TestSelectChatContextUsesMessageAttachmentAsAnAllowlist(t *testing.T) {
	attachment := uuid.New()
	persistent := uuid.New()
	selection := selectChatContext(&assistantUserMessage{
		HasAttachments:      true,
		AttachmentSourceIDs: []uuid.UUID{attachment},
	}, []uuid.UUID{persistent}, []uuid.UUID{uuid.New()})

	if !selection.SelectedOnly || len(selection.SourceIDs) != 1 || selection.SourceIDs[0] != attachment {
		t.Fatalf("message attachment must override durable context: %#v", selection)
	}
	if len(selection.TranscriptIDs) != 0 {
		t.Fatalf("message attachment must not include transcripts: %#v", selection)
	}
}

func TestSelectChatContextUsesReferencedStorageFileOnly(t *testing.T) {
	referenced := uuid.New()
	persistent := uuid.New()
	selection := selectChatContext(&assistantUserMessage{
		Text: ":knowledge[Meeting notes]{name=knowledge:" + referenced.String() + "}",
	}, []uuid.UUID{persistent}, []uuid.UUID{uuid.New()})

	if !selection.SelectedOnly || len(selection.SourceIDs) != 1 || selection.SourceIDs[0] != referenced {
		t.Fatalf("storage reference must override durable context: %#v", selection)
	}
	if len(selection.TranscriptIDs) != 0 {
		t.Fatalf("storage reference must not include transcripts: %#v", selection)
	}
}

func TestSelectChatContextFallsBackToAutomaticStorage(t *testing.T) {
	selection := selectChatContext(&assistantUserMessage{Text: "What are the decisions?"}, nil, nil)
	if selection.SelectedOnly || selection.Label != "Storage · Automatic" {
		t.Fatalf("expected automatic storage context, got %#v", selection)
	}
}
