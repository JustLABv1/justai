package server

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseBundestagPlanFromLivePage(t *testing.T) {
	f, err := os.Open("testdata/bundestag_live_plan.html")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	plan, err := parseBundestagPlan(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan) != 4 {
		t.Fatalf("got %d sessions: %+v", len(plan), plan)
	}
	first := plan[0]
	if first.Key != "bundestag-sitzung-110" || !strings.Contains(first.Title, "110. Sitzung") {
		t.Fatalf("unexpected first session %+v", first)
	}
	berlin, _ := time.LoadLocation("Europe/Berlin")
	if got := first.StartAt.In(berlin); got.Format("2006-01-02 15:04") != "2026-11-24 10:00" {
		t.Errorf("start = %v", got)
	}
	// The end comes from the page's data-enddate epoch: 18:55 Berlin time.
	if got := first.EndAt.In(berlin); got.Format("15:04") != "18:55" {
		t.Errorf("end = %v", got)
	}
	if !first.WindowStartAt.Equal(first.StartAt.Add(-planWindowLead)) || !first.WindowEndAt.Equal(first.EndAt.Add(planWindowOverrun)) || !first.FallbackAt.Equal(first.StartAt.Add(planFallbackStartIn)) {
		t.Errorf("window = %+v", first)
	}
	if plan[1].Key != "bundestag-sitzung-111" || plan[1].StartAt.In(berlin).Format("15:04") != "09:00" {
		t.Errorf("second = %+v", plan[1])
	}
}

func TestParseBundestagPlanRejectsPagesWithoutSessions(t *testing.T) {
	if _, err := parseBundestagPlan(strings.NewReader("<html><body>nothing</body></html>")); err == nil {
		t.Fatal("expected an error")
	}
}

func TestParseBundestagPlanHandlesOpenEndedAndDecimalTimes(t *testing.T) {
	page := `<div class="bt-ptv-day-table"><h3>Montag, 02.03.2026</h3><table><tbody>
<tr><td class="bt-time"><p>ab 13.30 Uhr</p></td><td><h4>Aktuelle Stunde</h4></td></tr>
<tr data-enddate="1772474400"><td class="bt-time"><p>9.30 bis 10.15 Uhr</p></td><td><h4>Sondersitzung</h4></td></tr>
</tbody></table></div>`
	plan, err := parseBundestagPlan(strings.NewReader(page))
	if err != nil || len(plan) != 2 {
		t.Fatalf("plan=%+v err=%v", plan, err)
	}
	berlin, _ := time.LoadLocation("Europe/Berlin")
	if plan[0].StartAt.In(berlin).Format("15:04") != "13:30" || plan[0].EndAt.Sub(plan[0].StartAt) != 10*time.Hour {
		t.Errorf("open-ended = %+v", plan[0])
	}
	if plan[0].Key != "bundestag-2026-03-02-aktuelle-stunde" {
		t.Errorf("key = %s", plan[0].Key)
	}
	if plan[1].StartAt.In(berlin).Format("15:04") != "09:30" {
		t.Errorf("decimal start = %+v", plan[1])
	}
}
