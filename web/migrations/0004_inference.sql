-- Money is integer microdollars (1 USD = 1,000,000). The database owns the
-- reservation and ledger transitions, including concurrent/replayed requests.
CREATE TABLE api_wallets (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  balance_micro INTEGER NOT NULL DEFAULT 0,
  reserved_micro INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0)
);
CREATE TABLE inference_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  budget_micro INTEGER NOT NULL CHECK (budget_micro > 0),
  spent_micro INTEGER NOT NULL DEFAULT 0 CHECK (spent_micro >= 0),
  reserved_micro INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0),
  created_at INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  last_used INTEGER,
  revoked_at INTEGER
);
CREATE INDEX inference_keys_account ON inference_keys(account_id);
CREATE TABLE api_ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  amount_micro INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topup', 'payment_adjustment', 'usage', 'operator_adjustment')),
  reference TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX api_ledger_account ON api_ledger(account_id, created_at DESC);
CREATE TRIGGER api_ledger_post AFTER INSERT ON api_ledger WHEN NEW.account_id IS NOT NULL BEGIN
  INSERT INTO api_wallets(account_id, balance_micro) VALUES(NEW.account_id, NEW.amount_micro)
    ON CONFLICT(account_id) DO UPDATE SET balance_micro = balance_micro + NEW.amount_micro;
END;
CREATE TABLE inference_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL REFERENCES inference_keys(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  idempotency_hash TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  hold_micro INTEGER NOT NULL CHECK (hold_micro > 0),
  input_rate INTEGER NOT NULL CHECK (input_rate >= 0),
  output_rate INTEGER NOT NULL CHECK (output_rate >= 0),
  minimum_micro INTEGER NOT NULL CHECK (minimum_micro >= 0),
  charge_micro INTEGER NOT NULL DEFAULT 0 CHECK (charge_micro >= 0 AND charge_micro <= hold_micro),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  finished_at INTEGER,
  failure_code TEXT,
  UNIQUE(account_id, idempotency_hash)
);
CREATE INDEX inference_requests_account ON inference_requests(account_id, created_at DESC);
CREATE INDEX inference_requests_running ON inference_requests(status, lease_until);
CREATE TRIGGER inference_reserve_check BEFORE INSERT ON inference_requests BEGIN
  SELECT RAISE(ABORT, 'api_insufficient_credit') WHERE NOT EXISTS (SELECT 1 FROM api_wallets WHERE account_id = NEW.account_id AND balance_micro - reserved_micro >= NEW.hold_micro);
  SELECT RAISE(ABORT, 'api_key_budget') WHERE NOT EXISTS (SELECT 1 FROM inference_keys WHERE id = NEW.key_id AND account_id = NEW.account_id
    AND revoked_at IS NULL AND expires > NEW.created_at AND budget_micro - spent_micro - reserved_micro >= NEW.hold_micro);
  SELECT RAISE(ABORT, 'api_concurrency') WHERE (SELECT COUNT(*) FROM inference_requests WHERE account_id = NEW.account_id AND status = 'running') >= 2;
  SELECT RAISE(ABORT, 'api_capacity') WHERE (SELECT COUNT(*) FROM inference_requests WHERE status = 'running') >= 4;
END;
CREATE TRIGGER inference_reserve AFTER INSERT ON inference_requests BEGIN
  UPDATE api_wallets SET reserved_micro = reserved_micro + NEW.hold_micro WHERE account_id = NEW.account_id;
  UPDATE inference_keys SET reserved_micro = reserved_micro + NEW.hold_micro, last_used = NEW.created_at WHERE id = NEW.key_id;
END;
CREATE TRIGGER inference_settlement_check BEFORE UPDATE OF status ON inference_requests BEGIN
  SELECT RAISE(ABORT, 'api_already_settled') WHERE OLD.status != 'running' OR NEW.status = 'running';
END;
CREATE TRIGGER inference_settle AFTER UPDATE OF status ON inference_requests BEGIN
  UPDATE api_wallets SET reserved_micro = reserved_micro - OLD.hold_micro WHERE account_id = OLD.account_id;
  UPDATE inference_keys SET reserved_micro = reserved_micro - OLD.hold_micro, spent_micro = spent_micro + NEW.charge_micro WHERE id = OLD.key_id;
  INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at)
    SELECT 'usage:' || NEW.id, NEW.account_id, -NEW.charge_micro, 'usage', NEW.id, NEW.finished_at WHERE NEW.charge_micro > 0;
END;
CREATE TABLE api_topups (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL,
  checkout_id TEXT UNIQUE,
  payment_intent TEXT UNIQUE,
  amount_micro INTEGER NOT NULL CHECK (amount_micro IN (20000000, 50000000, 100000000)),
  credited_micro INTEGER NOT NULL DEFAULT 0 CHECK (credited_micro >= 0 AND credited_micro <= amount_micro),
  refunded_micro INTEGER NOT NULL DEFAULT 0 CHECK (refunded_micro >= 0),
  dispute_at INTEGER NOT NULL DEFAULT 0,
  dispute_blocked INTEGER NOT NULL DEFAULT 0 CHECK (dispute_blocked IN (0, 1)),
  dispute_open INTEGER NOT NULL DEFAULT 0 CHECK (dispute_open IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX api_topups_account ON api_topups(account_id, created_at DESC);
CREATE TRIGGER api_topup_post AFTER UPDATE OF credited_micro ON api_topups WHEN NEW.credited_micro != OLD.credited_micro BEGIN
  INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at)
    VALUES('topup:' || NEW.id || ':' || NEW.revision, NEW.account_id, NEW.credited_micro - OLD.credited_micro,
      CASE WHEN OLD.credited_micro = 0 AND NEW.credited_micro > 0 AND OLD.status != 'paid' THEN 'topup' ELSE 'payment_adjustment' END, NEW.id, NEW.updated_at);
END;
CREATE TRIGGER api_account_delete_guard BEFORE DELETE ON accounts BEGIN
  SELECT RAISE(ABORT, 'api_balance_exists') WHERE EXISTS (SELECT 1 FROM api_wallets WHERE account_id = OLD.id AND (balance_micro != 0 OR reserved_micro != 0))
    OR EXISTS (SELECT 1 FROM api_topups WHERE account_id = OLD.id AND (status = 'pending' OR dispute_open = 1));
END;
