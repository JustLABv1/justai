ALTER TABLE transcription_sessions
    ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS transcription_sessions_done_scope_idx
    ON transcription_sessions(organization_id, user_id, done_at)
    WHERE archived_at IS NULL;
