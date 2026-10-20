CREATE TABLE transcription_speaker_caption_runs (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    upload_id UUID NOT NULL REFERENCES transcription_video_uploads(id) ON DELETE CASCADE,
    endpoint_id UUID NOT NULL REFERENCES endpoint_settings(id) ON DELETE CASCADE,
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    auto_apply BOOLEAN NOT NULL DEFAULT FALSE,
    frame_budget INTEGER NOT NULL CHECK (frame_budget BETWEEN 1 AND 48),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','cancelled')),
    frames JSONB NOT NULL DEFAULT '[]'::jsonb,
    observations JSONB NOT NULL DEFAULT '[]'::jsonb,
    results JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transcription_speaker_caption_active_session_idx
    ON transcription_speaker_caption_runs(session_id) WHERE status IN ('queued','processing');
CREATE INDEX transcription_speaker_caption_queue_idx
    ON transcription_speaker_caption_runs(status, created_at);
