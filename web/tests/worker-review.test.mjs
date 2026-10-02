// Hosted reviews end to end, against the real engine and an in-memory database.
// The provider is a stubbed fetch: nothing leaves the machine.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderError } from '../public/providers.mjs';
import { ApiError } from '../src/http.ts';
import { parseReviewRequest, reviewFailure, runHostedReview, streamHostedReview } from '../src/review.ts';
import { SITE_ORIGIN, addAccount, addSubscription, createCall, createContext, createEnv, funnelCounts } from './worker-helpers.mjs';

const ACCOUNT = 'account-1';
const KEY = 'sk-test-key-0123456789';
const REVIEW_TEXT = '# Review\nVerdict: no-blocking-issues\nMode: own-code\nCounts: critical=0 high=0 medium=0 hardening=0 checked-safe=0\nHeadline: Nothing blocks.\n';

function body(overrides = {}) {
  return {
    files: [{ name: 'src/Vault.sol', content: 'contract Vault {}\n' }],
    prompt: '',
    profile: 'solidity',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: KEY,
    mode: 'own-code',
    ...overrides,
  };
}

function setup(t, respond) {
  const env = createEnv();
  addAccount(env.DB, ACCOUNT);
  const ctx = createContext();
  const disconnect = new AbortController();
  const request = new Request(`${SITE_ORIGIN}/api/review`, { method: 'POST', signal: disconnect.signal });

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return { env, ctx, call: createCall(request, env, ctx), calls, disconnect };
}

function reviews(env) {
  return env.DB.sqlite.prepare('SELECT status, profile, channel FROM reviews ORDER BY created_at, rowid').all().map((row) => ({ ...row }));
}

function completion(text = REVIEW_TEXT, extra = {}) {
  return Response.json({
    model: 'gpt-test-2026',
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1200, completion_tokens: 300 },
    ...extra,
  });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test('parseReviewRequest resolves the profile and the default model', () => {
  const parsed = parseReviewRequest(body({ model: undefined }));
  assert.equal(parsed.profileId, 'solidity');
  assert.equal(parsed.provider, 'openai');
  assert.equal(parsed.model, 'gpt-6.1-sol');
  assert.equal(parseReviewRequest(body({ profile: undefined })).profileId, 'general');
});

test('parseReviewRequest gives each mistake its own code', () => {
  const codeOf = (overrides, apiKey) => {
    try {
      parseReviewRequest(body(overrides), apiKey);
    } catch (error) {
      assert(error instanceof ApiError);
      assert.equal(error.status, 400);
      return error.code;
    }
    return null;
  };

  assert.equal(codeOf({ profile: 'no-such-profile' }), 'bad_profile');
  assert.equal(codeOf({ profile: 42 }), 'bad_profile');
  assert.equal(codeOf({ provider: 'unsupported' }), 'bad_provider');
  assert.equal(codeOf({ provider: undefined }), 'bad_provider');
  assert.equal(codeOf({ provider: 'constructor' }), 'bad_provider');
  assert.equal(codeOf({ model: 'has spaces' }), 'bad_model');
  assert.equal(codeOf({ model: 'x'.repeat(201) }), 'bad_model');
  assert.equal(codeOf({ apiKey: 'short' }), 'bad_key');
  assert.equal(codeOf({ apiKey: undefined }), 'bad_key');
  assert.equal(codeOf({ apiKey: 'key with\nnewline-0123456789' }), 'bad_key');
  assert.equal(codeOf({ prompt: 42 }), 'bad_input');
  assert.equal(codeOf({}, null), 'bad_key', 'a key passed outside the body replaces the one inside it');
});

test('a request that fails validation reserves nothing and sends nothing', async (t) => {
  const { env, ctx, call, calls } = setup(t, () => completion());

  const cases = [
    [{ files: [] }, 400, 'bad_input'],
    [{ files: [{ name: '../etc/passwd', content: 'x' }] }, 400, 'bad_input'],
    [{ files: [{ name: 'big.txt', content: 'x'.repeat(120001) }] }, 400, 'bad_input'],
    [{ context: { proof: 'maybe' } }, 400, 'bad_input'],
    [{ profile: 'general', mode: 'sideways' }, 400, 'bad_input'],
  ];
  for (const [overrides, status, code] of cases) {
    const error = await rejection(runHostedReview(call, ACCOUNT, parseReviewRequest(body(overrides)), 'web'));
    assert(error instanceof ApiError, JSON.stringify(overrides));
    assert.equal(error.status, status);
    assert.equal(error.code, code);
  }

  await ctx.settled();
  assert.deepEqual(reviews(env), []);
  assert.deepEqual(funnelCounts(env.DB), {});
  assert.equal(calls.length, 0);
});

