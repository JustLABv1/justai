CREATE TABLE transcription_readers (
    session_id uuid NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL,
    PRIMARY KEY (session_id, user_id),
    FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE
);
