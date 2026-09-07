-- Unified Knowledge catalog. Native tables remain the source of truth for
-- content and provider-specific fields; this table gives the UI and retrieval
-- layer one stable identity and access envelope for every durable item.

CREATE TABLE IF NOT EXISTS knowledge_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('source', 'note', 'memory', 'repository', 'transcript')),
    resource_id UUID NOT NULL,
    title TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
    status TEXT NOT NULL DEFAULT 'ready',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (resource_type, resource_id)
);

ALTER TABLE repository_contexts
    ADD COLUMN IF NOT EXISTS sync_interval_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repository_contexts
    ADD COLUMN IF NOT EXISTS next_sync_at TIMESTAMPTZ;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repository_contexts_sync_interval_check'
    ) THEN
        ALTER TABLE repository_contexts
            ADD CONSTRAINT repository_contexts_sync_interval_check
            CHECK (sync_interval_minutes BETWEEN 0 AND 10080);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS knowledge_items_scope_idx
    ON knowledge_items(organization_id, visibility, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_items_type_idx
    ON knowledge_items(organization_id, resource_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_space_items (
    space_id UUID NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (space_id, item_id)
);

CREATE INDEX IF NOT EXISTS knowledge_space_items_item_idx
    ON knowledge_space_items(item_id, created_at DESC);

-- Keep the visibility invariant at the database boundary as well as in the
-- HTTP handler: a workspace-visible space must never expose a private item.
CREATE OR REPLACE FUNCTION enforce_knowledge_space_visibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_space_visibility TEXT;
    target_item_visibility TEXT;
BEGIN
    SELECT visibility INTO target_space_visibility
    FROM workspace_projects WHERE id = NEW.space_id;
    SELECT visibility INTO target_item_visibility
    FROM knowledge_items WHERE id = NEW.item_id;
    IF target_space_visibility = 'workspace' AND target_item_visibility = 'private' THEN
        RAISE EXCEPTION 'private knowledge items cannot be assigned to workspace spaces'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_space_items_visibility_guard ON knowledge_space_items;
CREATE TRIGGER knowledge_space_items_visibility_guard
    BEFORE INSERT OR UPDATE ON knowledge_space_items
    FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_space_visibility();

-- Keep the invariant true when either side of an existing membership changes.
-- The HTTP handlers perform the same checks for friendly errors, while these
-- triggers protect background jobs and direct SQL writes.
CREATE OR REPLACE FUNCTION enforce_knowledge_item_visibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.visibility = 'private' AND EXISTS (
        SELECT 1
        FROM knowledge_space_items ksi
        JOIN workspace_projects p ON p.id = ksi.space_id
        WHERE ksi.item_id = NEW.id AND p.visibility = 'workspace'
    ) THEN
        RAISE EXCEPTION 'private knowledge items cannot remain in workspace spaces'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_items_visibility_guard ON knowledge_items;
CREATE TRIGGER knowledge_items_visibility_guard
    BEFORE UPDATE OF visibility ON knowledge_items
    FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_item_visibility();

CREATE OR REPLACE FUNCTION enforce_knowledge_space_visibility_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.visibility = 'workspace' AND EXISTS (
        SELECT 1
        FROM knowledge_space_items ksi
        JOIN knowledge_items ki ON ki.id = ksi.item_id
        WHERE ksi.space_id = NEW.id AND ki.visibility = 'private'
    ) THEN
        RAISE EXCEPTION 'workspace spaces cannot contain private knowledge items'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_projects_visibility_guard ON workspace_projects;
CREATE TRIGGER workspace_projects_visibility_guard
    BEFORE UPDATE OF visibility ON workspace_projects
    FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_space_visibility_update();

CREATE OR REPLACE FUNCTION enforce_note_visibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.visibility = 'private' AND EXISTS (
        SELECT 1
        FROM knowledge_items ki
        JOIN knowledge_space_items ksi ON ksi.item_id = ki.id
        JOIN workspace_projects p ON p.id = ksi.space_id
        WHERE ki.resource_type = 'note'
          AND ki.resource_id = NEW.id
          AND p.visibility = 'workspace'
    ) THEN
        RAISE EXCEPTION 'private notes cannot remain in workspace spaces'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_visibility_guard ON notes;
CREATE TRIGGER notes_visibility_guard
    BEFORE UPDATE OF visibility ON notes
    FOR EACH ROW EXECUTE FUNCTION enforce_note_visibility();

-- One immutable grounding record per model run makes automatic routing
-- auditable without persisting the private passage text itself.
CREATE TABLE IF NOT EXISTS chat_context_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL UNIQUE REFERENCES chat_runs(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_message_id TEXT,
    selected_space_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
    selected_item_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
    selected_chunks JSONB NOT NULL DEFAULT '[]'::jsonb,
    overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
    routing_version TEXT NOT NULL DEFAULT 'catalog-v1',
    retrieval_status TEXT NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_context_snapshots_conversation_idx
    ON chat_context_snapshots(conversation_id, created_at DESC);

-- Existing durable resources are catalogued idempotently. Conversation
-- attachments are mapped into a project space when the conversation already
-- belongs to one; otherwise the item remains in the user's Personal view.
INSERT INTO knowledge_items (organization_id, owner_id, resource_type, resource_id, title, visibility, status, metadata, created_at, updated_at)
SELECT CASE WHEN ks.scope_type = 'organization' THEN ks.scope_id ELSE member.organization_id END,
       COALESCE(created_by, CASE WHEN ks.scope_type = 'user' THEN ks.scope_id END), 'source', id, title,
       CASE WHEN scope_type = 'organization' THEN 'workspace' ELSE 'private' END,
       status, jsonb_build_object('sourceType', source_type, 'sourceUrl', COALESCE(source_url, '')),
       created_at, updated_at
FROM knowledge_sources ks
LEFT JOIN LATERAL (
    SELECT om.organization_id
    FROM organization_members om
    WHERE om.user_id = ks.scope_id
    ORDER BY om.created_at
    LIMIT 1
) member ON TRUE
WHERE ks.scope_type = 'organization' OR member.organization_id IS NOT NULL
ON CONFLICT (resource_type, resource_id) DO UPDATE SET
	organization_id = EXCLUDED.organization_id,
	owner_id = EXCLUDED.owner_id,
    title = EXCLUDED.title,
	visibility = EXCLUDED.visibility,
    status = EXCLUDED.status,
	metadata = EXCLUDED.metadata,
    updated_at = EXCLUDED.updated_at;

INSERT INTO knowledge_items (organization_id, owner_id, resource_type, resource_id, title, visibility, status, metadata, created_at, updated_at)
SELECT organization_id, user_id, 'note', id, title, visibility, 'ready', '{}'::jsonb, created_at, updated_at
FROM notes
ON CONFLICT (resource_type, resource_id) DO UPDATE SET
	organization_id = EXCLUDED.organization_id,
	owner_id = EXCLUDED.owner_id,
    title = EXCLUDED.title,
    visibility = EXCLUDED.visibility,
    updated_at = EXCLUDED.updated_at;

INSERT INTO knowledge_items (organization_id, owner_id, resource_type, resource_id, title, visibility, status, metadata, created_at, updated_at)
SELECT organization_id, user_id, 'memory', id, left(content, 160), 'private',
       CASE WHEN enabled THEN 'ready' ELSE 'disabled' END,
       jsonb_build_object('source', source, 'enabled', enabled), created_at, updated_at
FROM memories
ON CONFLICT (resource_type, resource_id) DO UPDATE SET
	organization_id = EXCLUDED.organization_id,
	owner_id = EXCLUDED.owner_id,
    title = EXCLUDED.title,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = EXCLUDED.updated_at;

INSERT INTO knowledge_items (organization_id, owner_id, resource_type, resource_id, title, visibility, status, metadata, created_at, updated_at)
SELECT CASE WHEN rc.scope_type = 'organization' THEN rc.scope_id ELSE member.organization_id END,
       COALESCE(created_by, CASE WHEN rc.scope_type = 'user' THEN rc.scope_id END), 'repository', id, title,
       CASE WHEN scope_type = 'organization' THEN 'workspace' ELSE 'private' END,
       CASE
           WHEN rc.status = 'failed' THEN 'failed'
           WHEN EXISTS (
               SELECT 1 FROM repository_context_files rcf
               JOIN knowledge_sources rks ON rks.id = rcf.source_id
               WHERE rcf.context_id = rc.id AND rks.status = 'failed'
           ) THEN 'failed'
           WHEN rc.file_count > 0 AND NOT EXISTS (
               SELECT 1 FROM repository_context_files rcf
               JOIN knowledge_sources rks ON rks.id = rcf.source_id
               WHERE rcf.context_id = rc.id AND rks.status <> 'ready'
           ) THEN 'ready'
           ELSE rc.status
       END,
       jsonb_build_object('provider', provider, 'repositoryUrl', repository_url, 'ref', ref, 'fileCount', file_count, 'skippedFileCount', skipped_file_count, 'totalBytes', total_bytes, 'syncIntervalMinutes', sync_interval_minutes, 'nextSyncAt', next_sync_at),
       created_at, updated_at
FROM repository_contexts rc
LEFT JOIN LATERAL (
    SELECT om.organization_id
    FROM organization_members om
    WHERE om.user_id = rc.scope_id
    ORDER BY om.created_at
    LIMIT 1
) member ON TRUE
WHERE rc.scope_type = 'organization' OR member.organization_id IS NOT NULL
ON CONFLICT (resource_type, resource_id) DO UPDATE SET
	organization_id = EXCLUDED.organization_id,
	owner_id = EXCLUDED.owner_id,
    title = EXCLUDED.title,
	visibility = EXCLUDED.visibility,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = EXCLUDED.updated_at;

INSERT INTO knowledge_items (organization_id, owner_id, resource_type, resource_id, title, visibility, status, metadata, created_at, updated_at)
SELECT organization_id, user_id, 'transcript', id, title,
       'private', status, jsonb_build_object('kind', 'transcription'), created_at, updated_at
FROM transcription_sessions
ON CONFLICT (resource_type, resource_id) DO UPDATE SET
	organization_id = EXCLUDED.organization_id,
	owner_id = EXCLUDED.owner_id,
    title = EXCLUDED.title,
    status = EXCLUDED.status,
    updated_at = EXCLUDED.updated_at;

-- Re-running catalog synchronization after a native record is deleted removes
-- its stable identity and any space memberships instead of leaving a ghost
-- item in the Knowledge library.
DELETE FROM knowledge_items ki
WHERE ki.resource_type = 'source'
  AND NOT EXISTS (SELECT 1 FROM knowledge_sources r WHERE r.id = ki.resource_id);
DELETE FROM knowledge_items ki
WHERE ki.resource_type = 'note'
  AND NOT EXISTS (SELECT 1 FROM notes r WHERE r.id = ki.resource_id);
DELETE FROM knowledge_items ki
WHERE ki.resource_type = 'memory'
  AND NOT EXISTS (SELECT 1 FROM memories r WHERE r.id = ki.resource_id);
DELETE FROM knowledge_items ki
WHERE ki.resource_type = 'repository'
  AND NOT EXISTS (SELECT 1 FROM repository_contexts r WHERE r.id = ki.resource_id);
DELETE FROM knowledge_items ki
WHERE ki.resource_type = 'transcript'
  AND NOT EXISTS (SELECT 1 FROM transcription_sessions r WHERE r.id = ki.resource_id);

-- Preserve project intent from the old conversation context mappings.
INSERT INTO knowledge_space_items (space_id, item_id, added_by)
SELECT c.project_id, ki.id, COALESCE(cks.added_by, c.user_id)
FROM conversation_knowledge_sources cks
JOIN conversations c ON c.id = cks.conversation_id AND c.project_id IS NOT NULL
JOIN workspace_projects p ON p.id = c.project_id
JOIN knowledge_items ki ON ki.resource_type = 'source' AND ki.resource_id = cks.source_id
WHERE cks.context_scope <> 'message'
  AND (p.visibility <> 'workspace' OR ki.visibility <> 'private')
ON CONFLICT DO NOTHING;

INSERT INTO knowledge_space_items (space_id, item_id, added_by)
SELECT c.project_id, ki.id, COALESCE(cn.added_by, c.user_id)
FROM conversation_notes cn
JOIN conversations c ON c.id = cn.conversation_id AND c.project_id IS NOT NULL
JOIN workspace_projects p ON p.id = c.project_id
JOIN knowledge_items ki ON ki.resource_type = 'note' AND ki.resource_id = cn.note_id
WHERE p.visibility <> 'workspace' OR ki.visibility <> 'private'
ON CONFLICT DO NOTHING;

INSERT INTO knowledge_space_items (space_id, item_id, added_by)
SELECT c.project_id, ki.id, COALESCE(crc.added_by, c.user_id)
FROM conversation_repository_contexts crc
JOIN conversations c ON c.id = crc.conversation_id AND c.project_id IS NOT NULL
JOIN workspace_projects p ON p.id = c.project_id
JOIN knowledge_items ki ON ki.resource_type = 'repository' AND ki.resource_id = crc.context_id
WHERE crc.context_scope <> 'message'
  AND (p.visibility <> 'workspace' OR ki.visibility <> 'private')
ON CONFLICT DO NOTHING;

INSERT INTO knowledge_space_items (space_id, item_id, added_by)
SELECT c.project_id, ki.id, c.user_id
FROM conversation_transcription_sessions cts
JOIN conversations c ON c.id = cts.conversation_id AND c.project_id IS NOT NULL
JOIN workspace_projects p ON p.id = c.project_id
JOIN knowledge_items ki ON ki.resource_type = 'transcript' AND ki.resource_id = cts.session_id
WHERE p.visibility <> 'workspace' OR ki.visibility <> 'private'
ON CONFLICT DO NOTHING;
