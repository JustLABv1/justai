-- Store the primary setup lane separately from runtime capabilities. Existing
-- capability flags remain the source of truth for routing and dual-purpose
-- endpoints can still expose both chat and diarization.
ALTER TABLE endpoint_settings
    ADD COLUMN IF NOT EXISTS endpoint_kind TEXT;

UPDATE endpoint_settings
SET endpoint_kind = CASE
    WHEN provider_type = 'pyannote'
        OR (capabilities->>'diarization') = 'true'
           AND (capabilities->>'chat') IS DISTINCT FROM 'true'
        THEN 'diarization'
    ELSE 'llm'
END
WHERE endpoint_kind IS NULL;

ALTER TABLE endpoint_settings
    ALTER COLUMN endpoint_kind SET DEFAULT 'llm',
    ALTER COLUMN endpoint_kind SET NOT NULL;

ALTER TABLE endpoint_settings
    DROP CONSTRAINT IF EXISTS endpoint_settings_endpoint_kind_check;

ALTER TABLE endpoint_settings
    ADD CONSTRAINT endpoint_settings_endpoint_kind_check
    CHECK (endpoint_kind IN ('llm', 'diarization'));

CREATE INDEX IF NOT EXISTS endpoint_settings_kind_idx
    ON endpoint_settings(endpoint_kind, enabled);
