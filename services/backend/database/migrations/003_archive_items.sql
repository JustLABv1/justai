ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE transcription_sessions
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS conversations_active_scope_idx
    ON conversations(user_id, organization_id, updated_at DESC)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS transcription_sessions_active_scope_idx
    ON transcription_sessions(organization_id, user_id, updated_at DESC)
    WHERE archived_at IS NULL;
