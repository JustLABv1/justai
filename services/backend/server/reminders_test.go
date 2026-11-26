package server

import (
	"testing"
	"time"
)

func TestReminderDue(t *testing.T) {
	berlin, _ := time.LoadLocation("Europe/Berlin")
	now := time.Date(2026, 11, 26, 20, 30, 0, 0, time.UTC) // 21:30 in Berlin
	for name, c := range map[string]struct {
		args map[string]any
		want time.Time
	}{
		"in minutes":          {map[string]any{"inMinutes": 20.0}, now.Add(20 * time.Minute)},
		"later today (local)": {map[string]any{"at": "22:15"}, time.Date(2026, 11, 26, 22, 15, 0, 0, berlin)},
		"clock passed today":  {map[string]any{"at": "09:00"}, time.Date(2026, 11, 27, 9, 0, 0, 0, berlin)},
		"tomorrow at nine":    {map[string]any{"at": "09:00", "inDays": 1.0}, time.Date(2026, 11, 27, 9, 0, 0, 0, berlin)},
		"in two days 22:15":   {map[string]any{"at": "22:15", "inDays": 2.0}, time.Date(2026, 11, 28, 22, 15, 0, 0, berlin)},
		"local date and time": {map[string]any{"at": "2026-12-01 08:30"}, time.Date(2026, 12, 1, 8, 30, 0, 0, berlin)},
		"absolute with zone":  {map[string]any{"at": "2026-11-27T10:00:00Z"}, time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)},
	} {
		got, err := reminderDue(c.args, now, berlin)
		if err != nil || !got.Equal(c.want) {
			t.Errorf("%s: got %v (%v), want %v", name, got, err, c.want)
		}
	}
	for name, args := range map[string]map[string]any{
		"nothing":     {},
		"bad clock":   {"at": "morgen früh"},
		"huge offset": {"inMinutes": 1e9},
	} {
		if _, err := reminderDue(args, now, berlin); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
