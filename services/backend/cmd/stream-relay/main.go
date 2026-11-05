// stream-relay is an authenticated, finite-segment MP3 relay.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"justai-backend/streamrelay"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

// Every setting can come from a flag or a RELAY_* environment variable (flags win).
// Files remain preferred for secrets: environment variables leak more easily
// (docker inspect, /proc, crash reports).
func envString(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return def
}

func envBool(name string) bool {
	v, _ := strconv.ParseBool(os.Getenv(name))
	return v
}

func main() {
	config := flag.String("config", envString("RELAY_SOURCES_FILE", "/etc/stream-relay/sources.json"), "operator-owned source allowlist (env RELAY_SOURCES_FILE; or set RELAY_SOURCES=id=url,...)")
	tokenFile := flag.String("token-file", envString("RELAY_TOKEN_FILE", "/run/secrets/relay_token"), "bearer token file, one token per line (env RELAY_TOKEN_FILE; or set RELAY_TOKEN)")
	cert := flag.String("tls-cert", envString("RELAY_TLS_CERT", "/etc/stream-relay/tls.crt"), "TLS certificate")
	key := flag.String("tls-key", envString("RELAY_TLS_KEY", "/run/secrets/tls_key"), "TLS private key")
	httpMode := flag.Bool("http", envBool("RELAY_HTTP"), "serve plain HTTP behind a trusted TLS-terminating ingress; never expose publicly (env RELAY_HTTP=true)")
	maxConns := flag.Int("max-conns", envInt("RELAY_MAX_CONNS", 128), "maximum concurrent connections; extras are closed (keep below the file-descriptor limit)")
	maxConnsPerIP := flag.Int("max-conns-per-ip", envInt("RELAY_MAX_CONNS_PER_IP", -1), "maximum concurrent connections per peer address (default 16 for HTTPS, 0=off with --http since every peer is the ingress)")
	addr := flag.String("listen", envString("RELAY_LISTEN", ""), "listen address (default :8443 for HTTPS, :8080 with --http)")
	flag.Parse()
	if *addr == "" {
		*addr = ":8443"
		if *httpMode {
			*addr = ":8080"
		}
	}
	var cfg streamrelay.Config
	if raw := os.Getenv("RELAY_SOURCES"); raw != "" {
		var err error
		if cfg, err = streamrelay.ParseSources(raw); err != nil {
			log.Fatal(err)
		}
	} else {
		body, err := os.ReadFile(*config)
		if err != nil {
			log.Fatal("cannot read source configuration; mount sources.json or set RELAY_SOURCES")
		}
		if err = json.Unmarshal(body, &cfg); err != nil {
			log.Fatal("invalid source configuration")
		}
	}
	// One token per line (or comma-separated in RELAY_TOKEN); a second token
	// allows rotating without downtime.
	var tokens []string
	if raw := os.Getenv("RELAY_TOKEN"); raw != "" {
		tokens = streamrelay.ParseTokens(raw)
	} else {
		secret, err := os.ReadFile(*tokenFile)
		if err != nil {
			log.Fatal("cannot read token file; mount a secret or set RELAY_TOKEN")
		}
		tokens = streamrelay.ParseTokens(string(secret))
	}
	relay, err := streamrelay.NewWithTokens(cfg, tokens)
	if err != nil {
		log.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	relay.SetLogger(logger)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv := &http.Server{Addr: *addr, Handler: relay, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	// Disable HTTP/2 to bound concurrent requests with connection-level limits.
	srv.TLSNextProto = make(map[string]func(*http.Server, *tls.Conn, http.Handler))
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal("relay listener failed")
	}
	defer listener.Close()
	if *maxConnsPerIP < 0 {
		*maxConnsPerIP = 16
		if *httpMode {
			*maxConnsPerIP = 0
		}
	}
	listener = streamrelay.LimitListener(listener, *maxConns, *maxConnsPerIP, relay.ConnRejected)
	relay.Run(ctx, cfg)
	if *httpMode {
		log.Print("stream relay using HTTP behind a trusted TLS-terminating ingress")
	} else {
		log.Print("stream relay using HTTPS")
	}
	if err = serveRelay(srv, listener, *httpMode, *cert, *key); err != nil && err != http.ErrServerClosed {
		log.Fatal("relay listener failed; check listen address and TLS configuration")
	}
}

// HTTP is an explicit operator opt-in. Never infer transport from forwarded
// headers or fall back to plaintext when certificates are missing or invalid.
func serveRelay(srv *http.Server, listener net.Listener, httpMode bool, cert, key string) error {
	if httpMode {
		return srv.Serve(listener)
	}
	return srv.ServeTLS(listener, cert, key)
}
