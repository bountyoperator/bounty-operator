// The product-lift tool (tools/product-lift.mjs) against a stand-in provider: the two requests,
// the product's own provider call and what it records, scoring through the harness scorer,
// retries, the budget gates, resume and the summary. Offline: the stand-in answers every
// request the product's providerStream makes, and nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE, buildProductRequest, buildRawRequest, classify, liftAll, planJobs, productEngine, productFiles, readLedger, readRecords,
  readStream, recordingFetch, renderSummary, scoreAnswer, stripInputLabel, summarise, twinReason,
} from '../tools/product-lift.mjs';
import { buildProbePrompt } from '../tools/probe.mjs';
import { loadCases, pairsOf } from '../lib/cases.mjs';
import { readPrompt, taskText } from '../lib/arms.mjs';
import { loadProtocol } from '../bench.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { protocol } = loadProtocol();
const cases = loadCases([path.join(BENCH, 'tests', 'fixtures', 'cases')]);
const byId = new Map(cases.map((c) => [c.id, c]));
const pairs = pairsOf(cases);
const KEY = 'sk-or-v1-standin0123456789abcdef';
const sheet = (o) => `# Review\nVerdict: submit\n\n\`\`\`json\n${JSON.stringify({ findings: [], rejected: [], verdict: 'n/a', max_severity: 'unrated', ...o })}\n\`\`\`\n`;
const FOUND = (file) => ({ findings: [{ file, function: 'withdrawAll', line_start: 42, line_end: 44, severity: 'high', claim: 'pays before zeroing the balance' }], max_severity: 'high' });
const QUOTE = 'Any caller can also redirect the accrued exit fees to an address of their choice through `sweepDust`';

test('the raw arm is the probe request, word for word', () => {
  for (const kase of cases) {
    const r = buildRawRequest(kase, BENCH), p = buildProbePrompt(kase, BENCH);
    assert.equal(r.system, p.system);
    assert.equal(r.user, p.user);
    assert.ok(r.user.endsWith(`${taskText(kase, BENCH).trim()}\n`));
  }
});

test('the product arm is the prepared review, the bridge and the same answer sheet', async () => {
  const { core } = await productEngine();
  const o = byId.get('fx-02-o');
  assert.deepEqual(productFiles(o).map((f) => f.name), ['draft-report.md', 'src/LedgerMath.sol', 'src/PocketBank.sol'], 'the draft first, then the sources by path');
  const req = await buildProductRequest(o, { benchDir: BENCH });
  const prepared = await core.prepareReview(productFiles(o), '', 'report', { acknowledgeWarnings: true, mode: 'bounty' });
  assert.equal(req.system, prepared.messages[0].content, 'the system message is the product\'s own');
  assert.ok(req.user.startsWith(prepared.messages[1].content), 'the user message starts with the product\'s own');
  assert.equal(req.user, `${prepared.messages[1].content}\n\n${BRIDGE}\n\n${readPrompt('answer-sheet.md', BENCH).trim()}\n`);
  assert.equal(req.profile, 'report');
  assert.equal(req.mode, 'bounty');
  assert.deepEqual(req.labels, ['input-1/draft-report.md', 'input-2/src/LedgerMath.sol', 'input-3/src/PocketBank.sol']);
  assert.match(req.user, /## Context\nMode: bounty/);
  assert.ok(!/fx-02|canary|truth/i.test(req.user) && !req.user.includes(o.truth.canary));
  const v = await buildProductRequest(byId.get('fx-01-v'), { benchDir: BENCH });
  assert.equal(v.profile, 'solidity');
  assert.match(v.system, /Profile: Solidity review\./);
  const raw = buildRawRequest(byId.get('fx-01-v'), BENCH);
  const sheetText = readPrompt('answer-sheet.md', BENCH).trim();
  assert.ok(raw.user.endsWith(`${sheetText}\n`) && v.user.endsWith(`${sheetText}\n`), 'both arms end with the same answer sheet');
});

test('input-N labels are stripped before scoring, and the harness scorer decides', () => {
  assert.equal(stripInputLabel('input-3/src/PocketBank.sol'), 'src/PocketBank.sol');
  assert.equal(stripInputLabel('./input-12/src/A.sol'), 'src/A.sol');
  assert.equal(stripInputLabel('src/input-1/A.sol'), 'src/input-1/A.sol');
  const v = byId.get('fx-01-v'), f = byId.get('fx-01-f');
  const labelled = scoreAnswer(v, sheet(FOUND('input-2/src/PocketBank.sol')), { scoring: protocol.scoring });
  assert.equal(labelled.outcome.correct, true);
  assert.equal(labelled.stripped, 1);
  assert.equal(scoreAnswer(v, sheet(FOUND('src/PocketBank.sol')), { scoring: protocol.scoring }).stripped, 0);
  assert.equal(scoreAnswer(f, sheet(FOUND('input-2/src/PocketBank.sol')), { scoring: protocol.scoring }).outcome.bite, true);
  assert.equal(scoreAnswer(v, sheet(FOUND('src/PocketBank.sol')), { failure: 'truncated', scoring: protocol.scoring }).outcome.correct, false);
  assert.equal(scoreAnswer(v, 'no sheet', { scoring: protocol.scoring }).outcome.failure, 'unparseable');
});

const sse = (text, { finish = 'stop', native = finish, usage = { prompt_tokens: 1200, completion_tokens: 400, cost: 0.002, completion_tokens_details: { reasoning_tokens: 100 } }, error = null, reasoning = '' } = {}) => {
  const chunk = (o) => `data: ${JSON.stringify({ id: 'gen-standin-1', provider: 'Stand-in', model: 'test/model-a', object: 'chat.completion.chunk', ...o })}\n\n`;
  let s = ': OPENROUTER PROCESSING\n\n';
  if (reasoning) s += chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning }, finish_reason: null }] });
  for (let i = 0; i < text.length; i += 40) s += chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(i, i + 40) }, finish_reason: null }] });
  if (error) s += chunk({ error, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
  else s += chunk({ choices: [{ index: 0, delta: { content: '' }, finish_reason: finish, native_finish_reason: native }], usage });
  return `${s}data: [DONE]\n\n`;
};
const eventStream = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });

