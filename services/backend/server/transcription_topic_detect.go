package server

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// topicRef is what the detector needs to know about an agenda item.
type topicRef struct {
	ID      uuid.UUID
	Kind    string // EPL, TOP or ZP
	Numbers []int
	Title   string
	Status  string // planned, active, done
}

var (
	// The chair calls an item up with "Ich rufe ... auf" or "Wir kommen zu ...". Word
	// boundaries keep "Zwischenrufe" and "rufen" from counting.
	topicTrigger = regexp.MustCompile(`\b(rufe|rufen\s+wir|kommen\s+wir\s+(?:nun\s+|jetzt\s+)?zu|wir\s+kommen\s+(?:nun\s+|jetzt\s+)?zu|treten\s+wir\s+ein)\b`)
	topicEPL     = regexp.MustCompile(`\beinzelpl(?:an|ans|äne|änen)\s+((?:\d{1,2}(?:\s*(?:,|und|bis)\s*)?)+)`)
	topicTOP     = regexp.MustCompile(`\b(?:tagesordnungspunkt(?:e|en)?|top)\s+((?:\d+|[ivx]+)\b(?:\s*[a-z]\b)?(?:\s*(?:,|und|bis)\s*(?:\d+|[ivx]+)\b(?:\s*[a-z]\b)?)*)`)
	topicZP      = regexp.MustCompile(`\bzusatzpunkt(?:e|en)?\s+((?:\d+)\b(?:\s*[a-z]\b)?(?:\s*(?:,|und|bis)\s*\d+\b(?:\s*[a-z]\b)?)*)`)
	topicClose   = regexp.MustCompile(`\b(ich\s+schließe\s+die\s+sitzung|die\s+sitzung\s+ist\s+geschlossen|schließe\s+ich\s+die\s+sitzung)\b`)
	topicWords   = regexp.MustCompile(`[a-zäöüß]{5,}`)
)

// Common words that carry no topic meaning in an agenda title.
var topicStopwords = map[string]bool{
	"nukleare": true, "sicherheit": false, "bundesministeriums": true, "bundesministerium": true,
	"geschäftsbereich": true, "beratung": true, "entwurf": true, "gesetz": false, "deutschen": true,
	"bundestag": false, "bundestages": false, "unabhängiger": false, "sowie": true, "dritte": true, "zweite": true,
}

func intersects(a, b []int) bool {
	for _, x := range a {
		for _, y := range b {
			if x == y {
				return true
			}
		}
	}
	return false
}

// listNumbers reads "08 und 20", "2 a bis 2 c" or "II, III" into numbers.
func listNumbers(raw string) []int {
	var out []int
	for _, part := range regexp.MustCompile(`[^0-9a-z]+`).Split(strings.ToLower(raw), -1) {
		if part == "" {
			continue
		}
		if n, err := strconv.Atoi(part); err == nil {
			out = append(out, n)
		} else if n, ok := romanToInt(strings.ToUpper(part)); ok {
			out = append(out, n)
		}
	}
	return out
}

func titleTokens(title string) []string {
	var out []string
	for _, w := range topicWords.FindAllString(strings.ToLower(title), -1) {
		if topicStopwords[w] {
			continue
		}
		out = append(out, w)
	}
	return out
}

// detectTopicAnnouncement finds which unfinished agenda item the chair just called up.
// It returns the index into topics, or -1. Items already done are never matched again,
// which keeps a repeated mention (for example after a recess) from reopening them.
func detectTopicAnnouncement(text string, topics []topicRef) int {
	lower := strings.ToLower(text)
	if !topicTrigger.MatchString(lower) {
		return -1
	}
	var epl, top, zp []int
	if m := topicEPL.FindStringSubmatch(lower); m != nil {
		epl = listNumbers(m[1])
	}
	if m := topicTOP.FindStringSubmatch(lower); m != nil {
		top = listNumbers(m[1])
	}
	if m := topicZP.FindStringSubmatch(lower); m != nil {
		zp = listNumbers(m[1])
	}
	for i, t := range topics {
		if t.Status == "done" {
			continue
		}
		switch {
		case t.Kind == "EPL" && intersects(epl, t.Numbers),
			t.Kind == "TOP" && intersects(top, t.Numbers),
			t.Kind == "ZP" && intersects(zp, t.Numbers):
			return i
		}
	}
	if len(epl)+len(top)+len(zp) > 0 {
		return -1 // named by number, but not an item of this plan
	}
	// No number given: fall back to the item's title words ("Geschäftsbereich ... Verkehr").
	best, bestScore := -1, 0.0
	for i, t := range topics {
		if t.Status == "done" {
			continue
		}
		tokens := titleTokens(t.Title)
		if len(tokens) == 0 {
			continue
		}
		hits := 0
		for _, w := range tokens {
			if strings.Contains(lower, w) {
				hits++
			}
		}
		score := float64(hits) / float64(len(tokens))
		enough := hits >= 2 && score >= 0.6
		if len(tokens) == 1 && hits == 1 && (strings.Contains(lower, "geschäftsbereich") || strings.Contains(lower, "einzelplan")) {
			enough = true
		}
		if enough && score > bestScore {
			best, bestScore = i, score
		}
	}
	return best
}

// isSittingClosed reports the chair closing the whole sitting.
func isSittingClosed(text string) bool {
	return topicClose.MatchString(strings.ToLower(text))
}

// mightAnnounceTopic is a cheap pre-check so ordinary speech never touches the database.
func mightAnnounceTopic(text string) bool {
	lower := strings.ToLower(text)
	return topicTrigger.MatchString(lower) || topicClose.MatchString(lower)
}
