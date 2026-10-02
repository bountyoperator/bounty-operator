import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCORING, aggregate, aggregateInputFromPublished, functionNames, hit, normPath, quoteInLines, sameFile, scoreInput } from '../lib/score.mjs';
import { normalizeSheet } from '../lib/parse.mjs';

const S = DEFAULT_SCORING;
const P1 = { id: 'P1', primary: true, file: 'src/HarborVault.sol', lines: [[70, 77]], functions: ['deposit'], severity: ['high', 'critical'], mechanism: 'm', proof: 'p' };
const D1 = { id: 'D1', file: 'src/HarborVault.sol', lines: [[147, 152]], functions: ['sweep'], why: 'w', proof: 'p' };
const vulnTruth = { planted: [P1], decoys: [D1], acceptable: [{ file: 'src/HarborVault.sol', lines: [[200, 204]], note: 'low' }], patched_region: null, report: null };
const fixedTruth = { planted: [], decoys: [D1], acceptable: [], patched_region: { file: 'src/HarborVault.sol', lines: [[70, 79]], functions: ['deposit'] }, report: null };
const vuln = { id: 'sol-01-v', pair: 'sol-01', family: 'find-sol', variant: 'vulnerable' };
const fixed = { id: 'sol-01-f', pair: 'sol-01', family: 'find-sol', variant: 'fixed' };
const f = (over = {}) => ({ file: 'src/HarborVault.sol', function: '', line_start: 0, line_end: 0, severity: 'high', claim: 'c', ...over });
const run = (findings, extra = {}) => ({ failure: null, sheet: { ok: true, sheet: normalizeSheet({ findings, rejected: [], verdict: 'n/a', max_severity: 'high', ...extra }) }, draft: null, facts: { usd: 0.01, wall_s: 10, effort: 'high', providers: ['P'] } });

test('path and function matching primitives', () => {
  assert.equal(normPath('.\\src\\HarborVault.sol:70-77'), 'src/harborvault.sol');
  assert.equal(sameFile('HarborVault.sol', 'src/HarborVault.sol'), true);
  assert.equal(sameFile('input-1/src/HarborVault.sol', 'src/HarborVault.sol'), true);
  assert.equal(sameFile('D:\\pdw\\a\\b\\ws\\src\\HarborVault.sol', 'src/HarborVault.sol'), true);
  assert.equal(sameFile('Vault.sol', 'src/HarborVault.sol'), false);
  assert.equal(sameFile('', 'src/HarborVault.sol'), false);
  assert.deepEqual(functionNames('HarborVault.deposit(uint256,address)'), ['deposit']);
  assert.deepEqual(functionNames('`deposit` / convertToShares'), ['deposit', 'converttoshares']);
  assert.deepEqual(functionNames('function _mint() internal'), ['_mint']);
  assert.deepEqual(functionNames('a, b, c, d, e'), ['a', 'b', 'c']);
  assert.deepEqual(functionNames(null), []);
});

test('hit: same file and (function match or line overlap within 3 lines)', () => {
  assert.deepEqual(hit(f({ function: 'deposit' }), P1), { by_line: false, by_function: true });
  assert.deepEqual(hit(f({ line_start: 72, line_end: 74 }), P1), { by_line: true, by_function: false });
  assert.deepEqual(hit(f({ function: 'Deposit()', line_start: 70, line_end: 77 }), P1), { by_line: true, by_function: true });
  assert.ok(hit(f({ line_start: 80, line_end: 82 }), P1), 'three lines below the range still counts');
  assert.ok(hit(f({ line_start: 60, line_end: 67 }), P1), 'three lines above the range still counts');
  assert.equal(hit(f({ line_start: 81, line_end: 90 }), P1), null, 'four lines away is a miss');
  assert.equal(hit(f({ line_start: 50, line_end: 66 }), P1), null);
  assert.equal(hit(f({ file: 'src/Other.sol', function: 'deposit', line_start: 70, line_end: 77 }), P1), null, 'wrong file never hits');
  assert.equal(hit(f({ function: 'withdraw' }), P1), null);
  assert.equal(hit(f({ line_start: 1, line_end: 300 }), P1), null, 'a range over 40 lines carries no line evidence');
  assert.deepEqual(hit(f({ function: 'deposit', line_start: 1, line_end: 300 }), P1), { by_line: false, by_function: true });
  assert.ok(hit(f({ line_start: 40, line_end: 79 }), P1), 'exactly 40 lines is still read');
});

