-- Conversation-scoped context and operational metadata. This migration is
-- additive so existing conversations, sources, and MCP servers remain valid.
CREATE TABLE IF NOT EXISTS conversation_knowledge_sources (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, source_id)
);

CREATE INDEX IF NOT EXISTS conversation_knowledge_sources_source_idx
    ON conversation_knowledge_sources(source_id);

ALTER TABLE knowledge_sources
    ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS knowledge_sources_conversation_idx
    ON knowledge_sources(conversation_id)
    WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_mcp_servers (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, server_id)
);

CREATE INDEX IF NOT EXISTS conversation_mcp_servers_server_idx
    ON conversation_mcp_servers(server_id);

CREATE TABLE IF NOT EXISTS conversation_transcription_sessions (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, session_id)
);

CREATE INDEX IF NOT EXISTS conversation_transcription_sessions_session_idx
    ON conversation_transcription_sessions(session_id);

ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS trusted_read_only BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS last_tested_at TIMESTAMPTZ;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS protocol_version TEXT;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS oauth_refresh_credential BYTEA;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS oauth_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS mcp_server_tools (
    server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    title TEXT,
    description TEXT,
    input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
    annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, name)
);

ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS run_after TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS ingestion_jobs_ready_idx
    ON ingestion_jobs(status, run_after, lease_until, created_at);

WITH ranked_active_jobs AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY created_at, id) AS rank
    FROM ingestion_jobs
    WHERE status IN ('queued', 'processing')
)
UPDATE ingestion_jobs
SET status = 'failed',
    error_message = COALESCE(error_message, 'superseded by a newer active ingestion job'),
    lease_until = NULL,
    updated_at = now()
WHERE id IN (SELECT id FROM ranked_active_jobs WHERE rank > 1);

CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_one_active_per_source_idx
    ON ingestion_jobs(source_id)
    WHERE status IN ('queued', 'processing');

ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER;
ALTER TABLE knowledge_chunks ALTER COLUMN embedding TYPE vector USING embedding::vector;
UPDATE knowledge_chunks SET embedding_dimension = vector_dims(embedding)
WHERE embedding IS NOT NULL AND embedding_dimension IS NULL;

CREATE INDEX IF NOT EXISTS transcription_segments_search_idx
    ON transcription_segments USING GIN (to_tsvector('simple', text));

WITH ranked_defaults AS (
    SELECT id, ROW_NUMBER() OVER (
        PARTITION BY scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY created_at, id
    ) AS rank
    FROM endpoint_settings
    WHERE is_default = TRUE
)
UPDATE endpoint_settings
SET is_default = FALSE
WHERE id IN (SELECT id FROM ranked_defaults WHERE rank > 1);

CREATE UNIQUE INDEX IF NOT EXISTS endpoint_settings_default_scope_idx
    ON endpoint_settings(scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE is_default = TRUE;
