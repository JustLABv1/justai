-- Immutable workflow snapshots make edits auditable and let users restore a
-- known-good definition without changing the run snapshots already in flight.
CREATE TABLE IF NOT EXISTS agent_workflow_versions (
    id BIGSERIAL PRIMARY KEY,
    workflow_id UUID NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL,
    definition JSONB NOT NULL,
    schedule JSONB NOT NULL,
    timezone TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workflow_id, version)
);

CREATE INDEX IF NOT EXISTS agent_workflow_versions_workflow_idx
    ON agent_workflow_versions(workflow_id, version DESC);

INSERT INTO agent_workflow_versions
    (workflow_id, version, name, description, visibility, definition, schedule, timezone, enabled, created_by, created_at)
SELECT id, 1, name, description, visibility, definition, schedule, timezone, enabled, user_id, created_at
FROM agent_workflows
WHERE deleted_at IS NULL
ON CONFLICT (workflow_id, version) DO NOTHING;

CREATE OR REPLACE FUNCTION justai_capture_agent_workflow_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    next_version INTEGER;
BEGIN
    IF TG_OP = 'INSERT'
       OR NEW.definition IS DISTINCT FROM OLD.definition
       OR NEW.schedule IS DISTINCT FROM OLD.schedule
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.visibility IS DISTINCT FROM OLD.visibility
       OR NEW.timezone IS DISTINCT FROM OLD.timezone
       OR NEW.enabled IS DISTINCT FROM OLD.enabled THEN
        SELECT COALESCE(MAX(version), 0) + 1
          INTO next_version
          FROM agent_workflow_versions
         WHERE workflow_id = NEW.id;
        INSERT INTO agent_workflow_versions
            (workflow_id, version, name, description, visibility, definition, schedule, timezone, enabled, created_by)
        VALUES
            (NEW.id, next_version, NEW.name, NEW.description, NEW.visibility, NEW.definition, NEW.schedule, NEW.timezone, NEW.enabled, NEW.user_id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_workflow_version_capture ON agent_workflows;
CREATE TRIGGER agent_workflow_version_capture
AFTER INSERT OR UPDATE OF name, description, visibility, definition, schedule, timezone, enabled
ON agent_workflows
FOR EACH ROW
EXECUTE FUNCTION justai_capture_agent_workflow_version();
