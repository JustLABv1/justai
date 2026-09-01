package server

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"justai-backend/models"
)

const (
	maxAgentWorkflowNodes  = 16
	maxAgentWorkflowDepth  = 8
	maxAgentWorkflowFanout = 4
	maxAgentAttempts       = 3
	maxAgentNodeTimeout    = 10 * time.Minute
	maxAgentRunTimeout     = 30 * time.Minute
	maxAgentApprovalTTL    = 24 * time.Hour
)

var (
	dailySchedulePattern   = regexp.MustCompile(`(?i)^every\s+(?:(\d+)\s+)?days?\s+at\s+(\d{1,2}:\d{2})$`)
	weeklySchedulePattern  = regexp.MustCompile(`(?i)^every\s+(?:(\d+)\s+weeks?\s+on\s+)?([a-z]+)\s+at\s+(\d{1,2}:\d{2})$`)
	monthlySchedulePattern = regexp.MustCompile(`(?i)^every\s+(?:(\d+)\s+months?\s+on\s+day\s+|month\s+on\s+day\s+)(\d{1,2})\s+at\s+(\d{1,2}:\d{2})$`)
	monthlyFirstDayPattern = regexp.MustCompile(`(?i)^every\s+(?:(\d+)\s+)?months?\s+at\s+(\d{1,2}:\d{2})$`)
)

