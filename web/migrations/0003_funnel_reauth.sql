-- v0.7.0. Additive only: one new table and two new columns.

-- First-party counters: one number per UTC day and event name.
CREATE TABLE funnel_daily (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event)
);

-- When the session last passed a passkey check. Sessions opened before this
-- migration start at 0, so their next credential change asks for the passkey.
ALTER TABLE sessions ADD COLUMN auth_at INTEGER NOT NULL DEFAULT 0;

-- The receipt address Stripe collected at checkout. Empty for free accounts.
ALTER TABLE accounts ADD COLUMN email TEXT;
