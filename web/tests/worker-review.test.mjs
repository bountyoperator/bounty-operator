// Hosted reviews end to end, against the real engine and an in-memory database.
// The provider is a stubbed fetch: nothing leaves the machine.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ANTHROPIC_CYBER_NOTICE, ProviderError } from '../public/providers.mjs';
import { ApiError } from '../src/http.ts';
import { failureReason, parseReviewRequest, reviewFailure, runHostedReview, streamHostedReview } from '../src/review.ts';
import { SITE_ORIGIN, addAccount, addSubscription, createCall, createContext, createEnv, funnelCounts } from './worker-helpers.mjs';

const ACCOUNT = 'account-1';
const KEY = 'sk-test-key-0123456789';
const CYBER_NOTICE = ANTHROPIC_CYBER_NOTICE;
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
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1, 'review_fail:provider_auth': 1 });
});

test('a refusal is returned but not counted against the day', async (t) => {
  const { env, ctx, call } = setup(t, () =>
    Response.json({ model: 'gpt-test', choices: [{ message: { content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }] }),
  );
  const result = await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  assert.equal(result.refused, true);
  assert.equal(Object.hasOwn(result, 'blocked'), false, 'the model declining in its own words is not a policy block');
  await ctx.settled();
  assert.equal(reviews(env)[0].status, 'failed');
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1, 'review_fail:refused': 1 });
});

test('an ordinary-content policy refusal preserves the free allowance for a later review', async (t) => {
  let reply = CYBER_NOTICE;
  const { env, ctx, call, calls } = setup(t, () => completion(reply));
  const result = await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  assert.equal(result.review, CYBER_NOTICE);
  assert.equal(result.refused, true);
  assert.equal(result.blocked, 'anthropic-cyber');
  await ctx.settled();
  assert.equal(reviews(env)[0].status, 'failed');
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1, 'review_fail:blocked': 1 }, 'a block has its own failure reason');

  reply = REVIEW_TEXT;
  const next = await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  assert.equal(next.refused, false);
  assert.equal(next.blocked, undefined);
  await ctx.settled();
  assert.deepEqual(reviews(env).map((review) => review.status), ['failed', 'completed']);
  assert.equal(calls.length, 2, 'only the two explicit requests reached the provider');
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

test('a chunked ordinary-content policy refusal sends its category and keeps the free allowance', async (t) => {
  let provider;
  let blocked = true;
  const { env, ctx, call, calls } = setup(t, (init) => {
    if (!blocked) return completion();
    provider = providerStream(init);
    return provider.response;
  });
  const response = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  for (const part of [CYBER_NOTICE.slice(0, 48), CYBER_NOTICE.slice(48, 120), CYBER_NOTICE.slice(120)]) provider.push(chunk(part));
  provider.push(chunk(null, 'stop'));
  provider.push('data: [DONE]\n\n');
  provider.close();
  const events = parseEvents(await response.text());
  assert.equal(events.filter((event) => event.event === 'delta').map((event) => event.data.text).join(''), CYBER_NOTICE);
  const done = events.at(-1).data;
  assert.equal(events.at(-1).event, 'done');
  assert.equal(done.review, CYBER_NOTICE);
  assert.equal(done.refused, true);
  assert.equal(done.blocked, 'anthropic-cyber');
  await ctx.settled();
  assert.equal(reviews(env)[0].status, 'failed');
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1, 'review_fail:blocked': 1 });

  blocked = false;
  await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  await ctx.settled();
  assert.deepEqual(reviews(env).map((review) => review.status), ['failed', 'completed']);
  assert.equal(calls.length, 2);
});

