ALTER TABLE endpoint_settings ADD COLUMN IF NOT EXISTS diarization_model TEXT;

CREATE TABLE IF NOT EXISTS transcription_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Live session',
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'live', 'paused', 'processing', 'completed', 'failed')),
    transcription_endpoint_id UUID REFERENCES endpoint_settings(id) ON DELETE SET NULL,
    diarization_endpoint_id UUID REFERENCES endpoint_settings(id) ON DELETE SET NULL,
    language TEXT NOT NULL DEFAULT 'auto',
    record_audio BOOLEAN NOT NULL DEFAULT FALSE,
    join_code_hash TEXT,
    join_code_expires_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcription_sessions_scope_idx ON transcription_sessions(organization_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS transcription_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'browser',
    device_label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'paused', 'disconnected', 'stopped')),
    clock_offset_ms BIGINT NOT NULL DEFAULT 0,
    connected_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcription_sources_session_idx ON transcription_sources(session_id, created_at);

ALTER TABLE ws_tickets DROP CONSTRAINT IF EXISTS ws_tickets_kind_check;
ALTER TABLE ws_tickets ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES transcription_sessions(id) ON DELETE CASCADE;
ALTER TABLE ws_tickets ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES transcription_sources(id) ON DELETE CASCADE;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ws_tickets_kind_check') THEN
        ALTER TABLE ws_tickets ADD CONSTRAINT ws_tickets_kind_check CHECK (kind IN ('chat', 'transcription', 'transcription-viewer', 'transcription-capture'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS transcription_speakers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'violet',
    merged_into UUID REFERENCES transcription_speakers(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, label)
);

CREATE TABLE IF NOT EXISTS transcription_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    source_id UUID REFERENCES transcription_sources(id) ON DELETE SET NULL,
    speaker_id UUID REFERENCES transcription_speakers(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    start_offset_ms BIGINT NOT NULL,
    end_offset_ms BIGINT NOT NULL,
    confidence DOUBLE PRECISION,
    signal_quality DOUBLE PRECISION,
    canonical BOOLEAN NOT NULL DEFAULT TRUE,
    heard_by_source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcription_segments_session_idx ON transcription_segments(session_id, start_offset_ms, created_at);

CREATE TABLE IF NOT EXISTS transcription_recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES transcription_sources(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL,
    storage_driver TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    wrapped_key BYTEA NOT NULL,
    bytes BIGINT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE transcription_recordings ADD COLUMN IF NOT EXISTS next_part INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS transcription_recordings_expiry_idx ON transcription_recordings(expires_at);

CREATE TABLE IF NOT EXISTS transcription_join_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    request_hash TEXT NOT NULL UNIQUE,
    source_name TEXT NOT NULL,
    device_label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    source_id UUID REFERENCES transcription_sources(id) ON DELETE SET NULL,
    grant_hash TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcription_join_requests_session_idx ON transcription_join_requests(session_id, status, created_at);

CREATE TABLE IF NOT EXISTS transcription_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcription_jobs_queue_idx ON transcription_jobs(status, run_after, created_at);
