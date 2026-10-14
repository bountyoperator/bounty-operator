import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reserveInference, settleInference, reapInferenceHolds } from '../src/api-credits.ts';
import { markSupplierDispatched, quoteSupplierCommitment, supplierAvailability, supplierTokenCost, reconcileRunpodBilling, supplierOperatingReport } from '../src/supplier-costs.ts';
import { addAccount, createEnv } from './worker-helpers.mjs';

const now = () => Math.floor(Date.now() / 1000);
const model = { id: 'supplier-test', endpoint: 'https://supplier123.api.runpod.ai', upstreamModel: 'served-test', context: 100, maxOutput: 20, inputRate: 2, outputRate: 8, minimumMicro: 10 };
const runtimeRule = () => ({ model: model.id, endpoint: model.endpoint, upstreamModel: model.upstreamModel, provider: 'runpod', resourceId: 'supplier123', basis: 'runtime_allowance', holdMicro: 1000, revision: 'operator-allowance-test', source: 'https://fixtures.invalid/runpod-pricing', validUntil: now() + 3600 });
function setup({ budget = 10000, balance = 50000, rules = [runtimeRule()], provider = 'runpod' } = {}) {
  const env = createEnv({ SUPPLIER_COST_RULES: JSON.stringify(rules), RUNPOD_API_KEY: 'test-only' });
  const account = addAccount(env.DB);
  env.DB.sqlite.prepare(`INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES('fund', ?, ?, 'topup', 'test-only', ?)`).run(account, balance, now());
  env.DB.sqlite.prepare(`INSERT INTO inference_keys(id, account_id, token_hash, prefix, label, budget_micro, created_at, expires)
    VALUES('key', ?, 'hash', 'prefix', 'test', 1000000, ?, ?)`).run(account, now(), now() + 3600);
  if (budget !== null) env.DB.sqlite.prepare(`INSERT INTO supplier_budget_windows(id, provider, starts_at, ends_at, limit_micro, enabled, funding_reference, updated_at)
    VALUES('budget', ?, ?, ?, ?, 1, 'fixture-only', ?)`).run(provider, now() - 10, now() + 3600, budget, now());
  return { env, key: { id: 'key', account_id: account }, account };
}
const row = (env, table) => env.DB.sqlite.prepare(`SELECT * FROM ${table}`).get();
const reserve = (fixture, selected = model, idem = null) => reserveInference(fixture.env, fixture.key, selected, 20, idem);

test('supplier money math uses integer rational prices and ceiling rounding', () => {
  assert.equal(supplierTokenCost(10, 2, 750000, 12500000), 33);
  assert.equal(supplierTokenCost(1000000, 1000000, 113200, 452400, 7), 565607);
  assert.throws(() => supplierTokenCost(1, 1, -1, 1), /unavailable/);
  assert.throws(() => supplierTokenCost(Number.MAX_SAFE_INTEGER, 1, 1, 1), /unavailable/);
});

test('missing, stale, wrong-route, duplicate, invalid and unsupported quotes fail before reservation', async () => {
  const cases = [undefined, 'invalid json', '[]', JSON.stringify([{ ...runtimeRule(), validUntil: now() }]),
    JSON.stringify([{ ...runtimeRule(), endpoint: 'https://other123.api.runpod.ai' }]),
    JSON.stringify([runtimeRule(), runtimeRule()]), JSON.stringify([{ ...runtimeRule(), holdMicro: 0 }]),
    JSON.stringify([{ ...runtimeRule(), provider: 'unknown' }]), JSON.stringify([{ ...runtimeRule(), source: 'http://fixtures.invalid' }])];
  for (const rules of cases) {
    const fixture = setup();
    fixture.env.SUPPLIER_COST_RULES = rules;
    await assert.rejects(reserve(fixture), { code: 'supplier_unavailable' });
    assert.equal(row(fixture.env, 'inference_requests'), undefined);
    assert.equal(row(fixture.env, 'api_wallets').reserved_micro, 0);
    assert.equal(row(fixture.env, 'supplier_commitments'), undefined);
  }
});

