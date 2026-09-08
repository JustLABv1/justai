-- Turn the existing Knowledge spaces into a hierarchical storage tree. The
-- existing workspace_projects table remains the identity and permission
-- boundary so current projects, chat routing, and item memberships keep
-- working without a data migration.

ALTER TABLE workspace_projects
    ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES workspace_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS workspace_projects_parent_idx
    ON workspace_projects(parent_id, lower(name));

DROP INDEX IF EXISTS workspace_projects_owner_name_idx;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_projects_owner_parent_name_idx
    ON workspace_projects(user_id, organization_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE OR REPLACE FUNCTION enforce_workspace_project_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.parent_id = NEW.id THEN
        RAISE EXCEPTION 'a storage folder cannot contain itself' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM workspace_projects parent
        WHERE parent.id = NEW.parent_id
          AND parent.organization_id = NEW.organization_id
          AND parent.user_id = NEW.user_id
    ) THEN
        RAISE EXCEPTION 'storage folder parent is not available' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
        WITH RECURSIVE descendants AS (
            SELECT id FROM workspace_projects WHERE parent_id = NEW.id
            UNION ALL
            SELECT child.id
            FROM workspace_projects child
            JOIN descendants d ON child.parent_id = d.id
        )
        SELECT 1 FROM descendants WHERE id = NEW.parent_id
    ) THEN
        RAISE EXCEPTION 'storage folder hierarchy cannot contain a cycle' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_projects_parent_guard ON workspace_projects;
CREATE TRIGGER workspace_projects_parent_guard
    BEFORE INSERT OR UPDATE OF parent_id ON workspace_projects
    FOR EACH ROW EXECUTE FUNCTION enforce_workspace_project_parent();
