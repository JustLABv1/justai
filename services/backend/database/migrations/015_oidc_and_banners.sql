-- Platform-managed identity providers, authorization state, local-auth control,
-- and scheduled global announcements.
ALTER TABLE platform_settings
    ADD COLUMN IF NOT EXISTS local_auth_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS oidc_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    issuer TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    client_secret_ciphertext BYTEA NOT NULL,
    scopes TEXT NOT NULL DEFAULT 'openid profile email',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_tested_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oidc_providers_enabled_idx
    ON oidc_providers(enabled, display_name);

CREATE TABLE IF NOT EXISTS oidc_auth_states (
    state TEXT PRIMARY KEY,
    provider_id UUID NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
    nonce TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    next_path TEXT NOT NULL DEFAULT '/',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oidc_auth_states_expiry_idx
    ON oidc_auth_states(expires_at);

CREATE TABLE IF NOT EXISTS platform_banners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message TEXT NOT NULL CHECK (length(btrim(message)) > 0),
    severity TEXT NOT NULL DEFAULT 'info'
        CHECK (severity IN ('info', 'success', 'warning', 'danger')),
    link_url TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    dismissible BOOLEAN NOT NULL DEFAULT TRUE,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS platform_banners_schedule_idx
    ON platform_banners(enabled, starts_at, ends_at, priority DESC);
