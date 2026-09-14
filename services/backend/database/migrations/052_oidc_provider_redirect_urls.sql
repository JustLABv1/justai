-- Each identity provider may require a distinct registered callback URL.
-- Empty values retain the legacy global oidc.redirect_url fallback.
ALTER TABLE oidc_providers
    ADD COLUMN IF NOT EXISTS redirect_url TEXT NOT NULL DEFAULT '';
