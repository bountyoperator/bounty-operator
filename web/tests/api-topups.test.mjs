import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyAutoTopupSetupEvent,
  autoTopupData,
  createAutoTopupSetup,
  disableAutoTopup,
  processAutoTopups,
  updateAutoTopup,
} from '../src/api-autotopup.ts';
import { syncMonthlyCredit, syncMonthlyCreditForCharge } from '../src/api-monthly-credit.ts';
import { applyApiPaymentEvent, createApiTopup, localStripeTest, reconcileApiTopup, resyncPendingTopups, syncApiTopup } from '../src/api-topups.ts';
import { apiCreditData, createInferenceKey } from '../src/api-credits.ts';
import { subscriptionSummary } from '../src/billing.ts';
import { clearHostingState, inferenceBilling, inferenceEndpoint, inferencePaused } from '../src/inference.ts';
import { addAccount, createCall, createEnv } from './worker-helpers.mjs';
import { enableSupplierFixture } from './supplier-fixtures.mjs';
import { HOSTING_API, HOSTING_FAILURES, fundedHosting } from './hosting-fixtures.mjs';

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

// ---------------------------------------------------------------------------
// Monthly included $2 API credit
// ---------------------------------------------------------------------------

function setupMonthly() {
  const env = createEnv({
    BILLING_MODE: 'live',
    STRIPE_SECRET_KEY: 'rk_live_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_PRICE_ID: 'price_monthly',
  });
  const account = addAccount(env.DB);
  env.DB.sqlite.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ?').run('cus_1', account);

  const price = {
    id: 'price_monthly',
    livemode: true,
    currency: 'usd',
    unit_amount: 1000,
    type: 'recurring',
    billing_scheme: 'per_unit',
    transform_quantity: null,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
  };
  const sub = { id: 'sub_m1', livemode: true, customer: 'cus_1', status: 'active' };
  const line = {
    livemode: true,
    invoice: 'in_m1',
    currency: 'usd',
    amount: 1000,
    subtotal: 1000,
    quantity: 1,
    quantity_decimal: '1',
    parent: {
      type: 'subscription_item_details',
      subscription_item_details: { proration: false, subscription: 'sub_m1' },
    },
    subscription: 'sub_m1',
    pricing: {
      type: 'price_details',
      price_details: { price: 'price_monthly' },
      unit_amount_decimal: '1000',
    },
    discount_amounts: [],
    pretax_credit_amounts: [],
    period: { start: 1790899200, end: 1793577600 },
  };
  const invoice = {
    id: 'in_m1',
    livemode: true,
    status: 'paid',
    currency: 'usd',
    customer: 'cus_1',
    billing_reason: 'subscription_create',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_m1' } },
    amount_due: 1000,
    amount_paid: 1000,
    amount_remaining: 0,
    subtotal: 1000,
    total: 1000,
    total_discount_amounts: [],
    total_pretax_credit_amounts: [],
    pre_payment_credit_notes_amount: 0,
    post_payment_credit_notes_amount: 0,
    lines: { data: [line], has_more: false },
  };
  const intent = {
    id: 'pi_m1',
    livemode: true,
    status: 'succeeded',
    currency: 'usd',
    amount_received: 1000,
    customer: 'cus_1',
    latest_charge: 'ch_m1',
  };
  const charge = {
    id: 'ch_m1',
    livemode: true,
    status: 'succeeded',
    paid: true,
    captured: true,
    refunded: false,
    disputed: false,
    currency: 'usd',
    amount: 1000,
    amount_captured: 1000,
    amount_refunded: 0,
    customer: 'cus_1',
    payment_intent: 'pi_m1',
  };
  const payment = {
    id: 'inpay_1',
    livemode: true,
    status: 'paid',
    currency: 'usd',
    invoice: 'in_m1',
    amount_paid: 1000,
    payment: { type: 'payment_intent', payment_intent: 'pi_m1' },
  };
  const disputes = [];
  const api = {
    invoices: { retrieve: async () => structuredClone(invoice) },
    prices: { retrieve: async () => structuredClone(price) },
    subscriptions: { retrieve: async () => structuredClone(sub) },
    invoicePayments: { list: async () => ({ data: [structuredClone(payment)], has_more: false }) },
    paymentIntents: { retrieve: async () => structuredClone(intent) },
    charges: { retrieve: async () => structuredClone(charge) },
    disputes: { list: async () => ({ data: structuredClone(disputes), has_more: false }) },
  };
  const balance = () => env.DB.sqlite.prepare('SELECT balance_micro FROM api_wallets').get()?.balance_micro ?? 0;
  return { env, account, price, sub, line, invoice, intent, charge, payment, disputes, api, balance };
}

