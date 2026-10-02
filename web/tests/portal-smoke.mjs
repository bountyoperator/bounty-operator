// Integration check against a local `wrangler dev` and its disposable D1 file.
// It uses software passkeys, sends nothing to a model provider and creates no
// payment. The database path must be inside .local/dev-v070.
//
//   node tests/portal-smoke.mjs http://localhost:8799 <path to the local D1 .sqlite file>

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createBrowser, createPasskey } from './worker-helpers.mjs';

const origin = process.argv[2] || 'http://localhost:8787';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Run this against a local development server only.');

const disposableRoot = resolve(fileURLToPath(new URL('../../.local/dev-v070/', import.meta.url)));
const databasePath = resolve(process.argv[3] || '');
assert(databasePath.startsWith(disposableRoot + sep), 'Pass the disposable database under .local/dev-v070.');

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;');
// Earlier runs from this machine must not trip the per-address limits.
db.exec('DELETE FROM rate_limits');

const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);

/** A call with a connection token instead of a session. */
async function client(path, token, body, { status = 200, code, headers = {} } = {}) {
  const isPost = body !== undefined;
  const response = await fetch(origin + path, {
    method: isPost ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(isPost ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(isPost ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.equal(response.status, status, `${path}: ${result.error}`);
  if (code) assert.equal(result.code, code, path);
  return result;
}

async function mcp(method, params, headers = {}) {
  const response = await fetch(`${origin}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function reviewCount(accountId) {
  return db.prepare('SELECT COUNT(*) AS total FROM reviews WHERE account_id = ?').get(accountId).total;
}

const alice = createBrowser(origin);
const bob = createBrowser(origin);
const accountIds = [];

try {
  const { passkey: firstPasskey, recoveryCode } = await alice.register();
  await bob.register();

  // --- Two accounts see only their own data -------------------------------
  const alicePortal = await alice.call('/api/portal');
  const bobPortal = await bob.call('/api/portal');
  accountIds.push(alicePortal.account.id, bobPortal.account.id);
  assert.notEqual(alicePortal.account.id, bobPortal.account.id);
  assert.deepEqual(alicePortal.passkeys.map((key) => key.id), [firstPasskey.id]);
  assert.equal(alicePortal.account.hasSubscription, false);

  // --- Connection tokens ---------------------------------------------------
  const aliceToken = await alice.call('/api/connections/create', { label: 'Local check A' });
  const bobToken = await bob.call('/api/connections/create', { label: 'Local check B' });
  assert.match(aliceToken.token, /^bok_[A-Za-z0-9_-]{43}$/);
  await alice.call('/api/connections/create', { label: 'Bad CSRF' }, { status: 403, code: 'csrf', headers: { 'X-CSRF-Token': 'invalid' } });
  await alice.call('/api/connections/create', { label: 'Bad origin' }, { status: 403, code: 'origin', headers: { Origin: 'https://unrelated.invalid' } });
  await alice.call('/api/connections/create', { label: '' }, { status: 400 });

  // Three requests race for the two remaining slots: exactly one loses.
  const { csrf } = await alice.call('/api/account');
  const cookie = [...alice.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const raced = await Promise.all(
    [1, 2, 3].map(async (index) => {
      const response = await fetch(`${origin}/api/connections/create`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ label: `Concurrent ${index}` }),
      });
      return response.status;
    }),
  );
  assert.deepEqual(raced.sort(), [200, 200, 400]);

  // Revoking someone else's token id does nothing.
  await alice.call('/api/connections/revoke', { id: bobToken.id });
  await client('/api/client/account', bobToken.token);

  // A token reads usage and runs reviews. It opens nothing else.
  await client('/api/client/account', `bok_${'Z'.repeat(43)}`, undefined, { status: 401, code: 'token' });
  await client('/api/client/account', aliceToken.token, undefined, { status: 403, code: 'origin', headers: { Origin: 'https://unrelated.invalid' } });
  await client('/api/portal', aliceToken.token, undefined, { status: 401, code: 'signin' });
  await client('/api/billing/portal', aliceToken.token, {}, { status: 401, code: 'signin', headers: { Origin: origin } });

  // --- Passkeys ------------------------------------------------------------
  await alice.call('/api/passkeys/remove', { id: bobPortal.passkeys[0].id }, { status: 400, code: 'last_passkey' });

  const secondPasskey = createPasskey(origin);
  const addOptions = await alice.call('/api/auth/add/options', {});
  await alice.call('/api/auth/add/verify', secondPasskey.register(addOptions));

  // Removing a passkey signs out the account's other sessions.
  const aliceOtherDevice = createBrowser(origin);
  await aliceOtherDevice.signIn(firstPasskey);
  await aliceOtherDevice.call('/api/portal');
  await alice.call('/api/passkeys/remove', { id: firstPasskey.id });
  await aliceOtherDevice.call('/api/portal', undefined, { status: 401, code: 'signin' });
  await alice.call('/api/portal');
  await alice.call('/api/passkeys/remove', { id: secondPasskey.id }, { status: 400, code: 'last_passkey' });

  // --- Credential changes need a recent passkey check -----------------------
  db.prepare('UPDATE sessions SET auth_at = ? WHERE account_id = ?').run(now() - 601, alicePortal.account.id);
  for (const [path, body] of [
    ['/api/auth/rotate-recovery', {}],
    ['/api/auth/add/options', {}],
    ['/api/passkeys/remove', { id: secondPasskey.id }],
    ['/api/connections/create', { label: 'Needs passkey' }],
    ['/api/account/delete', {}],
  ]) {
    await alice.call(path, body, { status: 401, code: 'reauth' });
  }
  // Confirming with the passkey keeps the same session and CSRF token.
  const confirmed = await alice.signIn(secondPasskey);
  assert.equal(confirmed.csrf, csrf);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM sessions WHERE account_id = ?').get(alicePortal.account.id).total, 1);

  // --- Hosted reviews: validation comes before the allowance ----------------
  const files = [{ name: 'src/Owned.sol', content: 'contract Example {}\n' }];
  const validRequest = { files, prompt: 'Review the selected source.', profile: 'solidity', provider: 'openai', model: 'local-fixture', apiKey: 'sk-local-fixture-0000' };

  await client('/api/client/review', aliceToken.token, { ...validRequest, provider: 'unsupported' }, { status: 400, code: 'bad_provider' });
  await client('/api/client/review', aliceToken.token, { ...validRequest, model: 'has spaces' }, { status: 400, code: 'bad_model' });
  await client('/api/client/review', aliceToken.token, { ...validRequest, apiKey: 'short' }, { status: 400, code: 'bad_key' });
  await client('/api/client/review', aliceToken.token, { ...validRequest, profile: 'nope' }, { status: 400, code: 'bad_profile' });
  await client('/api/client/review', aliceToken.token, { ...validRequest, files: [] }, { status: 400, code: 'bad_input' });
  const blocked = await client(
    '/api/client/review',
    aliceToken.token,
    { ...validRequest, files: [{ name: 'deploy.sh', content: 'export AWS=AKIAIOSFODNN7EXAMPLE\n' }] },
    { status: 422, code: 'privacy_block' },
  );
  assert.deepEqual(blocked.findings.map((finding) => finding.kind), ['aws-key']);
  await alice.call('/api/review', { ...validRequest, stream: true, provider: 'unsupported' }, { status: 400, code: 'bad_provider' });

  assert.equal(reviewCount(alicePortal.account.id), 0, 'no rejected request reserved a review');
  assert.equal((await client('/api/client/account', aliceToken.token)).usage.remainingToday, 1);

  // --- The allowance is shared by the website and the token ------------------
  const insertReview = db.prepare(
    'INSERT INTO reviews (id, account_id, day, status, lease_until, created_at, profile, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const fixtureId = `fixture-${randomBytes(12).toString('hex')}`;
  insertReview.run(fixtureId, alicePortal.account.id, today(), 'running', now() + 120, now(), 'solidity', 'mcp');
  assert.equal((await client('/api/client/account', aliceToken.token)).usage.running, 1);
  await client('/api/client/review', aliceToken.token, validRequest, { status: 409, code: 'review_running' });
  await alice.call('/api/review', validRequest, { status: 409, code: 'review_running' });

  db.prepare("UPDATE reviews SET status = 'completed' WHERE id = ?").run(fixtureId);
  assert.equal((await client('/api/client/account', aliceToken.token)).usage.remainingToday, 0);
  const used = await client('/api/client/review', aliceToken.token, validRequest, { status: 429, code: 'daily_used' });
  assert.match(used.resetsAt, /T00:00:00\.000Z$/);
  await alice.call('/api/review', validRequest, { status: 429, code: 'daily_used' });
  await alice.call('/api/review', { ...validRequest, stream: true }, { status: 429, code: 'daily_used' });

  // --- The MCP endpoint ------------------------------------------------------
  const initialized = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  assert.equal(initialized.body.result.serverInfo.name, 'bounty-operator');
  const listed = await mcp('tools/list');
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ['list_profiles', 'prepare_review', 'build_packet', 'account', 'run_review']);

  const prepared = await mcp('tools/call', { name: 'prepare_review', arguments: { files, profile: 'solidity' } });
  assert.equal(prepared.body.result.isError, false);
  assert.equal(prepared.body.result.structuredContent.manifest[0].label, 'input-1/src/Owned.sol');
  assert(!JSON.stringify(prepared.body).includes('contract Example'), 'file contents are not echoed');

  const anonymous = await mcp('tools/call', { name: 'account', arguments: {} });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /^Bearer/);
  const withToken = await mcp('tools/call', { name: 'account', arguments: {} }, { Authorization: `Bearer ${aliceToken.token}` });
  assert.equal(withToken.body.result.structuredContent.usage.remainingToday, 0);
  const mcpReview = await mcp(
    'tools/call',
    { name: 'run_review', arguments: { files, provider: 'openai' } },
    { Authorization: `Bearer ${aliceToken.token}`, 'X-Provider-Key': 'sk-local-fixture-0000' },
  );
  assert.equal(mcpReview.body.result.isError, true);
  assert.equal(JSON.parse(mcpReview.body.result.content[0].text).code, 'daily_used');

  // --- Events ----------------------------------------------------------------
  const eventsBefore = db.prepare("SELECT COALESCE(SUM(n), 0) AS total FROM funnel_daily WHERE event = 'prompt_exported'").get().total;
  await alice.call('/api/event', { event: 'prompt_exported' }, { status: 204 });
  await alice.call('/api/event', { event: 'made_up_event' }, { status: 400, code: 'bad_event' });
  await alice.call('/api/event', { event: 'prompt_exported' }, { status: 403, code: 'origin', headers: { Origin: 'https://unrelated.invalid' } });
  // The counter is written after the response.
  await new Promise((done) => setTimeout(done, 300));
  const eventsAfter = db.prepare("SELECT COALESCE(SUM(n), 0) AS total FROM funnel_daily WHERE event = 'prompt_exported'").get().total;
  assert.equal(eventsAfter, eventsBefore + 1);
  assert(db.prepare("SELECT n FROM funnel_daily WHERE event = 'register' AND day = ?").get(today()).n >= 2);
  assert(db.prepare("SELECT n FROM funnel_daily WHERE event = 'quota_hit' AND day = ?").get(today()).n >= 1);

  // --- Export ----------------------------------------------------------------
  const exported = await alice.call('/api/account/export');
  const serialized = JSON.stringify(exported);
  for (const secret of [aliceToken.token, bobToken.token, recoveryCode]) assert(!serialized.includes(secret));
  for (const field of ['token_hash', 'public_key', 'csrf', 'recovery_hash']) assert(!serialized.includes(`"${field}"`));
  assert(exported.reviews.some((review) => review.channel === 'mcp' && review.profile === 'solidity' && review.status === 'completed'));

  // --- Deletion waits for a live subscription to end ---------------------------
  db.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ?').run(`cus_fixture_${alicePortal.account.id}`, alicePortal.account.id);
  const insertSubscription = db.prepare('INSERT INTO subscriptions (id, account_id, status, paid_until, updated_at) VALUES (?, ?, ?, ?, ?)');
  insertSubscription.run('sub_fixture_live', alicePortal.account.id, 'active', now() + 3600, now());
  const subscribed = await alice.call('/api/account');
  assert.equal(subscribed.hasSubscription, true);
  assert.equal(subscribed.usage.plan, 'weekly');
  assert.equal(subscribed.usage.concurrency, 4);
  assert.equal(subscribed.usage.remainingToday, null);
  await alice.call('/api/account/delete', {}, { status: 409, code: 'billing_exists' });
  db.prepare("UPDATE subscriptions SET status = 'canceled', paid_until = 0 WHERE id = 'sub_fixture_live'").run();
  assert.equal((await alice.call('/api/account')).hasSubscription, false, 'an abandoned or ended subscription does not block deletion');

  // Billing is off in local development: the route answers with a coded error.
  await alice.call('/api/billing/checkout', {}, { status: 503, code: 'billing_unavailable' });

  // --- Expiry, recovery and logout-all revoke tokens ---------------------------
  db.prepare('UPDATE api_tokens SET expires = 0 WHERE id = ?').run(aliceToken.id);
  await client('/api/client/account', aliceToken.token, undefined, { status: 401, code: 'token' });

  const replacement = await alice.call('/api/connections/create', { label: 'Recovery check' });
  const rotated = await alice.call('/api/auth/rotate-recovery', {});
  await alice.call('/api/auth/recover', { code: recoveryCode }, { status: 400, code: 'recovery' });
  await alice.call('/api/auth/recover', { code: rotated.recoveryCode });
  await client('/api/client/account', replacement.token, undefined, { status: 401, code: 'token' });

  const last = await alice.call('/api/connections/create', { label: 'Logout check' });
  await alice.call('/api/auth/logout-all', {});
  await alice.call('/api/portal', undefined, { status: 401, code: 'signin' });
  await client('/api/client/account', last.token, undefined, { status: 401, code: 'token' });
  await client('/api/client/account', bobToken.token);

  console.log(
    'Passed: account isolation, connection tokens (limit, race, expiry, revocation), passkey removal, recent-passkey checks, ' +
      'validation before reservation, shared allowance, MCP endpoint, events, export, deletion rules, recovery, logout-all.',
  );
} finally {
  for (const id of accountIds) db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  db.close();
}
