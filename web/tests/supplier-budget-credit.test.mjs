// Confirmed customer credit funds a share of supplier allowance in the same
// D1 batch as the credit. Stripe is a stand-in; nothing leaves the process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reserveInference } from '../src/api-credits.ts';
import { syncMonthlyCredit, syncMonthlyCreditForCharge } from '../src/api-monthly-credit.ts';
import { applyApiPaymentEvent, reconcileApiTopup, syncApiTopup } from '../src/api-topups.ts';
import { supplierAvailability, supplierBudgetCreditStatements, supplierBudgetProviders, supplierBudgetRefillable, supplierBudgetShare, supplierBudgetShareProblem, supplierOperatingReport, supplierShareShortfalls, sweepSupplierBudgets } from '../src/supplier-costs.ts';
import worker from '../src/worker.ts';
import { addAccount, createContext, createEnv } from './worker-helpers.mjs';

const DAY = 86400;
const TERM = 30 * DAY;
const now = () => Math.floor(Date.now() / 1000);
const runpodModel = { id: 'budget-runpod', name: 'Budget test', source: 'test/budget-model', revision: 'abc', license: 'MIT', quantization: 'FP8',
  endpoint: 'https://budget123.api.runpod.ai', upstreamModel: 'budget-runpod', inputRate: 2, outputRate: 8, minimumMicro: 10, context: 100, maxOutput: 20 };
const infronModel = { ...runpodModel, id: 'budget-infron', endpoint: 'https://api.infron.ai', upstreamModel: 'test/budget-infron' };
const orcaModel = { ...runpodModel, id: 'budget-orca', endpoint: 'https://api.orcarouter.ai', upstreamModel: 'test/budget-orca' };

function rule(model) {
  const runpod = /^https:\/\/([a-z0-9]+)\.api\.runpod\.ai$/.exec(model.endpoint);
  const provider = runpod ? 'runpod' : model.endpoint === 'https://api.infron.ai' ? 'infron' : 'orcarouter';
  return { model: model.id, endpoint: model.endpoint, upstreamModel: model.upstreamModel, provider, resourceId: runpod ? runpod[1] : model.upstreamModel,
    basis: runpod ? 'runtime_allowance' : 'token_rate', revision: 'test-only-quote', source: 'https://fixtures.invalid/pricing', validUntil: now() + DAY,
    ...(runpod ? { holdMicro: 1000 } : { inputMicroPerMillion: 1000000, outputMicroPerMillion: 1000000, fixedMicro: 0 }) };
}

function baseEnv({ share, models = [runpodModel], overrides = {} } = {}) {
  return createEnv({ INFERENCE_MODELS: JSON.stringify(models), SUPPLIER_COST_RULES: JSON.stringify(models.map(rule)), RUNPOD_API_KEY: 'test-only',
    ...(share === undefined ? {} : { SUPPLIER_BUDGET_SHARE: share }), ...overrides });
}

function addWindow(env, { id = 'operator', provider = 'runpod', starts = now() - DAY, ends = now() + DAY, limit = 0, enabled = 1, reserved = 0, consumed = 0 } = {}) {
  env.DB.sqlite.prepare(`INSERT INTO supplier_budget_windows(id, provider, starts_at, ends_at, limit_micro, reserved_micro, consumed_micro, enabled, funding_reference, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'operator fixture', ?)`).run(id, provider, starts, ends, limit, reserved, consumed, enabled, now());
}
const windows = (env) => env.DB.sqlite.prepare('SELECT * FROM supplier_budget_windows ORDER BY provider, starts_at, id').all().map((row) => ({ ...row }));
const windowById = (env, id) => ({ ...env.DB.sqlite.prepare('SELECT * FROM supplier_budget_windows WHERE id = ?').get(id) });
const adjustments = (env) => env.DB.sqlite.prepare('SELECT * FROM supplier_budget_adjustments ORDER BY created_at, rowid').all().map((row) => ({ ...row }));
const automaticWindow = (env, provider = 'runpod') => windows(env).find((row) => row.provider === provider && row.funding_reference.startsWith('automatic'));

