-- Topic subscriptions: keywords that pick agenda items of every upcoming Bundestag
-- sitting and schedule a "selected topics only" capture for them. The session settings
-- and stream link are copied from the session the subscription was made from.
CREATE TABLE IF NOT EXISTS transcription_topic_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    keywords TEXT[] NOT NULL,
    url_ciphertext BYTEA NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    transcription_endpoint_id UUID REFERENCES endpoint_settings(id) ON DELETE SET NULL,
    diarization_endpoint_id UUID REFERENCES endpoint_settings(id) ON DELETE SET NULL,
    grammar_endpoint_id UUID REFERENCES endpoint_settings(id) ON DELETE SET NULL,
    transcription_model TEXT,
    diarization_model TEXT,
    grammar_model TEXT,
    language TEXT NOT NULL DEFAULT 'auto',
    record_audio BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_checked_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcription_topic_subscriptions_owner_idx
    ON transcription_topic_subscriptions(user_id, organization_id);

-- One capture per subscription and sitting, so a sitting is never scheduled twice.
CREATE TABLE IF NOT EXISTS transcription_topic_subscription_sittings (
    subscription_id UUID NOT NULL REFERENCES transcription_topic_subscriptions(id) ON DELETE CASCADE,
    sitting_no INT NOT NULL,
    session_id UUID REFERENCES transcription_sessions(id) ON DELETE SET NULL,
    topic_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (subscription_id, sitting_no)
);

-- Read-only links: whoever has the link can follow the transcript, nothing else.
CREATE TABLE IF NOT EXISTS transcription_view_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token_ciphertext BYTEA NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS transcription_view_links_active_idx
    ON transcription_view_links(session_id) WHERE revoked_at IS NULL;

-- Stream outages during a capture, and why a capture ended.
ALTER TABLE transcription_stream_sources
    ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS outage_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS outage_seconds INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS end_reason TEXT NOT NULL DEFAULT '';
