-- Watch windows for livestream capture: instead of a fixed start time a source can
-- wait for the broadcast to go live (speech detected), follow a published
-- programme plan, stop after a stretch without speech, and carry an alert.
ALTER TABLE transcription_stream_sources
    ADD COLUMN IF NOT EXISTS start_mode TEXT NOT NULL DEFAULT 'at_time'
        CHECK (start_mode IN ('at_time', 'when_live')),
    ADD COLUMN IF NOT EXISTS silence_stop_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (silence_stop_seconds BETWEEN 0 AND 14400),
    ADD COLUMN IF NOT EXISTS plan_follow BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS plan_key TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS plan_fallback_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS alert TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;

ALTER TABLE transcription_stream_sources
    DROP CONSTRAINT IF EXISTS transcription_stream_sources_status_check;

ALTER TABLE transcription_stream_sources
    ADD CONSTRAINT transcription_stream_sources_status_check
    CHECK (status IN ('scheduled', 'watching', 'pending', 'connecting', 'connected', 'reconnecting', 'stopped', 'failed'));