test('a stream is read for its finish, usage and errors, and each kind of attempt is classified', () => {
  const s = readStream(sse('hello world', { reasoning: 'thinking' }));
  assert.equal(s.finish, 'stop');
  assert.equal(s.usage.completion_tokens, 400);
  assert.equal(s.provider, 'Stand-in');
  assert.deepEqual(s.ids, ['gen-standin-1']);
  assert.equal(s.content_chars, 11);
  assert.equal(s.reasoning_chars, 8);
  assert.equal(s.done_marker, true);
  const ok = { text: 'x', done: { truncated: false, refused: false }, error: null };
  assert.equal(classify(ok, s).failure, null);
  assert.equal(classify({ ...ok, done: { truncated: true, refused: false } }, readStream(sse('x', { finish: 'length' }))).failure, 'truncated');
  assert.equal(classify({ ...ok, done: { truncated: false, refused: true } }, readStream(sse('x', { finish: 'content_filter' }))).failure, 'refused');
  const limit = { text: '', done: null, error: { kind: 'response', status: null, message: 'Provider returned no review text before the answer was cut short.' } };
  assert.equal(classify(limit, readStream(sse('', { finish: 'length', reasoning: 'long' }))).failure, 'truncated', 'all of the allowance went to reasoning');
  const rate = { text: '', done: null, error: { kind: 'rate', status: 429, message: 'Provider rate limit reached' } };
  assert.deepEqual([classify(rate, readStream('{"error":{"code":429}}')).failure, classify(rate, readStream('{"error":{"code":429}}')).retryable], ['error', true]);
  const midway = { text: 'half an answer', done: null, error: { kind: 'response', status: null, message: 'Provider returned an error: upstream' } };
  const late = classify(midway, readStream(sse('half an answer', { error: { code: 502, message: 'upstream' } })));
  assert.deepEqual([late.failure, late.retryable, late.before_output], ['error', false, false], 'output was produced: never sent again');
  const early = classify({ text: '', done: null, error: midway.error }, readStream(sse('', { error: { code: 502, message: 'upstream' } })));
  assert.deepEqual([early.failure, early.retryable], ['error', true], 'an in-band 502 before any output is infrastructure');
  const empty = classify({ text: '', done: null, error: { kind: 'response', status: null, message: 'Provider did not return a text review.' } }, readStream(sse('')));
  assert.equal(empty.failure, 'empty');
});

