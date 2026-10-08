// The 'blocked' failure kind: a run the provider or its safety layer declined, for which no
// model judgment exists. Covers every signal the classifier accepts and the cases it must not
// (lib/runs.mjs), the scoring rules (lib/score.mjs), the runner against the stand-in omp, a
// score -> publish -> verify round trip, and the product-lift tool's separate privacy_block.
// A release stored before the rule (its block notices are 'unparseable') must score as it did.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BLOCKED, BLOCK_STOP_REASONS, CYBER_NOTICE_PREFIX, NOTICE_MAX_CHARS, RUN_SCHEMA, classifyError, classifyRun, modelDir, policyNotice, resumeKey, runName, toScoreRun } from '../lib/runs.mjs';
import { DEFAULT_SCORING, aggregate, aggregateInputFromPublished, scoreInput } from '../lib/score.mjs';
import { parseEvents } from '../lib/parse.mjs';
import { loadCases, pairsOf } from '../lib/cases.mjs';
import { createInvocation } from '../lib/omp.mjs';
import { sweepStray } from '../tools/sweep-stray.mjs';
import { classify, liftAll, readStream, renderSummary, summarise, twinReason } from '../tools/product-lift.mjs';
import { loadProtocol, runTask, storedRun } from '../bench.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_CASES = path.join(BENCH, 'tests', 'fixtures', 'cases');
const { protocol, sha, hashes } = loadProtocol();
const S = DEFAULT_SCORING;
const F = '```';
// the notice exactly as the 2026-10 runs stored it: 206 characters, a normal stop
const NOTICE = `${CYBER_NOTICE_PREFIX} To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.`;
const sheet = (o) => `Review.\n\n${F}json\n${JSON.stringify({ findings: [], rejected: [], verdict: 'n/a', max_severity: 'unrated', ...o })}\n${F}\n`;

// ---------------------------------------------------------------- the classifier

const okChecks = { requests: true, tools: true, model: true, system: true, nonce: true, cwd: true, no_sampling: true, ok: true };
const final = (over = {}) => ({ model: 'anthropic/claude-test', provider: 'openrouter', stopReason: 'stop', errorStatus: null, errorMessage: null, text: '', toolCalls: 0, strayToolCall: false, ...over });
const ev = (f, usage = { input: 5711, output: 300, cacheRead: 0 }) => ({ final: f, finalText: f?.text ?? '', usage, models: f?.model ? [f.model] : [], providers: [] });
const res = (over = {}) => ({ spawnError: null, timedOut: false, sawModelOutput: true, exitCode: 0, ...over });
const run = (f, { usage, stderr = '', r = res() } = {}) => classifyRun({ res: r, ev: ev(f, usage), checks: okChecks, stderr });
const blocked = (detail) => ({ status: 'failed', failure: 'blocked', detail, final: true, retry: false, halt: null });

test('the notice is recognised by its opening sentence, within 800 characters, with no answer sheet', () => {
  assert.equal(NOTICE.length, 206);
  assert.equal(BLOCKED, 'blocked');
  assert.equal(policyNotice(NOTICE), 'anthropic-cyber');
  assert.equal(policyNotice(`\n  ${NOTICE}\n`), 'anthropic-cyber', 'surrounding white space is ignored');
  assert.equal(policyNotice(`${CYBER_NOTICE_PREFIX} To request an adjustment pursuant to our Cyber Verification Program, see the link.`), 'anthropic-cyber', 'a prefix match: the rest of the wording may change');
  assert.equal(policyNotice(CYBER_NOTICE_PREFIX), 'anthropic-cyber');
  const padded = `${CYBER_NOTICE_PREFIX} ${'x'.repeat(NOTICE_MAX_CHARS - CYBER_NOTICE_PREFIX.length - 1)}`;
  assert.equal(padded.length, NOTICE_MAX_CHARS);
  assert.equal(policyNotice(padded), 'anthropic-cyber', 'exactly 800 characters still counts');
  assert.equal(policyNotice(`${padded}x`), null, '801 characters does not');
});

test('an answer that quotes the notice, runs long or carries an answer sheet is the model\'s own answer', () => {
  const long = `${NOTICE}\n\nThe vendor returned the text above for a similar request last week. My review follows.\n${'The withdraw path updates the balance after the external call. '.repeat(20)}`;
  assert.ok(long.length > NOTICE_MAX_CHARS);
  assert.equal(policyNotice(long), null, 'a long answer that opens with the notice');
  assert.equal(policyNotice(`The draft cites this provider message: "${NOTICE}"`), null, 'the notice quoted inside an answer');
  assert.equal(policyNotice(`Review.\n\n> ${NOTICE}`), null);
  const withSheet = `${CYBER_NOTICE_PREFIX}\n\n${sheet({ verdict: 'supported', max_severity: 'high' })}`;
  assert.ok(withSheet.length <= NOTICE_MAX_CHARS);
  assert.equal(policyNotice(withSheet), null, 'an answer sheet is a judgment, whatever precedes it');
  for (const prose of ['', '   ', "I can't help with that.", 'I\'m sorry, but I cannot assist with exploiting smart contracts.', 'This request was blocked.']) assert.equal(policyNotice(prose), null, prose);

  assert.deepEqual(run(final({ text: long })), { status: 'ok', failure: null, detail: null, final: true, retry: false, halt: null });
  assert.equal(run(final({ text: withSheet })).status, 'ok');
  assert.equal(run(final({ text: "I can't help with that." })).status, 'ok', 'refusal prose is an answer; the scorer finds no sheet in it');
});

