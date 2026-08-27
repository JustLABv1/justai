CREATE TABLE IF NOT EXISTS transcription_video_upload_parts (
    upload_id UUID NOT NULL REFERENCES transcription_video_uploads(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL CHECK (part_number > 0 AND part_number <= 10000),
    etag TEXT NOT NULL CHECK (char_length(etag) > 0 AND char_length(etag) <= 256),
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (upload_id, part_number)
);
