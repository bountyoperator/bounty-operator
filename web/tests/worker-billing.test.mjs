import assert from 'node:assert/strict';
import test from 'node:test';

import {
  billingFailure,
  billingLogFields,
  billingReady,
  hasLiveSubscription,
  paidUntilFor,
  settledCents,
  storeStanding,
  subscriptionStanding,
} from '../src/billing.ts';
import { ApiError } from '../src/http.ts';
import { RENEWAL_GRACE_SECONDS } from '../src/quota.mjs';
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
