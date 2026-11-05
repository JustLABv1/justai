package streamrelay

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"
)

// metrics is a tiny Prometheus text-format registry. It is hand-rolled to keep
// the relay dependency-free. Label values are always drawn from bounded sets
// (configured source IDs, fixed endpoint names, status codes), never from
// request input, so cardinality cannot be inflated by clients.
type metrics struct {
	mu       sync.Mutex
	started  time.Time
	counters map[string]float64 // "name{labels}" -> value
	gauges   map[string]float64
	hist     map[string]*histogram
}

type histogram struct {
	counts []uint64
	sum    float64
	n      uint64
}

var durationBuckets = []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10}

func newMetrics() *metrics {
	return &metrics{started: time.Now(), counters: map[string]float64{}, gauges: map[string]float64{}, hist: map[string]*histogram{}}
}

func key(name string, labels ...string) string {
	if len(labels) == 0 {
		return name
	}
	parts := make([]string, 0, len(labels)/2)
	for i := 0; i+1 < len(labels); i += 2 {
		parts = append(parts, fmt.Sprintf(`%s=%q`, labels[i], labels[i+1]))
	}
	return name + "{" + strings.Join(parts, ",") + "}"
}

func (m *metrics) add(name string, v float64, labels ...string) {
	m.mu.Lock()
	m.counters[key(name, labels...)] += v
	m.mu.Unlock()
}

func (m *metrics) set(name string, v float64, labels ...string) {
	m.mu.Lock()
	m.gauges[key(name, labels...)] = v
	m.mu.Unlock()
}

func (m *metrics) gauge(name string, labels ...string) float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.gauges[key(name, labels...)]
}

func (m *metrics) observe(name string, v float64, labels ...string) {
	m.mu.Lock()
	k := key(name, labels...)
	h := m.hist[k]
	if h == nil {
		h = &histogram{counts: make([]uint64, len(durationBuckets))}
		m.hist[k] = h
	}
	for i, b := range durationBuckets {
		if v <= b {
			h.counts[i]++
		}
	}
	h.sum += v
	h.n++
	m.mu.Unlock()
}

var help = map[string][2]string{
	"relay_http_requests_total":                      {"counter", "HTTP requests by source, endpoint and status code."},
	"relay_http_response_bytes_total":                {"counter", "Response body bytes by source."},
	"relay_http_request_duration_seconds":            {"histogram", "HTTP request duration by endpoint."},
	"relay_http_inflight_requests":                   {"gauge", "Requests currently being served."},
	"relay_upstream_segments_total":                  {"counter", "Five-second segments produced per source."},
	"relay_upstream_sessions_total":                  {"counter", "Upstream capture sessions ended per source and reason."},
	"relay_upstream_up":                              {"gauge", "1 while audio is being received from the upstream source."},
	"relay_upstream_latest_sequence":                 {"gauge", "Latest segment sequence per source."},
	"relay_upstream_last_segment_timestamp_seconds":  {"gauge", "Unix time of the last segment per source."},
	"relay_upstream_session_start_timestamp_seconds": {"gauge", "Unix time the current upstream session began producing audio."},
	"relay_connections_rejected_total":               {"counter", "Connections closed at accept because a connection limit was reached, by reason."},
	"relay_start_time_seconds":                       {"gauge", "Relay process start time."},
}

func family(k string) string {
	if i := strings.IndexByte(k, '{'); i >= 0 {
		return k[:i]
	}
	return k
}

func (m *metrics) write(w io.Writer) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gauges["relay_start_time_seconds"] = float64(m.started.UnixNano()) / 1e9
	seen := map[string]bool{}
	emit := func(name string) {
		if seen[name] {
			return
		}
		seen[name] = true
		if h, ok := help[name]; ok {
			fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", name, h[1], name, h[0])
		}
	}
	for _, set := range []map[string]float64{m.counters, m.gauges} {
		keys := make([]string, 0, len(set))
		for k := range set {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			emit(family(k))
			fmt.Fprintf(w, "%s %g\n", k, set[k])
		}
	}
	keys := make([]string, 0, len(m.hist))
	for k := range m.hist {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		h := m.hist[k]
		name := family(k)
		emit(name)
		labels := strings.TrimSuffix(strings.TrimPrefix(k[len(name):], "{"), "}")
		join := func(extra string) string {
			if labels == "" {
				return "{" + extra + "}"
			}
			return "{" + labels + "," + extra + "}"
		}
		for i, b := range durationBuckets {
			fmt.Fprintf(w, "%s_bucket%s %d\n", name, join(fmt.Sprintf(`le="%g"`, b)), h.counts[i])
		}
		fmt.Fprintf(w, "%s_bucket%s %d\n", name, join(`le="+Inf"`), h.n)
		suffix := ""
		if labels != "" {
			suffix = "{" + labels + "}"
		}
		fmt.Fprintf(w, "%s_sum%s %g\n%s_count%s %d\n", name, suffix, h.sum, name, suffix, h.n)
	}
}
