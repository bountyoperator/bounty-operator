import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiCreditData, authenticateInference, createInferenceKey, hasApiLiability, reapInferenceHolds, reserveInference, settleInference } from '../src/api-credits.ts';
import { inferenceEndpoint, inferenceModels, parseInference } from '../src/inference.ts';
import { addAccount, createCall, createContext, createEnv } from './worker-helpers.mjs';

const model = { id: 'cyber-test', name: 'Cyber test', source: 'test/model', revision: 'abc', license: 'Apache-2.0', quantization: 'AWQ', endpoint: 'https://test123.api.runpod.ai', upstreamModel: 'cyber-test', inputRate: 2, outputRate: 8, minimumMicro: 10000, context: 32768, maxOutput: 8192 };
async function setup(balance = 20000000) {
  const env = createEnv({ INFERENCE_ENABLED: 'true', RUNPOD_API_KEY: 'vendor-secret', INFERENCE_MODELS: JSON.stringify([model]) });
  const account = addAccount(env.DB);
  env.DB.sqlite.prepare('INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES(?, ?, ?, ?, ?, ?)').run('fund-1', account, balance, 'topup', 'fixture', 1);
  const created = await createInferenceKey(createCall(new Request('https://bountyoperator.com/api/inference/keys/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Workstation', budget_usd: 20 }) }), env), { account_id: account });
  const credentials = await created.json();
  const key = await authenticateInference(createCall(new Request('https://bountyoperator.com/v1/models', { headers: { Authorization: `Bearer ${credentials.key}` } }), env));
  return { env, account, key, token: credentials.key };
}
const request = (token, body) => new Request('https://bountyoperator.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'Explain this test.' }], max_tokens: 20, ...body }) });

test('concurrent reservations cannot exceed either wallet credit or key budget', async () => {
  const { env, key } = await setup(80000);
  const results = await Promise.allSettled([reserveInference(env, key, model, 20, null), reserveInference(env, key, model, 20, null)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'insufficient_quota');
  const wallet = env.DB.sqlite.prepare('SELECT * FROM api_wallets').get();
  assert.equal(wallet.reserved_micro, 32768 * 2 + 20 * 8);
  await settleInference(env, results.find((r) => r.status === 'fulfilled').value, 'completed', { input: 100, output: 20 });
  assert.equal(env.DB.sqlite.prepare('SELECT balance_micro, reserved_micro FROM api_wallets').get().balance_micro, 70000);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
  env.DB.sqlite.prepare('UPDATE inference_keys SET budget_micro = 10001').run();
  await assert.rejects(reserveInference(env, key, model, 20, null), { code: 'key_budget_exceeded' });
});

test('settlement is exactly once, a failed call releases its hold and stale holds are reaped', async () => {
  const { env, key, account } = await setup();
  const id = await reserveInference(env, key, model, 20, 'once');
  await assert.rejects(reserveInference(env, key, model, 20, 'once'), { code: 'idempotency_conflict' });
  await Promise.all([settleInference(env, id, 'completed', { input: 100, output: 20 }), settleInference(env, id, 'completed', { input: 100, output: 20 })]);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM api_ledger WHERE kind = 'usage'").get().n, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT spent_micro FROM inference_keys').get().spent_micro, 10000);
  const stale = await reserveInference(env, key, model, 20, null);
  env.DB.sqlite.prepare('UPDATE inference_requests SET lease_until = 0 WHERE id = ?').run(stale);
  assert.equal(await reapInferenceHolds(env, 100), 1);
  const panel = await apiCreditData(env, account);
  assert.equal(panel.reserved_micro, 0);
  assert.equal(panel.balance_micro, 19990000);
  assert.equal(panel.requests.find((r) => r.id === stale).charge_micro, 0);
});

test('account concurrency spans all keys and a revoked key cannot reserve', async () => {
  const { env, key } = await setup();
  const ids = await Promise.all([reserveInference(env, key, model, 20, null), reserveInference(env, key, model, 20, null)]);
  await assert.rejects(reserveInference(env, key, model, 20, null), { code: 'concurrency_limit' });
  await settleInference(env, ids[0], 'failed', null);
  env.DB.sqlite.prepare('UPDATE inference_keys SET revoked_at = 1').run();
  await assert.rejects(reserveInference(env, key, model, 20, null), { code: 'key_budget_exceeded' });
});

test('payment liabilities prevent account deletion; zero-balance history permits it', async () => {
  const { env, key, account } = await setup(10000);
  assert.equal(await hasApiLiability(env, account), true);
  assert.throws(() => env.DB.sqlite.prepare('DELETE FROM accounts').run(), /api_balance_exists/);
  const low = { ...model, inputRate: 1, context: 100, maxOutput: 20 };
  const id = await reserveInference(env, key, low, 20, null);
  await settleInference(env, id, 'completed', { input: 2, output: 2 });
  assert.equal(await hasApiLiability(env, account), false);
  env.DB.sqlite.prepare('DELETE FROM accounts').run();
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM api_ledger WHERE account_id IS NULL').get().n, 2);
});

test('request allowlist blocks remote images, overrides and oversized token budgets before GPU access', () => {
  const body = { model: model.id, messages: [{ role: 'user', content: 'hello' }] };
  assert.throws(() => parseInference({ ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://internal/' } }] }] }, model), /text content only/);
  assert.throws(() => parseInference({ ...body, model_url: 'http://internal' }, model), /Unsupported parameter/);
  assert.throws(() => parseInference({ ...body, max_tokens: 99999 }, model), /max_tokens/);
  assert.throws(() => parseInference({ ...body, n: 2 }, model), /n=1/);
  assert.deepEqual(inferenceModels({ INFERENCE_MODELS: JSON.stringify([{ ...model, endpoint: 'https://evil.example' }]) }), []);
});

test('plain completion uses only the configured upstream and settles trusted usage without storing text', async (t) => {
  const { env, token } = await setup();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/health')) return new Response(null, { status: 200 });
    assert.equal(url, `${model.endpoint}/v1/chat/completions`);
    assert.equal(options.headers.Authorization, 'Bearer vendor-secret');
    assert.equal(options.redirect, 'manual');
    return Response.json({ created: 1, choices: [{ index: 0, message: { role: 'assistant', content: 'private response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  });
  const response = await inferenceEndpoint(createCall(request(token), env));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'private response');
  const rows = JSON.stringify(env.DB.sqlite.prepare('SELECT * FROM inference_requests').all());
  assert.ok(!rows.includes('Explain this test') && !rows.includes('private response'));
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
});

test('upstream errors and absent usage do not leak vendor details or charge the customer', async (t) => {
  const { env, token } = await setup();
  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/health') ? new Response(null, { status: 200 }) : new Response('vendor-secret-stacktrace', { status: 500 }));
  let response = await inferenceEndpoint(createCall(request(token), env));
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('vendor-secret'));
  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/health') ? new Response(null, { status: 200 }) : Response.json({ choices: [{ message: { content: 'unmetered' } }] }));
  response = await inferenceEndpoint(createCall(request(token), env));
  assert.equal(response.status, 502);
  assert.equal(env.DB.sqlite.prepare('SELECT balance_micro, reserved_micro FROM api_wallets').get().balance_micro, 20000000);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
});

test('stream parses split SSE frames, reports final usage and charges exactly once', async (t) => {
  const { env, token } = await setup();
  const events = [
    { created: 1, choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 1 } },
    { created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2 } },
    { created: 1, choices: [], usage: { prompt_tokens: 100, completion_tokens: 2 } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (_url.endsWith('/health')) return new Response(null, { status: 200 });
    assert.equal(JSON.parse(options.body).stream_options.continuous_usage_stats, true);
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < events.length; i += 17) controller.enqueue(new TextEncoder().encode(events.slice(i, i + 17))); controller.close(); } }));
  });
  const ctx = createContext();
  const response = await inferenceEndpoint(createCall(request(token, { stream: true, stream_options: { include_usage: true } }), env, ctx));
  const text = await response.text();
  await ctx.settled();
  assert.match(text, /data: \[DONE\]/);
  assert.match(text, /"completion_tokens":2/);
  assert.match(text, /"content":"Hi"/);
  assert.equal(env.DB.sqlite.prepare('SELECT charge_micro, status FROM inference_requests').get().status, 'completed');
  assert.equal(env.DB.sqlite.prepare('SELECT spent_micro FROM inference_keys').get().spent_micro, 10000);
});

test('a health redirect is rejected before a prompt or vendor credential can reach another host', async (t) => {
  const { env, token } = await setup();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, `${model.endpoint}/health`);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.body, undefined);
    return new Response(null, { status: 302, headers: { Location: 'https://other.example' } });
  });
  const response = await inferenceEndpoint(createCall(request(token), env));
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
});