test('paid monthly invoice issues $2 API credit once and ignores duplicate or weekly invoices', async () => {
  const m = setupMonthly();
  await Promise.all([syncMonthlyCredit(m.env, m.api, 'in_m1'), syncMonthlyCredit(m.env, m.api, 'in_m1')]);
  await syncMonthlyCredit(m.env, m.api, 'in_m1');
  assert.equal(m.balance(), 2000000);
  assert.equal(m.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM api_ledger').get().n, 1);

  // Another invoice for the same subscription and period_start does not issue a second grant.
  m.invoice.id = 'in_m1_dup';
  m.line.invoice = 'in_m1_dup';
  m.payment.invoice = 'in_m1_dup';
  await syncMonthlyCredit(m.env, m.api, 'in_m1_dup');
  assert.equal(m.balance(), 2000000);

  // A weekly price never issues monthly credit.
  const w = setupMonthly();
  w.price.recurring.interval = 'week';
  await syncMonthlyCredit(w.env, w.api, 'in_m1');
  assert.equal(w.balance(), 0);
});

test('monthly credit refund revokes the full $2 grant permanently and stale events cannot restore it', async () => {
  const m = setupMonthly();
  await syncMonthlyCredit(m.env, m.api, 'in_m1', 10);
  assert.equal(m.balance(), 2000000);

  m.charge.amount_refunded = 100;
  await syncMonthlyCreditForCharge(m.env, m.api, 'ch_m1', 20);
  assert.equal(m.balance(), 0);

  // Stale replay reporting 0 refunded cannot restore the revoked grant.
  m.charge.amount_refunded = 0;
  await syncMonthlyCredit(m.env, m.api, 'in_m1', 30);
  assert.equal(m.balance(), 0);
});

test('monthly credit dispute suspends credit, blocks account deletion, and restores on win if unrefunded', async () => {
  const m = setupMonthly();
  await syncMonthlyCredit(m.env, m.api, 'in_m1', 10);
  m.charge.disputed = true;
  m.disputes.push({ charge: 'ch_m1', livemode: true, status: 'needs_response' });
  await syncMonthlyCreditForCharge(m.env, m.api, 'ch_m1', 20);
  assert.equal(m.balance(), 0);
  assert.throws(() => m.env.DB.sqlite.prepare('DELETE FROM accounts').run(), /api_balance_exists/);

  m.disputes[0].status = 'won';
  await syncMonthlyCreditForCharge(m.env, m.api, 'ch_m1', 30);
  assert.equal(m.balance(), 2000000);
});

// ---------------------------------------------------------------------------
// Optional automatic top-ups
// ---------------------------------------------------------------------------

const automaticModel = { id: 'auto-test', name: 'Automatic billing test', source: 'test/model', revision: 'abc', license: 'MIT', quantization: 'FP8', endpoint: 'https://api.infron.ai', upstreamModel: 'test/model', inputRate: 2, outputRate: 8, minimumMicro: 10000, context: 32768, maxOutput: 8192 };

function setupAuto(overrides = {}) {
  clearHostingState();
  const env = createEnv({
    BILLING_MODE: 'live',
    STRIPE_SECRET_KEY: 'rk_live_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_PRICE_ID: 'price_monthly',
    INFERENCE_ENABLED: 'true',
    API_TOPUPS_ENABLED: 'true',
    API_AUTOTOPUPS_ENABLED: 'true',
    INFRON_API_KEY: 'fixture-direct-key',
    INFERENCE_MODELS: JSON.stringify([automaticModel]),
    ...overrides,
  });
  enableSupplierFixture(env);
  const account = addAccount(env.DB);
  env.DB.sqlite.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ?').run('cus_1', account);

  let setupMeta = {};
  const method = {
    id: 'pm_1',
    livemode: true,
    customer: 'cus_1',
    type: 'card',
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
  };
  const setupIntent = {
    id: 'seti_1',
    livemode: true,
    status: 'succeeded',
    usage: 'off_session',
    customer: 'cus_1',
    payment_method: method,
    metadata: {},
  };
  const checkoutSession = {
    id: 'cs_live_setup_1',
    livemode: true,
    mode: 'setup',
    status: 'complete',
    currency: 'usd',
    customer: 'cus_1',
    client_reference_id: account,
    url: 'https://checkout.stripe.com/c/pay/cs_live_setup_1',
    setup_intent: setupIntent,
    metadata: {},
  };
  const charges = new Map();
  const intents = new Map();
  const api = {
    checkout: {
      sessions: {
        create: async (body) => {
          setupMeta = body.metadata;
          checkoutSession.metadata = body.metadata;
          setupIntent.metadata = body.setup_intent_data.metadata;
          return structuredClone(checkoutSession);
        },
        retrieve: async () => structuredClone(checkoutSession),
      },
    },
    setupIntents: { retrieve: async () => structuredClone(setupIntent) },
    paymentMethods: { retrieve: async () => structuredClone(method) },
    paymentIntents: {
      create: async (body) => {
        const id = `pi_auto_${intents.size + 1}`;
        const ch = {
          id: `ch_auto_${intents.size + 1}`,
          paid: true,
          captured: true,
          amount: body.amount,
          amount_refunded: 0,
          currency: 'usd',
          customer: body.customer,
          disputed: false,
          payment_intent: id,
        };
        const pi = {
          id,
          livemode: true,
          status: 'succeeded',
          currency: 'usd',
          amount: body.amount,
          amount_received: body.amount,
          customer: body.customer,
          payment_method: body.payment_method,
          latest_charge: ch,
          metadata: body.metadata,
        };
        charges.set(ch.id, ch);
        intents.set(id, pi);
        return structuredClone(pi);
      },
      retrieve: async (id) => structuredClone(intents.get(id)),
      cancel: async (id) => {
        const pi = intents.get(id);
        pi.status = 'canceled';
        return structuredClone(pi);
      },
      list: async () => ({ data: [...intents.values()].map((i) => structuredClone(i)), has_more: false }),
    },
    charges: { retrieve: async (id) => structuredClone(charges.get(id)) },
    disputes: { list: async () => ({ data: [], has_more: false }) },
  };
  const balance = () => env.DB.sqlite.prepare('SELECT balance_micro FROM api_wallets').get()?.balance_micro ?? 0;
  return { env, account, api, method, setupIntent, checkoutSession, intents, charges, balance, getSetupMeta: () => setupMeta };
}

test('automatic top-ups require verified setup, obey monthly caps, and stop when disabled', async () => {
  const a = setupAuto();
  assert.equal((await autoTopupData(a.env, a.account)).status, 'off');

  await assert.rejects(
    createAutoTopupSetup(a.env, a.api, a.account, 'cus_1', { amount_usd: 20, threshold_usd: 5, monthly_cap_usd: 20, consent: false, request_id: 'req-auto-setup-0001' }),
    { code: 'consent_required' },
  );

  const url = await createAutoTopupSetup(a.env, a.api, a.account, 'cus_1', {
    amount_usd: 20,
    threshold_usd: 5,
    monthly_cap_usd: 20,
    consent: true,
    request_id: 'req-auto-setup-0001',
  });
  assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_live_setup_1');
  assert.equal((await autoTopupData(a.env, a.account)).status, 'setup_pending');

  // Webhook confirms the SetupIntent and enables automatic top-ups.
  await applyAutoTopupSetupEvent(a.env, a.api, { type: 'checkout.session.completed', created: 100, data: { object: a.checkoutSession } });
  const enabledState = await autoTopupData(a.env, a.account);
  assert.equal(enabledState.enabled, true);
  assert.equal(enabledState.payment_method.last4, '4242');

  // Cron initiates one $20 charge because balance ($0) < threshold ($5).
  const baseNow = Math.floor(Date.now() / 1000) + 5;
  await processAutoTopups(a.env, a.api, baseNow);
  assert.equal(a.intents.size, 1);
  // The create response does not unlock credit; a webhook or reconciliation verifies it.
  assert.equal(a.balance(), 0);

  const pi = [...a.intents.values()][0];
  await applyApiPaymentEvent(a.env, a.api, { type: 'payment_intent.succeeded', created: baseNow + 5, data: { object: pi } });
  await applyApiPaymentEvent(a.env, a.api, { type: 'payment_intent.succeeded', created: baseNow + 5, data: { object: pi } });
  assert.equal(a.balance(), 20000000);

  // Spend credit down to $0; monthly cap ($20) prevents a second automatic charge in the same UTC month.
  a.env.DB.sqlite.prepare("INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES('u1', ?, -20000000, 'usage', 'r1', ?)").run(a.account, baseNow + 10);
  assert.equal(a.balance(), 0);
  await processAutoTopups(a.env, a.api, baseNow + 400);
  assert.equal(a.intents.size, 1);
  assert.equal((await autoTopupData(a.env, a.account)).cap_reached, true);

  // Raise monthly cap to $50 with fresh consent, then disable before cron runs: no charge is made.
  await updateAutoTopup(a.env, a.api, a.account, { amount_usd: 20, threshold_usd: 5, monthly_cap_usd: 50, consent: true });
  await disableAutoTopup(a.env, a.account);
  assert.equal((await autoTopupData(a.env, a.account)).enabled, false);
  await processAutoTopups(a.env, a.api, baseNow + 800);
  assert.equal(a.intents.size, 1);

  // Re-enable and verify that a payment reversal trigger automatically pauses auto top-ups.
  await updateAutoTopup(a.env, a.api, a.account, { amount_usd: 20, threshold_usd: 5, monthly_cap_usd: 50, consent: true });
  assert.equal((await autoTopupData(a.env, a.account)).enabled, true);
  a.env.DB.sqlite.prepare("INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES('rev1', ?, -1000000, 'payment_adjustment', 'topup:rev1', ?)").run(a.account, baseNow + 900);
  const paused = await autoTopupData(a.env, a.account);
  assert.equal(paused.enabled, false);
  assert.equal(paused.pause_reason, 'payment_failed');
});

const autoSettings = { amount_usd: 20, threshold_usd: 5, monthly_cap_usd: 20, consent: true, request_id: 'req-auto-setup-0002' };

async function enableAutomatic(a) {
  await createAutoTopupSetup(a.env, a.api, a.account, 'cus_1', autoSettings);
  await applyAutoTopupSetupEvent(a.env, a.api, { type: 'checkout.session.completed', created: 100, data: { object: a.checkoutSession } });
}

/** A reservation a Worker made and then stopped before sending to Stripe. */
function strandedReservation(a, id, now, account = a.account) {
  a.env.DB.sqlite.prepare(`INSERT INTO api_topups(id, account_id, customer_id, amount_micro, source, auto_month, auto_revision, payment_method, created_at, updated_at)
    SELECT ?, account_id, customer_id, amount_micro, 'automatic', ?, revision, payment_method, ?, ? FROM api_autotopup_settings WHERE account_id = ?`)
    .run(id, new Date(now * 1000).toISOString().slice(0, 7), now - 120, now - 120, account);
}

function useRunpod(a) {
  a.env.INFRON_API_KEY = undefined;
  a.env.RUNPOD_API_KEY = 'fixture-runpod-key';
  a.env.INFERENCE_MODELS = JSON.stringify([{ ...automaticModel, endpoint: 'https://autotest.api.runpod.ai' }]);
  clearHostingState();
}

test('automatic purchases fail closed without explicit enablement or a usable model service', async (t) => {
  const outbound = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No external request is expected'); });
  for (const overrides of [
    { API_AUTOTOPUPS_ENABLED: undefined },
    { API_AUTOTOPUPS_ENABLED: 'false' },
    { INFERENCE_ENABLED: 'false' },
    { INFRON_API_KEY: undefined },
    { INFERENCE_MODELS: '[]' },
  ]) {
    const a = setupAuto(overrides);
    assert.equal((await autoTopupData(a.env, a.account)).available, false);
    await assert.rejects(createAutoTopupSetup(a.env, a.api, a.account, 'cus_1', autoSettings), { code: 'topups_unavailable' });
    await assert.rejects(updateAutoTopup(a.env, a.api, a.account, autoSettings), { code: 'topups_unavailable' });
    await processAutoTopups(a.env, a.api);
    assert.equal(a.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM api_autotopup_setups').get().n, 0);
    assert.equal(a.intents.size, 0);
  }
  assert.equal(outbound.mock.callCount(), 0);
});

test('automatic purchases stay closed without supplier pricing or funded allowance', async () => {
  for (const missing of ['pricing', 'allowance']) {
    const a = setupAuto();
    if (missing === 'pricing') delete a.env.SUPPLIER_COST_RULES;
    else a.env.DB.sqlite.prepare('UPDATE supplier_budget_windows SET limit_micro = 0').run();
    assert.equal((await autoTopupData(a.env, a.account)).available, false);
    await assert.rejects(createAutoTopupSetup(a.env, a.api, a.account, 'cus_1', autoSettings), { code: 'topups_unavailable' });
    await processAutoTopups(a.env, a.api);
    assert.equal(a.intents.size, 0);
  }
});

test('paused hosting blocks automatic setup, updates and both new and reserved payments; disable still works', async (t) => {
  const a = setupAuto();
  await enableAutomatic(a);
  useRunpod(a);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { myself: { underBalance: true } } }));
  const closedState = await autoTopupData(a.env, a.account);
  assert.deepEqual([closedState.available, closedState.closure], [false, 'paused']);
  await assert.rejects(createAutoTopupSetup(a.env, a.api, a.account, 'cus_1', { ...autoSettings, request_id: 'req-auto-paused-0001' }), { code: 'topups_unavailable' });
  await assert.rejects(updateAutoTopup(a.env, a.api, a.account, autoSettings), { code: 'topups_unavailable' });
  const now = Math.floor(Date.now() / 1000) + 5;
  await processAutoTopups(a.env, a.api, now);
  assert.equal(a.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM api_topups').get().n, 0);

  // A Worker may stop after reserving a top-up and before sending it to Stripe.
  strandedReservation(a, 'pending-before-pause', now);
  await processAutoTopups(a.env, a.api, now);
  assert.equal(a.intents.size, 0);
  // Nothing reached Stripe, so the unsent reservation expires. A later run
  // reserves again from the balance and settings current then.
  assert.deepEqual({ ...a.env.DB.sqlite.prepare('SELECT status, initiated_at FROM api_topups').get() }, { status: 'expired', initiated_at: 0 });
  assert.equal((await autoTopupData(a.env, a.account)).enabled, true, 'the customer setting is untouched');
  // Disabling also expires an unsent reservation: no charge was ever started.
  strandedReservation(a, 'pending-before-disable', now);
  await disableAutoTopup(a.env, a.account);
  assert.equal((await autoTopupData(a.env, a.account)).enabled, false);
  assert.deepEqual(a.env.DB.sqlite.prepare('SELECT id, status FROM api_topups ORDER BY id').all().map((row) => [row.id, row.status]), [['pending-before-disable', 'expired'], ['pending-before-pause', 'expired']]);
  // The customer's export does not list them as failed payments.
  assert.deepEqual((await apiCreditData(a.env, a.account, true)).topups.map((row) => row.status), ['expired', 'expired']);
});