test('a secret in the files blocks the review and lists where, without the secret', async (t) => {
  const { env, call, calls } = setup(t, () => completion());
  const files = [{ name: 'deploy.sh', content: 'echo ok\nexport AWS=AKIAIOSFODNN7EXAMPLE\n' }];

  const error = await rejection(runHostedReview(call, ACCOUNT, parseReviewRequest(body({ files })), 'web'));
  assert.equal(error.status, 422);
  assert.equal(error.code, 'privacy_block');
  assert.deepEqual(error.extra.findings, [{ source: 'input-1', name: 'deploy.sh', line: 2, kind: 'aws-key', severity: 'block' }]);
  assert(!JSON.stringify(error.extra).includes('AKIA'));
  assert.deepEqual(reviews(env), []);
  assert.equal(calls.length, 0);
});

test('an email address is a warning the user can acknowledge', async (t) => {
  const { env, ctx, call, calls } = setup(t, () => completion());
  const files = [{ name: 'Vault.sol', content: '/// @author dev@company.io\ncontract Vault {}\n' }];

  const error = await rejection(runHostedReview(call, ACCOUNT, parseReviewRequest(body({ files })), 'web'));
  assert.equal(error.status, 422);
  assert.equal(error.code, 'privacy_warn');
  assert.equal(error.extra.findings[0].kind, 'email-address');
  assert.equal(calls.length, 0);

  const result = await runHostedReview(call, ACCOUNT, parseReviewRequest(body({ files, acknowledgeWarnings: true })), 'web');
  assert.equal(result.review, REVIEW_TEXT);
  await ctx.settled();
  assert.equal(reviews(env).length, 1);
});

test('reviews can be paused without touching anything else', async (t) => {
  const { env, call, calls } = setup(t, () => completion());
  env.AI_REVIEW_ENABLED = 'false';
  const error = await rejection(runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web'));
  assert.equal(error.status, 503);
  assert.equal(error.code, 'reviews_paused');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// One-answer reviews
// ---------------------------------------------------------------------------

test('a completed review returns the answer and is counted afterwards', async (t) => {
  const { env, ctx, call, calls } = setup(t, () => completion());

  const result = await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  assert.equal(result.review, REVIEW_TEXT);
  assert.deepEqual(result.profile, { id: 'solidity', name: 'Solidity review' });
  assert.equal(result.mode, 'own-code');
  assert.equal(result.model, 'gpt-test-2026');
  assert.equal(result.truncated, false);
  assert.equal(result.refused, false);
  assert.deepEqual(result.usage, { input: 1200, output: 300 });
  assert.equal(result.manifest[0].label, 'input-1/src/Vault.sol');
  assert.match(result.manifest[0].sha256, /^[0-9a-f]{64}$/);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);

  await ctx.settled();
  assert.deepEqual(reviews(env), [{ status: 'completed', profile: 'solidity', channel: 'web' }]);
  assert.deepEqual(funnelCounts(env.DB), { 'review_ok:solidity': 1 });
});

test('a review the provider wrote is returned even when the bookkeeping write fails', async (t) => {
  const { env, ctx, call } = setup(t, () => completion());
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => {
    if (sql.startsWith('UPDATE reviews SET status = ?')) throw new Error('database is down');
    return prepare(sql);
  };
  t.mock.method(console, 'error', () => {});

  const result = await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  assert.equal(result.review, REVIEW_TEXT);
  await ctx.settled();
  assert.equal(console.error.mock.callCount(), 1);
  assert.deepEqual(console.error.mock.calls[0].arguments, ['Review bookkeeping failed', { name: 'Error' }]);
});

test('a provider failure gives the allowance back and reports the cause', async (t) => {
  const { env, ctx, call } = setup(t, () =>
    Response.json({ error: { message: `Incorrect API key provided: ${KEY}` } }, { status: 401 }),
  );

  const error = await rejection(runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web'));
  assert(error instanceof ApiError);
  assert.equal(error.status, 502);
  assert.equal(error.code, 'provider');
  assert.equal(error.extra.kind, 'auth');
  assert.match(error.message, /^Provider rejected the API key/);
  assert(!error.message.includes(KEY));

  await ctx.settled();
  assert.deepEqual(reviews(env), [{ status: 'failed', profile: 'solidity', channel: 'web' }]);
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1 });
});

test('a refusal is returned but not counted against the day', async (t) => {
  const { env, ctx, call } = setup(t, () =>
    Response.json({ model: 'gpt-test', choices: [{ message: { content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }] }),
  );
  const result = await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  assert.equal(result.refused, true);
  await ctx.settled();
  assert.equal(reviews(env)[0].status, 'failed');
});

test('the free review of the day, then daily_used with the reset time', async (t) => {
  const { env, ctx, call, calls } = setup(t, () => completion());

  await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'mcp');
  await ctx.settled();

  const error = await rejection(runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web'));
  assert.equal(error.status, 429);
  assert.equal(error.code, 'daily_used');
  assert.match(error.extra.resetsAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.equal(error.extra.upgradeUrl, 'https://bountyoperator.com/pricing');
  assert.equal(calls.length, 1, 'the second review never reached the provider');

  await ctx.settled();
  assert.deepEqual(funnelCounts(env.DB), { quota_hit: 1, 'review_ok:solidity': 1 });
  assert.deepEqual(reviews(env), [{ status: 'completed', profile: 'solidity', channel: 'mcp' }]);
});

test('a second review while one runs is review_running, not daily_used', async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { ctx, call } = setup(t, async () => {
    await held;
    return completion();
  });

  const first = runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  // Let the first call reach the provider before the second one starts.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const error = await rejection(runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web'));
  assert.equal(error.status, 409);
  assert.equal(error.code, 'review_running');

  release();
  await first;
  await ctx.settled();
});

test('an Operator account runs four reviews at once', async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { env, ctx, call } = setup(t, async () => {
    await held;
    return completion();
  });
  addSubscription(env.DB, { account: ACCOUNT, paidUntil: Math.floor(Date.now() / 1000) + 86400 });

  const running = [1, 2, 3, 4].map(() => runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const fifth = await rejection(runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web'));
  assert.equal(fifth.code, 'review_running');

  release();
  const results = await Promise.all(running);
  assert.equal(results.length, 4);
  await ctx.settled();
  assert.equal(reviews(env).filter((row) => row.status === 'completed').length, 4);
});

// ---------------------------------------------------------------------------
// Streamed reviews
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function chunk(content, finish = null) {
  const choice = { delta: content === null ? {} : { content }, finish_reason: finish };
  return `data: ${JSON.stringify({ model: 'gpt-test-2026', choices: [choice] })}\n\n`;
}

/** A provider stream the test feeds by hand. It ends in an error when the request is aborted. */
function providerStream(init) {
  let controller;
  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
  });
  init.signal?.addEventListener('abort', () => {
    try {
      controller.error(new DOMException('The operation was aborted.', 'AbortError'));
    } catch {
      // Already closed.
    }
  });
  return {
    response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    signal: init.signal,
  };
}

function parseEvents(text) {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) };
    });
}

