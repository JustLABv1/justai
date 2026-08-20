-- Reusable assistant configurations. Conversations pin a version so editing an
-- assistant never changes the behavior of an existing thread.

CREATE TABLE IF NOT EXISTS saved_assistants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
    icon TEXT NOT NULL DEFAULT 'sparkles' CHECK (char_length(trim(icon)) BETWEEN 1 AND 40),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
    current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_assistants_scope_idx
    ON saved_assistants(organization_id, visibility, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS saved_assistants_owner_name_idx
    ON saved_assistants(user_id, organization_id, lower(name))
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS saved_assistant_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assistant_id UUID NOT NULL REFERENCES saved_assistants(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    instructions TEXT NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 30000),
    endpoint_id UUID REFERENCES endpoint_settings(id) ON DELETE SET NULL,
    model TEXT NOT NULL DEFAULT '' CHECK (char_length(model) <= 200),
    use_memory BOOLEAN NOT NULL DEFAULT TRUE,
    deep_context BOOLEAN NOT NULL DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (assistant_id, version)
);

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS assistant_id UUID REFERENCES saved_assistants(id) ON DELETE SET NULL;
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS assistant_version_id UUID REFERENCES saved_assistant_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_assistant_idx
    ON conversations(assistant_id, assistant_version_id);
