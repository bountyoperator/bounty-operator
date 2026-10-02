// The hash a run is stored and counted under: the core hash for the raw arm, one hash per
// profile for the profile arms (lib/protocol.mjs). Freezing changed product texts again must
// leave every raw-arm key where it was and move the keys of the changed profile only; score,
// publish and verify must agree on a run folder whose runs were made under different profile
// hashes; an old run folder must be read without error. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCases, sha256 } from '../lib/cases.mjs';
import { buildArm, frozenProfile } from '../lib/arms.mjs';
import { resolveOmp } from '../lib/omp.mjs';
import { RUN_SCHEMA, countsUnder, modelDir, resumeKey, runName } from '../lib/runs.mjs';
import { HASHES_BEGIN, HASHES_END, PROFILE_ARM_FILES, findHashesBlock, hashesDrift, profileArmIds, protocolHash, protocolHashes, recordedHashes, renderHashesBlock, replaceHashesBlock, stampHashes } from '../lib/protocol.mjs';
import { packTarGz, unpackTarGz } from '../lib/tar.mjs';
import { answerFor } from '../tools/offline-smoke.mjs';
import { buildPlan, freezeProtocol, freezeReport, loadProtocol, otherCoreRuns, promptDrift, storedRun, supersededRun } from '../bench.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(BENCH, 'tests', 'fixtures');
const FIXTURE_CASES = path.join(FIXTURES, 'cases');
const { protocol, hashes } = loadProtocol();
const PROFILES = profileArmIds(protocol);
const HEX = /^[0-9a-f]{64}$/;
// Two tests below call the real `run` command and expect it to refuse. If such a refusal ever broke, the
// command would go on to start the omp pinned in .local/benchmark.env with the real key, on every model
// and with no cap. So every command these tests start is told of an omp that does not exist: a `run` that
// gets past its refusal then stops at "omp not found" before anything is started or spent.
const NO_OMP = path.join(FIXTURES, 'no-omp-is-ever-started-by-the-tests');
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(BENCH, 'bench.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, PAYDIRT_OMP: NO_OMP, ...env } });
const sandbox = (fn) => { const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-hashes-')); try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); } };
const edited = (fn) => { const copy = structuredClone(protocol); fn(copy); return copy; };

/**
 * What `freeze` would write when the product has changed the text of the named profiles (the
 * others come out as they are frozen now) and the engine sits at another commit. Nothing is
 * written: freezeProtocol only computes.
 */
const refreeze = (changed) => freezeProtocol(protocol, {
  live: async (id) => ({ sent: `${frozenProfile(id, BENCH)}${changed.includes(id) ? `\n\nA paragraph the product added to its ${id} profile.` : ''}`, engine_profile: id, mode: 'bounty' }),
  engineInfo: () => ({ commit: 'f'.repeat(40), dirty: false, files: { 'web/public/review-core.mjs': '1'.repeat(64), 'web/public/profiles.mjs': '2'.repeat(64) } }),
});

const keyOf = (task, h) => resumeKey({ armSha: h.arms[task.arm], model: task.model, inputHash: task.kase.inputHash, arm: task.arm, rep: task.rep });
const nameOf = (task) => `${task.model} ${runName(task.kase.id, task.arm, task.rep)}`;
/** The keys of every task under two sets of hashes: { same: [names], moved: [names] }. */
function compareKeys(tasks, before, after) {
  const same = [], moved = [];
  for (const t of tasks) (keyOf(t, before) === keyOf(t, after) ? same : moved).push(nameOf(t));
  return { same, moved };
}
/** Every model x case x arm of the fixture cases, the profile arms included for both models. */
const fixturePlan = () => buildPlan(protocol, { 'cases-root': FIXTURE_CASES, models: 'openai/gpt-oss-120b,z-ai/glm-5.3-flash', 'all-arms': true }, { offline: true });

test('no command started by these tests can reach a real omp', () => {
  assert.equal(fs.existsSync(NO_OMP), false);
  // even where .local/benchmark.env pins an omp, the binary the environment names is the one looked for, and it is not there
  assert.throws(() => resolveOmp({ PATH: '', PAYDIRT_OMP: NO_OMP }, { PAYDIRT_OMP: process.execPath, PAYDIRT_OMP_ARGS: '["cli.js"]' }), /omp not found at .*no-omp-is-ever-started-by-the-tests \(PAYDIRT_OMP, from the environment\)/);
  assert.equal(cli(['hashes']).status, 0, 'a command that starts no omp is not affected');
});

// ---------------------------------------------------------------- the layout

test('hash layout: the raw arm runs under the core hash, each profile arm under a hash of its own', () => {
  assert.deepEqual(Object.keys(hashes.arms), ['raw', ...PROFILES]);
  assert.deepEqual(PROFILES, ['solidity', 'general', 'report']);
  assert.equal(hashes.arms.raw, hashes.core);
  for (const h of [hashes.protocol, hashes.core, ...Object.values(hashes.arms)]) assert.match(h, HEX);
  assert.equal(new Set([hashes.protocol, ...Object.values(hashes.arms)]).size, 5, 'five different hashes: the protocol, the core and three profiles');
  assert.equal(hashes.protocol, protocolHash(protocol));
  // the block freeze writes into protocol.json and into METHOD.md is the hash of the content
  assert.deepEqual(protocol.hashes, hashes, 'run "node bench/bench.mjs freeze" (or "freeze --no-engine") after changing protocol.json');
  assert.deepEqual(hashesDrift(protocol), []);
  const method = fs.readFileSync(path.join(BENCH, 'METHOD.md'), 'utf8');
  assert.equal(findHashesBlock(method), renderHashesBlock(protocol), 'METHOD.md states the hash each arm runs under');
  for (const h of [hashes.protocol, ...Object.values(hashes.arms)]) assert.ok(findHashesBlock(method).includes(h));
});

test('the core hash covers everything but the product part; a profile hash adds the bridge and its own text', () => {
  const moved = (fn) => {
    const now = protocolHashes(edited(fn));
    return ['protocol', 'core'].filter((k) => now[k] !== hashes[k]).concat(PROFILES.filter((id) => now.arms[id] !== hashes.arms[id])).join(',');
  };
  // the product part: nothing a raw-arm run is told
  assert.equal(moved((p) => { p.engine.commit = 'f'.repeat(40); p.engine.dirty = false; }), 'protocol');
  assert.equal(moved((p) => { p.engine.files['web/public/profiles.mjs'] = '0'.repeat(64); }), 'protocol', 'an engine edit that leaves the texts alone moves no run');
  assert.equal(moved((p) => { p.engine.profiles.report.chars += 1; }), 'protocol');
  assert.equal(moved((p) => { p.engine.profiles.report.system_sha256 = '0'.repeat(64); }), 'protocol,report', 'a changed text moves the hash of its profile and no other');
  assert.equal(moved((p) => { for (const id of PROFILES) p.engine.profiles[id].system_sha256 = id.padEnd(64, '0'); }), 'protocol,solidity,general,report', 'every text changed: the core hash still stands');
  assert.deepEqual(PROFILE_ARM_FILES, ['prompts/profile-bridge.md']);
  assert.equal(moved((p) => { p.files['prompts/profile-bridge.md'] = '0'.repeat(64); }), 'protocol,solidity,general,report', 'the bridge is sent by profile arms only');
  assert.equal(moved((p) => { delete p.engine; }), 'protocol,solidity,general,report');
  assert.deepEqual(PROFILES.map((id) => protocolHashes(edited((p) => { delete p.engine; })).arms[id]), [null, null, null], 'no frozen text, no hash to run under');
  // the core: everything else, as it always was
  const all = 'protocol,core,solidity,general,report';
  for (const [what, fn] of Object.entries({
    'omp version': (p) => { p.omp.version = 'omp/18.4.11'; },
    'omp flags': (p) => { p.omp.flags.push('--verbose'); },
    'routing policy': (p) => { p.omp.routing.data_collection = 'deny'; },
    'time limit': (p) => { p.omp.max_time_minutes = 45; },
    'thinking level': (p) => { p.omp.thinking = 'high'; },
    'overlay': (p) => { p.files['harness/bench-overlay.yml'] = '0'.repeat(64); },
    'jail extension': (p) => { p.files['harness/jail-ext.ts'] = '0'.repeat(64); },
    'system prompt': (p) => { p.files['prompts/system.txt'] = '0'.repeat(64); },
    'task text': (p) => { p.files['prompts/raw-task.md'] = '0'.repeat(64); },
    'answer sheet': (p) => { p.files['prompts/answer-sheet.md'] = '0'.repeat(64); },
    'scoring constant': (p) => { p.scoring.line_tolerance = 4; },
    'the sets': (p) => { p.sets.scored.pop(); },
    'the model list': (p) => { p.tiers['3'].push('some/model'); },
    'a run setting': (p) => { p.run.concurrency = 7; },
  })) assert.equal(moved(fn), all, what);
  // the stored block is a record, never an input
  assert.deepEqual(protocolHashes(edited((p) => { p.hashes = { protocol: 'x', core: 'y', arms: { raw: 'z' } }; })), hashes);
  assert.deepEqual(protocolHashes(edited((p) => { delete p.hashes; })), hashes);
});

test('a hashes block that is not the hash of the content is named, entry by entry', () => {
  assert.deepEqual(hashesDrift(edited((p) => { delete p.hashes; })), ['missing']);
  assert.deepEqual(hashesDrift(edited((p) => { p.engine.commit = 'x'; })), ['protocol']);
  assert.deepEqual(hashesDrift(edited((p) => { p.engine.profiles.general.system_sha256 = '0'.repeat(64); })), ['protocol', 'general']);
  assert.deepEqual(hashesDrift(edited((p) => { p.run.concurrency = 7; })), ['protocol', 'core', 'solidity', 'general', 'report']);
  assert.deepEqual(hashesDrift(stampHashes(edited((p) => { p.run.concurrency = 7; }))), [], 'stamping writes the block again');
  const stamped = stampHashes(edited((p) => { p.run.concurrency = 7; }));
  assert.equal(Object.keys(stamped).at(-1), 'hashes');
  assert.equal(stamped.hashes.protocol, protocolHash(stamped));
  // METHOD.md: the block is found, replaced, and missed when the markers are gone
  const text = `before\n\n${HASHES_BEGIN}\nold\n${HASHES_END}\n\nafter\n`;
  assert.equal(replaceHashesBlock(text, renderHashesBlock(stamped)), `before\n\n${renderHashesBlock(stamped)}\n\nafter\n`);
  assert.ok(renderHashesBlock(stamped).includes(`| \`raw\` | the core | \`${stamped.hashes.core}\` |`));
  assert.equal(findHashesBlock('no markers here'), null);
  assert.equal(replaceHashesBlock('no markers here', 'x'), null);
});

// ---------------------------------------------------------------- freezing again

test('re-freeze: when every product text changes, every raw-arm key stays where it was', async (t) => {
  const { next, texts } = await refreeze(PROFILES);
  const after = next.hashes;
  assert.deepEqual(Object.keys(texts), PROFILES, 'the freeze would write three new texts');
  assert.deepEqual(after, protocolHashes(next));
  assert.equal(after.core, hashes.core, 'the core hash does not move');
  assert.equal(after.arms.raw, hashes.arms.raw);
  assert.notEqual(after.protocol, hashes.protocol, 'the protocol hash, which covers the whole file, does');
  for (const id of PROFILES) assert.notEqual(after.arms[id], hashes.arms[id], id);
  assert.deepEqual(next.files, protocol.files, 'the prompt and harness files are the same');

  // the keys `run` resumes by, on the fixture cases
  const plan = await fixturePlan();
  const raw = plan.tasks.filter((x) => x.arm === 'raw'), profile = plan.tasks.filter((x) => x.arm !== 'raw');
  assert.deepEqual([raw.length, profile.length], [8, 8]);
  assert.deepEqual(compareKeys(raw, hashes, after), { same: raw.map(nameOf), moved: [] });
  assert.deepEqual(compareKeys(profile, hashes, after), { same: [], moved: profile.map(nameOf) });

  // the same through storedRun, with runs on disk that were stored before the freeze
  sandbox((root) => {
    for (const task of plan.tasks) {
      const dir = path.join(root, 'raw', modelDir(task.model), runName(task.kase.id, task.arm, task.rep));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schema: RUN_SCHEMA, key: keyOf(task, hashes), arm_sha256: hashes.arms[task.arm], arm: task.arm, final: true, failure: null, input_hash: task.kase.inputHash }));
    }
    assert.equal(plan.tasks.filter((x) => storedRun(root, hashes, x, [])).length, 16, 'before the freeze every run is found');
    assert.deepEqual(plan.tasks.filter((x) => storedRun(root, after, x, [])).map(nameOf), raw.map(nameOf), 'after it, the raw-arm runs are still found and are not bought again');
    assert.deepEqual(plan.tasks.filter((x) => supersededRun(root, after, x)).map(nameOf), profile.map(nameOf), 'and the profile-arm runs are named as the ones to make again');
    assert.deepEqual(otherCoreRuns(root, next, after), [], 'no raw-arm run was put aside');
  });

  // what the freeze prints
  const report = freezeReport(next, hashes, after).join('\n');
  assert.match(report, /core\s+[0-9a-f]{16}\s+unchanged: stored raw-arm runs still count/);
  assert.match(report, /solidity\s+[0-9a-f]{16} -> [0-9a-f]{16}\s+CHANGED: stored solidity runs no longer count/);

  // the release plan itself, where the held cases are on disk (they are not in the public download)
  const release = await buildPlan(protocol, {}, { offline: true });
  if (!release.cases.length) { t.diagnostic('the scored cases are not on disk; the release plan was not checked'); return; }
  const releaseRaw = release.tasks.filter((x) => x.arm === 'raw'), releaseProfile = release.tasks.filter((x) => x.arm !== 'raw');
  assert.equal(compareKeys(releaseRaw, hashes, after).moved.length, 0);
  assert.equal(compareKeys(releaseProfile, hashes, after).same.length, 0);
  t.diagnostic(`release plan (${release.models.length} models x ${release.cases.length} scored inputs): ${releaseRaw.length} raw-arm keys unchanged by a freeze of new product texts, ${releaseProfile.length} profile-arm keys moved`);
});

