-- Agenda items ("topics") of a live session, such as the items of a Bundestag
-- sitting. They are planned from a published schedule, opened and closed from the
-- chair's announcements as the transcript arrives, and can be read, exported and
-- summarised as soon as they are finished, without waiting for the session to end.
CREATE TABLE IF NOT EXISTS transcription_topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    source_id UUID REFERENCES transcription_sources(id) ON DELETE SET NULL,
    topic_key TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    numbers INTEGER[] NOT NULL DEFAULT '{}',
    title TEXT NOT NULL,
    planned_start_at TIMESTAMPTZ,
    planned_end_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'done')),
    started_offset_ms BIGINT,
    ended_offset_ms BIGINT,
    detected_by TEXT NOT NULL DEFAULT '' CHECK (detected_by IN ('', 'announcement', 'manual', 'sitting_closed', 'stream_ended')),
    starred BOOLEAN NOT NULL DEFAULT FALSE,
    summary TEXT NOT NULL DEFAULT '',
    summary_status TEXT NOT NULL DEFAULT 'none' CHECK (summary_status IN ('none', 'processing', 'completed', 'failed')),
    summary_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, topic_key)
);

CREATE INDEX IF NOT EXISTS transcription_topics_session_idx
    ON transcription_topics(session_id, sort_order);
