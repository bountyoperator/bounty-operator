-- Operator-funded supplier allowances are independent of customer credit.
-- No allowance is created by this migration, a payment, or a clock rollover.
-- These limit admitted commitments, not an upstream provider's actual bill.
CREATE TABLE supplier_budget_windows (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('runpod', 'infron', 'orcarouter')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  limit_micro INTEGER NOT NULL DEFAULT 0 CHECK (limit_micro >= 0),
  reserved_micro INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0),
  consumed_micro INTEGER NOT NULL DEFAULT 0 CHECK (consumed_micro >= 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  funding_reference TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX supplier_budget_current ON supplier_budget_windows(provider, starts_at, ends_at);
CREATE INDEX inference_requests_usage_fault ON inference_requests(finished_at, model) WHERE failure_code = 'usage_limit_exceeded';
CREATE TRIGGER supplier_budget_overlap_insert BEFORE INSERT ON supplier_budget_windows WHEN NEW.enabled = 1 BEGIN
  SELECT RAISE(ABORT, 'supplier_budget_overlap') WHERE EXISTS (
    SELECT 1 FROM supplier_budget_windows WHERE provider = NEW.provider AND enabled = 1
      AND starts_at < NEW.ends_at AND ends_at > NEW.starts_at);
END;
CREATE TRIGGER supplier_budget_overlap_update BEFORE UPDATE OF enabled, starts_at, ends_at, provider ON supplier_budget_windows WHEN NEW.enabled = 1 BEGIN
  SELECT RAISE(ABORT, 'supplier_budget_overlap') WHERE EXISTS (
    SELECT 1 FROM supplier_budget_windows WHERE id != NEW.id AND provider = NEW.provider AND enabled = 1
      AND starts_at < NEW.ends_at AND ends_at > NEW.starts_at);
END;

-- No account/content is copied here. Records survive account deletion so
-- supplier accounting cannot disappear with a customer's usage history.
CREATE TABLE supplier_commitments (
  request_id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES supplier_budget_windows(id),
  provider TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  model TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('token_rate', 'runtime_allowance')),
  rate_revision TEXT NOT NULL,
  rate_source TEXT NOT NULL,
  valid_until INTEGER NOT NULL,
  input_micro_per_million INTEGER NOT NULL DEFAULT 0 CHECK (input_micro_per_million >= 0),
  output_micro_per_million INTEGER NOT NULL DEFAULT 0 CHECK (output_micro_per_million >= 0),
  fixed_micro INTEGER NOT NULL DEFAULT 0 CHECK (fixed_micro >= 0),
  hold_micro INTEGER NOT NULL CHECK (hold_micro > 0),
  expense_micro INTEGER NOT NULL DEFAULT 0 CHECK (expense_micro >= 0),
  estimated_cost_micro INTEGER CHECK (estimated_cost_micro IS NULL OR estimated_cost_micro >= 0),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'dispatched', 'consumed', 'released')),
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX supplier_commitment_budget ON supplier_commitments(budget_id, state);
CREATE INDEX supplier_commitment_resource ON supplier_commitments(provider, resource_id, created_at);
CREATE TRIGGER supplier_reserve_check BEFORE INSERT ON supplier_commitments BEGIN
  SELECT RAISE(ABORT, 'supplier_invalid_commitment') WHERE NEW.state != 'reserved' OR NEW.expense_micro != 0
    OR NEW.dispatched_at IS NOT NULL OR NEW.finished_at IS NOT NULL OR NEW.valid_until <= NEW.created_at
    OR NOT EXISTS (SELECT 1 FROM inference_requests WHERE id = NEW.request_id AND model = NEW.model AND status = 'running');
  SELECT RAISE(ABORT, 'supplier_unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM supplier_budget_windows WHERE id = NEW.budget_id AND provider = NEW.provider
      AND enabled = 1 AND starts_at <= NEW.created_at AND ends_at > NEW.created_at AND limit_micro > 0);
  SELECT RAISE(ABORT, 'supplier_budget_exhausted') WHERE NOT EXISTS (
    SELECT 1 FROM supplier_budget_windows WHERE id = NEW.budget_id
      AND limit_micro - reserved_micro - consumed_micro >= NEW.hold_micro);
END;
CREATE TRIGGER supplier_reserve AFTER INSERT ON supplier_commitments BEGIN
  UPDATE supplier_budget_windows SET reserved_micro = reserved_micro + NEW.hold_micro WHERE id = NEW.budget_id;
END;
CREATE TRIGGER supplier_transition_check BEFORE UPDATE OF state ON supplier_commitments BEGIN
  SELECT RAISE(ABORT, 'supplier_invalid_transition') WHERE NOT (
    (OLD.state = 'reserved' AND NEW.state IN ('dispatched', 'released')) OR
    (OLD.state = 'dispatched' AND NEW.state = 'consumed'));
  SELECT RAISE(ABORT, 'supplier_invalid_transition') WHERE
    (NEW.state = 'released' AND (NEW.expense_micro != 0 OR NEW.dispatched_at IS NOT NULL)) OR
    (NEW.state = 'dispatched' AND (NEW.dispatched_at IS NULL OR NEW.expense_micro != 0)) OR
    (NEW.state IN ('consumed', 'released') AND NEW.finished_at IS NULL);
END;
CREATE TRIGGER supplier_settle AFTER UPDATE OF state ON supplier_commitments WHEN NEW.state IN ('consumed', 'released') BEGIN
  UPDATE supplier_budget_windows SET reserved_micro = reserved_micro - OLD.hold_micro,
    consumed_micro = consumed_micro + NEW.expense_micro WHERE id = OLD.budget_id;
END;

-- The vendor revises open buckets, so imports replace a bucket rather than
-- adding its entire cost again. Actual bills never refill spending allowance.
CREATE TABLE supplier_billing_buckets (
  provider TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  bucket_end INTEGER NOT NULL CHECK (bucket_end > bucket_start),
  total_micro INTEGER NOT NULL CHECK (total_micro >= 0),
  gpu_micro INTEGER NOT NULL DEFAULT 0 CHECK (gpu_micro >= 0),
  cpu_micro INTEGER NOT NULL DEFAULT 0 CHECK (cpu_micro >= 0),
  disk_micro INTEGER NOT NULL DEFAULT 0 CHECK (disk_micro >= 0),
  fetched_at INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (provider, resource_type, resource_id, bucket_start, bucket_end)
);
CREATE TABLE supplier_billing_syncs (
  provider TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  PRIMARY KEY (provider, resource_type, resource_id, window_start, window_end)
);