test('payments already sent reconcile while hosting is paused or automatic top-ups are disabled', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { myself: { underBalance: true } } }));
  for (const stop of ['hosting', 'configuration']) {
    const a = setupAuto();
    await enableAutomatic(a);
    const now = Math.floor(Date.now() / 1000) + 5;
    await processAutoTopups(a.env, a.api, now);
    assert.equal(a.intents.size, 1);
    assert.equal(a.balance(), 0);
    if (stop === 'hosting') useRunpod(a);
    else a.env.API_AUTOTOPUPS_ENABLED = 'false';
    await processAutoTopups(a.env, a.api, now + 120);
    assert.equal(a.balance(), 20000000);
    assert.equal(a.env.DB.sqlite.prepare('SELECT status FROM api_topups').get().status, 'paid');
    assert.equal(a.intents.size, 1);
  }
});

/** Counts the Stripe calls that could start a payment or a setup. */
function countStripe(api) {
  const calls = { checkout: 0, methods: 0, intents: 0 };
  const wrap = (owner, name, key) => {
    const original = owner[name];
    owner[name] = async (...args) => { calls[key]++; return original(...args); };
  };
  wrap(api.checkout.sessions, 'create', 'checkout');
  wrap(api.paymentMethods, 'retrieve', 'methods');
  wrap(api.paymentIntents, 'create', 'intents');
  return calls;
}

