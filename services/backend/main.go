package main

import (
	"context"
	"database/sql"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lmittmann/tint"

	"justai-backend/config"
	"justai-backend/database"
	"justai-backend/server"
)

func main() {
	configureLogger(os.Getenv("JUSTAI_ENV"))
	// Gin's debug mode prints every registered route during startup. The backend
	// owns request logging, so keep Gin quiet in every normal runtime.
	gin.SetMode(gin.ReleaseMode)
	var configPath string
	flag.StringVar(&configPath, "c", "", "path to a YAML config file")
	flag.StringVar(&configPath, "config", "", "path to a YAML config file")
	flag.Parse()

	cfg, err := config.Load(configPath)
	if err != nil {
		slog.Error("configuration failed", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := database.RunMigrations(ctx, db); err != nil {
		slog.Error("database migrations failed", "error", err)
		os.Exit(1)
	}
	if cfg.DevSeed {
		seedDevelopmentEndpoint(ctx, db)
	}
	application := server.New(cfg, db)
	if err := application.ImportLegacyOIDCProvider(ctx); err != nil {
		slog.Error("import legacy OIDC provider failed", "error", err)
		os.Exit(1)
	}
	workerContext, cancel := context.WithCancel(ctx)
	defer cancel()
	application.RAG.Start(workerContext)
	application.StartRepositoryWorker(workerContext)
	application.StartLifecycleWorker(workerContext)
	application.Live.Start(workerContext)
	server := &http.Server{
		Addr:              cfg.Address(),
		Handler:           application.Router(),
		ReadHeaderTimeout: 10 * time.Second,
		// Video parts are streamed through this server and the browser allows a
		// part up to ten minutes on constrained links. Keep a finite body-read
		// deadline with enough margin for that client contract.
		ReadTimeout:  11 * time.Minute,
		WriteTimeout: 0,
		IdleTimeout:  120 * time.Second,
	}
	slog.Info("JustAI backend listening", "address", cfg.Address(), "ginMode", gin.Mode())
	serverErr := make(chan error, 1)
	go func() {
		serverErr <- server.ListenAndServe()
	}()
	select {
	case err := <-serverErr:
		if err != nil && err != http.ErrServerClosed {
			slog.Error("HTTP server stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		shutdownContext, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			slog.Warn("backend graceful shutdown failed", "error", err)
		}
	}
}

func configureLogger(environment string) {
	level := slog.LevelInfo
	switch strings.ToLower(strings.TrimSpace(os.Getenv("JUSTAI_LOG_LEVEL"))) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}

	environment = strings.ToLower(strings.TrimSpace(environment))
	if environment == "production" || environment == "prod" {
		slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})))
		return
	}
	noColor := true
	if info, err := os.Stdout.Stat(); err == nil {
		noColor = info.Mode()&os.ModeCharDevice == 0
	}
	slog.SetDefault(slog.New(tint.NewHandler(os.Stdout, &tint.Options{
		Level:      level,
		TimeFormat: "15:04:05.000",
		NoColor:    noColor,
	})))
}

func seedDevelopmentEndpoint(ctx context.Context, db *sql.DB) {
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM endpoint_settings`).Scan(&count); err != nil || count > 0 {
		return
	}
	_, _ = db.ExecContext(ctx, `INSERT INTO endpoint_settings (id, scope_type, provider_type, name, base_url, chat_model, capabilities, enabled, is_default) VALUES ($1, 'global', 'mock', 'JustAI demo endpoint', 'http://mock.local', 'justai-demo', '{"chat":true}', TRUE, TRUE)`, uuid.New())
}
