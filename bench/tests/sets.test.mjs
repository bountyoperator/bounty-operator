// The three sets (scored, public, reserve): the selection rule, the checks on protocol.json,
// which arms a model runs, the run order of the budget plan, the commitments of held cases,
// and publishing a held leaderboard next to a public practice set. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCases, pairsOf } from '../lib/cases.mjs';
import { budgetPlan } from '../lib/budget.mjs';
import { RUN_SCHEMA, modelDir, protocolHash, resumeKey, runName } from '../lib/runs.mjs';
import { protocolHashes, stampHashes } from '../lib/protocol.mjs';
import { unpackTarGz } from '../lib/tar.mjs';
import { renderMethodBlock, selectSets } from '../tools/select.mjs';
import { answerFor, workspaceDigest } from '../tools/offline-smoke.mjs';
import { buildPlan, lintSets, loadProtocol, pairFilter, runsArm } from '../bench.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(BENCH, 'tests', 'fixtures');
const FIXTURE_CASES = path.join(FIXTURES, 'cases');
const HELD_CASES = path.join(BENCH, 'private', 'cases');
const { protocol } = loadProtocol();
const F = '```';
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(BENCH, 'bench.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const sandbox = (fn) => { const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-sets-')); try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); } };
const editJson = (file, fn) => { const j = JSON.parse(fs.readFileSync(file, 'utf8')); fn(j); fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`); };

// ---------------------------------------------------------------- the selection rule

const P = (pair, family) => ({ pair, family, author: 'x' });
const R = (pair, right, first, second, probes = 8) => ({ pair, probes, right, first_right: first, second_right: second, void: 0 });
const config = {
  scored_pairs: 6, always_scored: ['h-1'], family_targets: { challenge: 2, 'find-sol': 4 }, minimum: { challenge: 2 },
  public_per_family: { challenge: 1, 'find-sol': 1 }, class_cap: 2,
  prior_order: { challenge: ['c-3', 'c-2', 'c-1'], 'find-sol': ['s-5', 's-4', 's-3', 's-2', 's-1'] },
};
const pairs = [P('h-1', 'find-sol'), P('s-1', 'find-sol'), P('s-2', 'find-sol'), P('s-3', 'find-sol'), P('s-4', 'find-sol'), P('s-5', 'find-sol'), P('c-1', 'challenge'), P('c-2', 'challenge'), P('c-3', 'challenge')];

test('selection: hard pairs always, then the pairs the probes found hardest, the easiest go public', () => {
  const rows = [R('h-1', 8, 8, 8), R('s-1', 8, 8, 8), R('s-2', 6, 8, 6), R('s-3', 2, 4, 4), R('s-4', 0, 2, 3), R('s-5', 0, 0, 3), R('c-1', 8, 8, 8), R('c-2', 4, 6, 6), R('c-3', 4, 4, 8)];
  const res = selectSets({ pairs, rows, config, classes: {} });
  assert.deepEqual(res.problems, []);
  assert.deepEqual(res.order['find-sol'], ['s-5', 's-4', 's-3', 's-2', 's-1'], 'fewest probes right first; equal pair rates fall back to the twin rate');
  assert.deepEqual(res.order.challenge, ['c-3', 'c-2', 'c-1'], 'equal pair and twin rates fall back to the prior order');
  assert.deepEqual(res.scored, ['c-2', 'c-3', 'h-1', 's-3', 's-4', 's-5'], 'h-1 is scored although every probe got it right');
  assert.deepEqual(res.public, ['c-1', 's-1']);
  assert.deepEqual(res.reserve, ['s-2']);
});

test('selection: a pair with no probe is ordered as hardest, and the prior order decides among equals', () => {
  const res = selectSets({ pairs, rows: [R('s-1', 0, 0, 0, 0), R('s-2', 0, 0, 0, 0)], config, classes: {} });
  assert.deepEqual(res.order['find-sol'], ['s-5', 's-4', 's-3', 's-2', 's-1']);
  assert.deepEqual(res.scored, ['c-2', 'c-3', 'h-1', 's-3', 's-4', 's-5']);
});

test('selection: a bug class is scored at most class_cap times', () => {
  const classes = { 'h-1': 'rounding', 's-5': 'rounding', 's-4': 'rounding', 's-3': 'oracle', 's-2': 'reentrancy', 's-1': 'access' };
  const res = selectSets({ pairs, rows: [], config, classes });
  assert.deepEqual(res.skipped, [{ pair: 's-4', class: 'rounding' }]);
  assert.deepEqual(res.scored, ['c-2', 'c-3', 'h-1', 's-2', 's-3', 's-5']);
  assert.deepEqual([res.reserve, res.public], [['s-4'], ['c-1', 's-1']], 'the skipped pair is not lost: it is the hardest of the rest, so it goes to the reserve');
});

test('selection: an impossible target is reported, not papered over', () => {
  const res = selectSets({ pairs: pairs.filter((p) => p.family !== 'challenge'), rows: [], config, classes: {} });
  assert.ok(res.problems.some((p) => /challenge: only 0 pairs can be scored/.test(p)));
  assert.ok(res.problems.some((p) => /minimum is 2/.test(p)));
  assert.ok(selectSets({ pairs, rows: [], config: { ...config, always_scored: ['h-9'] }, classes: {} }).problems.some((p) => /h-9/.test(p)));
});

test('selection: the METHOD.md table says how much of the probe is in', () => {
  const sets = { scored: ['c-2', 'c-3', 'h-1', 's-3', 's-4', 's-5'], public: ['c-1', 's-1'], reserve: ['s-2'] };
  const probe = { models: ['a/b', 'c/d'], repeats: 2, probes_expected: 36, probes_complete: 8, calls_expected: 72, calls_answered: 16, probes_void: 0, unprobed: ['h-1'], status: 'provisional' };
  const md = renderMethodBlock({ pairs, rows: [R('s-5', 1, 2, 3, 4)], sets, config, probe, classCounts: { rounding: 2 } });
  assert.match(md, /\*\*Status: provisional\.\*\* 8 of 36 probes are in/);
  assert.match(md, /\| s-5 \| find-sol \| x \| scored \| 0\.25 \(1\/4\) \| 2\/4 \| 3\/4 \|/);
  assert.match(md, /\| h-1 \| find-sol \| x \| scored \| not probed \| - \| - \|/);
  assert.match(md, /\| scored \| 6 \| 4 \| 0 \| 2 \|/);
  assert.match(md, /rounding 2\. No class appears more than 2 times/);
  assert.match(renderMethodBlock({ pairs, rows: [], sets, config, probe: { ...probe, status: 'final', probes_complete: 32, probes_void: 1 }, classCounts: null }), /\*\*Status: final\.\*\*.*Not probed: h-1/);
});

// ---------------------------------------------------------------- protocol.json

test('protocol.json: one repeat, four profile-arm models, and sets that match the rule\'s numbers', () => {
  assert.equal(protocol.run.repeats, 1);
  const ranked = Object.values(protocol.tiers).flat();
  assert.deepEqual(protocol.run.profile_arm_models, ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'openai/gpt-6-luna', 'anthropic/claude-sonnet-5.5']);
  for (const m of protocol.run.profile_arm_models) assert.ok(ranked.includes(m), m);
  const s = protocol.selection;
  assert.equal(Object.values(s.family_targets).reduce((a, b) => a + b, 0), s.scored_pairs);
  assert.equal(protocol.sets.scored.length, s.scored_pairs);
  assert.ok(protocol.sets.public.length >= 6, 'at least six public practice pairs');
  for (const id of s.always_scored) assert.ok(protocol.sets.scored.includes(id), id);
  const all = [...protocol.sets.scored, ...protocol.sets.public, ...protocol.sets.reserve];
  assert.equal(new Set(all).size, all.length, 'no pair in two sets');
  for (const m of s.probe.models) assert.ok(!ranked.includes(m), `${m} must not be ranked`);
});

test('the public set on disk contains exactly the published pairs, all marked public', () => {
  const cases = loadCases([path.join(BENCH, 'cases')]);
  assert.deepEqual(pairsOf(cases).map((p) => p.pair).sort(), [...protocol.sets.public].sort());
  for (const c of cases) assert.equal(c.case?.visibility, 'public', `${c.id} must be public`);
});

test('the full sets on disk: every pair in exactly one set, public pairs in bench/cases, family minimums kept', {
  skip: !fs.existsSync(HELD_CASES) && 'Held dataset is absent from this public checkout; the public set is checked separately',
}, () => {
  const cases = loadCases([path.join(BENCH, 'cases'), HELD_CASES]);
  const expected = [...protocol.sets.scored, ...protocol.sets.public, ...protocol.sets.reserve].sort();
  assert.deepEqual(pairsOf(cases).map((p) => p.pair).sort(), expected);
  assert.deepEqual(lintSets(protocol, pairsOf(cases)), []);
  for (const c of cases) assert.equal(/[\\/]private[\\/]/.test(c.dir), !protocol.sets.public.includes(c.pair), `${c.id} is in the wrong folder`);
});

test('lintSets reports a pair in no set, in two sets, in the wrong visibility, and a missed minimum', () => {
  const pair = (id, family, visibility) => ({ pair: id, family, visibility });
  const proto = { sets: { scored: ['a', 'b'], public: ['c', 'b'], reserve: [] }, selection: { scored_pairs: 2, minimum: { challenge: 1 } } };
  const issues = lintSets(proto, [pair('a', 'find-sol', 'public'), pair('b', 'find-sol', 'held'), pair('c', 'find-sol', 'held'), pair('d', 'find-sol', 'held')]).map((i) => `${i.scope}: ${i.message}`).join('\n');
  assert.match(issues, /b: listed in two sets/);
  assert.match(issues, /d: the pair is in none of the sets/);
  assert.match(issues, /a: marked public but listed in the scored set/);
  assert.match(issues, /c: listed in the public set but its cases are not marked public/);
  assert.match(issues, /protocol: the scored set has 0 challenge pairs; the minimum is 1/);
  assert.deepEqual(lintSets({}, [pair('a', 'find-sol', 'held')]), [], 'a protocol without sets has nothing to check');
});

test('--set picks the pairs; another case root is another collection', () => {
  const proto = { sets: { scored: ['a'], public: ['b'], reserve: ['c'] } };
  assert.deepEqual([...pairFilter(proto, {}, 'scored')], ['a']);
  assert.deepEqual([...pairFilter(proto, { set: 'public,reserve' }, 'scored')], ['b', 'c']);
  assert.equal(pairFilter(proto, { set: 'all' }, 'scored'), null);
  assert.equal(pairFilter(proto, { 'cases-root': 'x' }, 'scored'), null, 'the sets do not apply to another root');
  assert.deepEqual([...pairFilter(proto, { 'cases-root': 'x', set: 'scored' }, 'all')], ['a'], 'unless --set says so');
  assert.equal(pairFilter({}, {}, 'scored'), null);
  assert.throws(() => pairFilter(proto, { set: 'held' }, 'scored'), /Unknown set "held"/);
});

test('profile arms are planned only for the models protocol.json lists', async () => {
  assert.equal(runsArm(protocol, 'openai/gpt-oss-120b', 'raw'), true);
  assert.equal(runsArm(protocol, 'openai/gpt-oss-120b', 'solidity'), false);
  assert.equal(runsArm(protocol, 'z-ai/glm-5.3-flash', 'report'), true);
  assert.equal(runsArm({ scoring: { headline_arm: 'raw' }, run: {} }, 'any/model', 'solidity'), true, 'no list: every model runs every arm');
  const flags = { 'cases-root': FIXTURE_CASES, models: 'z-ai/glm-5.3-flash,openai/gpt-oss-120b' };
  const plan = await buildPlan(protocol, flags, { offline: true });
  const count = (model, arm) => plan.tasks.filter((t) => t.model === model && (arm === 'raw') === (t.arm === 'raw')).length;
  assert.equal(plan.repeats, 1);
  assert.deepEqual([count('z-ai/glm-5.3-flash', 'raw'), count('z-ai/glm-5.3-flash', 'profile'), count('openai/gpt-oss-120b', 'raw'), count('openai/gpt-oss-120b', 'profile')], [4, 4, 4, 0]);
  assert.equal((await buildPlan(protocol, { ...flags, 'all-arms': true }, { offline: true })).tasks.length, 16);
  assert.equal((await buildPlan(protocol, { ...flags, arms: 'raw' }, { offline: true })).tasks.length, 8);
});

// ---------------------------------------------------------------- budget plan order

test('budget plan in run order: tier first, cheapest inside a tier, profile arms straight after their model', () => {
  const kase = (id, family, variant) => ({ id, family, variant, workspace: [{ path: 'a', bytes: Buffer.alloc(10_000) }] });
  const prof = { with_bug: { input: 1000, cached: 0, output: 1000 }, clean: { input: 1000, cached: 0, output: 1000 }, any: { input: 1000, cached: 0, output: 1000 } };
  const estimate = { workspace_bytes: 10_000, profiles: { mean: prof } };
  const cases = [kase('a-v', 'find-sol', 'vulnerable'), kase('a-f', 'find-sol', 'fixed')];
  const models = [
    { slug: 't2/cheap', run_tier: 2, price: { in: 1, out: 1 } },       // 2 runs x 2000 tokens x $1/M = 0.004
    { slug: 't1/dear', run_tier: 1, price: { in: 100, out: 100 } },    // 0.4
    { slug: 't1/cheap', run_tier: 1, price: { in: 10, out: 10 } },     // 0.04
    { slug: 't3/top', run_tier: 3, price: { in: 1000, out: 1000 } },   // 4
    { slug: 't1/unlisted', run_tier: 1, price: { in: null, out: null } },
  ];
  const byCost = budgetPlan({ cases, models, estimate, budget: 100 });
  assert.deepEqual(byCost.rows.map((r) => r.slug), ['t2/cheap', 't1/cheap', 't1/dear', 't3/top', 't1/unlisted']);
  const plan = budgetPlan({ cases, models, estimate, budget: 0.5, order: 'tier', profile: { models: ['t1/cheap', 't3/top'], cases } });
  assert.deepEqual(plan.rows.map((r) => `${r.slug}:${r.arm}`), ['t1/cheap:headline', 't1/cheap:profile', 't1/dear:headline', 't2/cheap:headline', 't3/top:headline', 't3/top:profile', 't1/unlisted:headline']);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(plan.rows[1].usd, 0.04); near(plan.rows[1].running, 0.08); near(plan.rows[3].running, 0.484);
  assert.equal(plan.line, 4, 'the budget runs out at the tier-3 model');
  assert.deepEqual(plan.rows.map((r) => r.fits), [true, true, true, true, false, false, false]);
  assert.equal(plan.rows[0].runs, 2);
  // a budget that stops inside tier 1 does not let a cheaper tier-2 model jump the queue
  assert.equal(budgetPlan({ cases, models, estimate, budget: 0.1, order: 'tier' }).fit, 1);
});

// ---------------------------------------------------------------- commitments

test('commit writes one salted hash per held case; lint fails when a held case changes afterwards', () => sandbox((tmp) => {
  fs.cpSync(FIXTURES, tmp, { recursive: true, filter: (src) => !/[\\/](out|cache)([\\/]|$)/.test(src) });
  const root = path.join(tmp, 'cases'), salts = path.join(tmp, 'salts.json'), file = path.join(tmp, 'commitments.json');
  for (const id of ['fx-02-o', 'fx-02-a']) editJson(path.join(root, id, 'case.json'), (j) => { j.visibility = 'held'; });
  const args = ['--cases-root', root, '--salts', salts, '--commitments', file];
  const first = cli(['commit', ...args, '--date', '2026-10-03']);
  assert.equal(first.status, 0, first.stderr);
  const one = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(one.schema, 'paydirt.commitments/1');
  assert.deepEqual(one.commitments.map((c) => [c.case, c.committed]), [['fx-02-a', '2026-10-03'], ['fx-02-o', '2026-10-03']], 'held cases only');
  assert.ok(one.commitments.every((c) => /^[0-9a-f]{64}$/.test(c.sha256)));
  assert.ok(!fs.readFileSync(file, 'utf8').includes(JSON.parse(fs.readFileSync(salts, 'utf8'))['fx-02-o']), 'the salt is not in the published file');
  const lint = (extra = []) => cli(['lint', '--bench-dir', tmp, '--no-engine', ...args, ...extra]);
  assert.equal(lint().status, 0, lint().stdout);

  fs.appendFileSync(path.join(root, 'fx-02-o', 'truth.md'), '\nA correction.\n');
  const stale = lint();
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /fx-02-o\s+commitment\s+the case changed after its commitment was written/);
  assert.equal(cli(['commit', ...args, '--date', '2026-10-04']).status, 0);
  const two = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(two.commitments.find((c) => c.case === 'fx-02-a').sha256, one.commitments[0].sha256, 'an unchanged case keeps its commitment and its date');
  assert.deepEqual([two.commitments.find((c) => c.case === 'fx-02-o').committed, two.superseded.length, two.superseded[0].sha256, two.superseded[0].replaced], ['2026-10-04', 1, one.commitments[1].sha256, '2026-10-04'], 'the replaced value stays in the file');
  assert.equal(lint().status, 0);

  // a held case that becomes public leaves the list and is recorded
  for (const id of ['fx-02-o', 'fx-02-a']) editJson(path.join(root, id, 'case.json'), (j) => { j.visibility = 'public'; });
  assert.equal(cli(['commit', ...args, '--date', '2026-10-05']).status, 0);
  const three = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([three.commitments.length, three.superseded.length, three.superseded.at(-1).note], [0, 3, 'no longer a held case']);
}));

// ---------------------------------------------------------------- a held leaderboard and a public practice set

test('publish: scored pairs are held, practice pairs are public with their raw output, both verify', () => sandbox((tmp) => {
  const root = path.join(tmp, 'cases'), runs = path.join(tmp, 'runs'), outDir = path.join(tmp, 'web'), protoFile = path.join(tmp, 'protocol.json');
  fs.cpSync(FIXTURE_CASES, root, { recursive: true });
  for (const id of ['fx-02-o', 'fx-02-a']) editJson(path.join(root, id, 'case.json'), (j) => { j.visibility = 'held'; });
  // another split is another core: the hashes block is written again with it, as `select --apply` does
  const proto = stampHashes({ ...structuredClone(protocol), sets: { scored: ['fx-02'], public: ['fx-01'], reserve: [] } });
  fs.writeFileSync(protoFile, JSON.stringify(proto));
  const hashes = protocolHashes(proto), sha = protocolHash(proto);
  assert.notEqual(hashes.core, protocolHashes(protocol).core, 'the sets are part of the core');
  const cases = loadCases([root]);
  // one model, right on everything, raw arm, one repeat
  let n = 0;
  for (const kase of cases) {
    const dir = path.join(runs, 't', 'raw', modelDir('acme/alpha'), runName(kase.id, 'raw', 1));
    fs.mkdirSync(dir, { recursive: true });
    const answer = answerFor('key', kase);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model: 'acme/alpha', content: [{ type: 'text', text: answer }], usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: 'stop', responseId: `gen-${n}` } })}\n`);
    fs.writeFileSync(path.join(dir, 'answer.md'), answer);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      schema: RUN_SCHEMA, key: resumeKey({ armSha: hashes.core, model: 'acme/alpha', inputHash: kase.inputHash, arm: 'raw', rep: 1 }), run_id: 't', arm_sha256: hashes.core, core_sha256: hashes.core, protocol_sha256: sha,
      model: 'acme/alpha', case: kase.id, pair: kase.pair, family: kase.family, arm: 'raw', rep: 1, input_hash: kase.inputHash,
      finished_at: `2026-10-03T10:00:0${n}.000Z`, wall_s: 20, status: 'ok', failure: null, final: true, stop_reason: 'stop', turns: 1,
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, usd: 0.01, usd_source: 'omp', effort: 'high', providers: ['P'],
    }));
    n++;
  }
  const env = { PAYDIRT_PROTOCOL: protoFile };
  const args = ['--run-id', 't', '--runs-dir', runs, '--cases-root', root, '--set', 'scored'];
  const pub = cli(['publish', ...args, '--out-dir', outDir, '--salts', path.join(tmp, 'salts.json'), '--release', 'test-sets'], env);
  assert.equal(pub.status, 0, pub.stderr + pub.stdout);
  assert.match(pub.stdout, /practice set: 1 public pairs, 1 models -> practice\/latest\.json/);

  const latest = JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
  assert.deepEqual(latest.pairs.map((p) => [p.pair, p.visibility]), [['fx-02', 'held']]);
  assert.deepEqual([latest.cases.pairs, latest.cases.held, latest.cases.public, latest.repeats], [1, 1, 0, 1]);
  assert.equal(latest.models[0].arms.raw.score.median, 100);
  assert.deepEqual(Object.keys(latest.models[0].arms), ['raw'], 'an arm that was never run for a model is not reported for it');
  assert.equal(latest.models[0].complete, true);
  assert.deepEqual(latest.commitments.map((c) => c.case), ['fx-02-a', 'fx-02-o']);
  const practice = JSON.parse(fs.readFileSync(path.join(outDir, 'practice', 'latest.json'), 'utf8'));
  assert.deepEqual(practice.pairs.map((p) => [p.pair, p.visibility]), [['fx-01', 'public']]);
  assert.equal(practice.models[0].arms.raw.score.median, 100);
  assert.deepEqual(practice.commitments, []);
  assert.equal(practice.downloads.archive, '../paydirt-test-sets-public.tar.gz');
  assert.ok(fs.existsSync(path.join(outDir, 'practice', 'models', 'acme__alpha.json')));

  assert.deepEqual([latest.hashes, practice.hashes], [hashes, hashes], 'both results files state the hashes of the protocol they were made under');
  const download = unpackTarGz(fs.readFileSync(path.join(outDir, latest.downloads.archive)));
  const names = [...download.keys()];
  assert.deepEqual(JSON.parse(download.get('paydirt-test-sets/bench/protocol.json').toString('utf8')), proto, 'the download holds the protocol the results were made under');
  assert.ok(names.includes('paydirt-test-sets/bench/cases/fx-01-v/truth.json') && names.includes('paydirt-test-sets/raw/acme__alpha/fx-01-f.raw.1/events.jsonl'));
  assert.ok(!names.some((x) => x.includes('/bench/cases/fx-02') || (x.includes('/raw/') && x.includes('fx-02'))), 'no file and no raw output of a scored (held) case');
  assert.equal(latest.downloads.public_runs, 2);

  const board = cli(['verify', '--results', path.join(outDir, 'latest.json')], env);
  assert.equal(board.status, 0, board.stdout);
  assert.match(board.stdout, /0\/0 raw runs on public cases re-scored.*\(2 more raw runs in the download belong to pairs outside this results file\)/);
  const prac = cli(['verify', '--results', path.join(outDir, 'practice', 'latest.json')], env);
  assert.equal(prac.status, 0, prac.stdout);
  assert.match(prac.stdout, /2\/2 raw runs on public cases re-scored/);

  // score follows --set too
  const scoreArgs = ['score', '--run-id', 't', '--runs-dir', runs, '--cases-root', root];
  assert.match(cli([...scoreArgs, '--set', 'public', '--out', path.join(tmp, 'p.json')], env).stdout, /1 pairs/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'p.json'), 'utf8')).pairs[0].pair, 'fx-01');
  assert.equal(cli([...scoreArgs, '--set', 'nope'], env).status, 1);
}));

