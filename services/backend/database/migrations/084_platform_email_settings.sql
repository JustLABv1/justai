-- E-mail (SMTP) and the public address for links, set by a platform admin. The server
-- configuration (config.yaml or JUSTAI_SMTP_* / JUSTAI_PUBLIC_URL) takes precedence.
CREATE TABLE platform_email_settings (
    id boolean PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
    enabled boolean NOT NULL DEFAULT false,
    host text NOT NULL DEFAULT '',
    port integer NOT NULL DEFAULT 587 CHECK (port BETWEEN 1 AND 65535),
    username text NOT NULL DEFAULT '',
    password_ciphertext bytea,
    from_address text NOT NULL DEFAULT '',
    security text NOT NULL DEFAULT 'starttls' CHECK (security IN ('starttls', 'tls', 'none')),
    public_url text NOT NULL DEFAULT '',
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_tested_at timestamptz,
    last_error text NOT NULL DEFAULT ''
);
INSERT INTO platform_email_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
