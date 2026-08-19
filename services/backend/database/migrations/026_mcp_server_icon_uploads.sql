-- Keep uploaded MCP branding inside JustAI so installations do not depend on
-- an externally hosted image URL.
CREATE TABLE IF NOT EXISTS mcp_server_icons (
    server_id UUID PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL,
    image_data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
