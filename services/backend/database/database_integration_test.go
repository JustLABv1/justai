//go:build integration

package database

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestRunMigrationsIntegration(t *testing.T) {
	databaseURL := os.Getenv("JUSTAI_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("JUSTAI_DATABASE_URL is not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	if err := RunMigrations(ctx, db); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	// Migration startup must be idempotent: a restarted backend should not
	// reapply or partially reapply an already-complete migration set.
	if err := RunMigrations(ctx, db); err != nil {
		t.Fatalf("rerun migrations: %v", err)
	}

	checks := map[string]string{
		"latest migration":                     `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '015_oidc_and_banners.sql')`,
		"platform settings":                    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'platform_settings')`,
		"organization endpoint default":        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organization_default_endpoints')`,
		"chat runs":                            `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'chat_runs')`,
		"chat stream chunks":                   `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'chat_stream_chunks')`,
		"conversation knowledge context":       `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'conversation_knowledge_sources')`,
		"message scoped context column":        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conversation_knowledge_sources' AND column_name = 'context_scope')`,
		"one active ingestion job index":       `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ingestion_jobs_one_active_per_source_idx')`,
		"encrypted transcription grant column": `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transcription_join_requests' AND column_name = 'grant_token_encrypted')`,
		"MCP discovery marker":                 `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_servers' AND column_name = 'tools_discovered_at')`,
		"MCP tool metadata":                    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_server_tools' AND column_name = 'metadata')`,
		"vision model":                         `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'endpoint_settings' AND column_name = 'vision_model')`,
		"local auth control":                   `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'platform_settings' AND column_name = 'local_auth_enabled')`,
		"OIDC provider catalog":                `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'oidc_providers')`,
		"OIDC authorization state":             `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'oidc_auth_states')`,
		"platform banners":                     `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'platform_banners')`,
	}
	for name, query := range checks {
		var present bool
		if err := db.QueryRowContext(ctx, query).Scan(&present); err != nil {
			t.Errorf("%s query: %v", name, err)
			continue
		}
		if !present {
			t.Errorf("%s is missing", name)
		}
	}
}
