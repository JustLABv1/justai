package server

import (
	"testing"

	"github.com/google/uuid"
)

func detectorTopics() []topicRef {
	mk := func(kind string, title string, status string, numbers ...int) topicRef {
		return topicRef{ID: uuid.New(), Kind: kind, Numbers: numbers, Title: title, Status: status}
	}
	return []topicRef{
		mk("EPL", "Bundespräsident und Bundespräsidialamt, Bundestag, Bundesrat", "planned", 1, 2, 3),
		mk("EPL", "Finanzen, Bundesrechnungshof", "planned", 8, 20),
		mk("EPL", "Gesundheit", "planned", 15),
		mk("EPL", "Verkehr", "planned", 12),
		mk("EPL", "Umwelt, Klimaschutz, Naturschutz und nukleare Sicherheit", "planned", 16),
		mk("TOP", "Haushaltsbegleitgesetz 2027, Haushaltsgesetz 2027 (3. Beratung)", "planned", 2, 3),
		mk("ZP", "Aktuelle Debatte", "planned", 1),
	}
}

func TestDetectTopicAnnouncement(t *testing.T) {
	topics := detectorTopics()
	cases := []struct {
		text string
		want int
	}{
		{"Ich rufe jetzt den Einzelplan 15 Geschäftsbereich des Bundesministeriums für Gesundheit auf.", 2},
		{"Wir kommen nun zu den Einzelplänen 08 und 20.", 1},
		{"Ich rufe die Tagesordnungspunkte II und III auf.", 5},
		{"Ich rufe Tagesordnungspunkt 3 auf: Haushaltsgesetz 2027", 5},
		{"Ich rufe den Zusatzpunkt 1 auf", 6},
		{"Ich rufe nun den Geschäftsbereich des Bundesministeriums für Verkehr auf.", 3},
		{"Kommen wir zu Umwelt, Klimaschutz und Naturschutz.", 4},
		// Not announcements.
		{"Das war ein Zwischenruf aus der Fraktion, den ich rügen muss.", -1},
		{"Der Einzelplan 15 ist ein wichtiger Haushalt für uns alle.", -1},
		{"Ich rufe Einzelplan 99 auf.", -1},
		{"Wir müssen beim Verkehr dringend mehr tun.", -1},
	}
	for _, c := range cases {
		if got := detectTopicAnnouncement(c.text, topics); got != c.want {
			t.Errorf("%q: got %d, want %d", c.text, got, c.want)
		}
	}
}

func TestDoneTopicsAreNotReopened(t *testing.T) {
	topics := detectorTopics()
	topics[2].Status = "done"
	if got := detectTopicAnnouncement("Ich rufe den Einzelplan 15 auf", topics); got != -1 {
		t.Fatalf("a finished item matched again: %d", got)
	}
}

func TestSittingCloseAndPrecheck(t *testing.T) {
	if !isSittingClosed("Damit ist die Tagesordnung erledigt. Ich schließe die Sitzung.") || !isSittingClosed("Die Sitzung ist geschlossen") {
		t.Error("closing not detected")
	}
	if isSittingClosed("Wir schließen die Aussprache") {
		t.Error("closing a debate must not close the sitting")
	}
	if mightAnnounceTopic("Das Wort hat der Kollege Müller.") || !mightAnnounceTopic("Ich rufe den Tagesordnungspunkt 4 auf") {
		t.Error("precheck wrong")
	}
}

func TestHousingBudgetCallAcrossFinalSegments(t *testing.T) {
	topics := []topicRef{{Kind: "EPL", Numbers: []int{25}, Title: "Wohnen, Stadtentwicklung und Bauwesen", Status: "planned"}}
	for _, segments := range [][]string{
		{"Ich rufe auf: den Einzelplan 25. Bundesministerium für Wohnen, Stadtentwicklung, und Bauwesen mit dem Beschluss mit den Beschlussempfehlungen des Haushaltsausschusses auf ist auf Drucksache 19-9061. und 9062."},
		{"Vielen Dank. Ich rufe auf:", "den Einzelplan", "25. Bundesministerium für Wohnen, Stadtentwicklung, und Bauwesen."},
	} {
		var pending topicCallBuffer
		for i, text := range segments {
			offset := int64(i * 2000)
			got := detectTopicAnnouncement(pending.candidate(text, offset, offset+2000), topics)
			if (got == 0) != (i == len(segments)-1) {
				t.Fatalf("segment %q: match %d", text, got)
			}
		}
	}
	var pending topicCallBuffer
	pending.candidate("Ich rufe auf:", 0, 2000)
	if detectTopicAnnouncement(pending.candidate("den Einzelplan 25.", 30000, 32000), topics) != -1 {
		t.Fatal("an expired call matched a later mention")
	}
}
