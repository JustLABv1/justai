ALTER TABLE transcription_segments
    ADD COLUMN IF NOT EXISTS edited_text TEXT;

CREATE TABLE IF NOT EXISTS transcription_annotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    segment_id UUID REFERENCES transcription_segments(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('bookmark', 'comment')),
    note TEXT NOT NULL DEFAULT '',
    start_offset_ms BIGINT NOT NULL DEFAULT 0 CHECK (start_offset_ms >= 0),
    end_offset_ms BIGINT NOT NULL DEFAULT 0 CHECK (end_offset_ms >= 0),
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcription_annotations_session_idx
    ON transcription_annotations(session_id, start_offset_ms, created_at DESC);

CREATE TABLE IF NOT EXISTS transcription_insights (
    session_id UUID PRIMARY KEY REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'processing', 'completed', 'failed')),
    summary TEXT NOT NULL DEFAULT '',
    chapters JSONB NOT NULL DEFAULT '[]'::jsonb,
    topics JSONB NOT NULL DEFAULT '[]'::jsonb,
    action_items JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message TEXT,
    generated_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