test('a streamed review sends deltas, then done with the whole review', async (t) => {
  let provider;
  const { env, ctx, call, calls } = setup(t, (init) => {
    provider = providerStream(init);
    return provider.response;
  });

  const response = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  assert.equal(JSON.parse(calls[0].init.body).stream, true);

  provider.push(chunk('# Review\n'));
  provider.push(chunk('Verdict: no-blocking-issues\n'));
  provider.push(chunk(null, 'stop'));
  provider.push('data: [DONE]\n\n');
  provider.close();

  const events = parseEvents(await response.text());
  assert.deepEqual(events.map((item) => item.event), ['delta', 'delta', 'done']);
  assert.deepEqual(events[0].data, { text: '# Review\n' });

  const done = events[2].data;
  assert.equal(done.review, '# Review\nVerdict: no-blocking-issues\n');
  assert.deepEqual(done.profile, { id: 'solidity', name: 'Solidity review' });
  assert.equal(done.model, 'gpt-test-2026');
  assert.equal(done.truncated, false);
  assert.equal(done.refused, false);
  assert.equal(done.manifest[0].label, 'input-1/src/Vault.sol');
  assert.deepEqual(Object.keys(done).sort(), ['manifest', 'mode', 'model', 'profile', 'refused', 'review', 'truncated', 'usage']);

  await ctx.settled();
  assert.deepEqual(reviews(env), [{ status: 'completed', profile: 'solidity', channel: 'web' }]);
  assert.deepEqual(funnelCounts(env.DB), { 'review_ok:solidity': 1 });
});

test('a key the provider rejects fails a streamed review before any event, as a plain error', async (t) => {
  const { env, ctx, call } = setup(t, () => Response.json({ error: { message: 'Invalid key' } }, { status: 401 }));

  const error = await rejection(streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web'));
  assert(error instanceof ApiError);
  assert.equal(error.code, 'provider');
  assert.equal(error.extra.kind, 'auth');

  await ctx.settled();
  assert.deepEqual(reviews(env), [{ status: 'failed', profile: 'solidity', channel: 'web' }]);
});

test('a provider error in the middle of a stream becomes an error event and frees the allowance', async (t) => {
  let provider;
  const { env, ctx, call } = setup(t, (init) => {
    provider = providerStream(init);
    return provider.response;
  });

  const response = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  provider.push(chunk('# Review\n'));
  provider.push(`data: ${JSON.stringify({ error: { message: 'Upstream overloaded' } })}\n\n`);

  const events = parseEvents(await response.text());
  assert.deepEqual(events.map((item) => item.event), ['delta', 'error']);
  assert.equal(events[1].data.code, 'provider');
  assert.match(events[1].data.error, /^Provider returned an error: Upstream overloaded/);

  await ctx.settled();
  assert.deepEqual(reviews(env), [{ status: 'failed', profile: 'solidity', channel: 'web' }]);
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1 });
});

