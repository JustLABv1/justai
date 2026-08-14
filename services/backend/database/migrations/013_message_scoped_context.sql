-- Files uploaded from the chat composer are useful for the turn they were
-- attached to, but should not silently become context for every later turn.
-- Existing context rows remain persistent for backwards compatibility.
ALTER TABLE conversation_knowledge_sources
    ADD COLUMN IF NOT EXISTS context_scope TEXT NOT NULL DEFAULT 'persistent';

ALTER TABLE conversation_knowledge_sources
    DROP CONSTRAINT IF EXISTS conversation_knowledge_sources_context_scope_check;

ALTER TABLE conversation_knowledge_sources
    ADD CONSTRAINT conversation_knowledge_sources_context_scope_check
    CHECK (context_scope IN ('persistent', 'message'));

CREATE INDEX IF NOT EXISTS conversation_knowledge_sources_scope_idx
    ON conversation_knowledge_sources(conversation_id, context_scope);
