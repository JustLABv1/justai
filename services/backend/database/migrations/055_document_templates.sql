CREATE TABLE document_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
    instructions TEXT NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 12000),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_data BYTEA NOT NULL CHECK (octet_length(file_data) BETWEEN 1 AND 8388608),
    inspection JSONB NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_templates_scope_idx ON document_templates (organization_id,user_id,updated_at DESC);
ALTER TABLE generated_chat_files DROP CONSTRAINT generated_chat_files_mime_type_check;
ALTER TABLE generated_chat_files ADD CONSTRAINT generated_chat_files_mime_type_check CHECK (mime_type IN (
'application/pdf','text/markdown','text/plain','application/json','text/csv','text/html','application/xml',
'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
'application/vnd.openxmlformats-officedocument.presentationml.presentation',
'application/vnd.openxmlformats-officedocument.presentationml.template',
'application/vnd.oasis.opendocument.text','application/vnd.oasis.opendocument.text-template',
'application/vnd.oasis.opendocument.spreadsheet','application/vnd.oasis.opendocument.spreadsheet-template',
'application/vnd.oasis.opendocument.presentation','application/vnd.oasis.opendocument.presentation-template'
));
