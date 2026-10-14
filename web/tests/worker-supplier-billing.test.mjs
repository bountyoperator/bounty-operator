import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.ts';
import { createContext, createEnv } from './worker-helpers.mjs';

const daily = '17 3 * * *';
const frequent = '*/15 * * * *';
const now = Date.UTC(2026, 9, 14, 16, 17);
const end = Math.floor(now / 3600000) * 3600;
const start = end - 72 * 3600;
const model = { id: 'billing-test', name: 'Billing test', source: 'test/model', revision: 'abc', license: 'MIT', quantization: 'FP8', endpoint: 'https://billingone.api.runpod.ai', upstreamModel: 'test/model', inputRate: 2, outputRate: 8, minimumMicro: 10000, context: 32768, maxOutput: 8192 };

function fixture(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const env = createEnv({ INFERENCE_ENABLED: 'false', RUNPOD_API_KEY: 'fixture-read-only-key', INFERENCE_MODELS: JSON.stringify([model]), ...overrides });
  const logged = t.mock.method(console, 'log', () => {});
  const failed = t.mock.method(console, 'error', () => {});
  const run = async (cron = daily) => {
    const ctx = createContext();
    await worker.scheduled({ cron }, env, ctx);
    await ctx.settled();
    return logged.mock.calls.at(-1).arguments[1];
  };
  return { env, run, failed };
}

function snapshot(records = []) {
  return { records, metadata: { recordCount: records.length, query: { bucketSize: 'hour', startTime: new Date(start * 1000).toISOString(), endTime: new Date(end * 1000).toISOString() } } };
}

function record(serverlessId, totalAmount = 0.25) {
  return { serverlessId, startTime: new Date(start * 1000).toISOString(), endTime: new Date((start + 3600) * 1000).toISOString(), totalAmount, gpuAmount: totalAmount, cpuAmount: 0, diskAmount: 0 };
}

test('daily cleanup reads 72 complete UTC hours of configured Runpod billing while inference is disabled', async (t) => {
  const models = [model, { ...model, id: 'same-endpoint' }, { ...model, id: 'disabled-endpoint', enabled: false, endpoint: 'https://billingtwo.api.runpod.ai' }, { ...model, id: 'direct-provider', endpoint: 'https://api.infron.ai' }];
  const { env, run, failed } = fixture(t, { INFERENCE_MODELS: JSON.stringify(models) });
  const fetched = t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://api.runpod.io/v2/billing/serverless', 'no worker health, generation or funding request');
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(url.searchParams.get('bucketSize'), 'hour');
    assert.equal(Date.parse(url.searchParams.get('startTime')) / 1000, start);
    assert.equal(Date.parse(url.searchParams.get('endTime')) / 1000, end);
    return Response.json(snapshot([record('billingone'), record('billingtwo', 0.5), record('unrelatedendpoint', 10)]));
  });
  assert.equal((await run(frequent)).supplierBilling, undefined);
  assert.equal(fetched.mock.callCount(), 0);
  const result = await run();
  assert.deepEqual(result.supplierBilling, { status: 'synced', resources: 2, records: 2 });
  assert.equal(fetched.mock.callCount(), 1);
  assert.deepEqual(env.DB.sqlite.prepare('SELECT resource_id, total_micro FROM supplier_billing_buckets ORDER BY resource_id').all().map((row) => ({ ...row })), [
    { resource_id: 'billingone', total_micro: 250000 }, { resource_id: 'billingtwo', total_micro: 500000 },
  ]);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM supplier_billing_syncs').get().n, 2);
  assert.equal(failed.mock.calls.filter(({ arguments: args }) => args[0] === 'Supplier billing reconciliation failed').length, 0);
});

test('a failed daily supplier read reports unknown and preserves previous costs', async (t) => {
  const { env, run, failed } = fixture(t);
  let unavailable = false;
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(new URL(input).pathname, '/v2/billing/serverless');
    return unavailable ? new Response('private provider diagnostic', { status: 503 }) : Response.json(snapshot([record('billingone')]));
  });
  await run();
  unavailable = true;
  const result = await run();
  assert.deepEqual(result.supplierBilling, { status: 'unknown' });
  assert.equal(env.DB.sqlite.prepare('SELECT total_micro FROM supplier_billing_buckets').get().total_micro, 250000);
  assert.deepEqual(failed.mock.calls.find(({ arguments: args }) => args[0] === 'Supplier billing reconciliation failed').arguments, ['Supplier billing reconciliation failed', { name: 'Error' }]);
  assert.equal(result.stripeEvents, 0, 'ordinary daily cleanup still ran');
});

test('daily supplier billing skips an absent key or a catalog with only other providers', async (t) => {
  const { env, run } = fixture(t, { RUNPOD_API_KEY: undefined });
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No external request is expected'); });
  assert.deepEqual((await run()).supplierBilling, { status: 'not_configured' });
  env.RUNPOD_API_KEY = 'fixture-read-only-key';
  env.INFERENCE_MODELS = JSON.stringify([{ ...model, endpoint: 'https://api.infron.ai' }]);
  assert.deepEqual((await run()).supplierBilling, { status: 'not_configured' });
  assert.equal(fetched.mock.callCount(), 0);
});
