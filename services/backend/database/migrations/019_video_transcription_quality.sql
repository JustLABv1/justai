ALTER TABLE transcription_sessions
    ADD COLUMN IF NOT EXISTS grammar_endpoint_id UUID REFERENCES endpoint_settings(id) ON DELETE SET NULL;

ALTER TABLE transcription_sessions
    ADD COLUMN IF NOT EXISTS polish_status TEXT NOT NULL DEFAULT 'not_requested';

ALTER TABLE transcription_segments
    ADD COLUMN IF NOT EXISTS raw_text TEXT;

ALTER TABLE transcription_segments
    ADD COLUMN IF NOT EXISTS polished_text TEXT;

UPDATE transcription_segments
SET raw_text = text
WHERE raw_text IS NULL;

ALTER TABLE transcription_sessions
    DROP CONSTRAINT IF EXISTS transcription_sessions_polish_status_check;

ALTER TABLE transcription_sessions
    ADD CONSTRAINT transcription_sessions_polish_status_check
    CHECK (polish_status IN ('not_requested', 'queued', 'processing', 'completed', 'failed'));
