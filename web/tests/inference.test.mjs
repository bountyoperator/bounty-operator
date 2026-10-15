import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiCreditData, authenticateInference, createInferenceKey, hasApiLiability, reapInferenceHolds, reserveInference, settleInference } from '../src/api-credits.ts';
import { clearHostingState, hostingRead, hostingState, inferenceBilling, inferenceBillingStatus, inferenceCatalog, inferenceEndpoint, inferenceModels, inferencePaused, inferenceStatus, parseInference, usageCounters } from '../src/inference.ts';
import { parseReviewRequest, runHostedReview } from '../src/review.ts';
import { addAccount, createCall, createContext, createEnv } from './worker-helpers.mjs';
import { enableSupplierFixture } from './supplier-fixtures.mjs';
import { HOSTING_API, HOSTING_FAILURES, HOSTING_REASONS, fundedHosting, pausedHosting } from './hosting-fixtures.mjs';

const model = { id: 'cyber-test', name: 'Cyber test', source: 'test/model', revision: 'abc', license: 'Apache-2.0', quantization: 'AWQ', endpoint: 'https://test123.api.runpod.ai', upstreamModel: 'cyber-test', inputRate: 2, outputRate: 8, minimumMicro: 10000, context: 32768, maxOutput: 8192 };
async function setup(balance = 20000000) {
  clearHostingState();
  const env = createEnv({ INFERENCE_ENABLED: 'true', RUNPOD_API_KEY: 'vendor-secret', INFERENCE_MODELS: JSON.stringify([model]) });
  enableSupplierFixture(env);
  const account = addAccount(env.DB);
  env.DB.sqlite.prepare('INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES(?, ?, ?, ?, ?, ?)').run('fund-1', account, balance, 'topup', 'fixture', 1);
  const created = await createInferenceKey(createCall(new Request('https://bountyoperator.com/api/inference/keys/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Workstation', budget_usd: 20 }) }), env), { account_id: account });
  const credentials = await created.json();
  const key = await authenticateInference(createCall(new Request('https://bountyoperator.com/v1/models', { headers: { Authorization: `Bearer ${credentials.key}` } }), env));
  return { env, account, key, token: credentials.key };
}
const request = (token, body) => new Request('https://bountyoperator.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'Explain this test.' }], max_tokens: 20, ...body }) });

test('harness discovery lists each configured model and retrieves its actual capabilities without starting workers', async (t) => {
  const { env, token } = await setup();
  const second = { ...model, id: 'security-chat', name: 'Security chat', endpoint: 'https://second123.api.runpod.ai', upstreamModel: 'second-model', description: 'Security analysis', tags: ['cybersecurity'], capabilities: ['text', 'streaming'], inputRate: 3, outputRate: 12 };
  env.INFERENCE_MODELS = JSON.stringify([model, second]);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Model discovery must not start a worker'); });
  const get = (path) => inferenceEndpoint(createCall(new Request(`https://bountyoperator.com${path}`, { headers: { Authorization: `Bearer ${token}` } }), env));
  const list = await (await get('/v1/models')).json();
  assert.equal(list.object, 'list');
  assert.deepEqual(list.data.map((entry) => entry.id), ['cyber-test', 'security-chat']);
  const detail = await (await get('/v1/models/security-chat')).json();
  assert.deepEqual(detail, list.data[1]);
  assert.deepEqual(detail.capabilities, ['text', 'streaming']);
  assert.equal(detail.pricing.output_per_million, 12);
  assert.equal(detail.endpoint, undefined);
  assert.equal(detail.upstreamModel, undefined);
  assert.equal((await get('/v1/models/not-offered')).status, 404);
  env.INFERENCE_ENABLED = 'false';
  assert.deepEqual((await (await get('/v1/models')).json()).data, []);
  assert.equal((await get('/v1/models/security-chat')).status, 404);
});

test('a selected catalog model routes to its own worker and settles at its own price', async (t) => {
  const { env, token } = await setup();
  const second = { ...model, id: 'second-model', endpoint: 'https://second123.api.runpod.ai', upstreamModel: 'served-second', inputRate: 3, outputRate: 12, minimumMicro: 15000 };
  env.INFERENCE_MODELS = JSON.stringify([model, second]);
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    paths.push(url);
    assert.ok(url.startsWith(second.endpoint));
    if (url.endsWith('/health')) return new Response(null, { status: 200 });
    assert.equal(JSON.parse(options.body).model, 'served-second');
    return Response.json({ created: 1, choices: [{ message: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
  });
  const response = await inferenceEndpoint(createCall(request(token, { model: second.id }), env));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, second.id);
  assert.deepEqual(paths, [`${second.endpoint}/health`, `${second.endpoint}/v1/chat/completions`]);
  assert.equal(env.DB.sqlite.prepare('SELECT charge_micro FROM inference_requests').get().charge_micro, 15000);
});

test('model capabilities reject unsupported harness requests before reservation or generation', () => {
  const chat = { ...model, capabilities: ['text'] };
  const messages = [{ role: 'user', content: 'Explain this test.' }];
  assert.throws(() => parseInference({ messages, tools: [{ type: 'function' }] }, chat), /does not support function tools/);
  assert.throws(() => parseInference({ messages, stream: true }, chat), /does not support streaming/);
  assert.throws(() => parseInference({ messages, response_format: { type: 'json_object' } }, chat), /does not support structured output/);
  assert.doesNotThrow(() => parseInference({ messages, tools: [], tool_choice: 'none', response_format: { type: 'text' } }, chat));
  for (const capabilities of [[], ['tools'], ['text', 'invented'], ['text', 'text']]) {
    assert.deepEqual(inferenceModels({ INFERENCE_MODELS: JSON.stringify([{ ...model, capabilities }]) }), []);
  }
});

test('reasoning controls preserve supported values and reject coercible non-strings before inference', () => {
  const body = { model: model.id, messages: [{ role: 'user', content: 'hello' }] };
  for (const name of ['thinking', 'enable_thinking', 'clear_thinking']) {
    assert.deepEqual(parseInference({ ...body, chat_template_kwargs: { [name]: false } }, model).payload.chat_template_kwargs, { [name]: false });
    assert.throws(() => parseInference({ ...body, chat_template_kwargs: { [name]: 'false' } }, model), /must be a boolean/);
  }
  for (const effort of ['none', 'low', 'medium', 'high', 'max']) {
    assert.equal(parseInference({ ...body, reasoning_effort: effort }, model).payload.reasoning_effort, effort);
    assert.deepEqual(parseInference({ ...body, chat_template_kwargs: { reasoning_effort: effort } }, model).payload.chat_template_kwargs, { reasoning_effort: effort });
  }
  for (const effort of [['low'], null, true, 1, {}, 'invented']) {
    assert.throws(() => parseInference({ ...body, reasoning_effort: effort }, model), /Invalid reasoning_effort/);
    assert.throws(() => parseInference({ ...body, chat_template_kwargs: { reasoning_effort: effort } }, model), /Invalid reasoning_effort/);
  }
  assert.throws(() => parseInference({ ...body, chat_template_kwargs: { arbitrary: true } }, model), /Unsupported chat template parameter/);
  assert.deepEqual(parseInference(body, { ...model, reasoningParameter: 'thinking' }).payload.chat_template_kwargs, { thinking: false });
  assert.deepEqual(parseInference({ ...body, chat_template_kwargs: { thinking: true } }, { ...model, reasoningParameter: 'thinking' }).payload.chat_template_kwargs, { thinking: true });
  assert.deepEqual(parseInference(body, { ...model, reasoningParameter: 'reasoning_effort' }).payload.chat_template_kwargs, { reasoning_effort: 'none', enable_thinking: false });
  assert.deepEqual(parseInference({ ...body, reasoning_effort: 'high' }, { ...model, reasoningParameter: 'reasoning_effort' }).payload.chat_template_kwargs, { reasoning_effort: 'high', enable_thinking: true });
});

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

test('catalog accepts larger native contexts up to one million tokens and retains output bounds', () => {
  for (const context of [262144, 524288, 1048576]) {
    const configured = { ...model, context };
    assert.deepEqual(inferenceModels({ INFERENCE_MODELS: JSON.stringify([configured]) }), [configured]);
  }
  assert.deepEqual(inferenceModels({ INFERENCE_MODELS: JSON.stringify([{ ...model, context: 1048577 }]) }), []);
  assert.deepEqual(inferenceModels({ INFERENCE_MODELS: JSON.stringify([{ ...model, context: 262144, maxOutput: 262145 }]) }), []);
});

test('managed catalog uses verified provider windows, source links and undisclosed provenance', async () => {
  const { env } = await setup();
  const ids = ['gemma-4-31b-ablit', 'glm-5.3-cyber', 'kimi-k3-cyber', 'omen-2.0-cyber', 'qwen3.8-27b-cyber', 'qwen3-coder-next', 'orca-cyber-zero-1.5'];
  env.INFERENCE_MODELS = JSON.stringify(ids.map((id) => ({ id, endpoint: id.startsWith('orca-') ? 'https://api.orcarouter.ai' : 'https://api.infron.ai' })));
  const models = inferenceModels(env);
  assert.deepEqual(models.map((item) => item.context), [32768, 1048576, 1048576, 1048576, 262144, 262140, 1000000]);
  const catalog = await inferenceCatalog(env);
  for (const entry of catalog) {
    assert.equal(entry.revision, null);
    assert.equal(entry.license, null);
    assert.equal(entry.quantization, null);
    assert.equal(entry.availability, 'unavailable', 'a RunPod credential must not enable managed gateways');
    assert.ok(!entry.source_url.includes('huggingface.co'));
  }
  assert.deepEqual(models.slice(2, 5).map((item) => [item.inputRate, item.outputRate]), [[8, 12], [8, 14], [4, 70]]);
  env.INFRON_API_KEY = 'managed-fixture';
  assert.equal((await inferenceCatalog(env)).filter((item) => item.availability === 'available').length, 6);
  Object.defineProperty(env, 'SUPPLIER_COST_RULES', { value: '[]', configurable: true });
  assert.equal(await inferenceStatus(env), 'unavailable');
  assert.equal((await inferenceCatalog(env)).filter((item) => item.availability === 'available').length, 0);
});

test('context admission includes messages, tools and response schemas before any reservation or upstream call', async (t) => {
  const { env, token } = await setup();
  const upstream = t.mock.method(globalThis, 'fetch', () => { throw new Error('Oversized input must not reach a provider'); });
  for (const body of [
    { messages: [{ role: 'user', content: 'x'.repeat(model.context) }] },
    { messages: [{ role: 'user', content: '€'.repeat(Math.ceil(model.context / 3)) }] },
    { tools: [{ type: 'function', function: { name: 'read_file', description: 'x'.repeat(model.context), parameters: { type: 'object' } } }] },
    { response_format: { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'string', description: 'x'.repeat(model.context) } } } },
  ]) {
    const response = await inferenceEndpoint(createCall(request(token, body), env));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'context_length_exceeded');
  }
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM inference_requests').get().n, 0);
});