const autoTopupCount = (a) => a.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM api_topups').get().n;

/** Production waits a second before reading an unknown state again; most tests do not. */
const FAST = { unknownRetryMs: 0 };

/** A second account with the same automatic settings, due one second after the first. */
function addAutoAccount(a, id, customer) {
  addAccount(a.env.DB, id);
  a.env.DB.sqlite.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ?').run(customer, id);
  a.env.DB.sqlite.prepare(`INSERT INTO api_autotopup_settings(account_id, customer_id, enabled, amount_micro, threshold_micro, monthly_cap_micro, payment_method, payment_method_summary, revision, consent_at, consent_version, next_check_at, updated_at)
    SELECT ?, ?, enabled, amount_micro, threshold_micro, monthly_cap_micro, payment_method, payment_method_summary, revision, consent_at, consent_version, next_check_at + 1, updated_at FROM api_autotopup_settings WHERE account_id = ?`)
    .run(id, customer, a.account);
  return id;
}

test('an unreadable hosting state creates no PaymentIntent; a funded state pays and sent payments still reconcile', async (t) => {
  let answer = fundedHosting;
  const reads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, HOSTING_API, 'only the hosting API is read; Stripe goes through the client stub');
    reads.push(url);
    return answer(url, options);
  });
  for (const [name, failure] of Object.entries(HOSTING_FAILURES)) {
    const a = setupAuto();
    useRunpod(a);
    answer = fundedHosting;
    await enableAutomatic(a);
    const stripe = countStripe(a.api);
    assert.equal((await autoTopupData(a.env, a.account)).available, true, name);

    // A reservation waited for this run while the one-minute cache still says
    // funded. The send skips the cache, finds the state unknown, reads once
    // more, and sends nothing.
    const now = Math.floor(Date.now() / 1000) + 5;
    strandedReservation(a, 'stranded', now);
    answer = failure;
    const before = reads.length;
    await processAutoTopups(a.env, a.api, now, FAST);
    assert.equal(reads.length, before + 2, `${name}: the send skips the cache, and an unknown answer is read once more`);
    assert.equal(stripe.intents, 0, name);
    assert.equal(a.intents.size, 0, name);
    assert.deepEqual({ ...a.env.DB.sqlite.prepare('SELECT status, initiated_at, payment_intent FROM api_topups').get() }, { status: 'expired', initiated_at: 0, payment_intent: null }, `${name}: nothing reached Stripe, so the reservation expires`);
    assert.equal(autoTopupCount(a), 1, `${name}: the due account reserves nothing once the run is closed`);
    const waiting = await autoTopupData(a.env, a.account);
    assert.deepEqual([waiting.enabled, waiting.available, waiting.closure, waiting.pending, waiting.pause_reason], [true, false, 'unknown', false, null], `${name}: nothing to reconcile, so the setting stays on`);

    // Setup, changes and new reservations are refused with a clear error.
    await assert.rejects(createAutoTopupSetup(a.env, a.api, a.account, 'cus_1', { ...autoSettings, request_id: 'req-auto-unknown-0001' }), { code: 'topups_unavailable', message: /hosting status could not be confirmed\. No charge was made\./ }, name);
    await assert.rejects(updateAutoTopup(a.env, a.api, a.account, autoSettings), { code: 'topups_unavailable', message: /hosting status could not be confirmed/ }, name);
    await processAutoTopups(a.env, a.api, now + 400, FAST);
    assert.equal(autoTopupCount(a), 1, `${name}: no reservation while the state is unknown`);
    assert.deepEqual(stripe, { checkout: 0, methods: 0, intents: 0 }, name);

    // A funded answer pays again, whatever the cache holds. One read made by
    // the run covers both its reservation and its send.
    answer = fundedHosting;
    const funded = reads.length;
    await processAutoTopups(a.env, a.api, now + 800, FAST);
    assert.equal(reads.length, funded + 1, `${name}: one read for the reservation and the send`);
    assert.equal(a.intents.size, 1, `${name}: a confirmed funded state pays`);
    assert.equal(a.balance(), 0, 'the create response alone grants no credit');

    // A payment already at Stripe reconciles whatever the hosting state.
    answer = failure;
    clearHostingState();
    const pi = [...a.intents.values()][0];
    await applyApiPaymentEvent(a.env, a.api, { type: 'payment_intent.succeeded', created: now + 805, data: { object: pi } });
    await processAutoTopups(a.env, a.api, now + 1200, FAST);
    assert.equal(a.balance(), 20000000, name);
    assert.equal(a.env.DB.sqlite.prepare('SELECT status FROM api_topups WHERE payment_intent IS NOT NULL').get().status, 'paid', name);
    assert.equal(a.intents.size, 1, name);
  }
});

