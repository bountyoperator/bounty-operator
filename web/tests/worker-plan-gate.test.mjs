// The plan gate on the two profiles that exist only inside an Operator run:
// `verdict`, the last stage of the gauntlet, and `panel`, the cross-examination
// of a panel review. An account without an active Operator plan is refused on
// every entry point before the provider is called, and keeps its daily review.
//
// Each test drives the Worker's own fetch handler: a session cookie for
// /api/review, a connection token for /api/client/review and for run_review
// over /api/mcp. The provider is a stubbed fetch that counts its calls.

import assert from 'node:assert/strict';
import test from 'node:test';

import { PROFILES } from '../public/profiles.mjs';
import { sha256 } from '../src/crypto.ts';
import { ApiError } from '../src/http.ts';
import { assertPlanCovers, operatorOnly, parseReviewRequest, runHostedReview, streamHostedReview } from '../src/review.ts';
import worker from '../src/worker.ts';
import { SITE_ORIGIN, addAccount, addSubscription, createCall, createContext, createEnv, funnelCounts } from './worker-helpers.mjs';

const ACCOUNT = 'account-1';
const KEY = 'sk-test-key-0123456789';
const SESSION = 'S'.repeat(43);
const CSRF = 'C'.repeat(43);
const TOKEN = `bok_${'T'.repeat(43)}`;
const GATED = ['verdict', 'panel'];
const FILES = [
  { name: 'report.md', content: '# Draft\nwithdraw has no access check.\n' },
  { name: 'src/Vault.sol', content: 'contract Vault {\n  function withdraw() external {}\n}\n' },
];
const REVIEW = '# Review\nVerdict: prove-first\nMode: bounty\nCounts: critical=0 high=0 medium=0 hardening=0 checked-safe=0\nHeadline: The proof stops before the withdrawal.\n\n## Coverage\nReviewed: input-1/report.md\nNot supplied: none\n';

const encoder = new TextEncoder();

/** The provider: one JSON answer, or the same answer as a stream when the request asks for one. */
function provider(init) {
  const streaming = JSON.parse(init.body).stream === true;
  if (!streaming) {
    return Response.json({ model: 'gpt-test-2026', choices: [{ message: { content: REVIEW }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 34 } });
  }
  const pieces = [
    `data: ${JSON.stringify({ model: 'gpt-test-2026', choices: [{ delta: { content: REVIEW }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ model: 'gpt-test-2026', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

/** A Worker with one account that holds a session and a connection token. `plan` is free, operator or past_due. */
async function setup(t, plan = 'free') {
  const env = createEnv();
  addAccount(env.DB, ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  if (plan === 'operator') addSubscription(env.DB, { paidUntil: now + 86400 });
  if (plan === 'past_due') addSubscription(env.DB, { status: 'past_due', paidUntil: now + 86400 });
  if (plan === 'lapsed') addSubscription(env.DB, { paidUntil: now - 60 });
  env.DB.sqlite.prepare('INSERT INTO sessions (token_hash, account_id, csrf, expires, auth_at) VALUES (?, ?, ?, ?, ?)').run(await sha256(SESSION), ACCOUNT, CSRF, now + 3600, now);
  env.DB.sqlite
    .prepare('INSERT INTO api_tokens (token_hash, id, account_id, label, created_at, expires) VALUES (?, ?, ?, ?, ?, ?)')
    .run(await sha256(TOKEN), 'token-1', ACCOUNT, 'Test client', 1, now + 3600);

  const providerCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    providerCalls.push(String(url));
    return provider(init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const send = async (path, body, headers) => {
    const ctx = createContext();
    const response = await worker.fetch(new Request(`${SITE_ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, ctx);
    const text = await response.text();
    await ctx.settled();
    return { status: response.status, type: response.headers.get('Content-Type') ?? '', text };
  };

  const request = (profile, extra = {}) => ({ files: FILES, prompt: '', profile, provider: 'openai', model: 'gpt-test', mode: 'bounty', ...extra });

  return {
    env,
    providerCalls,
    reviews: () => env.DB.sqlite.prepare('SELECT status, profile, channel FROM reviews ORDER BY created_at, rowid').all().map((row) => ({ ...row })),
    /** POST /api/review as the signed-in browser. */
    web: (profile, extra) => send('/api/review', request(profile, { apiKey: KEY, ...extra }), { Origin: SITE_ORIGIN, Cookie: `__Host-bounty-session=${SESSION}`, 'X-CSRF-Token': CSRF }),
    /** POST /api/client/review, which the local MCP package calls for run_review. */
    client: (profile) => send('/api/client/review', request(profile, { apiKey: KEY }), { Authorization: `Bearer ${TOKEN}` }),
    /** run_review on the remote MCP endpoint. */
    mcp: (profile) => send('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_review', arguments: request(profile) } }, { Authorization: `Bearer ${TOKEN}`, 'X-Provider-Key': KEY }),
  };
}