test('generic refusals retain the existing allowance threshold on both response paths', async (t) => {
  // The model declines in its own words (a refusal message, a normal stop): no provider block.
  for (const [chars, counted] of [[1999, false], [2000, true], [2500, true]]) {
    for (const streamed of [false, true]) {
      await t.test(`${chars} characters over ${streamed ? 'SSE' : 'JSON'}`, async (subtest) => {
        const text = 'Review text. '.repeat(210).slice(0, chars);
        let provider;
        const { env, ctx, call, calls } = setup(subtest, (init) => {
          if (!streamed) return completion(text, { choices: [{ message: { content: null, refusal: text }, finish_reason: 'stop' }] });
          provider = providerStream(init);
          return provider.response;
        });
        let result;
        if (streamed) {
          const response = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
          provider.push(`data: ${JSON.stringify({ model: 'gpt-test-2026', choices: [{ delta: { refusal: text }, finish_reason: null }] })}\n\n`);
          provider.push(chunk(null, 'stop'));
          provider.push('data: [DONE]\n\n');
          provider.close();
          result = parseEvents(await response.text()).at(-1).data;
        } else {
          result = await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
        }
        assert.equal(result.review, text);
        assert.equal(result.refused, true);
        assert.equal(result.blocked, undefined);
        await ctx.settled();
        assert.equal(reviews(env)[0].status, counted ? 'completed' : 'failed');
        assert.deepEqual(funnelCounts(env.DB), counted ? { 'review_ok:solidity': 1 } : { review_fail: 1, 'review_fail:refused': 1 });
        assert.equal(calls.length, 1);
      });
    }
  }
});

test('a blocked answer is never counted, whatever its length, on both response paths', async (t) => {
  const anthropic = { provider: 'anthropic', model: 'claude-opus-5-5' };
  const messageEvents = (...events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const details = { type: 'refusal', category: 'cyber', explanation: 'Blocked by the cyber safeguards.' };
  const reasoning = { type: 'refusal', category: 'reasoning_extraction', explanation: 'The request asks for the reasoning as text.' };
  const explained = { 'anthropic-cyber': details.explanation, 'anthropic-reasoning': reasoning.explanation };

  for (const chars of [0, 1999, 2000, 25000]) {
    const text = 'Review text written before the block. '.repeat(700).slice(0, chars);
    // [name, request overrides, blocked, one-answer body, stream chunks]
    const signals = [
      ['a provider filter (content_filter)', {}, 'policy',
        { model: 'gpt-test-2026', choices: [{ message: { content: text }, finish_reason: 'content_filter' }] },
        [...(text ? [chunk(text)] : []), chunk(null, 'content_filter'), 'data: [DONE]\n\n']],
      ['a raw upstream refusal (native_finish_reason)', { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' }, 'policy',
        { model: 'gpt-test-2026', choices: [{ message: { content: text }, finish_reason: 'stop', native_finish_reason: 'refusal' }] },
        [...(text ? [chunk(text)] : []), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', native_finish_reason: 'refusal' }] })}\n\n`, 'data: [DONE]\n\n']],
      ['a Messages refusal (stop_reason, category cyber)', anthropic, 'anthropic-cyber',
        { type: 'message', model: 'claude-opus-5-5', content: text ? [{ type: 'text', text }] : [], stop_reason: 'refusal', stop_details: details, usage: { input_tokens: 5, output_tokens: 1 } },
        messageEvents(
          { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 0 } } },
          ...(text ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }] : []),
          { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: details }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        )],
      // The one refusal a prompt can cause: it is counted apart, so a hosted method that trips it shows up.
      ['a Messages refusal (stop_reason, category reasoning_extraction)', anthropic, 'anthropic-reasoning',
        { type: 'message', model: 'claude-opus-5-5', content: text ? [{ type: 'text', text }] : [], stop_reason: 'refusal', stop_details: reasoning, usage: { input_tokens: 5, output_tokens: 1 } },
        messageEvents(
          { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 0 } } },
          ...(text ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }] : []),
          { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: reasoning }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        )],
    ];
    // A policy error after text, mid-stream: only a stream can carry it.
    if (text) {
      signals.push(['a policy error after text, mid-stream', { provider: 'openrouter', model: 'openai/gpt-6.1-sol' }, 'policy', null, [
        chunk(text),
        `data: ${JSON.stringify({ error: { code: 403, message: 'Provider returned error', metadata: { error_type: 'refusal' } }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] })}\n\n`,
      ]]);
    }

    for (const [name, overrides, blocked, whole, chunks] of signals) {
      for (const streamed of [false, true]) {
        if (!streamed && !whole) continue;
        await t.test(`${name}, ${chars} characters over ${streamed ? 'SSE' : 'JSON'}`, async (subtest) => {
          let provider;
          const { env, ctx, call } = setup(subtest, (init) => {
            if (!streamed) return Response.json(whole);
            provider = providerStream(init);
            return provider.response;
          });
          const input = parseReviewRequest(body(overrides));
          let result;
          if (streamed) {
            const response = await streamHostedReview(call, ACCOUNT, input, 'web');
            for (const part of chunks) provider.push(part);
            provider.close();
            const events = parseEvents(await response.text());
            assert.equal(events.at(-1).event, 'done');
            result = events.at(-1).data;
          } else {
            result = await runHostedReview(call, ACCOUNT, input, 'web');
          }
          assert.equal(result.refused, true);
          assert.equal(result.blocked, blocked);
          // The text the provider wrote before the block is shown; with none, its explanation is.
          assert.equal(result.review, text || (explained[blocked] ?? ''));
          await ctx.settled();
          assert.equal(reviews(env)[0].status, 'failed', 'not counted');
          assert.deepEqual(funnelCounts(env.DB), { review_fail: 1, [blocked === 'anthropic-reasoning' ? 'review_fail:blocked_reasoning' : 'review_fail:blocked']: 1 });
        });
      }
    }
  }
});

