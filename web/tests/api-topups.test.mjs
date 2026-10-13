import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyApiPaymentEvent, createApiTopup, localStripeTest, reconcileApiTopup, resyncPendingTopups, syncApiTopup } from '../src/api-topups.ts';
import { addAccount, createEnv } from './worker-helpers.mjs';

function setup() {
  const env = createEnv();
  const account = addAccount(env.DB);
  const charge = { id: 'ch_1', paid: true, captured: true, amount: 2000, amount_refunded: 0, currency: 'usd', customer: 'cus_1', disputed: false, payment_intent: 'pi_1' };
  const intent = { id: 'pi_1', livemode: true, status: 'succeeded', currency: 'usd', amount_received: 2000, customer: 'cus_1', latest_charge: charge, metadata: { app: 'bounty-operator-api', topup_id: 'topup-1' } };
  const session = { id: 'cs_live_1', livemode: true, mode: 'payment', currency: 'usd', amount_total: 2000, amount_subtotal: 2000, customer: 'cus_1', client_reference_id: account, metadata: { app: 'bounty-operator-api', topup_id: 'topup-1', account_id: account }, status: 'complete', payment_status: 'paid', payment_intent: intent };
  env.DB.sqlite.prepare('INSERT INTO api_topups(id, account_id, customer_id, checkout_id, amount_micro, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run('topup-1', account, 'cus_1', 'cs_live_1', 20000000, 1, 1);
  const disputes = [];
  const api = { checkout: { sessions: { retrieve: async () => structuredClone(session) } }, charges: { retrieve: async () => structuredClone(charge) }, paymentIntents: { retrieve: async () => structuredClone(intent) }, disputes: { list: async () => ({ data: structuredClone(disputes), has_more: false }) } };
  const balance = () => env.DB.sqlite.prepare('SELECT balance_micro FROM api_wallets').get()?.balance_micro ?? 0;
  return { env, account, charge, intent, session, disputes, api, balance };
}

test('concurrent and repeated payment fulfilment credits exactly once', async () => {
  const { env, api, balance } = setup();
  await Promise.all([syncApiTopup(env, api, 'topup-1'), syncApiTopup(env, api, 'topup-1')]);
  await syncApiTopup(env, api, 'topup-1');
  assert.equal(balance(), 20000000);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM api_ledger').get().n, 1);
});

test('unsettled, wrong-customer and wrong-amount payments never receive credit', async () => {
  const f = setup();
  f.session.payment_status = 'unpaid';
  await syncApiTopup(f.env, f.api, 'topup-1');
  assert.equal(f.balance(), 0);
  f.session.payment_status = 'paid';
  f.intent.amount_received = 1999;
  await assert.rejects(syncApiTopup(f.env, f.api, 'topup-1'), /verification failed/);
  f.intent.amount_received = 2000;
  f.session.customer = 'cus_other';
  await assert.rejects(syncApiTopup(f.env, f.api, 'topup-1'), /verification failed/);
  assert.equal(f.balance(), 0);
});

test('partial refunds deduct once and a stale refund total cannot restore funds', async () => {
  const f = setup();
  await syncApiTopup(f.env, f.api, 'topup-1');
  f.charge.amount_refunded = 500;
  await syncApiTopup(f.env, f.api, 'topup-1');
  await syncApiTopup(f.env, f.api, 'topup-1');
  assert.equal(f.balance(), 15000000);
  f.charge.amount_refunded = 0;
  await syncApiTopup(f.env, f.api, 'topup-1');
  assert.equal(f.balance(), 15000000);
  assert.equal(f.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM api_ledger').get().n, 2);
});

test('disputes suspend credit, a win restores the unrefunded amount and old events cannot undo it', async () => {
  const f = setup();
  await syncApiTopup(f.env, f.api, 'topup-1', 1);
  f.charge.disputed = true;
  f.disputes.push({ status: 'needs_response' });
  await syncApiTopup(f.env, f.api, 'topup-1', 20);
  assert.equal(f.balance(), 0);
  assert.throws(() => f.env.DB.sqlite.prepare('DELETE FROM accounts').run(), /api_balance_exists/);
  f.disputes[0].status = 'won';
  await syncApiTopup(f.env, f.api, 'topup-1', 30);
  assert.equal(f.balance(), 20000000);
  assert.equal(f.env.DB.sqlite.prepare('SELECT dispute_open FROM api_topups').get().dispute_open, 0);
  f.disputes[0].status = 'needs_response';
  await syncApiTopup(f.env, f.api, 'topup-1', 20);
  assert.equal(f.balance(), 20000000);
});

test('refund after usage can make the wallet negative and prevents further spending', async () => {
  const f = setup();
  await syncApiTopup(f.env, f.api, 'topup-1');
  f.env.DB.sqlite.prepare("INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES('usage-fixture', ?, -10000000, 'usage', 'req_1', 2)").run(f.account);
  f.charge.amount_refunded = 2000;
  await syncApiTopup(f.env, f.api, 'topup-1');
  assert.equal(f.balance(), -10000000);
});

test('checkout return enforces account ownership and does not trust the redirect', async () => {
  const f = setup();
  await assert.rejects(reconcileApiTopup(f.env, f.api, 'other-account', 'cs_live_1'), { code: 'forbidden' });
  f.session.payment_status = 'unpaid';
  await reconcileApiTopup(f.env, f.api, f.account, 'cs_live_1');
  assert.equal(f.balance(), 0);
});

test('async payment success and a refund event use current Stripe state', async () => {
  const f = setup();
  assert.equal(await applyApiPaymentEvent(f.env, f.api, { type: 'checkout.session.async_payment_succeeded', created: 1, data: { object: f.session } }), true);
  assert.equal(f.balance(), 20000000);
  f.charge.amount_refunded = 200;
  assert.equal(await applyApiPaymentEvent(f.env, f.api, { type: 'charge.refunded', created: 2, data: { object: f.charge } }), true);
  assert.equal(f.balance(), 18000000);
});

test('top-up creation pins allowed prices and preserves an idempotent checkout', async () => {
  const env = createEnv();
  const account = addAccount(env.DB);
  let created = 0;
  const api = { checkout: { sessions: {
    create: async (body, options) => {
      created++;
      assert.equal(body.mode, 'payment');
      assert.equal(body.line_items[0].price_data.unit_amount, 2000);
      assert.equal(body.line_items[0].quantity, 1);
      assert.ok(!('payment_method_types' in body));
      assert.match(options.idempotencyKey, /^api-topup-/);
      return { id: 'cs_live_new', url: 'https://checkout.stripe.com/c/pay/test', payment_intent: null };
    },
    retrieve: async () => ({ status: 'open', url: 'https://checkout.stripe.com/c/pay/test' }),
  } } };
  const nonce = '7e578a31-acdc-43bb-9211-141969cf6749';
  await assert.rejects(createApiTopup(env, api, account, 'cus_1', 1, nonce), /Choose a/);
  const first = await createApiTopup(env, api, account, 'cus_1', 20, nonce);
  assert.equal(await createApiTopup(env, api, account, 'cus_1', 20, nonce), first);
  assert.equal(created, 1);
  await assert.rejects(createApiTopup(env, api, account, 'cus_1', 50, nonce), { code: 'checkout_conflict' });
});

test('test-mode payments are confined to an explicitly configured local server', async () => {
  const f = setup();
  f.session.livemode = f.intent.livemode = false;
  await assert.rejects(syncApiTopup(f.env, f.api, 'topup-1'), /verification failed/);
  Object.assign(f.env, { BILLING_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_fixture', SITE_ORIGIN: 'https://bountyoperator.com' });
  assert.equal(localStripeTest(f.env), false);
  await assert.rejects(syncApiTopup(f.env, f.api, 'topup-1'), /verification failed/);
  f.env.SITE_ORIGIN = 'http://localhost:8799';
  await syncApiTopup(f.env, f.api, 'topup-1');
  assert.equal(f.balance(), 20000000);
});

test('failed delayed payments close their reservation without issuing credit', async () => {
  const f = setup();
  f.session.payment_status = 'unpaid';
  f.intent.status = 'requires_payment_method';
  await syncApiTopup(f.env, f.api, 'topup-1');
  assert.equal(f.balance(), 0);
  assert.equal(f.env.DB.sqlite.prepare('SELECT status FROM api_topups').get().status, 'failed');
});

test('an ambiguous checkout creation is recovered before stale reservations are closed', async () => {
  const f = setup();
  f.env.DB.sqlite.prepare('UPDATE api_topups SET checkout_id = NULL').run();
  f.api.checkout.sessions.list = async () => ({ data: [structuredClone(f.session)], has_more: false });
  await resyncPendingTopups(f.env, f.api);
  assert.equal(f.balance(), 20000000);
  assert.equal(f.env.DB.sqlite.prepare('SELECT checkout_id FROM api_topups').get().checkout_id, 'cs_live_1');
});

test('a missing checkout closes only after a complete Stripe search', async () => {
  const f = setup();
  f.env.DB.sqlite.prepare('UPDATE api_topups SET checkout_id = NULL').run();
  f.api.checkout.sessions.list = async () => ({ data: [], has_more: true });
  await resyncPendingTopups(f.env, f.api);
  assert.equal(f.env.DB.sqlite.prepare('SELECT status FROM api_topups').get().status, 'pending');
  f.api.checkout.sessions.list = async () => ({ data: [], has_more: false });
  await resyncPendingTopups(f.env, f.api);
  assert.equal(f.env.DB.sqlite.prepare('SELECT status FROM api_topups').get().status, 'failed');
  assert.equal(f.balance(), 0);
});
