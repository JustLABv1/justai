-- First-class agents, remote A2A connections, durable workflow runs, and
-- compatibility mappings for saved assistants and automations.

CREATE TABLE IF NOT EXISTS agent_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'user')),
    scope_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
    protocol TEXT NOT NULL DEFAULT 'a2a' CHECK (protocol IN ('a2a')),
    endpoint_url TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'api_key', 'http', 'oauth2', 'oidc', 'mtls')),
    encrypted_credential BYTEA,
    encrypted_refresh_credential BYTEA,
    encrypted_client_certificate BYTEA,
    encrypted_client_key BYTEA,
    oauth_authorization_url TEXT,
    oauth_token_url TEXT,
    oauth_issuer_url TEXT,
    oauth_client_id TEXT,
    oauth_scopes TEXT,
    agent_card JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    trusted_read_only BOOLEAN NOT NULL DEFAULT FALSE,
    discovered_at TIMESTAMPTZ,
    last_tested_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((scope_type = 'organization' AND scope_id = organization_id) OR scope_type = 'user')
);

CREATE INDEX IF NOT EXISTS agent_connections_scope_idx
    ON agent_connections(organization_id, scope_type, scope_id, updated_at DESC);

ALTER TABLE saved_assistants
    ADD COLUMN IF NOT EXISTS agent_kind TEXT NOT NULL DEFAULT 'native';
ALTER TABLE saved_assistants
    ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES agent_connections(id) ON DELETE SET NULL;
ALTER TABLE saved_assistants
    ADD COLUMN IF NOT EXISTS delegation_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE saved_assistants DROP CONSTRAINT IF EXISTS saved_assistants_agent_kind_check;
ALTER TABLE saved_assistants ADD CONSTRAINT saved_assistants_agent_kind_check
    CHECK (agent_kind IN ('native', 'remote'));

CREATE TABLE IF NOT EXISTS agent_workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
    description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
    definition JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
    schedule JSONB NOT NULL DEFAULT '{"kind":"manual"}'::jsonb,
    timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (char_length(trim(timezone)) BETWEEN 1 AND 80),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    legacy_automation_id UUID REFERENCES automations(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_workflows_scope_idx
    ON agent_workflows(organization_id, visibility, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_workflows_schedule_idx
    ON agent_workflows(enabled, next_run_at)
    WHERE deleted_at IS NULL AND next_run_at IS NOT NULL;
DROP INDEX IF EXISTS agent_workflows_owner_name_idx;
CREATE INDEX IF NOT EXISTS agent_workflows_owner_name_idx
    ON agent_workflows(user_id, organization_id, lower(name))
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workflow_id UUID REFERENCES agent_workflows(id) ON DELETE SET NULL,
    root_agent_id UUID REFERENCES saved_assistants(id) ON DELETE SET NULL,
    parent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'schedule', 'chat', 'delegation')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
    input JSONB NOT NULL DEFAULT '{}'::jsonb,
    definition_snapshot JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
    context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    summary TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    lease_owner TEXT,
    lease_until TIMESTAMPTZ,
    next_wake_at TIMESTAMPTZ,
    scheduled_for TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_scope_idx
    ON agent_runs(organization_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_queue_idx
    ON agent_runs(status, next_wake_at, created_at)
    WHERE status IN ('queued', 'running', 'waiting_approval');
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_schedule_dedupe_idx
    ON agent_runs(workflow_id, scheduled_for)
    WHERE workflow_id IS NOT NULL AND scheduled_for IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_run_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    node_key TEXT NOT NULL,
    agent_id UUID REFERENCES saved_assistants(id) ON DELETE SET NULL,
    agent_version_id UUID REFERENCES saved_assistant_versions(id) ON DELETE SET NULL,
    definition JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'skipped')),
    attempt INTEGER NOT NULL DEFAULT 0,
    input JSONB NOT NULL DEFAULT '{}'::jsonb,
    output JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT NOT NULL DEFAULT '',
    provider_task_id TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, node_key)
);

CREATE INDEX IF NOT EXISTS agent_run_nodes_status_idx
    ON agent_run_nodes(run_id, status, updated_at);

CREATE TABLE IF NOT EXISTS agent_run_events (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    node_id UUID REFERENCES agent_run_nodes(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_run_events_stream_idx
    ON agent_run_events(run_id, id);

CREATE TABLE IF NOT EXISTS agent_run_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    node_id UUID REFERENCES agent_run_nodes(id) ON DELETE SET NULL,
    action_type TEXT NOT NULL,
    action JSONB NOT NULL DEFAULT '{}'::jsonb,
    argument_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    reason TEXT NOT NULL DEFAULT '',
    decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_run_approvals_pending_idx
    ON agent_run_approvals(run_id, status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS agent_run_approvals_one_pending_idx
    ON agent_run_approvals(run_id, node_id)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS agent_run_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    node_id UUID REFERENCES agent_run_nodes(id) ON DELETE SET NULL,
    name TEXT NOT NULL DEFAULT 'artifact',
    kind TEXT NOT NULL DEFAULT 'text',
    mime_type TEXT NOT NULL DEFAULT 'text/plain',
    content BYTEA NOT NULL DEFAULT ''::bytea,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_run_artifacts_run_idx
    ON agent_run_artifacts(run_id, created_at);

ALTER TABLE automations
    ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES agent_workflows(id) ON DELETE SET NULL;
ALTER TABLE automation_runs
    ADD COLUMN IF NOT EXISTS agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL;

-- Existing automations become one-agent workflows. The legacy projection is
-- retained so old clients and URLs continue to work while new scheduling reads
-- the workflow records.
INSERT INTO agent_workflows (
    user_id, organization_id, name, description, visibility, definition,
    schedule, timezone, enabled, legacy_automation_id, created_at, updated_at
)
SELECT
    a.user_id,
    a.organization_id,
    a.name,
    'Migrated from the legacy automation scheduler.',
    'private',
    jsonb_build_object(
        'nodes', jsonb_build_array(jsonb_build_object(
            'id', 'agent-1',
            'type', 'agent',
            'agentId', a.assistant_id,
            'instruction', a.prompt,
            'inputBindings', jsonb_build_array(),
            'context', jsonb_build_object('mcpServerIds', a.mcp_server_ids),
            'delegationAgentIds', jsonb_build_array(),
            'approvalMode', a.approval_mode,
            'retry', jsonb_build_object('maxAttempts', 3),
            'timeoutSeconds', 600
        )),
        'edges', jsonb_build_array()
    ),
    jsonb_build_object('kind', 'legacy', 'display', a.schedule),
    a.timezone,
    a.enabled,
    a.id,
    a.created_at,
    a.updated_at
FROM automations a
WHERE a.workflow_id IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM agent_workflows w WHERE w.legacy_automation_id = a.id
  );

UPDATE automations a
SET workflow_id = w.id
FROM agent_workflows w
WHERE w.legacy_automation_id = a.id
  AND a.workflow_id IS NULL;

ALTER TABLE platform_settings
    ADD COLUMN IF NOT EXISTS agents_enabled BOOLEAN NOT NULL DEFAULT TRUE;
