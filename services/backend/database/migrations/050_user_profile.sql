-- User avatars are private application data and are served through the
-- authenticated API rather than exposed as public object-storage URLs.
CREATE TABLE IF NOT EXISTS user_avatars (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL,
    image_data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