test('a policy block the provider sends as an error is provider_policy, is not charged, and leaves the daily review', async (t) => {
  const moderation = { error: { code: 403, message: 'Input flagged', metadata: { reasons: ['illicit'], flagged_input: 'how to…', provider_name: 'OpenAI' } } };
  const cyber = { error: { message: `This request was flagged for ${KEY}.`, type: 'invalid_request_error', code: 'cyber_policy' } };
  const cases = [
    // [name, request overrides, HTTP status of the provider answer, body, blocked]
    ['an OpenRouter moderation 403', { provider: 'openrouter', model: 'openai/gpt-6.1-sol' }, 403, moderation, 'policy'],
    ['an OpenAI cyber_policy error', {}, 400, cyber, 'openai-cyber'],
    ['a block inside a 200 body', { provider: 'openrouter', model: 'openai/gpt-6.1-sol' }, 200, moderation, 'policy'],
  ];
  for (const [name, overrides, status, payload, blocked] of cases) {
    for (const streamed of [false, true]) {
      await t.test(`${name} over ${streamed ? 'SSE' : 'JSON'}`, async (subtest) => {
        let reply = () => Response.json(payload, { status });
        const { env, ctx, call } = setup(subtest, () => reply());
        const input = parseReviewRequest(body(overrides));

        let failure;
        if (streamed && status === 200) {
          // The provider accepted the stream and answered with one JSON error body: an `error` event.
          const response = await streamHostedReview(call, ACCOUNT, input, 'web');
          assert.match(response.headers.get('content-type'), /^text\/event-stream/);
          const events = parseEvents(await response.text());
          assert.deepEqual(events.map((item) => item.event), ['error']);
          failure = { message: events[0].data.error, code: events[0].data.code, extra: events[0].data };
        } else {
          const error = await rejection(streamed ? streamHostedReview(call, ACCOUNT, input, 'web') : runHostedReview(call, ACCOUNT, input, 'web'));
          assert(error instanceof ApiError);
          assert.equal(error.status, 502);
          failure = error;
        }
        assert.equal(failure.code, 'provider_policy');
        assert.equal(failure.extra.kind, 'policy');
        assert.equal(failure.extra.blocked, blocked);
        assert.match(failure.message, /^Provider blocked this request under .+; the API key is not the cause\. It was not counted against your allowance\.$/);
        assert.doesNotMatch(failure.message, /rejected the API key/);
        assert(!JSON.stringify(failure.extra).includes(KEY) && !failure.message.includes(KEY));

        await ctx.settled();
        assert.deepEqual(reviews(env), [{ status: 'failed', profile: 'solidity', channel: 'web' }]);
        assert.deepEqual(funnelCounts(env.DB), { review_fail: 1, 'review_fail:provider_policy': 1 });

        // The free account's one review of the day is still there.
        reply = () => completion();
        const next = await runHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
        assert.equal(next.refused, false);
        await ctx.settled();
        assert.deepEqual(reviews(env).map((review) => review.status), ['failed', 'completed']);
      });
    }
  }
});

