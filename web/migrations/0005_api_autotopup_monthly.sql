-- Existing weekly subscriptions keep their price and interval. Only new
-- checkouts use the configured monthly price; no Stripe resource is migrated.
ALTER TABLE subscriptions ADD COLUMN price_id TEXT;
ALTER TABLE subscriptions ADD COLUMN billing_interval TEXT CHECK (billing_interval IN ('week', 'month'));
ALTER TABLE subscriptions ADD COLUMN period_end INTEGER;
ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1));

-- Off until a customer explicitly consents and Stripe confirms setup. The
-- revision invalidates an older setup completion after disable/reconfigure.
CREATE TABLE api_autotopup_settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  amount_micro INTEGER NOT NULL DEFAULT 20000000 CHECK (amount_micro IN (20000000, 50000000, 100000000)),
  threshold_micro INTEGER NOT NULL DEFAULT 5000000 CHECK (threshold_micro IN (5000000, 10000000, 20000000) AND threshold_micro < amount_micro),
  monthly_cap_micro INTEGER NOT NULL DEFAULT 100000000 CHECK (monthly_cap_micro IN (20000000, 50000000, 100000000, 200000000, 500000000) AND monthly_cap_micro >= amount_micro),
  payment_method TEXT,
  payment_method_summary TEXT,
  setup_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  consent_at INTEGER,
  consent_version TEXT,
  pause_reason TEXT CHECK (pause_reason IN ('payment_failed', 'authentication_required', 'payment_method_unavailable', 'reconciliation_required')),
  next_check_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX api_autotopup_due ON api_autotopup_settings(enabled, next_check_at);
CREATE TABLE api_autotopup_setups (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL,
  checkout_id TEXT UNIQUE,
  setup_intent TEXT UNIQUE,
  amount_micro INTEGER NOT NULL,
  threshold_micro INTEGER NOT NULL,
  monthly_cap_micro INTEGER NOT NULL,
  consent_at INTEGER NOT NULL,
  consent_version TEXT NOT NULL,
  settings_revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'failed', 'expired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX api_autotopup_setups_account ON api_autotopup_setups(account_id, created_at);

ALTER TABLE api_topups ADD COLUMN source TEXT NOT NULL DEFAULT 'checkout' CHECK (source IN ('checkout', 'automatic'));
ALTER TABLE api_topups ADD COLUMN auto_month TEXT;
ALTER TABLE api_topups ADD COLUMN auto_revision INTEGER;
ALTER TABLE api_topups ADD COLUMN payment_method TEXT;
ALTER TABLE api_topups ADD COLUMN initiated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_topups ADD COLUMN payment_verified_at INTEGER NOT NULL DEFAULT 0;
-- The pending row reserves the cap and is the durable lock across Workers,
-- restarts and unknown Stripe outcomes. Refunds do not replenish the cap.
CREATE UNIQUE INDEX api_autotopup_one_pending ON api_topups(account_id) WHERE source = 'automatic' AND status = 'pending';
CREATE INDEX api_autotopup_month ON api_topups(account_id, auto_month, source, status);

-- An invoice/period is the source of the included monthly credit, independently
-- of the event that delivered it. Reversals post through the same wallet ledger.
CREATE TABLE api_monthly_grants (
  invoice_id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  amount_micro INTEGER NOT NULL DEFAULT 2000000 CHECK (amount_micro = 2000000),
  credited_micro INTEGER NOT NULL DEFAULT 0 CHECK (credited_micro IN (0, 2000000)),
  refunded_micro INTEGER NOT NULL DEFAULT 0 CHECK (refunded_micro >= 0),
  dispute_at INTEGER NOT NULL DEFAULT 0,
  dispute_blocked INTEGER NOT NULL DEFAULT 0 CHECK (dispute_blocked IN (0, 1)),
  dispute_open INTEGER NOT NULL DEFAULT 0 CHECK (dispute_open IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subscription_id, period_start)
);
CREATE INDEX api_monthly_grants_account ON api_monthly_grants(account_id, created_at);
CREATE TABLE api_monthly_grant_charges (
  invoice_id TEXT NOT NULL REFERENCES api_monthly_grants(invoice_id) ON DELETE CASCADE,
  charge_id TEXT NOT NULL,
  PRIMARY KEY(invoice_id, charge_id)
);
CREATE INDEX api_monthly_grant_charge ON api_monthly_grant_charges(charge_id);
CREATE TRIGGER api_monthly_grant_post AFTER UPDATE OF credited_micro ON api_monthly_grants WHEN NEW.credited_micro != OLD.credited_micro BEGIN
  INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at)
    VALUES('monthly:' || NEW.invoice_id || ':' || NEW.revision, NEW.account_id, NEW.credited_micro - OLD.credited_micro,
      CASE WHEN NEW.credited_micro > OLD.credited_micro THEN 'operator_adjustment' ELSE 'payment_adjustment' END,
      'monthly:' || NEW.invoice_id, NEW.updated_at);
END;
-- A reversal must never silently cause an automatic replacement purchase.
CREATE TRIGGER api_payment_reversal_pauses_autotopup AFTER INSERT ON api_ledger WHEN NEW.kind = 'payment_adjustment' AND NEW.amount_micro < 0 BEGIN
  UPDATE api_autotopup_settings SET enabled = 0, pause_reason = 'payment_failed', setup_id = NULL,
    revision = revision + 1, updated_at = NEW.created_at WHERE account_id = NEW.account_id;
END;
CREATE TRIGGER inference_autotopup_due AFTER UPDATE OF status ON inference_requests WHEN NEW.charge_micro > 0 BEGIN
  UPDATE api_autotopup_settings SET next_check_at = MIN(next_check_at, NEW.finished_at)
    WHERE account_id = NEW.account_id AND enabled = 1;
END;
DROP TRIGGER api_account_delete_guard;
CREATE TRIGGER api_account_delete_guard BEFORE DELETE ON accounts BEGIN
  SELECT RAISE(ABORT, 'api_balance_exists') WHERE EXISTS (SELECT 1 FROM api_wallets WHERE account_id = OLD.id AND (balance_micro != 0 OR reserved_micro != 0))
    OR EXISTS (SELECT 1 FROM api_topups WHERE account_id = OLD.id AND (status = 'pending' OR dispute_open = 1))
    OR EXISTS (SELECT 1 FROM api_monthly_grants WHERE account_id = OLD.id AND dispute_open = 1)
    OR EXISTS (SELECT 1 FROM api_autotopup_settings WHERE account_id = OLD.id AND (enabled = 1 OR setup_id IS NOT NULL));
END;
