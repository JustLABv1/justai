-- Keep the one-time capture grant recoverable during polling races without
-- storing its plaintext. The ciphertext is encrypted with the application
-- SecretBox and is cleared as soon as the grant is exchanged for a ticket.
ALTER TABLE transcription_join_requests
    ADD COLUMN IF NOT EXISTS grant_token_encrypted BYTEA;
