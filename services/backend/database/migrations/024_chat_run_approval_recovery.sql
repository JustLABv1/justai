-- Migration 010 originally added requires-action after some development
-- databases had already recorded that migration. Reassert the constraint in a
-- new migration so approval-paused runs can always be persisted.
ALTER TABLE chat_runs DROP CONSTRAINT IF EXISTS chat_runs_status_check;
ALTER TABLE chat_runs ADD CONSTRAINT chat_runs_status_check
    CHECK (status IN ('running', 'requires-action', 'complete', 'error', 'cancelled', 'incomplete'));

-- Repair runs that were stranded at running because the old constraint
-- rejected their terminal stream status. The latest stream is authoritative
-- for a request that reached the resumable streaming layer.
WITH latest_stream AS (
    SELECT DISTINCT ON (run_id) run_id, status, finished_at
    FROM chat_streams
    WHERE run_id IS NOT NULL AND status <> 'streaming'
    ORDER BY run_id, created_at DESC
)
UPDATE chat_runs AS run
SET status = stream.status,
    finished_at = COALESCE(run.finished_at, stream.finished_at, now())
FROM latest_stream AS stream
WHERE run.id = stream.run_id
  AND run.status = 'running';
