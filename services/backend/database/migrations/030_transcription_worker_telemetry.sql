ALTER TABLE transcription_jobs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE transcription_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS transcription_jobs_worker_telemetry_idx
    ON transcription_jobs(job_type, status, created_at, started_at, completed_at);
