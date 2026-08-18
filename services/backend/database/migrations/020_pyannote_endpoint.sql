-- Keep existing endpoint types valid while allowing the standalone
-- pyannote diarization service to be configured as an endpoint.
ALTER TABLE endpoint_settings
    DROP CONSTRAINT IF EXISTS endpoint_settings_provider_type_check;

ALTER TABLE endpoint_settings
    ADD CONSTRAINT endpoint_settings_provider_type_check
    CHECK (provider_type IN (
        'mock',
        'openai',
        'openai-compatible',
        'gemini',
        'anthropic',
        'ollama',
        'pyannote'
    ));
