// stream-relay is an authenticated, TLS-only finite-segment MP3 relay.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"justai-backend/streamrelay"
	"log"
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
	addr := flag.String("listen", ":8443", "listen address")
	flag.Parse()
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
	relay.Run(ctx, cfg)
	log.Print("stream relay listening with TLS")
	if err = srv.ListenAndServeTLS(*cert, *key); err != nil && err != http.ErrServerClosed {
		log.Fatal("relay TLS listener failed")
	}
}