/** A stand-in provider. `answer({ body, arm, n })` returns the Response for the n-th request with that exact body. */
function standIn(answer) {
  const seen = new Map(), bodies = [], headers = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    bodies.push(body); headers.push(init.headers);
    const arm = body.messages[0].content.startsWith('You are a security reviewer working for') ? 'product' : 'raw';
    seen.set(init.body, (seen.get(init.body) ?? 0) + 1);
    return answer({ body, arm, n: seen.get(init.body) });
  };
  return { fetchImpl, bodies, headers };
}

// What the stand-in reads from a request: which twin it is. The answer sheet names draft-report.md
// in every request, so a challenge input is told by its draft's title.
const DRAFT_TITLE = 'Re-entrancy in PocketBank.withdrawAll drains depositors';
const twinOf = (user) => (user.includes('Any caller can also redirect') ? 'overclaimed' : user.includes(DRAFT_TITLE) ? 'accurate' : /\n41\| ?\s*balances\[msg\.sender\] = 0;/.test(user) ? 'fixed' : 'vulnerable');

async function withFetch(fetchImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(fetchImpl);
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'product-lift-'));
const prices = new Map([['test/model-a', { in: 1, out: 2 }]]);

async function plan(models = ['test/model-a'], allowances = new Map([['test/model-a', 16000]])) {
  return planJobs({ cases, pairs, models, arms: ['raw', 'product'], prices, allowances, estOut: 'auto', records: [], benchDir: BENCH });
}

test('both arms go through the product call: same body shape, product headers, no key stored', async () => {
  const outDir = tmp(), runDir = path.join(outDir, 'main');
  const { providers } = await productEngine();
  const { jobs } = await plan();
  assert.equal(jobs.length, 8);
  // the stand-in answers every input right; on the product arm it cites the input-N label
  const right = (body, arm) => ({
    overclaimed: () => sheet({ verdict: 'overclaimed', rejected: [{ quote: QUOTE }] }),
    accurate: () => sheet({ verdict: 'supported' }),
    fixed: () => sheet({}),
    vulnerable: () => sheet(FOUND(arm === 'product' ? 'input-2/src/PocketBank.sol' : 'src/PocketBank.sol')),
  })[twinOf(body.messages[1].content)]();
  const stand = standIn(({ body, arm }) => eventStream(sse(right(body, arm))));
  const result = await withFetch(stand.fetchImpl, () => liftAll({ jobs, runDir, outDir, runName: 'main', key: KEY, providers, maxUsd: 5, concurrency: 3, perModel: 3, scoring: protocol.scoring, genStats: async () => null }));
  assert.equal(result.records.length, 8);
  assert.equal(stand.bodies.length, 8);
  assert.deepEqual(result.records.map((r) => [r.case, r.arm, r.correct]).filter((x) => !x[2]), [], 'every stand-in answer scores right');
  for (const b of stand.bodies) {
    assert.deepEqual(Object.keys(b).sort(), ['max_tokens', 'messages', 'model', 'stream'], 'the product body: no temperature, no reasoning, no routing');
    assert.equal(b.model, 'test/model-a');
    assert.equal(b.max_tokens, providers.outputTokenLimit('openrouter', 'test/model-a'));
    assert.equal(b.stream, true);
  }
  for (const h of stand.headers) { assert.equal(h['X-Title'], 'Bounty Operator'); assert.equal(h['HTTP-Referer'], 'https://bountyoperator.com'); }
  // nothing stored holds the key
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const file of walk(outDir)) {
    const bytes = fs.readFileSync(file);
    const text = file.endsWith('.gz') ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    assert.ok(!text.includes(KEY), `${path.basename(file)} holds the key`);
  }
  const recs = readRecords(runDir);
  assert.equal(recs.length, 8);
  const product = recs.find((r) => r.case === 'fx-01-v' && r.arm === 'product');
  assert.equal(product.request.headers.Authorization, '[REDACTED]');
  assert.equal(product.input_labels_stripped, 1);
  assert.equal(product.tokens.out, 400);
  assert.equal(product.tokens.reasoning, 100);
  assert.equal(product.usd, 0.002);
  assert.equal(product.usd_source, 'reported');
  const storedBody = fs.readFileSync(path.join(runDir, 'calls', 'test__model-a', product.request.body_file), 'utf8');
  assert.ok(stand.bodies.some((b) => JSON.stringify(b) === storedBody), 'the stored body is the exact body sent');
  assert.ok(JSON.parse(storedBody).messages[1].content.includes('### input-2/src/PocketBank.sol'));
  assert.ok(zlib.gunzipSync(fs.readFileSync(path.join(runDir, 'calls', 'test__model-a', product.attempts[0].raw_file))).toString().includes('data: [DONE]'));
  assert.equal(readLedger(outDir).attempts, 8);
  assert.ok(Math.abs(readLedger(outDir).usd - 0.016) < 1e-9);
  // resume: nothing is sent twice
  const again = standIn(() => { throw new Error('must not be called'); });
  const second = await withFetch(again.fetchImpl, () => liftAll({ jobs, runDir, outDir, runName: 'main', key: KEY, providers, maxUsd: 5, concurrency: 3, perModel: 3, scoring: protocol.scoring, genStats: async () => null }));
  assert.equal(second.records.filter((r) => r.stored).length, 8);
});

