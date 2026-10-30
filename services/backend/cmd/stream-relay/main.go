// stream-relay is an authenticated, finite-segment MP3 relay.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"justai-backend/streamrelay"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	config := flag.String("config", "/etc/stream-relay/sources.json", "operator-owned source allowlist")
	tokenFile := flag.String("token-file", "/run/secrets/relay_token", "bearer token file")
	cert := flag.String("tls-cert", "/etc/stream-relay/tls.crt", "TLS certificate")
	key := flag.String("tls-key", "/run/secrets/tls_key", "TLS private key")
	httpMode := flag.Bool("http", false, "serve plain HTTP behind a trusted TLS-terminating ingress; never expose publicly")
	addr := flag.String("listen", "", "listen address (default :8443 for HTTPS, :8080 with --http)")
	flag.Parse()
	if *addr == "" {
		*addr = ":8443"
		if *httpMode {
			*addr = ":8080"
		}
	}
	body, err := os.ReadFile(*config)
	if err != nil {
		log.Fatal("cannot read source configuration")
	}
	var cfg streamrelay.Config
	if err = json.Unmarshal(body, &cfg); err != nil {
		log.Fatal("invalid source configuration")
	}
	secret, err := os.ReadFile(*tokenFile)
	if err != nil {
		log.Fatal("cannot read token file")
	}
	relay, err := streamrelay.New(cfg, strings.TrimSpace(string(secret)))
	if err != nil {
		log.Fatal(err)
	}
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