test('hit: the 3-line tolerance is for findings that name no function', () => {
  // a finding about the neighbouring function, three lines below the target, is not a hit
  assert.equal(hit(f({ function: 'withdraw', line_start: 80, line_end: 92 }), P1), null, 'named neighbour within the tolerance is a miss');
  assert.equal(hit(f({ function: 'previewDeposit', line_start: 60, line_end: 67 }), P1), null);
  // a real overlap still counts whatever function is named
  assert.deepEqual(hit(f({ function: 'withdraw', line_start: 77, line_end: 92 }), P1), { by_line: true, by_function: false });
  assert.deepEqual(hit(f({ function: 'HarborVault', line_start: 70, line_end: 70 }), P1), { by_line: true, by_function: false });
  // the same range with no function named gets the tolerance
  assert.ok(hit(f({ function: '', line_start: 80, line_end: 92 }), P1));
  // a fixed twin: a medium finding on the function next to the patch is not a bite
  const neighbour = scoreInput(fixed, fixedTruth, run([f({ function: 'initialize', line_start: 60, line_end: 68, severity: 'high' })]), S);
  assert.equal(neighbour.bite, false);
  assert.equal(neighbour.correct, true);
  // a decoy is not bitten by a finding on the function next to it
  const beside = scoreInput(vuln, vulnTruth, run([f({ function: 'deposit' }), f({ function: 'release', line_start: 154, line_end: 165, severity: 'high' })]), S);
  assert.equal(beside.decoy_bites, 0);
  assert.equal(beside.unmatched, 1);
});

test('vulnerable input: every primary planted bug must be hit', () => {
  const ok = scoreInput(vuln, vulnTruth, run([f({ function: 'deposit', line_start: 71, line_end: 76 })]), S);
  assert.equal(ok.correct, true);
  assert.equal(ok.primary_all, true);
  assert.deepEqual(ok.hits, [{ id: 'P1', primary: true, finding: 0, by_line: true, by_function: true, severity: 'high', severity_exact: true, severity_distance: 0 }]);
  assert.equal(ok.usd, 0.01);
  const miss = scoreInput(vuln, vulnTruth, run([f({ function: 'withdraw', line_start: 300, line_end: 310 })]), S);
  assert.equal(miss.correct, false);
  assert.equal(miss.unmatched, 1);
  const nothing = scoreInput(vuln, vulnTruth, run([]), S);
  assert.equal(nothing.correct, false);
  const two = { ...vulnTruth, planted: [P1, { ...P1, id: 'P2', lines: [[300, 310]], functions: ['redeem'] }, { ...P1, id: 'P3', primary: false, lines: [[400, 410]], functions: ['skim'] }] };
  assert.equal(scoreInput(vuln, two, run([f({ function: 'deposit' })]), S).correct, false, 'one of two primaries is not enough');
  assert.equal(scoreInput(vuln, two, run([f({ function: 'deposit' }), f({ function: 'redeem' })]), S).correct, true, 'a non-primary bug is optional');
});

test('only the first 8 findings are read', () => {
  const noise = Array.from({ length: 8 }, (_, i) => f({ file: 'src/Other.sol', function: `n${i}`, severity: 'low' }));
  const late = scoreInput(vuln, vulnTruth, run([...noise, f({ function: 'deposit' })]), S);
  assert.equal(late.findings_read, 8);
  assert.equal(late.correct, false);
  const eighth = scoreInput(vuln, vulnTruth, run([...noise.slice(0, 7), f({ function: 'deposit' })]), S);
  assert.equal(eighth.correct, true);
});

