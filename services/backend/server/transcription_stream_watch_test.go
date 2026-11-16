package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"justai-backend/speechdetect"
)

func TestSilenceGuardIsArmedOnlyAfterSpeechWasHeard(t *testing.T) {
	// Music from the start (a detector that never hears speech) must not end the capture.
	blind := newSilenceGuard(20 * time.Second)
	for i := 0; i < 6; i++ {
		if blind.feed(speechdetect.SyntheticMusic(10)) {
			t.Fatal("guard stopped a capture it never heard speech in")
		}
	}
	guard := newSilenceGuard(20 * time.Second)
	for i := 0; i < 3; i++ {
		if guard.feed(speechdetect.SyntheticSpeech(10, int64(i))) {
			t.Fatal("stopped during speech")
		}
	}
	stopped := false
	for i := 0; i < 5 && !stopped; i++ {
		stopped = guard.feed(speechdetect.SyntheticMusic(10))
	}
	if !stopped {
		t.Fatal("guard did not stop after the programme returned to music")
	}
	// A short pause must not stop it.
	brief := newSilenceGuard(60 * time.Second)
	brief.feed(speechdetect.SyntheticSpeech(15, 9))
	if brief.feed(speechdetect.SyntheticMusic(20)) {
		t.Fatal("stopped on a short pause")
	}
	if brief.feed(speechdetect.SyntheticSpeech(10, 10)) || brief.gate.NonSpeechFor() > 5*time.Second {
		t.Fatal("speech did not reset the silence timer")
	}
}

func TestPrepareStreamWatchValidation(t *testing.T) {
	a := &App{}
	now := time.Now().UTC()
	start, end := now, now.Add(2*time.Hour)
	ok := func(mode string, silence int, follow bool, key string, s, e *time.Time) error {
		_, err := a.prepareStreamWatch(context.Background(), "https://example.com/live", mode, silence, follow, key, e, s)
		return err
	}
	if err := ok("at_time", 0, false, "", &start, nil); err != nil {
		t.Errorf("plain scheduled capture rejected: %v", err)
	}
	if err := ok("when_live", 0, false, "", &start, &end); err != nil {
		t.Errorf("valid watch window rejected: %v", err)
	}
	for name, err := range map[string]error{
		"watch window without an end": ok("when_live", 0, false, "", &start, nil),
		"window over 48 hours":        ok("when_live", 0, false, "", &start, ptrTime(start.Add(49*time.Hour))),
		"silence limit under 2 min":   ok("when_live", 60, false, "", &start, &end),
		"silence limit over 4 hours":  ok("at_time", 15000, false, "", &start, nil),
		"plan follow with fixed time": ok("at_time", 0, true, "bundestag-sitzung-1", &start, &end),
		"plan follow without a key":   ok("when_live", 0, true, "", &start, &end),
		"plan for another site":       ok("when_live", 0, true, "bundestag-sitzung-1", &start, &end),
	} {
		if err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if _, err := normalizeStartMode("whenever"); err == nil {
		t.Error("unknown start mode accepted")
	}
	if mode, err := normalizeStartMode(""); err != nil || mode != "at_time" {
		t.Errorf("default mode = %q, %v", mode, err)
	}
}

func ptrTime(t time.Time) *time.Time { return &t }

func TestBundestagLiveURLDetection(t *testing.T) {
	for raw, want := range map[string]bool{
		"https://www.bundestag.de/mediathek/live":  true,
		"https://bundestag.de/mediathek/live/":     true,
		"https://www.bundestag.de/mediathek/other": false,
		"https://example.com/mediathek/live":       false,
		"::bad::":                                  false,
	} {
		if got := isBundestagLiveURL(raw); got != want {
			t.Errorf("%s: got %v", raw, got)
		}
	}
	if !strings.Contains(bundestagLiveURL, "bundestag.de/mediathek/live") {
		t.Error("plan URL changed unexpectedly")
	}
}
