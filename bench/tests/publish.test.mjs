// End to end, offline: stored runs -> score -> publish -> verify, with synthetic runs on
// the fixture cases. Also covers the archive format and the privacy of held cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCases, sha256 } from '../lib/cases.mjs';
import { RUN_SCHEMA, modelDir, resumeKey, runName } from '../lib/runs.mjs';
import { packTarGz, unpackTarGz } from '../lib/tar.mjs';
import { loadProtocol } from '../bench.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_CASES = path.join(BENCH, 'tests', 'fixtures', 'cases');
const { protocol, sha, hashes } = loadProtocol();
const F = '```';

const cli = (...args) => spawnSync(process.execPath, [path.join(BENCH, 'bench.mjs'), ...args], { encoding: 'utf8' });
const sheet = (o) => `Review.\n\n${F}json\n${JSON.stringify({ findings: [], rejected: [], verdict: 'n/a', max_severity: 'unrated', ...o })}\n${F}\n`;
const reentrancy = { file: 'src/PocketBank.sol', function: 'withdrawAll', line_start: 42, line_end: 44, severity: 'high', claim: 'pays before zeroing' };

/** What each synthetic model answers per case. alpha is always right; beta bites the fixed twin and accepts the overclaimed draft. */
const ANSWERS = {
  'acme/alpha': {
    'fx-01-v': sheet({ findings: [reentrancy], max_severity: 'high' }),
    'fx-01-f': sheet({ findings: [{ ...reentrancy, severity: 'info', claim: 'ordering is fine here' }] }),
    'fx-02-o': sheet({ verdict: 'overclaimed', max_severity: 'high', rejected: [{ quote: 'Any caller can also redirect the accrued exit fees to an address of their choice' }] }),
    'fx-02-a': sheet({ verdict: 'supported', max_severity: 'high' }),
  },
  'openai/beta': {
    'fx-01-v': sheet({ findings: [reentrancy], max_severity: 'high' }),
    'fx-01-f': sheet({ findings: [{ ...reentrancy, line_start: 41, line_end: 43, severity: 'medium' }], max_severity: 'medium' }),
    'fx-02-o': sheet({ verdict: 'supported', max_severity: 'critical' }),
    'fx-02-a': sheet({ verdict: 'supported', max_severity: 'high' }),
  },
};

function writeRuns(runsDir, runId, cases, { reps = 2 } = {}) {
  const root = path.join(runsDir, runId);
  let n = 0;
  for (const model of Object.keys(ANSWERS)) for (const kase of cases) for (const arm of protocol.arms[kase.family]) for (let rep = 1; rep <= reps; rep++) {
    const dir = path.join(root, 'raw', modelDir(model), runName(kase.id, arm, rep));
    fs.mkdirSync(dir, { recursive: true });
    const timeout = model === 'openai/beta' && kase.id === 'fx-02-a' && arm === 'report' && rep === 2;
    const answer = ANSWERS[model][kase.id];
    const cost = 0.01 + n * 0.0001;
    const events = [
      { type: 'session', cwd: 'D:\\pdw\\x\\y\\ws' },
      { type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model, content: timeout ? [{ type: 'toolCall', id: 't', name: 'read', arguments: { path: 'src/PocketBank.sol' } }] : [{ type: 'text', text: answer }], usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: cost } }, stopReason: timeout ? 'toolUse' : 'stop', responseId: `gen-${n}` } },
    ];
    fs.writeFileSync(path.join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    fs.writeFileSync(path.join(dir, 'answer.md'), timeout ? '' : answer);
    fs.writeFileSync(path.join(dir, 'request.json'), `${JSON.stringify({ model, instructions: 'system', tools: [] })}\n`);
    fs.writeFileSync(path.join(dir, 'stderr.txt'), 'this file must never be published\n');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      schema: RUN_SCHEMA, key: resumeKey({ armSha: hashes.arms[arm], model, inputHash: kase.inputHash, arm, rep }), run_id: runId, arm_sha256: hashes.arms[arm], core_sha256: hashes.core, protocol_sha256: sha,
      model, case: kase.id, pair: kase.pair, family: kase.family, arm, rep, input_hash: kase.inputHash,
      finished_at: `2026-10-02T10:00:${String(n % 60).padStart(2, '0')}.000Z`, wall_s: 20 + n, status: timeout ? 'failed' : 'ok', failure: timeout ? 'timeout' : null, final: true,
      stop_reason: timeout ? 'toolUse' : 'stop', turns: 1, usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 50 }, usd: cost, usd_source: 'omp',
      effort: model === 'acme/alpha' ? 'xhigh' : 'high', providers: ['ProviderOne'],
    }));
    n++;
  }
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ prices_at: '2026-10-02T09:00:00.000Z', harness_commit: 'abc123', models: {
    'acme/alpha': { slug: 'acme/alpha', name: 'Alpha', vendor: 'acme', open_weight: true, price: { in: 0.1, out: 0.5 }, run_tier: 1 },
    'openai/beta': { slug: 'openai/beta', name: 'Beta', vendor: 'openai', open_weight: false, price: { in: 2, out: 10 }, run_tier: 2 },
  } }));
  return n;
}