/** A paid US$20 Checkout top-up, as Stripe reports it. */
function topup(options = {}) {
  const env = baseEnv(options);
  const account = addAccount(env.DB);
  const charge = { id: 'ch_1', paid: true, captured: true, amount: 2000, amount_refunded: 0, currency: 'usd', customer: 'cus_1', disputed: false, payment_intent: 'pi_1' };
  const intent = { id: 'pi_1', livemode: true, status: 'succeeded', currency: 'usd', amount_received: 2000, customer: 'cus_1', latest_charge: charge, metadata: { app: 'bounty-operator-api', topup_id: 'topup-1' } };
  const session = { id: 'cs_live_1', livemode: true, mode: 'payment', currency: 'usd', amount_total: 2000, amount_subtotal: 2000, customer: 'cus_1', client_reference_id: account,
    metadata: { app: 'bounty-operator-api', topup_id: 'topup-1', account_id: account }, status: 'complete', payment_status: 'paid', payment_intent: intent };
  env.DB.sqlite.prepare('INSERT INTO api_topups(id, account_id, customer_id, checkout_id, amount_micro, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run('topup-1', account, 'cus_1', 'cs_live_1', 20000000, 1, 1);
  const disputes = [];
  const api = { checkout: { sessions: { retrieve: async () => structuredClone(session) } }, charges: { retrieve: async () => structuredClone(charge) },
    paymentIntents: { retrieve: async () => structuredClone(intent) }, disputes: { list: async () => ({ data: structuredClone(disputes), has_more: false }) } };
  const balance = () => env.DB.sqlite.prepare('SELECT balance_micro FROM api_wallets').get()?.balance_micro ?? 0;
  const sync = (eventTime = 0) => syncApiTopup(env, api, 'topup-1', eventTime);
  return { env, account, charge, intent, session, disputes, api, balance, sync };
}

test('the share setting is a plain decimal clamped to 0..1, defaulting to 0.9 and failing closed', () => {
  const cases = [[undefined, 900000], ['', 900000], ['  ', 900000], ['0.9', 900000], ['0.5', 500000], [' 0.25 ', 250000], ['.5', 500000], ['1', 1000000],
    ['1.5', 1000000], ['0', 0], ['-0.5', 0], ['0.3333333', 333333], ['abc', 0], ['0.9.1', 0], ['1e-1', 0], ['NaN', 0], ['Infinity', 0], ['90%', 0]];
  for (const [value, ppm] of cases) assert.equal(supplierBudgetShare({ SUPPLIER_BUDGET_SHARE: value }), ppm, String(value));
});

test('a paid top-up adds the configured share to the current window exactly once', async () => {
  const f = topup();
  addWindow(f.env, { limit: 5000000 });
  await Promise.all([f.sync(), f.sync()]);
  await f.sync();
  assert.equal(f.balance(), 20000000);
  assert.equal(windowById(f.env, 'operator').limit_micro, 5000000 + 18000000);
  const [row] = adjustments(f.env);
  assert.equal(adjustments(f.env).length, 1);
  assert.deepEqual({ kind: row.kind, provider: row.provider, window_id: row.window_id, ledger_id: row.ledger_id, source: row.source, customer_micro: row.customer_micro,
    share_ppm: row.share_ppm, requested_micro: row.requested_micro, amount_micro: row.amount_micro },
  { kind: 'customer_credit', provider: 'runpod', window_id: 'operator', ledger_id: 'topup:topup-1:1', source: 'topup:topup-1', customer_micro: 20000000,
    share_ppm: 900000, requested_micro: 18000000, amount_micro: 18000000 });

  // Replayed Stripe events and the customer's return page change nothing.
  for (const type of ['checkout.session.completed', 'checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
    assert.equal(await applyApiPaymentEvent(f.env, f.api, { type, created: 5, data: { object: f.session } }), true);
  }
  await reconcileApiTopup(f.env, f.api, f.account, 'cs_live_1');
  assert.equal(windowById(f.env, 'operator').limit_micro, 23000000);
  assert.equal(adjustments(f.env).length, 1);
  assert.equal(windows(f.env).length, 1);
});

test('refunds remove the share the payment added, never below the reserved and consumed allowance', async () => {
  const f = topup();
  await f.sync();
  const id = automaticWindow(f.env).id;
  assert.equal(windowById(f.env, id).limit_micro, 18000000);
  f.charge.amount_refunded = 500;
  await f.sync();
  await f.sync();
  assert.equal(f.balance(), 15000000);
  assert.equal(windowById(f.env, id).limit_micro, 13500000);
  // A stale refund total cannot restore credit, so it cannot restore allowance.
  f.charge.amount_refunded = 0;
  await f.sync();
  assert.equal(windowById(f.env, id).limit_micro, 13500000);

  // 12 of the 13.5 left is already spent: a full refund can only take 1.5.
  f.env.DB.sqlite.prepare('UPDATE supplier_budget_windows SET reserved_micro = 1000000, consumed_micro = 11000000 WHERE id = ?').run(id);
  f.charge.amount_refunded = 2000;
  await f.sync();
  assert.equal(f.balance(), 0);
  const window = windowById(f.env, id);
  assert.equal(window.limit_micro, window.reserved_micro + window.consumed_micro);
  const last = adjustments(f.env).at(-1);
  assert.deepEqual([last.customer_micro, last.requested_micro, last.amount_micro], [-15000000, -13500000, -1500000]);
  assert.equal(adjustments(f.env).length, 3);
});

test('a dispute removes the share and a won dispute restores it', async () => {
  const f = topup();
  addWindow(f.env);
  await f.sync(1);
  f.charge.disputed = true;
  f.disputes.push({ status: 'needs_response' });
  await f.sync(20);
  assert.equal(f.balance(), 0);
  assert.equal(windowById(f.env, 'operator').limit_micro, 0);
  f.disputes[0].status = 'won';
  await f.sync(30);
  assert.equal(f.balance(), 20000000);
  assert.equal(windowById(f.env, 'operator').limit_micro, 18000000);
  assert.deepEqual(adjustments(f.env).map((row) => row.amount_micro), [18000000, -18000000, 18000000]);
});

test('with no current window a credit opens an enabled rolling 30-day window', async () => {
  const f = topup();
  // An ended operator window holds no customer funds and passes nothing on.
  addWindow(f.env, { id: 'ended', starts: now() - 40 * DAY, ends: now() - 10 * DAY, limit: 7000000 });
  const before = now();
  await f.sync();
  const created = automaticWindow(f.env);
  assert.ok(created.starts_at >= before && created.starts_at <= now());
  assert.equal(created.ends_at - created.starts_at, TERM);
  assert.equal(created.enabled, 1);
  assert.equal(created.limit_micro, 18000000);
  assert.equal(windowById(f.env, 'ended').limit_micro, 7000000);
  assert.equal(adjustments(f.env).length, 1);
});

test('an opened window ends where a later window starts, so the overlap guard cannot abort the credit', async () => {
  for (const enabled of [1, 0]) {
    const f = topup();
    const later = now() + 10 * DAY;
    addWindow(f.env, { id: 'later', starts: later, ends: later + TERM, enabled });
    await f.sync();
    assert.equal(f.balance(), 20000000);
    const created = automaticWindow(f.env);
    assert.equal(created.ends_at, later);
    assert.equal(created.limit_micro, 18000000);
    assert.equal(windowById(f.env, 'later').limit_micro, 0);
  }
});

test('a disabled window covering now is a pause: it keeps the allowance and no window opens beside it', async () => {
  const f = topup();
  addWindow(f.env, { id: 'paused', enabled: 0 });
  await f.sync();
  assert.equal(windows(f.env).length, 1);
  assert.equal(windowById(f.env, 'paused').limit_micro, 18000000);
  assert.equal(windowById(f.env, 'paused').enabled, 0);
});

test('the pause is enabled = 0 on the window covering now; a disabled window beside an enabled one pauses nothing', async () => {
  // Disabling the window that covers now: the credit still lands in it, no
  // window opens beside it, no request is admitted and top-ups close.
  const paused = topup();
  addWindow(paused.env, { id: 'current', limit: 5000000 });
  paused.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET enabled = 0 WHERE id = 'current'").run();
  await paused.sync();
  assert.deepEqual(windows(paused.env).map((row) => row.id), ['current']);
  assert.equal(windowById(paused.env, 'current').limit_micro, 23000000);
  assert.equal((await supplierAvailability(paused.env, [runpodModel]))[runpodModel.id].code, 'supplier_unavailable');
  assert.deepEqual([...await supplierBudgetRefillable(paused.env, [runpodModel], 20000000)], []);

  // A separate disabled window beside an enabled one is not a pause: the
  // enabled window takes the share and keeps admitting requests.
  const beside = topup();
  addWindow(beside.env, { id: 'selling', limit: 5000000 });
  addWindow(beside.env, { id: 'ignored', enabled: 0, starts: now() - DAY + 1 });
  await beside.sync();
  assert.equal(windowById(beside.env, 'selling').limit_micro, 23000000);
  assert.equal(windowById(beside.env, 'ignored').limit_micro, 0);
  assert.equal((await supplierAvailability(beside.env, [runpodModel]))[runpodModel.id].code, 'available');
});

test('a share of zero or an unreadable share adds nothing and opens no window', async () => {
  for (const share of ['0', 'ninety percent']) {
    const f = topup({ share });
    await f.sync();
    assert.equal(f.balance(), 20000000);
    assert.deepEqual(windows(f.env), []);
    assert.deepEqual(adjustments(f.env), []);
  }
  const f = topup({ share: '0' });
  addWindow(f.env, { limit: 5000000 });
  await f.sync();
  assert.equal(windowById(f.env, 'operator').limit_micro, 5000000);
});

test('refunds remove the share at the rate it was added, even after the setting changes or funding stops', async () => {
  for (const later of ['0.5', '0']) {
    const f = topup();
    addWindow(f.env);
    await f.sync();
    f.env.SUPPLIER_BUDGET_SHARE = later;
    f.charge.amount_refunded = 1000;
    await f.sync();
    assert.equal(windowById(f.env, 'operator').limit_micro, 9000000, later);
    f.charge.amount_refunded = 2000;
    await f.sync();
    assert.equal(windowById(f.env, 'operator').limit_micro, 0, later);
  }
});

test('a refund of a payment that added no share never reduces operator allowance', async () => {
  const f = topup({ share: '0' });
  addWindow(f.env, { limit: 5000000 });
  await f.sync();
  f.env.SUPPLIER_BUDGET_SHARE = '0.9';
  f.charge.amount_refunded = 2000;
  await f.sync();
  assert.equal(f.balance(), 0);
  assert.equal(windowById(f.env, 'operator').limit_micro, 5000000);
  assert.deepEqual(adjustments(f.env), []);
});

test('every provider with a sellable model receives the share; others receive nothing', async () => {
  const models = [runpodModel, infronModel, { ...orcaModel, enabled: false }];
  const f = topup({ models });
  assert.deepEqual(supplierBudgetProviders(f.env, models), ['runpod', 'infron']);
  await f.sync();
  assert.equal(automaticWindow(f.env, 'runpod').limit_micro, 18000000);
  assert.equal(automaticWindow(f.env, 'infron').limit_micro, 18000000);
  assert.equal(automaticWindow(f.env, 'orcarouter'), undefined);
  assert.deepEqual(adjustments(f.env).map((row) => row.provider).sort(), ['infron', 'runpod']);

  // A provider whose model stopped selling still gives back its share on refund.
  f.env.INFERENCE_MODELS = JSON.stringify([runpodModel]);
  f.charge.amount_refunded = 2000;
  await f.sync();
  assert.equal(automaticWindow(f.env, 'runpod').limit_micro, 0);
  assert.equal(automaticWindow(f.env, 'infron').limit_micro, 0);
});

test('a provider without a current cost rule is not funded', async () => {
  const f = topup({ models: [runpodModel, infronModel] });
  f.env.SUPPLIER_COST_RULES = JSON.stringify([rule(infronModel)]);
  await f.sync();
  assert.equal(automaticWindow(f.env, 'runpod'), undefined);
  assert.equal(automaticWindow(f.env, 'infron').limit_micro, 18000000);
});

test('a budget write failure rolls the customer credit back with it', async () => {
  const f = topup();
  f.env.DB.sqlite.exec("CREATE TRIGGER test_budget_failure BEFORE INSERT ON supplier_budget_adjustments BEGIN SELECT RAISE(ABORT, 'budget failure'); END");
  await assert.rejects(f.sync(), /budget failure/);
  assert.equal(f.balance(), 0);
  assert.deepEqual({ ...f.env.DB.sqlite.prepare('SELECT status, credited_micro, revision FROM api_topups').get() }, { status: 'pending', credited_micro: 0, revision: 0 });
  assert.deepEqual(windows(f.env), []);
  f.env.DB.sqlite.exec('DROP TRIGGER test_budget_failure');
  await f.sync();
  assert.equal(f.balance(), 20000000);
  assert.equal(automaticWindow(f.env).limit_micro, 18000000);
});

test('budget adjustments cannot be edited or deleted', async () => {
  const f = topup();
  await f.sync();
  assert.throws(() => f.env.DB.sqlite.exec('UPDATE supplier_budget_adjustments SET amount_micro = 1'), /supplier_budget_adjustment_immutable/);
  assert.throws(() => f.env.DB.sqlite.exec('DELETE FROM supplier_budget_adjustments'), /supplier_budget_adjustment_immutable/);
});

test('an automatic top-up adds the share when its verified payment succeeds, once', async () => {
  const f = topup();
  const charge = { ...f.charge, id: 'ch_auto', payment_intent: 'pi_auto' };
  const intent = { id: 'pi_auto', livemode: true, status: 'succeeded', currency: 'usd', amount: 2000, amount_received: 2000, customer: 'cus_1', payment_method: 'pm_1',
    latest_charge: charge, metadata: { app: 'bounty-operator-api', source: 'automatic', topup_id: 'auto-1', account_id: f.account } };
  f.env.DB.sqlite.prepare(`INSERT INTO api_topups(id, account_id, customer_id, payment_intent, amount_micro, source, auto_month, auto_revision, payment_method, initiated_at, created_at, updated_at)
    VALUES('auto-1', ?, 'cus_1', 'pi_auto', 20000000, 'automatic', '2026-10', 1, 'pm_1', 1, 1, 1)`).run(f.account);
  f.api.paymentIntents.retrieve = async () => structuredClone(intent);
  const event = { type: 'payment_intent.succeeded', created: now(), data: { object: intent } };
  await applyApiPaymentEvent(f.env, f.api, event);
  await applyApiPaymentEvent(f.env, f.api, event);
  assert.equal(f.balance(), 20000000);
  assert.equal(automaticWindow(f.env).limit_micro, 18000000);
  assert.deepEqual(adjustments(f.env).map((row) => row.source), ['topup:auto-1']);
});

/** A paid US$10 monthly Operator invoice that grants US$2 of API credit, as Stripe reports it. */
function monthly(options = {}) {
  const env = baseEnv({ ...options, overrides: { BILLING_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_PRICE_ID: 'price_monthly' } });
  const account = addAccount(env.DB);
  env.DB.sqlite.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ?').run('cus_1', account);
  const price = { id: 'price_monthly', livemode: true, currency: 'usd', unit_amount: 1000, type: 'recurring', billing_scheme: 'per_unit', transform_quantity: null,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } };
  const line = { livemode: true, invoice: 'in_m1', currency: 'usd', amount: 1000, subtotal: 1000, quantity: 1, quantity_decimal: '1',
    parent: { type: 'subscription_item_details', subscription_item_details: { proration: false, subscription: 'sub_m1' } }, subscription: 'sub_m1',
    pricing: { type: 'price_details', price_details: { price: 'price_monthly' }, unit_amount_decimal: '1000' }, discount_amounts: [], pretax_credit_amounts: [],
    period: { start: 1790899200, end: 1793577600 } };
  const invoice = { id: 'in_m1', livemode: true, status: 'paid', currency: 'usd', customer: 'cus_1', billing_reason: 'subscription_create',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_m1' } }, amount_due: 1000, amount_paid: 1000, amount_remaining: 0,
    subtotal: 1000, total: 1000, total_discount_amounts: [], total_pretax_credit_amounts: [], pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
    lines: { data: [line], has_more: false } };
  const charge = { id: 'ch_m1', livemode: true, status: 'succeeded', paid: true, captured: true, refunded: false, disputed: false, currency: 'usd', amount: 1000,
    amount_captured: 1000, amount_refunded: 0, customer: 'cus_1', payment_intent: 'pi_m1' };
  const disputes = [];
  const api = {
    invoices: { retrieve: async () => structuredClone(invoice) },
    prices: { retrieve: async () => structuredClone(price) },
    subscriptions: { retrieve: async () => ({ id: 'sub_m1', livemode: true, customer: 'cus_1', status: 'active' }) },
    invoicePayments: { list: async () => ({ data: [{ id: 'inpay_1', livemode: true, status: 'paid', currency: 'usd', invoice: 'in_m1', amount_paid: 1000,
      payment: { type: 'payment_intent', payment_intent: 'pi_m1' } }], has_more: false }) },
    paymentIntents: { retrieve: async () => ({ id: 'pi_m1', livemode: true, status: 'succeeded', currency: 'usd', amount_received: 1000, customer: 'cus_1', latest_charge: 'ch_m1' }) },
    charges: { retrieve: async () => structuredClone(charge) },
    disputes: { list: async () => ({ data: structuredClone(disputes), has_more: false }) },
  };
  return { env, account, api, charge, disputes, sync: (eventTime = 10) => syncMonthlyCredit(env, api, 'in_m1', eventTime) };
}

test('a monthly Operator credit grant adds the share once and a refund removes it', async () => {
  const m = monthly();
  await Promise.all([m.sync(), m.sync()]);
  await m.sync();
  assert.equal(automaticWindow(m.env).limit_micro, 1800000);
  assert.deepEqual(adjustments(m.env).map((row) => [row.ledger_id, row.source, row.amount_micro]), [['monthly:in_m1:1', 'monthly:in_m1', 1800000]]);
  m.charge.amount_refunded = 100;
  await syncMonthlyCreditForCharge(m.env, m.api, 'ch_m1', 20);
  await syncMonthlyCreditForCharge(m.env, m.api, 'ch_m1', 20);
  assert.equal(automaticWindow(m.env).limit_micro, 0);
  assert.equal(adjustments(m.env).length, 2);
});

test('customer-funded allowance left in an ended window carries into a current one; operator funding does not', async () => {
  const f = topup();
  addWindow(f.env, { id: 'first', limit: 5000000 });
  await f.sync();
  // 23 in the window: 5 from the operator, 18 from the payment. 7 is spent
  // and 1 is held for a running request, so 15 can carry.
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = 7000000, reserved_micro = 1000000, ends_at = ? WHERE id = 'first'").run(now() - 1);
  assert.equal(await sweepSupplierBudgets(f.env, ['runpod']), 2);
  const next = automaticWindow(f.env);
  assert.equal(next.limit_micro, 15000000);
  assert.equal(next.enabled, 1);
  assert.equal(windowById(f.env, 'first').limit_micro, 8000000);
  assert.equal(await sweepSupplierBudgets(f.env, ['runpod']), 0, 'a second sweep moves nothing');
  const carry = adjustments(f.env).at(-1);
  assert.deepEqual([carry.kind, carry.from_window_id, carry.window_id, carry.amount_micro], ['carry', 'first', next.id, 15000000]);

  // The held request is released later: that allowance carries too. The 7
  // spent comes out of the operator's 5 first, so 16 of the 18 moved in all.
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET reserved_micro = 0 WHERE id = 'first'").run();
  assert.equal(await sweepSupplierBudgets(f.env, ['runpod']), 1);
  assert.equal(automaticWindow(f.env).limit_micro, 16000000);
  assert.equal(windowById(f.env, 'first').limit_micro, 7000000);

  // A window that held only operator funding passes nothing on.
  const operatorOnly = baseEnv();
  addWindow(operatorOnly, { id: 'operator-only', starts: now() - 2 * DAY, ends: now() - 1, limit: 5000000 });
  assert.equal(await sweepSupplierBudgets(operatorOnly, ['runpod']), 0);
  assert.equal(windows(operatorOnly).length, 1);
  // A share of 0 turns the sweep off.
  f.env.SUPPLIER_BUDGET_SHARE = '0';
  assert.equal(await sweepSupplierBudgets(f.env, ['runpod']), 0);
});

test('a refund after the window ended takes its share from that window and opens none', async () => {
  const f = topup();
  addWindow(f.env, { id: 'first' });
  await f.sync();
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET ends_at = ? WHERE id = 'first'").run(now() - 1);
  f.charge.amount_refunded = 1000;
  await f.sync();
  // A removal does not sweep: carrying first and taking it back afterwards
  // would leave an automatic window of 0 standing in the way for 30 days.
  assert.equal(automaticWindow(f.env), undefined);
  assert.equal(windowById(f.env, 'first').limit_micro, 9000000);
  const removal = adjustments(f.env).at(-1);
  assert.deepEqual([removal.window_id, removal.requested_micro, removal.amount_micro], ['first', -9000000, -9000000]);
  // What the payment still funds carries on the next credit or scheduled run.
  assert.equal(await sweepSupplierBudgets(f.env, ['runpod']), 2);
  assert.equal(automaticWindow(f.env).limit_micro, 9000000);
  assert.equal(windowById(f.env, 'first').limit_micro, 0);
});

test('a request after its window ended rolls customer allowance over and is admitted', async () => {
  const f = topup();
  addWindow(f.env, { id: 'first' });
  await f.sync();
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET ends_at = ? WHERE id = 'first'").run(now() - 1);
  f.env.DB.sqlite.prepare(`INSERT INTO inference_keys(id, account_id, token_hash, prefix, label, budget_micro, created_at, expires)
    VALUES('key', ?, 'hash', 'prefix', 'test', 1000000, ?, ?)`).run(f.account, now(), now() + 3600);
  const id = await reserveInference(f.env, { id: 'key', account_id: f.account }, runpodModel, 20, null);
  const next = automaticWindow(f.env);
  assert.equal(f.env.DB.sqlite.prepare('SELECT budget_id FROM supplier_commitments WHERE request_id = ?').get(id).budget_id, next.id);
  assert.equal(next.limit_micro, 18000000);
  assert.equal(next.reserved_micro, 1000);
});

test('the 15-minute scheduled run sweeps ended windows for providers with sellable models', async (t) => {
  t.mock.method(console, 'log', () => {});
  const f = topup();
  addWindow(f.env, { id: 'first' });
  await f.sync();
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET ends_at = ? WHERE id = 'first'").run(now() - 1);
  await worker.scheduled({ cron: '*/15 * * * *' }, f.env, createContext());
  assert.equal(automaticWindow(f.env).limit_micro, 18000000);
  assert.equal(console.log.mock.calls[0].arguments[1].supplierBudgetsSwept, 2);
});

test('the operating report lists budget additions, removals and carries for its window', async () => {
  const f = topup();
  addWindow(f.env, { id: 'first' });
  await f.sync();
  f.charge.amount_refunded = 500;
  await f.sync();
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET ends_at = ? WHERE id = 'first'").run(now() - 1);
  await sweepSupplierBudgets(f.env, ['runpod']);
  const report = await supplierOperatingReport(f.env, now() - DAY, now() + DAY);
  assert.deepEqual(report.budget_adjustments.map((row) => ({ ...row })), [
    { provider: 'runpod', kind: 'carry', entries: 1, added_micro: 13500000, removed_micro: 0 },
    { provider: 'runpod', kind: 'customer_credit', entries: 2, added_micro: 18000000, removed_micro: 4500000 },
  ]);
  assert.deepEqual((await supplierOperatingReport(f.env, now() + DAY, now() + 2 * DAY)).budget_adjustments, []);
});

test('health reports a database that has not applied the budget migration', async () => {
  const env = baseEnv();
  const health = async () => {
    const response = await worker.fetch(new Request(`${env.SITE_ORIGIN}/api/health`), env, createContext());
    return [response.status, (await response.json()).db];
  };
  assert.deepEqual(await health(), [200, 'ok']);
  env.DB.sqlite.exec('DROP TABLE supplier_budget_adjustments');
  assert.deepEqual(await health(), [503, 'error']);
});

// A won dispute gives back only what its dispute took, and a removal finds the
// payment's allowance wherever it sits.

test('a dispute opened after usage and then won gives back only what the dispute removed', async () => {
  const f = topup();
  addWindow(f.env);
  await f.sync(1);
  // Requests consumed 16 of the 18 the payment funded, so the dispute can take only 2.
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = 16000000 WHERE id = 'operator'").run();
  f.charge.disputed = true;
  f.disputes.push({ status: 'needs_response' });
  await f.sync(20);
  assert.equal(windowById(f.env, 'operator').limit_micro, 16000000);
  f.disputes[0].status = 'won';
  await f.sync(30);
  assert.equal(f.balance(), 20000000);
  // The payment funded 18 in all: 16 spent and 2 left, not 18 more.
  assert.equal(windowById(f.env, 'operator').limit_micro, 18000000);
  assert.deepEqual(adjustments(f.env).map((row) => row.amount_micro), [18000000, -2000000, 2000000]);
  const won = adjustments(f.env).at(-1);
  assert.deepEqual([won.ledger_id, won.share_ppm, won.requested_micro], ['topup:topup-1:3', 900000, 18000000]);
  // A later resync of the won dispute adds nothing.
  await f.sync(40);
  assert.equal(adjustments(f.env).length, 3);
});

test('a won dispute restores at the original share, and a payment that funded nothing gets nothing back', async () => {
  const f = topup();
  addWindow(f.env);
  await f.sync(1);
  f.charge.disputed = true;
  f.disputes.push({ status: 'needs_response' });
  await f.sync(20);
  f.env.SUPPLIER_BUDGET_SHARE = '1';
  f.disputes[0].status = 'won';
  await f.sync(30);
  assert.equal(windowById(f.env, 'operator').limit_micro, 18000000, 'not 20 at the new share');

  // Credited while automatic funding was off: the dispute takes nothing and its win adds nothing.
  const off = topup({ share: '0' });
  await off.sync(1);
  off.env.SUPPLIER_BUDGET_SHARE = '0.9';
  off.charge.disputed = true;
  off.disputes.push({ status: 'needs_response' });
  await off.sync(20);
  off.disputes[0].status = 'won';
  await off.sync(30);
  assert.equal(off.balance(), 20000000);
  assert.deepEqual(windows(off.env), []);
  assert.deepEqual(adjustments(off.env), []);
});

test('a won dispute gives nothing to a provider that started selling after the payment', async () => {
  const f = topup();
  await f.sync(1);
  f.charge.disputed = true;
  f.disputes.push({ status: 'needs_response' });
  await f.sync(20);
  f.env.INFERENCE_MODELS = JSON.stringify([runpodModel, infronModel]);
  f.env.SUPPLIER_COST_RULES = JSON.stringify([rule(runpodModel), rule(infronModel)]);
  f.disputes[0].status = 'won';
  await f.sync(30);
  assert.equal(automaticWindow(f.env, 'runpod').limit_micro, 18000000);
  assert.equal(automaticWindow(f.env, 'infron'), undefined);
  assert.deepEqual(adjustments(f.env).map((row) => row.provider), ['runpod', 'runpod', 'runpod']);
});

test('a monthly grant disputed after usage and then won gives back only what the dispute removed', async () => {
  const m = monthly();
  await m.sync(10);
  const id = automaticWindow(m.env).id;
  m.env.DB.sqlite.prepare('UPDATE supplier_budget_windows SET consumed_micro = 1500000 WHERE id = ?').run(id);
  m.charge.disputed = true;
  m.disputes.push({ charge: 'ch_m1', livemode: true, status: 'needs_response' });
  await m.sync(20);
  assert.equal(windowById(m.env, id).limit_micro, 1500000);
  m.disputes[0].status = 'won';
  await m.sync(30);
  assert.equal(windowById(m.env, id).limit_micro, 1800000);
  assert.deepEqual(adjustments(m.env).map((row) => row.amount_micro), [1800000, -300000, 300000]);
});

test('a refund finds the allowance in an ended window while the share is 0, so a later carry cannot bring it back', async () => {
  const f = topup();
  addWindow(f.env, { id: 'first' });
  await f.sync();
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET ends_at = ? WHERE id = 'first'").run(now() - 1);
  f.env.SUPPLIER_BUDGET_SHARE = '0';
  f.charge.amount_refunded = 2000;
  await f.sync();
  assert.equal(windowById(f.env, 'first').limit_micro, 0);
  const removal = adjustments(f.env).at(-1);
  assert.deepEqual([removal.window_id, removal.requested_micro, removal.amount_micro], ['first', -18000000, -18000000]);
  // Funding back on: nothing is left to carry, so no window opens.
  f.env.SUPPLIER_BUDGET_SHARE = '0.9';
  assert.equal(await sweepSupplierBudgets(f.env, ['runpod']), 0);
  assert.deepEqual(windows(f.env).map((row) => row.id), ['first']);
});

test('a refund while the provider is not sellable still takes the allowance from the ended window', async () => {
  for (const stop of ['lapsed cost rule', 'disabled model']) {
    const f = topup();
    addWindow(f.env, { id: 'first' });
    await f.sync();
    f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET ends_at = ? WHERE id = 'first'").run(now() - 1);
    const live = { rules: f.env.SUPPLIER_COST_RULES, models: f.env.INFERENCE_MODELS };
    if (stop === 'lapsed cost rule') f.env.SUPPLIER_COST_RULES = JSON.stringify([{ ...rule(runpodModel), validUntil: now() - 10 }]);
    else f.env.INFERENCE_MODELS = JSON.stringify([{ ...runpodModel, enabled: false }]);
    assert.deepEqual(supplierBudgetProviders(f.env, JSON.parse(f.env.INFERENCE_MODELS)), [], stop);
    f.charge.amount_refunded = 2000;
    await f.sync();
    // The rule is renewed or the model comes back.
    f.env.SUPPLIER_COST_RULES = live.rules;
    f.env.INFERENCE_MODELS = live.models;
    assert.equal(await sweepSupplierBudgets(f.env, ['runpod']), 0, stop);
    assert.equal(windowById(f.env, 'first').limit_micro, 0, stop);
    assert.equal(automaticWindow(f.env), undefined, stop);
  }
});

test('a refund never takes operator funding, and records 0 when the payment’s allowance is spent', async () => {
  const f = topup();
  addWindow(f.env, { id: 'first' });
  await f.sync();
  // The window ends with the payment's 18 unspent. Funding is off, and the
  // operator funds the next window with 5.
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET ends_at = ? WHERE id = 'first'").run(now() - 1);
  f.env.SUPPLIER_BUDGET_SHARE = '0';
  addWindow(f.env, { id: 'next', starts: now() - 1, ends: now() + DAY, limit: 5000000 });
  f.charge.amount_refunded = 1000;
  await f.sync();
  assert.equal(windowById(f.env, 'next').limit_micro, 5000000);
  assert.equal(windowById(f.env, 'first').limit_micro, 9000000);

  // Spent allowance cannot be taken back: one row of 0, against no window.
  const spent = topup();
  addWindow(spent.env, { limit: 5000000 });
  await spent.sync();
  spent.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = 23000000 WHERE id = 'operator'").run();
  spent.charge.amount_refunded = 2000;
  await spent.sync();
  const last = adjustments(spent.env).at(-1);
  assert.deepEqual([last.id, last.window_id, last.requested_micro, last.amount_micro], ['topup:topup-1:2:runpod', null, -18000000, 0]);
  assert.equal(windowById(spent.env, 'operator').limit_micro, 23000000);
});

test('a removal spread over several windows takes from each, one row per window, and is applied once', async () => {
  const f = topup();
  addWindow(f.env, { id: 'first' });
  await f.sync();
  // The window ends while a running request holds 1 of the payment's 18, so 17 carry.
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET reserved_micro = 1000000, ends_at = ? WHERE id = 'first'").run(now() - 1);
  assert.equal(await sweepSupplierBudgets(f.env, ['runpod']), 2);
  const next = automaticWindow(f.env).id;
  assert.equal(windowById(f.env, next).limit_micro, 17000000);
  // Funding stops, then the hold is released: that 1 waits in the ended window.
  f.env.SUPPLIER_BUDGET_SHARE = '0';
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET reserved_micro = 0 WHERE id = 'first'").run();
  f.charge.amount_refunded = 2000;
  await f.sync();
  assert.equal(windowById(f.env, 'first').limit_micro, 0);
  assert.equal(windowById(f.env, next).limit_micro, 0);
  const rows = adjustments(f.env).filter((row) => row.ledger_id === 'topup:topup-1:2');
  assert.deepEqual(rows.map((row) => [row.id, row.window_id, row.requested_micro, row.amount_micro]), [
    ['topup:topup-1:2:runpod', 'first', -18000000, -1000000],
    ['topup:topup-1:2:runpod:2', next, -18000000, -17000000],
  ]);
  // Replaying either entry, as a batch that lost its revision race does, writes nothing.
  f.env.SUPPLIER_BUDGET_SHARE = '0.9';
  const count = adjustments(f.env).length;
  for (const [ledgerId, deltaMicro] of [['topup:topup-1:1', 20000000], ['topup:topup-1:2', -20000000]]) {
    await f.env.DB.batch(supplierBudgetCreditStatements(f.env, [runpodModel], { ledgerId, source: 'topup:topup-1', deltaMicro }));
  }
  assert.equal(adjustments(f.env).length, count);
  assert.equal(windowById(f.env, next).limit_micro, 0);
  // Every customer-credit row's id names its ledger entry and provider.
  assert.throws(() => f.env.DB.sqlite.prepare(`INSERT INTO supplier_budget_adjustments(id, kind, provider, window_id, ledger_id, source, customer_micro, share_ppm, requested_micro, amount_micro, created_at)
    VALUES('other', 'customer_credit', 'runpod', NULL, 'topup:topup-1:9', 'topup:topup-1', 1, 900000, 0, 0, 1)`).run(), /CHECK constraint failed/);
});

test('a pause lasts until its disabled window ends; then sales resume with the allowance it held', async () => {
  const f = topup();
  addWindow(f.env, { id: 'paused', enabled: 0 });
  await f.sync();
  f.env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET ends_at = ? WHERE id = 'paused'").run(now() - 1);
  assert.equal(await sweepSupplierBudgets(f.env, ['runpod']), 2);
  const resumed = automaticWindow(f.env);
  assert.deepEqual([resumed.enabled, resumed.limit_micro], [1, 18000000]);
  assert.equal(windowById(f.env, 'paused').limit_micro, 0);
});

test('operator funding beside an automatic window: raise its limit, or start a window where it ends', async () => {
  const f = topup();
  await f.sync();
  const auto = automaticWindow(f.env);
  // An enabled window overlapping the automatic one is refused.
  assert.throws(() => addWindow(f.env, { id: 'manual', starts: now(), ends: now() + 10 * DAY, limit: 5000000 }), /supplier_budget_overlap/);
  addWindow(f.env, { id: 'after', starts: auto.ends_at, ends: auto.ends_at + TERM, limit: 5000000 });
  // A raised limit is operator funding: spent first, and it ends with its window.
  f.env.DB.sqlite.prepare('UPDATE supplier_budget_windows SET limit_micro = limit_micro + 5000000, consumed_micro = 4000000 WHERE id = ?').run(auto.id);
  f.env.DB.sqlite.prepare('UPDATE supplier_budget_windows SET starts_at = ?, ends_at = ? WHERE id = ?').run(now() - DAY, now() - 1, auto.id);
  assert.equal(await sweepSupplierBudgets(f.env, ['runpod']), 2);
  const next = windows(f.env).find((row) => row.funding_reference.startsWith('automatic') && row.id !== auto.id);
  assert.deepEqual([next.limit_micro, next.ends_at], [18000000, auto.ends_at]);
  const ended = windowById(f.env, auto.id);
  assert.equal(ended.limit_micro - ended.consumed_micro, 1000000, 'the operator’s unspent 1 stays behind');
});

test('the scheduled run logs the share in force, warns once about an unusable value, and names models that fund less than they use', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const affordable = { ...runpodModel, id: 'budget-affordable', upstreamModel: 'budget-affordable', minimumMicro: 1200 };
  const thin = { ...infronModel, id: 'budget-thin', upstreamModel: 'test/budget-thin', outputRate: 1 };
  const models = [runpodModel, affordable, infronModel, thin, { ...orcaModel, enabled: false }];
  const env = baseEnv({ models });
  // At 0.9: a 10 minimum funds 9 of a 1,000 hold (1,200 funds 1,080), and a
  // US$1 output rate funds US$0.90 of the supplier's US$1.
  assert.deepEqual(supplierShareShortfalls(env, models), ['budget-runpod', 'budget-thin']);
  const cron = () => worker.scheduled({ cron: '*/15 * * * *' }, env, createContext());
  await cron();
  const first = console.log.mock.calls[0].arguments[1];
  assert.deepEqual([first.supplierBudgetSharePpm, first.supplierShareShortfall], [900000, ['budget-runpod', 'budget-thin']]);
  assert.equal(console.warn.mock.callCount(), 0);

  env.SUPPLIER_BUDGET_SHARE = '0,9';
  await cron();
  await cron();
  assert.equal(console.warn.mock.callCount(), 1, 'once for each value');
  assert.deepEqual(console.warn.mock.calls[0].arguments, ['SUPPLIER_BUDGET_SHARE is not a decimal from 0 to 1', { problem: 'unreadable', sharePpm: 0 }]);
  const off = console.log.mock.calls.at(-1).arguments[1];
  assert.equal(off.supplierBudgetSharePpm, 0);
  assert.equal(Object.hasOwn(off, 'supplierShareShortfall'), false, 'with funding off nothing is funded short');
  env.SUPPLIER_BUDGET_SHARE = '1.5';
  await cron();
  assert.deepEqual(console.warn.mock.calls[1].arguments[1], { problem: 'out_of_range', sharePpm: 1000000 });
  for (const value of [undefined, '', '0', '0.9', '1']) assert.equal(supplierBudgetShareProblem({ SUPPLIER_BUDGET_SHARE: value }), null, String(value));
});