function refusal(profileId) {
  const profile = PROFILES.find((entry) => entry.id === profileId);
  const part = profileId === 'verdict' ? 'the last stage of the gauntlet' : 'the cross-examination of a panel review';
  return {
    error: `${profile.name} is ${part}, which runs on Operator. Nothing was sent to the provider and today's review was not used.`,
    code: 'operator_only',
    profile: profileId,
    upgradeUrl: `${SITE_ORIGIN}/pricing`,
  };
}

test('the gated profiles are exactly the ones no form lists', () => {
  assert.deepEqual(PROFILES.filter((profile) => operatorOnly(profile.id)).map((profile) => profile.id), GATED);
  assert.deepEqual(PROFILES.filter((profile) => !profile.listed).map((profile) => profile.id), GATED);
});

test('POST /api/review refuses verdict and panel for a free account, as JSON and as a stream', async (t) => {
  const { web, providerCalls, reviews, env } = await setup(t, 'free');
  for (const profile of GATED) {
    for (const stream of [false, true]) {
      const answer = await web(profile, { stream });
      assert.equal(answer.status, 403, `${profile} stream=${stream}`);
      assert.match(answer.type, /^application\/json/, 'a refused stream is an ordinary JSON error');
      assert.deepEqual(JSON.parse(answer.text), refusal(profile));
    }
  }
  assert.equal(providerCalls.length, 0, 'the provider was never called');
  assert.deepEqual(reviews(), [], 'nothing was reserved');
  assert.deepEqual(funnelCounts(env.DB), {}, 'a refusal is not a quota hit and not a failed review');

  // The daily review is still there.
  const single = await web('triage');
  assert.equal(single.status, 200);
  assert.equal(JSON.parse(single.text).profile.id, 'triage');
  assert.deepEqual(reviews(), [{ status: 'completed', profile: 'triage', channel: 'web' }]);
  assert.equal(providerCalls.length, 1);
});

test('POST /api/review runs verdict and panel for an Operator account', async (t) => {
  const { web, providerCalls, reviews } = await setup(t, 'operator');
  for (const profile of GATED) {
    const answer = await web(profile);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(JSON.parse(answer.text).profile.id, profile);
  }
  const streamed = await web('verdict', { stream: true });
  assert.equal(streamed.status, 200);
  assert.match(streamed.type, /^text\/event-stream/);
  assert.match(streamed.text, /event: done/);
  assert.equal(providerCalls.length, 3);
  assert.deepEqual(reviews().map((row) => `${row.status}:${row.profile}`), ['completed:verdict', 'completed:panel', 'completed:verdict']);
});

test('POST /api/client/review refuses verdict and panel for a free account and runs them on Operator', async (t) => {
  const free = await setup(t, 'free');
  for (const profile of GATED) {
    const answer = await free.client(profile);
    assert.equal(answer.status, 403, profile);
    assert.deepEqual(JSON.parse(answer.text), refusal(profile));
  }
  assert.equal(free.providerCalls.length, 0);
  assert.deepEqual(free.reviews(), []);
  assert.equal((await free.client('scope')).status, 200, 'the daily review is still there');
  assert.deepEqual(free.reviews(), [{ status: 'completed', profile: 'scope', channel: 'mcp' }]);

  const paid = await setup(t, 'operator');
  for (const profile of GATED) {
    const answer = await paid.client(profile);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(JSON.parse(answer.text).profile.id, profile);
  }
  assert.equal(paid.providerCalls.length, 2);
});