test('an unavailable supplier blocks discovery and inference before a health probe or customer hold', async (t) => {
  const { env, token } = await setup();
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET enabled = 0 WHERE provider = 'runpod'").run();
  const upstream = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unavailable supplier must not be probed'); });
  assert.equal(await inferenceStatus(env), 'unavailable');
  assert.equal((await inferenceCatalog(env))[0].availability, 'unavailable');
  const response = await inferenceEndpoint(createCall(request(token), env));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'supplier_unavailable');
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM inference_requests').get().n, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
});

test('usage validation preserves above-window counters and rejects malformed or arithmetically unsafe usage', () => {
  assert.deepEqual(usageCounters({ prompt_tokens: 200000, completion_tokens: 10 }, model), { input: 200000, output: 10 });
  for (const usage of [null, {}, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: 1.5, completion_tokens: 1 }, { prompt_tokens: '1', completion_tokens: 1 }, { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }]) {
    assert.equal(usageCounters(usage, model), null);
  }
});

test('managed final-only streams settle a 200K-token prompt inside the native context and preserve OpenAI SSE', async (t) => {
  const { env, token } = await setup();
  env.INFERENCE_MODELS = JSON.stringify([{ id: 'glm-5.3-cyber', endpoint: 'https://api.infron.ai' }]);
  env.INFRON_API_KEY = 'managed-fixture';
  const events = [
    { choices: [{ index: 0, delta: { content: 'Complete fixture answer.' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 200000, completion_tokens: 10 } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://api.infron.ai/v1/chat/completions');
    return new Response(events);
  });
  const ctx = createContext();
  const response = await inferenceEndpoint(createCall(request(token, { model: 'glm-5.3-cyber', stream: true, stream_options: { include_usage: true } }), env, ctx));
  const output = await response.text();
  await ctx.settled();
  assert.equal(response.status, 200);
  assert.match(output, /Complete fixture answer/);
  assert.match(output, /"prompt_tokens":200000/);
  assert.match(output, /data: \[DONE\]/);
  const row = env.DB.sqlite.prepare('SELECT * FROM inference_requests').get();
  assert.equal(row.status, 'completed');
  assert.equal(row.input_tokens, 200000);
  assert.equal(row.charge_micro, 200000 * 10 + 10 * 20);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
  const supplier = env.DB.sqlite.prepare('SELECT * FROM supplier_commitments').get();
  assert.equal(supplier.expense_micro, 200010, 'a terminal stream uses its final confirmed supplier estimate');
  assert.equal(supplier.estimated_cost_micro, 200010);
});

test('partial managed stream usage charges confirmed customer tokens but retains the full supplier allowance', async (t) => {
  const { env, token } = await setup();
  env.INFERENCE_MODELS = JSON.stringify([{ ...model, endpoint: 'https://api.infron.ai', upstreamModel: 'fixture/managed' }]);
  env.INFRON_API_KEY = 'managed-fixture';
  const events = 'data: {"choices":[{"delta":{"content":"Partial metered answer"},"finish_reason":null}],"usage":{"prompt_tokens":100,"completion_tokens":1}}\n\ndata: {"error":{"code":"upstream_interrupted"}}\n\n';
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://api.infron.ai/v1/chat/completions');
    return new Response(events);
  });
  const ctx = createContext();
  const response = await inferenceEndpoint(createCall(request(token, { stream: true }), env, ctx));
  assert.match(await response.text(), /stream_interrupted/);
  await ctx.settled();
  const row = env.DB.sqlite.prepare('SELECT * FROM inference_requests').get();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.input_tokens, 100);
  assert.equal(row.output_tokens, 1);
  assert.equal(row.charge_micro, model.minimumMicro);
  const supplier = env.DB.sqlite.prepare('SELECT * FROM supplier_commitments').get();
  assert.equal(supplier.state, 'consumed');
  assert.equal(supplier.expense_micro, supplier.hold_micro);
  assert.equal(supplier.estimated_cost_micro, 101, 'partial usage remains visible as an estimate, not final expense');
  assert.equal(env.DB.sqlite.prepare("SELECT consumed_micro FROM supplier_budget_windows WHERE provider = 'infron'").get().consumed_micro, supplier.hold_micro);
});

