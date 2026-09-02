package server

import (
	"encoding/json"
	"strings"

	"justai-backend/provider"
)

const (
	// Pagination often needs more than the old four model/tool exchanges. Keep
	// a hard ceiling so a provider cannot turn a single request into an
	// unbounded loop, while allowing a progressing read to make several pages.
	maxChatToolRounds = 16
	// A tool that keeps returning the same result (or keeps failing) is not
	// making progress. Two such rounds are enough to give the model one retry
	// opportunity without repeatedly hammering an MCP server.
	maxChatToolStalledRounds = 2
)

type chatToolLoopStopReason uint8

const (
	chatToolLoopContinue chatToolLoopStopReason = iota
	chatToolLoopStalled
	chatToolLoopFailed
)

type chatToolLoopOutcome struct {
	call      provider.ToolCall
	arguments map[string]any
	result    string
	failed    bool
}

type chatToolLoopObservation struct {
	result string
	failed bool
}

type chatToolLoopGuard struct {
	observations       map[string]chatToolLoopObservation
	stalledRounds      int
	lastRoundAllFailed bool
}

func (guard *chatToolLoopGuard) stopReason() chatToolLoopStopReason {
	if guard.stalledRounds < maxChatToolStalledRounds {
		return chatToolLoopContinue
	}
	if guard.lastRoundAllFailed {
		return chatToolLoopFailed
	}
	return chatToolLoopStalled
}

// newChatToolLoopGuard restores the observations belonging to the current
// user turn. This matters for Assistant UI approval continuations: each
// approval is a new HTTP request, but it is still part of the same tool loop.
func newChatToolLoopGuard(history []provider.ToolMessage) *chatToolLoopGuard {
	guard := &chatToolLoopGuard{observations: map[string]chatToolLoopObservation{}}
	lastUser := -1
	for index, message := range history {
		if message.Role == "user" {
			lastUser = index
		}
	}
	if lastUser < 0 {
		return guard
	}

	var pending map[string]provider.ToolCall
	var roundOutcomes []chatToolLoopOutcome
	flushRound := func() {
		if len(roundOutcomes) == 0 {
			return
		}
		// The persisted history does not expose the stop reason to this helper;
		// the accumulated observations and stall count are what matter when the
		// live loop resumes.
		_ = guard.observeRound(roundOutcomes)
		roundOutcomes = nil
	}
	for _, message := range history[lastUser+1:] {
		if message.Role == "assistant" && len(message.ToolCalls) > 0 {
			flushRound()
			pending = map[string]provider.ToolCall{}
			for _, call := range message.ToolCalls {
				if call.ID != "" {
					pending[call.ID] = call
				}
			}
			continue
		}
		if message.Role != "tool" || message.ToolCallID == "" || pending == nil {
			if message.Role != "tool" {
				flushRound()
				pending = nil
			}
			continue
		}
		call, ok := pending[message.ToolCallID]
		if !ok {
			continue
		}
		arguments := map[string]any{}
		if strings.TrimSpace(call.Arguments) != "" {
			if err := json.Unmarshal([]byte(call.Arguments), &arguments); err != nil {
				arguments = nil
			}
		}
		roundOutcomes = append(roundOutcomes, chatToolLoopOutcome{
			call:      call,
			arguments: arguments,
			result:    message.Content,
			failed:    chatToolLoopHistoryResultFailed(message.Content),
		})
		delete(pending, message.ToolCallID)
	}
	flushRound()
	return guard
}

// observeRound evaluates a complete model/tool exchange. A changed argument
// set is progress even when the tool name stays the same (the usual cursor
// pagination case). A stable invocation with a changed result is also
// progress because some MCP servers advance pagination server-side.
func (guard *chatToolLoopGuard) observeRound(outcomes []chatToolLoopOutcome) chatToolLoopStopReason {
	if len(outcomes) == 0 {
		return chatToolLoopContinue
	}

	progressed := false
	allFailed := true
	for _, outcome := range outcomes {
		if !outcome.failed {
			allFailed = false
		}
		key := chatToolLoopCallKeyForArguments(outcome.call.Name, outcome.arguments)
		previous, seen := guard.observations[key]
		current := chatToolLoopObservation{
			result: canonicalChatToolLoopResult(outcome.result),
			failed: outcome.failed,
		}
		if !seen || previous != current {
			progressed = true
		}
	}

	if progressed {
		guard.stalledRounds = 0
	} else {
		guard.stalledRounds++
	}
	guard.lastRoundAllFailed = allFailed
	for _, outcome := range outcomes {
		key := chatToolLoopCallKeyForArguments(outcome.call.Name, outcome.arguments)
		guard.observations[key] = chatToolLoopObservation{
			result: canonicalChatToolLoopResult(outcome.result),
			failed: outcome.failed,
		}
	}

	return guard.stopReason()
}

func chatToolLoopCallKey(name, rawArguments string) string {
	return name + "\x00" + canonicalChatToolLoopArguments(rawArguments)
}

func chatToolLoopCallKeyForArguments(name string, arguments map[string]any) string {
	if arguments == nil {
		return chatToolLoopCallKey(name, "{}")
	}
	encoded, err := json.Marshal(arguments)
	if err != nil {
		return chatToolLoopCallKey(name, "")
	}
	return chatToolLoopCallKey(name, string(encoded))
}

func canonicalChatToolLoopArguments(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "{}"
	}
	return canonicalChatToolLoopJSON(trimmed)
}

func canonicalChatToolLoopResult(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	// The provider-facing history prefixes execution errors, while persisted
	// chat tool events keep only the raw error. Compare their useful payload so
	// an approval continuation sees the same failed call as the original turn.
	lower := strings.ToLower(trimmed)
	for _, prefix := range []string{"the mcp tool failed:", "the tool failed:"} {
		if strings.HasPrefix(lower, prefix) {
			trimmed = strings.TrimSpace(trimmed[len(prefix):])
			break
		}
	}
	return canonicalChatToolLoopJSON(trimmed)
}

func canonicalChatToolLoopJSON(raw string) string {
	var value any
	if json.Unmarshal([]byte(raw), &value) != nil {
		return raw
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return raw
	}
	return string(encoded)
}

func chatToolLoopHistoryResultFailed(result string) bool {
	trimmed := strings.ToLower(strings.TrimSpace(result))
	for _, prefix := range []string{
		"the mcp tool failed:",
		"the tool failed:",
		"the tool arguments were invalid json.",
		"the requested tool is not available.",
		"the requested tool is not allowlisted.",
	} {
		if strings.HasPrefix(trimmed, prefix) {
			return true
		}
	}
	return false
}

func chatToolLoopStopMessage(reason chatToolLoopStopReason) string {
	switch reason {
	case chatToolLoopFailed:
		return "\n\nI stopped because the MCP tool kept failing. The latest error is shown above."
	case chatToolLoopStalled:
		return "\n\nI stopped because the tool returned the same result repeatedly. The latest tool output is shown above."
	default:
		return ""
	}
}
