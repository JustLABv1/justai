package database

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"time"

	_ "github.com/lib/pq"
)

//go:embed migrations/*.sql
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
	// Keep the advisory lock and all migration queries on one physical
	// connection. Without this, two backend instances can both observe an
	// unapplied migration and race its DDL/marker insert during a deploy.
	connection, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer connection.Close()
	const migrationLockName = "justai.schema_migrations"
	if _, err := connection.ExecContext(ctx, `SELECT pg_advisory_lock(hashtext($1))`, migrationLockName); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() {
		_, _ = connection.ExecContext(context.Background(), `SELECT pg_advisory_unlock(hashtext($1))`, migrationLockName)
	}()

	if _, err := connection.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	var initialSchemaExists bool
	if err := connection.QueryRowContext(ctx, `SELECT to_regclass('public.users') IS NOT NULL`).Scan(&initialSchemaExists); err != nil {
		return err
	}
	if initialSchemaExists {
		if _, err := connection.ExecContext(ctx, `INSERT INTO schema_migrations (version) VALUES ('001_initial.sql') ON CONFLICT (version) DO NOTHING`); err != nil {
			return fmt.Errorf("recognize existing initial schema: %w", err)
		}
	}
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		version := entry.Name()
		var applied bool
		if err := connection.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, version).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		migration, err := migrationFS.ReadFile("migrations/" + version)
		if err != nil {
			return err
		}
		transaction, err := connection.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := transaction.ExecContext(ctx, string(migration)); err != nil {
			_ = transaction.Rollback()
			return fmt.Errorf("apply migration %s: %w", version, err)
		}
		if _, err := transaction.ExecContext(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, version); err != nil {
			_ = transaction.Rollback()
			return err
		}
		if err := transaction.Commit(); err != nil {
			return err
		}
	}
	return nil
}
