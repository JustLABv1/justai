CREATE TABLE transcription_live_processing (
 session_id UUID PRIMARY KEY REFERENCES transcription_sessions(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
 stage TEXT NOT NULL DEFAULT 'recording' CHECK (stage IN ('recording','diarization','grammar','completed')),
 diarization_status TEXT NOT NULL DEFAULT 'queued' CHECK (diarization_status IN ('queued','processing','completed','failed','skipped')),
 polish_status TEXT NOT NULL DEFAULT 'queued' CHECK (polish_status IN ('queued','processing','completed','failed','skipped')),
 error_message TEXT NOT NULL DEFAULT '',
 lease_until TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Preserve selected processing for already scheduled captures.
INSERT INTO transcription_live_processing(session_id,diarization_status,polish_status)
SELECT s.id,CASE WHEN s.diarization_endpoint_id IS NULL THEN 'skipped' ELSE 'queued' END,CASE WHEN s.grammar_endpoint_id IS NULL THEN 'skipped' ELSE 'queued' END
FROM transcription_sessions s WHERE s.status='waiting' AND s.started_at IS NULL AND (s.diarization_endpoint_id IS NOT NULL OR s.grammar_endpoint_id IS NOT NULL)
AND NOT EXISTS(SELECT 1 FROM transcription_video_uploads WHERE session_id=s.id);
UPDATE transcription_sessions SET record_audio=true WHERE id IN(SELECT session_id FROM transcription_live_processing WHERE diarization_status='queued');
