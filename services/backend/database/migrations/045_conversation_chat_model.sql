-- A conversation remembers the routing choice from its latest successful
-- chat turn. The endpoint configuration remains unchanged; this is only the
-- conversation-specific selection that the user may change on a later turn.
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS chat_model TEXT;
