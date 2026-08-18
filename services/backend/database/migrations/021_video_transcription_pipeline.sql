ALTER TABLE transcription_video_uploads
    ADD COLUMN IF NOT EXISTS pipeline_steps JSONB NOT NULL DEFAULT '[]'::jsonb;