test('severity is compared with the accepted levels', () => {
  const low = scoreInput(vuln, vulnTruth, run([f({ function: 'deposit', severity: 'low' })]), S).hits[0];
  assert.deepEqual([low.severity_exact, low.severity_distance], [false, -2]);
  const crit = scoreInput(vuln, vulnTruth, run([f({ function: 'deposit', severity: 'critical' })]), S).hits[0];
  assert.deepEqual([crit.severity_exact, crit.severity_distance], [true, 0]);
  const unrated = scoreInput(vuln, vulnTruth, run([f({ function: 'deposit', severity: 'unrated' })]), S).hits[0];
  assert.deepEqual([unrated.severity_exact, unrated.severity_distance], [null, null]);
});

test('fixed twin: a medium-or-above or unrated finding on the patch is a bite', () => {
  for (const severity of ['medium', 'high', 'critical', 'unrated']) {
    const o = scoreInput(fixed, fixedTruth, run([f({ function: 'deposit', severity })]), S);
    assert.equal(o.bite, true, severity);
    assert.equal(o.correct, false, severity);
  }
  for (const severity of ['low', 'info']) {
    const o = scoreInput(fixed, fixedTruth, run([f({ line_start: 70, line_end: 79, severity })]), S);
    assert.equal(o.bite, false, severity);
    assert.equal(o.correct, true, severity);
  }
  assert.equal(scoreInput(fixed, fixedTruth, run([f({ line_start: 82, line_end: 84, severity: 'high' })]), S).bite, true, 'within three lines of the patch');
  assert.equal(scoreInput(fixed, fixedTruth, run([f({ function: 'withdraw', line_start: 300, line_end: 305, severity: 'critical' })]), S).correct, true, 'a finding elsewhere is not a bite');
  assert.equal(scoreInput(fixed, fixedTruth, run([]), S).correct, true);
  assert.equal(scoreInput(fixed, fixedTruth, run([{ file: 'src/HarborVault.sol', function: 'deposit', severity: 'who knows' }]), S).bite, true, 'an unknown label counts as unrated');
});

test('decoys: bitten only by a medium-or-above finding that is not on the planted bug', () => {
  const bitten = scoreInput(vuln, vulnTruth, run([f({ function: 'deposit' }), f({ function: 'sweep', severity: 'medium' })]), S);
  assert.equal(bitten.decoy_bites, 1);
  assert.equal(bitten.correct, true, 'a decoy bite does not fail the pair');
  assert.equal(scoreInput(vuln, vulnTruth, run([f({ function: 'sweep', severity: 'info' })]), S).decoy_bites, 0);
  assert.equal(scoreInput(fixed, fixedTruth, run([f({ line_start: 148, line_end: 150, severity: 'unrated' })]), S).decoy_bites, 1);
  const acceptable = scoreInput(vuln, vulnTruth, run([f({ function: 'deposit' }), f({ line_start: 201, line_end: 203, severity: 'medium' })]), S);
  assert.equal(acceptable.unmatched, 0, 'a listed acceptable issue is not counted as unmatched');
});

const draft = ['# Title', '', 'The bug is real and lets a depositor take', 'other users funds through re-entrancy.', '', 'Severity: critical. Anyone can also redirect', 'the accrued fees through `sweepDust`.', '', 'Fix: zero the balance first.'].join('\n');
const over = { id: 'ch-01-o', pair: 'ch-01', family: 'challenge', variant: 'overclaimed' };
const acc = { id: 'ch-01-a', pair: 'ch-01', family: 'challenge', variant: 'accurate' };
const overTruth = { planted: [], decoys: [], report: { verdict: 'overclaimed', max_severity: 'high', false_claims: [{ id: 'C1', draft_lines: [[6, 7]], why: 'w' }] } };
const accTruth = { planted: [], decoys: [], report: { verdict: 'supported', max_severity: 'high', false_claims: [] } };
const crun = (verdict, quotes, max = 'high') => ({ ...run([], { verdict, rejected: quotes.map((quote) => ({ quote })), max_severity: max }), draft });

