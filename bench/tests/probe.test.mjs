// The difficulty probe (tools/probe.mjs) against a stand-in model: prompt shape, the refusal
// of ranked models, scoring through the harness scorer, the budget stop, resume and the table.
// Offline: no request leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_MODELS, PROBE_SYSTEM, assertUnranked, buildProbePrompt, callCost, callOpenRouter, numbered, probeAll, renderTable, scoreProbe, summarise } from '../tools/probe.mjs';
import { loadCases } from '../lib/cases.mjs';
import { taskText } from '../lib/arms.mjs';
import { loadProtocol } from '../bench.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { protocol } = loadProtocol();
const cases = loadCases([path.join(BENCH, 'tests', 'fixtures', 'cases')]);
const byId = new Map(cases.map((c) => [c.id, c]));
const sheet = (o) => `Reviewed.\n\n\`\`\`json\n${JSON.stringify({ findings: [], rejected: [], verdict: 'n/a', max_severity: 'unrated', ...o })}\n\`\`\`\n`;
const FOUND = { findings: [{ file: 'src/PocketBank.sol', function: 'withdrawAll', line_start: 42, line_end: 44, severity: 'high', claim: 'pays before zeroing the balance' }], max_severity: 'high' };
const QUOTE = 'Any caller can also redirect the accrued exit fees to an address of their choice through `sweepDust`';
/** What a model that gets everything right answers for each fixture case. */
const PERFECT = { 'fx-01-v': sheet(FOUND), 'fx-01-f': sheet({}), 'fx-02-o': sheet({ verdict: 'overclaimed', rejected: [{ quote: QUOTE }], max_severity: 'high' }), 'fx-02-a': sheet({ verdict: 'supported', max_severity: 'high' }) };
/** A model that reports the same re-entrancy everywhere and approves every draft: right on one twin of each pair. */
const ALWAYS = { 'fx-01-v': sheet(FOUND), 'fx-01-f': sheet(FOUND), 'fx-02-o': sheet({ verdict: 'supported' }), 'fx-02-a': sheet({ verdict: 'supported' }) };
const caseOf = (user) => cases.find((c) => buildProbePrompt(c, BENCH).user === user).id;
const reply = (text, extra = {}) => ({ ok: true, status: 200, text, finish: 'stop', usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.01 }, usd: 0.01, provider: 'Stand-in', ...extra });

test('the probe models are not on the leaderboard, and a ranked model is refused', () => {
  assert.equal(PROBE_MODELS.length, 4);
  assert.doesNotThrow(() => assertUnranked(PROBE_MODELS, protocol));
  const ranked = protocol.tiers['1'][0];
  assert.throws(() => assertUnranked([PROBE_MODELS[0], ranked], protocol), /must not be on the leaderboard/);
  assert.throws(() => assertUnranked([`${ranked}:free`], protocol), /must not be on the leaderboard/, 'a routing variant of a ranked model is the same model');
  assert.throws(() => assertUnranked([`${ranked}:nitro`], protocol), /leaderboard/);
});

test('the prompt holds every workspace file with line numbers, then the benchmark task', () => {
  assert.equal(numbered('a\nb\n'), '1|a\n2|b');
  assert.equal(numbered('a\n\nc'), '1|a\n2|\n3|c');
  const v = byId.get('fx-01-v'), o = byId.get('fx-02-o');
  const p = buildProbePrompt(v, BENCH);
  assert.equal(p.system, PROBE_SYSTEM);
  for (const f of v.workspace) assert.ok(p.user.includes(`### ${f.path}\n`) && p.user.includes(numbered(f.text)), f.path);
  assert.ok(p.user.endsWith(`${taskText(v, BENCH).trim()}\n`), 'the task and answer sheet are the raw arm\'s, word for word');
  assert.ok(!/truth|canary|fx-01/i.test(p.user) && !p.user.includes(v.truth.canary), 'nothing of the answer key or the case id is sent');
  const q = buildProbePrompt(o, BENCH).user;
  assert.ok(q.indexOf('### draft-report.md') > q.indexOf('### src/PocketBank.sol'), 'the draft comes after the sources');
  assert.ok(q.includes('1|# Re-entrancy in PocketBank.withdrawAll drains depositors'));
  assert.notEqual(buildProbePrompt(byId.get('fx-01-f'), BENCH).sha256, p.sha256);
});

