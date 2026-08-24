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
		"latest migration":                     `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '032_transcription_insight_language.sql')`,
		"platform settings":                    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'platform_settings')`,
		"organization endpoint default":        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organization_default_endpoints')`,
		"chat runs":                            `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'chat_runs')`,
		"approval-paused chat runs":            `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chat_runs'::regclass AND conname = 'chat_runs_status_check' AND pg_get_constraintdef(oid) LIKE '%requires-action%')`,
		"chat stream chunks":                   `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'chat_stream_chunks')`,
		"conversation knowledge context":       `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'conversation_knowledge_sources')`,
		"message scoped context column":        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conversation_knowledge_sources' AND column_name = 'context_scope')`,
		"one active ingestion job index":       `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ingestion_jobs_one_active_per_source_idx')`,
		"encrypted transcription grant column": `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transcription_join_requests' AND column_name = 'grant_token_encrypted')`,
		"MCP discovery marker":                 `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_servers' AND column_name = 'tools_discovered_at')`,
		"MCP server icon":                      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_servers' AND column_name = 'icon_url')`,
		"MCP server icon uploads":              `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'mcp_server_icons')`,
		"MCP tool metadata":                    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_server_tools' AND column_name = 'metadata')`,
		"MCP automatic discovery policy":       `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_servers' AND column_name = 'auto_discover')`,
		"vision model":                         `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'endpoint_settings' AND column_name = 'vision_model')`,
		"local auth control":                   `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'platform_settings' AND column_name = 'local_auth_enabled')`,
		"OIDC provider catalog":                `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'oidc_providers')`,
		"OIDC authorization state":             `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'oidc_auth_states')`,
		"platform banners":                     `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'platform_banners')`,
		"video upload table":                   `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'transcription_video_uploads')`,
		"video job lease":                      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transcription_jobs' AND column_name = 'lease_until')`,
		"video worker start telemetry":         `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transcription_jobs' AND column_name = 'started_at') AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transcription_jobs' AND column_name = 'completed_at')`,
		"grammar endpoint":                     `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transcription_sessions' AND column_name = 'grammar_endpoint_id')`,
		"polished transcript":                  `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transcription_segments' AND column_name = 'polished_text')`,
		"edited transcript":                    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transcription_segments' AND column_name = 'edited_text')`,
		"transcription annotations":            `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'transcription_annotations')`,
		"transcription insights":               `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'transcription_insights')`,
		"transcription insight language":       `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transcription_insights' AND column_name = 'language')`,
		"pyannote endpoint provider":           `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.endpoint_settings'::regclass AND conname = 'endpoint_settings_provider_type_check' AND pg_get_constraintdef(oid) LIKE '%pyannote%')`,
		"endpoint kind":                        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'endpoint_settings' AND column_name = 'endpoint_kind')`,
		"video pipeline steps":                 `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transcription_video_uploads' AND column_name = 'pipeline_steps')`,
		"repository contexts":                  `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'repository_contexts')`,
		"repository context files":             `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'repository_context_files')`,
		"conversation repository context":      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'conversation_repository_contexts')`,
		"saved assistants":                     `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'saved_assistants')`,
		"saved assistant versions":             `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'saved_assistant_versions')`,
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
