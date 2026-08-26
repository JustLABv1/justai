-- First-class PDF files created by the assistant. The bytes remain in the
-- database so download URLs can enforce the same user + organization scope as
-- generated images without exposing an unscoped object-storage key.
CREATE TABLE IF NOT EXISTS generated_pdfs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
    filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 120 AND right(lower(filename), 4) = '.pdf'),
    mime_type TEXT NOT NULL DEFAULT 'application/pdf' CHECK (mime_type = 'application/pdf'),
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    pdf_data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS generated_pdfs_scope_idx
    ON generated_pdfs(user_id, organization_id, created_at DESC);