// ValidateAgentWorkflowDefinition validates the intentionally small v1 graph
// language. A workflow is a bounded DAG of typed agent nodes; accepting only
// this shape keeps execution deterministic and makes every run replayable.
func ValidateAgentWorkflowDefinition(definition models.AgentWorkflowDefinition) error {
	if len(definition.Nodes) == 0 {
		return fmt.Errorf("workflow must contain at least one agent node")
	}
	if len(definition.Nodes) > maxAgentWorkflowNodes {
		return fmt.Errorf("workflow cannot contain more than %d nodes", maxAgentWorkflowNodes)
	}
	nodes := make(map[string]models.AgentWorkflowNode, len(definition.Nodes))
	for _, node := range definition.Nodes {
		key := strings.TrimSpace(node.ID)
		if key == "" {
			return fmt.Errorf("workflow node id is required")
		}
		if _, exists := nodes[key]; exists {
			return fmt.Errorf("workflow node %q is duplicated", key)
		}
		nodeType := strings.TrimSpace(strings.ToLower(node.Type))
		if nodeType == "" {
			nodeType = "agent"
		}
		if nodeType != "agent" {
			return fmt.Errorf("workflow node %q has unsupported type %q; only agent nodes are allowed", key, node.Type)
		}
		if strings.TrimSpace(node.Instruction) == "" {
			return fmt.Errorf("workflow node %q requires an instruction", key)
		}
		if len([]rune(node.Instruction)) > 30000 {
			return fmt.Errorf("workflow node %q instruction is too long", key)
		}
		attempts := node.Retry.MaxAttempts
		if attempts == 0 {
			attempts = maxAgentAttempts
		}
		if attempts < 1 || attempts > maxAgentAttempts {
			return fmt.Errorf("workflow node %q retry attempts must be between 1 and %d", key, maxAgentAttempts)
		}
		if node.TimeoutSeconds < 0 || node.TimeoutSeconds > int(maxAgentNodeTimeout/time.Second) {
			return fmt.Errorf("workflow node %q timeout cannot exceed %d seconds", key, int(maxAgentNodeTimeout/time.Second))
		}
		approval := strings.TrimSpace(strings.ToLower(node.ApprovalMode))
		if approval != "" && approval != "review" && approval != "read_only_auto" {
			return fmt.Errorf("workflow node %q has invalid approval mode", key)
		}
		node.ID = key
		node.Type = nodeType
		for _, binding := range node.InputBindings {
			source := strings.TrimSpace(strings.ToLower(binding.Source))
			if source != "input" && source != "node" {
				return fmt.Errorf("workflow node %q has invalid input binding source", key)
			}
			if source == "node" && strings.TrimSpace(binding.NodeID) == "" {
				return fmt.Errorf("workflow node %q has a node binding without a nodeId", key)
			}
		}
		nodes[key] = node
	}
	indegree := make(map[string]int, len(nodes))
	children := make(map[string][]string, len(nodes))
	seenEdges := make(map[string]bool, len(definition.Edges))
	for _, edge := range definition.Edges {
		from, to := strings.TrimSpace(edge.From), strings.TrimSpace(edge.To)
		if from == "" || to == "" {
			return fmt.Errorf("workflow edges require from and to node ids")
		}
		if from == to {
			return fmt.Errorf("workflow cannot contain self-referential edges")
		}
		if _, ok := nodes[from]; !ok {
			return fmt.Errorf("workflow edge references unknown node %q", from)
		}
		if _, ok := nodes[to]; !ok {
			return fmt.Errorf("workflow edge references unknown node %q", to)
		}
		edgeKey := from + "\x00" + to
		if seenEdges[edgeKey] {
			return fmt.Errorf("workflow edge %q -> %q is duplicated", from, to)
		}
		seenEdges[edgeKey] = true
		children[from] = append(children[from], to)
		indegree[to]++
		if len(children[from]) > maxAgentWorkflowFanout {
			return fmt.Errorf("workflow node %q exceeds the fan-out limit of %d", from, maxAgentWorkflowFanout)
		}
	}
	for _, node := range nodes {
		for _, binding := range node.InputBindings {
			if strings.EqualFold(strings.TrimSpace(binding.Source), "node") {
				dependency := strings.TrimSpace(binding.NodeID)
				if _, ok := nodes[dependency]; !ok {
					return fmt.Errorf("workflow node %q binds an unknown node %q", node.ID, dependency)
				}
				if !seenEdges[dependency+"\x00"+node.ID] {
					return fmt.Errorf("workflow node %q binds node %q without a directed edge", node.ID, dependency)
				}
			}
		}
	}
	queue := make([]string, 0, len(nodes))
	depth := make(map[string]int, len(nodes))
	for key := range nodes {
		if indegree[key] == 0 {
			queue = append(queue, key)
			depth[key] = 1
		}
	}
	sort.Strings(queue)
	processed := 0
	for len(queue) > 0 {
		key := queue[0]
		queue = queue[1:]
		processed++
		if depth[key] > maxAgentWorkflowDepth {
			return fmt.Errorf("workflow depth cannot exceed %d nodes", maxAgentWorkflowDepth)
		}
		for _, child := range children[key] {
			if depth[child] < depth[key]+1 {
				depth[child] = depth[key] + 1
			}
			indegree[child]--
			if indegree[child] == 0 {
				queue = append(queue, child)
			}
		}
	}
	if processed != len(nodes) {
		return fmt.Errorf("workflow graph must be acyclic")
	}
	return nil
}

// NormalizeAgentSchedule accepts both the canonical structured form and the
// human-readable schedule strings emitted by the legacy automation builder.
func NormalizeAgentSchedule(schedule models.AgentSchedule) (models.AgentSchedule, error) {
	schedule.Kind = strings.ToLower(strings.TrimSpace(schedule.Kind))
	if schedule.Kind == "" {
		schedule.Kind = "manual"
	}
	if schedule.Kind == "legacy" {
		parsed, err := ParseAgentSchedule(schedule.Display)
		if err != nil {
			return models.AgentSchedule{}, err
		}
		return parsed, nil
	}
	switch schedule.Kind {
	case "manual":
		return models.AgentSchedule{Kind: "manual"}, nil
	case "daily":
		if schedule.Interval == 0 {
			schedule.Interval = 1
		}
		if schedule.Interval < 1 || schedule.Interval > 365 {
			return models.AgentSchedule{}, fmt.Errorf("daily interval must be between 1 and 365")
		}
	case "weekly":
		if schedule.Interval == 0 {
			schedule.Interval = 1
		}
		if schedule.Interval < 1 || schedule.Interval > 52 {
			return models.AgentSchedule{}, fmt.Errorf("weekly interval must be between 1 and 52")
		}
		if schedule.Weekday < 0 || schedule.Weekday > 6 {
			return models.AgentSchedule{}, fmt.Errorf("weekday must be between 0 and 6")
		}
	case "monthly":
		if schedule.Interval == 0 {
			schedule.Interval = 1
		}
		if schedule.Interval < 1 || schedule.Interval > 12 {
			return models.AgentSchedule{}, fmt.Errorf("monthly interval must be between 1 and 12")
		}
		if schedule.Weekday < 1 || schedule.Weekday > 31 {
			return models.AgentSchedule{}, fmt.Errorf("monthly day must be between 1 and 31")
		}
	default:
		return models.AgentSchedule{}, fmt.Errorf("schedule kind must be manual, daily, weekly, or monthly")
	}
	if _, _, err := parseScheduleClock(schedule.Time); err != nil {
		return models.AgentSchedule{}, err
	}
	return schedule, nil
}

