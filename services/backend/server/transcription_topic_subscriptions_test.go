package server

import (
	"testing"
	"time"
)

func TestUpcomingSittingMatches(t *testing.T) {
	now := time.Date(2026, 11, 16, 9, 0, 0, 0, time.UTC)
	item := func(sitting int, key, label, title string, start time.Time) planItem {
		return planItem{Key: key, SessionNo: sitting, Label: label, Title: title, StartAt: start, EndAt: start.Add(time.Hour)}
	}
	items := []planItem{
		item(40, "s40-top-1", "TOP 1", "Haushaltsgesetz 2027", now.Add(-2*time.Hour)), // already running
		item(41, "s41-top-3", "TOP 3", "Digitale Verwaltung", now.Add(26*time.Hour)),
		item(41, "s41-top-4", "TOP 4", "Rente", now.Add(28*time.Hour)),
		item(42, "s42-epl-08", "EPL 08", "Bundesministerium der Finanzen", now.Add(50*time.Hour)),
		item(42, "s42-top-9", "TOP 9", "Gesetz zur Förderung der Digitalisierung", now.Add(52*time.Hour)),
	}
	got := upcomingSittingMatches(items, []string{"digital", "haushalt", "FOERDERUNG"}, now)
	if len(got) != 2 {
		t.Fatalf("sittings = %v", got)
	}
	if len(got[41]) != 1 || got[41][0].Key != "s41-top-3" {
		t.Fatalf("sitting 41 = %+v", got[41])
	}
	if len(got[42]) != 1 || got[42][0].Key != "s42-top-9" {
		t.Fatalf("sitting 42 = %+v (umlaut spelling should match)", got[42])
	}
	if _, ok := got[40]; ok {
		t.Fatal("a sitting whose capture would start in the past must be skipped")
	}
}

func TestNormalizeKeywords(t *testing.T) {
	got, err := normalizeKeywords([]string{"  Digitales ", "digitales", "", "Haus  halt"})
	if err != nil || len(got) != 2 || got[1] != "Haus halt" {
		t.Fatalf("got %v, %v", got, err)
	}
	if _, err := normalizeKeywords([]string{"ab"}); err == nil {
		t.Fatal("too short keywords must be rejected")
	}
}
