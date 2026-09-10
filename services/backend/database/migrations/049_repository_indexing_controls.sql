-- Per-connection indexing policy. The importer always applies its safe
-- built-in exclusions; these arrays contain the user's additional patterns.
ALTER TABLE repository_contexts
    ADD COLUMN IF NOT EXISTS include_patterns TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS exclude_patterns TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS max_file_bytes BIGINT NOT NULL DEFAULT 2097152,
    ADD COLUMN IF NOT EXISTS honor_gitignore BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repository_contexts_max_file_bytes_check'
    ) THEN
        ALTER TABLE repository_contexts
            ADD CONSTRAINT repository_contexts_max_file_bytes_check
            CHECK (max_file_bytes BETWEEN 1 AND 26214400);
    END IF;
END $$;
