// The publication additions, offline: the "not run" list and the release notes, the count of
// infrastructure retries per model, and --harness-commit. Synthetic runs on the fixture cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCases } from '../lib/cases.mjs';
import { RUN_SCHEMA, modelDir, resumeKey, runName } from '../lib/runs.mjs';
import { packTarGz, unpackTarGz } from '../lib/tar.mjs';
import { NOT_RUN_REASON, notRun, parseReleaseNotes } from '../lib/score.mjs';
import { loadProtocol } from '../bench.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_CASES = path.join(BENCH, 'tests', 'fixtures', 'cases');
const { protocol, sha, hashes } = loadProtocol();
const F = '```';
const cli = (...args) => spawnSync(process.execPath, [path.join(BENCH, 'bench.mjs'), ...args], { encoding: 'utf8' });
const sheet = (o) => `Review.\n\n${F}json\n${JSON.stringify({ findings: [], rejected: [], verdict: 'n/a', max_severity: 'unrated', ...o })}\n${F}\n`;
const reentrancy = { file: 'src/PocketBank.sol', function: 'withdrawAll', line_start: 42, line_end: 44, severity: 'high', claim: 'pays before zeroing' };
const ANSWER = {
  'fx-01-v': sheet({ findings: [reentrancy], max_severity: 'high' }),
  'fx-01-f': sheet({}),
  'fx-02-o': sheet({ verdict: 'overclaimed', max_severity: 'high', rejected: [{ quote: 'Any caller can also redirect the accrued exit fees to an address of their choice' }] }),
  'fx-02-a': sheet({ verdict: 'supported', max_severity: 'high' }),
};

// Two models of the protocol's tiers: the first answers every input, the second never produced an
// answer (its only stored run is an unresolved infrastructure failure). A third, outside the tiers, answers too.
const RANKED = protocol.tiers['1'][0];
const STUCK = protocol.tiers['1'][1];
const OUTSIDE = 'acme/outside';

/** One stored run. `attempts` is written into meta.json as the runner writes it; null leaves it out. */
function writeRun(root, { model, kase, arm, rep = 1, attempts = [], infra = false, n }) {
  const dir = path.join(root, 'raw', modelDir(model), runName(kase.id, arm, rep));
  fs.mkdirSync(dir, { recursive: true });
  const answer = ANSWER[kase.id];
  const events = infra ? [] : [{ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model, content: [{ type: 'text', text: answer }], usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: 'stop', responseId: `gen-${n}` } }];
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  fs.writeFileSync(path.join(dir, 'answer.md'), infra ? '' : answer);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    schema: RUN_SCHEMA, key: resumeKey({ armSha: hashes.arms[arm], model, inputHash: kase.inputHash, arm, rep }), run_id: 'n1', arm_sha256: hashes.arms[arm], core_sha256: hashes.core, protocol_sha256: sha,
    model, case: kase.id, pair: kase.pair, family: kase.family, arm, rep, input_hash: kase.inputHash,
    finished_at: `2026-10-02T10:00:${String(n).padStart(2, '0')}.000Z`, wall_s: 30 + n, status: infra ? 'failed' : 'ok', failure: infra ? 'infra' : null, final: !infra,
    stop_reason: infra ? null : 'stop', turns: 1, usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, usd: infra ? 0 : 0.01, usd_source: infra ? 'none' : 'omp',
    effort: 'high', providers: ['ProviderOne'], ...(attempts === null ? {} : { attempts }),
  }));
}

function writeRelease(root) {
  const cases = loadCases([FIXTURE_CASES]);
  const retry = { failure: 'infra', detail: 'HTTP 502', wall_s: 1.2, usd: 0 };
  let n = 0;
  for (const kase of cases) {
    // RANKED: two retried attempts on fx-01-v, one on fx-02-o, none elsewhere (raw arm only)
    const attempts = kase.id === 'fx-01-v' ? [retry, retry] : kase.id === 'fx-02-o' ? [retry] : [];
    writeRun(root, { model: RANKED, kase, arm: 'raw', attempts, n: n++ });
    // OUTSIDE: stored before the runner kept an attempt record, so no count can be given
    writeRun(root, { model: OUTSIDE, kase, arm: 'raw', attempts: null, n: n++ });
  }
  writeRun(root, { model: STUCK, kase: cases[0], arm: 'raw', attempts: [retry, retry], infra: true, n: n++ });
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ prices_at: '2026-10-02T09:00:00.000Z', harness_commit: null, models: {
    [RANKED]: { slug: RANKED, name: 'Ranked One', vendor: RANKED.split('/')[0], open_weight: true, price: { in: 0.1, out: 0.5 }, run_tier: 1 },
    [STUCK]: { slug: STUCK, name: 'Stuck Two', vendor: STUCK.split('/')[0], open_weight: true, price: { in: 0.1, out: 0.5 }, run_tier: 1 },
  } }));
}

