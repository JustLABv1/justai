// Package outbound supplies operator-configured proxy routing for backend clients.
package outbound

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/net/http/httpproxy"
)

// ValidatePublicTarget delegates hostname resolution to an operator-configured
// proxy. Local DNS cannot validate the address the proxy will actually use and
// may not be available in proxy-only networks. Literal IPs and recognizable
// local hostnames are still rejected; the proxy enforces resolved-address ACLs.
// Direct requests (including NO_PROXY and non-HTTP protocols) retain DNS checks.
func ValidatePublicTarget(target *url.URL, validateDirectHost func(string) error) error {
	proxy, err := httpproxy.FromEnvironment().ProxyFunc()(target)
	if err != nil {
		return fmt.Errorf("backend proxy configuration is invalid")
	}
	host := strings.TrimSuffix(strings.ToLower(target.Hostname()), ".")
	if proxy == nil || net.ParseIP(host) != nil {
		return validateDirectHost(host)
	}
	if !strings.Contains(host, ".") || strings.ContainsAny(host, ":%") || numericHost(host) {
		return fmt.Errorf("proxy target must be a public hostname or IP address")
	}
	for _, suffix := range []string{"localhost", "local", "localdomain", "internal", "svc", "cluster.local", "home.arpa"} {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return fmt.Errorf("proxy target must not be a local hostname")
		}
	}
	return nil
}

// Proxies can interpret abbreviated, octal, or hexadecimal IPv4 spellings.
// Require standard IP literals so the caller's address checks cannot be skipped.
func numericHost(host string) bool {
	for _, label := range strings.Split(host, ".") {
		digits := "0123456789"
		if strings.HasPrefix(label, "0x") {
			label = strings.TrimPrefix(label, "0x")
			digits += "abcdef"
		}
		if label == "" || strings.Trim(label, digits) != "" {
			return false
		}
	}
	return true
}

// WithEnvironmentProxy preserves the client's guarded direct dialer. Proxied
// requests validate their destination before handing it to the trusted proxy;
// only the proxy connection uses an unrestricted dialer. The proxy must enforce
// destination policy too, since it performs its own DNS resolution.
func WithEnvironmentProxy(direct *http.Transport, validate func(*url.URL) error) http.RoundTripper {
	proxyForURL := httpproxy.FromEnvironment().ProxyFunc()
	proxied := direct.Clone()
	proxied.Proxy = func(r *http.Request) (*url.URL, error) { return proxyForURL(r.URL) }
	proxied.DialContext = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	return &proxyTransport{direct: direct, proxied: proxied, proxyForURL: proxyForURL, validate: validate}
}

type proxyTransport struct {
	direct, proxied *http.Transport
	proxyForURL     func(*url.URL) (*url.URL, error)
	validate        func(*url.URL) error
}

func (t *proxyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	proxy, err := t.proxyForURL(r.URL)
	if err != nil {
		return nil, fmt.Errorf("backend proxy configuration is invalid")
	}
	if proxy == nil {
		return t.direct.RoundTrip(r)
	}
	if err := t.validate(r.URL); err != nil {
		return nil, err
	}
	return t.proxied.RoundTrip(r)
}

func (t *proxyTransport) CloseIdleConnections() {
	t.direct.CloseIdleConnections()
	t.proxied.CloseIdleConnections()
}

// MediaProxyEnv maps scheme-specific Go proxy selection to FFmpeg's lowercase
// http_proxy variable. Credentials stay out of command-line arguments.
func MediaProxyEnv(rawURL string) ([]string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid media URL")
	}
	proxy, err := httpproxy.FromEnvironment().ProxyFunc()(u)
	if err != nil {
		return nil, fmt.Errorf("backend proxy configuration is invalid")
	}
	if proxy != nil && proxy.Scheme != "http" {
		return nil, fmt.Errorf("media capture requires an http:// proxy URL")
	}
	env := make([]string, 0, len(os.Environ())+2)
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		switch strings.ToLower(key) {
		case "http_proxy", "https_proxy", "all_proxy", "no_proxy":
			continue
		}
		env = append(env, value)
	}
	proxyValue := ""
	if proxy != nil {
		proxyValue = proxy.String()
	}
	return append(env, "http_proxy="+proxyValue, "no_proxy="+httpproxy.FromEnvironment().NoProxy), nil
}
