-- Client realtime transports use SSE plus bounded HTTP uploads. Keep the
-- ticket data, but remove the obsolete WebSocket-specific table name.
ALTER TABLE IF EXISTS ws_tickets RENAME TO stream_tickets;
ALTER INDEX IF EXISTS ws_tickets_expiry_idx RENAME TO stream_tickets_expiry_idx;
ALTER INDEX IF EXISTS ws_tickets_conversation_idx RENAME TO stream_tickets_conversation_idx;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ws_tickets_kind_check'
          AND conrelid = 'stream_tickets'::regclass
    ) THEN
        ALTER TABLE stream_tickets
            RENAME CONSTRAINT ws_tickets_kind_check TO stream_tickets_kind_check;
    END IF;
END $$;
