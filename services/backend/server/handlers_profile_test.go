package server

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestProfileActivityInsightsUsesLocalCalendarDays(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.September, 10, 9, 0, 0, 0, location)
	activity := []profileActivityDay{
		{Date: "2026-09-07", Count: 8},
		{Date: "2026-09-08", Count: 5},
		{Date: "2026-09-09", Count: 3},
		{Date: "2026-09-10", Count: 1},
		{Date: "2026-08-01", Count: 6},
	}

	current, longest, weekday, last30, previous30, total, activeDays, milestones := profileActivityInsights(activity, now, location)
	if current != 4 {
		t.Fatalf("current streak = %d, want 4", current)
	}
	if longest != 4 {
		t.Fatalf("longest streak = %d, want 4", longest)
	}
	if weekday != "Monday" {
		t.Fatalf("productive weekday = %q, want Monday", weekday)
	}
	if last30 != 17 || previous30 != 6 {
		t.Fatalf("30-day totals = %d/%d, want 17/6", last30, previous30)
	}
	if total != 23 || activeDays != 5 {
		t.Fatalf("activity totals = %d/%d, want 23/5", total, activeDays)
	}
	if len(milestones) != 0 {
		t.Fatalf("unexpected milestones: %v", milestones)
	}
}

func TestProfileLocationRejectsInvalidTimezone(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest("GET", "/api/v1/profile?timezone=Not%2FAnIANAZone", nil)
	if _, _, err := profileLocation(context); err == nil {
		t.Fatal("expected invalid timezone to be rejected")
	}
}