test('signal 1: the notice with a normal stop is a blocked run, final and never retried', () => {
  assert.deepEqual(run(final({ text: NOTICE })), blocked('anthropic-cyber'));
  assert.deepEqual(run(final({ text: NOTICE }), { usage: { input: 0, output: 0, cacheRead: 0 } }), blocked('anthropic-cyber'), 'a block that reports no usage is not retried as a cached response');
  assert.equal(run(final({ text: sheet({}) }), { usage: { input: 0, output: 0, cacheRead: 0 } }).failure, 'infra', 'an ordinary answer with zero usage is still a cached response');
  assert.equal(run(final({ text: NOTICE, stopReason: 'length' })).failure, 'truncated', 'only a normal stop is read as the notice');
});

test('signal 2: stop reasons refusal and content_filter are blocked runs', () => {
  assert.deepEqual(BLOCK_STOP_REASONS, ['refusal', 'content_filter']);
  assert.deepEqual(run(final({ stopReason: 'refusal' })), blocked('anthropic-refusal'));
  assert.deepEqual(run(final({ stopReason: 'content_filter', model: 'deepseek/deepseek-test', text: 'half an answer' })), blocked('deepseek-content_filter'), 'partial output before the filter is not an answer');
  assert.deepEqual(run(final({ stopReason: 'refusal', model: 'claude-test' })), blocked('provider-refusal'), 'no vendor in the slug');
  assert.equal(run(final({ stopReason: 'pause_turn' })).failure, 'error', 'any other unknown stop reason stays an error');
});

test('signal 3: a policy error envelope is a blocked run and is never retried as infrastructure', () => {
  const err = (errorStatus, errorMessage, model = 'anthropic/claude-test') => run(final({ stopReason: 'error', errorStatus, errorMessage, model }), { r: res({ exitCode: 1 }) });
  assert.deepEqual(err(400, '{"error":{"code":"cyber_policy","message":"This request was flagged"}}', 'openai/gpt-test'), blocked('openai-cyber_policy'));
  assert.deepEqual(err(null, 'cyber_policy', 'gpt-test'), blocked('openai-cyber_policy'), 'the code belongs to OpenAI when the slug names no vendor');
  // OpenRouter's wrapper says "Provider returned error" and "upstream": both are in the infrastructure pattern
  const wrapped = 'Provider returned error: {"error":{"code":403,"message":"The upstream provider refused to respond","metadata":{"error_type":"refusal","provider_name":"Anthropic"}}}';
  assert.equal(classifyError(null, 'Provider returned error: upstream').kind, 'infra', 'the same wrapper without a policy signal is infrastructure');
  assert.deepEqual(err(403, wrapped), blocked('anthropic-refusal'));
  assert.deepEqual(err(403, 'Provider returned error (upstream): content_policy_violation: SAFETY', 'google/gemini-test'), blocked('google-content_policy_violation'));
  assert.deepEqual(err(500, `upstream error: ${NOTICE}`, 'claude-test'), blocked('anthropic-cyber'), 'the notice inside an error, even with a 5xx status');
  assert.deepEqual(err(403, 'Your chosen model requires moderation and your input was flagged for violence', 'x-ai/grok-test'), blocked('x-ai-moderation'));
  assert.deepEqual(err(403, 'Request blocked by a guardrail', 'mistralai/mistral-test'), blocked('mistralai-moderation'));
  assert.deepEqual(classifyError(403, 'Input flagged by moderation'), { kind: 'blocked', retry: false, halt: null, category: 'moderation', vendor: null });
  assert.deepEqual(classifyError(400, 'error code cyber_policy'), { kind: 'blocked', retry: false, halt: null, category: 'cyber_policy', vendor: 'openai' });
  // no assistant message at all: omp exited and stderr holds the provider's error
  const silent = classifyRun({ res: res({ exitCode: 1, sawModelOutput: false }), ev: ev(null), checks: okChecks, stderr: `Error: 403 ${wrapped}` });
  assert.deepEqual(silent, blocked('provider-refusal'));
});

