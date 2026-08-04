package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"

	"justai-backend/config"
	"justai-backend/database"
	"justai-backend/server"
)

func main() {
	cfg := config.Load()
	ctx := context.Background()
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
	workerContext, cancel := context.WithCancel(ctx)
	defer cancel()
	application.RAG.Start(workerContext)
	server := &http.Server{
		Addr:              cfg.Address(),
		Handler:           application.Router(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("JustAI backend listening on %s", cfg.Address())
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func seedDevelopmentEndpoint(ctx context.Context, db *sql.DB) {
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM endpoint_settings`).Scan(&count); err != nil || count > 0 {
		return
	}
	_, _ = db.ExecContext(ctx, `INSERT INTO endpoint_settings (id, scope_type, provider_type, name, base_url, chat_model, capabilities, enabled, is_default) VALUES ($1, 'global', 'mock', 'JustAI demo endpoint', 'http://mock.local', 'justai-demo', '{"chat":true}', TRUE, TRUE)`, uuid.New())
}
