-- Shared workspace resources, lightweight project context, and user-controlled
-- retention policies. Private remains the safe default for existing data.

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'conversations_visibility_check'
    ) THEN
        ALTER TABLE conversations
            ADD CONSTRAINT conversations_visibility_check
            CHECK (visibility IN ('private', 'workspace'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS conversations_visibility_idx
    ON conversations(organization_id, visibility, updated_at DESC);

ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'notes_visibility_check'
    ) THEN
        ALTER TABLE notes
            ADD CONSTRAINT notes_visibility_check
            CHECK (visibility IN ('private', 'workspace'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS notes_visibility_idx
    ON notes(organization_id, visibility, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
    description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 30000),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_projects_scope_idx
    ON workspace_projects(organization_id, visibility, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_projects_owner_name_idx
    ON workspace_projects(user_id, organization_id, lower(name));

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES workspace_projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS conversations_project_idx
    ON conversations(project_id, updated_at DESC)
    WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS privacy_settings (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    archived_conversation_retention_days INTEGER NOT NULL DEFAULT 0 CHECK (archived_conversation_retention_days BETWEEN 0 AND 3650),
    knowledge_retention_days INTEGER NOT NULL DEFAULT 0 CHECK (knowledge_retention_days BETWEEN 0 AND 3650),
    transcription_retention_days INTEGER NOT NULL DEFAULT 0 CHECK (transcription_retention_days BETWEEN 0 AND 3650),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, organization_id)
);