test('a 403 that is an auth failure, an account gate or a rate limit is not a block', () => {
  assert.equal(classifyError(403, 'Forbidden').kind, 'error', 'a bare 403 carries no policy signal');
  assert.equal(classifyError(403, 'Provider rejected the API key').kind, 'error');
  assert.deepEqual(classifyError(403, 'Invalid API key'), { kind: 'auth', retry: false, halt: 'all' }, 'a key failure on a 403 stops everything');
  assert.deepEqual(classifyError(401, 'No auth credentials found; your request was flagged by moderation'), { kind: 'auth', retry: false, halt: 'all' }, 'auth is decided first');
  assert.deepEqual(classifyError(402, 'Insufficient credits (content_policy_violation)'), { kind: 'budget', retry: false, halt: 'all' }, 'credit is decided first');
  assert.deepEqual(classifyError(403, 'This model requires you to accept the terms of its usage policy'), { kind: 'unavailable', retry: false, halt: 'model' }, 'an account gate is decided first');
  assert.equal(classifyError(403, 'Ask your team admin for permission.').kind, 'error');
  assert.deepEqual(classifyError(429, 'Rate limit exceeded under the fair usage policy'), { kind: 'infra', retry: true, halt: null }, 'moderation wording only counts on a 403');
  assert.equal(classifyError(400, 'content filtered').kind, 'error');
  assert.equal(classifyError(null, 'The model refused: content policy').kind, 'error', 'general refusal wording is not matched');
  const auth = run(final({ stopReason: 'error', errorStatus: 403, errorMessage: 'Forbidden: invalid api key' }), { r: res({ exitCode: 1 }) });
  assert.deepEqual([auth.failure, auth.final, auth.halt], ['infra', false, 'all']);
});

// ---------------------------------------------------------------- stored runs and the scorer

const eventsOf = (text, model = 'anthropic/claude-test') => `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model, content: [{ type: 'text', text }], usage: { input: 5711, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: 'stop' } })}\n`;
const vuln = { id: 'sol-01-v', pair: 'sol-01', family: 'find-sol', variant: 'vulnerable' };
const vulnTruth = { planted: [{ id: 'P1', primary: true, file: 'src/A.sol', lines: [[70, 77]], functions: ['deposit'], severity: ['high'] }], decoys: [], acceptable: [], patched_region: null, report: null };

test('a stored run: blocked goes to the scorer as blocked; the notice stored as unparseable stays unparseable', () => {
  const parsed = parseEvents(eventsOf(NOTICE));
  assert.equal(classifyRun({ res: res(), ev: parsed, checks: okChecks }).failure, 'blocked', 'the parsed event stream of a notice run');
  const now = toScoreRun({ meta: { failure: 'blocked', usd: 0.03 }, eventsText: eventsOf(NOTICE) });
  assert.deepEqual([now.failure, now.sheet], ['blocked', null]);
  const o = scoreInput(vuln, vulnTruth, now, S);
  assert.deepEqual([o.status, o.failure, o.correct, o.usd], ['failed', 'blocked', false, 0.03]);
  // the 2026-10 release: the same answer, stored before the rule existed. Scoring never reclassifies a stored run.
  const then = toScoreRun({ meta: { failure: 'unparseable', usd: 0.03 }, eventsText: eventsOf(NOTICE) });
  assert.equal(then.failure, null);
  assert.equal(scoreInput(vuln, vulnTruth, then, S).failure, 'unparseable');
  assert.equal(scoreInput(vuln, vulnTruth, toScoreRun({ meta: { failure: null }, eventsText: eventsOf(NOTICE) }), S).failure, 'unparseable');
});

const pairs = [
  { pair: 'sol-01', family: 'find-sol', visibility: 'public', author: 'openai', cases: { vulnerable: 'sol-01-v', fixed: 'sol-01-f' } },
  { pair: 'sol-02', family: 'find-sol', visibility: 'held', author: 'google', cases: { vulnerable: 'sol-02-v', fixed: 'sol-02-f' } },
  { pair: 'ts-01', family: 'find-ts', visibility: 'held', author: 'openai', cases: { vulnerable: 'ts-01-v', fixed: 'ts-01-f' } },
  { pair: 'ch-01', family: 'challenge', visibility: 'held', author: 'anthropic', cases: { overclaimed: 'ch-01-o', accurate: 'ch-01-a' } },
];
const arms = { 'find-sol': ['raw', 'solidity'], 'find-ts': ['raw', 'general'], challenge: ['raw', 'report'] };
function oc(caseId, arm, rep, correct) {
  const p = pairs.find((x) => Object.values(x.cases).includes(caseId));
  const variant = Object.entries(p.cases).find(([, id]) => id === caseId)[0];
  const base = { case: caseId, pair: p.pair, family: p.family, variant, arm, rep, status: 'ok', failure: null, correct, hits: [], planted: variant === 'vulnerable' ? 1 : 0, decoys: p.family === 'challenge' ? 0 : 1, decoy_bites: 0, bite: variant === 'fixed' ? !correct : null, usd: 0.02, wall_s: 30, effort: 'high', providers: ['Prov'] };
  if (variant === 'vulnerable' && correct) base.hits = [{ id: 'P1', primary: true, finding: 0, by_line: true, by_function: true, severity: 'high', severity_exact: true, severity_distance: 0 }];
  return base;
}
/** every input of every arm; `wrong` and `block` list "case|arm|rep" keys */
function outcomes(reps, { wrong = [], block = [], as = 'blocked' } = {}) {
  const list = [];
  for (const p of pairs) for (const arm of arms[p.family]) for (let rep = 1; rep <= reps; rep++) for (const id of Object.values(p.cases)) {
    const key = `${id}|${arm}|${rep}`;
    const o = oc(id, arm, rep, !wrong.includes(key) && !block.includes(key));
    list.push(block.includes(key) ? { ...o, status: 'failed', failure: as, correct: false, hits: [], bite: null } : o);
  }
  return list;
}
const meta = { release: 't', run_id: 'r', protocol_sha256: 'p', harness_commit: 'h', omp_version: 'omp/18.4.4', generated_at: '2026-10-02T00:00:00.000Z', prices_at: '2026-10-02T00:00:00.000Z', thinking: 'max' };
const model = (slug, list) => ({ slug, name: slug, vendor: slug.split('/')[0], open_weight: false, price: { in: 1, out: 2 }, run_tier: 1, outcomes: list });
const agg = (models, repeats = 1) => aggregate({ meta: { ...meta, repeats }, scoring: S, arms, pairs, models });