test('answers are scored with the harness scorer', () => {
  for (const [id, text] of Object.entries(PERFECT)) assert.equal(scoreProbe(byId.get(id), text, { scoring: protocol.scoring }).correct, true, id);
  assert.equal(scoreProbe(byId.get('fx-01-f'), ALWAYS['fx-01-f'], { scoring: protocol.scoring }).bite, true);
  assert.equal(scoreProbe(byId.get('fx-02-o'), ALWAYS['fx-02-o'], { scoring: protocol.scoring }).correct, false);
  assert.equal(scoreProbe(byId.get('fx-01-v'), 'no sheet here', { scoring: protocol.scoring }).failure, 'unparseable');
  assert.equal(scoreProbe(byId.get('fx-01-v'), PERFECT['fx-01-v'], { failure: 'truncated', scoring: protocol.scoring }).correct, false);
});

test('a full probe: fraction of probes that got the pair right, per pair and per model', async () => {
  const models = ['small/perfect', 'small/always', 'small/flaky'];
  const seen = [];
  let flakyCalls = 0;
  const call = async ({ model, system, user, maxTokens, routing }) => {
    seen.push({ model, maxTokens, routing });
    assert.equal(system, PROBE_SYSTEM);
    const id = caseOf(user);
    if (model === 'small/perfect') return reply(PERFECT[id]);
    if (model === 'small/always') return reply(ALWAYS[id]);
    flakyCalls++;
    if (id === 'fx-01-f') return { ok: false, status: 503, error: 'upstream down', usage: null, usd: 0 }; // never answers this twin
    if (id === 'fx-02-a') return reply('', { finish: 'length' }); // ran out of tokens
    return reply(PERFECT[id]);
  };
  const res = await probeAll({ cases, models, repeats: 2, scoring: protocol.scoring, call, maxTokens: 777, routing: { data_collection: 'deny' }, retries: 1, backoffMs: 1, benchDir: BENCH, concurrency: 3 });
  assert.equal(res.stopped, null);
  assert.equal(res.calls.length, 3 * 2 * 4);
  assert.ok(seen.every((s) => s.maxTokens === 777 && s.routing.data_collection === 'deny'));
  assert.equal(flakyCalls, 2 * 3 + 2 * 2, 'the failing call is retried once per repeat');
  assert.ok(Math.abs(res.spent - (16 + 6) * 0.01) < 1e-9, 'spend is the sum of what each answered call reported');

  const rows = summarise({ cases, calls: res.calls, models, repeats: 2 });
  const [find, challenge] = rows;
  assert.deepEqual([find.pair, find.probes, find.right, find.first_right, find.second_right, find.void], ['fx-01', 4, 2, 4, 2, 2], 'the flaky model never answered one twin: its two probes are void');
  assert.deepEqual(find.per_model, { 'small/perfect': { probes: 2, right: 2 }, 'small/always': { probes: 2, right: 0 }, 'small/flaky': { probes: 0, right: 0 } });
  assert.deepEqual([find.fraction, find.band], [0.5, 'easy']);
  assert.deepEqual([challenge.pair, challenge.probes, challenge.right, challenge.first_right, challenge.second_right, challenge.void], ['fx-02', 6, 2, 4, 4, 0], 'a truncated answer counts as wrong, as in the benchmark');
  assert.equal(challenge.band, 'medium');
  assert.equal(summarise({ cases, calls: res.calls.filter((c) => c.model === 'small/always'), models: ['small/always'], repeats: 2 })[0].band, 'hard');

  const md = renderTable({ rows, models, repeats: 2, spent: res.spent, stopped: null, date: '2026-10-02 00:00 UTC', settings: 'test' });
  assert.match(md, /\| fx-01 \| find-sol \| anthropic \| 0\.50 \(2\/4\) \| 4\/4 \| 2\/4 \| 2\/2 \| 0\/2 \| - \| easy \|/);
  assert.match(md, /\| fx-02 \| challenge \| anthropic \| 0\.33 \(2\/6\) \| 4\/6 \| 4\/6 \| 2\/2 \| 0\/2 \| 0\/2 \| medium \|/);
  assert.match(md, /\| all \| 2 \| 0\.40 \(4\/10\) \| 1 \| 1 \| 0 \|/);
  assert.match(md, /None of these models is on the leaderboard/);
  assert.match(md, /2 probes had a call with no answer/);
});

