-- Optional presentation metadata for MCP server branding. The URL is never
-- fetched by the backend; it is rendered as an image by the authenticated UI.
ALTER TABLE mcp_servers
    ADD COLUMN IF NOT EXISTS icon_url TEXT;