test('nonterminal or unknown completion reasons cannot release a managed supplier allowance', async (t) => {
  for (const finishReason of [null, 'unknown', ['stop'], 'stop']) {
    const { env, token } = await setup();
    env.INFERENCE_MODELS = JSON.stringify([{ ...model, endpoint: 'https://api.infron.ai', upstreamModel: 'fixture/managed' }]);
    env.INFRON_API_KEY = 'managed-fixture';
    t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'Metered response' }, finish_reason: finishReason }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    const response = await inferenceEndpoint(createCall(request(token), env));
    assert.equal(response.status, 200);
    await response.json();
    const supplier = env.DB.sqlite.prepare('SELECT * FROM supplier_commitments').get();
    assert.equal(supplier.estimated_cost_micro, 110);
    assert.equal(supplier.expense_micro, finishReason === 'stop' ? 110 : supplier.hold_micro);
    t.mock.restoreAll();
  }
});

test('a usage event followed by more streaming output is not a final supplier meter', async (t) => {
  const { env, token } = await setup();
  env.INFERENCE_MODELS = JSON.stringify([{ ...model, endpoint: 'https://api.infron.ai', upstreamModel: 'fixture/managed' }]);
  env.INFRON_API_KEY = 'managed-fixture';
  const events = 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":1}}\n\ndata: {"choices":[{"delta":{"content":"Later output"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  t.mock.method(globalThis, 'fetch', async () => new Response(events));
  const ctx = createContext();
  const response = await inferenceEndpoint(createCall(request(token, { stream: true }), env, ctx));
  assert.match(await response.text(), /stream_interrupted/);
  await ctx.settled();
  assert.equal(env.DB.sqlite.prepare('SELECT status FROM inference_requests').get().status, 'cancelled');
  const supplier = env.DB.sqlite.prepare('SELECT * FROM supplier_commitments').get();
  assert.equal(supplier.expense_micro, supplier.hold_micro);
  assert.equal(supplier.estimated_cost_micro, 101);
});

