package server

import (
	"testing"

	"github.com/google/uuid"
)

func TestDecodeVideoPolishOutputMergesConcatenatedJSONValues(t *testing.T) {
	firstID := uuid.New()
	secondID := uuid.New()
	value := `{"segments":[{"id":"` + firstID.String() + `","text":"Erste Zeile."}]}{"segments":[{"id":"` + secondID.String() + `","text":"Zweite Zeile."}]}`

	got, err := decodeVideoPolishOutput(value)
	if err != nil {
		t.Fatalf("decodeVideoPolishOutput returned error: %v", err)
	}
	if got[firstID] != "Erste Zeile." || got[secondID] != "Zweite Zeile." {
		t.Fatalf("decoded segments = %#v", got)
	}
}

func TestDecodeVideoPolishOutputIgnoresMarkdownAndProse(t *testing.T) {
	segmentID := uuid.New()
	value := "Here is the corrected transcript:\n```json\n" +
		`{"segments":[{"id":"` + segmentID.String() + `","text":"Korrigierte Zeile."}]}` +
		"\n```\n"

	got, err := decodeVideoPolishOutput(value)
	if err != nil {
		t.Fatalf("decodeVideoPolishOutput returned error: %v", err)
	}
	if got[segmentID] != "Korrigierte Zeile." {
		t.Fatalf("decoded segment = %#v", got)
	}
}
