package streamrelay

import (
	"fmt"
	"strings"
)

// ParseSources parses "id=https://url,id2=https://url2" (commas or newlines
// separate entries). Validation of IDs and URLs happens in New.
func ParseSources(raw string) (Config, error) {
	cfg := Config{Sources: map[string]string{}}
	for _, entry := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '\n' || r == '\r' }) {
		id, u, ok := strings.Cut(strings.TrimSpace(entry), "=")
		id, u = strings.TrimSpace(id), strings.TrimSpace(u)
		if !ok || id == "" || u == "" {
			return Config{}, fmt.Errorf("RELAY_SOURCES entries must look like id=https://host/stream.mp3")
		}
		if _, dup := cfg.Sources[id]; dup {
			return Config{}, fmt.Errorf("duplicate source %q", id)
		}
		cfg.Sources[id] = u
	}
	return cfg, nil
}

// ParseTokens splits tokens separated by commas or newlines (rotation allows several).
func ParseTokens(raw string) []string {
	var out []string
	for _, t := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '\n' || r == '\r' }) {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	return out
}