test('re-freeze: when one product text changes, only the keys of that profile move', async () => {
  const plan = await fixturePlan();
  const { next, texts } = await refreeze(['report']);
  const after = next.hashes;
  assert.equal(after.core, hashes.core);
  assert.deepEqual([after.arms.solidity, after.arms.general], [hashes.arms.solidity, hashes.arms.general], 'the profiles whose text did not change keep their hash');
  assert.notEqual(after.arms.report, hashes.arms.report);
  assert.equal(sha256(texts.solidity), protocol.engine.profiles.solidity.system_sha256);
  assert.deepEqual(next.engine.profiles.solidity, protocol.engine.profiles.solidity);
  const { same, moved } = compareKeys(plan.tasks, hashes, after);
  assert.deepEqual(moved, plan.tasks.filter((x) => x.arm === 'report').map(nameOf));
  assert.deepEqual(same, plan.tasks.filter((x) => x.arm !== 'report').map(nameOf));
  assert.equal(moved.length, 4);
  const report = freezeReport(next, hashes, after).join('\n');
  assert.match(report, /solidity\s+[0-9a-f]{16}\s+unchanged: stored solidity runs still count/);
  assert.match(report, /report\s+[0-9a-f]{16} -> [0-9a-f]{16}\s+CHANGED/);

  // the engine was edited or committed and every text came out the same: no run moves at all
  const engineOnly = (await refreeze([])).next;
  assert.notDeepEqual(engineOnly.engine, protocol.engine);
  assert.deepEqual(engineOnly.engine.profiles, protocol.engine.profiles);
  assert.deepEqual({ core: engineOnly.hashes.core, arms: engineOnly.hashes.arms }, { core: hashes.core, arms: hashes.arms });
  assert.notEqual(engineOnly.hashes.protocol, hashes.protocol);
  assert.deepEqual(compareKeys(plan.tasks, hashes, engineOnly.hashes).moved, []);

  // --no-engine: the product is not consulted, the texts and the engine block stay
  const kept = await freezeProtocol(protocol, { engine: false, live: async () => { throw new Error('the engine must not be loaded'); } });
  assert.deepEqual(kept.texts, {});
  assert.deepEqual(kept.next, protocol, 'with nothing changed, freezing again writes the same file');

  // an edit to the core that was never frozen: the freeze is reported against the recorded hashes,
  // the ones the runs so far were made under, so the edit shows as the change it is
  const handEdited = edited((p) => { p.run.concurrency = 7; });
  assert.deepEqual(recordedHashes(handEdited), hashes, 'the block still records the hashes from before the edit');
  assert.deepEqual(recordedHashes(edited((p) => { delete p.hashes; })), hashes, 'without a block, the hashes of the content');
  const restamp = (await freezeProtocol(handEdited, { engine: false })).next;
  const lines = freezeReport(restamp, recordedHashes(handEdited), restamp.hashes).join('\n');
  assert.match(lines, new RegExp(`core\\s+${hashes.core.slice(0, 16)} -> ${restamp.hashes.core.slice(0, 16)}\\s+CHANGED: no stored run counts any more, on any arm`));
  assert.match(lines, /report\s+[0-9a-f]{16} -> [0-9a-f]{16}\s+CHANGED: follows the core hash/);
  await assert.rejects(freezeProtocol(protocol, { live: async () => { throw new Error('no web directory'); } }), /product text of the solidity profile could not be produced \(no web directory\).*freeze --no-engine/);
});