test('an earlier terminal marker cannot certify later unfinished streaming output', async (t) => {
  const { env, token } = await setup();
  env.INFERENCE_MODELS = JSON.stringify([{ ...model, endpoint: 'https://api.infron.ai', upstreamModel: 'fixture/managed' }]);
  env.INFRON_API_KEY = 'managed-fixture';
  const events = [
    { choices: [{ delta: { content: 'Earlier answer' }, finish_reason: 'stop' }] },
    { choices: [{ delta: { content: 'Later unfinished output' }, finish_reason: null }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  t.mock.method(globalThis, 'fetch', async () => new Response(events));
  const ctx = createContext();
  const response = await inferenceEndpoint(createCall(request(token, { stream: true }), env, ctx));
  assert.match(await response.text(), /data: \[DONE\]/);
  await ctx.settled();
  const supplier = env.DB.sqlite.prepare('SELECT * FROM supplier_commitments').get();
  assert.equal(supplier.expense_micro, supplier.hold_micro);
  assert.equal(supplier.estimated_cost_micro, 110);
});

test('unexpected provider usage above the reservation is retained, charge-capped and blocks repeated upstream execution', async (t) => {
  const { env, token } = await setup();
  const upstream = t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/health') ? new Response(null, { status: 200 }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'Confirmed answer' } }], usage: { prompt_tokens: 200000, completion_tokens: 10 } }));
  let response = await inferenceEndpoint(createCall(request(token), env));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).usage.prompt_tokens, 200000);
  const row = env.DB.sqlite.prepare('SELECT * FROM inference_requests').get();
  assert.equal(row.status, 'completed');
  assert.equal(row.input_tokens, 200000);
  assert.equal(row.charge_micro, row.hold_micro);
  assert.equal(row.failure_code, 'usage_limit_exceeded');
  assert.equal(env.DB.sqlite.prepare('SELECT balance_micro FROM api_wallets').get().balance_micro, 20000000 - row.hold_micro);
  // A long cold start must not exhaust the cooldown before the fault finishes.
  env.DB.sqlite.prepare('UPDATE inference_requests SET created_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 901, row.id);
  assert.equal(await inferenceStatus(env), 'unavailable');
  assert.equal((await inferenceCatalog(env))[0].availability, 'unavailable');
  response = await inferenceEndpoint(createCall(request(token), env));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'model_usage_unavailable');
  assert.equal(upstream.mock.callCount(), 2, 'only the first health probe and generation ran');
});

test('catalog discovers a paused RunPod account on its first read even when a managed model is available', async (t) => {
  const { env, token } = await setup();
  const direct = { ...model, id: 'managed-fixture', endpoint: 'https://api.infron.ai', upstreamModel: 'fixture/managed' };
  env.INFERENCE_MODELS = JSON.stringify([model, direct]);
  env.INFRON_API_KEY = 'managed-fixture';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    assert.equal(url, 'https://api.runpod.io/graphql', 'discovery must not start or probe a worker');
    return Response.json({ data: { myself: { underBalance: true } } });
  });
  assert.equal(await inferenceStatus(env), 'available', 'managed gateway remains independently available');
  const catalog = await inferenceCatalog(env);
  assert.deepEqual(catalog.map((entry) => entry.availability), ['paused', 'available']);
  const response = await inferenceEndpoint(createCall(new Request('https://bountyoperator.com/v1/models', { headers: { Authorization: `Bearer ${token}` } }), env));
  assert.deepEqual((await response.json()).data.map((entry) => entry.id), [direct.id]);
  assert.deepEqual(calls, ['https://api.runpod.io/graphql']);
});

