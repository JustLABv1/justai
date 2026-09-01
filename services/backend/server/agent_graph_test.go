package server

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"justai-backend/models"
)

func testAgentNode(id string) models.AgentWorkflowNode {
	return models.AgentWorkflowNode{ID: id, Type: "agent", Instruction: "Complete the assigned task."}
}

func TestValidateAgentWorkflowDefinitionAcceptsParallelFanIn(t *testing.T) {
	definition := models.AgentWorkflowDefinition{
		Nodes: []models.AgentWorkflowNode{testAgentNode("research-a"), testAgentNode("research-b"), testAgentNode("summarize")},
		Edges: []models.AgentWorkflowEdge{{From: "research-a", To: "summarize"}, {From: "research-b", To: "summarize"}},
	}
	if err := ValidateAgentWorkflowDefinition(definition); err != nil {
		t.Fatalf("expected parallel/fan-in graph to validate: %v", err)
	}
}

func TestValidateAgentWorkflowDefinitionRejectsCyclesAndUnboundedShape(t *testing.T) {
	cycle := models.AgentWorkflowDefinition{
		Nodes: []models.AgentWorkflowNode{testAgentNode("a"), testAgentNode("b")},
		Edges: []models.AgentWorkflowEdge{{From: "a", To: "b"}, {From: "b", To: "a"}},
	}
	if err := ValidateAgentWorkflowDefinition(cycle); err == nil {
		t.Fatal("expected cycle to be rejected")
	}

	tooManyChildren := models.AgentWorkflowDefinition{Nodes: []models.AgentWorkflowNode{testAgentNode("root")}}
	for index := 0; index < maxAgentWorkflowFanout+1; index++ {
		child := testAgentNode("child-" + uuid.NewString())
		tooManyChildren.Nodes = append(tooManyChildren.Nodes, child)
		tooManyChildren.Edges = append(tooManyChildren.Edges, models.AgentWorkflowEdge{From: "root", To: child.ID})
	}
	if err := ValidateAgentWorkflowDefinition(tooManyChildren); err == nil {
		t.Fatal("expected fan-out limit to be enforced")
	}

	missingDependencyEdge := models.AgentWorkflowDefinition{
		Nodes: []models.AgentWorkflowNode{
			{ID: "source", Type: "agent", Instruction: "Collect facts."},
			{ID: "summary", Type: "agent", Instruction: "Summarize.", InputBindings: []models.AgentInputBinding{{Name: "facts", Source: "node", NodeID: "source"}}},
		},
	}
	if err := ValidateAgentWorkflowDefinition(missingDependencyEdge); err == nil {
		t.Fatal("expected node binding without an edge to be rejected")
	}
}

func TestAgentScheduleParsingAndTimezone(t *testing.T) {
	schedule, err := ParseAgentSchedule("Every 2 weeks on Monday at 09:30")
	if err != nil {
		t.Fatalf("parse weekly schedule: %v", err)
	}
	if schedule.Kind != "weekly" || schedule.Interval != 2 || schedule.Weekday != 1 || schedule.Time != "09:30" {
		t.Fatalf("unexpected normalized schedule: %+v", schedule)
	}

	after := time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC)
	next, err := NextAgentScheduleTime(schedule, "Europe/Berlin", after)
	if err != nil {
		t.Fatalf("calculate next occurrence: %v", err)
	}
	local := next.In(time.FixedZone("CET", 1*60*60))
	if local.Weekday() != time.Monday || local.Hour() != 9 || local.Minute() != 30 {
		t.Fatalf("unexpected next occurrence: %s", next)
	}
}

func TestAgentScheduleRejectsInvalidTimezoneAndClock(t *testing.T) {
	if _, err := NormalizeAgentSchedule(models.AgentSchedule{Kind: "daily", Time: "25:00"}); err == nil {
		t.Fatal("expected invalid clock to be rejected")
	}
	if _, err := NextAgentScheduleTime(models.AgentSchedule{Kind: "daily", Time: "09:00"}, "Not/AnIanaZone", time.Now()); err == nil {
		t.Fatal("expected invalid timezone to be rejected")
	}
}

func TestAgentScheduleCompatibilityAndIntervals(t *testing.T) {
	schedule, err := ParseAgentSchedule("Every 2 months at 09:00")
	if err != nil {
		t.Fatalf("parse legacy first-day monthly schedule: %v", err)
	}
	if schedule.Kind != "monthly" || schedule.Interval != 2 || schedule.Weekday != 1 {
		t.Fatalf("unexpected monthly compatibility schedule: %+v", schedule)
	}

	first := time.Date(2026, time.January, 2, 12, 0, 0, 0, time.UTC)
	daily := models.AgentSchedule{Kind: "daily", Interval: 2, Time: "09:00"}
	due, err := NextAgentScheduleTime(daily, "UTC", first)
	if err != nil {
		t.Fatalf("calculate first daily occurrence: %v", err)
	}
	next, err := NextAgentScheduleTime(daily, "UTC", due)
	if err != nil {
		t.Fatalf("calculate interval daily occurrence: %v", err)
	}
	if next.Sub(due) != 48*time.Hour {
		t.Fatalf("expected a two-day interval, got %s", next.Sub(due))
	}
}

func TestNodeInputResolvesScopedBindings(t *testing.T) {
	firstID := uuid.New()
	run := models.AgentRun{
		Input: json.RawMessage(`{"request":{"topic":"agents"},"items":["a","b"]}`),
		Nodes: []models.AgentRunNode{{NodeKey: "research", Status: "completed", Output: json.RawMessage(`{"answer":{"text":"hello"},"sources":["one"]}`), ID: firstID}},
	}
	node := models.AgentWorkflowNode{
		ID: "summarize",
		InputBindings: []models.AgentInputBinding{
			{Name: "topic", Source: "INPUT", Path: "request.topic"},
			{Name: "answer", Source: "node", NodeID: "research", Path: "answer.text"},
		},
	}
	definition := models.AgentWorkflowDefinition{Nodes: []models.AgentWorkflowNode{{ID: "research"}, node}, Edges: []models.AgentWorkflowEdge{{From: "research", To: "summarize"}}}
	encoded := nodeInput(run, definition, node)
	var value struct {
		Bindings map[string]any `json:"bindings"`
	}
	if err := json.Unmarshal(encoded, &value); err != nil {
		t.Fatalf("decode scoped node input: %v", err)
	}
	if value.Bindings["topic"] != "agents" || value.Bindings["answer"] != "hello" {
		t.Fatalf("unexpected scoped bindings: %#v", value.Bindings)
	}
}