test('an initiated payment with a lost response is recovered from Stripe while the hosting state is unknown', async (t) => {
  let answer = fundedHosting;
  t.mock.method(globalThis, 'fetch', async (url, options) => answer(url, options));
  const a = setupAuto();
  useRunpod(a);
  await enableAutomatic(a);
  const now = Math.floor(Date.now() / 1000) + 5;
  // Stripe creates the payment but the response never arrives.
  const create = a.api.paymentIntents.create;
  a.api.paymentIntents.create = async (...args) => { await create(...args); throw new Error('Connection lost'); };
  await processAutoTopups(a.env, a.api, now);
  assert.equal(a.intents.size, 1);
  assert.equal(a.env.DB.sqlite.prepare('SELECT payment_intent FROM api_topups').get().payment_intent, null);
  answer = HOSTING_FAILURES['network error'];
  clearHostingState();
  await processAutoTopups(a.env, a.api, now + 120);
  assert.equal(a.env.DB.sqlite.prepare('SELECT status FROM api_topups').get().status, 'paid');
  assert.equal(a.balance(), 20000000);
  assert.equal(a.intents.size, 1, 'recovery never sends a second payment');
});

test('a setup completed while the hosting state is unknown turns on but charges nothing until hosting is confirmed funded', async (t) => {
  let answer = fundedHosting;
  t.mock.method(globalThis, 'fetch', async (url, options) => answer(url, options));
  const a = setupAuto();
  useRunpod(a);
  await createAutoTopupSetup(a.env, a.api, a.account, 'cus_1', autoSettings);
  answer = HOSTING_FAILURES['GraphQL errors'];
  clearHostingState();
  await applyAutoTopupSetupEvent(a.env, a.api, { type: 'checkout.session.completed', created: 100, data: { object: a.checkoutSession } });
  const saved = await autoTopupData(a.env, a.account);
  assert.deepEqual([saved.enabled, saved.available, saved.closure, saved.payment_method.last4], [true, false, 'unknown', '4242']);
  const now = Math.floor(Date.now() / 1000) + 5;
  await processAutoTopups(a.env, a.api, now, FAST);
  assert.equal(autoTopupCount(a), 0);
  assert.equal(a.intents.size, 0);
  answer = fundedHosting;
  clearHostingState();
  await processAutoTopups(a.env, a.api, now + 400);
  assert.equal(a.intents.size, 1, 'the consent given at setup applies once hosting is confirmed funded');
});

