-- What the meeting-bot service reports about a bot it joined on the user's behalf:
-- starting, connecting, joining, in_call, ended or failed ('' for external adapters).
ALTER TABLE transcription_bot_sources
    ADD COLUMN IF NOT EXISTS join_status TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS join_error TEXT NOT NULL DEFAULT '';
