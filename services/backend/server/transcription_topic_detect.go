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

// Words the chair puts between "wir kommen" and "zu".
const topicCallFillers = `(?:(?:nun|jetzt|damit|dann|nunmehr|zunächst|abschließend|als\s+nächstes)\s+)*`

var (
	// The chair calls an item up with "Ich rufe ... auf" or "Wir kommen zu ...". Word
	// boundaries keep "Zwischenrufe" and "rufen" from counting.
	// "Wir kommen jetzt zum Einzelplan 17" and "Kommen wir damit zur ..." count too.
	topicTrigger = regexp.MustCompile(`(?i)\b((?:ich\s+)?rufe|rufen\s+wir|(?:kommen\s+wir|wir\s+kommen)\s+` + topicCallFillers + `(?:zu|zum|zur)|treten\s+wir\s+ein)\b`)
	// A vote on an item ("Wir kommen zur Abstimmung über den Einzelplan 10") ends it.
	topicVote = regexp.MustCompile(`^[[:punct:]\s]*abstimmung\b`)
	topicEPL  = regexp.MustCompile(`\beinzelpl(?:an|ans|äne|änen)\s+((?:\d{1,2}(?:\s*(?:,|und|bis)\s*)?)+)`)
	topicTOP  = regexp.MustCompile(`\b(?:tagesordnungspunkt(?:e|en)?|top)\s+((?:\d+|[ivx]+)\b(?:\s*[a-z]\b)?(?:\s*(?:,|und|bis)\s*(?:\d+|[ivx]+)\b(?:\s*[a-z]\b)?)*)`)
	topicZP   = regexp.MustCompile(`\bzusatzpunkt(?:e|en)?\s+((?:\d+)\b(?:\s*[a-z]\b)?(?:\s*(?:,|und|bis)\s*\d+\b(?:\s*[a-z]\b)?)*)`)
	// The chair closes the sitting ("Ich schließe die Sitzung"), says the agenda is done
	// ("Wir sind nun am Ende unserer heutigen Tagesordnung") or calls the next sitting
	// ("Ich berufe die nächste Sitzung ... ein"). Speech recognition often writes
	// "Tagesordnungspunkt" for "Tagesordnung" and "rufe" for "berufe".
	topicClose = regexp.MustCompile(`\b(ich\s+schließe\s+die\s+sitzung|die\s+sitzung\s+ist\s+geschlossen|schließe\s+ich\s+die\s+sitzung|(?:wir\s+sind|sind\s+wir)\s+(?:(?:nun|jetzt|damit|somit)\s+)*am\s+(?:ende|schluss)\s+(?:unserer|der)\s+(?:heutigen\s+)?tagesordnung\w*|(?:die\s+)?tagesordnung\s+ist\s+(?:(?:damit|somit|nun)\s+)*(?:erschöpft|abgearbeitet|erledigt)|(?:be)?rufe\s+(?:ich\s+)?(?:die\s+)?nächste\s+sitzung|nächste\s+sitzung\s+(?:des\s+deutschen\s+bundestages\s+)?berufe\s+ich)`)
	topicWords = regexp.MustCompile(`[a-zäöüß]{5,}`)
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

// Providers may finalize the chair's introductory phrase before the item number.
// Carry only an unfinished call, never a whole preceding speech.
var unfinishedTopicCall = regexp.MustCompile(`(?i)\b(?:ich\s+rufe|wir\s+kommen|kommen\s+wir)(?:[[:punct:]\s]+(?:jetzt|nun|damit|dann|nunmehr|auf|zu|zum|zur|den|die|das|dem|einzelplan|einzelplänen|tagesordnungspunkt|zusatzpunkt))*[[:punct:]\s]*$`)

type topicCallBuffer struct {
	text  string
	endMs int64
}

func (b *topicCallBuffer) candidate(text string, startMs, endMs int64) string {
	candidate := text
	if b.text != "" && startMs <= b.endMs+10000 && !topicTrigger.MatchString(text) {
		candidate = b.text + " " + text
	}
	b.text = ""
	if suffix := unfinishedTopicCall.FindString(candidate); suffix != "" && len(suffix) <= 160 {
		b.text = suffix
		b.endMs = endMs
	}
	return candidate
}

// detectTopicAnnouncement finds which unfinished agenda item the chair just called up.
// It returns the index into topics, or -1. Items already done are never matched again,
// which keeps a repeated mention (for example after a recess) from reopening them.
func detectTopicAnnouncement(text string, topics []topicRef) int {
	lower := strings.ToLower(text)
	calls := topicTrigger.FindAllStringIndex(lower, -1)
	if len(calls) == 0 {
		return -1
	}
	// Only what follows the last call names the item; earlier words belong to the
	// previous item (for example the vote that just closed it).
	lower = lower[calls[len(calls)-1][1]:]
	if topicVote.MatchString(lower) {
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
