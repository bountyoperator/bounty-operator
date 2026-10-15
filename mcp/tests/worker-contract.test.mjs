// account and run_review against the real Worker code: the local server's
// requests are handed straight to the Worker's fetch handler, which runs on an
// in-memory database with the model provider stubbed. Nothing leaves the process.
//
// Skipped, with the reason, where the Worker cannot be loaded: web/node_modules
// not installed, or a Node without TypeScript type stripping.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROVIDER_KEY, TOKEN, VAULT, failure, project, reviewFor, server } from './helpers.mjs';

const WEB = new URL('../../web/', import.meta.url);
let skip = false;
if (!existsSync(fileURLToPath(new URL('node_modules/stripe', WEB)))) skip = 'web/node_modules is not installed; run "npm ci" in web/';
else if (!process.features.typescript) skip = 'this Node cannot load the Worker source; use Node 22.18 or later';

const load = async () => {
  const [worker, helpers, crypto] = await Promise.all([
    import(new URL('src/worker.ts', WEB)),
    import(new URL('tests/worker-helpers.mjs', WEB)),
    import(new URL('src/crypto.ts', WEB)),
  ]);
  return { worker: worker.default, ...helpers, sha256: crypto.sha256 };
};

/** A Worker with one account and one connection token, and a local server whose requests go to it. */
async function connected(t, files) {
  const { worker, createEnv, createContext, addAccount, sha256 } = await load();
  const env = createEnv();
  addAccount(env.DB, 'account-1');
  env.DB.sqlite
    .prepare('INSERT INTO api_tokens (token_hash, id, account_id, label, created_at, expires) VALUES (?, ?, ?, ?, ?, ?)')
    .run(await sha256(TOKEN), 'token-1', 'account-1', 'Local MCP', 1, Math.floor(Date.now() / 1000) + 3600);

  const toWorker = async (url, init) => {
    const ctx = createContext();
    const response = await worker.fetch(new Request(url, init), env, ctx);
    await ctx.settled();
    return response;
  };

  // The Worker calls the provider through the global fetch.
  const providerCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    providerCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({
      model: 'provider-reported-model',
      choices: [{ message: { content: reviewFor('input-1/src/Vault.sol') }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const cwd = await project(t, files);
  const local = (environment) => server({ cwd, fetch: toWorker, env: environment });
  return { local, providerCalls };
}

test('account reads the usage the Worker reports for the token', { skip }, async (t) => {
  const { local } = await connected(t, {});

  const result = await local({ BOUNTY_OPERATOR_TOKEN: TOKEN }).tool('account');
  assert.equal(result.isError, false);
  const { usage, price, limits, version } = result.structuredContent;
  assert.equal(usage.plan, 'free');
  assert.equal(usage.usedToday, 0);
  assert.equal(usage.remainingToday, 1);
  assert.equal(usage.concurrency, 1);
  assert.deepEqual(price, { usd: 10, interval: 'month', included_api_credit_usd: 2 });
  assert.equal(limits.files, 50);
  assert.equal(version, '0.9.18');

  const unknown = failure(await local({ BOUNTY_OPERATOR_TOKEN: `bok_${'Z'.repeat(43)}` }).tool('account'));
  assert.equal(unknown.code, 'token');
  assert.match(unknown.error, /expired or was revoked/);
});

test('run_review runs through the Worker on the provider key from the environment, then the daily allowance is used', { skip }, async (t) => {
  const { local, providerCalls } = await connected(t, { 'src/Vault.sol': VAULT });
  const { tool } = local({ BOUNTY_OPERATOR_TOKEN: TOKEN, OPENROUTER_API_KEY: PROVIDER_KEY });
  const args = { paths: ['src/Vault.sol'], provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', profile: 'solidity', mode: 'bounty', context: { target: 'Example vault' } };

  const result = await tool('run_review', args);
  assert.equal(result.isError, false, result.content[0].text);
  const ran = result.structuredContent;

  assert.equal(ran.verdict, 'prove-first');
  assert.equal(ran.headline, 'withdraw has no access check.');
  assert.deepEqual(ran.profile, { id: 'solidity', name: 'Solidity review' });
  assert.equal(ran.mode, 'bounty');
  assert.equal(ran.model, 'provider-reported-model');
  assert.equal(ran.truncated, false);
  assert.equal(ran.refused, false);
  assert.deepEqual(ran.usage, { input: 5, output: 7 });
  assert.equal(ran.manifest[0].label, 'input-1/src/Vault.sol');
  assert.deepEqual(ran.referenceProblems, [{ location: 'input-1/src/Vault.sol:40', problem: 'line-out-of-range' }]);
  assert.equal(ran.allowance.remainingToday, 0);
  assert.equal(ran.allowance.usedToday, 1);

  // What reached the provider: the key from this process's environment, the model named, and the file with line numbers.
  assert.equal(providerCalls.length, 1);
  assert.match(providerCalls[0].url, /^https:\/\/openrouter\.ai\//);
  assert.equal(providerCalls[0].headers.Authorization, `Bearer ${PROVIDER_KEY}`);
  assert.equal(providerCalls[0].body.model, 'anthropic/claude-sonnet-5.5');
  const user = providerCalls[0].body.messages.at(-1).content;
  assert.match(user, /### input-1\/src\/Vault\.sol/);
  assert.match(user, /2\|   function withdraw\(\) external \{\}/);
  assert.match(user, /Target: Example vault/);

  // The free plan has one hosted review per UTC day.
  const second = failure(await tool('run_review', args));
  assert.equal(second.code, 'daily_used');
  assert.match(second.resetsAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.equal(second.upgradeUrl, 'https://bountyoperator.com/pricing');
  assert.equal(providerCalls.length, 1);

  const account = await tool('account');
  assert.equal(account.structuredContent.usage.remainingToday, 0);
});

const CYBER_MODEL = {
  id: 'cyber-test', name: 'Cyber test', source: 'test/model', revision: 'fixture', license: 'Apache-2.0', quantization: 'AWQ',
  endpoint: 'https://contract.api.runpod.ai', upstreamModel: 'cyber-test',
  inputRate: 2, outputRate: 8, minimumMicro: 10000, context: 32768, maxOutput: 8192,
};

/**
 * A Worker with the Model API open on CYBER_MODEL, one account holding credit,
 * a connection token and an inference key. `toWorker` keeps each request's
 * context: a stream is read while the Worker writes it, so its work settles
 * after the response is returned.
 */
async function modelApi() {
  const { worker, createEnv, createContext, createCall, addAccount, sha256, funnelCounts, SITE_ORIGIN } = await load();
  const [{ createInferenceKey }, { enableSupplierFixture }] = await Promise.all([
    import(new URL('src/api-credits.ts', WEB)),
    import(new URL('tests/supplier-fixtures.mjs', WEB)),
  ]);
  const env = createEnv({ INFERENCE_ENABLED: 'true', RUNPOD_API_KEY: 'contract-vendor-key', INFERENCE_MODELS: JSON.stringify([CYBER_MODEL]) });
  addAccount(env.DB, 'account-1');
  enableSupplierFixture(env);
  env.DB.sqlite.prepare('INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES(?, ?, ?, ?, ?, ?)').run('contract-credit', 'account-1', 20000000, 'topup', 'fixture', 1);
  env.DB.sqlite
    .prepare('INSERT INTO api_tokens (token_hash, id, account_id, label, created_at, expires) VALUES (?, ?, ?, ?, ?, ?)')
    .run(await sha256(TOKEN), 'token-1', 'account-1', 'Local MCP', 1, Math.floor(Date.now() / 1000) + 7200);
  const created = await createInferenceKey(createCall(new Request(`${SITE_ORIGIN}/api/inference/keys/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Contract', budget_usd: 20 }),
  }), env), { account_id: 'account-1' });
  const { key } = await created.json();

  const contexts = [];
  const toWorker = async (url, init) => {
    const ctx = createContext();
    contexts.push(ctx);
    return worker.fetch(new Request(url, init), env, ctx);
  };
  const settled = async () => {
    for (const ctx of contexts) await ctx.settled();
  };
  const reviews = () => env.DB.sqlite.prepare('SELECT status, channel FROM reviews').all().map((row) => ({ ...row }));
  return { env, key, toWorker, settled, reviews, counts: () => funnelCounts(env.DB) };
}

test('run_review on a Bounty Operator model waits through an eight-minute cold start on the real Worker', { skip }, async (t) => {
  const { key, toWorker, settled, reviews } = await modelApi();

  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  // Time limits run on the same clock, so a client limit shorter than the start would end the call.
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), milliseconds);
    return controller.signal;
  });

  // The GPU worker answers its health probe with 503 until eight minutes have passed.
  const startedAt = Date.now();
  const WARM_AFTER_MS = 480000;
  let probes = 0;
  let generations = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === `${CYBER_MODEL.endpoint}/health`) {
      probes += 1;
      return new Response(null, { status: Date.now() - startedAt >= WARM_AFTER_MS ? 200 : 503 });
    }
    assert.equal(url, `${CYBER_MODEL.endpoint}/v1/chat/completions`);
    generations += 1;
    const chunk = (content, finish = null) => `data: ${JSON.stringify({ choices: [{ delta: content === null ? {} : { content }, finish_reason: finish }] })}\n\n`;
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 300 } })}\n\n`;
    return new Response(chunk(reviewFor('input-1/src/Vault.sol')) + chunk(null, 'stop') + usage + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const instance = server({ cwd: await project(t, {}), fetch: toWorker, env: { BOUNTY_OPERATOR_TOKEN: TOKEN, BOUNTYOPERATOR_API_KEY: key } });
  const notes = [];
  let answeredAt = null;
  const reply = instance.handle(
    {
      jsonrpc: '2.0', id: 'cold-1', method: 'tools/call',
      params: { name: 'run_review', arguments: { files: [{ name: 'src/Vault.sol', content: VAULT }], provider: 'bountyoperator', model: CYBER_MODEL.id, profile: 'solidity', mode: 'bounty' }, _meta: { progressToken: 'cold' } },
    },
    (notification) => notes.push({ at: Date.now() - startedAt, ...notification.params }),
  );
  void reply.then(() => { answeredAt = Date.now() - startedAt; });

  for (let elapsed = 0; elapsed < WARM_AFTER_MS + 60000 && answeredAt === null; elapsed += 5000) {
    t.mock.timers.tick(5000);
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  const result = (await reply).result;
  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(result.structuredContent.verdict, 'prove-first');
  assert.ok(answeredAt >= WARM_AFTER_MS, `the review came back after the start, at ${answeredAt / 1000} s`);
  assert.equal(generations, 1, 'the prompt is sent once, after the worker is up');
  assert.ok(probes > 1);

  // The agent's client heard that the model was starting, and kept hearing from the call past five minutes.
  assert.match(notes[0].message, /^Starting the model\. The first request after a quiet spell can take up to 10 minutes/);
  assert.ok(notes.some((note) => note.at > 300000), 'progress continued past 300 seconds');
  assert.ok(notes.every((note, index) => index === 0 || note.progress > notes[index - 1].progress), 'progress rises');

  await settled();
  assert.deepEqual(reviews(), [{ status: 'completed', channel: 'mcp' }]);
});

test('a warm Bounty Operator review the agent cancels mid-stream is not counted', { skip }, async (t) => {
  const { key, toWorker, settled, reviews, counts } = await modelApi();

  // The worker is warm and writes 2,500 characters, then holds the stream open.
  // RunPod meters every chunk, and the gateway holds output back until it can.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === `${CYBER_MODEL.endpoint}/health`) return new Response(null, { status: 200 });
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(2500) }, finish_reason: null }], usage: { prompt_tokens: 1200, completion_tokens: 600 } })}\n\n`));
        init.signal?.addEventListener('abort', () => {
          try {
            controller.error(init.signal.reason);
          } catch {
            // Already closed.
          }
        }, { once: true });
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // What the Worker has written to this client, kept as it arrives.
  let received = '';
  const decoder = new TextDecoder();
  const readWorker = async (url, init) => {
    const response = await toWorker(url, init);
    if (!response.body) return response;
    const counting = new TransformStream({
      transform(chunk, controller) {
        received += decoder.decode(chunk, { stream: true });
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(counting), response);
  };

  const instance = server({ cwd: await project(t, {}), fetch: readWorker, env: { BOUNTY_OPERATOR_TOKEN: TOKEN, BOUNTYOPERATOR_API_KEY: key } });
  const reply = instance.handle({
    jsonrpc: '2.0', id: 'cancel-1', method: 'tools/call',
    params: { name: 'run_review', arguments: { files: [{ name: 'src/Vault.sol', content: VAULT }], provider: 'bountyoperator', model: CYBER_MODEL.id, profile: 'solidity', mode: 'bounty' } },
  });
  const wrote = 'event: progress\ndata: {"chars":2500}';
  for (let turn = 0; turn < 200 && !received.includes(wrote); turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(received.includes(wrote), 'the Worker reported the 2,500 characters written');
  // Over MCP the review text does not cross the wire before `done`, so a caller
  // that reads the stream itself and leaves early has been given nothing.
  assert.doesNotMatch(received, /x{100}/);
  assert.doesNotMatch(received, /event: delta/);
  await instance.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-1' } });

  // A cancelled call is never answered: the agent saw none of those characters.
  assert.equal(await reply, null);
  await settled();
  assert.deepEqual(reviews(), [{ status: 'failed', channel: 'mcp' }]);
  assert.deepEqual(counts(), { review_fail: 1, 'review_fail:client_gone': 1 });

  // The free review of the day is still there.
  const account = await instance.tool('account');
  assert.equal(account.structuredContent.usage.usedToday, 0);
  assert.equal(account.structuredContent.usage.remainingToday, 1);
});

test('a hosted profile runs on the Worker: the method reaches the provider and never this client', { skip }, async (t) => {
  const { local, providerCalls } = await connected(t, { 'report.md': '# Draft\nwithdraw has no access check.\n', 'src/Vault.sol': VAULT });
  const { tool } = local({ BOUNTY_OPERATOR_TOKEN: TOKEN, OPENROUTER_API_KEY: PROVIDER_KEY });
  const { OPERATOR_PROFILES } = await import(new URL('src/operator-profiles.generated.mjs', WEB));
  const method = OPERATOR_PROFILES.scope;
  assert.ok(method.instructions.length > 100);

  // This package cannot prepare it.
  const refused = failure(await tool('prepare_review', { paths: ['report.md', 'src/Vault.sol'], profile: 'scope' }));
  assert.equal(refused.code, 'hosted_profile');
  assert.equal(providerCalls.length, 0);

  const result = await tool('run_review', { paths: ['report.md', 'src/Vault.sol'], provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', profile: 'scope' });
  assert.equal(result.isError, false, result.content[0].text);
  assert.deepEqual(result.structuredContent.profile, { id: 'scope', name: 'Scope and impact fit' });
  assert.equal(result.structuredContent.verdict, 'prove-first');

  // The provider received the method as part of the system message.
  assert.equal(providerCalls.length, 1);
  const system = providerCalls[0].body.messages[0].content;
  assert.ok(system.includes(method.instructions));
  assert.ok(system.includes(method.extraFormat));

  // Nothing this server returned repeats it.
  const returned = JSON.stringify(result);
  assert.ok(!returned.includes(method.instructions.slice(0, 60)));
  assert.equal(result.structuredContent.instructions, undefined);
  assert.equal(result.structuredContent.messages, undefined);
});
