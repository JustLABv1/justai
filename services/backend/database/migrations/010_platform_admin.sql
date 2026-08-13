-- Platform administration, lifecycle controls, and global MCP catalog support.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended'));

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_status_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_status_check CHECK (status IN ('active', 'archived', 'suspended'));

ALTER TABLE mcp_servers DROP CONSTRAINT IF EXISTS mcp_servers_scope_type_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_scope_type_check CHECK (scope_type IN ('global', 'organization', 'user'));
ALTER TABLE mcp_servers ALTER COLUMN scope_id DROP NOT NULL;
ALTER TABLE mcp_servers DROP CONSTRAINT IF EXISTS mcp_servers_scope_id_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_scope_id_check CHECK ((scope_type = 'global' AND scope_id IS NULL) OR (scope_type <> 'global' AND scope_id IS NOT NULL));

CREATE TABLE IF NOT EXISTS platform_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
    login_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    signup_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    voice_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    transcription_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    mcp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    knowledge_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    attachments_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    maintenance_message TEXT NOT NULL DEFAULT '',
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- Approval-paused chat runs are first-class states. Keep the historical
-- terminal error/cancelled states as well so analytics can distinguish an
-- interrupted request from a run waiting for an MCP decision.
ALTER TABLE chat_runs DROP CONSTRAINT IF EXISTS chat_runs_status_check;
ALTER TABLE chat_runs ADD CONSTRAINT chat_runs_status_check
    CHECK (status IN ('running', 'requires-action', 'complete', 'error', 'cancelled', 'incomplete'));

CREATE INDEX IF NOT EXISTS users_status_idx ON users(status, created_at DESC);
CREATE INDEX IF NOT EXISTS organizations_status_idx ON organizations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);