test('results without a blocked outcome carry no blocked field at all', () => {
  const result = agg([model('a/one', outcomes(2, { wrong: ['sol-01-f|raw|1', 'ch-01-o|report|2'] })), model('b/two', outcomes(2, { wrong: ['ts-01-v|raw|1'] }))], 2);
  assert.ok(!JSON.stringify(result).includes('blocked'), 'the published shape of a release with no block is the one from before the rule');
});

test('a blocked input is counted on its own and leaves every accuracy denominator', () => {
  const block = ['ts-01-v|raw|1'];
  const [m] = agg([model('a/m', outcomes(1, { wrong: ['sol-01-f|raw|1'], block }))]).models;
  const raw = m.arms.raw;
  assert.deepEqual([raw.blocked, raw.pairs_blocked, m.blocked], [1, 1, 1]);
  assert.equal(raw.pairs, 4);
  assert.deepEqual(raw.score, { median: 66.67, min: 66.67, max: 66.67, majority: 66.67, ci95: raw.score.ci95 }, '2 of the 3 pairs that have a result');
  assert.deepEqual(raw.by_family, { challenge: 100, 'find-sol': 50, 'find-ts': null }, 'a family whose only pair was blocked has no score');
  assert.deepEqual(raw.by_author.openai, { pairs: 2, score: 0 }, 'sol-01 wrong, ts-01 blocked: one pair with a result');
  assert.equal(raw.recall, 1, '2 hits in the 2 planted bugs of the inputs that were answered');
  assert.equal(raw.fools_gold, 0.3333, 'the fixed twin of the blocked pair was answered and still counts: 1 bite in 3');
  assert.equal(raw.failure, 0, 'a block is not a failure of the model');
  assert.deepEqual([raw.runs, raw.runs_expected, raw.unresolved, m.complete], [8, 8, 0, true], 'the run was made and is final');
  assert.equal(raw.usd_total, 0.16, 'its cost is still counted');
  assert.equal(m.tier, 1, 'the model is ranked on the pairs that have a result');

  // the same outcome under the kind the 2026-10 release stored: a wrong answer, as published
  const [old] = agg([model('a/m', outcomes(1, { wrong: ['sol-01-f|raw|1'], block, as: 'unparseable' }))]).models;
  assert.deepEqual([old.arms.raw.score.median, old.arms.raw.failure, old.arms.raw.recall], [50, 0.125, 0.6667]);
  assert.ok(!('blocked' in old.arms.raw) && !('blocked' in old));
});

test('a paired comparison leaves out a pair that is blocked on either side', () => {
  // raw wrong on both find-sol pairs, the profile right: +100 on 2 pairs
  const wrong = ['sol-01-v|raw|1', 'sol-02-v|raw|1'];
  const free = agg([model('x/m', outcomes(1, { wrong }))]).models[0].lift;
  assert.deepEqual(free.solidity, { delta: 100, ci95: [100, 100], n_pairs: 2, significant: true });
  // sol-02 blocked on the profile arm: the pair leaves the comparison instead of counting as a loss or a draw
  const profileSide = agg([model('x/m', outcomes(1, { wrong, block: ['sol-02-f|solidity|1'] }))]).models[0];
  assert.deepEqual(profileSide.lift.solidity, { delta: 100, ci95: [100, 100], n_pairs: 1, significant: true, pairs_blocked: 1 });
  assert.deepEqual([profileSide.arms.solidity.blocked, profileSide.arms.solidity.pairs_blocked, profileSide.arms.raw.blocked], [1, 1, 0]);
  // sol-01 blocked on the raw arm: the profile's right answer on it is not a gain
  const rawSide = agg([model('x/m', outcomes(1, { wrong: ['sol-02-v|raw|1'], block: ['sol-01-v|raw|1'] }))]).models[0];
  assert.deepEqual(rawSide.lift.solidity, { delta: 100, ci95: [100, 100], n_pairs: 1, significant: true, pairs_blocked: 1 });
  assert.deepEqual(rawSide.lift.report, { delta: 0, ci95: [0, 0], n_pairs: 1, significant: false, pairs_blocked: 0 });
  // the only pair of a comparison blocked: no number, never a zero
  const none = agg([model('x/m', outcomes(1, { block: ['ts-01-f|general|1'] }))]).models[0];
  assert.deepEqual(none.lift.general, { delta: null, ci95: null, n_pairs: 0, significant: false, pairs_blocked: 1 });
  assert.equal(none.arms.general.score.median, null);
  assert.ok(!agg([model('x/m', outcomes(1, { block: ['ts-01-f|general|1'] }))]).picks.some((p) => p.arm === 'general'), 'an arm with no score supplies no pick');
});

