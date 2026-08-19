package main

import (
	"context"
	"database/sql"
	"flag"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"

	"justai-backend/config"
	"justai-backend/database"
	"justai-backend/server"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	var configPath string
	flag.StringVar(&configPath, "c", "", "path to a YAML config file")
	flag.StringVar(&configPath, "config", "", "path to a YAML config file")
	flag.Parse()

	cfg, err := config.Load(configPath)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := database.RunMigrations(ctx, db); err != nil {
		log.Fatal(err)
	}
	if cfg.DevSeed {
		seedDevelopmentEndpoint(ctx, db)
	}
	application := server.New(cfg, db)
	if err := application.ImportLegacyOIDCProvider(ctx); err != nil {
		log.Fatalf("import legacy OIDC provider: %v", err)
	}
	workerContext, cancel := context.WithCancel(ctx)
	defer cancel()
	application.RAG.Start(workerContext)
	application.StartRepositoryWorker(workerContext)
	application.Live.Start(workerContext)
	server := &http.Server{
		Addr:              cfg.Address(),
		Handler:           application.Router(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("JustAI backend listening on %s", cfg.Address())
	serverErr := make(chan error, 1)
	go func() {
		serverErr <- server.ListenAndServe()
	}()
	select {
	case err := <-serverErr:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case <-ctx.Done():
		shutdownContext, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			log.Printf("backend graceful shutdown failed: %v", err)
		}
	}
}

func seedDevelopmentEndpoint(ctx context.Context, db *sql.DB) {
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM endpoint_settings`).Scan(&count); err != nil || count > 0 {
		return
	}
	_, _ = db.ExecContext(ctx, `INSERT INTO endpoint_settings (id, scope_type, provider_type, name, base_url, chat_model, capabilities, enabled, is_default) VALUES ($1, 'global', 'mock', 'JustAI demo endpoint', 'http://mock.local', 'justai-demo', '{"chat":true}', TRUE, TRUE)`, uuid.New())
}