test('missing, disabled, empty and expired funding all fail closed and roll back the customer hold', async () => {
  for (const state of ['missing', 'disabled', 'empty', 'expired']) {
    const fixture = setup({ budget: state === 'missing' ? null : state === 'empty' ? 0 : 10000 });
    if (state === 'disabled') fixture.env.DB.sqlite.exec('UPDATE supplier_budget_windows SET enabled = 0');
    if (state === 'expired') fixture.env.DB.sqlite.prepare('UPDATE supplier_budget_windows SET ends_at = ?').run(now() - 1);
    await assert.rejects(reserve(fixture), { code: 'supplier_unavailable' });
    assert.equal(row(fixture.env, 'inference_requests'), undefined);
    assert.equal(row(fixture.env, 'supplier_commitments'), undefined);
    assert.equal(row(fixture.env, 'api_wallets').reserved_micro, 0);
    assert.equal(row(fixture.env, 'inference_keys').reserved_micro, 0);
  }
});

test('concurrent admissions cannot overbook the durable supplier allowance', async () => {
  const fixture = setup({ budget: 1500 });
  const result = await Promise.allSettled([reserve(fixture), reserve(fixture)]);
  assert.equal(result.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(result.find((item) => item.status === 'rejected').reason.code, 'supplier_budget_exhausted');
  assert.equal(row(fixture.env, 'supplier_budget_windows').reserved_micro, 1000);
  assert.equal(fixture.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM inference_requests').get().n, 1);
  assert.equal(row(fixture.env, 'api_wallets').reserved_micro, 360);
  assert.equal(row(fixture.env, 'inference_keys').reserved_micro, 360);
});

test('customer rejection leaves the supplier allowance untouched', async () => {
  const fixture = setup({ balance: 359 });
  await assert.rejects(reserve(fixture), { code: 'insufficient_quota' });
  assert.equal(row(fixture.env, 'supplier_commitments'), undefined);
  assert.equal(row(fixture.env, 'supplier_budget_windows').reserved_micro, 0);
});

test('idempotency replays cannot duplicate either hold', async () => {
  const fixture = setup();
  await reserve(fixture, model, 'one-request');
  await assert.rejects(reserve(fixture, model, 'one-request'), { code: 'idempotency_conflict' });
  assert.equal(row(fixture.env, 'supplier_budget_windows').reserved_micro, 1000);
  assert.equal(row(fixture.env, 'api_wallets').reserved_micro, 360);
});

test('predispatch failure releases both reservations and cannot later be dispatched', async () => {
  const fixture = setup();
  const id = await reserve(fixture);
  await settleInference(fixture.env, id, 'failed', null, 'validation_failed');
  assert.equal(row(fixture.env, 'supplier_commitments').state, 'released');
  assert.equal(row(fixture.env, 'supplier_budget_windows').reserved_micro, 0);
  assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 0);
  assert.equal(row(fixture.env, 'api_wallets').balance_micro, 50000);
  await assert.rejects(markSupplierDispatched(fixture.env, id), { code: 'supplier_unavailable' });
});

test('dispatch is one-way and consumes allowance even if no customer usage can be confirmed', async () => {
  const fixture = setup({ budget: 1000 });
  const id = await reserve(fixture);
  await markSupplierDispatched(fixture.env, id);
  await assert.rejects(markSupplierDispatched(fixture.env, id), { code: 'supplier_unavailable' });
  await settleInference(fixture.env, id, 'cancelled', null, 'unmetered_stream');
  assert.equal(row(fixture.env, 'supplier_commitments').state, 'consumed');
  assert.equal(row(fixture.env, 'supplier_commitments').estimated_cost_micro, null);
  assert.equal(row(fixture.env, 'supplier_budget_windows').reserved_micro, 0);
  assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 1000);
  assert.equal(row(fixture.env, 'api_wallets').balance_micro, 50000);
  await assert.rejects(reserve(fixture), { code: 'supplier_budget_exhausted' });
});

test('a revoked allowance or expired quote cannot dispatch an existing reservation', async () => {
  for (const state of ['disabled', 'quote_expired', 'request_expired']) {
    const fixture = setup();
    const id = await reserve(fixture);
    if (state === 'disabled') fixture.env.DB.sqlite.exec('UPDATE supplier_budget_windows SET enabled = 0');
    if (state === 'quote_expired') fixture.env.DB.sqlite.prepare('UPDATE supplier_commitments SET valid_until = ?').run(now());
    if (state === 'request_expired') fixture.env.DB.sqlite.prepare('UPDATE inference_requests SET lease_until = ?').run(now());
    await assert.rejects(markSupplierDispatched(fixture.env, id), { code: 'supplier_unavailable' });
    await settleInference(fixture.env, id, 'failed', null);
    assert.equal(row(fixture.env, 'supplier_commitments').state, 'released');
  }
});

