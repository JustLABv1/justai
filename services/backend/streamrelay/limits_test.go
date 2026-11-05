package streamrelay

import (
	"net"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func get(r *Relay, token, remote string) int {
	req := httptest.NewRequest("GET", "/v1/sources/radio", nil)
	req.RemoteAddr = remote
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code
}

func TestFailedAuthThrottleNeverBlocksValidToken(t *testing.T) {
	r := testRelay(t)
	now := time.Now()
	r.throttle.now = func() time.Time { return now }
	for i := 0; i < authFailLimit; i++ {
		if c := get(r, "wrong", "198.51.100.7:1"); c != 401 {
			t.Fatalf("attempt %d: %d", i, c)
		}
	}
	if c := get(r, "wrong", "198.51.100.7:1"); c != 429 {
		t.Fatalf("expected throttle, got %d", c)
	}
	if c := get(r, testToken, "198.51.100.7:1"); c != 200 {
		t.Fatalf("valid token must pass from a throttled address, got %d", c)
	}
	if c := get(r, "wrong", "198.51.100.8:1"); c != 401 {
		t.Fatalf("other addresses unaffected, got %d", c)
	}
	now = now.Add(authBlockFor + time.Second)
	if c := get(r, "wrong", "198.51.100.7:1"); c != 401 {
		t.Fatalf("block must expire, got %d", c)
	}
}

func TestThrottleStateIsBounded(t *testing.T) {
	th := newAuthThrottle()
	for i := 0; i < maxTrackedIPs*2; i++ {
		th.fail(net.IPv4(10, byte(i>>16), byte(i>>8), byte(i)).String())
	}
	if len(th.ips) > maxTrackedIPs {
		t.Fatalf("tracked %d addresses", len(th.ips))
	}
}

func TestTokenRotationAcceptsEitherToken(t *testing.T) {
	old, next := testToken, "second-test-only-token-with-more-than-32-chars"
	r, err := NewWithTokens(Config{Sources: map[string]string{"radio": "https://radio.example/live.mp3"}}, []string{old, next})
	if err != nil {
		t.Fatal(err)
	}
	for _, tok := range []string{old, next} {
		if c := get(r, tok, "192.0.2.1:1"); c != 404 && c != 200 {
			t.Errorf("token rejected: %d", c)
		}
	}
	if c := get(r, "nope", "192.0.2.1:1"); c != 401 {
		t.Errorf("got %d", c)
	}
	if _, err := NewWithTokens(Config{Sources: map[string]string{"radio": "https://radio.example/live.mp3"}}, []string{old, "short"}); err == nil {
		t.Error("short rotation token must be rejected")
	}
}

func TestLimitListenerShedsExcessConnections(t *testing.T) {
	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var reasons []string
	l := LimitListener(base, 2, 0, func(r string) { mu.Lock(); reasons = append(reasons, r); mu.Unlock() })
	defer l.Close()
	accepted := make(chan net.Conn, 4)
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			accepted <- c
		}
	}()
	var clients []net.Conn
	for i := 0; i < 3; i++ {
		c, err := net.Dial("tcp", base.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		clients = append(clients, c)
		defer c.Close()
	}
	first, second := <-accepted, <-accepted
	// Third client is closed by the server.
	_ = clients[2].SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := clients[2].Read(make([]byte, 1)); err == nil {
		t.Error("third connection should be shed")
	}
	mu.Lock()
	if len(reasons) != 1 || reasons[0] != "total" {
		t.Errorf("reasons: %v", reasons)
	}
	mu.Unlock()
	first.Close()
	_ = second
	c, err := net.Dial("tcp", base.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Error("slot should be released after Close")
	}
}

func TestEnvConfigParsing(t *testing.T) {
	cfg, err := ParseSources("radio=https://a.example/x.mp3, news=https://b.example/y.mp3\n")
	if err != nil || len(cfg.Sources) != 2 || cfg.Sources["news"] != "https://b.example/y.mp3" {
		t.Fatalf("%v %v", cfg, err)
	}
	for _, bad := range []string{"radio", "=https://a", "radio=", "a=https://x,a=https://y"} {
		if _, err := ParseSources(bad); err == nil {
			t.Errorf("%q should fail", bad)
		}
	}
	if got := ParseTokens("one, two\n\nthree"); len(got) != 3 || got[1] != "two" {
		t.Errorf("%v", got)
	}
}
