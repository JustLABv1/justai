-- Scheduled assistant work. Individual MCP connections remain opt-in per
-- automation, and write-capable runs are recorded for review.
CREATE TABLE IF NOT EXISTS automations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assistant_id UUID REFERENCES saved_assistants(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
    prompt TEXT NOT NULL CHECK (char_length(trim(prompt)) BETWEEN 1 AND 30000),
    schedule TEXT NOT NULL DEFAULT 'Every Monday at 09:00' CHECK (char_length(trim(schedule)) BETWEEN 1 AND 160),
    timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (char_length(trim(timezone)) BETWEEN 1 AND 80),
    mcp_server_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    approval_mode TEXT NOT NULL DEFAULT 'review' CHECK (approval_mode IN ('review', 'read_only_auto')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automations_scope_idx ON automations(organization_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS automation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'needs_review', 'completed', 'failed')),
    summary TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS automation_runs_recent_idx ON automation_runs(automation_id, started_at DESC);