test('direct token settlement uses pinned maximum supplier rates and retains unknown failure costs', async () => {
  const direct = { ...model, endpoint: 'https://api.infron.ai' };
  const rule = { ...runtimeRule(), endpoint: direct.endpoint, provider: 'infron', resourceId: direct.upstreamModel, basis: 'token_rate', inputMicroPerMillion: 750000, outputMicroPerMillion: 12500000, fixedMicro: 0 };
  const fixture = setup({ rules: [rule], provider: 'infron', budget: 1000 });
  assert.equal(quoteSupplierCommitment(fixture.env, direct, 20).holdMicro, 325);
  const id = await reserve(fixture, direct);
  await markSupplierDispatched(fixture.env, id);
  fixture.env.SUPPLIER_COST_RULES = '[]'; // changing current pricing never changes an admitted request
  await settleInference(fixture.env, id, 'completed', { input: 10, output: 2 }, null, true);
  assert.equal(row(fixture.env, 'supplier_commitments').estimated_cost_micro, 33);
  assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 33);
  assert.equal(row(fixture.env, 'api_wallets').balance_micro, 50000 - 36);
  fixture.env.SUPPLIER_COST_RULES = JSON.stringify([rule]);
  const failed = await reserve(fixture, direct);
  await markSupplierDispatched(fixture.env, failed);
  await settleInference(fixture.env, failed, 'failed', null);
  assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 33 + 325);
});

test('above-hold confirmed usage is retained and customer payment is capped at the authorized hold', async () => {
  const fixture = setup();
  const id = await reserve(fixture);
  await markSupplierDispatched(fixture.env, id);
  await settleInference(fixture.env, id, 'completed', { input: 1000, output: 20 });
  const request = row(fixture.env, 'inference_requests');
  assert.equal(request.charge_micro, 360);
  assert.equal(request.input_tokens, 1000);
  assert.equal(request.output_tokens, 20);
  assert.equal(request.failure_code, 'usage_limit_exceeded');
  await settleInference(fixture.env, id, 'completed', { input: 1000, output: 20 });
  assert.equal(row(fixture.env, 'api_wallets').balance_micro, 50000 - 360);
  assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 1000);
});

test('partial or unconfirmed terminal usage cannot release a dispatched supplier allowance', async () => {
  const direct = { ...model, endpoint: 'https://api.infron.ai' };
  const rule = { ...runtimeRule(), endpoint: direct.endpoint, provider: 'infron', resourceId: direct.upstreamModel, basis: 'token_rate', inputMicroPerMillion: 750000, outputMicroPerMillion: 12500000, fixedMicro: 0 };
  for (const [status, terminal] of [['cancelled', false], ['failed', false], ['completed', false], ['cancelled', true]]) {
    const fixture = setup({ rules: [rule], provider: 'infron' });
    const id = await reserve(fixture, direct);
    await markSupplierDispatched(fixture.env, id);
    await settleInference(fixture.env, id, status, { input: 10, output: 2 }, 'interrupted', terminal);
    assert.equal(row(fixture.env, 'supplier_commitments').estimated_cost_micro, 33);
    assert.equal(row(fixture.env, 'supplier_commitments').expense_micro, 325);
    assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 325);
    assert.equal(row(fixture.env, 'api_wallets').balance_micro, 50000 - 36);
    // Replaying with final counters cannot reopen the already settled hold.
    await settleInference(fixture.env, id, 'completed', { input: 10, output: 2 }, null, true);
    assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 325);
  }
});

test('unrepresentable supplier usage cannot prevent capped customer settlement', async () => {
  const direct = { ...model, endpoint: 'https://api.infron.ai' };
  const rule = { ...runtimeRule(), endpoint: direct.endpoint, provider: 'infron', resourceId: direct.upstreamModel, basis: 'token_rate', inputMicroPerMillion: 750000, outputMicroPerMillion: 12500000 };
  const fixture = setup({ rules: [rule], provider: 'infron' });
  const id = await reserve(fixture, direct);
  await markSupplierDispatched(fixture.env, id);
  await settleInference(fixture.env, id, 'completed', { input: 1000000000001, output: 1 }, null, true);
  assert.equal(row(fixture.env, 'inference_requests').charge_micro, 360);
  assert.equal(row(fixture.env, 'inference_requests').input_tokens, 1000000000001);
  assert.equal(row(fixture.env, 'inference_requests').failure_code, 'usage_limit_exceeded');
  assert.equal(row(fixture.env, 'supplier_commitments').estimated_cost_micro, null);
  assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 325);
});

