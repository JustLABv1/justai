-- Chat exports other than PDFs use the same scoped, authenticated download
-- model as generated PDFs. Keep bytes in the database so downloads always
-- verify the active user and workspace.
CREATE TABLE IF NOT EXISTS generated_chat_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
    filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 120),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'text/markdown', 'text/plain', 'application/json', 'text/csv', 'text/html')),
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    file_data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS generated_chat_files_scope_idx
    ON generated_chat_files(user_id, organization_id, created_at DESC);
