// Hosted-review allowance: how many reviews an account may run at once and
// how many it may complete per UTC day. Plain JavaScript so node:test can run
// it against an in-memory SQLite database.

/**
 * How long a reservation holds without a sign of life. The provider is cut off
 * after 180 seconds of silence, and a streamed review renews its lease while it
 * is delivering, so a lease only expires when the Worker itself was stopped.
 */
export const LEASE_SECONDS = 300;
export const FREE_DAILY_REVIEWS = 1;
export const FREE_CONCURRENCY = 1;
export const PAID_CONCURRENCY = 4;
/** Access continues this long past the paid period, so a renewal invoice has time to settle. */
export const RENEWAL_GRACE_SECONDS = 21600;

const PAID = "SELECT 1 FROM subscriptions WHERE account_id = ?1 AND status = 'active' AND paid_until > ?2";
const RUNNING = "SELECT COUNT(*) FROM reviews WHERE account_id = ?1 AND status = 'running' AND lease_until > ?2";

/**
 * @typedef {object} Usage
 * @property {'free' | 'weekly' | 'past_due'} plan  `past_due` is a subscription whose last payment failed.
 * @property {number} usedToday
 * @property {number | null} remainingToday  null on the paid plan.
 * @property {number} running
 * @property {number} concurrency
 * @property {string} resetsAt  When the free allowance resets, ISO 8601.
 * @property {string | null} paidUntil  End of the paid period, ISO 8601.
 */

function dayOf(now) {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

/**
 * @param {D1Database} db
 * @param {string} account
 * @param {number} now
 * @returns {Promise<boolean>}
 */
export async function paidAccess(db, account, now) {
  return Boolean(await db.prepare(`${PAID} LIMIT 1`).bind(account, now).first());
}

/**
 * Reserves one hosted review. Returns `{ ok: true }`, or `{ ok: false, reason }`
 * with `review_running` when the account is at its concurrency limit and
 * `daily_used` when the free review of the day is spent.
 *
 * @param {D1Database} db
 * @param {string} account
 * @param {string} id
 * @param {number} now
 * @param {{ profile?: string, channel?: string }} [labels]
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'review_running' | 'daily_used' }>}
 */
export async function reserveReview(db, account, id, now, { profile = 'general', channel = 'web' } = {}) {
  await db
    .prepare("UPDATE reviews SET status = 'failed' WHERE account_id = ? AND status = 'running' AND lease_until <= ?")
    .bind(account, now)
    .run();

  // One statement decides and inserts, so two requests that arrive together
  // cannot both take the last slot, in this Worker or in another.
  const result = await db
    .prepare(
      `INSERT INTO reviews (id, account_id, day, status, lease_until, created_at, profile, channel)
       SELECT ?3, ?1, ?4, 'running', ?5, ?2, ?6, ?7
       WHERE (${RUNNING}) < CASE WHEN EXISTS (${PAID}) THEN ${PAID_CONCURRENCY} ELSE ${FREE_CONCURRENCY} END
         AND (
           EXISTS (${PAID})
           OR (SELECT COUNT(*) FROM reviews
               WHERE account_id = ?1 AND day = ?4 AND status IN ('running', 'completed')) < ${FREE_DAILY_REVIEWS}
         )`,
    )
    .bind(account, now, id, dayOf(now), now + LEASE_SECONDS, profile, channel)
    .run();

  if (result.meta.changes === 1) return { ok: true };

  const current = await usage(db, account, now);
  return { ok: false, reason: current.running >= current.concurrency ? 'review_running' : 'daily_used' };
}

/**
 * Ends a reservation. A failed review does not count against the day.
 *
 * @param {D1Database} db
 * @param {string} account
 * @param {string} id
 * @param {boolean} success
 */
export async function finishReview(db, account, id, success) {
  await db
    .prepare("UPDATE reviews SET status = ? WHERE id = ? AND account_id = ? AND status = 'running'")
    .bind(success ? 'completed' : 'failed', id, account)
    .run();
}

/**
 * Pushes the lease of a review that is still delivering.
 *
 * @param {D1Database} db
 * @param {string} account
 * @param {string} id
 * @param {number} now
 */
export async function extendLease(db, account, id, now) {
  await db
    .prepare("UPDATE reviews SET lease_until = ? WHERE id = ? AND account_id = ? AND status = 'running'")
    .bind(now + LEASE_SECONDS, id, account)
    .run();
}

/**
 * Marks every review whose lease ran out as failed, for all accounts.
 * Returns how many rows changed.
 *
 * @param {D1Database} db
 * @param {number} now
 * @returns {Promise<number>}
 */
export async function reapStaleLeases(db, now) {
  const result = await db
    .prepare("UPDATE reviews SET status = 'failed' WHERE status = 'running' AND lease_until <= ?")
    .bind(now)
    .run();
  return result.meta.changes;
}

/**
 * @param {D1Database} db
 * @param {string} account
 * @param {number} now
 * @returns {Promise<Usage>}
 */
export async function usage(db, account, now) {
  const row = await db
    .prepare(
      `SELECT
         (SELECT MAX(paid_until) FROM subscriptions
          WHERE account_id = ?1 AND status = 'active' AND paid_until > ?2) AS paid_until,
         (SELECT COUNT(*) FROM subscriptions
          WHERE account_id = ?1 AND status IN ('past_due', 'unpaid')) AS overdue,
         (SELECT COUNT(*) FROM reviews
          WHERE account_id = ?1 AND day = ?3
            AND (status = 'completed' OR (status = 'running' AND lease_until > ?2))) AS used,
         (${RUNNING}) AS running`,
    )
    .bind(account, now, dayOf(now))
    .first();

  const paidUntil = Number(row?.paid_until || 0);
  const paid = paidUntil > now;
  const used = Number(row?.used || 0);

  let plan = 'free';
  if (paid) plan = 'weekly';
  else if (Number(row?.overdue || 0) > 0) plan = 'past_due';

  return {
    plan,
    usedToday: used,
    remainingToday: paid ? null : Math.max(0, FREE_DAILY_REVIEWS - used),
    running: Number(row?.running || 0),
    concurrency: paid ? PAID_CONCURRENCY : FREE_CONCURRENCY,
    resetsAt: new Date((Math.floor(now / 86400) + 1) * 86400000).toISOString(),
    paidUntil: paid ? new Date((paidUntil - RENEWAL_GRACE_SECONDS) * 1000).toISOString() : null,
  };
}
