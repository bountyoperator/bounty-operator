import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../src/crypto.ts';
import { portalData } from '../src/account.ts';
import { clearHostingState, inferencePaused } from '../src/inference.ts';
import worker from '../src/worker.ts';
import { addAccount, createContext, createEnv, SITE_ORIGIN } from './worker-helpers.mjs';
import { enableSupplierFixture } from './supplier-fixtures.mjs';
import { HOSTING_FAILURES, fundedHosting } from './hosting-fixtures.mjs';

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

test('purchase routes say top-ups are unavailable, before any Stripe request, when the hosting state cannot be read', async (t) => {
  let answer = fundedHosting;
  const stripeCalls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host === 'api.runpod.io') return answer(url, options);
    assert.equal(url.host, 'api.stripe.com');
    assert.equal(url.pathname, '/v1/checkout/sessions');
    stripeCalls.push(url.pathname);
    return Response.json({ id: 'cs_live_fixture', url: 'https://checkout.stripe.com/c/pay/cs_live_fixture', payment_intent: null });
  });
  const runpodOnly = { INFRON_API_KEY: undefined, RUNPOD_API_KEY: 'fixture-runpod-key', INFERENCE_MODELS: JSON.stringify([{ ...model, endpoint: 'https://billingtest.api.runpod.ai' }]) };
  for (const [name, failure] of Object.entries(HOSTING_FAILURES)) {
    const { env, account, post } = await setup(runpodOnly);
    env.DB.sqlite.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ?').run('cus_fixture', account);
    answer = failure;
    for (const path of ['/api/inference/topup', '/api/inference/autotopup/setup', '/api/inference/autotopup/update']) {
      const response = await post(path);
      assert.equal(response.status, 503, `${name} ${path}`);
      assert.equal(response.headers.get('Retry-After'), '60', `${name} ${path}`);
      const body = await response.json();
      assert.equal(body.code, 'topups_unavailable', `${name} ${path}`);
      assert.match(body.error, /top-ups are unavailable because the model hosting status could not be confirmed\. No charge was made\./, `${name} ${path}`);
    }
    assert.equal(stripeCalls.length, 0, name);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM api_topups').get().n, 0, name);

    // The catalog keeps showing the model; only purchases close.
    const catalog = await (await worker.fetch(new Request(`${SITE_ORIGIN}/api/inference/catalog`), env, createContext())).json();
    assert.deepEqual([catalog.status, catalog.models[0].availability, catalog.topups_enabled], ['available', 'available', false], name);
    const portal = await portalData(env, account);
    assert.deepEqual([portal.api.status, portal.api.topups_enabled, portal.api.auto_topup.available], ['available', false, false], name);

    // Once hosting is confirmed funded, the same purchase opens a checkout.
    answer = fundedHosting;
    clearHostingState();
    const opened = await post('/api/inference/topup');
    assert.equal(opened.status, 200, name);
    assert.equal(stripeCalls.length, 1, name);
    stripeCalls.length = 0;
  }
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
