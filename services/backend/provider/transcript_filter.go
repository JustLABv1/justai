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

const (
	minimumRepeatedPhraseCopies = 8
	minimumRepeatedWordCount    = 16
	minimumRepeatedSingleWords  = 12
	maximumRepeatedPhraseWords  = 8
)

// SanitizeTranscriptRepetition removes only pathological, exact word loops
// from a provider response. Normal speech such as "yes, yes, yes" remains
// untouched because the threshold is deliberately high. The caller should
// retain the original provider response separately when using this function.
func SanitizeTranscriptRepetition(value string) string {
	words := strings.Fields(value)
	if len(words) < minimumRepeatedSingleWords {
		return value
	}

	normalized := make([]string, len(words))
	for index, word := range words {
		normalized[index] = normalizeRepeatedTranscriptWord(word)
	}

	bestStart := -1
	bestEnd := -1
	bestSpan := 0
	bestPhraseLength := 0
	for start := 0; start < len(words); start++ {
		for phraseLength := 1; phraseLength <= maximumRepeatedPhraseWords; phraseLength++ {
			if start+phraseLength*minimumRepeatedPhraseCopies > len(words) {
				break
			}
			if !hasRepeatedPhraseContent(normalized[start : start+phraseLength]) {
				continue
			}

			copies := repeatedPhraseCopies(normalized, start, phraseLength)
			minimumCopies := minimumRepeatedPhraseCopies
			minimumWords := minimumRepeatedWordCount
			if phraseLength == 1 {
				minimumCopies = minimumRepeatedSingleWords
				minimumWords = minimumRepeatedSingleWords
			}
			if copies < minimumCopies || copies*phraseLength < minimumWords {
				continue
			}

			span := copies * phraseLength
			if span > bestSpan {
				bestStart = start
				bestEnd = start + span
				bestSpan = span
				bestPhraseLength = phraseLength
			}
		}
	}
	if bestStart < 0 {
		return value
	}

	// Keep two copies so a real repeated phrase is not erased wholesale while
	// the pathological loop is reduced to a readable trace of what was heard.
	keepEnd := bestStart + minInt(2*bestPhraseLength, bestEnd-bestStart)
	cleaned := make([]string, 0, len(words)-bestSpan+2*bestPhraseLength)
	cleaned = append(cleaned, words[:keepEnd]...)
	cleaned = append(cleaned, words[bestEnd:]...)
	return strings.Join(cleaned, " ")
}

func repeatedPhraseCopies(words []string, start, phraseLength int) int {
	if phraseLength <= 0 || start < 0 || start+phraseLength > len(words) {
		return 0
	}
	copies := 1
	for next := start + phraseLength; next+phraseLength <= len(words); next += phraseLength {
		if !sameTranscriptWords(words[start:start+phraseLength], words[next:next+phraseLength]) {
			break
		}
		copies++
	}
	return copies
}

func sameTranscriptWords(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] == "" || left[index] != right[index] {
			return false
		}
	}
	return true
}

func hasRepeatedPhraseContent(words []string) bool {
	for _, word := range words {
		if len([]rune(word)) >= 4 {
			return true
		}
	}
	return false
}

func normalizeRepeatedTranscriptWord(value string) string {
	var builder strings.Builder
	for _, char := range strings.ToLower(value) {
		if unicode.IsLetter(char) || unicode.IsNumber(char) {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
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
