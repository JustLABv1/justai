-- Persist the most recent provider capability probe so workspace settings can
-- distinguish a configured endpoint from one that is currently healthy.
ALTER TABLE endpoint_settings
    ADD COLUMN IF NOT EXISTS last_tested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_test_ok BOOLEAN,
    ADD COLUMN IF NOT EXISTS last_test_error TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS last_test_results JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS endpoint_settings_health_idx
    ON endpoint_settings(last_tested_at DESC)
    WHERE last_tested_at IS NOT NULL;
