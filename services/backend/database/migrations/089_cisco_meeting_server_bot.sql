-- Meeting-bot sources can be labelled as Cisco Meeting Server (services/meeting-bot).
ALTER TABLE transcription_bot_sources
    DROP CONSTRAINT IF EXISTS transcription_bot_sources_platform_check;
ALTER TABLE transcription_bot_sources
    ADD CONSTRAINT transcription_bot_sources_platform_check
    CHECK (platform IN ('generic', 'zoom', 'google-meet', 'microsoft-teams', 'cisco-meeting-server'));
