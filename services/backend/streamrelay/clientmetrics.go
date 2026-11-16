package streamrelay

import (
	"fmt"
	"io"
	"sort"
	"sync"
	"time"
)

// Backend-side relay metrics (Prometheus text). Label values come only from the
// operator-configured relay names, so cardinality is bounded.
var clientMetrics = struct {
	sync.Mutex
	values map[string]float64
}{values: map[string]float64{}}

var clientMetricHelp = map[string][2]string{
	"justai_stream_relay_manifest_errors_total":          {"counter", "Failed relay manifest requests."},
	"justai_stream_relay_segment_errors_total":           {"counter", "Failed, truncated or invalid relay audio segments."},
	"justai_stream_relay_segments_received_total":        {"counter", "Audio segments received from the relay."},
	"justai_stream_relay_reconnects_total":               {"counter", "Relay audio sessions that ended unexpectedly and must reconnect."},
	"justai_stream_relay_list_errors_total":              {"counter", "Failed relay source list requests."},
	"justai_stream_relay_last_success_timestamp_seconds": {"gauge", "Unix time of the last successful relay request."},
}

func initClientMetrics(relay string) {
	clientMetrics.Lock()
	defer clientMetrics.Unlock()
	for name, meta := range clientMetricHelp {
		if meta[0] == "counter" {
			if _, ok := clientMetrics.values[key(name, "relay", relay)]; !ok {
				clientMetrics.values[key(name, "relay", relay)] = 0
			}
		}
	}
}

func countClient(name, relay string) {
	clientMetrics.Lock()
	clientMetrics.values[key(name, "relay", relay)]++
	clientMetrics.Unlock()
}

func markClientSuccess(relay string) {
	clientMetrics.Lock()
	clientMetrics.values[key("justai_stream_relay_last_success_timestamp_seconds", "relay", relay)] = float64(time.Now().Unix())
	clientMetrics.Unlock()
}

// WriteClientMetrics appends the backend-side relay metrics in Prometheus text format.
func WriteClientMetrics(w io.Writer) {
	clientMetrics.Lock()
	lines := make([]string, 0, len(clientMetrics.values))
	for k, v := range clientMetrics.values {
		lines = append(lines, fmt.Sprintf("%s %g", k, v))
	}
	clientMetrics.Unlock()
	sort.Strings(lines)
	names := make([]string, 0, len(clientMetricHelp))
	for name := range clientMetricHelp {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		var series []string
		for _, line := range lines {
			if len(line) > len(name) && line[:len(name)] == name && (line[len(name)] == '{' || line[len(name)] == ' ') {
				series = append(series, line)
			}
		}
		if len(series) == 0 {
			continue
		}
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", name, clientMetricHelp[name][1], name, clientMetricHelp[name][0])
		for _, line := range series {
			fmt.Fprintln(w, line)
		}
	}
}
