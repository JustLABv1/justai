-- Read-only repository context. Repository files are copied into the existing
-- Knowledge/RAG pipeline so chat retrieval, readiness checks, and citations
-- keep one consistent path.
ALTER TABLE knowledge_sources
    DROP CONSTRAINT IF EXISTS knowledge_sources_source_type_check;

ALTER TABLE knowledge_sources
    ADD CONSTRAINT knowledge_sources_source_type_check
    CHECK (source_type IN ('upload', 'url', 'text', 'repository'));

CREATE TABLE IF NOT EXISTS repository_contexts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'user')),
    scope_id UUID NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
    repository_url TEXT NOT NULL,
    owner TEXT NOT NULL,
    repository TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT 'HEAD',
    resolved_ref TEXT,
    title TEXT NOT NULL,
    encrypted_credential BYTEA,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('processing', 'queued', 'ready', 'failed')),
    error_message TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    skipped_file_count INTEGER NOT NULL DEFAULT 0,
    total_bytes BIGINT NOT NULL DEFAULT 0,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, provider, repository_url, ref)
);

CREATE INDEX IF NOT EXISTS repository_contexts_conversation_idx
    ON repository_contexts(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS repository_context_files (
    context_id UUID NOT NULL REFERENCES repository_contexts(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    content_hash TEXT,
    PRIMARY KEY (context_id, path),
    UNIQUE (context_id, source_id)
);

CREATE INDEX IF NOT EXISTS repository_context_files_source_idx
    ON repository_context_files(source_id);

CREATE TABLE IF NOT EXISTS conversation_repository_contexts (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    context_id UUID NOT NULL REFERENCES repository_contexts(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    context_scope TEXT NOT NULL DEFAULT 'persistent',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, context_id),
    CONSTRAINT conversation_repository_contexts_scope_check
        CHECK (context_scope IN ('persistent', 'message'))
);

CREATE INDEX IF NOT EXISTS conversation_repository_contexts_context_idx
    ON conversation_repository_contexts(context_id);
