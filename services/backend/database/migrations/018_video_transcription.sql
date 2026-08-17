ALTER TABLE transcription_jobs DROP CONSTRAINT IF EXISTS transcription_jobs_status_check;
ALTER TABLE transcription_jobs ADD CONSTRAINT transcription_jobs_status_check CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled'));
ALTER TABLE transcription_jobs ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE transcription_jobs ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS transcription_video_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    storage_driver TEXT NOT NULL CHECK (storage_driver = 's3'),
    storage_key TEXT NOT NULL UNIQUE,
    multipart_upload_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    expected_bytes BIGINT NOT NULL CHECK (expected_bytes > 0),
    bytes BIGINT NOT NULL DEFAULT 0,
    part_size BIGINT NOT NULL CHECK (part_size >= 5242880),
    part_count INTEGER NOT NULL CHECK (part_count > 0),
    status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'uploaded', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    stage TEXT NOT NULL DEFAULT 'uploading',
    duration_ms BIGINT NOT NULL DEFAULT 0,
    error_message TEXT,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcription_video_uploads_session_idx
    ON transcription_video_uploads(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS transcription_video_uploads_expiry_idx
    ON transcription_video_uploads(expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS transcription_jobs_active_video_upload_idx
    ON transcription_jobs ((payload->>'uploadId'))
    WHERE job_type = 'video_transcription' AND status IN ('queued', 'processing');
