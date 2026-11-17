package server

import (
	"testing"

	"github.com/google/uuid"

	"justai-backend/models"
)

func TestParseSpeakerAnnouncement(t *testing.T) {
	cases := []struct {
		text, name, group, role string
	}{
		{"Vielen Dank. – Das Wort hat jetzt die Kollegin Anna Müller für die SPD-Fraktion.", "Anna Müller", "SPD", ""},
		{"Nächster Redner ist der Kollege Dr. Max von der Heide, CDU/CSU-Fraktion.", "Dr. Max von der Heide", "CDU/CSU", ""},
		{"Das Wort hat Bundeskanzler Friedrich Merz.", "Friedrich Merz", "", "Bundeskanzler"},
		{"Ich erteile das Wort der Kollegin Lisa Paus, Bündnis 90/Die Grünen.", "Lisa Paus", "Bündnis 90/Die Grünen", ""},
		{"Für die AfD-Fraktion spricht jetzt der Kollege Stefan Keuter.", "Stefan Keuter", "AfD", ""},
		{"Das Wort hat die Parlamentarische Staatssekretärin Rita Hagl-Kehl.", "Rita Hagl-Kehl", "", "Staatssekretärin"},
	}
	for _, tc := range cases {
		got, ok := parseSpeakerAnnouncement(tc.text)
		if !ok {
			t.Errorf("%q: no announcement found", tc.text)
			continue
		}
		if got.Name != tc.name || got.Group != tc.group || got.Role != tc.role {
			t.Errorf("%q: got %+v, want name %q group %q role %q", tc.text, got, tc.name, tc.group, tc.role)
		}
	}
	for _, text := range []string{
		"Das Wort hat die Bundesregierung.",
		"Wir haben heute das Wort der Ministerin gehört.",
		"Der Kollege hat recht, die SPD will das auch.",
	} {
		if got, ok := parseSpeakerAnnouncement(text); ok {
			t.Errorf("%q: unexpected announcement %+v", text, got)
		}
	}
}

func TestSpeakerTurnsNameSeparatedVoices(t *testing.T) {
	chair, voiceA, voiceB := uuid.New(), uuid.New(), uuid.New()
	seg := func(speaker uuid.UUID, start, end int64, text string) models.TranscriptionSegment {
		return models.TranscriptionSegment{SpeakerID: &speaker, StartOffsetMs: start, EndOffsetMs: end, Text: text}
	}
	segments := []models.TranscriptionSegment{
		seg(chair, 0, 5_000, "Das Wort hat die Kollegin Anna Müller für die SPD."),
		seg(voiceA, 5_000, 40_000, "Sehr geehrte Frau Präsidentin! Liebe Kolleginnen und Kollegen!"),
		seg(voiceA, 40_000, 70_000, "Wir brauchen dieses Gesetz."),
		seg(chair, 70_000, 73_000, "Vielen Dank, Frau Kollegin."),
		seg(chair, 73_000, 78_000, "Nächster Redner ist der Kollege Stefan Keuter, AfD."),
		seg(voiceB, 78_000, 120_000, "Frau Präsidentin! Meine Damen und Herren!"),
	}
	labels := speakerTurnLabels(segments)
	want := []string{parliamentChairName, "Anna Müller (SPD)", "Anna Müller (SPD)", parliamentChairName, parliamentChairName, "Stefan Keuter (AfD)"}
	for i := range want {
		if labels[i] != want[i] {
			t.Fatalf("label %d = %q, want %q", i, labels[i], want[i])
		}
	}
	names := speakerNamesFromTurns(segments, labels)
	if names[voiceA] != "Anna Müller (SPD)" || names[voiceB] != "Stefan Keuter (AfD)" {
		t.Fatalf("names = %v", names)
	}
	if _, ok := names[chair]; ok {
		t.Fatalf("the chair spoke too briefly to be named, got %q", names[chair])
	}
}
