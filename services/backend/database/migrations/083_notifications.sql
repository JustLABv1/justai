-- Notifications: shown in the app, and sent by e-mail and browser push when set up.
CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    -- Path inside the app, for example /live-transcription/<id>.
    link text NOT NULL DEFAULT '',
    session_id uuid REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    dedupe_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz,
    UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, organization_id, created_at DESC);

-- Per-user delivery settings. locale picks the language of e-mails and push texts.
CREATE TABLE notification_settings (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email_enabled boolean NOT NULL DEFAULT true,
    locale text NOT NULL DEFAULT 'en',
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Browser push subscriptions (Web Push, RFC 8030/8291/8292).
CREATE TABLE push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_success_at timestamptz,
    failure_count integer NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- The instance's VAPID key pair, made on first use. The private key is encrypted.
CREATE TABLE push_vapid_keys (
    id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    public_key text NOT NULL,
    private_key_ciphertext bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- People who turned notifications off for one live transcript.
CREATE TABLE transcription_notification_mutes (
    session_id uuid NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, user_id)
);

-- What has been announced already; earlier sessions and topics are not announced.
ALTER TABLE transcription_topics ADD COLUMN notified_at timestamptz;
ALTER TABLE transcription_sessions ADD COLUMN done_notified_at timestamptz;
UPDATE transcription_topics SET notified_at = now() WHERE status = 'done';
UPDATE transcription_sessions SET done_notified_at = now() WHERE status IN ('completed', 'failed');
CREATE INDEX transcription_topics_unnotified_idx ON transcription_topics (updated_at) WHERE status = 'done' AND notified_at IS NULL;
CREATE INDEX transcription_sessions_unnotified_idx ON transcription_sessions (ended_at) WHERE status = 'completed' AND done_notified_at IS NULL;