test('unmetered final-only stream output is withheld from the caller', async (t) => {
  const { env, token } = await setup();
  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/health') ? new Response(null, { status: 200 }) : new Response('data: {"choices":[{"delta":{"content":"Unmetered secret answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  const ctx = createContext();
  const response = await inferenceEndpoint(createCall(request(token, { stream: true }), env, ctx));
  const output = await response.text();
  await ctx.settled();
  assert.ok(!output.includes('Unmetered secret answer'));
  assert.match(output, /stream_interrupted/);
  assert.equal(env.DB.sqlite.prepare('SELECT charge_micro FROM inference_requests').get().charge_micro, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
});

test('disconnecting before final-only output is flushed cannot erase confirmed usage', async (t) => {
  const { env, token } = await setup();
  const events = 'data: {"choices":[{"delta":{"content":"Metered answer"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\ndata: [DONE]\n\n';
  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/health') ? new Response(null, { status: 200 }) : new Response(events));
  const ctx = createContext();
  const response = await inferenceEndpoint(createCall(request(token, { stream: true }), env, ctx));
  await response.body.cancel();
  await ctx.settled();
  assert.equal(env.DB.sqlite.prepare('SELECT charge_micro FROM inference_requests').get().charge_micro, model.minimumMicro);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM api_ledger WHERE kind = 'usage'").get().n, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
});

test('a slow streaming client cannot hold confirmed usage past the generation timeout and reap it for free', { timeout: 2000 }, async (t) => {
  const { env, token } = await setup();
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => originalTimeout(callback, delay === 300000 ? 20 : delay, ...args));
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/health')) return new Response(null, { status: 200 });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Confirmed metered output"},"finish_reason":null}],"usage":{"prompt_tokens":100,"completion_tokens":1}}\n\n'));
      options.signal.addEventListener('abort', () => {
        aborted = true;
        controller.error(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    } }));
  });
  const ctx = createContext();
  const response = await inferenceEndpoint(createCall(request(token, { stream: true }), env, ctx));
  // Intentionally do not read response.body until after the pump has settled.
  await ctx.settled();
  assert.equal(aborted, true);
  const row = env.DB.sqlite.prepare('SELECT * FROM inference_requests').get();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.input_tokens, 100);
  assert.equal(row.output_tokens, 1);
  assert.equal(row.charge_micro, model.minimumMicro);
  assert.equal(await reapInferenceHolds(env, row.lease_until + 1), 0);
  await assert.rejects(response.text(), /Stream cancelled/);
  assert.equal(env.DB.sqlite.prepare('SELECT balance_micro, reserved_micro FROM api_wallets').get().balance_micro, 20000000 - model.minimumMicro);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
});

test('a request over 256 KiB reaches the larger configured model and settles its usage', async (t) => {
  const { env, token } = await setup();
  const largeModel = { ...model, context: 1048576 };
  env.INFERENCE_MODELS = JSON.stringify([largeModel]);
  const content = 'context '.repeat(65536);
  const largeRequest = request(token, { messages: [{ role: 'user', content }] });
  assert.ok(Buffer.byteLength(await largeRequest.clone().text()) > 256 * 1024);
  let generations = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, largeModel.context * largeModel.inputRate + 20 * largeModel.outputRate);
    if (url.endsWith('/health')) return new Response(null, { status: 200 });
    generations++;
    assert.equal(JSON.parse(options.body).messages[0].content, content);
    return Response.json({ created: 1, choices: [{ message: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 65536, completion_tokens: 2 } });
  });
  const response = await inferenceEndpoint(createCall(largeRequest, env));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).usage.prompt_tokens, 65536);
  assert.equal(generations, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT charge_micro FROM inference_requests').get().charge_micro, 65536 * largeModel.inputRate + 2 * largeModel.outputRate);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
});

test('requests over 8 MiB are rejected before GPU access or reservation, with or without Content-Length', async (t) => {
  const { env, token } = await setup();
  env.INFERENCE_MODELS = JSON.stringify([{ ...model, context: 1048576 }]);
  const content = '\u20ac'.repeat(3 * 1024 * 1024);
  const gpuFetch = t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/health') ? new Response(null, { status: 200 }) : Response.json({ choices: [{ message: { content: 'Unexpected generation' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  for (const declared of [false, true]) {
    const oversized = request(token, { messages: [{ role: 'user', content }] });
    const bytes = Buffer.byteLength(await oversized.clone().text());
    assert.ok(bytes > 8 * 1024 * 1024);
    assert.equal(oversized.headers.has('Content-Length'), false);
    if (declared) oversized.headers.set('Content-Length', String(bytes));
    const response = await inferenceEndpoint(createCall(oversized, env));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'too_large');
  }
  assert.equal(gpuFetch.mock.callCount(), 0);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM inference_requests').get().n, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT balance_micro FROM api_wallets').get().balance_micro, 20000000);
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