test('one dropped hosting read is read again after a second, and the reservation is then sent', async (t) => {
  let answers = [];
  const reads = t.mock.method(globalThis, 'fetch', async () => (answers.shift() ?? fundedHosting)());
  const a = setupAuto();
  useRunpod(a);
  await enableAutomatic(a);
  const now = Math.floor(Date.now() / 1000) + 5;
  strandedReservation(a, 'stranded', now);
  answers = [HOSTING_FAILURES['network error'], fundedHosting];
  const before = reads.mock.callCount();
  const started = Date.now();
  // The production default: one second between the two reads.
  await processAutoTopups(a.env, a.api, now);
  assert.ok(Date.now() - started >= 950, 'the second read waits about a second');
  assert.equal(reads.mock.callCount(), before + 2);
  assert.equal(a.intents.size, 1, 'a funded second read sends the reservation');
  assert.equal(a.env.DB.sqlite.prepare("SELECT payment_intent FROM api_topups WHERE id = 'stranded'").get().payment_intent, 'pi_auto_1', 'the stranded reservation itself was sent');
});

test('a stranded reservation is sent later only while credit is still below the consented threshold', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fundedHosting());
  const a = setupAuto();
  useRunpod(a);
  await enableAutomatic(a);
  const now = Math.floor(Date.now() / 1000) + 5;
  // A Worker reserved at a zero balance and stopped. Credit arrived before the next run.
  strandedReservation(a, 'stranded-credited', now);
  a.env.DB.sqlite.prepare("INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES('manual-credit', ?, 20000000, 'topup', 'fixture', ?)").run(a.account, now - 30);
  a.env.DB.sqlite.prepare('UPDATE api_autotopup_settings SET next_check_at = ?').run(now + 3600);
  await processAutoTopups(a.env, a.api, now);
  assert.equal(a.intents.size, 0, 'the consent covers a top-up only below the threshold');
  assert.deepEqual({ ...a.env.DB.sqlite.prepare("SELECT status, initiated_at FROM api_topups WHERE id = 'stranded-credited'").get() }, { status: 'expired', initiated_at: 0 });

  // US$7 left, US$3 of it held by a running request: credit looks below the
  // US$5 threshold only because of the hold, so the send waits, as the reservation does.
  a.env.DB.sqlite.prepare("INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES('usage-13', ?, -13000000, 'usage', 'fixture', ?)").run(a.account, now - 20);
  await createInferenceKey(createCall(new Request('https://bountyoperator.com/api/inference/keys/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Agent', budget_usd: 20 }) }), a.env), { account_id: a.account });
  const keyId = a.env.DB.sqlite.prepare('SELECT id FROM inference_keys').get().id;
  a.env.DB.sqlite.prepare(`INSERT INTO inference_requests(id, account_id, key_id, model, hold_micro, input_rate, output_rate, minimum_micro, created_at, lease_until)
    VALUES('running-1', ?, ?, 'auto-test', 3000000, 2, 8, 10000, ?, ?)`).run(a.account, keyId, now - 10, now + 600);
  strandedReservation(a, 'stranded-running', now);
  await processAutoTopups(a.env, a.api, now);
  assert.equal(a.intents.size, 0);
  assert.equal(a.env.DB.sqlite.prepare("SELECT status FROM api_topups WHERE id = 'stranded-running'").get().status, 'expired');

  // The request ends and the credit is spent: below the threshold with nothing running, the stranded reservation is sent.
  a.env.DB.sqlite.prepare("UPDATE inference_requests SET status = 'cancelled', finished_at = ? WHERE id = 'running-1'").run(now - 5);
  a.env.DB.sqlite.prepare("INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES('usage-7', ?, -7000000, 'usage', 'fixture', ?)").run(a.account, now - 4);
  strandedReservation(a, 'stranded-due', now);
  await processAutoTopups(a.env, a.api, now);
  assert.equal(a.intents.size, 1);
  assert.equal(a.env.DB.sqlite.prepare("SELECT payment_intent FROM api_topups WHERE id = 'stranded-due'").get().payment_intent, 'pi_auto_1');
});

