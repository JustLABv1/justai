-- Reliability, security, and operational foundations.

-- Access tokens now carry a stable per-device session identifier. Keeping
-- sessions durable lets an administrator revoke one browser without changing
-- every session for the user (session_version remains the emergency global
-- revocation switch).
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    user_agent TEXT NOT NULL DEFAULT '',
    ip_address INET
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx
    ON user_sessions(user_id, revoked_at, expires_at DESC);

-- A shared, short-lived counter provides a safe multi-replica fallback when
-- Redis is not deployed. Keys are SHA-256 values, never raw emails or IPs.
CREATE TABLE IF NOT EXISTS api_rate_limit_buckets (
    bucket_key TEXT PRIMARY KEY,
    window_started_at TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 0),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS api_rate_limit_buckets_expiry_idx
    ON api_rate_limit_buckets(expires_at);

-- Heartbeats are intentionally keyed by backend instance so a healthy
-- replica cannot hide a dead one during incident diagnosis.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_name TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (worker_name, instance_id)
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_recent_idx
    ON worker_heartbeats(worker_name, heartbeat_at DESC);

-- A recording part is acknowledged only after this row and the recording
-- cursor are committed. It makes retries idempotent for both local and S3
-- storage drivers.
CREATE TABLE IF NOT EXISTS transcription_recording_parts (
    recording_id UUID NOT NULL REFERENCES transcription_recordings(id) ON DELETE CASCADE,
    part INTEGER NOT NULL CHECK (part >= 0),
    payload_hash TEXT NOT NULL,
    payload_bytes BIGINT NOT NULL CHECK (payload_bytes > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (recording_id, part)
);

-- Fencing fields prevent an expired worker from committing work after another
-- worker has reclaimed the same job.
ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS lease_epoch BIGINT NOT NULL DEFAULT 0;
ALTER TABLE transcription_jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE transcription_jobs ADD COLUMN IF NOT EXISTS lease_epoch BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ingestion_jobs_lease_idx
    ON ingestion_jobs(status, lease_until, lease_owner);
CREATE INDEX IF NOT EXISTS transcription_jobs_lease_idx
    ON transcription_jobs(job_type, status, lease_until, lease_owner);

-- Generated search vectors avoid recomputing the same tsvector for every
-- result row. Existing title/content remain the source of truth.
ALTER TABLE knowledge_chunks
    ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(title, '') || ' ' || COALESCE(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS knowledge_chunks_search_vector_idx
    ON knowledge_chunks USING GIN (search_vector);

-- Identical user/upload/text sources in one scope should share one durable
-- ingestion job. URL sources are excluded because their content is fetched
-- asynchronously and may legitimately change over time.
--
-- Older installations may already contain equivalent sources from before the
-- deduplication policy existed. Preserve every source and its chunks, but let
-- the earliest source retain the hash; clearing the duplicate hash makes the
-- new partial unique index safe to create without deleting or merging user
-- data. A subsequent re-upload then resolves to that canonical source.
WITH ranked_duplicate_sources AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY scope_type, scope_id, content_hash
               ORDER BY created_at ASC, id ASC
           ) AS source_rank
    FROM knowledge_sources
    WHERE content_hash IS NOT NULL
      AND content_hash <> ''
      AND source_type <> 'url'
)
UPDATE knowledge_sources AS source
SET content_hash = NULL
FROM ranked_duplicate_sources AS duplicate
WHERE source.id = duplicate.id
  AND duplicate.source_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_sources_scope_hash_idx
    ON knowledge_sources(scope_type, scope_id, content_hash)
    WHERE content_hash IS NOT NULL AND content_hash <> '' AND source_type <> 'url';

-- API request logs are retained as an audit/troubleshooting signal but need a
-- bounded cleanup path and request correlation.
ALTER TABLE api_request_logs ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE INDEX IF NOT EXISTS api_request_logs_created_idx
    ON api_request_logs(created_at DESC);
