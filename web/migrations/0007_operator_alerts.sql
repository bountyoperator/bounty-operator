-- Additive only: one small bookkeeping table for owner alerts.
--
-- The */15 cron watches the RunPod balance and whether model inference is
-- selling, and emails the owner when something needs attention. One row per
-- alert condition remembers when the owner was last told, so a standing
-- problem is reported at most once a day, and a condition that clears can
-- warn again the next time it returns. No account or customer data is kept
-- here, and nothing in this table ever moves money or starts a worker.
CREATE TABLE operator_alerts (
  id TEXT PRIMARY KEY,
  last_sent INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at INTEGER NOT NULL
);
