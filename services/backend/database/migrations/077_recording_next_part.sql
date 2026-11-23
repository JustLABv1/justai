-- 002_transcription.sql gained next_part after it had already been applied on
-- existing installs, so those databases never received the column. Add it here
-- and seed the cursor from the parts already committed for each recording.
ALTER TABLE transcription_recordings ADD COLUMN IF NOT EXISTS next_part INTEGER NOT NULL DEFAULT 0;

UPDATE transcription_recordings r
SET next_part = p.next_part
FROM (
    SELECT recording_id, MAX(part) + 1 AS next_part
    FROM transcription_recording_parts
    GROUP BY recording_id
) p
WHERE p.recording_id = r.id AND r.next_part < p.next_part;
