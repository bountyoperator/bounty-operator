import assert from 'node:assert/strict';
import test from 'node:test';

import {
  billingFailure,
  billingLogFields,
  billingReady,
  hasLiveSubscription,
  paidUntilFor,
  resyncEndingSubscriptions,
  settledCents,
  storeStanding,
  subscriptionStanding,
} from '../src/billing.ts';
import { ApiError } from '../src/http.ts';
import { RENEWAL_GRACE_SECONDS } from '../src/quota.mjs';
import worker from '../src/worker.ts';
import { addAccount, addSubscription, createContext, createDatabase, createEnv, funnelCounts } from './worker-helpers.mjs';

const PRICE = 'price_operator';
// 2026-10-02T00:00:00Z
const NOW = 1790899200;
const PERIOD_END = NOW + 7 * 86400;

function operatorPrice(overrides = {}) {
  return { id: PRICE, currency: 'usd', unit_amount: 1000, recurring: { interval: 'week', interval_count: 1 }, ...overrides };
}

function invoice(overrides = {}) {
  return { id: 'in_1', status: 'paid', amount_paid: 1000, created: NOW - 60, ...overrides };
}

/** A Stripe subscription as `subscriptions.retrieve(id, { expand: ['latest_invoice'] })` returns it. */
function subscription(overrides = {}) {
  return {
    id: 'sub_1',
    livemode: true,
    status: 'active',
    pause_collection: null,
    customer: 'cus_1',
    latest_invoice: invoice(),
    items: { data: [{ quantity: 1, current_period_end: PERIOD_END, price: operatorPrice() }] },
    ...overrides,
  };
}

const standing = (overrides) => subscriptionStanding(subscription(overrides), PRICE, NOW);

test('an active subscription with a paid invoice is paid through the period end', () => {
  assert.deepEqual(standing(), { kind: 'paid', periodEnd: PERIOD_END, invoiceId: 'in_1' });
});

test('access is stored six hours past the period end', () => {
  assert.equal(RENEWAL_GRACE_SECONDS, 21600);
  assert.equal(paidUntilFor(PERIOD_END), PERIOD_END + 21600);
});

test('a renewal invoice still in draft keeps access: the subscriber has not missed a payment', () => {
  const created = NOW - 1800;
  assert.deepEqual(standing({ latest_invoice: invoice({ status: 'draft', amount_paid: 0, created }) }), {
    kind: 'renewing',
    graceUntil: created + RENEWAL_GRACE_SECONDS,
  });
});

test('a renewal invoice that is open and being charged keeps access too', () => {
  const created = NOW - 4000;
  assert.deepEqual(standing({ latest_invoice: invoice({ status: 'open', amount_paid: 0, created }) }), {
    kind: 'renewing',
    graceUntil: created + RENEWAL_GRACE_SECONDS,
  });
});

test('the grace is anchored to the invoice, so replaying the event cannot stretch it', () => {
  const draft = { latest_invoice: invoice({ status: 'draft', amount_paid: 0, created: NOW - 3600 }) };
  const first = subscriptionStanding(subscription(draft), PRICE, NOW);
  const later = subscriptionStanding(subscription(draft), PRICE, NOW + 7200);
  assert.deepEqual(first, later);
});

test('an unpaid invoice older than 24 hours carries no access', () => {
  const stale = invoice({ status: 'open', amount_paid: 0, created: NOW - 86400 - 1 });
  assert.deepEqual(standing({ latest_invoice: stale }), { kind: 'lapsed', status: 'unpaid' });
});