test('freeze --dry-run and hashes write nothing', () => {
  const file = path.join(BENCH, 'protocol.json');
  const before = [fs.readFileSync(file, 'utf8'), fs.readFileSync(path.join(BENCH, 'METHOD.md'), 'utf8'), ...PROFILES.map((id) => fs.readFileSync(path.join(BENCH, 'prompts', 'frozen', `${id}.md`), 'utf8'))];
  const dry = cli(['freeze', '--no-engine', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /freeze --dry-run: nothing written/);
  assert.match(dry.stdout, new RegExp(`core\\s+${hashes.core.slice(0, 16)}\\s+unchanged: stored raw-arm runs still count`));
  const shown = cli(['hashes', '--json']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), hashes);
  assert.match(cli(['hashes']).stdout, new RegExp(`core\\s+${hashes.core}`));
  assert.deepEqual([fs.readFileSync(file, 'utf8'), fs.readFileSync(path.join(BENCH, 'METHOD.md'), 'utf8'), ...PROFILES.map((id) => fs.readFileSync(path.join(BENCH, 'prompts', 'frozen', `${id}.md`), 'utf8'))], before);
});

test('a protocol.json edited after its hashes block was written is refused by lint and by run, before anything is spent', () => sandbox((tmp) => {
  const file = path.join(tmp, 'protocol.json');
  const args = ['--bench-dir', FIXTURES, '--cases-root', FIXTURE_CASES, '--no-engine'];
  // an edit to a core setting, with the block left as it was
  fs.writeFileSync(file, JSON.stringify(edited((p) => { p.run.concurrency = 7; })));
  const lint = cli(['lint', ...args], { PAYDIRT_PROTOCOL: file });
  assert.equal(lint.status, 1);
  assert.match(lint.stdout, /protocol\s+protocol\.hashes\s+protocol\.json was changed after its "hashes" block was written \(protocol, core, solidity, general, report differ\)/);
  const run = cli(['run', '--run-id', 'x', '--runs-dir', path.join(tmp, 'runs')], { PAYDIRT_PROTOCOL: file });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /was changed after its "hashes" block was written.*freeze --dry-run/);
  assert.equal(fs.existsSync(path.join(tmp, 'runs')), false, 'nothing was started or stored');
  const shown = cli(['hashes'], { PAYDIRT_PROTOCOL: file });
  assert.equal(shown.status, 1);
  assert.match(shown.stdout, /STALE/);
  const asJson = cli(['hashes', '--json'], { PAYDIRT_PROTOCOL: file });
  assert.equal(asJson.status, 1, 'with --json too, the exit code says the block is stale');
  assert.deepEqual(JSON.parse(asJson.stdout), protocolHashes(edited((p) => { p.run.concurrency = 7; })), 'and what is printed are the hashes of the content');
  // the same file with its block written again passes
  fs.writeFileSync(file, JSON.stringify(stampHashes(edited((p) => { p.run.concurrency = 7; }))));
  const ok = cli(['lint', ...args], { PAYDIRT_PROTOCOL: file });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /hashes: protocol [0-9a-f]{16}  raw [0-9a-f]{16} \(core\)  solidity [0-9a-f]{16}  general [0-9a-f]{16}  report [0-9a-f]{16}/);
}));

