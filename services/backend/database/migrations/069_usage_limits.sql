-- Monthly token budgets. A workspace has a default per member; admins can give
-- one member their own limit (or lift the limit for them with a NULL one).
CREATE TABLE organization_usage_limits (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    monthly_token_limit BIGINT CHECK (monthly_token_limit IS NULL OR monthly_token_limit >= 0),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organization_member_usage_limits (
    organization_id UUID NOT NULL,
    user_id UUID NOT NULL,
    monthly_token_limit BIGINT CHECK (monthly_token_limit IS NULL OR monthly_token_limit >= 0),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_id),
    FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chat_runs_member_started_idx
    ON chat_runs(organization_id, user_id, started_at DESC);
