-- Short-lived, database-backed UI message streams. The stream id is returned
-- to Assistant UI clients so a browser can reconnect after a transport drop
-- without restarting the provider request or replaying MCP side effects.
CREATE TABLE IF NOT EXISTS chat_streams (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    run_id UUID REFERENCES chat_runs(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'streaming',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
    CONSTRAINT chat_streams_status_check
      CHECK (status IN ('streaming', 'complete', 'requires-action', 'error', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS chat_stream_chunks (
    id BIGSERIAL PRIMARY KEY,
    stream_id UUID NOT NULL REFERENCES chat_streams(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_streams_owner_idx
    ON chat_streams(organization_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_streams_expiry_idx
    ON chat_streams(expires_at);

CREATE INDEX IF NOT EXISTS chat_stream_chunks_stream_idx
    ON chat_stream_chunks(stream_id, id);