test('supplier estimates above an allowance are recorded and prevent further admission', async () => {
  const direct = { ...model, endpoint: 'https://api.infron.ai' };
  const rule = { ...runtimeRule(), endpoint: direct.endpoint, provider: 'infron', resourceId: direct.upstreamModel, basis: 'token_rate', inputMicroPerMillion: 1000000, outputMicroPerMillion: 1000000 };
  const fixture = setup({ rules: [rule], provider: 'infron', budget: 120 });
  const id = await reserve(fixture, direct);
  await markSupplierDispatched(fixture.env, id);
  await settleInference(fixture.env, id, 'completed', { input: 200, output: 20 }, null, true);
  assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 220);
  await assert.rejects(reserve(fixture, direct), { code: 'supplier_budget_exhausted' });
});

test('unexpected earlier supplier costs prevent dispatch of another reserved request', async () => {
  const direct = { ...model, endpoint: 'https://api.infron.ai' };
  const rule = { ...runtimeRule(), endpoint: direct.endpoint, provider: 'infron', resourceId: direct.upstreamModel, basis: 'token_rate', inputMicroPerMillion: 1000000, outputMicroPerMillion: 1000000 };
  const fixture = setup({ rules: [rule], provider: 'infron', budget: 240 });
  const first = await reserve(fixture, direct);
  const second = await reserve(fixture, direct);
  await markSupplierDispatched(fixture.env, first);
  await settleInference(fixture.env, first, 'completed', { input: 300, output: 20 }, null, true);
  await assert.rejects(markSupplierDispatched(fixture.env, second), { code: 'supplier_unavailable' });
  await settleInference(fixture.env, second, 'failed', null);
  assert.equal(row(fixture.env, 'supplier_budget_windows').reserved_micro, 0);
  assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 320);
});

test('a supplier settlement failure rolls the customer settlement back as well', async () => {
  const fixture = setup();
  const id = await reserve(fixture);
  await markSupplierDispatched(fixture.env, id);
  fixture.env.DB.sqlite.exec("CREATE TRIGGER test_failure BEFORE UPDATE OF state ON supplier_commitments BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(settleInference(fixture.env, id, 'completed', { input: 10, output: 2 }), /test failure/);
  assert.equal(row(fixture.env, 'inference_requests').status, 'running');
  assert.equal(row(fixture.env, 'api_wallets').balance_micro, 50000);
  assert.equal(row(fixture.env, 'api_wallets').reserved_micro, 360);
  assert.equal(row(fixture.env, 'supplier_budget_windows').reserved_micro, 1000);
});

test('lease cleanup releases undispatched costs but retains dispatched costs and is idempotent', async () => {
  const fixture = setup();
  const pending = await reserve(fixture);
  const dispatched = await reserve(fixture);
  await markSupplierDispatched(fixture.env, dispatched);
  fixture.env.DB.sqlite.prepare('UPDATE inference_requests SET lease_until = ?').run(now() - 1);
  assert.equal(await reapInferenceHolds(fixture.env, now()), 2);
  assert.equal(await reapInferenceHolds(fixture.env, now()), 0);
  assert.equal(fixture.env.DB.sqlite.prepare('SELECT state FROM supplier_commitments WHERE request_id = ?').get(pending).state, 'released');
  assert.equal(fixture.env.DB.sqlite.prepare('SELECT state FROM supplier_commitments WHERE request_id = ?').get(dispatched).state, 'consumed');
  assert.equal(row(fixture.env, 'supplier_budget_windows').reserved_micro, 0);
  assert.equal(row(fixture.env, 'supplier_budget_windows').consumed_micro, 1000);
  assert.equal(row(fixture.env, 'api_wallets').reserved_micro, 0);
  await assert.rejects(markSupplierDispatched(fixture.env, pending), { code: 'supplier_unavailable' });
});

test('overlapping enabled windows cannot accidentally multiply supplier capital', () => {
  const fixture = setup();
  const insert = fixture.env.DB.sqlite.prepare(`INSERT INTO supplier_budget_windows(id, provider, starts_at, ends_at, limit_micro, enabled, funding_reference, updated_at)
    VALUES('other', 'runpod', ?, ?, 50000, ?, 'fixture', ?)`);
  assert.throws(() => insert.run(now(), now() + 100, 1, now()), /supplier_budget_overlap/);
  insert.run(now(), now() + 100, 0, now());
  assert.throws(() => fixture.env.DB.sqlite.exec("UPDATE supplier_budget_windows SET enabled = 1 WHERE id = 'other'"), /supplier_budget_overlap/);
});

test('availability is read-only and distinguishes unavailable funding from exhausted allowance', async (t) => {
  const fixture = setup({ budget: 1000 });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('availability cannot warm a worker'); });
  assert.deepEqual(await supplierAvailability(fixture.env, [model]), { [model.id]: { available: true, code: 'available' } });
  await reserve(fixture);
  assert.deepEqual(await supplierAvailability(fixture.env, [model]), { [model.id]: { available: false, code: 'supplier_budget_exhausted' } });
  fixture.env.SUPPLIER_COST_RULES = '[]';
  assert.deepEqual(await supplierAvailability(fixture.env, [model]), { [model.id]: { available: false, code: 'supplier_unavailable' } });
});

