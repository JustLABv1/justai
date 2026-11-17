package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // the plan is published in Berlin time; containers may lack tzdata

	"golang.org/x/net/html"
	"justai-backend/streamrelay"
)

// The Bundestag publishes its plenary schedule on the live page. Sessions often
// start a little late and routinely run long, so a capture window opens before
// the announced start and closes well after the announced end.
const (
	bundestagLiveURL    = "https://www.bundestag.de/mediathek/live"
	planWindowLead      = 15 * time.Minute
	planWindowOverrun   = 3 * time.Hour
	planFallbackStartIn = 10 * time.Minute // start without speech confirmation this long after the announced start
)

// planSession is one announced session with the capture window derived from it.
type planSession struct {
	Key           string    `json:"key"`
	Title         string    `json:"title"`
	StartAt       time.Time `json:"startAt"`
	EndAt         time.Time `json:"endAt"`
	WindowStartAt time.Time `json:"windowStartAt"`
	WindowEndAt   time.Time `json:"windowEndAt"`
	FallbackAt    time.Time `json:"fallbackAt"`
}

func newPlanSession(key, title string, start, end time.Time) planSession {
	return planSession{Key: key, Title: title, StartAt: start, EndAt: end,
		WindowStartAt: start.Add(-planWindowLead), WindowEndAt: end.Add(planWindowOverrun), FallbackAt: start.Add(planFallbackStartIn)}
}

var (
	planDate      = regexp.MustCompile(`(\d{1,2})\.(\d{1,2})\.(\d{4})`)
	planRange     = regexp.MustCompile(`(\d{1,2})(?:[.:](\d{2}))?\s*bis\s*(\d{1,2})(?:[.:](\d{2}))?`)
	planStart     = regexp.MustCompile(`(\d{1,2})(?:[.:](\d{2}))?\s*Uhr`)
	planSessionNo = regexp.MustCompile(`(\d+)\.\s*Sitzung`)
	planSlug      = regexp.MustCompile(`[^a-z0-9]+`)
)

func nodeClass(n *html.Node) string {
	for _, a := range n.Attr {
		if a.Key == "class" {
			return a.Val
		}
	}
	return ""
}

func nodeAttr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func hasClass(n *html.Node, class string) bool {
	for _, c := range strings.Fields(nodeClass(n)) {
		if c == class {
			return true
		}
	}
	return false
}

func nodeText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
			b.WriteByte(' ')
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return strings.Join(strings.Fields(b.String()), " ")
}

func findAll(n *html.Node, match func(*html.Node) bool) []*html.Node {
	var out []*html.Node
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		if x.Type == html.ElementNode && match(x) {
			out = append(out, x)
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return out
}

func clockTime(day time.Time, hour, minute string) time.Time {
	h, _ := strconv.Atoi(hour)
	m, _ := strconv.Atoi(minute)
	return time.Date(day.Year(), day.Month(), day.Day(), h, m, 0, 0, day.Location())
}

// parseBundestagPlan reads the "Beratungsablauf" tables of the live page. The
// page repeats them for several tabs, so sessions are de-duplicated by key.
func parseBundestagPlan(r io.Reader) ([]planSession, error) {
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		return nil, err
	}
	doc, err := html.Parse(r)
	if err != nil {
		return nil, fmt.Errorf("the Bundestag plan could not be read")
	}
	var out []planSession
	seen := map[string]bool{}
	for _, table := range findAll(doc, func(n *html.Node) bool { return n.Data == "div" && hasClass(n, "bt-ptv-day-table") }) {
		headings := findAll(table, func(n *html.Node) bool { return n.Data == "h3" })
		if len(headings) == 0 {
			continue
		}
		d := planDate.FindStringSubmatch(nodeText(headings[0]))
		if d == nil {
			continue
		}
		year, _ := strconv.Atoi(d[3])
		month, _ := strconv.Atoi(d[2])
		dayNum, _ := strconv.Atoi(d[1])
		day := time.Date(year, time.Month(month), dayNum, 0, 0, 0, 0, loc)
		for _, row := range findAll(table, func(n *html.Node) bool {
			return n.Data == "tr" && nodeAttr(n, "data-enddate") != "" || (n.Data == "tr" && len(findAll(n, func(x *html.Node) bool { return hasClass(x, "bt-time") })) > 0)
		}) {
			cells := findAll(row, func(n *html.Node) bool { return n.Data == "td" && hasClass(n, "bt-time") })
			titles := findAll(row, func(n *html.Node) bool { return n.Data == "h4" })
			if len(cells) == 0 || len(titles) == 0 {
				continue
			}
			timeText := nodeText(cells[0])
			title := nodeText(titles[0])
			var start, end time.Time
			if m := planRange.FindStringSubmatch(timeText); m != nil {
				start, end = clockTime(day, m[1], m[2]), clockTime(day, m[3], m[4])
			} else if m := planStart.FindStringSubmatch(timeText); m != nil {
				start = clockTime(day, m[1], m[2])
			} else {
				continue
			}
			if epoch, convErr := strconv.ParseInt(nodeAttr(row, "data-enddate"), 10, 64); convErr == nil && epoch > 0 {
				end = time.Unix(epoch, 0).In(loc)
			}
			if end.IsZero() || !end.After(start) {
				end = start.Add(10 * time.Hour)
			}
			key := "bundestag-" + day.Format("2006-01-02") + "-" + strings.Trim(planSlug.ReplaceAllString(strings.ToLower(title), "-"), "-")
			if m := planSessionNo.FindStringSubmatch(title); m != nil {
				key = "bundestag-sitzung-" + m[1]
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, newPlanSession(key, title, start.UTC(), end.UTC()))
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no sessions found in the Bundestag plan")
	}
	return out, nil
}

func fetchBundestagPlan(ctx context.Context, client *http.Client) ([]planSession, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, bundestagLiveURL, nil)
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
		return nil, fmt.Errorf("the Bundestag plan returned HTTP %d", resp.StatusCode)
	}
	return parseBundestagPlan(io.LimitReader(resp.Body, 4*1024*1024))
}

// isBundestagPlanURL reports whether the programme plan applies to this source: the
// Bundestag live page itself, or a stream relay source whose ID contains "bundestag"
// (for example https://relay.example.org/v1/sources/bundestag).
func isBundestagPlanURL(raw string) bool {
	if isBundestagLiveURL(raw) {
		return true
	}
	id, ok := streamrelay.RelaySourceID(raw)
	return ok && strings.Contains(strings.ToLower(id), "bundestag")
}

// isBundestagLiveURL reports whether the URL is the Bundestag live page that publishes the plan.
func isBundestagLiveURL(raw string) bool {
	return isBundestagHost(raw) && strings.TrimRight(strings.ToLower(planURLPath(raw)), "/") == "/mediathek/live"
}

func planURLPath(raw string) string {
	u, err := urlParse(raw)
	if err != nil {
		return ""
	}
	return u.Path
}

func isBundestagHost(raw string) bool {
	u, err := urlParse(raw)
	if err != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return h == "www.bundestag.de" || h == "bundestag.de"
}

func urlParse(raw string) (*url.URL, error) { return url.Parse(strings.TrimSpace(raw)) }
