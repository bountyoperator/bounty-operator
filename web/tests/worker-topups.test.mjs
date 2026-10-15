import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../src/crypto.ts';
import { portalData } from '../src/account.ts';
import { clearHostingState, inferencePaused } from '../src/inference.ts';
import worker from '../src/worker.ts';
import { addAccount, createContext, createEnv, SITE_ORIGIN } from './worker-helpers.mjs';
import { enableSupplierFixture } from './supplier-fixtures.mjs';

const model = { id: 'billing-test', name: 'Billing test', source: 'test/model', revision: 'abc', license: 'MIT', quantization: 'FP8', endpoint: 'https://api.infron.ai', upstreamModel: 'test/model', inputRate: 2, outputRate: 8, minimumMicro: 10000, context: 32768, maxOutput: 8192 };
const session = 's'.repeat(43);
const purchase = { amount_usd: 20, threshold_usd: 5, monthly_cap_usd: 20, consent: true, request_id: 'worker-topup-request-0001' };

async function setup(overrides = {}) {
  clearHostingState();
  const env = createEnv({
    BILLING_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_PRICE_ID: 'price_monthly',
    INFERENCE_ENABLED: 'true', API_TOPUPS_ENABLED: 'true', API_AUTOTOPUPS_ENABLED: 'true',
    INFRON_API_KEY: 'fixture-direct-key', INFERENCE_MODELS: JSON.stringify([model]), ...overrides,
  });
  enableSupplierFixture(env);
  const account = addAccount(env.DB);
  const now = Math.floor(Date.now() / 1000);
  env.DB.sqlite.prepare('INSERT INTO sessions(token_hash, account_id, csrf, expires, auth_at) VALUES(?, ?, ?, ?, ?)')
    .run(await sha256(session), account, 'csrf', now + 3600, now);
  const post = async (path) => {
    const ctx = createContext();
    const response = await worker.fetch(new Request(`${SITE_ORIGIN}${path}`, {
      method: 'POST', headers: { Origin: SITE_ORIGIN, Cookie: `__Host-bounty-session=${session}`, 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }, body: JSON.stringify(purchase),
    }), env, ctx);
    await ctx.settled();
    return response;
  };
  return { env, account, post };
}

test('manual top-up checkout remains available through a direct provider while Runpod is paused', async (t) => {
  const { env, account, post } = await setup({ RUNPOD_API_KEY: 'fixture-runpod-key' });
  env.DB.sqlite.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ?').run('cus_fixture', account);
  const stripeCalls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host === 'api.runpod.io') return Response.json({ data: { myself: { underBalance: true } } });
    assert.equal(url.host, 'api.stripe.com');
    assert.equal(url.pathname, '/v1/checkout/sessions');
    assert.equal(options.method, 'POST');
    stripeCalls.push(url.pathname);
    return Response.json({ id: 'cs_live_fixture', url: 'https://checkout.stripe.com/c/pay/cs_live_fixture', payment_intent: null });
  });
  assert.equal(await inferencePaused(env), true);
  const response = await post('/api/inference/topup');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).url, 'https://checkout.stripe.com/c/pay/cs_live_fixture');
  assert.equal(stripeCalls.length, 1);
});

test('paused or unavailable inference rejects manual and automatic purchases before any Stripe request', async (t) => {
  const stripeCalls = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host === 'api.runpod.io') return Response.json({ data: { myself: { underBalance: true } } });
    stripeCalls.push(url.toString());
    throw new Error('A closed purchase route must not contact Stripe');
  });
  for (const overrides of [
    { INFRON_API_KEY: undefined },
    { INFRON_API_KEY: undefined, RUNPOD_API_KEY: 'fixture-runpod-key', INFERENCE_MODELS: JSON.stringify([{ ...model, endpoint: 'https://billingtest.api.runpod.ai' }]) },
  ]) {
    const { env, post } = await setup(overrides);
    for (const path of ['/api/inference/topup', '/api/inference/autotopup/setup', '/api/inference/autotopup/update']) {
      const response = await post(path);
      assert.equal(response.status, 503, path);
      assert.equal((await response.json()).code, 'topups_unavailable');
    }
    assert.equal(env.DB.sqlite.prepare('SELECT stripe_customer FROM accounts').get().stripe_customer, null);
  }
  assert.equal(stripeCalls.length, 0);
});

test('automatic setup requires explicit configuration but disabling stays available without it', async (t) => {
  const { env, account, post } = await setup({ API_AUTOTOPUPS_ENABLED: undefined });
  const outbound = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No external request is expected'); });
  const setupResponse = await post('/api/inference/autotopup/setup');
  assert.equal(setupResponse.status, 503);
  assert.equal((await setupResponse.json()).code, 'topups_unavailable');
  env.DB.sqlite.prepare('INSERT INTO api_autotopup_settings(account_id, customer_id, enabled, updated_at) VALUES(?, ?, 1, 1)').run(account, 'cus_fixture');
  env.DB.sqlite.prepare('UPDATE sessions SET auth_at = 0').run();
  const disabled = await post('/api/inference/autotopup/disable');
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).auto_topup.enabled, false);
  assert.equal(outbound.mock.callCount(), 0);
});