const start = 1791921600;
const billingWindow = { start, end: start + 3600, resourceIds: ['supplier123'] };
function billingPayload(total = 0.02, records = true) {
  const startTime = new Date(start * 1000).toISOString();
  const endTime = new Date((start + 3600) * 1000).toISOString();
  return { records: records ? [{ serverlessId: 'supplier123', startTime, endTime, totalAmount: total, gpuAmount: total, cpuAmount: 0, diskAmount: 0 }] : [],
    metadata: { query: { startTime, endTime, bucketSize: 'hour' }, recordCount: records ? 1 : 0 } };
}

test('RunPod reconciliation reads only billing; replay and revised hours replace costs without refilling allowance', async (t) => {
  const fixture = setup();
  let total = 0.02;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'https://api.runpod.io');
    assert.equal(url.pathname, '/v2/billing/serverless');
    assert.equal(url.searchParams.get('serverlessId'), null);
    assert.equal(options.method, undefined);
    assert.equal(options.redirect, 'manual');
    return Response.json(billingPayload(total));
  });
  assert.deepEqual(await reconcileRunpodBilling(fixture.env, billingWindow), { resources: 1, records: 1 });
  await reconcileRunpodBilling(fixture.env, billingWindow);
  assert.equal(row(fixture.env, 'supplier_billing_buckets').revision, 1);
  assert.equal(row(fixture.env, 'supplier_billing_buckets').total_micro, 20000);
  total = 0.03;
  await reconcileRunpodBilling(fixture.env, billingWindow);
  assert.equal(row(fixture.env, 'supplier_billing_buckets').revision, 2);
  assert.equal(row(fixture.env, 'supplier_billing_buckets').total_micro, 30000);
  assert.equal(row(fixture.env, 'supplier_budget_windows').limit_micro, 10000);
});

test('missing or malformed billing never becomes a verified zero or replaces previous evidence', async (t) => {
  const fixture = setup();
  let payload = billingPayload();
  t.mock.method(globalThis, 'fetch', async () => payload === null ? new Response(null, { status: 503 }) : Response.json(payload));
  await reconcileRunpodBilling(fixture.env, billingWindow);
  for (const invalid of [null, {}, { ...billingPayload(), records: [{ ...billingPayload().records[0], serverlessId: 'malformed/id' }] },
    { ...billingPayload(), records: [{ ...billingPayload().records[0], totalAmount: -1 }] },
    { ...billingPayload(), records: [...billingPayload().records, ...billingPayload().records], metadata: { ...billingPayload().metadata, recordCount: 2 } }]) {
    payload = invalid;
    await assert.rejects(reconcileRunpodBilling(fixture.env, billingWindow));
    assert.equal(row(fixture.env, 'supplier_billing_buckets').total_micro, 20000);
    assert.equal(row(fixture.env, 'supplier_billing_syncs').record_count, 1);
  }
});

