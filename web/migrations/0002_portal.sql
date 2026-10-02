CREATE TABLE api_tokens (
  token_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  last_used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX api_tokens_account ON api_tokens(account_id, expires);
ALTER TABLE passkeys ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE passkeys ADD COLUMN label TEXT NOT NULL DEFAULT 'Passkey';
ALTER TABLE reviews ADD COLUMN profile TEXT NOT NULL DEFAULT 'general';
ALTER TABLE reviews ADD COLUMN channel TEXT NOT NULL DEFAULT 'web';
