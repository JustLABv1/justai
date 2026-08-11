ALTER TABLE endpoint_settings ADD COLUMN IF NOT EXISTS speech_model TEXT;

ALTER TABLE ws_tickets DROP CONSTRAINT IF EXISTS ws_tickets_kind_check;
ALTER TABLE ws_tickets ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ws_tickets_kind_check') THEN
        ALTER TABLE ws_tickets ADD CONSTRAINT ws_tickets_kind_check CHECK (kind IN ('chat', 'voice', 'transcription', 'transcription-viewer', 'transcription-capture'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ws_tickets_conversation_idx ON ws_tickets(conversation_id) WHERE conversation_id IS NOT NULL;
