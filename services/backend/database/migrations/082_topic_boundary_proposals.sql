-- When live detection misses an agenda change, an AI model proposes where the next item
-- began. The proposal sits on the topic it would end; the user can accept or reject it,
-- otherwise it is applied after a deadline.
ALTER TABLE transcription_topics DROP CONSTRAINT transcription_topics_detected_by_check;
ALTER TABLE transcription_topics ADD CONSTRAINT transcription_topics_detected_by_check
    CHECK (detected_by IN ('', 'announcement', 'manual', 'sitting_closed', 'stream_ended', 'missed', 'ai'));

ALTER TABLE transcription_topics
    ADD COLUMN boundary_status text NOT NULL DEFAULT 'none' CHECK (boundary_status IN ('none', 'pending', 'rejected', 'accepted')),
    ADD COLUMN boundary_topic_id uuid REFERENCES transcription_topics(id) ON DELETE SET NULL,
    ADD COLUMN boundary_offset_ms bigint,
    ADD COLUMN boundary_quote text NOT NULL DEFAULT '',
    ADD COLUMN boundary_reason text NOT NULL DEFAULT '',
    ADD COLUMN boundary_deadline timestamptz,
    ADD COLUMN boundary_checked_at timestamptz,
    ADD COLUMN boundary_checked_until_ms bigint;

CREATE INDEX transcription_topics_boundary_pending_idx ON transcription_topics (boundary_deadline) WHERE boundary_status = 'pending';
