-- Repository indexes are user-owned library entries. Conversations keep an
-- attachment to the entry, but deleting or switching a conversation must not
-- delete the indexed files.

ALTER TABLE repository_contexts
    DROP CONSTRAINT IF EXISTS repository_contexts_conversation_id_fkey;

ALTER TABLE repository_contexts
    ALTER COLUMN conversation_id DROP NOT NULL;

ALTER TABLE repository_contexts
    ADD CONSTRAINT repository_contexts_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

ALTER TABLE repository_contexts
    DROP CONSTRAINT IF EXISTS repository_contexts_conversation_id_provider_repository_url_ref_key;

-- Repository sources were originally stored with the conversation that first
-- attached them. Clear that legacy ownership before the conversation can be
-- deleted; the conversation_repository_contexts mapping is the source of
-- truth from this migration onward.
ALTER TABLE knowledge_sources
    DROP CONSTRAINT IF EXISTS knowledge_sources_conversation_id_fkey;

ALTER TABLE knowledge_sources
    ADD CONSTRAINT knowledge_sources_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

UPDATE knowledge_sources
SET conversation_id = NULL
WHERE source_type = 'repository' AND conversation_id IS NOT NULL;

-- A user may have added the same repository to more than one conversation
-- before repository indexes became persistent. Keep the most complete copy,
-- move its conversation attachments to that copy, and remove the duplicate
-- indexed files before adding the library uniqueness constraint.
DO $$
DECLARE
    duplicate RECORD;
BEGIN
    FOR duplicate IN
        SELECT id, canonical_id
        FROM (
            SELECT rc.id,
                   FIRST_VALUE(rc.id) OVER (
                       PARTITION BY rc.scope_type, rc.scope_id, rc.provider,
                                    rc.repository_url, rc.ref
                       ORDER BY rc.file_count DESC,
                                (rc.status = 'ready') DESC,
                                rc.created_at,
                                rc.id
                   ) AS canonical_id,
                   ROW_NUMBER() OVER (
                       PARTITION BY rc.scope_type, rc.scope_id, rc.provider,
                                    rc.repository_url, rc.ref
                       ORDER BY rc.file_count DESC,
                                (rc.status = 'ready') DESC,
                                rc.created_at,
                                rc.id
                   ) AS duplicate_rank
            FROM repository_contexts rc
        ) ranked
        WHERE duplicate_rank > 1
    LOOP
        INSERT INTO conversation_repository_contexts
            (conversation_id, context_id, added_by, context_scope)
        SELECT crc.conversation_id, duplicate.canonical_id, crc.added_by,
               crc.context_scope
        FROM conversation_repository_contexts crc
        WHERE crc.context_id = duplicate.id
        ON CONFLICT (conversation_id, context_id) DO UPDATE
        SET context_scope = CASE
                WHEN conversation_repository_contexts.context_scope = 'persistent'
                  OR EXCLUDED.context_scope = 'persistent'
                THEN 'persistent'
                ELSE 'message'
            END;

        DELETE FROM knowledge_sources
        WHERE id IN (
            SELECT source_id
            FROM repository_context_files
            WHERE context_id = duplicate.id
        );

        DELETE FROM repository_contexts
        WHERE id = duplicate.id;
    END LOOP;
END $$;

UPDATE repository_contexts
SET conversation_id = NULL
WHERE conversation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS repository_contexts_library_unique_idx
    ON repository_contexts(scope_type, scope_id, provider, repository_url, ref);

-- Existing attachments need the normal RAG mapping as well as the repository
-- attachment mapping. This makes already-indexed repositories searchable in
-- every conversation that already has them attached.
INSERT INTO conversation_knowledge_sources
    (conversation_id, source_id, added_by, context_scope)
SELECT crc.conversation_id, rcf.source_id, crc.added_by, 'persistent'
FROM conversation_repository_contexts crc
JOIN repository_context_files rcf ON rcf.context_id = crc.context_id
ON CONFLICT (conversation_id, source_id) DO UPDATE
SET context_scope = 'persistent';