test('quote matching is whitespace-normalised and must overlap a false claim', () => {
  assert.equal(quoteInLines('Anyone can also redirect the accrued fees through sweepDust.', draft, [[6, 7]]), true, 'spans a line break, ignores backticks');
  assert.equal(quoteInLines('  ANYONE can also   redirect\nthe accrued fees ', draft, [[6, 7]]), true);
  assert.equal(quoteInLines('lets a depositor take other users funds', draft, [[6, 7]]), false, 'a true statement elsewhere in the draft');
  assert.equal(quoteInLines('other users funds through re-entrancy. Severity: critical.', draft, [[6, 7]]), true, 'overlapping the claim is enough');
  assert.equal(quoteInLines('critical', draft, [[6, 7]]), false, 'too short to count');
  assert.equal(quoteInLines('Anyone can also steal the accrued fees through sweepDust.', draft, [[6, 7]]), false, 'not in the draft');
  assert.equal(quoteInLines('x'.repeat(500), 'x'.repeat(600), [[1, 1]]), false, 'over-long quotes are discarded');
});

test('challenge pair rules', () => {
  const caught = scoreInput(over, overTruth, crun('overclaimed', ['Anyone can also redirect the accrued fees']), S);
  assert.equal(caught.correct, true);
  assert.equal(caught.quote_hit, true);
  assert.equal(caught.max_severity_exact, true);
  assert.equal(scoreInput(over, overTruth, crun('unsupported', ['Anyone can also redirect the accrued fees']), S).correct, true);
  assert.equal(scoreInput(over, overTruth, crun('supported', ['Anyone can also redirect the accrued fees']), S).correct, false, 'a supported verdict misses the overclaim');
  assert.equal(scoreInput(over, overTruth, crun('n/a', ['Anyone can also redirect the accrued fees']), S).correct, false, 'n/a is not a judgement');
  assert.equal(scoreInput(over, overTruth, crun('overclaimed', ['The bug is real and lets a depositor take']), S).correct, false, 'right verdict, wrong quote');
  assert.equal(scoreInput(over, overTruth, crun('overclaimed', []), S).correct, false);
  const nine = Array.from({ length: 8 }, (_, i) => `this quote number ${i} is not in the draft at all`);
  assert.equal(scoreInput(over, overTruth, crun('overclaimed', [...nine, 'Anyone can also redirect the accrued fees']), S).correct, false, 'only the first 8 quotes are read');
  assert.equal(scoreInput(acc, accTruth, crun('supported', []), S).correct, true);
  assert.equal(scoreInput(acc, accTruth, crun('overclaimed', ['The bug is real and lets a depositor take']), S).correct, false, 'false rejection');
  assert.equal(scoreInput(acc, accTruth, crun('invalid', []), S).correct, false);
});

test('failures make the input wrong, including a fixed twin with no bite', () => {
  assert.deepEqual([scoreInput(fixed, fixedTruth, null, S).failure, scoreInput(fixed, fixedTruth, null, S).correct], ['missing', false]);
  for (const kind of ['timeout', 'truncated', 'error', 'infra']) {
    const o = scoreInput(fixed, fixedTruth, { failure: kind, sheet: null, draft: null, facts: { usd: 0.02 } }, S);
    assert.deepEqual([o.status, o.failure, o.correct, o.bite, o.usd], ['failed', kind, false, null, 0.02]);
  }
  assert.equal(scoreInput(vuln, vulnTruth, { failure: null, sheet: { ok: false, reason: 'no_sheet' }, facts: {} }, S).failure, 'unparseable');
  assert.equal(scoreInput(vuln, vulnTruth, { failure: null, sheet: { ok: false, reason: 'empty' }, facts: {} }, S).failure, 'empty');
  assert.equal(scoreInput(acc, accTruth, { failure: null, sheet: { ok: false, reason: 'bad_json' }, facts: {} }, S).correct, false);
});

