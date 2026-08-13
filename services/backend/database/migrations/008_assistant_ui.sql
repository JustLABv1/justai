-- Assistant UI message persistence. The legacy content/citations columns stay
-- readable so existing conversations can be migrated lazily at the API edge.
-- Chat no longer uses WebSocket tickets; discard any short-lived legacy chat
-- tickets before tightening the ticket-kind constraint for voice/transcription.
ALTER TABLE ws_tickets DROP CONSTRAINT IF EXISTS ws_tickets_kind_check;
DELETE FROM ws_tickets WHERE kind = 'chat';
ALTER TABLE ws_tickets ADD CONSTRAINT ws_tickets_kind_check
  CHECK (kind IN ('voice', 'transcription', 'transcription-viewer', 'transcription-capture'));

ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'legacy-text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ui_message JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS run_status TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS feedback TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS messages_parent_idx ON messages(conversation_id, parent_id, created_at);
CREATE INDEX IF NOT EXISTS messages_ui_message_idx ON messages(id) WHERE ui_message IS NOT NULL;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_run_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_run_status_check
  CHECK (run_status IN ('running', 'requires-action', 'complete', 'incomplete'));

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_feedback_check;
ALTER TABLE messages ADD CONSTRAINT messages_feedback_check
  CHECK (feedback IS NULL OR feedback IN ('positive', 'negative'));

-- Give visible legacy user/assistant rows a stable UI-message envelope. Tool
-- rows are coalesced into dynamic tool parts by the read converter because
-- their server-side event JSON needs the richer status mapping.
UPDATE messages
SET format = 'ai-sdk-ui',
    ui_message = jsonb_build_object(
      'id', id::text,
      'role', role,
      'parts', jsonb_build_array(jsonb_build_object('type', 'text', 'text', content))
    ),
    updated_at = created_at
WHERE ui_message IS NULL AND role IN ('user', 'assistant');

UPDATE messages
SET updated_at = created_at
WHERE format = 'legacy-text';

-- Preserve the visible chronological path for existing conversations. New
-- branch writes use the same parent_id column, so the repository can expose a
-- canonical head without rewriting legacy message content.
WITH ordered AS (
  SELECT id,
         LAG(id) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS previous_id
  FROM messages
  WHERE role IN ('user', 'assistant', 'tool')
)
UPDATE messages AS current
SET parent_id = ordered.previous_id
FROM ordered
WHERE current.id = ordered.id
  AND current.parent_id IS NULL
  AND ordered.previous_id IS NOT NULL;
