-- Workspace productivity primitives: memories, conversation organization,
-- notes, and provider-generated images.

CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    content TEXT NOT NULL CHECK (char_length(trim(content)) BETWEEN 1 AND 2000),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'chat', 'import')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memories_scope_idx
    ON memories(user_id, organization_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
    color TEXT NOT NULL DEFAULT 'primary',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_folders_name_idx
    ON conversation_folders(user_id, organization_id, lower(name));

CREATE TABLE IF NOT EXISTS conversation_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 40),
    color TEXT NOT NULL DEFAULT 'secondary',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_tags_name_idx
    ON conversation_tags(user_id, organization_id, lower(name));

CREATE TABLE IF NOT EXISTS conversation_tag_links (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES conversation_tags(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, tag_id)
);

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES conversation_folders(id) ON DELETE SET NULL;
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS conversations_folder_idx
    ON conversations(user_id, organization_id, folder_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_pinned_idx
    ON conversations(user_id, organization_id, pinned_at DESC)
    WHERE pinned_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Untitled note' CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
    content TEXT NOT NULL DEFAULT '',
    source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    pinned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notes_scope_idx
    ON notes(user_id, organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS notes_search_idx
    ON notes USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '')));

ALTER TABLE endpoint_settings
    ADD COLUMN IF NOT EXISTS image_model TEXT;

CREATE TABLE IF NOT EXISTS generated_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    endpoint_id UUID REFERENCES endpoint_settings(id) ON DELETE SET NULL,
    prompt TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('generate', 'edit')),
    mime_type TEXT NOT NULL DEFAULT 'image/png',
    image_data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS generated_images_scope_idx
    ON generated_images(user_id, organization_id, created_at DESC);