test('website and account catalogs retain unavailable models with the same individual status', async () => {
  const unavailable = { ...model, id: 'unavailable-model', endpoint: 'https://api.orcarouter.ai' };
  const { env, account } = await setup({ INFERENCE_MODELS: JSON.stringify([model, unavailable]) });
  const response = await worker.fetch(new Request(`${SITE_ORIGIN}/api/inference/catalog`), env, createContext());
  assert.equal(response.status, 200);
  const catalog = await response.json();
  const portal = await portalData(env, account);
  assert.deepEqual(catalog.models.map(({ id, availability }) => [id, availability]), [[model.id, 'available'], [unavailable.id, 'unavailable']]);
  assert.deepEqual(portal.api.models, catalog.models);
  assert.equal(catalog.enabled, true);
  assert.equal(portal.api.topups_enabled, true);

  delete env.SUPPLIER_COST_RULES;
  const closed = await (await worker.fetch(new Request(`${SITE_ORIGIN}/api/inference/catalog`), env, createContext())).json();
  assert.equal(closed.status, 'unavailable');
  assert.equal(closed.topups_enabled, false);
  assert.equal(closed.models.length, 2);
  assert(closed.models.every(({ availability }) => availability === 'unavailable'));
});

const catalog = async (env) => (await worker.fetch(new Request(`${SITE_ORIGIN}/api/inference/catalog`), env, createContext())).json();
/** Every window's allowance used up: no room for one more request. */
const exhaust = (env) => env.DB.sqlite.prepare('UPDATE supplier_budget_windows SET consumed_micro = limit_micro').run();

test('manual top-ups stay open while only an exhausted supplier budget blocks inference, since the payment refills it', async (t) => {
  let underBalance = false;
  const stripeCalls = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host === 'api.runpod.io') return Response.json({ data: { myself: { underBalance } } });
    assert.equal(url.host, 'api.stripe.com');
    stripeCalls.push(url.pathname);
    return Response.json({ id: 'cs_live_fixture', url: 'https://checkout.stripe.com/c/pay/cs_live_fixture', payment_intent: null });
  });
  const { env, account, post } = await setup();
  env.DB.sqlite.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ?').run('cus_fixture', account);
  exhaust(env);
  const shown = await catalog(env);
  assert.deepEqual([shown.enabled, shown.status, shown.topups_enabled], [false, 'unavailable', true]);
  const portal = await portalData(env, account);
  assert.deepEqual([portal.api.enabled, portal.api.status, portal.api.topups_enabled], [false, 'unavailable', true]);
  const response = await post('/api/inference/topup');
  assert.equal(response.status, 200);
  assert.deepEqual(stripeCalls, ['/v1/checkout/sessions']);
  // Automatic top-ups still need the service available.
  const automatic = await post('/api/inference/autotopup/setup');
  assert.equal(automatic.status, 503);
  assert.equal((await automatic.json()).code, 'topups_unavailable');
  assert.equal(stripeCalls.length, 1);

  // The window ended with nothing left to carry: the next payment opens one.
  const now = Math.floor(Date.now() / 1000);
  env.DB.sqlite.prepare('UPDATE supplier_budget_windows SET starts_at = ?, ends_at = ?').run(now - 2 * 86400, now - 1);
  assert.equal((await catalog(env)).topups_enabled, true);

  // A RunPod-only service stays open too, unless the hosting account is paused.
  const runpod = await setup({ INFRON_API_KEY: undefined, RUNPOD_API_KEY: 'fixture-runpod-key', INFERENCE_MODELS: JSON.stringify([{ ...model, endpoint: 'https://billingtest.api.runpod.ai' }]) });
  exhaust(runpod.env);
  assert.equal((await catalog(runpod.env)).topups_enabled, true);
  clearHostingState();
  underBalance = true;
  assert.equal((await catalog(runpod.env)).topups_enabled, false);
});

test('every other reason inference is unavailable keeps manual top-ups closed', async (t) => {
  const stripeCalls = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host === 'api.runpod.io') return Response.json({ data: { myself: { underBalance: true } } });
    stripeCalls.push(url.toString());
    throw new Error('A closed purchase route must not contact Stripe');
  });
  const runpodOnly = { INFRON_API_KEY: undefined, RUNPOD_API_KEY: 'fixture-runpod-key', INFERENCE_MODELS: JSON.stringify([{ ...model, endpoint: 'https://billingtest.api.runpod.ai' }]) };
  const cases = [
    ['a provider that was never funded', {}, (env) => env.DB.sqlite.prepare('DELETE FROM supplier_budget_windows').run()],
    ['the operator\u2019s pause', {}, (env) => { exhaust(env); env.DB.sqlite.prepare('UPDATE supplier_budget_windows SET enabled = 0').run(); }],
    ['automatic funding off', { SUPPLIER_BUDGET_SHARE: '0' }, exhaust],
    ['an unreadable share', { SUPPLIER_BUDGET_SHARE: 'ninety' }, exhaust],
    ['a share of the smallest top-up too small for one request', { SUPPLIER_BUDGET_SHARE: '0.000001' }, exhaust],
    ['no cost rule', {}, (env) => { exhaust(env); delete env.SUPPLIER_COST_RULES; }],
    ['a disabled model', { INFERENCE_MODELS: JSON.stringify([{ ...model, enabled: false }]) }, exhaust],
    ['inference switched off', { INFERENCE_ENABLED: 'false' }, exhaust],
    ['a hosting pause', runpodOnly, exhaust],
  ];
  for (const [reason, overrides, arrange] of cases) {
    const { env, account, post } = await setup(overrides);
    arrange(env);
    assert.equal((await catalog(env)).topups_enabled, false, reason);
    assert.equal((await portalData(env, account)).api.topups_enabled, false, reason);
    const response = await post('/api/inference/topup');
    assert.equal(response.status, 503, reason);
    assert.equal((await response.json()).code, 'topups_unavailable', reason);
  }
  assert.equal(stripeCalls.length, 0);
});
