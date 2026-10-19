ALTER TABLE transcription_speakers
 ADD COLUMN IF NOT EXISTS name_source TEXT NOT NULL DEFAULT '' CHECK (name_source IN ('', 'manual', 'ai')),
 ADD COLUMN IF NOT EXISTS suggested_name TEXT NOT NULL DEFAULT '',
 ADD COLUMN IF NOT EXISTS suggestion_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS suggestion_evidence TEXT NOT NULL DEFAULT '';

ALTER TABLE transcription_sessions
 ADD COLUMN IF NOT EXISTS participants JSONB NOT NULL DEFAULT '[]'::jsonb;
