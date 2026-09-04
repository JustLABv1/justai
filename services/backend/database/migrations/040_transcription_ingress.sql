-- External transcription ingress sources. URLs are encrypted by the backend;
-- bot credentials are bearer secrets and are stored only as hashes.
CREATE TABLE IF NOT EXISTS transcription_stream_sources (
    source_id UUID PRIMARY KEY REFERENCES transcription_sources(id) ON DELETE CASCADE,
    url_ciphertext BYTEA NOT NULL,
    protocol TEXT NOT NULL CHECK (protocol IN ('http', 'https', 'rtmp', 'rtmps')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connecting', 'connected', 'reconnecting', 'stopped', 'failed')),
    reconnect_count INTEGER NOT NULL DEFAULT 0 CHECK (reconnect_count >= 0),
    last_error TEXT NOT NULL DEFAULT '',
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcription_stream_sources_status_idx
    ON transcription_stream_sources(status, updated_at);

CREATE TABLE IF NOT EXISTS transcription_bot_sources (
    source_id UUID PRIMARY KEY REFERENCES transcription_sources(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('generic', 'zoom', 'google-meet', 'microsoft-teams')),
    meeting_url_ciphertext BYTEA,
    ingest_token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'disconnected', 'stopped')),
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcription_bot_sources_status_idx
    ON transcription_bot_sources(status, updated_at);