test('cold starts keep probing beyond three transient failures and generate only once', async (t) => {
  const { env, token } = await setup();
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => realTimeout(callback, delay === 15000 ? 0 : delay, ...args));
  let probes = 0;
  let generations = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/health')) {
      assert.equal(options.body, undefined);
      probes++;
      return new Response(null, { status: probes <= 3 ? 503 : 200 });
    }
    generations++;
    return Response.json({ created: 1, choices: [{ message: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
  });
  const response = await inferenceEndpoint(createCall(request(token), env));
  assert.equal(response.status, 200);
  assert.equal(probes, 4);
  assert.equal(generations, 1);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM api_ledger WHERE kind = 'usage'").get().n, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
});

test('an aborted cold start releases credit without sending the prompt', async (t) => {
  const { env, token } = await setup();
  const controller = new AbortController();
  let probes = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, `${model.endpoint}/health`);
    probes++;
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  });
  const response = await inferenceEndpoint(createCall(new Request(request(token), { signal: controller.signal }), env));
  assert.equal(response.status, 503);
  assert.equal(probes, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT balance_micro FROM api_wallets').get().balance_micro, 20000000);
});

test('a request already aborted before dispatch releases both reservations without an upstream call', async (t) => {
  const { env, token } = await setup();
  const controller = new AbortController();
  controller.abort();
  const upstream = t.mock.method(globalThis, 'fetch', () => { throw new Error('An aborted request must not reach a supplier'); });
  const response = await inferenceEndpoint(createCall(new Request(request(token), { signal: controller.signal }), env));
  assert.equal(response.status, 503);
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT state FROM supplier_commitments').get().state, 'released');
  assert.equal(env.DB.sqlite.prepare("SELECT consumed_micro FROM supplier_budget_windows WHERE provider = 'runpod'").get().consumed_micro, 0);
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

test('a paused hosting account reports paused status, releases holds with no charge and never triggers the caller failure limit', async (t) => {
  const { env, token } = await setup();
  let healthCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === 'https://api.runpod.io/graphql') return Response.json({ data: { myself: { underBalance: true } } });
    if (url.endsWith('/health')) {
      healthCalls++;
      return new Response(JSON.stringify({ status: 402, title: 'Insufficient Balance' }), { status: 402 });
    }
    throw new Error('Generation must not run while hosting is paused');
  });
  assert.equal(await inferencePaused(env), true);
  assert.equal(await inferenceStatus(env), 'paused');

  // Memoized fast-fail: after the first 402 from /health, the next call fails before reserving or probing.
  clearHostingState();
  for (let i = 0; i < 2; i++) {
    const response = await inferenceEndpoint(createCall(request(token), env));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '300');
    assert.equal((await response.json()).error.code, 'inference_paused');
  }
  assert.equal(healthCalls, 1, 'second call fast-fails before reserving or probing while the pause memo is fresh');
  const row = env.DB.sqlite.prepare('SELECT status, charge_micro, failure_code FROM inference_requests').get();
  assert.deepEqual({ ...row }, { status: 'failed', charge_micro: 0, failure_code: 'hosting_paused' });

  // Even across six un-memoized pause failures, hosting_paused rows never trigger the 5-strike caller failure_limit (429).
  for (let i = 0; i < 5; i++) {
    clearHostingState();
    const response = await inferenceEndpoint(createCall(request(token), env));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'inference_paused');
  }
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM inference_requests WHERE failure_code = 'hosting_paused'").get().n, 6);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro, balance_micro FROM api_wallets').get().reserved_micro, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT balance_micro FROM api_wallets').get().balance_micro, 20000000);
});

test('only a well-formed hosting answer is known; an unknown state keeps the catalog open but closes billing', async (t) => {
  const { env } = await setup();
  let answer = fundedHosting;
  const reads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    reads.push(url);
    assert.equal(url, HOSTING_API, 'a status read must not start or probe a worker');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal, 'every read carries a timeout');
    return answer(url, options);
  });
  assert.equal(await hostingState(env), 'funded');
  assert.equal(await inferenceBillingStatus(env), 'available');
  for (const [name, failure] of Object.entries(HOSTING_FAILURES)) {
    clearHostingState();
    answer = failure;
    assert.equal(await hostingState(env), 'unknown', name);
    // Requests and the catalog keep their behaviour: the worker probe decides.
    assert.equal(await inferencePaused(env), false, name);
    assert.equal(await inferenceStatus(env), 'available', name);
    assert.equal((await inferenceCatalog(env))[0].availability, 'available', name);
    // Payments do not: an unknown state is never available for billing.
    assert.equal(await inferenceBillingStatus(env), 'unknown', name);
  }
  clearHostingState();
  answer = pausedHosting;
  assert.equal(await hostingState(env), 'paused');
  assert.equal(await inferenceBillingStatus(env), 'paused');
  assert.equal(reads.length, Object.keys(HOSTING_FAILURES).length + 2, 'each state is read once and then cached for the minute');
  env.RUNPOD_API_KEY = undefined;
  assert.equal(await hostingState(env), 'unknown', 'no credential means no known state');
});