test('a subscription Stripe no longer calls active is lapsed under its own status', () => {
  for (const status of ['past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'trialing']) {
    assert.deepEqual(standing({ status }), { kind: 'lapsed', status }, status);
  }
  // Even with a draft invoice: a failed payment is not a renewal in progress.
  const draft = invoice({ status: 'draft', amount_paid: 0 });
  assert.deepEqual(standing({ status: 'past_due', latest_invoice: draft }), { kind: 'lapsed', status: 'past_due' });
});

test('anything other than exactly one Operator plan at US$10 a week is lapsed', () => {
  const withItem = (item) => standing({ items: { data: [{ quantity: 1, current_period_end: PERIOD_END, price: operatorPrice(), ...item }] } });
  const lapsed = { kind: 'lapsed', status: 'unpaid' };

  assert.deepEqual(withItem({ price: operatorPrice({ id: 'price_other' }) }), lapsed);
  assert.deepEqual(withItem({ price: operatorPrice({ unit_amount: 100 }) }), lapsed);
  assert.deepEqual(withItem({ price: operatorPrice({ currency: 'eur' }) }), lapsed);
  assert.deepEqual(withItem({ price: operatorPrice({ recurring: { interval: 'month', interval_count: 1 } }) }), lapsed);
  assert.deepEqual(withItem({ price: operatorPrice({ recurring: { interval: 'week', interval_count: 4 } }) }), lapsed);
  assert.deepEqual(withItem({ price: operatorPrice({ recurring: null }) }), lapsed);
  assert.deepEqual(withItem({ quantity: 2 }), lapsed);
  assert.deepEqual(standing({ items: { data: [] } }), lapsed);

  const two = { quantity: 1, current_period_end: PERIOD_END, price: operatorPrice() };
  assert.deepEqual(standing({ items: { data: [two, two] } }), lapsed);
});

test('test-mode, paused and invoice-less subscriptions are lapsed', () => {
  const lapsed = { kind: 'lapsed', status: 'unpaid' };
  assert.deepEqual(standing({ livemode: false }), lapsed);
  assert.deepEqual(standing({ pause_collection: { behavior: 'void' } }), lapsed);
  assert.deepEqual(standing({ latest_invoice: null }), lapsed);
  assert.deepEqual(standing({ latest_invoice: 'in_not_expanded' }), lapsed);
});

test('a paid invoice below the price, or a voided one, is lapsed', () => {
  const lapsed = { kind: 'lapsed', status: 'unpaid' };
  assert.deepEqual(standing({ latest_invoice: invoice({ amount_paid: 999 }) }), lapsed);
  assert.deepEqual(standing({ latest_invoice: invoice({ status: 'void', amount_paid: 0 }) }), lapsed);
  assert.deepEqual(standing({ latest_invoice: invoice({ status: 'uncollectible', amount_paid: 0 }) }), lapsed);
});

test('settledCents counts only money that was paid in USD and is still held', () => {
  const charge = { paid: true, refunded: false, currency: 'usd', amount: 1000, amount_refunded: 0 };

  assert.equal(settledCents(1000, charge, false), 1000);
  assert.equal(settledCents(1000, { ...charge, amount_refunded: 400 }, false), 600);
  assert.equal(settledCents(500, charge, false), 500);
  assert.equal(settledCents(null, charge, false), 0);

  assert.equal(settledCents(1000, charge, true), 0, 'an open dispute');
  assert.equal(settledCents(1000, { ...charge, refunded: true, amount_refunded: 1000 }, false), 0);
  assert.equal(settledCents(1000, { ...charge, paid: false }, false), 0);
  assert.equal(settledCents(1000, { ...charge, currency: 'eur' }, false), 0);
});

test('billingFailure passes a coded error through unchanged', () => {
  const exists = new ApiError('This account already has a subscription. Open Manage subscription.', 409, 'billing_exists');
  assert.equal(billingFailure(exists), exists);
});

/** An error shaped like the Stripe SDK throws it. */
function stripeError(type, fields = {}) {
  return Object.assign(new Error('No such customer: cus_SECRET; request req_123'), { type, ...fields });
}

test('billingFailure maps Stripe failures to coded errors and never repeats Stripe text', () => {
  const cases = [
    ['StripeRateLimitError', 503, 'billing_unavailable', 60],
    ['StripeConnectionError', 503, 'billing_unavailable', 60],
    ['StripeAPIError', 503, 'billing_unavailable', 60],
    ['StripeIdempotencyError', 409, 'billing_busy', 5],
    ['StripeAuthenticationError', 503, 'billing_unavailable', undefined],
    ['StripePermissionError', 503, 'billing_unavailable', undefined],
    ['StripeInvalidRequestError', 503, 'billing_unavailable', undefined],
    ['StripeCardError', 503, 'billing_unavailable', undefined],
  ];
  for (const [type, status, code, retryAfter] of cases) {
    const mapped = billingFailure(stripeError(type));
    assert(mapped instanceof ApiError, type);
    assert.equal(mapped.status, status, type);
    assert.equal(mapped.code, code, type);
    assert.equal(mapped.extra.retryAfter, retryAfter, type);
    assert(!/cus_|req_/.test(mapped.message), type);
  }
});

test('billingFailure treats anything unknown as billing being unavailable', () => {
  for (const thrown of [new TypeError('fetch failed'), 'a string', null, undefined, { type: 'NotStripe' }]) {
    const mapped = billingFailure(thrown);
    assert.equal(mapped.status, 503);
    assert.equal(mapped.code, 'billing_unavailable');
  }
});

test('billingLogFields keeps the error class and Stripe code, and drops the message', () => {
  const fields = billingLogFields(stripeError('StripeInvalidRequestError', { code: 'resource_missing' }));
  assert.deepEqual(fields, { name: 'Error', type: 'StripeInvalidRequestError', code: 'resource_missing' });
  assert(!JSON.stringify(fields).includes('cus_SECRET'));

  assert.deepEqual(billingLogFields(new TypeError('boom')), { name: 'TypeError', type: '', code: '' });
  assert.deepEqual(billingLogFields(null), { name: 'unknown', type: '', code: '' });
});

test('billing is ready only in live mode with a live key, a price and a webhook secret', () => {
  const live = { BILLING_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_PRICE_ID: PRICE, STRIPE_WEBHOOK_SECRET: 'whsec_x' };
  assert.equal(billingReady(live), true);
  assert.equal(billingReady({ ...live, STRIPE_SECRET_KEY: 'sk_live_x' }), true);

  assert.equal(billingReady({ ...live, BILLING_MODE: 'disabled' }), false);
  assert.equal(billingReady({ ...live, STRIPE_SECRET_KEY: 'sk_test_x' }), false);
  assert.equal(billingReady({ ...live, STRIPE_SECRET_KEY: undefined }), false);
  assert.equal(billingReady({ ...live, STRIPE_WEBHOOK_SECRET: undefined }), false);
  assert.equal(billingReady({ ...live, STRIPE_PRICE_ID: '' }), false);
});

test('an account can be deleted once no subscription can bill it again', async () => {
  const db = createDatabase();
  addAccount(db);
  assert.equal(await hasLiveSubscription(db, 'account-1'), false, 'a customer record without a subscription does not block');

  addSubscription(db, { id: 'sub_old', status: 'canceled' });
  addSubscription(db, { id: 'sub_expired', status: 'incomplete_expired' });
  assert.equal(await hasLiveSubscription(db, 'account-1'), false);

  for (const status of ['active', 'past_due', 'unpaid', 'paused', 'incomplete']) {
    db.sqlite.prepare("UPDATE subscriptions SET status = ? WHERE id = 'sub_old'").run(status);
    assert.equal(await hasLiveSubscription(db, 'account-1'), true, status);
  }
});

function stored(env, id = 'sub_1') {
  const row = env.DB.sqlite.prepare('SELECT status, paid_until FROM subscriptions WHERE id = ?').get(id);
  return row ? { ...row } : null;
}

async function store(env, standing, settled = true) {
  const ctx = createContext();
  await storeStanding(env, ctx, 'sub_1', 'account-1', standing, settled);
  await ctx.settled();
}

test('a settled paid period is stored as active and counted once', async () => {
  const env = createEnv();
  addAccount(env.DB);
  const paid = { kind: 'paid', periodEnd: PERIOD_END, invoiceId: 'in_1' };

  await store(env, paid);
  assert.deepEqual(stored(env), { status: 'active', paid_until: PERIOD_END + RENEWAL_GRACE_SECONDS });
  await store(env, paid);
  assert.deepEqual(funnelCounts(env.DB), { sub_active: 1 }, 'a second webhook for the same period is not a new subscriber');
});

test('a burst of concurrent syncs for one new subscription counts it once', async () => {
  // Checkout sends about six webhooks at once; each one syncs the subscription.
  const env = createEnv();
  addAccount(env.DB);
  const paid = { kind: 'paid', periodEnd: PERIOD_END, invoiceId: 'in_1' };
  await Promise.all(Array.from({ length: 6 }, () => store(env, paid)));
  assert.deepEqual(stored(env), { status: 'active', paid_until: PERIOD_END + RENEWAL_GRACE_SECONDS });
  assert.deepEqual(funnelCounts(env.DB), { sub_active: 1 });
});

test('a subscription Stripe ended stays ended: a slower sync cannot write an older state over it', async () => {
  for (const ended of ['canceled', 'incomplete_expired']) {
    const env = createEnv();
    addAccount(env.DB);
    addSubscription(env.DB, { status: ended, paidUntil: 0 });

    await store(env, { kind: 'paid', periodEnd: PERIOD_END, invoiceId: 'in_1' });
    assert.deepEqual(stored(env), { status: ended, paid_until: 0 }, `${ended}: a stale paid read`);
    await store(env, { kind: 'lapsed', status: 'past_due' });
    assert.deepEqual(stored(env), { status: ended, paid_until: 0 }, `${ended}: a stale past_due read`);
    await store(env, { kind: 'paid', periodEnd: PERIOD_END, invoiceId: 'in_1' }, false);
    assert.deepEqual(stored(env), { status: ended, paid_until: 0 }, `${ended}: a stale unsettled read`);
    assert.deepEqual(funnelCounts(env.DB), {});
  }
});

test('a paid invoice whose payments do not add up grants nothing', async () => {
  const env = createEnv();
  addAccount(env.DB);
  await store(env, { kind: 'paid', periodEnd: PERIOD_END, invoiceId: 'in_1' }, false);
  assert.deepEqual(stored(env), { status: 'unpaid', paid_until: 0 });
  assert.deepEqual(funnelCounts(env.DB), {});
});

test('a renewal in progress extends existing access and never shortens it', async () => {
  const env = createEnv();
  addAccount(env.DB);
  const oldEnd = NOW + 600;
  addSubscription(env.DB, { paidUntil: oldEnd });

  await store(env, { kind: 'renewing', graceUntil: NOW + RENEWAL_GRACE_SECONDS });
  assert.deepEqual(stored(env), { status: 'active', paid_until: NOW + RENEWAL_GRACE_SECONDS });

  await store(env, { kind: 'renewing', graceUntil: NOW + 100 });
  assert.deepEqual(stored(env), { status: 'active', paid_until: NOW + RENEWAL_GRACE_SECONDS });
});

test('a renewal in progress does not create access where there was none', async () => {
  const env = createEnv();
  addAccount(env.DB);
  await store(env, { kind: 'renewing', graceUntil: NOW + RENEWAL_GRACE_SECONDS });
  assert.deepEqual(stored(env), { status: 'unpaid', paid_until: 0 });

  env.DB.sqlite.prepare("UPDATE subscriptions SET status = 'past_due'").run();
  await store(env, { kind: 'renewing', graceUntil: NOW + RENEWAL_GRACE_SECONDS });
  assert.deepEqual(stored(env), { status: 'unpaid', paid_until: 0 });
});

test('a lapsed subscription loses access under its Stripe status', async () => {
  const env = createEnv();
  addAccount(env.DB);
  addSubscription(env.DB, { paidUntil: PERIOD_END });

  await store(env, { kind: 'lapsed', status: 'past_due' });
  assert.deepEqual(stored(env), { status: 'past_due', paid_until: 0 });
});

// ---------------------------------------------------------------------------
// The scheduled read of subscriptions whose paid period is ending
// ---------------------------------------------------------------------------

const LIVE = { BILLING_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_FAKE_LOCAL_ONLY', STRIPE_PRICE_ID: PRICE, STRIPE_WEBHOOK_SECRET: 'whsec_x' };
const HOUR = 3600;
const NEXT_END = PERIOD_END + 7 * 86400;

/** An account with a Stripe customer and one active subscription that is paid until `paidUntil`. */
function subscriber(env, { id = 'sub_1', account = 'account-1', customer = 'cus_1', paidUntil, updatedAt = 1 }) {
  addAccount(env.DB, account);
  env.DB.sqlite.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ?').run(customer, account);
  addSubscription(env.DB, { id, account, paidUntil });
  env.DB.sqlite.prepare('UPDATE subscriptions SET updated_at = ? WHERE id = ?').run(updatedAt, id);
}

/**
 * Answers Stripe for the subscriptions in `subscriptions` (by id), with one
 * settled charge behind every paid invoice, and refuses every other host.
 * Returns the ids of the subscriptions that were asked for, in order.
 */
function stubStripeSubscriptions(t, subscriptions) {
  const original = globalThis.fetch;
  const asked = [];
  const missing = { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such subscription' } };
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host !== 'api.stripe.com') throw new Error(`unexpected host ${url.host}`);
    const found = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname);
    if (found) {
      asked.push(found[1]);
      const body = subscriptions[found[1]];
      return body ? Response.json({ object: 'subscription', ...body }) : Response.json(missing, { status: 404 });
    }
    if (url.pathname === '/v1/invoice_payments') {
      return Response.json({ object: 'list', has_more: false, url: '/v1/invoice_payments', data: [{ amount_paid: 1000, payment: { type: 'charge', charge: 'ch_1' } }] });
    }
    if (url.pathname === '/v1/charges/ch_1') {
      return Response.json({ id: 'ch_1', object: 'charge', paid: true, refunded: false, disputed: false, currency: 'usd', amount: 1000, amount_refunded: 0 });
    }
    throw new Error(`unexpected Stripe call ${url.pathname}`);
  };
  t.after(() => { globalThis.fetch = original; });
  return asked;
}

