-- Uploaded endpoint branding is stored inside JustAI, like MCP server icons, so
-- model pickers never depend on an externally hosted image.
CREATE TABLE IF NOT EXISTS endpoint_logos (
    endpoint_id UUID PRIMARY KEY REFERENCES endpoint_settings(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL,
    image_data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