test('a fresh hosting read skips the one-minute cache and replaces the cached state', async (t) => {
  const { env } = await setup();
  let answer = fundedHosting;
  const reads = t.mock.method(globalThis, 'fetch', async () => answer());
  assert.equal(await inferenceBillingStatus(env), 'available');
  answer = HOSTING_FAILURES['fetch 500'];
  assert.equal(await inferenceBillingStatus(env), 'available', 'a cached funded state is used within the minute');
  assert.equal(reads.mock.callCount(), 1);
  assert.equal(await inferenceBillingStatus(env, true), 'unknown');
  assert.equal(reads.mock.callCount(), 2);
  assert.equal(await inferenceBillingStatus(env), 'unknown', 'the fresh answer replaces the cached one');
  assert.equal(reads.mock.callCount(), 2);
  answer = fundedHosting;
  assert.equal(await hostingState(env, true), 'funded');
  assert.equal(await inferenceBillingStatus(env), 'available');
  assert.equal(reads.mock.callCount(), 3);
});

test('a hosting read with no answer in five seconds is unknown and closes billing', async (t) => {
  const { env } = await setup();
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  // The timeout's own timer does not keep Node running; this one does.
  const keepAlive = setTimeout(() => {}, 10000);
  try {
    const started = Date.now();
    assert.equal(await inferenceBillingStatus(env), 'unknown');
    assert.ok(Date.now() - started >= 4500, 'the read waits for the timeout before giving up');
    assert.equal(await inferenceStatus(env), 'available');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('each unknown hosting read is logged once with a reason code, never with the key, the body or an upstream message', async (t) => {
  const { env } = await setup();
  assert.deepEqual(Object.keys(HOSTING_REASONS).sort(), Object.keys(HOSTING_FAILURES).sort(), 'every failure fixture has a reason');
  let answer = fundedHosting;
  t.mock.method(globalThis, 'fetch', async (url, options) => answer(url, options));
  const warn = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await hostingRead(env), { state: 'funded', reason: null });
  assert.equal(warn.mock.callCount(), 0, 'a known answer logs nothing');
  for (const [name, failure] of Object.entries(HOSTING_FAILURES)) {
    clearHostingState();
    warn.mock.resetCalls();
    answer = failure;
    assert.deepEqual(await hostingRead(env), { state: 'unknown', reason: HOSTING_REASONS[name] }, name);
    assert.deepEqual(await inferenceBilling(env), { status: 'unknown', reason: HOSTING_REASONS[name] }, `${name}: billing carries the reason`);
    assert.equal(warn.mock.callCount(), 1, `${name}: one line per read, none for the cached answer`);
    const [message, fields] = warn.mock.calls[0].arguments;
    assert.equal(message, 'Hosting status unknown', name);
    assert.equal(fields.reason, HOSTING_REASONS[name], name);
    const logged = JSON.stringify(warn.mock.calls[0].arguments);
    for (const secret of ['vendor-secret', 'Unauthorized', 'Field failed', 'Internal Server Error', 'other.example']) assert.ok(!logged.includes(secret), `${name} logged "${secret}"`);
  }
  // A GraphQL error code is kept when it is a plain code; its message never is.
  clearHostingState();
  warn.mock.resetCalls();
  answer = () => Response.json({ errors: [{ message: 'Token vendor-secret has no access', extensions: { code: 'UNAUTHENTICATED' } }, { message: 'second' }] });
  assert.deepEqual(await hostingRead(env), { state: 'unknown', reason: 'graphql_errors' });
  assert.deepEqual(warn.mock.calls[0].arguments[1], { reason: 'graphql_errors', graphqlErrors: 2, firstCode: 'UNAUTHENTICATED' });
  clearHostingState();
  warn.mock.resetCalls();
  answer = () => Response.json({ errors: [{ extensions: { code: 'not a code: vendor-secret' } }] });
  await hostingRead(env);
  assert.deepEqual(warn.mock.calls[0].arguments[1], { reason: 'graphql_errors', graphqlErrors: 1 });
  // Without a credential nothing is read, and the reason says so.
  env.RUNPOD_API_KEY = undefined;
  assert.deepEqual(await hostingRead(env), { state: 'unknown', reason: 'no_credential' });
});

test('an unknown hosting read says only that it is unknown; whether payments close is decided elsewhere', async (t) => {
  const { env } = await setup();
  env.INFRON_API_KEY = 'direct-secret';
  env.INFERENCE_MODELS = JSON.stringify([model, { ...model, id: 'direct-test', endpoint: 'https://api.infron.ai', upstreamModel: 'test/direct' }]);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, HOSTING_API, 'the catalog reads funding, never a worker');
    return HOSTING_FAILURES['fetch 500'](url, options);
  });
  const warn = t.mock.method(console, 'warn', () => {});
  // The direct provider can spend credit, so purchases are open although the
  // Runpod state is unknown. The read must not claim otherwise.
  assert.deepEqual(await inferenceBilling(env), { status: 'available', reason: null });
  assert.equal(warn.mock.callCount(), 0, 'a direct provider answers without reading Runpod');
  await inferenceCatalog(env);
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [['Hosting status unknown', { reason: 'http_500' }]]);
});

