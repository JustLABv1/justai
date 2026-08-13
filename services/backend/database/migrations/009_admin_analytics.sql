CREATE TABLE IF NOT EXISTS organization_mcp_defaults (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, server_id)
);

CREATE INDEX IF NOT EXISTS organization_mcp_defaults_server_idx
    ON organization_mcp_defaults(server_id);

-- An organization may choose a global endpoint without changing the global
-- endpoint's own is_default flag. Endpoint is_default remains the scoped
-- endpoint default used by the endpoint manager; this table is the explicit
-- organization-admin override used when creating new conversations.
CREATE TABLE IF NOT EXISTS organization_default_endpoints (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    endpoint_id UUID REFERENCES endpoint_settings(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS organization_default_endpoints_endpoint_idx
    ON organization_default_endpoints(endpoint_id);

CREATE TABLE IF NOT EXISTS chat_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_request_id TEXT NOT NULL,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    endpoint_id UUID REFERENCES endpoint_settings(id) ON DELETE SET NULL,
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'error', 'cancelled', 'incomplete')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    first_token_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    input_tokens BIGINT,
    output_tokens BIGINT,
    total_tokens BIGINT,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    UNIQUE (conversation_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS chat_runs_organization_started_idx
    ON chat_runs(organization_id, started_at DESC);

CREATE INDEX IF NOT EXISTS chat_runs_endpoint_model_idx
    ON chat_runs(endpoint_id, model, started_at DESC);

CREATE OR REPLACE FUNCTION justai_apply_conversation_endpoint_default()
RETURNS trigger AS $$
BEGIN
    IF NEW.endpoint_id IS NULL THEN
        SELECT ode.endpoint_id INTO NEW.endpoint_id
        FROM organization_default_endpoints ode
        JOIN endpoint_settings selected ON selected.id = ode.endpoint_id
        WHERE ode.organization_id = NEW.organization_id
          AND selected.enabled = TRUE
          AND (selected.capabilities->>'chat') = 'true';
    END IF;
    IF NEW.endpoint_id IS NULL THEN
        SELECT e.id INTO NEW.endpoint_id
        FROM endpoint_settings e
        WHERE e.enabled = TRUE
          AND (e.capabilities->>'chat') = 'true'
          AND e.is_default = TRUE
          AND ((e.scope_type = 'organization' AND e.scope_id = NEW.organization_id) OR e.scope_type = 'global')
        ORDER BY CASE WHEN e.scope_type = 'organization' THEN 0 ELSE 1 END
        LIMIT 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversations_apply_endpoint_default ON conversations;
CREATE TRIGGER conversations_apply_endpoint_default
    BEFORE INSERT ON conversations
    FOR EACH ROW EXECUTE FUNCTION justai_apply_conversation_endpoint_default();

CREATE OR REPLACE FUNCTION justai_apply_conversation_mcp_defaults()
RETURNS trigger AS $$
BEGIN
    INSERT INTO conversation_mcp_servers (conversation_id, server_id)
    SELECT NEW.id, d.server_id
    FROM organization_mcp_defaults d
    JOIN mcp_servers s ON s.id = d.server_id
    WHERE d.organization_id = NEW.organization_id AND s.enabled = TRUE
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversations_apply_mcp_defaults ON conversations;
CREATE TRIGGER conversations_apply_mcp_defaults
    AFTER INSERT ON conversations
    FOR EACH ROW EXECUTE FUNCTION justai_apply_conversation_mcp_defaults();