test('MCP run_review refuses verdict and panel for a free account and runs them on Operator', async (t) => {
  const free = await setup(t, 'free');
  for (const profile of GATED) {
    const answer = await free.mcp(profile);
    assert.equal(answer.status, 200, 'a refused tool call is a tool result the agent can read');
    const { result } = JSON.parse(answer.text);
    assert.equal(result.isError, true, profile);
    assert.equal(result.structuredContent, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { profile, upgradeUrl: `${SITE_ORIGIN}/pricing`, error: refusal(profile).error, code: 'operator_only' });
  }
  assert.equal(free.providerCalls.length, 0);
  assert.deepEqual(free.reviews(), []);

  const single = JSON.parse((await free.mcp('severity')).text).result;
  assert.equal(single.isError, false, 'the daily review is still there');
  assert.equal(single.structuredContent.allowance.remainingToday, 0);

  const paid = await setup(t, 'operator');
  for (const profile of GATED) {
    const { result } = JSON.parse((await paid.mcp(profile)).text);
    assert.equal(result.isError, false, profile);
    assert.equal(result.structuredContent.profile.id, profile);
    assert.equal(result.structuredContent.allowance.plan, 'weekly');
  }
  assert.equal(paid.providerCalls.length, 2);
});

test('a failed payment or a lapsed period is not an Operator plan', async (t) => {
  for (const plan of ['past_due', 'lapsed']) {
    const { web, client, mcp, providerCalls, reviews } = await setup(t, plan);
    assert.equal((await web('verdict')).status, 403, plan);
    assert.equal((await client('panel')).status, 403, plan);
    assert.equal(JSON.parse(JSON.parse((await mcp('verdict')).text).result.content[0].text).code, 'operator_only', plan);
    assert.equal(providerCalls.length, 0);
    assert.deepEqual(reviews(), []);
  }
});

test('the gate comes before the inputs are read and before the allowance', async (t) => {
  const { env, web, providerCalls, reviews } = await setup(t, 'free');

  // Files that would fail the size check, and a secret that would block: the plan is answered first.
  assert.equal(JSON.parse((await web('verdict', { files: [] })).text).code, 'operator_only');
  assert.equal(JSON.parse((await web('panel', { files: [{ name: 'deploy.sh', content: 'export AWS=AKIAIOSFODNN7EXAMPLE\n' }] })).text).code, 'operator_only');

  // With today's review already used, the answer is still the plan, not the allowance.
  assert.equal((await web('scope')).status, 200);
  const after = JSON.parse((await web('verdict')).text);
  assert.equal(after.code, 'operator_only');
  assert.equal(after.resetsAt, undefined);
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(reviews(), [{ status: 'completed', profile: 'scope', channel: 'web' }]);
  assert.equal(funnelCounts(env.DB).quota_hit, undefined);
});

test('runHostedReview and streamHostedReview hold the gate themselves, whatever calls them', async (t) => {
  const { env, providerCalls } = await setup(t, 'free');
  const ctx = createContext();
  const call = createCall(new Request(`${SITE_ORIGIN}/api/review`, { method: 'POST' }), env, ctx);
  const input = (profile) => parseReviewRequest({ files: FILES, profile, provider: 'openai', model: 'gpt-test', apiKey: KEY });

  for (const run of [runHostedReview, streamHostedReview]) {
    for (const profile of GATED) {
      await assert.rejects(run(call, ACCOUNT, input(profile), 'web'), (error) => error instanceof ApiError && error.status === 403 && error.code === 'operator_only');
    }
  }
  await assert.rejects(assertPlanCovers(env, ACCOUNT, 'verdict'), (error) => error.code === 'operator_only');
  // A listed profile is not the gate's business, on any plan.
  for (const profile of PROFILES.filter((entry) => entry.listed)) await assertPlanCovers(env, ACCOUNT, profile.id);
  assert.equal(providerCalls.length, 0);
});

test('paused reviews are reported before the plan', async (t) => {
  const { env, web } = await setup(t, 'free');
  env.AI_REVIEW_ENABLED = 'false';
  assert.equal(JSON.parse((await web('verdict')).text).code, 'reviews_paused');
});