test('a client that disconnects early stops the provider call and releases the lease', async (t) => {
  let provider;
  const { env, ctx, call, disconnect } = setup(t, (init) => {
    provider = providerStream(init);
    return provider.response;
  });

  const response = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  const reader = response.body.getReader();
  provider.push(chunk('# Review\n'));
  await reader.read();

  disconnect.abort();
  await reader.cancel();
  await ctx.settled();

  assert.equal(provider.signal.aborted, true, 'the provider request was aborted');
  assert.deepEqual(reviews(env), [{ status: 'failed', profile: 'solidity', channel: 'web' }]);

  // The slot is free again at once: no waiting for the lease to run out.
  const next = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  provider.push(chunk(null, 'stop'));
  provider.close();
  await next.body.cancel();
  await ctx.settled();
});

test('a stream the provider breaks off after a few characters is delivered and not counted', async (t) => {
  let provider;
  const { env, ctx, call } = setup(t, (init) => {
    provider = providerStream(init);
    return provider.response;
  });

  const response = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  provider.push(chunk('# Review\n'));
  provider.close();

  const events = parseEvents(await response.text());
  assert.deepEqual(events.map((item) => item.event), ['delta', 'done']);
  assert.equal(events[1].data.truncated, true);
  assert.equal(events[1].data.review, '# Review\n');

  await ctx.settled();
  assert.deepEqual(reviews(env), [{ status: 'failed', profile: 'solidity', channel: 'web' }]);
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1 });
});

test('a long answer cut at the output limit is a review and is counted', async (t) => {
  let provider;
  const { env, ctx, call } = setup(t, (init) => {
    provider = providerStream(init);
    return provider.response;
  });

  const response = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  provider.push(chunk('x'.repeat(2500)));
  provider.push(chunk(null, 'length'));
  provider.close();

  const events = parseEvents(await response.text());
  assert.equal(events.at(-1).event, 'done');
  assert.equal(events.at(-1).data.truncated, true);

  await ctx.settled();
  assert.deepEqual(reviews(env), [{ status: 'completed', profile: 'solidity', channel: 'web' }]);
});

test('a single answer the provider cut short after a few characters is not counted', async (t) => {
  const { env, ctx, call } = setup(t, () =>
    Response.json({ model: 'gpt-test', choices: [{ message: { content: '# Review\n' }, finish_reason: 'length' }] }),
  );
  const result = await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  assert.equal(result.truncated, true);
  await ctx.settled();
  assert.equal(reviews(env)[0].status, 'failed');
});

test('a client that leaves after most of the review arrived has used its review', async (t) => {
  let provider;
  const { env, ctx, call, disconnect } = setup(t, (init) => {
    provider = providerStream(init);
    return provider.response;
  });

  const response = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  const reader = response.body.getReader();
  provider.push(chunk('x'.repeat(2500)));
  await reader.read();

  disconnect.abort();
  await reader.cancel();
  await ctx.settled();

  assert.deepEqual(reviews(env), [{ status: 'completed', profile: 'solidity', channel: 'web' }]);
});

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

test('reviewFailure keeps provider messages and hides everything else', () => {
  const rate = reviewFailure(new ProviderError('Provider rate limit reached.', { status: 429, kind: 'rate', retryAfter: 30 }));
  assert.equal(rate.status, 502);
  assert.equal(rate.code, 'provider');
  assert.deepEqual(rate.extra, { kind: 'rate', retryAfter: 30 });

  const timeout = reviewFailure(new ProviderError('Provider did not answer within 180 seconds.', { kind: 'timeout' }));
  assert.equal(timeout.status, 504);
  assert.deepEqual(timeout.extra, { kind: 'timeout' });

  const hardLimit = reviewFailure(new DOMException('The operation timed out.', 'TimeoutError'));
  assert.equal(hardLimit.status, 504);
  assert.equal(hardLimit.code, 'provider');
  assert.match(hardLimit.message, /^Provider did not finish within 270 seconds/);

  const unknown = reviewFailure(new TypeError('secret internal detail'));
  assert.equal(unknown.status, 502);
  assert.equal(unknown.code, 'review_failed');
  assert(!unknown.message.includes('secret'));
});
