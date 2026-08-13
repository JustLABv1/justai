-- A separate marker lets an empty tools/list result be cached just like a
-- non-empty result. The rows table alone cannot represent a successful zero
-- tool discovery without inventing a sentinel tool.
ALTER TABLE mcp_servers
    ADD COLUMN IF NOT EXISTS tools_discovered_at TIMESTAMPTZ;