func ParseAgentSchedule(display string) (models.AgentSchedule, error) {
	display = strings.TrimSpace(display)
	if display == "" {
		return models.AgentSchedule{Kind: "manual"}, nil
	}
	if matches := dailySchedulePattern.FindStringSubmatch(display); len(matches) > 0 {
		interval := 1
		if matches[1] != "" {
			interval, _ = strconv.Atoi(matches[1])
		}
		if _, _, err := parseScheduleClock(matches[2]); err != nil {
			return models.AgentSchedule{}, err
		}
		return NormalizeAgentSchedule(models.AgentSchedule{Kind: "daily", Interval: interval, Time: matches[2], Display: display})
	}
	if matches := monthlySchedulePattern.FindStringSubmatch(display); len(matches) > 0 {
		interval := 1
		if matches[1] != "" {
			interval, _ = strconv.Atoi(matches[1])
		}
		day, _ := strconv.Atoi(matches[2])
		return NormalizeAgentSchedule(models.AgentSchedule{Kind: "monthly", Interval: interval, Weekday: day, Time: matches[3], Display: display})
	}
	// The legacy builder represented "on the first day" as
	// "Every N months at HH:MM". Normalize that compatibility form to an
	// explicit monthly day so the canonical scheduler can replay it.
	if matches := monthlyFirstDayPattern.FindStringSubmatch(display); len(matches) > 0 {
		interval := 1
		if matches[1] != "" {
			interval, _ = strconv.Atoi(matches[1])
		}
		return NormalizeAgentSchedule(models.AgentSchedule{Kind: "monthly", Interval: interval, Weekday: 1, Time: matches[2], Display: display})
	}
	if matches := weeklySchedulePattern.FindStringSubmatch(display); len(matches) > 0 {
		interval := 1
		if matches[1] != "" {
			interval, _ = strconv.Atoi(matches[1])
		}
		weekday, err := parseScheduleWeekday(matches[2])
		if err != nil {
			return models.AgentSchedule{}, err
		}
		return NormalizeAgentSchedule(models.AgentSchedule{Kind: "weekly", Interval: interval, Weekday: weekday, Time: matches[3], Display: display})
	}
	return models.AgentSchedule{}, fmt.Errorf("schedule must use daily, weekly, or monthly recurrence")
}

func parseScheduleClock(value string) (hour, minute int, err error) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("schedule time must use HH:MM")
	}
	hour, err = strconv.Atoi(parts[0])
	if err != nil || hour < 0 || hour > 23 {
		return 0, 0, fmt.Errorf("schedule hour must be between 00 and 23")
	}
	minute, err = strconv.Atoi(parts[1])
	if err != nil || minute < 0 || minute > 59 {
		return 0, 0, fmt.Errorf("schedule minute must be between 00 and 59")
	}
	return hour, minute, nil
}