test('once a run finds purchases closed, other reservations expire without another read and nothing is reserved', async (t) => {
  let answer = fundedHosting;
  const reads = t.mock.method(globalThis, 'fetch', async () => answer());
  const a = setupAuto();
  useRunpod(a);
  await enableAutomatic(a);
  const second = addAutoAccount(a, 'account-2', 'cus_2');
  const now = Math.floor(Date.now() / 1000) + 5;
  strandedReservation(a, 'stranded-1', now);
  strandedReservation(a, 'stranded-2', now, second);
  answer = HOSTING_FAILURES['fetch 500'];
  const before = reads.mock.callCount();
  await processAutoTopups(a.env, a.api, now, FAST);
  assert.equal(reads.mock.callCount(), before + 2, 'one read and one retry, then the run stays closed');
  assert.equal(a.intents.size, 0);
  assert.deepEqual(a.env.DB.sqlite.prepare('SELECT id, status, initiated_at FROM api_topups ORDER BY id').all().map((row) => [row.id, row.status, row.initiated_at]),
    [['stranded-1', 'expired', 0], ['stranded-2', 'expired', 0]], 'both due accounts reserve nothing');
});

test('a send that finds purchases closed stops the run before the next due account is reserved', async (t) => {
  let answers = [];
  const reads = t.mock.method(globalThis, 'fetch', async () => (answers.shift() ?? fundedHosting)());
  const a = setupAuto();
  useRunpod(a);
  await enableAutomatic(a);
  const second = addAutoAccount(a, 'account-2', 'cus_2');
  const secondCheck = a.env.DB.sqlite.prepare('SELECT next_check_at FROM api_autotopup_settings WHERE account_id = ?').get(second).next_check_at;
  const now = Math.floor(Date.now() / 1000) + 5;
  // The reservation check is funded; the first send, made after the reuse
  // window (zero here, as when Stripe is slow), reads unknown twice.
  answers = [fundedHosting, HOSTING_FAILURES.timeout, HOSTING_FAILURES.timeout];
  const before = reads.mock.callCount();
  await processAutoTopups(a.env, a.api, now, { unknownRetryMs: 0, reuseMs: 0 });
  assert.equal(reads.mock.callCount(), before + 3);
  assert.equal(a.intents.size, 0);
  assert.deepEqual(a.env.DB.sqlite.prepare('SELECT account_id, status FROM api_topups').all().map((row) => [row.account_id, row.status]), [[a.account, 'expired']]);
  assert.equal(a.env.DB.sqlite.prepare('SELECT next_check_at FROM api_autotopup_settings WHERE account_id = ?').get(second).next_check_at, secondCheck, 'the second account is left for the next run');
});

