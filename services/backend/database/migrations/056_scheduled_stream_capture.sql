-- Durable scheduling and automatic end detection for direct livestream capture.
ALTER TABLE transcription_stream_sources
    ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reconnect_grace_seconds INTEGER NOT NULL DEFAULT 900
        CHECK (reconnect_grace_seconds BETWEEN 60 AND 3600);

ALTER TABLE transcription_stream_sources
    DROP CONSTRAINT IF EXISTS transcription_stream_sources_status_check;

ALTER TABLE transcription_stream_sources
    ADD CONSTRAINT transcription_stream_sources_status_check
    CHECK (status IN ('scheduled', 'pending', 'connecting', 'connected', 'reconnecting', 'stopped', 'failed'));

CREATE INDEX IF NOT EXISTS transcription_stream_sources_schedule_idx
    ON transcription_stream_sources(scheduled_start_at, status)
    WHERE status = 'scheduled';
