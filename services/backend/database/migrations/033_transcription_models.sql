ALTER TABLE transcription_sessions
    ADD COLUMN IF NOT EXISTS transcription_model TEXT;

ALTER TABLE transcription_sessions
    ADD COLUMN IF NOT EXISTS diarization_model TEXT;

ALTER TABLE transcription_sessions
    ADD COLUMN IF NOT EXISTS grammar_model TEXT;
