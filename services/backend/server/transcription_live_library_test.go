package server

import (
	"strings"
	"testing"
)

func TestLibraryExcerpt(t *testing.T) {
	cases := []struct{ summary, opening, want string }{
		{"## Zusammenfassung\n\n**Kurzfassung:**\n- Das Team testet den **Meeting-Bot** in BDBOS.\n- Zweiter Punkt", "egal", "Das Team testet den Meeting-Bot in BDBOS."},
		{"", "  Vielen Dank.   Test 1, 2, 3. ", "Vielen Dank. Test 1, 2, 3."},
		{"# Nur eine Überschrift\n", "Hallo zusammen", "Hallo zusammen"},
		{"", "", ""},
	}
	for _, c := range cases {
		if got := libraryExcerpt(c.summary, c.opening); got != c.want {
			t.Errorf("libraryExcerpt(%q, %q) = %q, want %q", c.summary, c.opening, got, c.want)
		}
	}
	long := libraryExcerpt("", strings.Repeat("Wort ", 100))
	if !strings.HasSuffix(long, "…") || len([]rune(long)) > libraryExcerptRunes+1 || strings.Contains(long, "Wo…") {
		t.Errorf("long excerpt is not cut at a word: %q", long)
	}
}
