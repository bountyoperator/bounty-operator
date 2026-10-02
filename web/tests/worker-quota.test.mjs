import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FREE_CONCURRENCY,
  LEASE_SECONDS,
  PAID_CONCURRENCY,
  RENEWAL_GRACE_SECONDS,
  extendLease,
  finishReview,
  paidAccess,
  reapStaleLeases,
  reserveReview,
  usage,
} from '../src/quota.mjs';
import { addAccount, addSubscription, createDatabase } from './worker-helpers.mjs';

// 2026-10-02T00:00:00Z
const NOW = 1790899200;
const ACCOUNT = 'account-1';

function setup() {
  const db = createDatabase();
  addAccount(db, ACCOUNT);
  return db;
}

const reserve = (db, id, now = NOW, labels) => reserveReview(db, ACCOUNT, id, now, labels);

function row(db, id) {
  return db.sqlite.prepare('SELECT status, profile, channel, lease_until FROM reviews WHERE id = ?').get(id);
}

test('free: one review at a time, and one completed review per UTC day', async () => {
  const db = setup();

  assert.deepEqual(await reserve(db, 'one'), { ok: true });
  assert.deepEqual(await reserve(db, 'two'), { ok: false, reason: 'review_running' });

  await finishReview(db, ACCOUNT, 'one', false);
  assert.deepEqual(await reserve(db, 'three'), { ok: true }, 'a failed review gives the allowance back');

  await finishReview(db, ACCOUNT, 'three', true);
  assert.deepEqual(await reserve(db, 'four'), { ok: false, reason: 'daily_used' });

  const used = await usage(db, ACCOUNT, NOW);
  assert.equal(used.plan, 'free');
  assert.equal(used.usedToday, 1);
  assert.equal(used.remainingToday, 0);
  assert.equal(used.running, 0);
  assert.equal(used.concurrency, FREE_CONCURRENCY);
  assert.equal(used.resetsAt, '2026-10-03T00:00:00.000Z');
  assert.equal(used.paidUntil, null);

  assert.deepEqual(await reserve(db, 'five', NOW + 86400), { ok: true }, 'the next UTC day opens a new review');
});

test('a reservation records its profile and channel in the same statement', async () => {
  const db = setup();
  await reserve(db, 'one', NOW, { profile: 'solidity', channel: 'mcp' });
  assert.deepEqual({ ...row(db, 'one') }, { status: 'running', profile: 'solidity', channel: 'mcp', lease_until: NOW + LEASE_SECONDS });

  await finishReview(db, ACCOUNT, 'one', false);
  await reserve(db, 'two');
  assert.equal(row(db, 'two').profile, 'general');
  assert.equal(row(db, 'two').channel, 'web');
});

test('a lease that ran out frees the slot and does not count against the day', async () => {
  const db = setup();
  await reserve(db, 'stuck');

  assert.equal((await reserve(db, 'early', NOW + LEASE_SECONDS - 1)).ok, false);
  assert.deepEqual(await reserve(db, 'late', NOW + LEASE_SECONDS), { ok: true });
  assert.equal(row(db, 'stuck').status, 'failed');
});

test('extendLease keeps a delivering review alive past the first lease', async () => {
  const db = setup();
  await reserve(db, 'streaming');
  await extendLease(db, ACCOUNT, 'streaming', NOW + 200);
  assert.equal(row(db, 'streaming').lease_until, NOW + 200 + LEASE_SECONDS);

  assert.deepEqual(await reserve(db, 'second', NOW + LEASE_SECONDS + 100), { ok: false, reason: 'review_running' });

  await finishReview(db, ACCOUNT, 'streaming', true);
  await extendLease(db, ACCOUNT, 'streaming', NOW + 400);
  assert.equal(row(db, 'streaming').lease_until, NOW + 200 + LEASE_SECONDS, 'a finished review is not extended');
});

test('reapStaleLeases fails every expired running review, for all accounts', async () => {
  const db = setup();
  addAccount(db, 'account-2');
  await reserveReview(db, 'account-2', 'done', NOW - 1000);
  await finishReview(db, 'account-2', 'done', true);
  await reserveReview(db, ACCOUNT, 'old-1', NOW);
  await reserveReview(db, 'account-2', 'old-2', NOW);

  assert.equal(await reapStaleLeases(db, NOW + LEASE_SECONDS - 1), 0);
  assert.equal(await reapStaleLeases(db, NOW + LEASE_SECONDS), 2);
  assert.equal(row(db, 'old-1').status, 'failed');
  assert.equal(row(db, 'old-2').status, 'failed');
  assert.equal(row(db, 'done').status, 'completed');
});

test('paid: no daily limit and four reviews at once', async () => {
  const db = setup();
  const paidUntil = NOW + 7 * 86400 + RENEWAL_GRACE_SECONDS;
  addSubscription(db, { paidUntil });

  assert.equal(PAID_CONCURRENCY, 4);
  for (let index = 1; index <= PAID_CONCURRENCY; index += 1) {
    assert.deepEqual(await reserve(db, `run-${index}`), { ok: true });
  }
  assert.deepEqual(await reserve(db, 'run-5'), { ok: false, reason: 'review_running' });

  const busy = await usage(db, ACCOUNT, NOW);
  assert.equal(busy.plan, 'weekly');
  assert.equal(busy.running, 4);
  assert.equal(busy.concurrency, 4);
  assert.equal(busy.remainingToday, null);
  assert.equal(busy.paidUntil, new Date((NOW + 7 * 86400) * 1000).toISOString(), 'the grace is not shown as paid time');

  for (let index = 1; index <= PAID_CONCURRENCY; index += 1) await finishReview(db, ACCOUNT, `run-${index}`, true);
  assert.deepEqual(await reserve(db, 'run-6'), { ok: true }, 'completed reviews do not use up a paid day');
  assert.equal((await usage(db, ACCOUNT, NOW)).usedToday, 5);
});

test('only an unexpired active subscription lifts the limits', async () => {
  const db = setup();
  await reserve(db, 'one');
  await finishReview(db, ACCOUNT, 'one', true);

  addSubscription(db, { status: 'unpaid', paidUntil: NOW + 1000 });
  assert.equal(await paidAccess(db, ACCOUNT, NOW), false);
  assert.deepEqual(await reserve(db, 'two'), { ok: false, reason: 'daily_used' });
  assert.equal((await usage(db, ACCOUNT, NOW)).plan, 'past_due', 'a failed payment is shown as past due, not as free');

  db.sqlite.prepare("UPDATE subscriptions SET status = 'active', paid_until = ?").run(NOW - 1);
  assert.deepEqual(await reserve(db, 'three'), { ok: false, reason: 'daily_used' });
  assert.equal((await usage(db, ACCOUNT, NOW)).plan, 'free');

  db.sqlite.prepare('UPDATE subscriptions SET paid_until = ?').run(NOW + 1000);
  assert.equal(await paidAccess(db, ACCOUNT, NOW), true);
  assert.deepEqual(await reserve(db, 'four'), { ok: true });
});

test('a subscription on another account grants nothing', async () => {
  const db = setup();
  addAccount(db, 'account-2');
  addSubscription(db, { account: 'account-2', paidUntil: NOW + 1000 });

  await reserve(db, 'one');
  assert.deepEqual(await reserve(db, 'two'), { ok: false, reason: 'review_running' });
  assert.equal((await usage(db, ACCOUNT, NOW)).plan, 'free');
});

test('simultaneous reservations cannot exceed the limit', async () => {
  const db = setup();
  const outcomes = await Promise.all(['a', 'b', 'c'].map((id) => reserve(db, id)));
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
});
