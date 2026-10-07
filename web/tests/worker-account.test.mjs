// The data export and account deletion.

import assert from 'node:assert/strict';
import test from 'node:test';

import { deleteAccount, exportAccount } from '../src/account.ts';
import { addAccount, addSubscription, createCall, createContext, createEnv, SITE_ORIGIN } from './worker-helpers.mjs';

const ACCOUNT = 'account-1';
const LIVE = { BILLING_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_FAKE_LOCAL_ONLY', STRIPE_PRICE_ID: 'price_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
const session = { account_id: ACCOUNT, token_hash: 'session', csrf: 'csrf', expires: 0, auth_at: 0 };
const call = (env) => createCall(new Request(`${SITE_ORIGIN}/api/account/delete`, { method: 'POST', body: '{}' }), env, createContext());

function linkStripe(env, customer = 'cus_1') {
  env.DB.sqlite.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ?').run(customer, ACCOUNT);
}

/** Answers Stripe's subscription list with the given statuses, and refuses every other host. */
function stubStripe(t, statuses) {
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host !== 'api.stripe.com') throw new Error(`unexpected host ${url.host}`);
    asked.push(url.pathname + url.search);
    const data = statuses.map((status, index) => ({ id: `sub_${index}`, object: 'subscription', status, items: { data: [] } }));
    return Response.json({ object: 'list', data, has_more: false, url: '/v1/subscriptions' });
  };
  t.after(() => { globalThis.fetch = original; });
  return asked;
}

const deleted = (env) => !env.DB.sqlite.prepare('SELECT 1 FROM accounts WHERE id = ?').get(ACCOUNT);

test('the export holds every stored review row and the billing records', async () => {
  const env = createEnv();
  addAccount(env.DB, ACCOUNT);
  linkStripe(env);
  addSubscription(env.DB, { status: 'canceled', paidUntil: 0 });
  const insert = env.DB.sqlite.prepare("INSERT INTO reviews (id, account_id, day, status, lease_until, created_at, profile, channel) VALUES (?, ?, '2026-10-07', 'completed', 0, ?, 'general', 'web')");
  for (let index = 0; index < 35; index += 1) insert.run(`review-${index}`, ACCOUNT, 1000 + index);

  const body = await (await exportAccount(call(env), session)).json();
  assert.equal(body.reviews.length, 35, 'not only the 30 the panel shows');
  assert.equal(body.billing.stripeCustomer, 'cus_1');
  assert.deepEqual(body.billing.subscriptions.map((row) => row.status), ['canceled']);
});

test('an account linked to Stripe is not deleted while billing cannot be checked', async () => {
  const env = createEnv();
  addAccount(env.DB, ACCOUNT);
  linkStripe(env);
  await assert.rejects(deleteAccount(call(env), session), (error) => error.code === 'billing_exists' && error.status === 409);
  assert.equal(deleted(env), false);
});

test('deletion asks Stripe for a subscription the database never stored', async (t) => {
  const env = createEnv(LIVE);
  addAccount(env.DB, ACCOUNT);
  linkStripe(env);
  const asked = stubStripe(t, ['active']);
  await assert.rejects(deleteAccount(call(env), session), (error) => error.code === 'billing_exists');
  assert.match(asked[0], /^\/v1\/subscriptions\?.*customer=cus_1/);
  assert.equal(deleted(env), false);
});

test('an account whose Stripe subscriptions have all ended is deleted', async (t) => {
  const env = createEnv(LIVE);
  addAccount(env.DB, ACCOUNT);
  linkStripe(env);
  stubStripe(t, ['canceled', 'incomplete_expired']);
  const response = await deleteAccount(call(env), session);
  assert.equal(response.status, 200);
  assert.equal(deleted(env), true);
});

test('an account never linked to Stripe is deleted without asking Stripe', async (t) => {
  const env = createEnv(LIVE);
  addAccount(env.DB, ACCOUNT);
  const asked = stubStripe(t, ['active']);
  assert.equal((await deleteAccount(call(env), session)).status, 200);
  assert.equal(asked.length, 0);
  assert.equal(deleted(env), true);
});