function sandbox(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-e2e-'));
  try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('tar.gz round trip is exact and deterministic', () => {
  const long = `paydirt-2026-10/raw/nvidia__nemotron-3-ultra-550b-a55b/sol-01-v.solidity.3/${'deep/'.repeat(8)}events.jsonl`;
  const entries = [{ path: 'b/two.txt', data: 'two' }, { path: 'a/one.bin', data: Buffer.from([0, 1, 2, 255]) }, { path: long, data: 'x'.repeat(1500) }, { path: 'empty', data: '' }];
  const packed = packTarGz(entries);
  assert.deepEqual(packTarGz([...entries].reverse()), packed, 'entry order does not change the bytes');
  const files = unpackTarGz(packed);
  assert.deepEqual([...files.keys()], ['a/one.bin', 'b/two.txt', 'empty', long]);
  assert.deepEqual([...files.get('a/one.bin')], [0, 1, 2, 255]);
  assert.equal(files.get(long).toString(), 'x'.repeat(1500));
  assert.equal(files.get('empty').length, 0);
  assert.throws(() => packTarGz([{ path: `${'a'.repeat(160)}/${'b'.repeat(101)}`, data: '' }]), /too long/);
});

test('score -> publish -> verify on the fixture cases', () => sandbox((tmp) => {
  const runs = path.join(tmp, 'runs'), outDir = path.join(tmp, 'web');
  const cases = loadCases([FIXTURE_CASES]);
  const total = writeRuns(runs, 't1', cases);
  assert.equal(total, 32, '2 models x 4 cases x 2 arms x 2 repeats');

  const score = cli('score', '--run-id', 't1', '--runs-dir', runs, '--cases-root', FIXTURE_CASES);
  assert.equal(score.status, 0, score.stderr);
  const local = JSON.parse(fs.readFileSync(path.join(runs, 't1', 'results.json'), 'utf8'));
  assert.equal(cli('verify', '--results', path.join(runs, 't1', 'results.json')).status, 0, 'a scored run verifies without an archive');

  const pub = cli('publish', '--run-id', 't1', '--runs-dir', runs, '--cases-root', FIXTURE_CASES, '--out-dir', outDir, '--salts', path.join(tmp, 'salts.json'), '--release', 'test-1');
  assert.equal(pub.status, 0, pub.stderr + pub.stdout);
  const latest = JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'test-1.json'), 'utf8')), latest);
  assert.equal(latest.schema, 'paydirt.results/1');
  assert.equal(latest.release, 'test-1');
  assert.equal(latest.protocol_sha256, sha);
  assert.deepEqual(latest.hashes, hashes, 'the results state the hash each arm ran under');
  assert.equal(latest.hashes.arms.raw, hashes.core, 'the raw arm ran under the core hash');
  assert.deepEqual(local.hashes, latest.hashes, 'score and publish state the same hashes');
  assert.equal(latest.harness_commit, 'abc123');
  assert.equal(latest.generated_at, '2026-10-02T10:00:31.000Z', 'the timestamp of the latest run, not the clock');
  assert.deepEqual(latest.cases, { pairs: 2, inputs: 4, public: 2, held: 0, by_family: { challenge: 1, 'find-sol': 1 }, by_author: { anthropic: 2 } });
  assert.deepEqual(latest.models.map((m) => [m.slug, m.tier, m.effort, m.open_weight, m.complete]), [['acme/alpha', 1, 'xhigh', true, true], ['openai/beta', 2, 'high', false, true]]);
  const [alpha, beta] = latest.models;
  assert.deepEqual([alpha.arms.raw.score.median, alpha.arms.raw.fools_gold, alpha.arms.raw.recall, alpha.arms.raw.challenge_ba], [100, 0, 1, 1]);
  assert.deepEqual([beta.arms.raw.score.median, beta.arms.raw.fools_gold, beta.arms.raw.recall, beta.arms.raw.challenge_ba, beta.arms.raw.line_acc], [0, 1, 1, 0.5, 1]);
  assert.equal(beta.arms.report.failure, 0.25, 'one timeout in four report-arm runs');
  assert.equal(beta.arms.report.score.median, 0);
  assert.deepEqual(alpha.lift.solidity, { delta: 0, ci95: [0, 0], n_pairs: 1, significant: false });
  assert.equal(beta.arms.raw.excl_same_vendor.n_pairs, 2);
  assert.deepEqual(latest.models.map((m) => m.arms.raw.score), local.models.map((m) => m.arms.raw.score), 'publish and score agree');
  assert.equal(latest.downloads.archive, 'paydirt-test-1-public.tar.gz');
  assert.equal(latest.downloads.public_runs, 32);
  assert.deepEqual(latest.commitments, []);

  const archive = fs.readFileSync(path.join(outDir, latest.downloads.archive));
  assert.equal(sha256(archive), latest.downloads.sha256);
  const names = [...unpackTarGz(archive).keys()];
  for (const want of ['README.md', 'bench/bench.mjs', 'bench/protocol.json', 'bench/lib/score.mjs', 'bench/lib/protocol.mjs', 'bench/harness/jail-ext.ts', 'bench/prompts/answer-sheet.md', 'bench/prompts/profile-bridge.md', 'bench/prompts/frozen/solidity.md', 'bench/prompts/frozen/report.md', 'bench/cases/fx-01-v/truth.json', 'bench/cases/fx-02-o/workspace/draft-report.md', 'raw/acme__alpha/fx-01-v.raw.1/events.jsonl', 'raw/openai__beta/fx-02-a.report.2/meta.json']) {
    assert.ok(names.includes(`paydirt-test-1/${want}`), want);
  }
  assert.ok(!names.some((n) => n.includes('/out/') || n.includes('/cache/')), 'no build output in the archive');
  assert.ok(!names.some((n) => n.endsWith('stderr.txt') || n.includes('benchmark.env') || n.includes('/private/') || n.includes('salts')), 'nothing private in the archive');
  const detail = JSON.parse(fs.readFileSync(path.join(outDir, alpha.detail), 'utf8'));
  assert.equal(detail.outcomes.length, 16);
  assert.ok(!JSON.stringify(detail).includes('pays before zeroing'), 'detail files carry outcomes, not model text');

  const ok = cli('verify', '--results', path.join(outDir, 'latest.json'));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /results recomputed from 32 published outcomes \(2 models\): identical/);
  assert.match(ok.stdout, /hashes recomputed from the protocol, prompt files and frozen product texts in the download/);
  assert.match(ok.stdout, /32\/32 raw runs on public cases re-scored/);
  assert.match(ok.stdout, /all checks passed/);

  // a changed headline number is caught
  const forged = structuredClone(latest);
  forged.models[1].arms.raw.score.median = 100;
  fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(forged));
  const bad1 = cli('verify', '--results', path.join(outDir, 'latest.json'));
  assert.equal(bad1.status, 1);
  assert.match(bad1.stdout, /MISMATCH results: .*score\.median/);
  fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(latest));

  // a changed outcome is caught twice: the aggregate changes and the raw output disagrees
  const betaFile = path.join(outDir, beta.detail);
  const betaDetail = JSON.parse(fs.readFileSync(betaFile, 'utf8'));
  const flipped = structuredClone(betaDetail);
  const target = flipped.outcomes.find((o) => o.case === 'fx-01-f' && o.arm === 'raw' && o.rep === 1);
  target.correct = true; target.bite = false;
  fs.writeFileSync(betaFile, JSON.stringify(flipped));
  const bad2 = cli('verify', '--results', path.join(outDir, 'latest.json'));
  assert.equal(bad2.status, 1);
  assert.match(bad2.stdout, /MISMATCH results/);
  assert.match(bad2.stdout, /MISMATCH raw\/openai__beta\/fx-01-f\.raw\.1/);
  fs.writeFileSync(betaFile, JSON.stringify(betaDetail));

  // a changed archive is caught
  fs.writeFileSync(path.join(outDir, latest.downloads.archive), packTarGz([{ path: 'paydirt-test-1/README.md', data: 'other' }]));
  const bad3 = cli('verify', '--results', path.join(outDir, 'latest.json'));
  assert.equal(bad3.status, 1);
  assert.match(bad3.stdout, /MISMATCH archive: sha256 differs/);
}));