test('the budget stops new calls, and a stored answer is never bought twice', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-probe-'));
  try {
    let n = 0;
    const call = async ({ user }) => { n++; return reply(PERFECT[caseOf(user)], { usd: 1, usage: { cost: 1 } }); };
    const prices = new Map([['small/perfect', { in: 0, out: 100 }]]); // worst case per call: 0.5 at 5000 output tokens
    const args = { cases, models: ['small/perfect'], repeats: 1, scoring: protocol.scoring, call, store, maxTokens: 5000, prices, concurrency: 1, benchDir: BENCH };
    const first = await probeAll({ ...args, maxUsd: 2.6 });
    assert.equal(n, 3, 'after three calls ($3) no further call fits under the cap');
    assert.match(first.stopped, /--max-usd 2\.6/);
    assert.equal(first.not_run, 1);
    assert.equal(fs.readdirSync(path.join(store, 'small__perfect')).length, 3);
    const stored = JSON.parse(fs.readFileSync(path.join(store, 'small__perfect', `${first.calls[0].case}.1.json`), 'utf8'));
    assert.equal(stored.correct, true);
    assert.ok(stored.text.includes('findings'), 'the raw answer is kept for audit');

    // a second invocation only buys what is missing
    const second = await probeAll({ ...args, maxUsd: 100 });
    assert.equal(n, 4);
    assert.equal(second.calls.filter((c) => c.stored).length, 3);
    assert.equal(second.calls.length, 4);
    assert.equal(summarise({ cases, calls: second.calls, models: ['small/perfect'], repeats: 1 }).every((r) => r.fraction === 1), true);
    // --fresh buys everything again; a changed output cap is a different probe
    await probeAll({ ...args, maxUsd: 100, fresh: true });
    assert.equal(n, 8);
    await probeAll({ ...args, maxUsd: 100, maxTokens: 6000 });
    assert.equal(n, 12);
  } finally { fs.rmSync(store, { recursive: true, force: true }); }
});

test('a model with no endpoint under the routing rules is dropped after its first refusal', async () => {
  let n = 0;
  const call = async ({ model, user }) => {
    if (model === 'small/blocked') { n++; return { ok: false, status: 404, error: 'No endpoints found matching your data policy', usage: null, usd: 0 }; }
    return reply(PERFECT[caseOf(user)]);
  };
  const res = await probeAll({ cases, models: ['small/blocked', 'small/perfect'], repeats: 2, scoring: protocol.scoring, call, maxTokens: 100, concurrency: 1, benchDir: BENCH });
  assert.equal(n, 1, 'one refusal is enough');
  assert.deepEqual(Object.keys(res.unavailable), ['small/blocked']);
  const rows = summarise({ cases, calls: res.calls, models: ['small/blocked', 'small/perfect'], repeats: 2 });
  assert.deepEqual(rows.map((r) => [r.probes, r.right]), [[2, 2], [2, 2]], 'the fractions cover the models that answered');
  assert.match(renderTable({ rows, models: ['small/blocked', 'small/perfect'], repeats: 2, spent: 0, unavailable: res.unavailable, date: 'd', settings: 's' }), /No answer from `small\/blocked`/);
});

test('one request: body, headers, cost and error handling', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ id: 'gen-1', provider: 'P', choices: [{ finish_reason: 'stop', message: { content: 'hello sk-secret' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002 } }), { status: 200 }); };
  const ok = await callOpenRouter({ api: 'https://example.invalid/api/v1', key: 'sk-secret', model: 'm/x', system: 'S', user: 'U', maxTokens: 9, routing: { data_collection: 'deny' }, fetchImpl });
  assert.deepEqual([ok.ok, ok.text, ok.finish, ok.usd, ok.provider], [true, 'hello [REDACTED]', 'stop', 0.002, 'P']);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(sent[0].url, 'https://example.invalid/api/v1/chat/completions');
  assert.deepEqual(body, { model: 'm/x', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], max_tokens: 9, usage: { include: true }, provider: { data_collection: 'deny' } });
  assert.ok(!('temperature' in body) && !('tools' in body), 'single shot: no tools, no sampling parameters');
  assert.equal(sent[0].init.headers.authorization, 'Bearer sk-secret');

  const refused = await callOpenRouter({ key: 'sk-secret', model: 'm/x', system: 'S', user: 'U', maxTokens: 9, fetchImpl: async () => new Response(JSON.stringify({ error: { code: 429, message: 'slow down sk-secret' } }), { status: 429 }) });
  assert.deepEqual([refused.ok, refused.status, refused.error], [false, 429, 'slow down [REDACTED]']);
  const down = await callOpenRouter({ key: 'k', model: 'm/x', system: 'S', user: 'U', maxTokens: 9, fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.deepEqual([down.ok, down.status], [false, 0]);

  assert.equal(callCost({ usd: 0.5 }, { in: 1, out: 1 }), 0.5, 'the billed cost when OpenRouter reports one');
  assert.equal(callCost({ usd: null, usage: { prompt_tokens: 1_000_000, completion_tokens: 2_000_000 } }, { in: 1, out: 3 }), 7, 'else tokens at list prices');
  assert.equal(callCost({ usd: null, usage: null }, { in: 1, out: 3 }), 0);
});