test('with repeats, a pair is judged on the repeats that have a result', () => {
  // sol-01: blocked in repeat 1, right in 2, wrong in 3 -> 1 of 2 is no majority. ts-01: blocked in every repeat.
  const block = ['sol-01-v|raw|1', 'ts-01-v|raw|1', 'ts-01-f|raw|2', 'ts-01-v|raw|3'];
  const [m] = agg([model('a/m', outcomes(3, { wrong: ['sol-01-f|raw|3'], block }))], 3).models;
  const raw = m.arms.raw;
  assert.deepEqual([raw.blocked, raw.pairs_blocked], [4, 1], 'only ts-01 has no result in any repeat');
  assert.deepEqual([raw.score.min, raw.score.median, raw.score.max], [66.67, 100, 100], 'repeat 1: 2 of 2; repeat 2: 3 of 3; repeat 3: 2 of 3');
  assert.equal(raw.score.majority, 66.67, 'sol-02 and ch-01 of the three judged pairs');
  assert.equal(raw.repeat_agreement, 0.6667, 'sol-02 and ch-01 agree with themselves; sol-01 does not; ts-01 is not counted');
});

test('a model blocked on every pair has no score and no tier, and the others keep theirs', () => {
  const everything = outcomes(1).filter((o) => o.arm === 'raw').map((o) => `${o.case}|raw|1`);
  const result = agg([model('a/open', outcomes(1)), model('b/shut', outcomes(1, { block: everything }))]);
  const by = Object.fromEntries(result.models.map((m) => [m.slug, m]));
  assert.deepEqual([by['b/shut'].arms.raw.score.median, by['b/shut'].arms.raw.score.majority, by['b/shut'].arms.raw.score.ci95, by['b/shut'].tier], [null, null, null, null]);
  assert.deepEqual([by['b/shut'].arms.raw.blocked, by['b/shut'].arms.raw.pairs_blocked, by['b/shut'].arms.raw.failure, by['b/shut'].complete], [8, 4, null, true]);
  assert.deepEqual(by['b/shut'].lift.solidity, { delta: null, ci95: null, n_pairs: 0, significant: false, pairs_blocked: 2 }, 'no comparison without a raw result: no number, never a zero');
  assert.deepEqual([by['a/open'].tier, by['a/open'].arms.raw.score.median, by['a/open'].arms.raw.blocked], [1, 100, 0], 'every model of the release states its count, zero included');
  assert.equal(result.models[0].slug, 'a/open');
  assert.ok(result.picks.every((p) => p.model === 'a/open'));
});

test('results with blocked outcomes recompute from the per-model detail files', () => {
  const models = [model('a/one', outcomes(2, { wrong: ['sol-01-f|raw|1'], block: ['ts-01-v|raw|1', 'ch-01-o|report|2'] })), model('b/two', outcomes(2))];
  const published = JSON.parse(JSON.stringify(agg(models, 2)));
  const details = models.map((m) => ({ slug: m.slug, outcomes: JSON.parse(JSON.stringify(m.outcomes)) }));
  assert.deepEqual(aggregate(aggregateInputFromPublished(published, details)), published);
  details[0].outcomes.find((o) => o.case === 'ts-01-v' && o.arm === 'raw' && o.rep === 1).failure = 'unparseable';
  assert.notDeepEqual(aggregate(aggregateInputFromPublished(published, details)), published, 'relabelling a block as a wrong answer changes the numbers');
});

// ---------------------------------------------------------------- the runner

const FAKE = path.join(BENCH, 'tests', 'fixtures', 'fake-omp.mjs');
const [fxVuln] = loadCases([FIXTURE_CASES], { glob: 'fx-01-v' });

