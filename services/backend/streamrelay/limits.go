package streamrelay

import (
	"net"
	"sync"
	"time"
)

// Failed-authentication throttle. Requests with a valid token are NEVER
// throttled: behind an ingress every client shares one peer address, so a bot
// must not be able to lock the real backend out by failing from that address.
// Throttling only short-circuits repeated failures (429, no per-request log).
const (
	authFailLimit  = 20
	authFailWindow = time.Minute
	authBlockFor   = time.Minute
	maxTrackedIPs  = 10000
)

type authEntry struct {
	failures     int
	windowStart  time.Time
	blockedUntil time.Time
}

type authThrottle struct {
	mu  sync.Mutex
	now func() time.Time
	ips map[string]*authEntry
}

func newAuthThrottle() *authThrottle {
	return &authThrottle{now: time.Now, ips: map[string]*authEntry{}}
}

// blocked reports whether ip is currently in a block window.
func (t *authThrottle) blocked(ip string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.ips[ip]
	return e != nil && t.now().Before(e.blockedUntil)
}

// fail records a failed attempt and reports whether this one started a block.
func (t *authThrottle) fail(ip string) (startedBlock bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	if len(t.ips) >= maxTrackedIPs {
		for k, e := range t.ips {
			if now.After(e.blockedUntil) && now.Sub(e.windowStart) > authFailWindow {
				delete(t.ips, k)
			}
		}
		if len(t.ips) >= maxTrackedIPs { // still full: shed state rather than grow
			t.ips = map[string]*authEntry{}
		}
	}
	e := t.ips[ip]
	if e == nil || now.Sub(e.windowStart) > authFailWindow {
		e = &authEntry{windowStart: now, blockedUntil: e.blockedUntilOrZero()}
		t.ips[ip] = e
	}
	e.failures++
	if e.failures >= authFailLimit && !now.Before(e.blockedUntil) {
		e.blockedUntil = now.Add(authBlockFor)
		e.failures = 0
		return true
	}
	return false
}

func (e *authEntry) blockedUntilOrZero() time.Time {
	if e == nil {
		return time.Time{}
	}
	return e.blockedUntil
}

// LimitListener sheds connections beyond maxTotal, and beyond maxPerIP from a
// single peer address (0 disables the per-IP cap; use 0 behind an ingress, where
// every connection comes from the ingress). Shedding closes immediately so idle
// or slow connections cannot exhaust file descriptors and starve the backend.
// onReject is called with "total" or "per_ip".
func LimitListener(l net.Listener, maxTotal, maxPerIP int, onReject func(reason string)) net.Listener {
	return &limitListener{Listener: l, maxTotal: maxTotal, maxPerIP: maxPerIP, onReject: onReject, perIP: map[string]int{}}
}

type limitListener struct {
	net.Listener
	maxTotal, maxPerIP int
	onReject           func(string)
	mu                 sync.Mutex
	total              int
	perIP              map[string]int
}

func (l *limitListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		ip := remoteHost(c.RemoteAddr().String())
		l.mu.Lock()
		reason := ""
		switch {
		case l.maxTotal > 0 && l.total >= l.maxTotal:
			reason = "total"
		case l.maxPerIP > 0 && l.perIP[ip] >= l.maxPerIP:
			reason = "per_ip"
		default:
			l.total++
			l.perIP[ip]++
		}
		l.mu.Unlock()
		if reason != "" {
			_ = c.Close()
			if l.onReject != nil {
				l.onReject(reason)
			}
			continue
		}
		return &limitedConn{Conn: c, release: func() {
			l.mu.Lock()
			l.total--
			if l.perIP[ip]--; l.perIP[ip] <= 0 {
				delete(l.perIP, ip)
			}
			l.mu.Unlock()
		}}, nil
	}
}

type limitedConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *limitedConn) Close() error {
	c.once.Do(c.release)
	return c.Conn.Close()
}

// ConnRejected lets the listener report shed connections as a metric.
func (r *Relay) ConnRejected(reason string) {
	r.metrics.add("relay_connections_rejected_total", 1, "reason", reason)
}