test('held cases: outcomes are published, their files and raw outputs are not', () => sandbox((tmp) => {
  const casesRoot = path.join(tmp, 'cases'), runs = path.join(tmp, 'runs'), outDir = path.join(tmp, 'web'), salts = path.join(tmp, 'salts.json');
  fs.cpSync(FIXTURE_CASES, casesRoot, { recursive: true });
  for (const id of ['fx-02-o', 'fx-02-a']) {
    const file = path.join(casesRoot, id, 'case.json');
    fs.writeFileSync(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), visibility: 'held' }, null, 2)}\n`);
  }
  writeRuns(runs, 't2', loadCases([casesRoot]), { reps: 1 });
  const pub = cli('publish', '--run-id', 't2', '--runs-dir', runs, '--cases-root', casesRoot, '--out-dir', outDir, '--salts', salts);
  assert.equal(pub.status, 0, pub.stderr + pub.stdout);
  const latest = JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
  assert.equal(latest.release, protocol.release);
  assert.deepEqual([latest.cases.public, latest.cases.held], [1, 1]);
  assert.deepEqual(latest.commitments.map((c) => c.case), ['fx-02-a', 'fx-02-o']);
  assert.ok(latest.commitments.every((c) => /^[0-9a-f]{64}$/.test(c.sha256)));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(salts, 'utf8'))).sort(), ['fx-02-a', 'fx-02-o']);
  const names = [...unpackTarGz(fs.readFileSync(path.join(outDir, latest.downloads.archive))).keys()];
  assert.ok(names.some((n) => n.includes('/bench/cases/fx-01-v/')));
  // (the harness's own test fixtures under bench/tests/ are shipped; the held copies must not be)
  assert.ok(!names.some((n) => n.includes('/bench/cases/fx-02') || (n.includes('/raw/') && n.includes('fx-02'))), 'no held case file and no raw output on a held case');
  assert.equal(latest.downloads.public_runs, 8);
  const detail = JSON.parse(fs.readFileSync(path.join(outDir, latest.models[0].detail), 'utf8'));
  assert.equal(detail.outcomes.filter((o) => o.pair === 'fx-02').length, 4, 'held outcomes are still published');
  const first = latest.commitments[0].sha256;
  assert.equal(cli('publish', '--run-id', 't2', '--runs-dir', runs, '--cases-root', casesRoot, '--out-dir', outDir, '--salts', salts).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8')).commitments[0].sha256, first, 'commitments are stable across publishes');
  const ok = cli('verify', '--results', path.join(outDir, 'latest.json'));
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /8\/8 raw runs on public cases re-scored/);
}));

test('publish refuses an incomplete run; stale runs are ignored', () => sandbox((tmp) => {
  const runs = path.join(tmp, 'runs'), outDir = path.join(tmp, 'web');
  const cases = loadCases([FIXTURE_CASES]);
  writeRuns(runs, 't3', cases, { reps: 1 });
  fs.rmSync(path.join(runs, 't3', 'raw', 'openai__beta', 'fx-01-f.raw.1'), { recursive: true });
  const staleMeta = path.join(runs, 't3', 'raw', 'acme__alpha', 'fx-02-o.raw.1', 'meta.json');
  fs.writeFileSync(staleMeta, JSON.stringify({ ...JSON.parse(fs.readFileSync(staleMeta, 'utf8')), input_hash: '0'.repeat(64) }));
  const refused = cli('publish', '--run-id', 't3', '--runs-dir', runs, '--cases-root', FIXTURE_CASES, '--out-dir', outDir, '--salts', path.join(tmp, 's.json'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing to publish: missing or unresolved runs for .*acme\/alpha.*openai\/beta|Refusing to publish: missing or unresolved runs for .*openai\/beta.*acme\/alpha/);
  assert.equal(fs.existsSync(path.join(outDir, 'latest.json')), false);
  const score = cli('score', '--run-id', 't3', '--runs-dir', runs, '--cases-root', FIXTURE_CASES);
  assert.equal(score.status, 0);
  assert.match(score.stdout, /1 stored run\(s\) ignored \(stale case\)/);
  assert.match(score.stdout, /\[incomplete\]/);
  const forced = cli('publish', '--run-id', 't3', '--runs-dir', runs, '--cases-root', FIXTURE_CASES, '--out-dir', outDir, '--salts', path.join(tmp, 's.json'), '--allow-incomplete');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8')).models.every((m) => m.complete === false), true);
}));
