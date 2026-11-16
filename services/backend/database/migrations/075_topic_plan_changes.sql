-- Remember when the published plan moved an agenda item, and where it was first
-- planned, so the session can show "moved from 13:00" before the capture starts.
ALTER TABLE transcription_topics
    ADD COLUMN IF NOT EXISTS original_start_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS plan_changed_at TIMESTAMPTZ;