test('a verified empty billing response records coverage without inventing a cost row', async (t) => {
  const fixture = setup();
  t.mock.method(globalThis, 'fetch', async () => Response.json(billingPayload(0, false)));
  await reconcileRunpodBilling(fixture.env, billingWindow);
  assert.equal(row(fixture.env, 'supplier_billing_buckets'), undefined);
  assert.equal(row(fixture.env, 'supplier_billing_syncs').record_count, 0);
  const report = await supplierOperatingReport(fixture.env, start, start + 3600);
  assert.equal(report.current_customer_wallets.customer_credit_liability_micro, 50000);
  assert.equal(report.revenue.usage_revenue_micro, 0);
  assert.equal(report.stripe_fees_micro, null);
  assert.equal(report.net_profit_micro, null);
  assert.equal(report.owner_withdrawable_micro, null);
  assert.equal(report.successful_billing_reads.length, 1);
});

test('a complete replacement billing snapshot can correct a previous charge to zero without deleting evidence', async (t) => {
  const fixture = setup();
  let records = true;
  t.mock.method(globalThis, 'fetch', async () => Response.json(billingPayload(0.02, records)));
  await reconcileRunpodBilling(fixture.env, billingWindow);
  records = false;
  await reconcileRunpodBilling(fixture.env, billingWindow);
  assert.equal(row(fixture.env, 'supplier_billing_buckets').total_micro, 0);
  assert.equal(row(fixture.env, 'supplier_billing_buckets').revision, 2);
  await reconcileRunpodBilling(fixture.env, billingWindow);
  assert.equal(row(fixture.env, 'supplier_billing_buckets').revision, 2);
});

test('72 hours across ten endpoints reconcile in one billing read and three SQL queries with other projects excluded', async (t) => {
  const fixture = setup();
  const ids = Array.from({ length: 10 }, (_, i) => `endpoint${i}`);
  const end = Math.floor(now() / 3600) * 3600;
  const from = end - 72 * 3600;
  const records = ids.flatMap((id) => Array.from({ length: 72 }, (_, hour) => ({ serverlessId: id,
    startTime: new Date((from + hour * 3600) * 1000).toISOString(), endTime: new Date((from + (hour + 1) * 3600) * 1000).toISOString(),
    totalAmount: 0.01, gpuAmount: 0.009, cpuAmount: 0, diskAmount: 0.001 })));
  records.push({ ...records[0], serverlessId: 'unrelatedproject', totalAmount: 123 });
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    reads++;
    return Response.json({ records, metadata: { recordCount: records.length,
      query: { startTime: new Date(from * 1000).toISOString(), endTime: new Date(end * 1000).toISOString(), bucketSize: 'hour' } } });
  });
  const batch = fixture.env.DB.batch;
  let queryCount = 0;
  t.mock.method(fixture.env.DB, 'batch', async (statements) => { queryCount += statements.length; return batch(statements); });
  assert.deepEqual(await reconcileRunpodBilling(fixture.env, { start: from, end, resourceIds: ids }), { resources: 10, records: 720 });
  assert.equal(reads, 1);
  assert.equal(queryCount, 3);
  assert.equal(fixture.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM supplier_billing_buckets').get().n, 720);
  assert.equal(fixture.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM supplier_billing_syncs').get().n, 10);
  assert.equal(fixture.env.DB.sqlite.prepare('SELECT SUM(total_micro) AS cost FROM supplier_billing_buckets').get().cost, 7200000);
  assert.equal(fixture.env.DB.sqlite.prepare("SELECT 1 FROM supplier_billing_buckets WHERE resource_id = 'unrelatedproject'").get(), undefined);
});

test('billing import failure is atomic and cannot leave a successful sync receipt', async (t) => {
  const fixture = setup();
  t.mock.method(globalThis, 'fetch', async () => Response.json(billingPayload()));
  fixture.env.DB.sqlite.exec("CREATE TRIGGER test_billing_failure BEFORE INSERT ON supplier_billing_syncs BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  await assert.rejects(reconcileRunpodBilling(fixture.env, billingWindow), /receipt failure/);
  assert.equal(row(fixture.env, 'supplier_billing_buckets'), undefined);
  assert.equal(row(fixture.env, 'supplier_billing_syncs'), undefined);
});

test('operating report never nets a debtor against another customer credit liability', async () => {
  const fixture = setup();
  addAccount(fixture.env.DB, 'debtor');
  fixture.env.DB.sqlite.exec("INSERT INTO api_wallets(account_id, balance_micro) VALUES('debtor', -1000)");
  const report = await supplierOperatingReport(fixture.env, start, start + 3600);
  assert.equal(report.current_customer_wallets.customer_credit_liability_micro, 50000);
  assert.equal(report.current_customer_wallets.customer_deficit_micro, 1000);
});
