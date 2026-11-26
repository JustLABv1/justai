ALTER TABLE transcription_stream_sources
    ADD COLUMN outage_history jsonb NOT NULL DEFAULT '[]'::jsonb;
