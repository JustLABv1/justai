-- Instance restores replace every application table. Their progress must stay
-- readable while that happens (the administrator's session is replaced too),
-- so this table deliberately has no foreign keys, is never exported, and is
-- never truncated by a restore.
CREATE TABLE IF NOT EXISTS backup_restore_jobs (
    id UUID PRIMARY KEY,
    created_by UUID,
    created_by_email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    file_name TEXT NOT NULL DEFAULT '',
    expected_bytes BIGINT NOT NULL,
    received_bytes BIGINT NOT NULL DEFAULT 0,
    staging_path TEXT NOT NULL,
    manifest JSONB,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    progress JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT NOT NULL DEFAULT '',
    status_token_hash BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS backup_restore_jobs_created_at_idx ON backup_restore_jobs (created_at DESC);
