-- Additive only: one small bookkeeping table for owner alerts.
--
-- Numbered 0008 so it cannot collide with another branch's 0007; Wrangler
-- applies whatever has not been applied yet, in file-name order.
--
-- The */15 cron watches RunPod funding and whether the Model API can sell, and
-- emails the owner when something needs attention. One row per alert
-- condition remembers when the owner was last told (last_sent), so each
-- condition sends at most one email per 24 hours. A few rows only remember
-- state, with last_sent left at 0: the last known sales status and since when
-- RunPod reads have been failing. No account or customer data is kept here,
-- and nothing in this table ever moves money or starts a worker.
CREATE TABLE operator_alerts (
  id TEXT PRIMARY KEY,
  last_sent INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at INTEGER NOT NULL
);
