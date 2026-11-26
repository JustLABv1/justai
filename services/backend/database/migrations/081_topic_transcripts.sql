-- Each finished agenda item gets its own transcript (a completed session holding a copy
-- of the item's lines and speakers), so it can be edited, summarised and shared alone.
ALTER TABLE transcription_topics
    ADD COLUMN transcript_session_id uuid REFERENCES transcription_sessions(id) ON DELETE SET NULL,
    ADD COLUMN transcript_synced_at timestamptz;
