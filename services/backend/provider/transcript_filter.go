package provider

import (
	"strings"
	"unicode"
)

var nonSpeechTranscriptMarkers = map[string]struct{}{
	"applause":         {},
	"atem":             {},
	"atmen":            {},
	"background noise": {},
	"blank audio":      {},
	"breath":           {},
	"breathing":        {},
	"click":            {},
	"cough":            {},
	"coughing":         {},
	"disk":             {},
	"geräusch":         {},
	"hust":             {},
	"husten":           {},
	"inaudible":        {},
	"klick":            {},
	"laughter":         {},
	"laughing":         {},
	"music":            {},
	"noise":            {},
	"puh":              {},
	"räusper":          {},
	"räuspern":         {},
	"seufz":            {},
	"seufzen":          {},
	"silence":          {},
	"sound":            {},
	"stille":           {},
	"unhörbar":         {},
	"unintelligible":   {},
	"unverständlich":   {},
}

// CleanTranscriptText removes provider artifacts that are not spoken content.
// Whisper-style models commonly emit punctuation for silence and wrap detected
// room sounds in markers such as *puh* or [BLANK_AUDIO]. The wrapper check is
// intentionally narrow so ordinary one-word utterances like "Ja" or "Nein"
// are not discarded.
func CleanTranscriptText(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || !containsTranscriptWord(trimmed) {
		return ""
	}

	inner, _, wrapped := unwrapTranscriptMarker(trimmed)
	if wrapped {
		marker := normalizeTranscriptMarker(inner)
		if _, ok := nonSpeechTranscriptMarkers[marker]; ok {
			return ""
		}
	}
	return value
}

func containsTranscriptWord(value string) bool {
	for _, char := range value {
		if unicode.IsLetter(char) || unicode.IsNumber(char) {
			return true
		}
	}
	return false
}

func unwrapTranscriptMarker(value string) (string, string, bool) {
	if len(value) < 2 {
		return "", "", false
	}
	wrappers := []struct {
		open  string
		close string
	}{
		{open: "*", close: "*"},
		{open: "_", close: "_"},
		{open: "[", close: "]"},
		{open: "(", close: ")"},
		{open: "{", close: "}"},
		{open: "`", close: "`"},
	}
	for _, wrapper := range wrappers {
		if strings.HasPrefix(value, wrapper.open) && strings.HasSuffix(value, wrapper.close) {
			inner := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(value, wrapper.open), wrapper.close))
			if inner != "" {
				return inner, wrapper.open, true
			}
		}
	}
	return "", "", false
}

func normalizeTranscriptMarker(value string) string {
	var builder strings.Builder
	previousSpace := false
	for _, char := range strings.ToLower(value) {
		if unicode.IsLetter(char) || unicode.IsNumber(char) {
			builder.WriteRune(char)
			previousSpace = false
			continue
		}
		if !previousSpace {
			builder.WriteByte(' ')
			previousSpace = true
		}
	}
	return strings.TrimSpace(builder.String())
}
