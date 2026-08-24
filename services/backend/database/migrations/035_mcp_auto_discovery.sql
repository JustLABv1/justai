-- MCP servers can opt into the bounded, per-turn tool router without being
-- permanently attached to every conversation. Existing servers stay opt-in.
ALTER TABLE mcp_servers
    ADD COLUMN IF NOT EXISTS auto_discover BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS mcp_servers_auto_discover_idx
    ON mcp_servers (scope_type, scope_id)
    WHERE enabled = TRUE AND auto_discover = TRUE;
