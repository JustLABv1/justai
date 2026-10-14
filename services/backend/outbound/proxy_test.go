package outbound

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func clearProxyEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "ALL_PROXY", "all_proxy", "REQUEST_METHOD"} {
		t.Setenv(key, "")
	}
}

func TestEnvironmentProxyAndBypass(t *testing.T) {
	clearProxyEnv(t)
	proxyCalls, directCalls, validations := 0, 0, 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyCalls++
		if r.URL.String() != "http://8.8.8.8/audio" || r.Header.Get("Proxy-Authorization") == "" {
			t.Errorf("incorrect proxy request: %s", r.URL)
		}
		w.Write([]byte("proxied"))
	}))
	defer proxy.Close()
	u, _ := url.Parse(proxy.URL)
	u.User = url.UserPassword("user", "secret")
	t.Setenv("HTTP_PROXY", u.String())
	t.Setenv("NO_PROXY", "1.1.1.1")
	directServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		directCalls++
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("proxy credentials leaked to direct target")
		}
		w.Write([]byte("direct"))
	}))
	defer directServer.Close()
	direct := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(directServer.URL, "http://"))
	}}
	client := &http.Client{Transport: WithEnvironmentProxy(direct, func(*url.URL) error { validations++; return nil })}
	defer client.CloseIdleConnections()
	for raw, want := range map[string]string{"http://8.8.8.8/audio": "proxied", "http://1.1.1.1/audio": "direct"} {
		resp, err := client.Get(raw)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(body) != want {
			t.Fatalf("got %q, want %q", body, want)
		}
	}
	if proxyCalls != 1 || directCalls != 1 || validations != 1 {
		t.Fatalf("proxy=%d direct=%d validations=%d", proxyCalls, directCalls, validations)
	}
}

func TestHTTPSProxyConnect(t *testing.T) {
	clearProxyEnv(t)
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("proxy credentials reached destination")
		}
		w.Write([]byte("tunneled"))
	}))
	defer target.Close()
	connects := make(chan string, 1)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			t.Errorf("expected CONNECT, got %s", r.Method)
			return
		}
		connects <- r.Host
		upstream, err := net.Dial("tcp", strings.TrimPrefix(target.URL, "https://"))
		if err != nil {
			t.Error(err)
			return
		}
		defer upstream.Close()
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		buf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		buf.Flush()
		go io.Copy(upstream, buf)
		io.Copy(conn, upstream)
	}))
	defer proxy.Close()
	t.Setenv("HTTPS_PROXY", proxy.URL)
	direct := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}} // Test server certificate.
	client := &http.Client{Timeout: 3 * time.Second, Transport: WithEnvironmentProxy(direct, func(*url.URL) error { return nil })}
	defer client.CloseIdleConnections()
	resp, err := client.Get("https://8.8.8.8/audio")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "tunneled" || <-connects != "8.8.8.8:443" {
		t.Fatal("HTTPS was not tunneled through proxy")
	}
}

func TestMediaProxyEnv(t *testing.T) {
	clearProxyEnv(t)
	t.Setenv("HTTP_PROXY", "http://http-proxy:8080")
	t.Setenv("HTTPS_PROXY", "http://user:secret@https-proxy:8080")
	t.Setenv("NO_PROXY", "8.8.8.8")
	for raw, want := range map[string]string{
		"http://1.1.1.1/audio":  "http_proxy=http://http-proxy:8080",
		"https://1.1.1.1/audio": "http_proxy=http://user:secret@https-proxy:8080",
		"https://8.8.8.8/audio": "http_proxy=",
	} {
		env, err := MediaProxyEnv(raw)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, entry := range env {
			if entry == want {
				found = true
			}
			if strings.HasPrefix(entry, "HTTPS_PROXY=") || strings.HasPrefix(entry, "HTTP_PROXY=") {
				t.Fatal("inherited proxy was not normalized")
			}
		}
		if !found {
			t.Fatalf("proxy selection for %s is incorrect", raw)
		}
	}
	t.Setenv("HTTPS_PROXY", "https://proxy:8443")
	if _, err := MediaProxyEnv("https://1.1.1.1/audio"); err == nil {
		t.Fatal("unsupported media proxy accepted")
	}
}
