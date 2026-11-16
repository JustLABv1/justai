package server

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// liveStreamEvents counts watch-window and schedule events so operators can alert on
// missed captures. Event names are a fixed set, so cardinality is bounded.
var liveStreamEvents = &liveStreamMetrics{counts: map[string]*atomic.Int64{}}

type liveStreamMetrics struct {
	mu       sync.Mutex
	counts   map[string]*atomic.Int64
	watching atomic.Int64
}

func (l *liveStreamMetrics) inc(event string) {
	l.mu.Lock()
	c := l.counts[event]
	if c == nil {
		c = &atomic.Int64{}
		l.counts[event] = c
	}
	l.mu.Unlock()
	c.Add(1)
}

func (l *liveStreamMetrics) write(b *strings.Builder) {
	b.WriteString("# HELP justai_livestream_watching Livestream sources currently waiting for the broadcast to go live.\n# TYPE justai_livestream_watching gauge\n")
	fmt.Fprintf(b, "justai_livestream_watching %d\n", l.watching.Load())
	l.mu.Lock()
	names := make([]string, 0, len(l.counts))
	for name := range l.counts {
		names = append(names, name)
	}
	sort.Strings(names)
	b.WriteString("# HELP justai_livestream_events_total Livestream schedule events: speech_start, fallback_start, watch_missed, silence_stop, plan_changed, plan_missing, plan_fetch_failed, stream_unreachable.\n# TYPE justai_livestream_events_total counter\n")
	for _, name := range names {
		fmt.Fprintf(b, "justai_livestream_events_total{event=%q} %d\n", name, l.counts[name].Load())
	}
	l.mu.Unlock()
}
