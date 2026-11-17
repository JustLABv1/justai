package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The Bundestag publishes the planned course of each sitting week as a PDF
// ("Geplanter Ablauf der Plenarsitzungen") with a time slot per agenda item.
// Slots are estimates: sittings routinely drift, so they only name the items and
// give a rough order. The real boundaries come from the chair's announcements.

const bundestagAgendaPage = "https://www.bundestag.de/parlament/plenum/tagesordnungen"

// planItem is one agenda item of a sitting.
type planItem struct {
	Key       string    `json:"key"`
	SessionNo int       `json:"sessionNo"`
	Kind      string    `json:"kind"`    // "EPL" (Einzelplan), "TOP" or "ZP"
	Numbers   []int     `json:"numbers"` // 8, 20 for "EPL 08, 20"; Roman TOP numbers are converted
	Label     string    `json:"label"`   // "EPL 08, 20" as published
	Title     string    `json:"title"`
	StartAt   time.Time `json:"startAt"`
	EndAt     time.Time `json:"endAt"`
	Note      string    `json:"note,omitempty"`
}

var (
	planDayHeader = regexp.MustCompile(`^\s*\S+,\s*(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})\s*\((\d+)\.\s*Sitzung\)`)
	planItemLine  = regexp.MustCompile(`^\s*(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})\s*Uhr\s+\d+\s*Min\.\s+(.*)$`)
	planColumns   = regexp.MustCompile(`\s{2,}`)
	planNumberRun = regexp.MustCompile(`^[\d,\s]+$`)
	// Kind, a list of numbers (arabic or upper-case Roman), then any title text.
	planKindLabel = regexp.MustCompile(`^(EPL|TOP|ZP|Zusatzpunkt)\b\s*((?:\d+|[IVXL]+)\b(?:\s*(?:,|und|bis)\s*(?:\d+|[IVXL]+)\b)*,?)\s*(.*)$`)
	planKeyClean  = regexp.MustCompile(`[^a-z0-9]+`)
)

var germanMonths = map[string]time.Month{
	"januar": 1, "februar": 2, "märz": 3, "april": 4, "mai": 5, "juni": 6, "juli": 7,
	"august": 8, "september": 9, "oktober": 10, "november": 11, "dezember": 12,
}

var romanValues = map[rune]int{'I': 1, 'V': 5, 'X': 10, 'L': 50}

func romanToInt(s string) (int, bool) {
	total, prev := 0, 0
	for i := len(s) - 1; i >= 0; i-- {
		v, ok := romanValues[rune(s[i])]
		if !ok {
			return 0, false
		}
		if v < prev {
			total -= v
		} else {
			total += v
			prev = v
		}
	}
	return total, total > 0
}