async function resync(env, now = NOW) {
  const ctx = createContext();
  const read = await resyncEndingSubscriptions(env, ctx, now);
  await ctx.settled();
  return read;
}

const updatedAt = (env, id = 'sub_1') => env.DB.sqlite.prepare('SELECT updated_at FROM subscriptions WHERE id = ?').get(id).updated_at;

test('a renewal whose webhook never arrived is read from Stripe, and the next week is stored', async (t) => {
  const env = createEnv(LIVE);
  // The paid period ended an hour ago: five hours of grace are left.
  subscriber(env, { paidUntil: NOW + 5 * HOUR });
  const renewed = subscription({ latest_invoice: invoice({ id: 'in_2' }), items: { data: [{ quantity: 1, current_period_end: NEXT_END, price: operatorPrice() }] } });
  const asked = stubStripeSubscriptions(t, { sub_1: renewed });

  assert.equal(await resync(env), 1);
  assert.deepEqual(asked, ['sub_1']);
  assert.deepEqual(stored(env), { status: 'active', paid_until: NEXT_END + RENEWAL_GRACE_SECONDS });
  assert.deepEqual(funnelCounts(env.DB), {}, 'a renewal is not a new subscriber');
});

test('a subscription cancelled at Stripe without a webhook loses its access at the next read', async (t) => {
  const env = createEnv(LIVE);
  subscriber(env, { paidUntil: NOW + 5 * HOUR });
  stubStripeSubscriptions(t, { sub_1: subscription({ status: 'canceled' }) });

  assert.equal(await resync(env), 1);
  assert.deepEqual(stored(env), { status: 'canceled', paid_until: 0 });
});