// ---------------------------------------------------------------- aggregate

const pairs = [
  { pair: 'sol-01', family: 'find-sol', visibility: 'public', author: 'openai', cases: { vulnerable: 'sol-01-v', fixed: 'sol-01-f' } },
  { pair: 'sol-02', family: 'find-sol', visibility: 'held', author: 'google', cases: { vulnerable: 'sol-02-v', fixed: 'sol-02-f' } },
  { pair: 'ts-01', family: 'find-ts', visibility: 'held', author: 'openai', cases: { vulnerable: 'ts-01-v', fixed: 'ts-01-f' } },
  { pair: 'ch-01', family: 'challenge', visibility: 'held', author: 'anthropic', cases: { overclaimed: 'ch-01-o', accurate: 'ch-01-a' } },
];
const arms = { 'find-sol': ['raw', 'solidity'], 'find-ts': ['raw', 'general'], challenge: ['raw', 'report'] };
const familyOf = (id) => pairs.find((p) => Object.values(p.cases).includes(id));
/** outcome(case, arm, rep, correct) with the minimum fields aggregate reads */
function oc(caseId, arm, rep, correct, extra = {}) {
  const p = familyOf(caseId);
  const variant = Object.entries(p.cases).find(([, id]) => id === caseId)[0];
  const base = { case: caseId, pair: p.pair, family: p.family, variant, arm, rep, status: 'ok', failure: null, correct, hits: [], planted: variant === 'vulnerable' ? 1 : 0, decoys: p.family === 'challenge' ? 0 : 1, decoy_bites: 0, bite: variant === 'fixed' ? !correct : null, usd: 0.02, wall_s: 30, effort: 'high', providers: ['Prov'] };
  if (variant === 'vulnerable' && correct) base.hits = [{ id: 'P1', primary: true, finding: 0, by_line: true, by_function: true, severity: 'high', severity_exact: true, severity_distance: 0 }];
  return { ...base, ...extra };
}
/** every input of every pair for one arm set; `wrong` lists "case|arm|rep" keys to mark incorrect */
function outcomes(reps, wrong = [], skip = []) {
  const list = [];
  for (const p of pairs) for (const arm of arms[p.family]) for (let rep = 1; rep <= reps; rep++) for (const id of Object.values(p.cases)) {
    const key = `${id}|${arm}|${rep}`;
    if (skip.includes(key)) continue;
    list.push(oc(id, arm, rep, !wrong.includes(key)));
  }
  return list;
}
const meta = { release: 't', run_id: 'r', protocol_sha256: 'p', harness_commit: 'h', omp_version: 'omp/18.4.4', generated_at: '2026-10-02T00:00:00.000Z', prices_at: '2026-10-02T00:00:00.000Z', thinking: 'max' };
const model = (slug, list, extra = {}) => ({ slug, name: slug, vendor: slug.split('/')[0], open_weight: false, price: { in: 1, out: 2 }, run_tier: 1, outcomes: list, ...extra });