// ---------------------------------------------------------------- offline smoke helpers

test('offline smoke: the answer books are what their names say, on the fixture cases', () => {
  const cases = loadCases([FIXTURE_CASES]);
  const sheetOf = (text) => JSON.parse(text.slice(text.indexOf(`${F}json`) + 7, text.lastIndexOf(F)));
  const get = (book, id) => sheetOf(answerFor(book, cases.find((c) => c.id === id)));
  assert.equal(get('key', 'fx-01-v').findings[0].function, 'withdrawAll');
  assert.deepEqual(get('key', 'fx-01-f').findings, []);
  assert.equal(get('flag', 'fx-01-f').findings[0].severity, 'high');
  assert.deepEqual([get('key', 'fx-02-o').verdict, get('key', 'fx-02-a').verdict, get('flag', 'fx-02-a').verdict, get('silent', 'fx-02-o').verdict], ['overclaimed', 'supported', 'overclaimed', 'supported']);
  assert.ok(get('key', 'fx-02-o').rejected[0].quote.length >= 20);
  assert.match(workspaceDigest(cases[0]), /^[0-9a-f]{64}$/);
  assert.notEqual(workspaceDigest(cases[0]), workspaceDigest(cases[1]), 'twins have different digests');
});

// ---------------------------------------------------------------- runbook batches

