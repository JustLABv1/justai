-- Preserve existing installations and accounts; new ones start with onboarding.
CREATE TABLE installation_setup (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    step TEXT NOT NULL DEFAULT 'welcome',
    completed_at TIMESTAMPTZ
);
INSERT INTO installation_setup (id, completed_at)
VALUES (TRUE, CASE WHEN EXISTS (SELECT 1 FROM users) THEN now() ELSE NULL END);

ALTER TABLE users ADD COLUMN onboarding_step TEXT NOT NULL DEFAULT 'welcome';
ALTER TABLE users ADD COLUMN onboarding_completed_at TIMESTAMPTZ;
UPDATE users SET onboarding_completed_at = now();
