-- Notes are durable workspace content. This relation controls which notes are
-- available as context for a conversation without copying or freezing the
-- note's content into a separate Knowledge source.
CREATE TABLE IF NOT EXISTS conversation_notes (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, note_id)
);

CREATE INDEX IF NOT EXISTS conversation_notes_note_idx
    ON conversation_notes(note_id);
