package streamrelay

import (
	"bytes"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsEndpointRequiresAuthAndReportsTraffic(t *testing.T) {
	r := testRelay(t)
	var logs bytes.Buffer
	r.SetLogger(slog.New(slog.NewJSONHandler(&logs, nil)))
	do := func(path, token, rid string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", path, nil)
		req.RemoteAddr = "203.0.113.9:4444"
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if rid != "" {
			req.Header.Set("X-Request-ID", rid)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}
	if w := do("/metrics", "", ""); w.Code != 401 {
		t.Fatalf("metrics must require auth, got %d", w.Code)
	}
	do("/v1/sources/radio", testToken, "trace-1")
	do("/v1/sources/radio/segments/1?epoch=test-epoch", testToken, "bad id with spaces")
	do("/v1/sources/radio/segments/9?epoch=test-epoch", testToken, "")
	r.sources["radio"].append(make([]byte, SegmentBytes))

	w := do("/metrics", testToken, "")
	if w.Code != 200 {
		t.Fatalf("metrics: %d", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{
		`relay_http_requests_total{source="none",endpoint="other",code="401"} 1`,
		`relay_http_requests_total{source="radio",endpoint="manifest",code="200"} 1`,
		`relay_http_requests_total{source="radio",endpoint="segment",code="200"} 1`,
		`relay_http_requests_total{source="radio",endpoint="segment",code="410"} 1`,
		`relay_upstream_segments_total{source="radio"} 1`,
		`relay_upstream_up{source="radio"} 1`,
		`relay_upstream_latest_sequence{source="radio"} 2`,
		`relay_http_request_duration_seconds_count{endpoint="segment"} 2`,
		`# TYPE relay_http_request_duration_seconds histogram`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
	if got := do("/v1/sources/radio", testToken, "trace-1").Header().Get("X-Request-ID"); got != "trace-1" {
		t.Errorf("request id not echoed: %q", got)
	}
	if got := do("/v1/sources/radio", testToken, "bad id").Header().Get("X-Request-ID"); got == "bad id" || got == "" {
		t.Errorf("invalid request id must be replaced: %q", got)
	}
	out := logs.String()
	if !strings.Contains(out, `"request_id":"trace-1"`) || !strings.Contains(out, `"remote":"203.0.113.9"`) {
		t.Errorf("structured log missing fields:\n%s", out)
	}
	for _, secret := range []string{testToken, "test-epoch"} {
		if strings.Contains(out, secret) {
			t.Errorf("log leaks %q", secret)
		}
	}
}

func TestUnknownSourcesDoNotCreateLabels(t *testing.T) {
	r := testRelay(t)
	for _, id := range []string{"a", "b", "c"} {
		req := httptest.NewRequest("GET", "/v1/sources/"+id, nil)
		req.Header.Set("Authorization", "Bearer "+testToken)
		r.ServeHTTP(httptest.NewRecorder(), req)
	}
	var b bytes.Buffer
	r.metrics.write(&b)
	if strings.Contains(b.String(), `source="a"`) {
		t.Error("client-supplied source IDs must not become label values")
	}
}

func TestHealthzIsUnauthenticatedAndMinimal(t *testing.T) {
	r := testRelay(t)
	var logs bytes.Buffer
	r.SetLogger(slog.New(slog.NewJSONHandler(&logs, nil)))
	for _, tc := range []struct {
		method string
		code   int
		body   string
	}{{"GET", 200, "ok\n"}, {"HEAD", 200, ""}, {"POST", 405, ""}} {
		req := httptest.NewRequest(tc.method, "/healthz", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != tc.code || (tc.code == 200 && w.Body.String() != tc.body) {
			t.Errorf("%s /healthz: %d %q", tc.method, w.Code, w.Body.String())
		}
	}
	// Other paths still require auth, and the probe never feeds the failed-auth throttle.
	for i := 0; i < authFailLimit+5; i++ {
		httptest.NewRecorder()
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/healthz", nil))
	}
	if c := get(r, "", "192.0.2.5:1"); c != 401 {
		t.Errorf("auth still required elsewhere: %d", c)
	}
	if strings.Contains(logs.String(), `"endpoint":"health","status":200`) {
		t.Error("successful health probes must not be logged at info")
	}
	var m bytes.Buffer
	r.metrics.write(&m)
	if !strings.Contains(m.String(), `endpoint="health",code="200"`) {
		t.Error("health probes should still be counted")
	}
}
