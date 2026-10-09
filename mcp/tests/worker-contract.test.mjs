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
  assert.deepEqual(price, { usd: 10, interval: 'week' });
  assert.equal(limits.files, 50);
  assert.equal(version, '0.8.4');

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
