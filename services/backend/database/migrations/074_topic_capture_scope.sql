-- Capture only selected agenda items: the stream source records around the selected
-- topics and pauses in between, instead of transcribing the whole sitting.
ALTER TABLE transcription_stream_sources
    ADD COLUMN IF NOT EXISTS capture_scope TEXT NOT NULL DEFAULT 'all'
        CHECK (capture_scope IN ('all', 'topics'));

-- A selected topic can be missed when the sitting reached it before the capture window.
ALTER TABLE transcription_topics
    DROP CONSTRAINT IF EXISTS transcription_topics_detected_by_check;

ALTER TABLE transcription_topics
    ADD CONSTRAINT transcription_topics_detected_by_check
    CHECK (detected_by IN ('', 'announcement', 'manual', 'sitting_closed', 'stream_ended', 'missed'));
