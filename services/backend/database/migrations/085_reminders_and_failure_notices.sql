-- Reminders the assistant sets in chat ("tell me in 20 minutes ...").
CREATE TABLE reminders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    message text NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
    due_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    cancelled_at timestamptz
);
CREATE INDEX reminders_due_idx ON reminders (due_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX reminders_user_idx ON reminders (user_id, due_at);

-- The user's time zone, so "at 3 pm" means their 3 pm.
ALTER TABLE notification_settings ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';

-- Problems during a transcription that were announced already.
ALTER TABLE transcription_live_processing ADD COLUMN failure_notified_at timestamptz;
UPDATE transcription_live_processing SET failure_notified_at = now() WHERE status = 'failed';
-- The interruption (its interrupted_at) the owner was told about.
ALTER TABLE transcription_stream_sources ADD COLUMN outage_notified_for timestamptz;
