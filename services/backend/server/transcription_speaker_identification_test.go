package server

import (
	"testing"

	"github.com/google/uuid"

	"justai-backend/models"
)

func TestResolveSpeakerIdentifications(t *testing.T) {
	a, b, c, d := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	speakers := []models.TranscriptionSpeaker{
		{ID: a, Label: "SPEAKER_00"},
		{ID: b, Label: "SPEAKER_01"},
		{ID: c, Label: "SPEAKER_02", DisplayName: "Tom", NameSource: "manual"},
		{ID: d, Label: "SPEAKER_03", DisplayName: "Old", NameSource: "ai"},
	}
	participants := []speakerParticipant{{Name: "Anna Schmidt"}, {Name: "Ben"}}
	items := []speakerIdentification{
		{Label: "SPEAKER_00", Name: "anna schmidt", Confidence: 0.95, Evidence: "Ich bin Anna"},
		{Label: "SPEAKER_01", Name: "Zoe", Confidence: 0.99, Evidence: "unlisted"},
		{Label: "SPEAKER_02", Name: "Ben", Confidence: 0.99},
		{Label: "SPEAKER_03", Name: "Ben", Confidence: 0.9},
		{Label: "SPEAKER_09", Name: "Ghost", Confidence: 1},
	}
	got := resolveSpeakerIdentifications(items, speakers, participants, true)
	byID := map[uuid.UUID]resolvedSpeakerName{}
	for _, r := range got {
		byID[r.SpeakerID] = r
	}
	if r := byID[a]; r.Name != "Anna Schmidt" || !r.Apply {
		t.Fatalf("listed, confident name should be canonicalized and applied: %+v", r)
	}
	if r := byID[b]; r.Name != "Zoe" || r.Apply || r.Confidence != speakerUnlistedConfidenceCap {
		t.Fatalf("unlisted name must be capped to a suggestion: %+v", r)
	}
	if _, ok := byID[c]; ok {
		t.Fatal("manually named speaker must not be touched")
	}
	if r := byID[d]; r.Name != "Ben" || !r.Apply {
		t.Fatalf("AI-named speaker may be refined: %+v", r)
	}
	if len(got) != 3 {
		t.Fatalf("unknown labels must be dropped, got %d results", len(got))
	}
}

func TestResolveSpeakerIdentificationsDuplicateNameKeepsMostConfident(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	speakers := []models.TranscriptionSpeaker{{ID: a, Label: "Speaker 1"}, {ID: b, Label: "Speaker 2"}}
	got := resolveSpeakerIdentifications([]speakerIdentification{
		{Label: "Speaker 1", Name: "Anna", Confidence: 0.6},
		{Label: "Speaker 2", Name: "Anna", Confidence: 0.9},
		{Label: "Speaker 1", Name: "", Confidence: 0},
	}, speakers, nil, false)
	if len(got) != 1 || got[0].SpeakerID != b || got[0].Apply {
		t.Fatalf("unexpected result: %+v", got)
	}
}

func TestDecodeSpeakerIdentifications(t *testing.T) {
	items, err := decodeSpeakerIdentifications("Here:\n```json\n{\"speakers\":[{\"label\":\"A\",\"name\":\"X\",\"confidence\":0.7}]}\n```")
	if err != nil || len(items) != 1 || items[0].Name != "X" {
		t.Fatalf("fenced output: %v %+v", err, items)
	}
	if _, err := decodeSpeakerIdentifications("no json"); err == nil {
		t.Fatal("expected error for non-JSON output")
	}
}
