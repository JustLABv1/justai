ALTER TABLE transcription_insights
    ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'auto';
