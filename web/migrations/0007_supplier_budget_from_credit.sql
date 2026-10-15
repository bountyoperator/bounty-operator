-- From this migration a confirmed customer payment funds a share of supplier
-- allowance (SUPPLIER_BUDGET_SHARE, see src/supplier-costs.ts). The rows are
-- appended in the same D1 batch as the customer credit and are never edited:
--   customer_credit: the allowance one api_ledger entry that added or removed
--     paid customer credit gave or took, per provider. A credit is one row with
--     id <ledger id>:<provider>. A removal takes customer-funded allowance from
--     every window that still holds some, ended ones included, one row per
--     window: the first with that same id, the others suffixed :2, :3 and so on.
--     The statements write nothing for an entry that already has rows for the
--     provider, so a replayed Stripe event or resync is a no-op.
--   carry: unspent customer-funded allowance moved from an ended window into
--     the current one. Operator-funded allowance never carries over.
-- A window's customer-funded part is the sum of the rows into it minus the
-- carries out of it. Payments that predate this migration have no rows, so
-- their refunds never reduce an operator-funded allowance.
CREATE TABLE supplier_budget_adjustments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('customer_credit', 'carry')),
  provider TEXT NOT NULL CHECK (provider IN ('runpod', 'infron', 'orcarouter')),
  -- The window whose limit changed. NULL only when no window could receive it.
  window_id TEXT REFERENCES supplier_budget_windows(id),
  from_window_id TEXT REFERENCES supplier_budget_windows(id),
  ledger_id TEXT,
  -- 'topup:<id>' or 'monthly:<invoice>': the payment the credit belongs to.
  source TEXT,
  customer_micro INTEGER,
  share_ppm INTEGER CHECK (share_ppm IS NULL OR (share_ppm >= 0 AND share_ppm <= 1000000)),
  -- What the share asked for, and what the window actually took after the
  -- floor of reserved plus consumed allowance. Removals are negative.
  requested_micro INTEGER NOT NULL,
  amount_micro INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((kind = 'customer_credit' AND ledger_id IS NOT NULL AND source IS NOT NULL AND from_window_id IS NULL
      AND customer_micro IS NOT NULL AND share_ppm IS NOT NULL)
    OR (kind = 'carry' AND ledger_id IS NULL AND source IS NULL AND window_id IS NOT NULL AND from_window_id IS NOT NULL
      AND from_window_id != window_id AND amount_micro > 0)),
  -- A ledger entry's first row per provider always has the same id, so the
  -- primary key also stops a second credit for one entry.
  CHECK (kind = 'carry' OR id = ledger_id || ':' || provider
    OR substr(id, 1, length(ledger_id) + length(provider) + 2) = ledger_id || ':' || provider || ':')
);
CREATE INDEX supplier_budget_adjustment_ledger ON supplier_budget_adjustments(ledger_id, provider) WHERE ledger_id IS NOT NULL;
CREATE INDEX supplier_budget_adjustment_window ON supplier_budget_adjustments(window_id);
CREATE INDEX supplier_budget_adjustment_from ON supplier_budget_adjustments(from_window_id) WHERE from_window_id IS NOT NULL;
CREATE INDEX supplier_budget_adjustment_source ON supplier_budget_adjustments(source, provider) WHERE source IS NOT NULL;
CREATE INDEX supplier_budget_adjustment_created ON supplier_budget_adjustments(created_at);
CREATE TRIGGER supplier_budget_adjust AFTER INSERT ON supplier_budget_adjustments WHEN NEW.amount_micro != 0 BEGIN
  UPDATE supplier_budget_windows SET limit_micro = limit_micro + NEW.amount_micro, updated_at = NEW.created_at WHERE id = NEW.window_id;
  UPDATE supplier_budget_windows SET limit_micro = limit_micro - NEW.amount_micro, updated_at = NEW.created_at WHERE id = NEW.from_window_id;
END;
-- Window limits already include every row. Editing or deleting one would
-- leave the limits and the record of where they came from disagreeing.
CREATE TRIGGER supplier_budget_adjustment_update BEFORE UPDATE ON supplier_budget_adjustments BEGIN
  SELECT RAISE(ABORT, 'supplier_budget_adjustment_immutable');
END;
CREATE TRIGGER supplier_budget_adjustment_delete BEFORE DELETE ON supplier_budget_adjustments BEGIN
  SELECT RAISE(ABORT, 'supplier_budget_adjustment_immutable');
END;
