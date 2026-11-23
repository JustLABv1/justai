package server

import (
	"strings"
	"testing"
	"time"

	"justai-backend/streamrelay"
)

func TestParseBundestagPlanReadsChannels(t *testing.T) {
	page := `<div class="bt-ptv-day-table"><h3>Heute, 23.11.2026</h3><table>
<tr data-channelnumber="7" data-enddate="1795435200"><td class="bt-time"><p>11 bis 13 Uhr</p></td><td><h4>Finanzierung der Infrastrukturgesellschaft</h4></td></tr>
<tr data-channelnumber="8" data-enddate="1795446000"><td class="bt-time"><p>14 bis 16 Uhr</p></td><td><h4>KI in der Migrationsverwaltung</h4></td></tr>
<tr data-channelnumber="999"><td class="bt-time"><p>17 bis 18 Uhr</p></td><td><h4>Kaputt</h4></td></tr>
</table></div>`
	plan, err := parseBundestagPlan(strings.NewReader(page))
	if err != nil {
		t.Fatal(err)
	}
	if len(plan) != 3 || plan[0].Channel != 7 || plan[1].Channel != 8 || plan[2].Channel != 0 {
		t.Fatalf("channels not parsed: %+v", plan)
	}
}

func TestBundestagChannelURL(t *testing.T) {
	t.Setenv("JUSTAI_STREAM_RELAY_URL", "https://relay.example.org")
	relay := "https://relay.example.org/v1/sources/"
	sources := []streamrelay.Source{{ID: "bundestag", URL: relay + "bundestag"}, {ID: "bundestag-hk7", URL: relay + "bundestag-hk7"}}
	cases := []struct {
		url     string
		channel int
		want    string
		ok      bool
	}{
		{"https://www.bundestag.de/mediathek/live", 1, "https://www.bundestag.de/mediathek/live", true},
		{"https://www.bundestag.de/mediathek/live", 7, "https://bttv-live-z.r53.cdn.tv1.eu/13014bundestag-hk7/live_or_128/playlist_dvr.m3u8", true},
		{relay + "bundestag", 7, relay + "bundestag-hk7", true},
		{relay + "bundestag-hk7", 1, relay + "bundestag", true},
		{relay + "bundestag", 8, "", false},
		{relay + "bundestag", 0, relay + "bundestag", true},
		{"https://radio.example/live.mp3", 7, "https://radio.example/live.mp3", true},
	}
	for _, c := range cases {
		got, ok := bundestagChannelURL(c.url, c.channel, sources)
		if got != c.want || ok != c.ok {
			t.Errorf("%s channel %d: got %q %v, want %q %v", c.url, c.channel, got, ok, c.want, c.ok)
		}
	}
	plan := []planSession{{Channel: 7}, {Channel: 8}, {}}
	plan[0].Channel, plan[1].Channel = 7, 8
	for i, session := range plan {
		_, ok := bundestagChannelURL(relay+"bundestag", session.Channel, sources)
		if want := i != 1; ok != want {
			t.Errorf("session %d availability %v", i, ok)
		}
	}
	if err := errChannelUnavailable(planSession{Title: "KI", Channel: 8}); !strings.Contains(err.Error(), `"bundestag-hk8"`) {
		t.Errorf("error does not name the relay source: %v", err)
	}
}

func TestRunningBundestagSession(t *testing.T) {
	now := time.Date(2026, 11, 23, 11, 30, 0, 0, time.UTC)
	committee := newPlanSession("verkehr", "Verkehr", now.Add(-30*time.Minute), now.Add(90*time.Minute))
	committee.Channel = 7
	later := newPlanSession("inneres", "Inneres", now.Add(3*time.Hour), now.Add(5*time.Hour))
	later.Channel = 8
	if got, ok := runningBundestagSession([]planSession{committee, later}, now); !ok || got.Key != "verkehr" {
		t.Fatalf("running committee not chosen: %+v %v", got, ok)
	}
	plenary := newPlanSession("bundestag-sitzung-110", "110. Sitzung", now.Add(-time.Hour), now.Add(6*time.Hour))
	plenary.Channel = 1
	if got, _ := runningBundestagSession([]planSession{committee, plenary}, now); got.Key != plenary.Key {
		t.Fatalf("plenary should win: %+v", got)
	}
	other := committee
	other.Key, other.Channel = "other", 3
	if _, ok := runningBundestagSession([]planSession{committee, other}, now); ok {
		t.Fatal("two parallel committees are ambiguous")
	}
	if _, ok := runningBundestagSession([]planSession{later}, now); ok {
		t.Fatal("a later session is not running")
	}
}
