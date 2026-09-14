-- Bind each OIDC authorization attempt to the allowlisted frontend origin that
-- initiated it, so multi-ingress deployments return users to the same host.
ALTER TABLE oidc_auth_states
    ADD COLUMN IF NOT EXISTS frontend_origin TEXT NOT NULL DEFAULT '';
