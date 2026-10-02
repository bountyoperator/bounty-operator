PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  recovery_hash TEXT NOT NULL UNIQUE,
  stripe_customer TEXT UNIQUE
);
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL
);
CREATE INDEX passkeys_account ON passkeys(account_id);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_expires ON sessions(expires);
CREATE TABLE challenges (
  token_hash TEXT PRIMARY KEY,
  flow TEXT NOT NULL,
  account_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX challenges_expires ON challenges(expires);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  paid_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_account ON subscriptions(account_id, status, paid_until);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reviews_account_day ON reviews(account_id, day, status);
CREATE INDEX reviews_account_running ON reviews(account_id, status, lease_until);
CREATE TABLE stripe_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE rate_limits (id TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX rate_limits_expires ON rate_limits(expires);