function sandbox(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-notes-'));
  try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const publish = (tmp, ...extra) => cli('publish', '--run-id', 'n1', '--runs-dir', path.join(tmp, 'runs'), '--cases-root', FIXTURE_CASES, '--out-dir', path.join(tmp, 'web'), '--salts', path.join(tmp, 'salts.json'), '--release', 'notes-1', '--allow-incomplete', ...extra);
const readLatest = (tmp) => JSON.parse(fs.readFileSync(path.join(tmp, 'web', 'latest.json'), 'utf8'));

test('notRun lists every tier model without a counted answer, in run order, with its reason', () => {
  const tiers = { 2: ['b/two'], 1: ['a/one', 'a/two', 'a/three'] };
  const models = [
    { slug: 'a/one', outcomes: [{ failure: null }] },
    { slug: 'a/two', outcomes: [{ failure: 'infra' }, { failure: 'missing' }] },
    { slug: 'a/three', outcomes: [{ failure: 'timeout' }] }, // a final failure is a counted answer: it scores as wrong
  ];
  assert.deepEqual(notRun({ tiers, models, reasons: { 'b/two': 'Withdrawn by its host.' }, names: { 'a/two': 'A Two' } }), [
    { slug: 'a/two', name: 'A Two', tier: 1, reason: NOT_RUN_REASON },
    { slug: 'b/two', name: 'b/two', tier: 2, reason: 'Withdrawn by its host.' },
  ]);
  assert.equal(NOT_RUN_REASON, "The release's credit did not reach it.");
});

test('release notes: both keys optional, anything else refused', () => {
  assert.deepEqual(parseReleaseNotes(null), { not_run: {}, notes: [] });
  assert.deepEqual(parseReleaseNotes('{"notes":[" One. "]}'), { not_run: {}, notes: ['One.'] });
  assert.throws(() => parseReleaseNotes('{"not_run":{"a/b":""}}'), /one non-empty sentence/);
  assert.throws(() => parseReleaseNotes('{"notrun":{}}'), /unknown key/);
  assert.throws(() => parseReleaseNotes('[]'), /must be an object/);
  assert.throws(() => parseReleaseNotes('{"notes":"x"}'), /list of non-empty sentences/);
  assert.throws(() => parseReleaseNotes('{'), /not JSON/);
  // the file of this release parses, and names a model of the protocol's tiers
  const shipped = parseReleaseNotes(fs.readFileSync(path.join(BENCH, 'release-notes', '2026-10.json'), 'utf8'));
  const tiered = Object.values(protocol.tiers).flat();
  for (const slug of Object.keys(shipped.not_run)) assert.ok(tiered.includes(slug), slug);
  assert.match(shipped.not_run['openai/gpt-oss-120b'], /35 of 36 initial inputs/);
  assert.match(shipped.not_run['openai/gpt-oss-120b'], /excluded from the ranking/);
});

test('publish writes not_run and notes, infra_retries and --harness-commit; verify recomputes them', () => sandbox((tmp) => {
  writeRelease(path.join(tmp, 'runs', 'n1'));
  const notes = path.join(tmp, 'notes.json');
  fs.writeFileSync(notes, JSON.stringify({ not_run: { [STUCK]: 'Its host returned no answer.', 'nobody/else': 'A reason for a model in no tier.' }, notes: ['One repeat per input in this release.'] }));

  const pub = publish(tmp, '--release-notes', notes, '--harness-commit', 'ABCDEF1234567');
  assert.equal(pub.status, 0, pub.stderr + pub.stdout);
  assert.match(pub.stdout, /the release notes give a reason for nobody\/else/);
  assert.match(pub.stdout, /harness commit: ABCDEF1234567 \(--harness-commit; plan\.json says nothing\)/);
  const latest = readLatest(tmp);
  assert.equal(latest.harness_commit, 'ABCDEF1234567', '--harness-commit overrides plan.json');

  // not_run: every tier model but RANKED, in run order; STUCK only failed for infrastructure reasons
  const tiered = Object.entries(protocol.tiers).sort(([a], [b]) => a - b).flatMap(([tier, slugs]) => slugs.map((slug) => ({ slug, tier: Number(tier) })));
  assert.deepEqual(latest.not_run.map((m) => m.slug), tiered.filter((m) => m.slug !== RANKED).map((m) => m.slug));
  const stuck = latest.not_run.find((m) => m.slug === STUCK);
  assert.deepEqual(stuck, { slug: STUCK, name: 'Stuck Two', tier: 1, reason: 'Its host returned no answer.' });
  assert.ok(latest.not_run.filter((m) => m.slug !== STUCK).every((m) => m.reason === NOT_RUN_REASON && m.name === m.slug));
  assert.ok(!latest.not_run.some((m) => m.slug === OUTSIDE || m.slug === 'nobody/else'));
  assert.deepEqual(latest.notes, ['One repeat per input in this release.']);

  // infra_retries: the sum over the counted runs; left out where no run carries the record
  const bySlug = new Map(latest.models.map((m) => [m.slug, m]));
  assert.equal(bySlug.get(RANKED).infra_retries, 3);
  assert.equal('infra_retries' in bySlug.get(OUTSIDE), false);
  assert.equal(bySlug.get(STUCK).infra_retries, 2, 'an unresolved run counts its retries too');
  const detail = JSON.parse(fs.readFileSync(path.join(tmp, 'web', bySlug.get(RANKED).detail), 'utf8'));
  assert.equal(detail.outcomes.find((o) => o.case === 'fx-01-v').infra_retries, 2);

  // the notes travel in the download, where verify reads them
  const archive = path.join(tmp, 'web', latest.downloads.archive);
  const files = unpackTarGz(fs.readFileSync(archive));
  assert.deepEqual(JSON.parse(files.get('paydirt-notes-1/bench/release-notes/notes-1.json').toString('utf8')), JSON.parse(fs.readFileSync(notes, 'utf8')));
  const ok = cli('verify', '--results', path.join(tmp, 'web', 'latest.json'));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /"not run" list \(24 model\(s\)\) and release notes recomputed/);
  assert.match(ok.stdout, /re-scored from events \+ answer key: identical/, 'public runs re-score with their retry count');

  // a changed reason, a dropped model or a changed note is caught
  for (const forge of [(r) => { r.not_run[0].reason = 'Something else.'; }, (r) => { r.not_run.pop(); }, (r) => { r.notes = []; }]) {
    const forged = structuredClone(latest);
    forge(forged);
    fs.writeFileSync(path.join(tmp, 'web', 'latest.json'), JSON.stringify(forged));
    const bad = cli('verify', '--results', path.join(tmp, 'web', 'latest.json'));
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stdout, /MISMATCH (not_run|notes)/);
  }
  // a changed retry count is caught by the recomputation from the outcomes
  const forged = structuredClone(latest);
  forged.models.find((m) => m.slug === RANKED).infra_retries = 0;
  fs.writeFileSync(path.join(tmp, 'web', 'latest.json'), JSON.stringify(forged));
  assert.match(cli('verify', '--results', path.join(tmp, 'web', 'latest.json')).stdout, /MISMATCH results: .*infra_retries/);
  fs.writeFileSync(path.join(tmp, 'web', 'latest.json'), JSON.stringify(latest));

  // a download without the notes file: every reason must then be the default
  const stripped = new Map([...files].filter(([name]) => !name.includes('/release-notes/')));
  fs.writeFileSync(archive, packTarGz([...stripped].map(([p, data]) => ({ path: p, data }))));
  const withoutNotes = structuredClone(latest);
  delete withoutNotes.downloads.sha256; // the archive was repacked on purpose
  fs.writeFileSync(path.join(tmp, 'web', 'latest.json'), JSON.stringify(withoutNotes));
  const missing = cli('verify', '--results', path.join(tmp, 'web', 'latest.json'));
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /MISMATCH not_run\[\d+\]\.reason/);
}));

