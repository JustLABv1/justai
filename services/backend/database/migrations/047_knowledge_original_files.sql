CREATE TABLE knowledge_source_files (
    source_id UUID PRIMARY KEY REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    content BYTEA NOT NULL CHECK (octet_length(content) <= 26214400)
);