test('a worker that answers /health while the hosting read is unknown opens no purchase', async (t) => {
  let answer = fundedHosting;
  const upstream = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === HOSTING_API) return answer(url, options);
    upstream.push(url);
    if (url.endsWith('/health')) return new Response(null, { status: 200 });
    return Response.json({ created: 1, choices: [{ message: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  });
  const a = setupAuto();
  useRunpod(a);
  await enableAutomatic(a);

  // Another customer, with credit, makes a request while the funding read fails.
  answer = HOSTING_FAILURES['GraphQL errors'];
  clearHostingState();
  const other = addAccount(a.env.DB, 'account-with-credit');
  a.env.DB.sqlite.prepare("INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES('fund-other', ?, 20000000, 'topup', 'fixture', 1)").run(other);
  const created = await createInferenceKey(createCall(new Request('https://bountyoperator.com/api/inference/keys/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Other', budget_usd: 20 }) }), a.env), { account_id: other });
  const { key } = await created.json();
  const response = await inferenceEndpoint(createCall(new Request('https://bountyoperator.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: automaticModel.id, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 20 }),
  }), a.env));
  assert.equal(response.status, 200);
  assert.ok(upstream.includes('https://autotest.api.runpod.ai/health'), 'the worker answered its health probe');

  // That 200 says the worker answers, not that the account is funded.
  assert.deepEqual(await inferenceBilling(a.env), { status: 'unknown', reason: 'graphql_errors' });
  const data = await autoTopupData(a.env, a.account);
  assert.deepEqual([data.available, data.closure], [false, 'unknown']);
  await assert.rejects(updateAutoTopup(a.env, a.api, a.account, autoSettings), { code: 'topups_unavailable' });
  await processAutoTopups(a.env, a.api, Math.floor(Date.now() / 1000) + 5, FAST);
  assert.equal(autoTopupCount(a), 0);
  assert.equal(a.intents.size, 0);
});

test('a usable direct provider keeps automatic top-ups available when Runpod is paused', async (t) => {
  const a = setupAuto({ RUNPOD_API_KEY: 'fixture-runpod-key' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { myself: { underBalance: true } } }));
  assert.equal(await inferencePaused(a.env), true);
  assert.equal((await autoTopupData(a.env, a.account)).available, true);
  await enableAutomatic(a);
  await processAutoTopups(a.env, a.api, Math.floor(Date.now() / 1000) + 5);
  assert.equal(a.intents.size, 1);
});

test('subscriptionSummary preserves legacy weekly terms separately from monthly subscriptions', async () => {
  const env = createEnv();
  const account = addAccount(env.DB);
  env.DB.sqlite
    .prepare("INSERT INTO subscriptions(id, account_id, status, paid_until, price_id, billing_interval, period_end, cancel_at_period_end, updated_at) VALUES('sub_w', ?, 'active', 2000, 'price_w', 'week', 1500, 1, 1)")
    .run(account);
  const weekly = await subscriptionSummary(env.DB, account);
  assert.equal(weekly.interval, 'week');
  assert.equal(weekly.legacy, true);
  assert.equal(weekly.included_api_credit_usd, 0);
  assert.equal(weekly.cancel_at_period_end, true);

  env.DB.sqlite.prepare("UPDATE subscriptions SET billing_interval = 'month', cancel_at_period_end = 0 WHERE id = 'sub_w'").run();
  const monthly = await subscriptionSummary(env.DB, account);
  assert.equal(monthly.interval, 'month');
  assert.equal(monthly.legacy, false);
  assert.equal(monthly.included_api_credit_usd, 2);
  assert.equal(monthly.cancel_at_period_end, false);
});