// parseAgendaNumbers reads "08, 20", "II, III" or "2 a" style number lists.
func parseAgendaNumbers(raw string) []int {
	var out []int
	for _, part := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == ';' }) {
		part = strings.TrimSpace(strings.TrimRight(part, "."))
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

// parseBundestagAblaufplan reads the text of the planned-course PDF (pdftotext -layout).
func parseBundestagAblaufplan(text string) ([]planItem, error) {
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		return nil, err
	}
	var items []planItem
	var day time.Time
	var sessionNo int
	var current *planItem
	var label, title string
	flush := func() {
		if current == nil {
			return
		}
		current.Label, current.Title = strings.TrimSpace(label), strings.TrimSpace(title)
		items = append(items, *current)
		current, label, title = nil, "", ""
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, " \t\r")
		if m := planDayHeader.FindStringSubmatch(line); m != nil {
			flush()
			dayNum, _ := strconv.Atoi(m[1])
			year, _ := strconv.Atoi(m[3])
			month, ok := germanMonths[strings.ToLower(m[2])]
			if !ok {
				continue
			}
			day = time.Date(year, month, dayNum, 0, 0, 0, 0, loc)
			sessionNo, _ = strconv.Atoi(m[4])
			continue
		}
		if day.IsZero() {
			continue
		}
		if m := planItemLine.FindStringSubmatch(line); m != nil {
			flush()
			h1, _ := strconv.Atoi(m[1])
			m1, _ := strconv.Atoi(m[2])
			h2, _ := strconv.Atoi(m[3])
			m2, _ := strconv.Atoi(m[4])
			cols := planColumns.Split(strings.TrimSpace(m[5]), -1)
			// The last column is the slot type (A, Ü, ...), a single short token.
			if len(cols) > 1 && len([]rune(cols[len(cols)-1])) <= 2 {
				cols = cols[:len(cols)-1]
			}
			current = &planItem{SessionNo: sessionNo,
				StartAt: time.Date(day.Year(), day.Month(), day.Day(), h1, m1, 0, 0, loc).UTC(),
				EndAt:   time.Date(day.Year(), day.Month(), day.Day(), h2, m2, 0, 0, loc).UTC()}
			if len(cols) > 0 {
				// "EPL 04, 22 Bundeskanzler ..." may share one column when the numbers are long.
				if km := planKindLabel.FindStringSubmatch(cols[0]); km != nil {
					current.Kind = strings.ToUpper(km[1])
					if current.Kind == "ZUSATZPUNKT" {
						current.Kind = "ZP"
					}
					numbers := strings.TrimRight(strings.TrimSpace(km[2]), ", ")
					label = km[1] + " " + numbers
					current.Numbers = parseAgendaNumbers(numbers)
					cols = cols[1:]
					if rest := strings.TrimSpace(km[3]); rest != "" {
						cols = append([]string{rest}, cols...)
					}
				}
			}
			title = strings.Join(cols, " ")
			continue
		}
		if current == nil {
			continue
		}
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
		case strings.HasPrefix(trimmed, "•"):
			note := strings.TrimSpace(strings.TrimPrefix(trimmed, "•"))
			if current.Note == "" {
				current.Note = note
			} else {
				current.Note += " " + note
			}
		default:
			cols := planColumns.Split(trimmed, -1)
			if len(cols) > 1 && len([]rune(cols[len(cols)-1])) <= 2 {
				cols = cols[:len(cols)-1]
			}
			// A wrapped number column ("03") continues the label; other text continues the title.
			if len(cols) > 0 && planNumberRun.MatchString(cols[0]) {
				label += ", " + strings.TrimSpace(cols[0])
				current.Numbers = append(current.Numbers, parseAgendaNumbers(cols[0])...)
				cols = cols[1:]
			}
			if len(cols) > 0 {
				title += " " + strings.Join(cols, " ")
			}
		}
	}
	flush()
	if len(items) == 0 {
		return nil, fmt.Errorf("no agenda items found in the Bundestag plan")
	}
	seen := map[string]int{}
	for i := range items {
		it := &items[i]
		base := fmt.Sprintf("s%d-%s", it.SessionNo, strings.Trim(planKeyClean.ReplaceAllString(strings.ToLower(it.Label), "-"), "-"))
		if it.Label == "" {
			base = fmt.Sprintf("s%d-%s", it.SessionNo, strings.Trim(planKeyClean.ReplaceAllString(strings.ToLower(it.Title), "-"), "-"))
		}
		seen[base]++
		it.Key = base
		if seen[base] > 1 {
			it.Key = fmt.Sprintf("%s-%d", base, seen[base])
		}
	}
	return items, nil
}

// plenaryItemsForSession returns the items of one sitting, in plan order.
func plenaryItemsForSession(items []planItem, sessionNo int) []planItem {
	var out []planItem
	for _, it := range items {
		if it.SessionNo == sessionNo {
			out = append(out, it)
		}
	}
	return out
}

var ablaufplanLink = regexp.MustCompile(`href="([^"]*Ablaufplan[^"]*\.pdf)"`)

// fetchBundestagAblaufplan downloads the planned-course PDF and extracts its text.
func fetchBundestagAblaufplan(ctx context.Context, client *http.Client) ([]planItem, error) {
	page, err := httpGetLimited(ctx, client, bundestagAgendaPage, 4*1024*1024)
	if err != nil {
		return nil, err
	}
	m := ablaufplanLink.FindSubmatch(page)
	if m == nil {
		return nil, fmt.Errorf("the planned course of the sittings is not published")
	}
	base, _ := url.Parse(bundestagAgendaPage)
	ref, err := url.Parse(string(m[1]))
	if err != nil {
		return nil, fmt.Errorf("the planned course link is invalid")
	}
	pdf, err := httpGetLimited(ctx, client, base.ResolveReference(ref).String(), 8*1024*1024)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, "pdftotext", "-layout", "-enc", "UTF-8", "-", "-")
	cmd.Stdin = bytes.NewReader(pdf)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("the planned course could not be read")
	}
	return parseBundestagAblaufplan(out.String())
}

func httpGetLimited(ctx context.Context, client *http.Client, target string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "JustAI livestream resolver")
	resp, err := client.Do(req)
	if err != nil {
		return nil, livestreamConnectionError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("the Bundestag returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, fmt.Errorf("the Bundestag response could not be read")
	}
	return body, nil
}