test('the read starts twelve hours before the paid period ends, and not earlier', async (t) => {
  const env = createEnv(LIVE);
  // Stored end = period end + six hours of grace.
  subscriber(env, { paidUntil: NOW + 18 * HOUR + 60 });
  const asked = stubStripeSubscriptions(t, { sub_1: subscription() });

  assert.equal(await resync(env), 0);
  assert.deepEqual(asked, [], 'more than twelve hours of the period are left');

  assert.equal(await resync(env, NOW + 120), 1);
  assert.deepEqual(asked, ['sub_1']);
});

test('a subscription is read at most once an hour', async (t) => {
  const env = createEnv(LIVE);
  subscriber(env, { paidUntil: NOW + 5 * HOUR, updatedAt: NOW - HOUR + 60 });
  const asked = stubStripeSubscriptions(t, { sub_1: subscription() });

  assert.equal(await resync(env), 0);
  assert.equal(await resync(env, NOW + 120), 1);
  assert.deepEqual(asked, ['sub_1']);
});

test('a read that fails changes nothing, takes its turn, and does not stop the reads after it', async (t) => {
  const env = createEnv(LIVE);
  subscriber(env, { id: 'sub_gone', account: 'account-1', customer: 'cus_1', paidUntil: NOW + 5 * HOUR, updatedAt: 1 });
  subscriber(env, { id: 'sub_2', account: 'account-2', customer: 'cus_2', paidUntil: NOW + 5 * HOUR, updatedAt: 2 });
  const renewed = subscription({ id: 'sub_2', customer: 'cus_2', items: { data: [{ quantity: 1, current_period_end: NEXT_END, price: operatorPrice() }] } });
  const asked = stubStripeSubscriptions(t, { sub_2: renewed });
  const logged = t.mock.method(console, 'error', () => {});

  assert.equal(await resync(env), 1, 'only the read that worked is counted');
  assert.deepEqual(asked, ['sub_gone', 'sub_2']);
  assert.deepEqual(stored(env, 'sub_gone'), { status: 'active', paid_until: NOW + 5 * HOUR }, 'access is never taken away on a failed read');
  assert.deepEqual(stored(env, 'sub_2'), { status: 'active', paid_until: NEXT_END + RENEWAL_GRACE_SECONDS });
  assert.equal(logged.mock.callCount(), 1);
  const [line, fields] = logged.mock.calls[0].arguments;
  assert.equal(line, 'Subscription resync failed');
  assert.deepEqual([fields.type, fields.code], ['StripeInvalidRequestError', 'resource_missing'], 'the log names the failure and holds no id');

  assert.equal(updatedAt(env, 'sub_gone'), NOW, 'the failed row waits an hour like the others');
  assert.equal(await resync(env, NOW + 60), 0);
  assert.equal(asked.length, 2, 'Stripe is not asked again within the hour');
});

