-- Platform administration hardening: auditable mutations and ownership
-- invariants.  These columns are deliberately additive so older deployments
-- can roll forward without changing the existing audit payload contract.

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'success';
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS audit_events_request_idx ON audit_events(request_id);
CREATE INDEX IF NOT EXISTS audit_events_outcome_idx ON audit_events(outcome, created_at DESC);

-- There must be one and only one owner per workspace.  Keep the earliest
-- owner deterministically when cleaning up legacy duplicate rows.
WITH ranked_owners AS (
    SELECT organization_id,
           user_id,
           ROW_NUMBER() OVER (
               PARTITION BY organization_id
               ORDER BY created_at ASC, user_id ASC
           ) AS owner_rank
    FROM organization_members
    WHERE role = 'owner'
)
UPDATE organization_members AS members
SET role = 'admin'
FROM ranked_owners AS duplicate
WHERE members.organization_id = duplicate.organization_id
  AND members.user_id = duplicate.user_id
  AND duplicate.owner_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS organization_members_one_owner_idx
    ON organization_members(organization_id)
    WHERE role = 'owner';