test('a 429 before any output is retried and recorded; output that broke off is not', async () => {
  const outDir = tmp(), runDir = path.join(outDir, 'main');
  const { providers } = await productEngine();
  const { jobs } = await plan();
  const stand = standIn(({ arm, body, n }) => {
    const find = ['vulnerable', 'fixed'].includes(twinOf(body.messages[1].content));
    if (arm === 'raw' && find && n === 1) return new Response(JSON.stringify({ error: { message: 'slow down', code: 429 } }), { status: 429, headers: { 'content-type': 'application/json' } });
    if (arm === 'product' && find) return eventStream(sse('# Review\nVerdict: submit\nHalf of a review', { error: { code: 502, message: 'upstream went away' } }));
    return eventStream(sse(sheet({ verdict: 'supported' })));
  });
  const result = await withFetch(stand.fetchImpl, () => liftAll({ jobs, runDir, outDir, runName: 'main', key: KEY, providers, maxUsd: 5, concurrency: 2, perModel: 2, backoffMs: [5, 5], scoring: protocol.scoring, genStats: async () => null }));
  const retried = result.records.filter((r) => r.retries > 0);
  assert.equal(retried.length, 2, 'both raw find inputs were retried once');
  for (const r of retried) {
    assert.equal(r.arm, 'raw');
    assert.deepEqual([r.attempts[0].http_status, r.attempts[0].retryable, r.attempts[0].usd, r.attempts[1].http_status], [429, true, 0, 200]);
    assert.equal(r.failure, null);
  }
  const broke = result.records.filter((r) => r.arm === 'product' && r.failure === 'error');
  assert.equal(broke.length, 2);
  assert.ok(broke.every((r) => r.retries === 0 && r.before_output === false && r.correct === false), 'an answer that broke off is wrong and never sent again');
  assert.equal(readLedger(outDir).attempts, 10, 'every attempt is in the ledger');
});

test('a refusal of the account (HTTP 402) stops the run and leaves the calls to make later', async () => {
  const outDir = tmp(), runDir = path.join(outDir, 'main');
  const { providers } = await productEngine();
  const { jobs } = await plan();
  const broke = standIn(() => new Response(JSON.stringify({ error: { message: 'Insufficient credits', code: 402, metadata: { limit_source: 'openrouter_credits' } } }), { status: 402, headers: { 'content-type': 'application/json' } }));
  const first = await withFetch(broke.fetchImpl, () => liftAll({ jobs, runDir, outDir, runName: 'main', key: KEY, providers, maxUsd: 5, concurrency: 1, perModel: 1, scoring: protocol.scoring, genStats: async () => null }));
  assert.match(String(first.stopped), /refused the account \(credit, HTTP 402\)/);
  assert.equal(broke.bodies.length, 1, 'nothing more is sent once the account is refused');
  assert.equal(readRecords(runDir).length, 0, 'a refused call is not a record');
  assert.equal(first.not_run, 8);
  const paid = standIn(() => eventStream(sse(sheet({ verdict: 'supported' }))));
  const second = await withFetch(paid.fetchImpl, () => liftAll({ jobs, runDir, outDir, runName: 'main', key: KEY, providers, maxUsd: 5, concurrency: 2, perModel: 2, scoring: protocol.scoring, genStats: async () => null }));
  assert.equal(paid.bodies.length, 8, 'every call is made once the account can pay');
  assert.equal(second.stopped, null);
  assert.equal(readRecords(runDir).length, 8);
});

