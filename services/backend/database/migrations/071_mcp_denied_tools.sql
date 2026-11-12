ALTER TABLE mcp_servers
    ADD COLUMN IF NOT EXISTS denied_tools JSONB NOT NULL DEFAULT '[]'::jsonb;