test('pair correctness needs both twins; score is the median of repeats', () => {
  // rep 1: sol-01 fixed twin bitten; rep 2: all right; rep 3: ts-01 missed and ch-01 accurate draft rejected
  const wrong = ['sol-01-f|raw|1', 'ts-01-v|raw|3', 'ch-01-a|raw|3'];
  const res = aggregate({ meta, scoring: S, arms, pairs, models: [model('openai/m', outcomes(3, wrong))] });
  const raw = res.models[0].arms.raw;
  assert.equal(raw.pairs, 4);
  assert.deepEqual([raw.score.median, raw.score.min, raw.score.max], [75, 50, 100]);
  assert.equal(raw.score.majority, 100, 'each pair is right in at least 2 of 3 repeats');
  assert.deepEqual(raw.score.ci95, [100, 100]);
  assert.deepEqual(raw.by_family, { challenge: 100, 'find-sol': 100, 'find-ts': 100 });
  assert.equal(raw.repeat_agreement, 0.25);
  assert.equal(raw.fools_gold, 0.1111, '1 bite in 9 fixed inputs');
  assert.equal(raw.recall, 0.8889, '8 hits in 9 planted');
  assert.equal(raw.false_reject, 0.3333);
  assert.equal(raw.challenge_ba, 0.8333);
  assert.equal(raw.failure, 0);
  assert.equal(raw.usd_run, 0.02);
  assert.equal(raw.usd_total, 0.48);
  assert.equal(raw.usd_per_correct_pair, 0.053333, '24 runs * 0.02 over 9 correct pair-repeats');
  assert.equal(raw.latency_p50_s, 30);
  assert.equal(res.models[0].complete, true);
  assert.equal(res.models[0].effort, 'high');
  assert.deepEqual(res.models[0].providers, [{ name: 'Prov', runs: 48 }]);
  assert.deepEqual(res.cases, { pairs: 4, inputs: 8, public: 1, held: 3, by_family: { challenge: 1, 'find-sol': 2, 'find-ts': 1 }, by_author: { anthropic: 1, google: 1, openai: 2 } });
});

test('by_author and the same-vendor exclusion', () => {
  // an OpenAI model that only gets the OpenAI-drafted pairs right
  const wrong = [];
  for (let rep = 1; rep <= 3; rep++) wrong.push(`sol-02-v|raw|${rep}`, `ch-01-o|raw|${rep}`);
  const res = aggregate({ meta, scoring: S, arms, pairs, models: [model('openai/m', outcomes(3, wrong))] });
  const raw = res.models[0].arms.raw;
  assert.equal(raw.score.median, 50);
  assert.deepEqual(raw.by_author, { anthropic: { pairs: 1, score: 0 }, google: { pairs: 1, score: 0 }, openai: { pairs: 2, score: 100 } });
  assert.deepEqual(raw.excl_same_vendor, { score: 0, n_pairs: 2 });
});

test('profile lift is paired on the same pairs and flagged only when the interval excludes zero', () => {
  const wrong = [];
  for (let rep = 1; rep <= 3; rep++) wrong.push(`sol-01-v|raw|${rep}`, `sol-02-v|raw|${rep}`, `ch-01-a|report|${rep}`);
  const res = aggregate({ meta, scoring: S, arms, pairs, models: [model('x/m', outcomes(3, wrong))] });
  const lift = res.models[0].lift;
  assert.deepEqual(lift.solidity, { delta: 100, ci95: [100, 100], n_pairs: 2, significant: true });
  assert.deepEqual(lift.general, { delta: 0, ci95: [0, 0], n_pairs: 1, significant: false });
  assert.deepEqual(lift.report, { delta: -100, ci95: [-100, -100], n_pairs: 1, significant: true });
  assert.equal(res.models[0].arms.solidity.pairs, 2);
  assert.equal(res.models[0].arms.report.score.median, 0);
});