test('prompts are compared with protocol.json before a run is made', async () => {
  const kase = loadCases([FIXTURE_CASES], { glob: 'fx-01-v' })[0];
  const raw = await buildArm('raw', kase, { benchDir: BENCH }), solidity = await buildArm('solidity', kase, { benchDir: BENCH });
  assert.deepEqual(Object.keys(raw.sources), ['prompts/system.txt', 'prompts/raw-task.md', 'prompts/answer-sheet.md']);
  assert.deepEqual(Object.keys(solidity.sources), [...Object.keys(raw.sources), 'prompts/profile-bridge.md']);
  for (const [rel, sha] of Object.entries(solidity.sources)) assert.equal(sha, protocol.files[rel], rel);
  assert.deepEqual([promptDrift(protocol, raw), promptDrift(protocol, solidity)], [[], []]);
  const otherText = edited((p) => { p.engine.profiles.solidity.system_sha256 = '0'.repeat(64); });
  assert.deepEqual([promptDrift(otherText, raw), promptDrift(otherText, solidity)], [[], ['prompts/frozen/solidity.md']], 'another product text concerns the profile arm only');
  const otherBridge = edited((p) => { p.files['prompts/profile-bridge.md'] = '0'.repeat(64); });
  assert.deepEqual([promptDrift(otherBridge, raw), promptDrift(otherBridge, solidity)], [[], ['prompts/profile-bridge.md']]);
  const otherTask = edited((p) => { p.files['prompts/raw-task.md'] = '0'.repeat(64); });
  assert.deepEqual([promptDrift(otherTask, raw), promptDrift(otherTask, solidity)], [['prompts/raw-task.md'], ['prompts/raw-task.md']]);
});