func parseScheduleWeekday(value string) (int, error) {
	for index, name := range []string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"} {
		if strings.EqualFold(strings.TrimSpace(value), name) {
			return index, nil
		}
	}
	return 0, fmt.Errorf("unknown schedule weekday %q", value)
}

// NextAgentScheduleTime returns the next local occurrence after the supplied
// instant. The result is converted back to UTC for persistence.
func NextAgentScheduleTime(schedule models.AgentSchedule, timezone string, after time.Time) (time.Time, error) {
	schedule, err := NormalizeAgentSchedule(schedule)
	if err != nil {
		return time.Time{}, err
	}
	if schedule.Kind == "manual" {
		return time.Time{}, nil
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, fmt.Errorf("timezone must be a valid IANA timezone: %w", err)
	}
	localAfter := after.In(location)
	hour, minute, _ := parseScheduleClock(schedule.Time)
	date := time.Date(localAfter.Year(), localAfter.Month(), localAfter.Day(), hour, minute, 0, 0, location)
	if scheduleOccurrenceMatches(date, localAfter, schedule) {
		return scheduleOccurrenceAfter(date, schedule, hour, minute, location).UTC(), nil
	}
	if !date.After(localAfter) {
		date = date.AddDate(0, 0, 1)
	}
	switch schedule.Kind {
	case "daily":
		for date.Sub(localAfter) <= 0 || date.Sub(localAfter) > time.Duration(schedule.Interval)*24*time.Hour+time.Minute {
			date = date.AddDate(0, 0, 1)
		}
	case "weekly":
		days := (schedule.Weekday - int(date.Weekday()) + 7) % 7
		date = date.AddDate(0, 0, days)
		if !date.After(localAfter) {
			date = date.AddDate(0, 0, 7*schedule.Interval)
		}
	case "monthly":
		date = monthlyScheduleDate(date.Year(), date.Month(), schedule.Weekday, hour, minute, location)
		if !date.After(localAfter) {
			month := date.AddDate(0, schedule.Interval, 0)
			date = monthlyScheduleDate(month.Year(), month.Month(), schedule.Weekday, hour, minute, location)
		}
	}
	return date.UTC(), nil
}

func scheduleOccurrenceMatches(candidate, after time.Time, schedule models.AgentSchedule) bool {
	if candidate.Year() != after.Year() || candidate.Month() != after.Month() || candidate.Day() != after.Day() || candidate.Hour() != after.Hour() || candidate.Minute() != after.Minute() {
		return false
	}
	switch schedule.Kind {
	case "daily":
		return true
	case "weekly":
		return int(candidate.Weekday()) == schedule.Weekday
	case "monthly":
		return candidate.Day() == schedule.Weekday || candidate.Day() == monthlyScheduleDate(candidate.Year(), candidate.Month(), schedule.Weekday, candidate.Hour(), candidate.Minute(), candidate.Location()).Day()
	default:
		return false
	}
}

func scheduleOccurrenceAfter(previous time.Time, schedule models.AgentSchedule, hour, minute int, location *time.Location) time.Time {
	switch schedule.Kind {
	case "daily":
		return time.Date(previous.Year(), previous.Month(), previous.Day(), hour, minute, 0, 0, location).AddDate(0, 0, schedule.Interval)
	case "weekly":
		return time.Date(previous.Year(), previous.Month(), previous.Day(), hour, minute, 0, 0, location).AddDate(0, 0, 7*schedule.Interval)
	case "monthly":
		month := previous.AddDate(0, schedule.Interval, 0)
		return monthlyScheduleDate(month.Year(), month.Month(), schedule.Weekday, hour, minute, location)
	default:
		return previous
	}
}

func monthlyScheduleDate(year int, month time.Month, day, hour, minute int, location *time.Location) time.Time {
	firstNext := time.Date(year, month+1, 1, 0, 0, 0, 0, location)
	lastDay := firstNext.Add(-24 * time.Hour).Day()
	if day > lastDay {
		day = lastDay
	}
	return time.Date(year, month, day, hour, minute, 0, 0, location)
}
