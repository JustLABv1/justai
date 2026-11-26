-- When a workflow's runs notify their owner: waiting for approval, failed, completed.
ALTER TABLE agent_workflows
    ADD COLUMN notify_on jsonb NOT NULL DEFAULT '{"approval": true, "failed": true, "completed": false}'::jsonb;

-- The run status last announced; earlier runs count as announced.
ALTER TABLE agent_runs ADD COLUMN notified_status text;
UPDATE agent_runs SET notified_status = status WHERE status IN ('completed', 'failed', 'waiting_approval');
CREATE INDEX agent_runs_unnotified_idx ON agent_runs (updated_at)
    WHERE status IN ('completed', 'failed', 'waiting_approval');