// ---------------------------------------------------------------- score, publish, verify

const OLD_SOLIDITY = protocolHashes(edited((p) => { p.engine.profiles.solidity.system_sha256 = sha256('the solidity text as it was before it was frozen again'); })).arms.solidity;
const LEGACY = { key: 'ea1794d0a2822dc9962f2fdf663117a29d59907a22ac942a39a28268ea5d3bab', protocol_sha256: '1f59eab60de1754b79ad94dacf6f27d4945b8e74360a6d0feec21f7e4e30bd8d' };

/** One stored run that answers as the key does. `armSha: null` writes it as a run folder from before the hashes were split. */
function writeRun(runRoot, { model, kase, arm, armSha, n = 0 }) {
  const dir = path.join(runRoot, 'raw', modelDir(model), runName(kase.id, arm, 1));
  fs.mkdirSync(dir, { recursive: true });
  const answer = answerFor('key', kase);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model, content: [{ type: 'text', text: answer }], usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: 'stop', responseId: `gen-${n}` } })}\n`);
  fs.writeFileSync(path.join(dir, 'answer.md'), answer);
  const hashOf = armSha === null ? LEGACY : { key: resumeKey({ armSha, model, inputHash: kase.inputHash, arm, rep: 1 }), arm_sha256: armSha, core_sha256: hashes.core, protocol_sha256: hashes.protocol };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    schema: RUN_SCHEMA, ...hashOf, run_id: path.basename(runRoot), model, case: kase.id, pair: kase.pair, family: kase.family, arm, rep: 1, input_hash: kase.inputHash,
    finished_at: `2026-10-03T10:00:${String(n % 60).padStart(2, '0')}.000Z`, wall_s: 20, status: 'ok', failure: null, final: true, stop_reason: 'stop', turns: 1,
    usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, usd: 0.01, usd_source: 'omp', effort: 'high', providers: ['P'],
  }));
  return dir;
}

/**
 * A run folder as it looks after the solidity text was frozen again half way: alpha's solidity
 * runs were made under the earlier text, beta's under the present one. Raw and report runs of
 * both models are current. One raw run of gamma is from before the hashes were split.
 */
function mixedFolder(runRoot) {
  const cases = loadCases([FIXTURE_CASES]);
  let n = 0;
  for (const model of ['acme/alpha', 'openai/beta']) for (const kase of cases) for (const arm of protocol.arms[kase.family]) {
    writeRun(runRoot, { model, kase, arm, armSha: arm === 'solidity' && model === 'acme/alpha' ? OLD_SOLIDITY : hashes.arms[arm], n: n++ });
  }
  writeRun(runRoot, { model: 'old/gamma', kase: cases.find((c) => c.id === 'fx-01-v'), arm: 'raw', armSha: null, n: n++ });
  return cases;
}

test('a stored run counts under the hash of its own arm', () => {
  const meta = (arm, armSha) => ({ arm, arm_sha256: armSha });
  assert.equal(countsUnder(meta('raw', hashes.core), hashes), true);
  assert.equal(countsUnder(meta('solidity', hashes.arms.solidity), hashes), true);
  assert.equal(countsUnder(meta('solidity', OLD_SOLIDITY), hashes), false, 'made under an earlier text of its profile');
  assert.equal(countsUnder(meta('solidity', hashes.core), hashes), false, 'the core hash is not the hash of a profile arm');
  assert.equal(countsUnder(meta('raw', hashes.arms.solidity), hashes), false);
  assert.equal(countsUnder({ arm: 'raw', ...LEGACY }, hashes), false, 'a run from before the split carries no arm hash');
  assert.equal(countsUnder(meta('unknown', undefined), hashes), false);
  assert.equal(countsUnder(meta('general', null), { arms: { general: null } }), false, 'an arm without a hash counts nothing');
  assert.notEqual(OLD_SOLIDITY, hashes.arms.solidity);
});

test('score, publish and verify agree on a run folder that mixes arms made under different profile hashes', () => sandbox((tmp) => {
  const runs = path.join(tmp, 'runs'), outDir = path.join(tmp, 'web'), runRoot = path.join(runs, 'mix');
  const cases = mixedFolder(runRoot);
  const common = ['--run-id', 'mix', '--runs-dir', runs, '--cases-root', FIXTURE_CASES];

  // what `run` would make of this folder
  const task = (model, id, arm) => ({ model, kase: cases.find((c) => c.id === id), arm, rep: 1 });
  assert.ok(storedRun(runRoot, hashes, task('acme/alpha', 'fx-01-v', 'raw'), []));
  assert.ok(storedRun(runRoot, hashes, task('openai/beta', 'fx-01-v', 'solidity'), []));
  assert.equal(storedRun(runRoot, hashes, task('acme/alpha', 'fx-01-v', 'solidity'), []), null, 'made under the earlier solidity text: to be made again');
  assert.ok(supersededRun(runRoot, hashes, task('acme/alpha', 'fx-01-v', 'solidity')));
  assert.equal(supersededRun(runRoot, hashes, task('openai/beta', 'fx-01-v', 'solidity')), null);
  assert.equal(supersededRun(runRoot, hashes, task('acme/alpha', 'fx-01-v', 'raw')), null);
  assert.deepEqual(otherCoreRuns(runRoot, protocol, hashes).map(({ meta }) => meta.model), ['old/gamma'], 'the one raw-arm run that is not under the core hash');

  // score: 14 runs count; the two solidity runs under the earlier text and the old run do not
  const score = cli(['score', ...common]);
  assert.equal(score.status, 0, score.stderr);
  assert.match(score.stdout, /note: 3 stored run\(s\) ignored \(stale protocol: [^)]*\)/);
  assert.match(score.stdout, /stale protocol: [^)]*solidity 2/);
  assert.match(score.stdout, /stale protocol: [^)]*raw 1/);
  assert.match(score.stdout, new RegExp(`ran under: raw ${hashes.core.slice(0, 16)} \\(core\\)  solidity ${hashes.arms.solidity.slice(0, 16)}`));
  const local = JSON.parse(fs.readFileSync(path.join(runRoot, 'results.json'), 'utf8'));
  assert.deepEqual(local.hashes, hashes, 'the results state the hash each arm ran under, and nothing was mixed in');
  assert.deepEqual(local.models.map((m) => [m.slug, Object.keys(m.arms), Object.keys(m.lift), m.complete]), [
    ['acme/alpha', ['raw', 'report'], ['report'], true],                           // its solidity arm is as if never run
    ['openai/beta', ['raw', 'report', 'solidity'], ['report', 'solidity'], true],
  ]);
  assert.deepEqual(local.models.map((m) => [m.arms.raw.score.median, m.arms.raw.runs]), [[100, 4], [100, 4]], 'the raw-arm runs of both models count in full');

  // publish: the same numbers, and the download holds the raw output of exactly the runs that counted
  const pub = cli(['publish', ...common, '--out-dir', outDir, '--salts', path.join(tmp, 'salts.json'), '--release', 'test-mix']);
  assert.equal(pub.status, 0, pub.stderr + pub.stdout);
  assert.match(pub.stdout, /note: 3 stored run\(s\) ignored \(stale protocol/);
  const latestFile = path.join(outDir, 'latest.json');
  const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  assert.deepEqual(latest.hashes, hashes);
  assert.equal(latest.protocol_sha256, hashes.protocol);
  assert.deepEqual(latest.models, local.models, 'publish and score agree model for model');
  assert.equal(latest.downloads.public_runs, 14);
  const archiveFile = path.join(outDir, latest.downloads.archive);
  const archive = unpackTarGz(fs.readFileSync(archiveFile));
  const stored = [...archive.keys()].filter((k) => k.endsWith('/meta.json') && k.includes('/raw/')).map((k) => k.split('/').slice(2, 4).join('/'));
  assert.equal(stored.length, 14);
  assert.ok(stored.includes('openai__beta/fx-01-v.solidity.1') && stored.includes('acme__alpha/fx-01-v.raw.1') && stored.includes('acme__alpha/fx-02-o.report.1'));
  assert.ok(!stored.some((s) => s.startsWith('acme__alpha/') && s.includes('.solidity.')), 'the runs under the earlier solidity text are not published');
  assert.ok(!stored.some((s) => s.startsWith('old__gamma/')), 'nor is the run from before the split');
  for (const key of archive.keys()) if (key.endsWith('/meta.json') && key.includes('/raw/')) { const m = JSON.parse(archive.get(key).toString('utf8')); assert.equal(m.arm_sha256, hashes.arms[m.arm], key); }

  // verify: the hashes follow from the download, every run is under the hash stated for its arm, every outcome re-scores
  const ok = cli(['verify', '--results', latestFile]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ok {2}results recomputed from 14 published outcomes \(2 models\): identical/);
  assert.match(ok.stdout, new RegExp(`ok {2}hashes recomputed from the protocol, prompt files and frozen product texts in the download: raw ${hashes.core.slice(0, 16)}  solidity ${hashes.arms.solidity.slice(0, 16)}`));
  assert.match(ok.stdout, /14\/14 raw runs on public cases re-scored/);
  assert.match(ok.stdout, /verify: all checks passed/);

  // a results file that states another hash for an arm is caught twice: against the protocol and against the runs
  const forged = structuredClone(latest);
  forged.hashes.arms.solidity = OLD_SOLIDITY;
  fs.writeFileSync(latestFile, JSON.stringify(forged));
  const bad1 = cli(['verify', '--results', latestFile]);
  assert.equal(bad1.status, 1);
  assert.match(bad1.stdout, /MISMATCH protocol: hashes\.arms\.solidity: published/);
  assert.match(bad1.stdout, new RegExp(`MISMATCH raw/openai__beta/fx-01-[fv]\\.solidity\\.1: the run was stored under ${hashes.arms.solidity.slice(0, 16)}, the results say the solidity arm ran under ${OLD_SOLIDITY.slice(0, 16)}`));
  assert.doesNotMatch(bad1.stdout, /MISMATCH raw\/[^:]*\.raw\.1/, 'the raw-arm runs are not affected');
  fs.writeFileSync(latestFile, JSON.stringify(latest));

  // a download in which one run sits under another hash than the results state, or carries a key that is not its own
  const repack = (edit) => {
    const entries = [...archive.entries()].map(([p, data]) => ({ path: p, data }));
    const target = entries.find((e) => e.path.endsWith('raw/openai__beta/fx-01-v.solidity.1/meta.json'));
    target.data = Buffer.from(JSON.stringify(edit(JSON.parse(target.data.toString('utf8')))));
    const bytes = packTarGz(entries);
    fs.writeFileSync(archiveFile, bytes);
    fs.writeFileSync(latestFile, JSON.stringify({ ...latest, downloads: { ...latest.downloads, sha256: sha256(bytes), bytes: bytes.length } }));
    return cli(['verify', '--results', latestFile]);
  };
  const beta = cases.find((c) => c.id === 'fx-01-v');
  const bad2 = repack((m) => ({ ...m, arm_sha256: OLD_SOLIDITY, key: resumeKey({ armSha: OLD_SOLIDITY, model: 'openai/beta', inputHash: beta.inputHash, arm: 'solidity', rep: 1 }) }));
  assert.equal(bad2.status, 1);
  assert.match(bad2.stdout, /ok {2}hashes recomputed/);
  assert.match(bad2.stdout, /MISMATCH raw\/openai__beta\/fx-01-v\.solidity\.1: the run was stored under/);
  const bad3 = repack((m) => ({ ...m, key: 'not-the-key' }));
  assert.equal(bad3.status, 1);
  assert.match(bad3.stdout, /MISMATCH raw\/openai__beta\/fx-01-v\.solidity\.1: the key in meta\.json is not the key of this run/);
  // a download whose frozen product text is not the one its protocol records
  const tampered = [...archive.entries()].map(([p, data]) => ({ path: p, data: p.endsWith('bench/prompts/frozen/solidity.md') ? Buffer.from('another text\n') : data }));
  const bytes = packTarGz(tampered);
  fs.writeFileSync(archiveFile, bytes);
  fs.writeFileSync(latestFile, JSON.stringify({ ...latest, downloads: { ...latest.downloads, sha256: sha256(bytes), bytes: bytes.length } }));
  const bad4 = cli(['verify', '--results', latestFile]);
  assert.equal(bad4.status, 1);
  assert.match(bad4.stdout, /MISMATCH archive: bench\/prompts\/frozen\/solidity\.md is not the text protocol\.json records/);
}));

test('old run folders and old results are read without error', () => sandbox((tmp) => {
  const runs = path.join(tmp, 'runs'), outDir = path.join(tmp, 'web');
  const cases = mixedFolder(path.join(runs, 'mix'));
  const common = ['--run-id', 'mix', '--runs-dir', runs, '--cases-root', FIXTURE_CASES];

  // --any-protocol counts the runs made under other hashes, and the results say that they are mixed in
  const any = cli(['score', ...common, '--any-protocol', '--out', path.join(tmp, 'any', 'results.json')]);
  assert.equal(any.status, 0, any.stderr);
  assert.match(any.stdout, /note: 3 run\(s\) made under another hash are counted \(--any-protocol\)/);
  assert.match(any.stdout, /\[3 run\(s\) under other hashes are counted\]/);
  const mixed = JSON.parse(fs.readFileSync(path.join(tmp, 'any', 'results.json'), 'utf8'));
  assert.deepEqual(mixed.hashes, { ...hashes, mixed: 3 });
  assert.deepEqual(mixed.models.map((m) => m.slug).sort(), ['acme/alpha', 'old/gamma', 'openai/beta']);
  assert.ok(mixed.models.find((m) => m.slug === 'acme/alpha').arms.solidity, 'the runs under the earlier text are counted when asked for');
  assert.equal(cli(['verify', '--results', path.join(tmp, 'any', 'results.json')]).status, 0, 'such a results file still recomputes');

  // a folder that holds nothing but runs from before the split
  const old = path.join(runs, 'pilot');
  for (const [i, kase] of cases.entries()) writeRun(old, { model: 'old/gamma', kase, arm: 'raw', armSha: null, n: i });
  const args = ['--run-id', 'pilot', '--runs-dir', runs, '--cases-root', FIXTURE_CASES];
  const plain = cli(['score', ...args]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /note: 4 stored run\(s\) ignored \(stale protocol: [^)]*raw 4\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(old, 'results.json'), 'utf8')).models, []);
  const counted = cli(['score', ...args, '--any-protocol']);
  assert.equal(counted.status, 0, counted.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(old, 'results.json'), 'utf8')).models[0].arms.raw.score.median, 100, 'the pilot runs are still scored with --any-protocol');
  const refused = cli(['publish', ...args, '--out-dir', outDir, '--salts', path.join(tmp, 's.json')]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /No scoreable runs under bench\/runs\/pilot\. 4 stored run\(s\) were made under another hash/);
  // publish never takes --any-protocol: runs made under other hashes are for `score` to look at, not for a publication
  for (const args2 of [args, common]) {
    const mixedOut = path.join(tmp, 'web-any');
    const anyPub = cli(['publish', ...args2, '--any-protocol', '--out-dir', mixedOut, '--salts', path.join(tmp, 's.json')]);
    assert.equal(anyPub.status, 1);
    assert.match(anyPub.stderr, /Refusing to publish with --any-protocol/);
    assert.equal(fs.existsSync(mixedOut), false, 'and nothing is written');
  }
  // `run` does not buy raw-arm runs again on top of a folder whose raw runs sit under another core hash
  const run = cli(['run', ...args]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /holds 4 finished raw-arm runs made under another core hash \(no arm hash: stored before the hashes were split\); the core hash is now [0-9a-f]{16}\..*--allow-core-change/);
  assert.equal(fs.existsSync(path.join(old, 'raw', 'old__gamma', 'fx-01-v.raw.1', 'meta.json')), true, 'and the stored runs are left as they are');

  // results written before the hashes were split state none: they verify as before
  const pub = cli(['publish', ...common, '--out-dir', outDir, '--salts', path.join(tmp, 's.json'), '--release', 'test-old']);
  assert.equal(pub.status, 0, pub.stderr + pub.stdout);
  const latestFile = path.join(outDir, 'latest.json');
  const { hashes: _none, ...before } = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  fs.writeFileSync(latestFile, JSON.stringify(before));
  const ok = cli(['verify', '--results', latestFile]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /note: these results state no per-arm hashes/);
  assert.match(ok.stdout, /14\/14 raw runs on public cases re-scored/);
}));
