-- Webhooks a user adds to receive their notifications in other tools. The URL is
-- encrypted because Slack, Teams and Discord URLs are credentials themselves.
CREATE TABLE notification_webhooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    format text NOT NULL CHECK (format IN ('json', 'slack', 'teams', 'discord')),
    url_ciphertext bytea NOT NULL,
    -- Host only, to show which service it is without revealing the URL.
    url_hint text NOT NULL,
    -- Signs json deliveries (HMAC-SHA256).
    secret_ciphertext bytea,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_success_at timestamptz,
    last_error text NOT NULL DEFAULT '',
    last_error_at timestamptz,
    failure_count integer NOT NULL DEFAULT 0
);
CREATE INDEX notification_webhooks_user_idx ON notification_webhooks (user_id);