test('a plain 403 from the provider is still a rejected key', async (t) => {
  const { env, ctx, call } = setup(t, () => Response.json({ error: { code: 403, message: 'Forbidden', metadata: { provider_name: 'OpenAI' } } }, { status: 403 }));
  const error = await rejection(runHostedReview(call, ACCOUNT, parseReviewRequest(body({ provider: 'openrouter', model: 'openai/gpt-6.1-sol' })), 'web'));
  assert.equal(error.code, 'provider');
  assert.equal(error.extra.kind, 'auth');
  assert.match(error.message, /^Provider rejected the API key \(HTTP 403\)/);
  await ctx.settled();
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1, 'review_fail:provider_auth': 1 });
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

test('a provider error before any text becomes an error event and frees the allowance', async (t) => {
  let provider;
  const { env, ctx, call } = setup(t, (init) => {
    provider = providerStream(init);
    return provider.response;
  });

  const response = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  provider.push(`data: ${JSON.stringify({ error: { message: 'Upstream overloaded' } })}\n\n`);

  const events = parseEvents(await response.text());
  assert.deepEqual(events.map((item) => item.event), ['error']);
  assert.equal(events[0].data.code, 'provider');
  assert.match(events[0].data.error, /^Provider returned an error: Upstream overloaded/);

  await ctx.settled();
  assert.deepEqual(reviews(env), [{ status: 'failed', profile: 'solidity', channel: 'web' }]);
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1, 'review_fail:provider_response': 1 });
});

test('a provider error after text ends the review as cut short: the text is kept and a short one is not counted', async (t) => {
  let provider;
  const { env, ctx, call } = setup(t, (init) => {
    provider = providerStream(init);
    return provider.response;
  });

  const response = await streamHostedReview(call, ACCOUNT, parseReviewRequest(body()), 'web');
  provider.push(chunk('# Review\n'));
  provider.push(`data: ${JSON.stringify({ error: { message: 'Upstream overloaded' } })}\n\n`);

  const events = parseEvents(await response.text());
  assert.deepEqual(events.map((item) => item.event), ['delta', 'done']);
  assert.equal(events[1].data.truncated, true);
  assert.equal(events[1].data.review, '# Review\n');

  await ctx.settled();
  assert.deepEqual(reviews(env), [{ status: 'failed', profile: 'solidity', channel: 'web' }]);
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1, 'review_fail:cut_short': 1 });
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
  assert.deepEqual(funnelCounts(env.DB), { review_fail: 1, 'review_fail:cut_short': 1 });
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

  const policy = reviewFailure(new ProviderError('Provider blocked this request.', { status: 403, kind: 'policy', blocked: 'openai-cyber', detail: 'Flagged.' }));
  assert.equal(policy.status, 502);
  assert.equal(policy.code, 'provider_policy');
  assert.deepEqual(policy.extra, { kind: 'policy', blocked: 'openai-cyber', detail: 'Flagged.' });
  assert.equal(policy.message, 'Provider blocked this request. It was not counted against your allowance.');
  assert.deepEqual(reviewFailure(new ProviderError('Provider blocked this request.', { kind: 'policy' })).extra, { kind: 'policy', blocked: 'policy' });

  const unknown = reviewFailure(new TypeError('secret internal detail'));
  assert.equal(unknown.status, 502);
  assert.equal(unknown.code, 'review_failed');
  assert(!unknown.message.includes('secret'));
});

test('failureReason names a failed review from a fixed set and never from the message', () => {
  assert.equal(failureReason(new ProviderError('Provider rate limit reached.', { status: 429, kind: 'rate' })), 'provider_rate');
  assert.equal(failureReason(new ProviderError('Provider has no credits left.', { status: 402, kind: 'credit' })), 'provider_credit');
  assert.equal(failureReason(new ProviderError('Provider blocked this request.', { status: 403, kind: 'policy', blocked: 'policy' })), 'provider_policy');
  assert.equal(failureReason(new DOMException('The operation timed out.', 'TimeoutError')), 'single_answer_limit');
  assert.equal(failureReason(new DOMException('The operation was aborted.', 'AbortError')), 'client_gone');
  assert.equal(failureReason(new ProviderError('Provider failed.', { kind: 'server' }), true), 'client_gone', 'a client that left wins');
  assert.equal(failureReason(new TypeError('secret internal detail')), 'other');
  assert.equal(failureReason('not an error'), 'other');
});