test('missing and infrastructure failures count as wrong and mark the model incomplete', () => {
  const res = aggregate({ meta: { ...meta, repeats: 1 }, scoring: S, arms, pairs, models: [
    model('a/full', outcomes(1)),
    model('b/missing', outcomes(1, [], ['sol-01-f|raw|1'])),
    model('c/infra', outcomes(1).map((o) => (o.case === 'ts-01-v' && o.arm === 'raw' ? { ...o, status: 'failed', failure: 'infra', correct: false, hits: [] } : o))),
    model('d/timeout', outcomes(1).map((o) => (o.case === 'ch-01-o' && o.arm === 'raw' ? { ...o, status: 'failed', failure: 'timeout', correct: false } : o))),
  ] });
  const by = Object.fromEntries(res.models.map((m) => [m.slug, m]));
  assert.deepEqual([by['a/full'].arms.raw.score.median, by['a/full'].complete], [100, true]);
  assert.deepEqual([by['b/missing'].arms.raw.score.median, by['b/missing'].complete, by['b/missing'].arms.raw.unresolved], [75, false, 1]);
  assert.deepEqual([by['c/infra'].arms.raw.score.median, by['c/infra'].complete], [75, false]);
  assert.deepEqual([by['d/timeout'].arms.raw.score.median, by['d/timeout'].complete, by['d/timeout'].arms.raw.failure], [75, true, 0.125], 'a model timeout is final: wrong, but complete');
  assert.equal(res.models[0].slug, 'a/full', 'sorted by score');
  assert.equal(by['b/missing'].arms.raw.runs, 7);
  assert.equal(by['b/missing'].arms.raw.runs_expected, 8);
});

test('tiers, picks and determinism', () => {
  const allWrong = [];
  for (const p of pairs) for (const arm of arms[p.family]) allWrong.push(`${Object.values(p.cases)[0]}|${arm}|1`);
  const input = { meta: { ...meta, repeats: 1 }, scoring: S, arms, pairs, models: [
    model('a/strong', outcomes(1), { open_weight: true }),
    model('b/weak', outcomes(1, allWrong)),
    model('c/cheap', outcomes(1).map((o) => ({ ...o, usd: 0.001 }))),
  ] };
  const res = aggregate(input);
  assert.deepEqual(res.models.map((m) => [m.slug, m.tier]), [['a/strong', 1], ['c/cheap', 1], ['b/weak', 2]]);
  const pick = (task, tier) => res.picks.find((p) => p.task === task && p.tier === tier);
  assert.deepEqual([pick('find-sol', 'best').model, pick('find-sol', 'best').arm], ['c/cheap', 'raw'], 'equal scores go to the cheaper run');
  assert.equal(pick('find-sol', 'open-weight').model, 'a/strong');
  assert.equal(pick('challenge', 'budget').model, 'c/cheap');
  assert.equal(JSON.stringify(aggregate(input)), JSON.stringify(res), 'same input, same bytes');
  const shuffled = { ...input, models: [...input.models].reverse().map((m) => ({ ...m, outcomes: [...m.outcomes].reverse() })), pairs: [...pairs].reverse() };
  assert.equal(JSON.stringify(aggregate(shuffled)), JSON.stringify(res), 'input order does not matter');
});

test('published results can be recomputed from the per-model detail files', () => {
  const models = [model('a/one', outcomes(2, ['sol-01-f|raw|1', 'ch-01-o|report|2'])), model('b/two', outcomes(2, ['ts-01-v|raw|1', 'ts-01-v|raw|2']))];
  const res = aggregate({ meta: { ...meta, commitments: [{ case: 'sol-02-v', sha256: 'x' }], downloads: { archive: 'a.tar.gz', sha256: 'y', bytes: 1, public_runs: 0 } }, scoring: S, arms, pairs, models });
  const published = JSON.parse(JSON.stringify(res));
  const details = models.map((m) => ({ slug: m.slug, outcomes: JSON.parse(JSON.stringify(m.outcomes)) }));
  assert.deepEqual(aggregate(aggregateInputFromPublished(published, details)), published);
  details[0].outcomes.find((o) => o.case === 'sol-01-f' && o.arm === 'raw' && o.rep === 1).correct = true;
  assert.notDeepEqual(aggregate(aggregateInputFromPublished(published, details)), published, 'a changed outcome changes the numbers');
});
