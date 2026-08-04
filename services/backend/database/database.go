package database

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"time"

	_ "github.com/lib/pq"
)

//go:embed migrations/001_initial.sql
var migrationFS embed.FS

func Open(ctx context.Context, databaseURL string) (*sql.DB, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("JUSTAI_DATABASE_URL is required; start the local Postgres service and set it before running the backend")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(12)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func RunMigrations(ctx context.Context, db *sql.DB) error {
	migration, err := migrationFS.ReadFile("migrations/001_initial.sql")
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, string(migration))
	return err
}
