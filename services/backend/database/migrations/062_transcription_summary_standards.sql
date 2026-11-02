-- Personal standards follow the user across sessions, organizations and devices.
CREATE TABLE transcription_summary_standards (
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 settings JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep the source scope visible when reopening or regenerating a summary.
ALTER TABLE transcription_insights ADD COLUMN customization JSONB NOT NULL DEFAULT '{}';