test('one run reads four subscriptions, the longest unread first', async (t) => {
  const env = createEnv(LIVE);
  const subscriptions = {};
  for (let index = 1; index <= 6; index += 1) {
    const id = `sub_${index}`;
    // sub_6 was read longest ago, sub_1 most recently.
    subscriber(env, { id, account: `account-${index}`, customer: `cus_${index}`, paidUntil: NOW + 5 * HOUR, updatedAt: 100 - index });
    subscriptions[id] = subscription({ id, customer: `cus_${index}` });
  }
  const asked = stubStripeSubscriptions(t, subscriptions);

  assert.equal(await resync(env), 4);
  assert.deepEqual(asked, ['sub_6', 'sub_5', 'sub_4', 'sub_3']);
  assert.equal(await resync(env), 2, 'the next run takes the rest');
  assert.deepEqual(asked.slice(4), ['sub_2', 'sub_1']);
});

test('a subscription that is not active, or whose access ended more than a week ago, is left alone', async (t) => {
  const env = createEnv(LIVE);
  subscriber(env, { id: 'sub_old', account: 'account-1', customer: 'cus_1', paidUntil: NOW - 8 * 86400 });
  subscriber(env, { id: 'sub_due', account: 'account-2', customer: 'cus_2', paidUntil: NOW + 5 * HOUR });
  env.DB.sqlite.prepare("UPDATE subscriptions SET status = 'past_due' WHERE id = 'sub_due'").run();
  const asked = stubStripeSubscriptions(t, {});

  assert.equal(await resync(env), 0);
  assert.deepEqual(asked, []);
});