test('publish without a notes file gives every model the default reason; plan.json keeps the harness commit', () => sandbox((tmp) => {
  writeRelease(path.join(tmp, 'runs', 'n1'));
  const plan = path.join(tmp, 'runs', 'n1', 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ ...JSON.parse(fs.readFileSync(plan, 'utf8')), harness_commit: 'fedcba9' }));
  const pub = publish(tmp);
  assert.equal(pub.status, 0, pub.stderr + pub.stdout);
  const latest = readLatest(tmp);
  assert.equal(latest.harness_commit, 'fedcba9');
  assert.ok(latest.not_run.every((m) => m.reason === NOT_RUN_REASON));
  assert.deepEqual(latest.notes, []);
  const names = [...unpackTarGz(fs.readFileSync(path.join(tmp, 'web', latest.downloads.archive))).keys()];
  assert.ok(!names.some((n) => n.includes('/release-notes/')), 'no notes file, none in the download');
  const ok = cli('verify', '--results', path.join(tmp, 'web', 'latest.json'));
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /the default reason \(no release-notes file in the download\)/);
}));

test('publish refuses a malformed harness commit and a malformed or missing notes file', () => sandbox((tmp) => {
  writeRelease(path.join(tmp, 'runs', 'n1'));
  const bad = publish(tmp, '--harness-commit', 'not-a-sha');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--harness-commit takes a commit id/);
  const notes = path.join(tmp, 'notes.json');
  fs.writeFileSync(notes, JSON.stringify({ not_run: { [STUCK]: 7 } }));
  const malformed = publish(tmp, '--release-notes', notes);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /one non-empty sentence/);
  const absent = publish(tmp, '--release-notes', path.join(tmp, 'nope.json'));
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /does not exist/);
  assert.equal(fs.existsSync(path.join(tmp, 'web', 'latest.json')), false, 'nothing is written');
}));
