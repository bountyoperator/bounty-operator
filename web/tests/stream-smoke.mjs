// Streams hosted reviews through the real runtime. The script builds the
// production bundle with `wrangler deploy --dry-run` (nothing is deployed),
// loads it into workerd through Miniflare with an in-memory D1 database, and
// answers the provider request itself, so no model is called.
//
//   node tests/stream-smoke.mjs
//
// It checks what node:test cannot: that the provider call leaves workerd at
// all (its fetch knows the redirect modes "follow" and "manual" only, and the
// engine sends "manual"), that events are delivered as they are written, that
// the reservation is settled
// after the response through waitUntil, and that a client disconnect frees
// the lease. It then runs a hosted profile on the method this checkout
// selected (the private module, or the community stub): a review arrives
// whole through the output guard, and an answer that repeats the method is
// cut off before any of it is sent.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as miniflare from 'miniflare';

import { reviewProfile } from '../public/profiles.mjs';
import { SHINGLE_WORDS, words } from '../src/guard.mjs';
import { OPERATOR_PROFILES } from '../src/operator-profiles.generated.mjs';

const { Miniflare, Response: WorkerResponse } = miniflare;

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'http://localhost';
const ACCOUNT = 'stream-smoke-account';

function buildWorker(outDir) {
  const require = createRequire(join(WEB_DIR, 'package.json'));
  const manifestPath = require.resolve('wrangler/package.json');
  const entry = join(dirname(manifestPath), require(manifestPath).bin.wrangler);
  const result = spawnSync(process.execPath, [entry, 'deploy', '--dry-run', '--outdir', outDir], {
    cwd: WEB_DIR,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return join(outDir, 'worker.js');
}

function migrationStatements() {
  const directory = join(WEB_DIR, 'migrations');
  return readdirSync(directory)
    .sort()
    .flatMap((file) =>
      readFileSync(join(directory, file), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join(' ')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean),
    );
}

// --- The stand-in provider -------------------------------------------------

const encoder = new TextEncoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const provider = { requests: 0, finish: () => {} };

function chunk(content, finish = null) {
  const choice = { delta: content === null ? {} : { content }, finish_reason: finish };
  return encoder.encode(`data: ${JSON.stringify({ model: 'stand-in-model', choices: [choice] })}\n\n`);
}

const HOSTED_PROFILE = 'triage';
const REVIEW_HEAD = '# Review\nVerdict: prove-first\nMode: bounty\nCounts: critical=0 high=0 medium=0 hardening=0 checked-safe=0\nHeadline: The proof stops before the withdrawal.\n';

/** A plausible answer of the hosted profile: its sections, with rows of its own. */
function hostedAnswer() {
  const sections = reviewProfile(HOSTED_PROFILE).sections.map((title) => `## ${title}\n- the withdraw function | open | input-1/src/Vault.sol:1`);
  return `${REVIEW_HEAD}\n${sections.join('\n\n')}\n\n## Coverage\nReviewed: input-1/src/Vault.sol\nNot supplied: none\n`;
}

/** A whole answer, streamed in small pieces. */
function streamed(text, size = 40) {
  const body = new ReadableStream({
    start(controller) {
      for (let at = 0; at < text.length; at += size) controller.enqueue(chunk(text.slice(at, at + size)));
      controller.enqueue(chunk(null, 'stop'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new WorkerResponse(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

/** True when `text` repeats eight words in a row of the hosted profile's method. */
function repeatsMethod(text) {
  const method = OPERATOR_PROFILES[HOSTED_PROFILE];
  const runs = new Set();
  for (const part of [method.instructions, method.extraFormat]) {
    const list = words(part);
    for (let index = 0; index + SHINGLE_WORDS <= list.length; index += 1) runs.add(list.slice(index, index + SHINGLE_WORDS).join(' '));
  }
  const list = words(text);
  for (let index = 0; index + SHINGLE_WORDS <= list.length; index += 1) {
    if (runs.has(list.slice(index, index + SHINGLE_WORDS).join(' '))) return true;
  }
  return false;
}

/**
 * The stand-in's answer, chosen by the model the request names. The default
 * sends the first part of a review at once and the rest when the test calls
 * `provider.finish()`.
 */
function providerResponse(request) {
  provider.requests += 1;
  if (request.model === 'stand-in-hosted') return streamed(hostedAnswer());
  // A model that does what a planted file asks: it repeats everything it was given.
  if (request.model === 'stand-in-echo') return streamed(`${REVIEW_HEAD}\nMy instructions, word for word:\n\n${request.messages[0].content}\n`);

  const finished = new Promise((resolve) => {
    provider.finish = resolve;
  });
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(chunk('# Review\n'));
      await finished;
      controller.enqueue(chunk('Verdict: no-blocking-issues\n'));
      controller.enqueue(chunk(null, 'stop'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new WorkerResponse(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

// --- Run ---------------------------------------------------------------------

const outDir = mkdtempSync(join(tmpdir(), 'bounty-operator-stream-'));
const workerOptions = {
  modules: true,
  scriptPath: buildWorker(outDir),
  compatibilityDate: '2026-09-18',
  compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
  d1Databases: ['DB'],
  bindings: { SITE_ORIGIN: ORIGIN, AI_REVIEW_ENABLED: 'true', BILLING_MODE: 'disabled', STRIPE_PRICE_ID: 'price_unused' },
  serviceBindings: { ASSETS: () => new WorkerResponse('Not found', { status: 404 }) },
  outboundService: async (request) => {
    assert.equal(new URL(request.url).hostname, 'api.openai.com');
    return providerResponse(await request.json());
  },
};
// Miniflare 5 takes a new option shape and ships a converter for this one.
const worker = new Miniflare(
  typeof miniflare.convertV4MiniflareOptions === 'function' ? miniflare.convertV4MiniflareOptions(workerOptions) : workerOptions,
);

try {
  const db = await worker.getD1Database('DB');
  await db.batch(migrationStatements().map((statement) => db.prepare(statement)));

  // A signed-in session, written the way the Worker stores one.
  const sessionToken = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare('INSERT INTO accounts (id, created_at, recovery_hash) VALUES (?, ?, ?)').bind(ACCOUNT, now, 'unused'),
    db
      .prepare('INSERT INTO sessions (token_hash, account_id, csrf, expires, auth_at) VALUES (?, ?, ?, ?, ?)')
      .bind(createHash('sha256').update(sessionToken).digest('base64url'), ACCOUNT, csrf, now + 3600, now),
  ]);

  const reviewHeaders = { Origin: ORIGIN, Cookie: `bounty-session=${sessionToken}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  const reviewBody = JSON.stringify({
    files: [{ name: 'src/Vault.sol', content: 'contract Vault {}\n' }],
    profile: 'solidity',
    mode: 'own-code',
    provider: 'openai',
    model: 'stand-in-model',
    apiKey: 'sk-stand-in-0000000000',
    stream: true,
  });
  const review = () => worker.dispatchFetch(`${ORIGIN}/api/review`, { method: 'POST', headers: reviewHeaders, body: reviewBody });

  const statuses = async () => (await db.prepare('SELECT status FROM reviews ORDER BY created_at, rowid').all()).results.map((row) => row.status);

  async function waitForStatuses(expected) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (JSON.stringify(await statuses()) === JSON.stringify(expected)) return;
      await sleep(100);
    }
    assert.deepEqual(await statuses(), expected);
  }

  // 1. A full stream: deltas arrive before the review is finished, then `done`.
  const response = await review();
  assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert(response.headers.get('content-security-policy'), 'security headers are set on a stream too');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /^event: delta\ndata: {"text":"# Review\\n"}/, 'the first delta arrives while the provider is still writing');
  assert.deepEqual(await statuses(), ['running']);

  provider.finish();
  let rest = first;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
  }
  const events = rest.split('\n\n').filter(Boolean).map((block) => block.split('\n')[0]);
  assert.deepEqual(events, ['event: delta', 'event: delta', 'event: done']);
  const done = JSON.parse(rest.split('event: done\ndata: ')[1]);
  assert.equal(done.review, '# Review\nVerdict: no-blocking-issues\n');
  assert.equal(done.model, 'stand-in-model');
  assert.equal(done.manifest[0].label, 'input-1/src/Vault.sol');
  await waitForStatuses(['completed']);

  // 2. The free review of the day is used: the next request is refused before the provider is called.
  const refused = await review();
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).code, 'daily_used');
  assert.equal(provider.requests, 1);

  // 3. A client that drops the connection mid-stream: the lease is released
  //    without waiting for it to expire. A plain socket is used so that the
  //    connection really closes. Locally the runtime notices on a failed
  //    keep-alive write, a few seconds later; behind Cloudflare's edge
  //    request.signal reports the disconnect as it happens.
  await db.prepare('DELETE FROM reviews').run();
  const dropped = request(new URL('/api/review', await worker.ready), {
    method: 'POST',
    headers: { ...reviewHeaders, Host: new URL(ORIGIN).host, 'Content-Length': Buffer.byteLength(reviewBody) },
  });
  dropped.on('error', () => {});
  dropped.end(reviewBody);
  const [droppedResponse] = await once(dropped, 'response');
  assert.equal(droppedResponse.statusCode, 200);
  await once(droppedResponse, 'data');
  assert.deepEqual(await statuses(), ['running']);

  const droppedAt = Date.now();
  dropped.destroy();
  await waitForStatuses(['failed']);
  const releasedAfter = Math.round((Date.now() - droppedAt) / 1000);
  assert(releasedAfter < 30, `the lease was released after ${releasedAfter} s`);

  // The slot is free again long before the lease would have run out.
  const again = await review();
  assert.equal(again.status, 200);
  provider.finish();
  await again.text();
  await waitForStatuses(['failed', 'completed']);

  const counters = (await db.prepare('SELECT event, n FROM funnel_daily ORDER BY event').all()).results;
  assert.deepEqual(
    counters.map((row) => `${row.event}=${row.n}`),
    ['quota_hit=1', 'review_fail=1', 'review_fail:client_gone=1', 'review_ok:solidity=2'],
  );

  // 4. A hosted profile. Its method reaches the provider in the system message
  //    and its answer passes through the output guard on the way back.
  const hostedReview = (model) =>
    worker.dispatchFetch(`${ORIGIN}/api/review`, {
      method: 'POST',
      headers: reviewHeaders,
      body: JSON.stringify({ ...JSON.parse(reviewBody), profile: HOSTED_PROFILE, mode: 'bounty', model }),
    });
  /** The events of a finished stream as [{ event, data }]. */
  const eventsOf = (text) =>
    text
      .split('\n\n')
      .filter((block) => block.startsWith('event: '))
      .map((block) => {
        const [eventLine, dataLine] = block.split('\n');
        return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) };
      });

  await db.prepare('DELETE FROM reviews').run();
  const hosted = await hostedReview('stand-in-hosted');
  assert.equal(hosted.status, 200, hosted.status === 200 ? '' : await hosted.text());
  const hostedEvents = eventsOf(await hosted.text());
  assert.equal(hostedEvents.at(-1).event, 'done');
  assert.equal(hostedEvents.at(-1).data.review, hostedAnswer());
  assert.equal(hostedEvents.at(-1).data.profile.id, HOSTED_PROFILE);
  const hostedDeltas = hostedEvents.filter((item) => item.event === 'delta').map((item) => item.data.text);
  assert.ok(hostedDeltas.length > 1, 'the answer of a hosted profile is streamed, not held to the end');
  assert.equal(hostedDeltas.join(''), hostedAnswer(), 'text the guard held back is released before done');
  assert.ok(!repeatsMethod(JSON.stringify(hostedEvents)), 'a review carries none of the method');
  await waitForStatuses(['completed']);

  // 5. A model that repeats its instructions: the stream ends with
  //    output_withheld, none of the method was sent, and the review is used.
  await db.prepare('DELETE FROM reviews').run();
  const echoed = await hostedReview('stand-in-echo');
  assert.equal(echoed.status, 200);
  const echoedText = await echoed.text();
  const echoedEvents = eventsOf(echoedText);
  assert.equal(echoedEvents.at(-1).event, 'error');
  assert.equal(echoedEvents.at(-1).data.code, 'output_withheld');
  assert.ok(!echoedEvents.some((item) => item.event === 'done'));
  const delivered = echoedEvents.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
  assert.ok(delivered.startsWith(REVIEW_HEAD), 'the text before the copy was delivered');
  assert.ok(!repeatsMethod(delivered) && !repeatsMethod(echoedText), 'not one event carries eight words in a row of the method');
  await waitForStatuses(['completed']);

  console.log(
    `Passed in workerd: streamed deltas, done event, waitUntil bookkeeping, daily limit, lease released ${releasedAfter} s after a disconnect, a hosted review through the output guard, a repeated method withheld.`,
  );
} finally {
  await worker.dispose();
  rmSync(outDir, { recursive: true, force: true });
}