test('without live billing nothing is read', async (t) => {
  const env = createEnv();
  subscriber(env, { paidUntil: NOW + 5 * HOUR });
  const asked = stubStripeSubscriptions(t, { sub_1: subscription() });

  assert.equal(await resync(env), 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(stored(env), { status: 'active', paid_until: NOW + 5 * HOUR });
});

const EVERY_15_MINUTES = '*/15 * * * *';
const DAILY = '17 3 * * *';

test('every scheduled run reads the ending subscriptions and logs how many', async (t) => {
  const env = createEnv(LIVE);
  // A scheduled run goes by the clock.
  const now = Math.floor(Date.now() / 1000);
  const nextEnd = now + 7 * 86400;
  subscriber(env, { paidUntil: now + 5 * HOUR });
  stubStripeSubscriptions(t, { sub_1: subscription({ items: { data: [{ quantity: 1, current_period_end: nextEnd, price: operatorPrice() }] } }) });
  const logged = t.mock.method(console, 'log', () => {});

  const ctx = createContext();
  await worker.scheduled({ cron: EVERY_15_MINUTES }, env, ctx);
  await ctx.settled();

  assert.deepEqual(stored(env), { status: 'active', paid_until: nextEnd + RENEWAL_GRACE_SECONDS });
  assert.deepEqual(logged.mock.calls[0].arguments, ['Scheduled cleanup', { cron: EVERY_15_MINUTES, reapedLeases: 0, resynced: 1 }]);
});

test('a read of subscriptions that cannot start does not stop the daily purge', async (t) => {
  const env = createEnv(LIVE);
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => {
    if (sql.includes('FROM subscriptions')) throw new Error('database away');
    return prepare(sql);
  };
  const logged = t.mock.method(console, 'log', () => {});
  const failed = t.mock.method(console, 'error', () => {});

  await worker.scheduled({ cron: DAILY }, env, createContext());

  const [line, fields] = logged.mock.calls[0].arguments;
  assert.equal(line, 'Scheduled cleanup');
  assert.equal(fields.resynced, 0);
  assert.equal(fields.stripeEvents, 0, 'the purge ran and reported');
  assert.equal(failed.mock.callCount(), 1);
  assert.equal(failed.mock.calls[0].arguments[0], 'Subscription resync failed');
});
