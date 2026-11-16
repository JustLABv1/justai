package server

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"justai-backend/models"
)

func scopeTopic(order int, status string, starred bool, start, end time.Time) models.TranscriptionTopic {
	s, e := start, end
	return models.TranscriptionTopic{ID: uuid.New(), Order: order, Status: status, Starred: starred, PlannedStartAt: &s, PlannedEndAt: &e, Title: "T"}
}

func TestTopicCapturePlan(t *testing.T) {
	day := time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)
	items := []planItem{
		{StartAt: day.Add(6 * time.Hour), EndAt: day.Add(7 * time.Hour)},
		{StartAt: day.Add(2 * time.Hour), EndAt: day.Add(3 * time.Hour)},
	}
	start, end := topicCapturePlan(items, day)
	if !start.Equal(day.Add(2*time.Hour-topicCaptureLead)) || !end.Equal(day.Add(7*time.Hour+topicCaptureOverrun)) {
		t.Fatalf("window %v–%v", start, end)
	}
	// A slot that already began is captured from now on.
	if start, _ := topicCapturePlan(items, day.Add(5*time.Hour)); !start.Equal(day.Add(5 * time.Hour)) {
		t.Fatalf("late start = %v", start)
	}
}

func TestDecideTopicScope(t *testing.T) {
	day := time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)
	h := func(n float64) time.Time { return day.Add(time.Duration(n * float64(time.Hour))) }

	// A selected item is running: keep going.
	topics := []models.TranscriptionTopic{
		scopeTopic(0, "done", false, h(1), h(2)),
		scopeTopic(1, "active", true, h(2), h(3)),
		scopeTopic(2, "planned", false, h(3), h(4)),
		scopeTopic(3, "planned", true, h(6), h(7)),
	}
	if d := decideTopicScope(topics, h(2.5)); d.Finish || d.ResumeAt != nil || len(d.Missed) > 0 {
		t.Fatalf("running selected item: %+v", d)
	}

	// The selected item finished on time and the next selected one is hours away: pause
	// until 30 minutes before it.
	topics[1].Status, topics[1].DetectedBy = "done", "announcement"
	topics[2].Status = "active"
	d := decideTopicScope(topics, h(3))
	if d.ResumeAt == nil || !d.ResumeAt.Equal(h(6).Add(-topicCaptureLead)) || d.Next.ID != topics[3].ID {
		t.Fatalf("expected a pause until 14:30: %+v", d)
	}

	// The sitting runs 1.5 hours late: the pause ends 1.5 hours later too.
	if d := decideTopicScope(topics, h(4.5)); d.ResumeAt == nil || !d.ResumeAt.Equal(h(7.5).Add(-topicCaptureLead)) {
		t.Fatalf("delay not carried over: %+v", d.ResumeAt)
	}

	// The next selected item is close: no pause for a short gap.
	topics[3].PlannedStartAt = ptrTime(h(3.3))
	if d := decideTopicScope(topics, h(3)); d.ResumeAt != nil || d.Finish {
		t.Fatalf("short gap should keep the capture running: %+v", d)
	}

	// Everything selected is done: finish.
	topics[3].Status, topics[3].DetectedBy = "done", "announcement"
	topics[2].Status = "done"
	if d := decideTopicScope(topics, h(8)); !d.Finish {
		t.Fatalf("expected finish: %+v", d)
	}
}

func TestDecideTopicScopeMarksPassedItemsMissed(t *testing.T) {
	day := time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)
	h := func(n float64) time.Time { return day.Add(time.Duration(n * float64(time.Hour))) }
	topics := []models.TranscriptionTopic{
		scopeTopic(0, "planned", true, h(1), h(2)), // selected, but the sitting is already past it
		scopeTopic(1, "active", false, h(2), h(3)),
		scopeTopic(2, "planned", true, h(5), h(6)),
	}
	d := decideTopicScope(topics, h(2))
	if len(d.Missed) != 1 || d.Missed[0] != topics[0].ID || d.Next == nil || d.Next.ID != topics[2].ID {
		t.Fatalf("missed = %v next = %+v", d.Missed, d.Next)
	}
	// After marking it missed, it does not count as captured, and the capture waits for item 2.
	topics[0].Status, topics[0].DetectedBy = "done", "missed"
	if d := decideTopicScope(topics, h(2)); d.Finish || d.ResumeAt == nil {
		t.Fatalf("after a miss: %+v", d)
	}
}