test('a worker /health 200 never opens payments; a worker 402 closes them until the hosting API answers again', async (t) => {
  const { env, token } = await setup();
  let answer = HOSTING_FAILURES['fetch 500'];
  let health = 200;
  let apiReads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === HOSTING_API) { apiReads++; return answer(url, options); }
    if (url.endsWith('/health')) return new Response(null, { status: health });
    return Response.json({ created: 1, choices: [{ message: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
  });
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await inferenceBilling(env), { status: 'unknown', reason: 'http_500' });

  // A worker answers 200 and serves the request. Payments stay closed: the
  // cached API answer is still unknown, and no API read was needed.
  assert.equal((await inferenceEndpoint(createCall(request(token), env))).status, 200);
  assert.deepEqual(await inferenceBilling(env), { status: 'unknown', reason: 'http_500' });
  assert.equal(apiReads, 1);
  clearHostingState();
  assert.deepEqual(await inferenceBilling(env), { status: 'unknown', reason: 'http_500' }, 'with the cache gone, the API is read again, not the probe');
  assert.equal(apiReads, 2);

  // The API says funded, then a worker answers 402: payments close at once,
  // requests fail fast and the catalog says paused, with no new API read.
  answer = fundedHosting;
  clearHostingState();
  assert.equal(await inferenceBillingStatus(env), 'available');
  health = 402;
  const refused = await inferenceEndpoint(createCall(request(token), env));
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error.code, 'inference_paused');
  const reads = apiReads;
  assert.deepEqual(await inferenceBilling(env), { status: 'paused', reason: null });
  assert.equal(await inferenceStatus(env), 'paused');
  assert.equal((await inferenceCatalog(env))[0].availability, 'paused');
  assert.equal(apiReads, reads);

  // An API answer newer than the 402 decides again.
  assert.equal(await inferenceBillingStatus(env, true), 'available');
  assert.equal((await inferenceCatalog(env))[0].availability, 'available');
});

test('serverless upstream gateways route with their own secret, skip the Runpod health probe and bill wallet usage', async (t) => {
  const { env, token } = await setup();
  const infronModel = { ...model, id: 'glm-5.3-flash-cyber', endpoint: 'https://api.infron.ai', upstreamModel: 'z-ai/glm-5.3-flash-cybersecurity', inputRate: 2, outputRate: 24, minimumMicro: 100000 };
  env.INFERENCE_MODELS = JSON.stringify([model, infronModel]);

  // Without INFRON_API_KEY, a request to an Infron-backed model returns 503 before reserving credit.
  let response = await inferenceEndpoint(createCall(request(token, { model: infronModel.id }), env));
  assert.equal(response.status, 503);
  assert.equal(env.DB.sqlite.prepare('SELECT reserved_micro FROM api_wallets').get().reserved_micro, 0);

  // With INFRON_API_KEY configured, it routes straight to api.infron.ai/v1/chat/completions without a /health probe, even if Runpod is paused.
  env.INFRON_API_KEY = 'infron-secret';
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer infron-secret');
    const sent = JSON.parse(options.body);
    assert.equal(sent.model, 'z-ai/glm-5.3-flash-cybersecurity');
    return Response.json({ created: 1, choices: [{ message: { role: 'assistant', content: 'Verified' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 10 } });
  });
  assert.equal(await inferenceStatus(env), 'available');
  response = await inferenceEndpoint(createCall(request(token, { model: infronModel.id }), env));
  assert.equal(response.status, 200);
  assert.deepEqual(urls, ['https://api.infron.ai/v1/chat/completions']);
  assert.equal(env.DB.sqlite.prepare('SELECT charge_micro FROM inference_requests ORDER BY created_at DESC LIMIT 1').get().charge_micro, 100000);
});

test('a hosted review with provider bountyoperator routes in-process to inferenceEndpoint and settles API credit', async (t) => {
  const { env, account, token } = await setup();
  env.AI_REVIEW_ENABLED = 'true';
  const infronModel = { ...model, id: 'glm-5.3-flash-cyber', endpoint: 'https://api.infron.ai', upstreamModel: 'z-ai/glm-5.3-flash-cybersecurity', inputRate: 2, outputRate: 24, minimumMicro: 100000 };
  env.INFERENCE_MODELS = JSON.stringify([infronModel]);
  env.INFRON_API_KEY = 'infron-secret';

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.infron.ai/v1/chat/completions');
    assert.equal(JSON.parse(options.body).stream, true);
    const events = [
      { created: 1, choices: [{ index: 0, delta: { content: '# Review\nVerdict: submit\nMode: bounty\nCounts: critical=0 high=1 medium=0 hardening=0 checked-safe=0\nHeadline: Verified via Bounty Operator API.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 500, completion_tokens: 40 } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const reviewReq = parseReviewRequest({
    provider: 'bountyoperator',
    model: 'glm-5.3-flash-cyber',
    apiKey: token,
    profile: 'general',
    files: [{ name: 'Vault.sol', content: 'contract Vault {}' }],
  });
  const ctx = createContext();
  const result = await runHostedReview(createCall(new Request('https://bountyoperator.com/api/review', { method: 'POST' }), env, ctx), account, reviewReq, 'web');
  await ctx.settled();
  assert.match(result.review, /Verified via Bounty Operator API/);
  assert.equal(env.DB.sqlite.prepare('SELECT charge_micro FROM inference_requests ORDER BY created_at DESC LIMIT 1').get().charge_micro, 100000);
});