test('the budget: a call starts only within the cap, and a model that does not fit is dropped whole', async () => {
  const outDir = tmp(), runDir = path.join(outDir, 'main');
  const { providers } = await productEngine();
  const twoModels = ['test/model-a', 'test/model-b'];
  const p2 = new Map([['test/model-a', { in: 1, out: 2 }], ['test/model-b', { in: 50, out: 100 }]]);
  const { jobs } = await planJobs({ cases, pairs, models: twoModels, arms: ['raw', 'product'], prices: p2, allowances: new Map(twoModels.map((m) => [m, 16000])), estOut: 'auto', records: [], benchDir: BENCH });
  assert.deepEqual([...new Set(jobs.map((j) => j.model))], twoModels, 'the cheaper model first');
  const stand = standIn(() => eventStream(sse(sheet({ verdict: 'supported' }))));
  const budget = jobs.filter((j) => j.model === 'test/model-a').reduce((s, j) => s + j.est_usd, 0) + 1;
  const result = await withFetch(stand.fetchImpl, () => liftAll({ jobs, runDir, outDir, runName: 'main', key: KEY, providers, maxUsd: budget, concurrency: 2, perModel: 2, scoring: protocol.scoring, genStats: async () => null }));
  assert.ok(result.dropped['test/model-b'], 'the expensive model is dropped before any of its calls');
  assert.equal(stand.bodies.filter((b) => b.model === 'test/model-b').length, 0);
  assert.equal(result.records.filter((r) => r.model === 'test/model-a').length, 8);
  // the model fits at the estimate, but every call costs its whole reservation: the reservation gate stops the launches
  const outDir2 = tmp();
  const own = jobs.filter((j) => j.model === 'test/model-a');
  const cap = own.reduce((s, j) => s + j.est_usd, 0) + 1e-6;
  const dear = standIn(() => eventStream(sse(sheet({}), { usage: { prompt_tokens: 1000, completion_tokens: 16000, cost: Math.min(...own.map((j) => j.reserve_usd)) } })));
  const tight = await withFetch(dear.fetchImpl, () => liftAll({ jobs: own, runDir: path.join(outDir2, 'main'), outDir: outDir2, runName: 'main', key: KEY, providers, maxUsd: cap, concurrency: 2, perModel: 2, scoring: protocol.scoring, genStats: async () => null }));
  assert.match(String(tight.stopped), /--max-usd/);
  assert.ok(tight.not_run > 0);
  assert.equal(dear.bodies.length, own.length - tight.not_run);
  assert.ok(readLedger(outDir2).usd <= cap, 'the ledger never passes the cap');
});

test('the summary counts pairs, failures, the lift on answered pairs and every flip with its reason', () => {
  const rec = (c, arm, extra) => ({ model: 'm', case: c, arm, variant: byId.get(c).variant, family: byId.get(c).family, failure: null, correct: true, tokens: { out: 100 }, usd: 0.01, ...extra });
  const records = [
    rec('fx-01-v', 'raw'), rec('fx-01-f', 'raw'), rec('fx-02-o', 'raw', { correct: false, verdict: 'supported' }), rec('fx-02-a', 'raw'),
    rec('fx-01-v', 'product', { correct: false }), rec('fx-01-f', 'product'), rec('fx-02-o', 'product'), rec('fx-02-a', 'product', { failure: 'truncated', correct: false, tokens: { out: 16000 } }),
  ];
  const s = summarise({ records, pairs, models: ['m'] });
  const m = s.models[0];
  assert.deepEqual([m.correct.raw, m.correct.product, m.delta], [1, 0, -1]);
  assert.deepEqual(m.failures.product, { truncated: 1 });
  assert.equal(m.failed_calls.raw, 0);
  assert.equal(m.flags.failure_rate_rises, true);
  assert.deepEqual([m.answered.pairs, m.answered.raw, m.answered.product], [1, 1, 0], 'fx-02 is not an answered pair: the product arm truncated');
  assert.equal(m.flags.worse_on_answered, true);
  assert.deepEqual(m.flips.map((f) => [f.pair, f.direction]), [['fx-01', 'loss']], 'fx-02 is wrong on both arms, so it did not flip');
  assert.equal(m.flips[0].product.vulnerable, 'miss');
  assert.equal(twinReason(records[2]), 'overclaim not caught (verdict supported)');
  assert.equal(twinReason({ ...records[3], correct: false, verdict: 'overclaimed' }), 'false rejection of an accurate draft (verdict overclaimed)');
  assert.equal(twinReason({ ...records[1], correct: false }), 'bite on the fixed twin');
  assert.match(renderSummary(s), /product worse on answered pairs/);
});