async function withFake(mode, fn) {
  const saved = [process.env.PAYDIRT_OMP, process.env.PAYDIRT_OMP_ARGS];
  process.env.PAYDIRT_OMP = process.execPath;
  process.env.PAYDIRT_OMP_ARGS = JSON.stringify([FAKE, mode]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-blocked-'));
  const ctx = createInvocation({ benchDir: BENCH, protocol, key: 'sk-or-v1-FAKE-KEY-0123456789' });
  try { return await fn(ctx, out); } finally {
    ctx.destroy();
    fs.rmSync(out, { recursive: true, force: true });
    for (const [i, name] of ['PAYDIRT_OMP', 'PAYDIRT_OMP_ARGS'].entries()) { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }
  }
}
const callsOf = (ctx) => Number(fs.readFileSync(path.join(ctx.worker(0).home, 'fake-omp-calls'), 'utf8'));

for (const [mode, detail, stop] of [['notice', 'anthropic-cyber', 'stop'], ['policy403', 'acme-refusal', 'error']]) {
  test(`the runner stores a ${mode} run as blocked: one attempt, final, no halt`, () => withFake(mode, async (ctx, out) => {
    const env = { ctx, protocol, hashes, runRoot: out, runId: 'unit', catalogue: new Map(), ompVer: 'omp/18.4.4', stop: { reason: null }, genStats: 'off' };
    const task = { model: 'acme/model-1', kase: fxVuln, arm: 'raw', rep: 1 };
    const meta = await runTask(env, task, 0);
    assert.deepEqual([meta.status, meta.failure, meta.failure_detail, meta.final, meta.halt, meta.stop_reason], ['failed', 'blocked', detail, true, null, stop]);
    assert.deepEqual(meta.attempts, [], 'never retried');
    assert.equal(callsOf(ctx), 1, 'omp was started once');
    assert.equal(meta.sheet, null);
    assert.equal(meta.checks.ok, true);
    assert.ok(storedRun(out, hashes, task, []), 'the stored run is final: the next invocation does not buy it again');
    assert.equal(storedRun(out, hashes, task, ['blocked']), null, '--redo blocked makes it again, for an account that has since been approved');
    const dir = path.join(out, 'raw', 'acme__model-1', 'fx-01-v.raw.1');
    const scored = scoreInput(fxVuln, fxVuln.truth, toScoreRun({ meta, eventsText: fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8') }), protocol.scoring);
    assert.deepEqual([scored.failure, scored.correct], ['blocked', false]);
    const swept = sweepStray(out, { log: () => {} });
    assert.deepEqual([swept.seen, swept.stray.length], [1, 0], 'a blocked run is not swept as infrastructure');
  }));
}

test('the sweep leaves a stored error alone when the current rules read it as a policy block', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-sweep-'));
  try {
    const write = (name, detail) => {
      const dir = path.join(root, 'raw', 'acme__m', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schema: RUN_SCHEMA, model: 'acme/m', status: 'failed', failure: 'error', failure_detail: detail, final: true }));
      fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    };
    write('a.raw.1', '403 Your input was flagged by moderation');
    write('b.raw.1', 'OpenAI responses stream stalled while waiting for the next event');
    const swept = sweepStray(root, { log: () => {} });
    assert.deepEqual(swept.stray.map((s) => s.run), ['b.raw.1']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- score -> publish -> verify

const cli = (...args) => spawnSync(process.execPath, [path.join(BENCH, 'bench.mjs'), ...args], { encoding: 'utf8' });
const reentrancy = { file: 'src/PocketBank.sol', function: 'withdrawAll', line_start: 42, line_end: 44, severity: 'high', claim: 'pays before zeroing' };
const RIGHT = {
  'fx-01-v': sheet({ findings: [reentrancy], max_severity: 'high' }),
  'fx-01-f': sheet({ findings: [{ ...reentrancy, severity: 'info', claim: 'ordering is fine here' }] }),
  'fx-02-o': sheet({ verdict: 'overclaimed', max_severity: 'high', rejected: [{ quote: 'Any caller can also redirect the accrued exit fees to an address of their choice' }] }),
  'fx-02-a': sheet({ verdict: 'supported', max_severity: 'high' }),
};

/** One model that answers every fixture case right, except the runs in `notice`, which hold the block notice stored under the failure kind `as`. */
function writeRuns(runsDir, runId, cases, { notice = [], as = 'blocked' } = {}) {
  const root = path.join(runsDir, runId), slug = 'anthropic/claude-test';
  let n = 0;
  for (const kase of cases) for (const arm of protocol.arms[kase.family]) {
    const dir = path.join(root, 'raw', modelDir(slug), runName(kase.id, arm, 1));
    fs.mkdirSync(dir, { recursive: true });
    const isNotice = notice.includes(`${kase.id}|${arm}`);
    const answer = isNotice ? NOTICE : RIGHT[kase.id];
    fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'session', cwd: 'D:\\pdw\\x\\y\\ws' })}\n${eventsOf(answer, slug)}`);
    fs.writeFileSync(path.join(dir, 'answer.md'), answer);
    fs.writeFileSync(path.join(dir, 'request.json'), `${JSON.stringify({ model: slug, instructions: 'system', tools: [] })}\n`);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      schema: RUN_SCHEMA, key: resumeKey({ armSha: hashes.arms[arm], model: slug, inputHash: kase.inputHash, arm, rep: 1 }), run_id: runId, arm_sha256: hashes.arms[arm], core_sha256: hashes.core, protocol_sha256: sha,
      model: slug, case: kase.id, pair: kase.pair, family: kase.family, arm, rep: 1, input_hash: kase.inputHash,
      finished_at: `2026-10-02T10:00:${String(n).padStart(2, '0')}.000Z`, wall_s: 20 + n, status: isNotice ? 'failed' : 'ok', failure: isNotice ? as : null, failure_detail: isNotice && as === 'blocked' ? 'anthropic-cyber' : null, final: true,
      stop_reason: 'stop', turns: 1, usage: { input: 5711, output: 300, cacheRead: 0, cacheWrite: 0, reasoning: 22 }, usd: 0.01, usd_source: 'omp', effort: 'high', providers: ['ProviderOne'], attempts: [],
    }));
    n++;
  }
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ prices_at: '2026-10-02T09:00:00.000Z', harness_commit: 'abc123', models: { [slug]: { slug, name: 'Claude Test', vendor: 'anthropic', open_weight: false, price: { in: 2, out: 10 }, run_tier: 1 } } }));
}

function publishRound(tmp, id, options) {
  const runs = path.join(tmp, 'runs'), outDir = path.join(tmp, `web-${id}`);
  writeRuns(runs, id, loadCases([FIXTURE_CASES]), options);
  const score = cli('score', '--run-id', id, '--runs-dir', runs, '--cases-root', FIXTURE_CASES);
  assert.equal(score.status, 0, score.stderr);
  const pub = cli('publish', '--run-id', id, '--runs-dir', runs, '--cases-root', FIXTURE_CASES, '--out-dir', outDir, '--salts', path.join(tmp, 'salts.json'), '--release', id);
  assert.equal(pub.status, 0, pub.stderr + pub.stdout);
  const latest = JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
  const verify = cli('verify', '--results', path.join(outDir, 'latest.json'), '--archive', path.join(outDir, latest.downloads.archive));
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /8\/8 raw runs on public cases re-scored from events \+ answer key: identical/);
  const detail = JSON.parse(fs.readFileSync(path.join(outDir, latest.models[0].detail), 'utf8'));
  return { latest, detail, score, text: fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8') };
}

test('score, publish and verify: a blocked run is published as blocked and the release verifies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-blocked-e2e-'));
  try {
    const notice = ['fx-01-v|raw'];
    const { latest, detail, score } = publishRound(tmp, 'with-block', { notice });
    const [m] = latest.models;
    assert.deepEqual([m.blocked, m.complete, m.tier], [1, true, 1], 'a blocked run does not hold the release back');
    assert.deepEqual([m.arms.raw.blocked, m.arms.raw.pairs_blocked, m.arms.raw.score.median, m.arms.raw.failure, m.arms.raw.runs], [1, 1, 100, 0, 4], 'the score is over the challenge pair');
    assert.deepEqual(m.arms.raw.by_family, { challenge: 100, 'find-sol': null });
    assert.deepEqual(m.lift.solidity, { delta: null, ci95: null, n_pairs: 0, significant: false, pairs_blocked: 1 }, 'the profile got the pair right; with the raw side blocked that is not a gain');
    assert.deepEqual(m.lift.report, { delta: 0, ci95: [0, 0], n_pairs: 1, significant: false, pairs_blocked: 0 });
    const stored = detail.outcomes.find((o) => o.case === 'fx-01-v' && o.arm === 'raw');
    assert.deepEqual([stored.status, stored.failure, stored.correct], ['failed', 'blocked', false], 'the per-run file says what happened');
    assert.match(score.stdout, /\[blocked 1: left out of the score\]/);

    // the 2026-10 shape: the same raw output, stored as 'unparseable' before the rule existed
    const old = publishRound(tmp, 'as-published', { notice, as: 'unparseable' });
    const [o] = old.latest.models;
    assert.ok(!old.text.includes('blocked'), 'no blocked field appears in a release that stored none');
    assert.deepEqual([o.arms.raw.score.median, o.arms.raw.failure, o.arms.raw.by_family['find-sol']], [50, 0.25, 0], 'the notice counts as a wrong answer, as published');
    assert.deepEqual(o.lift.solidity, { delta: 100, ci95: [100, 100], n_pairs: 1, significant: true });
    assert.equal(old.detail.outcomes.find((x) => x.case === 'fx-01-v' && x.arm === 'raw').failure, 'unparseable');
    assert.doesNotMatch(old.score.stdout, /\[blocked/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- product-lift

const fxCases = loadCases([FIXTURE_CASES]);
const fxPairs = pairsOf(fxCases);
const fxById = new Map(fxCases.map((c) => [c.id, c]));

test('product-lift: the privacy check\'s refusal is privacy_block, written without a call', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-lift-privacy-'));
  try {
    const kase = fxById.get('fx-01-v');
    const job = { model: 'test/model-a', arm: 'product', kase, request: { arm: 'product', privacy_block: true, profile: 'solidity', privacy: { blocking: 1, warnings: 0, kinds: ['private_key'] } }, chars: 0, allowance: 16000, price: { in: 1, out: 2 }, messages_sha256: null, est_usd: 0, reserve_usd: 0, est_in: 0, est_out: 0 };
    let called = 0;
    const result = await liftAll({ jobs: [job], runDir: path.join(outDir, 'main'), outDir, runName: 'main', key: 'k', providers: null, maxUsd: 1, concurrency: 1, perModel: 1, scoring: protocol.scoring, call: async () => { called++; throw new Error('a privacy-blocked request must never be sent'); }, genStats: async () => null });
    assert.equal(called, 0);
    const [rec] = result.records;
    assert.deepEqual([rec.status, rec.failure, rec.correct, rec.usd, rec.refused], ['failed', 'privacy_block', false, 0, false]);
    assert.deepEqual(rec.privacy.kinds, ['private_key']);
    assert.equal(twinReason(rec), 'privacy_block');
    const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'main', 'calls', modelDir('test/model-a'), 'fx-01-v.product.json'), 'utf8'));
    assert.equal(onDisk.failure, 'privacy_block');
    assert.ok(!('blocked' in onDisk), 'the record no longer uses the provider block\'s name');
    const src = fs.readFileSync(path.join(BENCH, 'tools', 'product-lift.mjs'), 'utf8');
    assert.doesNotMatch(src, /failure: 'blocked', truncated/);
    assert.match(src, /privacy_block: true, profile: profileId/);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test('product-lift: a provider block is its own kind, apart from refused and from privacy_block', () => {
  const stop = readStream('data: {"id":"g","choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  assert.equal(stop.finish, 'stop');
  const flagged = classify({ text: NOTICE, done: { truncated: false, refused: true, blocked: 'anthropic-cyber' }, error: null }, stop);
  assert.deepEqual([flagged.failure, flagged.retryable, flagged.reason], ['blocked', false, 'anthropic-cyber'], 'the product flagged the block');
  const text = classify({ text: NOTICE, done: { truncated: false, refused: false }, error: null }, stop);
  assert.deepEqual([text.failure, text.reason], ['blocked', 'anthropic-cyber'], 'the notice as the whole answer');
  assert.equal(classify({ text: 'x', done: { truncated: false, refused: true }, error: null }, stop).failure, 'refused', 'a refusal without a block signal stays refused');
  assert.equal(classify({ text: `Review. The vendor wrote: "${NOTICE}"\n${sheet({})}`, done: { truncated: false, refused: false }, error: null }, stop).failure, null, 'an answer that quotes the notice is an answer');
});

test('product-lift: a pair with a blocked call leaves the change, both lifts and the flips', () => {
  const rec = (c, arm, extra) => ({ model: 'm', case: c, arm, variant: fxById.get(c).variant, family: fxById.get(c).family, failure: null, correct: true, tokens: { out: 100 }, usd: 0.01, ...extra });
  const block = { failure: 'blocked', correct: false };
  const records = [
    rec('fx-01-v', 'raw', block), rec('fx-01-f', 'raw'), rec('fx-02-o', 'raw', { correct: false, verdict: 'supported' }), rec('fx-02-a', 'raw'),
    rec('fx-01-v', 'product'), rec('fx-01-f', 'product'), rec('fx-02-o', 'product'), rec('fx-02-a', 'product'),
  ];
  const [m] = summarise({ records, pairs: fxPairs, models: ['m'] }).models;
  assert.deepEqual([m.blocked, m.blocked_pairs], [{ raw: 1, product: 0 }, 1]);
  assert.deepEqual([m.failed_calls.raw, m.failures.raw, m.failure_rate.raw], [0, {}, 0], 'a block is not a failed call');
  assert.equal(m.flags.failure_rate_rises, false);
  assert.deepEqual([m.lift_all.pairs, m.lift_all.delta_pairs, m.delta], [1, 1, 1], 'only fx-02 is compared: the product gained it');
  assert.deepEqual(m.answered.ids, ['fx-02']);
  assert.deepEqual(m.flips.map((f) => [f.pair, f.direction]), [['fx-02', 'gain']], 'fx-01 right with the product against a blocked raw call is not a gain');
  assert.match(renderSummary({ pairs: 2, by_family_pairs: { challenge: 1, 'find-sol': 1 }, models: [m], usd_total: 0.08 }), /provider blocked 1 raw \/ 0 product calls: 1 pair left out/);

  // without a block the summary is what it was
  const plain = summarise({ records: records.map((r) => (r.failure === 'blocked' ? { ...r, failure: 'unparseable' } : r)), pairs: fxPairs, models: ['m'] }).models[0];
  assert.deepEqual([plain.blocked, plain.blocked_pairs, plain.failed_calls.raw, plain.lift_all.pairs, plain.delta], [{ raw: 0, product: 0 }, 0, 1, 2, 2]);
  assert.deepEqual(plain.flips.map((f) => f.pair), ['fx-01', 'fx-02']);
});
