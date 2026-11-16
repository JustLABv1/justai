package streamrelay

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
)

// Endpoint is one external relay the backend may use.
type Endpoint struct {
	Name      string // display name; defaults to the host
	URL       string // HTTPS origin without path
	Token     string // inline token; token files are preferred
	TokenFile string
}

const maxEndpoints = 8

var (
	settingsMu sync.RWMutex
	primary    Endpoint   // legacy single relay; environment variables override it
	extra      []Endpoint // additional relays from config
)

// Configure installs the relay settings from config.yaml. primary may be empty.
// JUSTAI_STREAM_RELAY_URL / _TOKEN_FILE / _TOKEN override the primary relay.
func Configure(first Endpoint, more []Endpoint) error {
	all := append([]Endpoint{first}, more...)
	seen := map[string]bool{}
	count := 0
	for _, e := range all {
		if strings.TrimSpace(e.URL) == "" {
			continue
		}
		count++
		origin, err := e.origin()
		if err != nil {
			return err
		}
		if seen[strings.ToLower(origin.Host)] {
			return fmt.Errorf("stream relay %s is configured more than once", origin.Host)
		}
		seen[strings.ToLower(origin.Host)] = true
	}
	if count > maxEndpoints {
		return fmt.Errorf("configure at most %d stream relays", maxEndpoints)
	}
	settingsMu.Lock()
	primary, extra = first, append([]Endpoint(nil), more...)
	settingsMu.Unlock()
	for _, e := range endpoints() {
		initClientMetrics(e.displayName())
	}
	return nil
}

// endpoints returns the configured relays, applying environment overrides to the primary one.
func endpoints() []Endpoint {
	settingsMu.RLock()
	first, more := primary, extra
	settingsMu.RUnlock()
	if v := strings.TrimSpace(os.Getenv("JUSTAI_STREAM_RELAY_URL")); v != "" {
		first.URL = v
	}
	if v := strings.TrimSpace(os.Getenv("JUSTAI_STREAM_RELAY_TOKEN_FILE")); v != "" {
		first.TokenFile, first.Token = v, ""
	} else if v := strings.TrimSpace(os.Getenv("JUSTAI_STREAM_RELAY_TOKEN")); v != "" {
		first.Token, first.TokenFile = v, ""
	}
	var out []Endpoint
	for _, e := range append([]Endpoint{first}, more...) {
		if strings.TrimSpace(e.URL) != "" {
			out = append(out, e)
		}
	}
	return out
}

// origin validates the configured URL: an HTTPS origin with no path or credentials.
func (e Endpoint) origin() (*url.URL, error) {
	b, err := url.Parse(strings.TrimRight(strings.TrimSpace(e.URL), "/"))
	if err != nil || b.Scheme != "https" || b.Host == "" || b.User != nil || b.RawQuery != "" || b.Fragment != "" || b.Path != "" {
		return nil, fmt.Errorf("invalid stream relay configuration: HTTPS origin required")
	}
	return b, nil
}

func (e Endpoint) displayName() string {
	if n := strings.TrimSpace(e.Name); n != "" {
		return n
	}
	if b, err := e.origin(); err == nil {
		return b.Host
	}
	return "relay"
}

func (e Endpoint) readToken() ([]byte, error) {
	if e.TokenFile != "" {
		return os.ReadFile(e.TokenFile)
	}
	if e.Token != "" {
		return []byte(e.Token), nil
	}
	return nil, fmt.Errorf("no token configured")
}
