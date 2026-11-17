package server

import (
	"os"
	"testing"
	"time"
)

func TestParseBundestagAblaufplan(t *testing.T) {
	text, err := os.ReadFile("testdata/bundestag_ablaufplan.txt")
	if err != nil {
		t.Fatal(err)
	}
	items, err := parseBundestagAblaufplan(string(text))
	if err != nil {
		t.Fatal(err)
	}
	berlin, _ := time.LoadLocation("Europe/Berlin")
	byKey := map[string]planItem{}
	for _, it := range items {
		byKey[it.Key] = it
	}
	first := items[0]
	if first.SessionNo != 110 || first.Kind != "EPL" || len(first.Numbers) != 3 || first.Numbers[2] != 3 {
		t.Fatalf("wrapped number column not joined: %+v", first)
	}
	if first.Title != "Bundespräsident und Bundespräsidialamt, Bundestag, Bundesrat" {
		t.Errorf("title = %q", first.Title)
	}
	if first.StartAt.In(berlin).Format("2006-01-02 15:04") != "2026-11-24 10:00" || first.EndAt.In(berlin).Format("15:04") != "10:05" {
		t.Errorf("slot = %v–%v", first.StartAt, first.EndAt)
	}
	gesundheit := byKey["s110-epl-15"]
	if gesundheit.Title != "Gesundheit" || gesundheit.StartAt.In(berlin).Format("15:04") != "15:20" {
		t.Errorf("Gesundheit = %+v (keys %v)", gesundheit, keysOf(byKey))
	}
	umwelt := byKey["s110-epl-16"]
	if umwelt.Title != "Umwelt, Klimaschutz, Naturschutz und nukleare Sicherheit" {
		t.Errorf("wrapped title = %q", umwelt.Title)
	}
	kanzler := byKey["s111-epl-04-22"]
	if kanzler.Note == "" || kanzler.EndAt.Sub(kanzler.StartAt) != 4*time.Hour {
		t.Errorf("notes or long slot lost: %+v", kanzler)
	}
	top := byKey["s113-top-ii-iii"]
	if len(top.Numbers) != 2 || top.Numbers[0] != 2 || top.Numbers[1] != 3 || top.Kind != "TOP" {
		t.Errorf("Roman numerals = %+v", top)
	}
	if len(plenaryItemsForSession(items, 112)) != 8 {
		t.Errorf("session 112 has %d items", len(plenaryItemsForSession(items, 112)))
	}
}

func keysOf(m map[string]planItem) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestParseAgendaNumbers(t *testing.T) {
	for in, want := range map[string]int{"08, 20": 2, "II, III": 2, "01, 02,": 2, "IV": 1} {
		if got := parseAgendaNumbers(in); len(got) != want {
			t.Errorf("%q = %v", in, got)
		}
	}
	if n, _ := romanToInt("XIV"); n != 14 {
		t.Errorf("XIV = %d", n)
	}
}