test('runbook: batches follow the plan order, never mix tiers, fit one window with slack, and carry a cap', async () => {
  const { makeBatches, commandOf } = await import('../tools/runbook.mjs');
  const row = (slug, tier, arm, usd, running) => ({ slug, tier, arm, runs: 36, usd, low: usd / 2, high: usd * 2, running, price: {} });
  const rows = [
    row('a/one', 1, 'headline', 1, 1), row('a/one', 1, 'profile', 1, 2), row('a/two', 1, 'headline', 2, 4), row('a/three', 1, 'headline', 3, 7), row('a/four', 1, 'headline', 4, 11),
    row('b/five', 2, 'headline', 5, 16), row('b/six', 2, 'headline', 6, 22), row('b/six', 2, 'profile', 6, 28), row('c/seven', 3, 'headline', 50, 78),
    { slug: 'c/unlisted', tier: 3, arm: 'headline', runs: 36, usd: null, low: null, high: null, running: 78, price: {} },
  ];
  // the budget line falls between b/six's raw row and its profile row
  const args = { rows, line: 7, protocol, concurrency: 12, windowMin: 110, secondsPerRun: 480 };
  const { batches, capacity, launchMin } = makeBatches({ ...args, smokeCap: 2 });
  assert.equal(launchMin, 76.5, 'a run may take 30 minutes plus the kill grace, so nothing starts after minute 76');
  assert.equal(capacity, 80, '12 workers for 70% of the launch time at 8 minutes a run');
  assert.deepEqual(batches.map((b) => [b.n, b.tier, b.inBudget, b.models.join('+'), b.runs, b.arms, b.perModel, b.minutes]), [
    [1, 1, true, 'a/one', 72, null, 11, 53],                  // the smoke: the first model alone, its profile arms with it
    [2, 1, true, 'a/two+a/three', 72, null, 6, 48],
    [3, 1, true, 'a/four', 36, null, 6, 48],                  // a tier is never mixed with the next
    [4, 2, true, 'b/five+b/six', 72, 'raw', 6, 48],           // b/six runs its raw arm only: its profile arms are past the line
    [5, 2, false, 'b/six', 36, 'solidity,general,report', 6, 48],
    [6, 3, false, 'c/seven', 36, null, 6, 48],
  ]);
  assert.deepEqual(batches.map((b) => b.cap), [2, 15, 12, 33, 18, 150], '1.5 x the high estimate, and the smoke cap on the first');
  assert.ok(batches.every((b) => b.runs <= capacity && b.fitsWindow));
  assert.equal(commandOf(batches[3], { runId: 'r', concurrency: 12, windowMin: 110, budget: 160 }), 'node bench/bench.mjs run --run-id r --models b/five,b/six --arms raw --concurrency 12 --per-model 6 --max-usd 33 --run-budget-usd 160 --max-minutes 110');
  // "--arms raw" never joins a model whose profile arms are meant to run in the same command
  const mixed = makeBatches({ ...args, rows: [row('a/one', 1, 'headline', 1, 1), row('p/q', 1, 'headline', 1, 2), row('p/q', 1, 'profile', 1, 3), row('a/two', 1, 'headline', 1, 4), row('p/q2', 1, 'headline', 1, 5), row('p/q2', 1, 'profile', 1, 6)], line: 5 });
  assert.deepEqual(mixed.batches.map((b) => [b.models.join('+'), b.arms, b.inBudget]), [['a/one', null, true], ['p/q', null, true], ['a/two+p/q2', 'raw', true], ['p/q2', 'solidity,general,report', false]]);
  // without the smoke option the first model shares its batch when the batch has room
  assert.equal(makeBatches({ ...args, rows: rows.filter((r) => r.arm !== 'profile'), line: 6 }).batches[0].models.join('+'), 'a/one+a/two');
});
