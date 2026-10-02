// The runner against a stand-in omp (tests/fixtures/fake-omp.mjs): real processes, no
// network. Covers the workspace copy, the clean environment, event capture, key
// redaction, infrastructure retries and the hard kill of the whole process tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInvocation, ompVersion, runOmp } from '../lib/omp.mjs';
import { loadCases } from '../lib/cases.mjs';
import { parseEvents } from '../lib/parse.mjs';
import { harnessChecks, resumeKey, runName } from '../lib/runs.mjs';
import { protocolHashes } from '../lib/protocol.mjs';
import { frozenProfile, writeFrozen } from '../lib/arms.mjs';
import { scoreInput } from '../lib/score.mjs';
import { toScoreRun } from '../lib/runs.mjs';
import { freezeProtocol, loadProtocol, runTask, storedRun } from '../bench.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(BENCH, 'tests', 'fixtures', 'fake-omp.mjs');
const KEY = 'sk-or-v1-FAKE-KEY-0123456789';
const { protocol, hashes } = loadProtocol();
const [kase] = loadCases([path.join(BENCH, 'tests', 'fixtures', 'cases')], { glob: 'fx-01-v' });

async function withFake(mode, fn) {
  const saved = [process.env.PAYDIRT_OMP, process.env.PAYDIRT_OMP_ARGS];
  process.env.PAYDIRT_OMP = process.execPath;
  process.env.PAYDIRT_OMP_ARGS = JSON.stringify([FAKE, mode]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-runner-'));
  const ctx = createInvocation({ benchDir: BENCH, protocol, key: KEY });
  try { return await fn(ctx, out); } finally {
    ctx.destroy();
    fs.rmSync(out, { recursive: true, force: true });
    for (const [i, name] of ['PAYDIRT_OMP', 'PAYDIRT_OMP_ARGS'].entries()) { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('one run: workspace copy, clean environment, captured events, redacted key', () => withFake('ok', async (ctx, out) => {
  assert.equal(ompVersion(ctx), 'omp/18.4.4');
  const res = await runOmp(ctx, 0, { model: 'acme/model-1', system: 'SYSTEM PROMPT\n', task: 'TASK "quoted" \\ back\nsecond line', files: kase.workspace, outDir: out, nonce: 'nonce-1' });
  assert.deepEqual([res.exitCode, res.timedOut, res.spawnError], [0, false, null]);
  assert.equal(res.counts.message_update, 5);
  assert.equal(res.dropped, 5);
  assert.equal(res.slotRemoved, true);
  assert.equal(fs.existsSync(res.cwd), false, 'the workspace copy is deleted after the run');
  assert.ok(!res.args.some((a) => a.includes(KEY)), 'the key is never an argument');

  const eventsText = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8');
  assert.ok(!eventsText.includes(KEY) && eventsText.includes('[REDACTED]'), 'the key is redacted from stored output');
  assert.ok(!eventsText.includes('message_update'));
  const ev = parseEvents(eventsText);
  assert.equal(ev.stopReason, 'stop');
  assert.deepEqual(ev.usage, { input: 1200, output: 300, cacheRead: 100, cacheWrite: 0, reasoning: 40 });
  assert.equal(ev.costReported, 0.00123);
  const report = JSON.parse(/FAKE-REPORT (\{.*\})/.exec(ev.finalText)[1]);
  assert.deepEqual(report.files, ['src/LedgerMath.sol', 'src/PocketBank.sol'], 'exactly the case files, nothing else');
  assert.deepEqual(report.launch, [], 'omp starts in an empty directory');
  assert.deepEqual(report.env.filter((n) => /KEY|TOKEN|SECRET/i.test(n)), ['OPENROUTER_API_KEY']);
  assert.ok(report.env.every((n) => ['SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'PATH', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'OPENROUTER_API_KEY', 'OMP_BENCH_DUMP'].includes(n)), `unexpected variables: ${report.env.join(', ')}`);
  assert.ok(report.home.startsWith(ctx.dir), 'throwaway home');
  if (process.platform === 'win32') assert.equal(report.user, 'bench', 'the real user name is not handed to omp');
  assert.equal(report.args.join(' '), ['-p', '--mode', 'json', '--profile', 'bench', '--no-session', '--no-title', '--no-skills', '--no-rules', '--no-extensions', '--no-lsp', '--no-pty', '--config', ctx.harness['bench-overlay.yml'], '-e', ctx.harness['dump-ext.ts'], '-e', ctx.harness['jail-ext.ts'], '--tools', 'read,grep,glob', '--thinking', 'max', '--max-time', '30m', '--system-prompt', path.join(path.dirname(res.cwd), 'system.txt'), '--append-system-prompt', 'run-nonce: nonce-1', '--cwd', res.cwd, '--model', 'openrouter/acme/model-1'].join(' '));

  const request = JSON.parse(fs.readFileSync(path.join(out, 'request.json'), 'utf8'));
  assert.equal(request.input[0].content[0].text, 'TASK "quoted" \\ back\nsecond line', 'the task survives the command line byte for byte');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'requests.jsonl'), 'utf8').trim()), { model: 'acme/model-1', effort: 'high', reasoning: { effort: 'high', summary: 'auto' }, tools: ['read', 'grep', 'glob'], provider: protocol.omp.routing, items: 1, max_tokens: null, temperature: null, wire: 'responses' });
  const expected = { tools: protocol.omp.tools, model: 'acme/model-1', provider: 'openrouter', system: 'SYSTEM PROMPT\n', nonce: 'nonce-1', cwd: res.cwd, routing: protocol.omp.routing };
  const checks = harnessChecks({ ev, requests: res.requests, expected });
  assert.equal(checks.ok, true, JSON.stringify(checks));
  assert.equal(checks.routing, true, 'the routing policy written into the throwaway profile reached the request');
  // a request that carries another routing block, or none, fails the check
  const other = harnessChecks({ ev, requests: res.requests, expected: { ...expected, routing: { ...protocol.omp.routing, sort: 'price' } } });
  assert.deepEqual([other.routing, other.ok], [false, false]);
  const bare = { ...res.requests, summaries: res.requests.summaries.map((s) => ({ ...s, provider: null })) };
  assert.equal(harnessChecks({ ev, requests: bare, expected }).routing, false);
  assert.equal(scoreInput(kase, kase.truth, toScoreRun({ meta: { failure: null }, eventsText }), protocol.scoring).correct, true);
}));

test('with no variable set, the omp pinned in the env file is the one that is started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-pin-'));
  const saved = [process.env.PAYDIRT_OMP, process.env.PAYDIRT_OMP_ARGS];
  delete process.env.PAYDIRT_OMP;
  delete process.env.PAYDIRT_OMP_ARGS;
  // the two lines an operator adds below the key: a runtime, and the cli.js of a private copy as its first argument
  const file = path.join(dir, 'benchmark.env');
  fs.writeFileSync(file, `OPENROUTER_API_KEY=${KEY}\r\nPAYDIRT_OMP=${process.execPath}\r\nPAYDIRT_OMP_ARGS=${JSON.stringify([FAKE, 'ok'])}\r\n`);
  const ctx = createInvocation({ benchDir: BENCH, protocol, key: KEY, envFile: file });
  try {
    assert.equal(ctx.omp.source, 'env-file');
    assert.equal(ompVersion(ctx), 'omp/18.4.4', 'the version check runs the pinned copy');
    const res = await runOmp(ctx, 0, { model: 'acme/model-1', system: 'S\n', task: 'T', files: kase.workspace, outDir: path.join(dir, 'out'), nonce: 'n' });
    assert.deepEqual([res.exitCode, res.spawnError], [0, null], 'and so does a run');
    const report = JSON.parse(/FAKE-REPORT (\{.*\})/.exec(parseEvents(fs.readFileSync(path.join(dir, 'out', 'events.jsonl'), 'utf8')).finalText)[1]);
    assert.deepEqual(report.env.filter((n) => n.startsWith('PAYDIRT_')), [], 'the pin is the harness\'s own setting: omp does not see it');
  } finally {
    ctx.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [i, name] of ['PAYDIRT_OMP', 'PAYDIRT_OMP_ARGS'].entries()) { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }
  }
});

test('hard timeout kills the whole process tree', () => withFake('hang', async (ctx, out) => {
  const started = Date.now();
  const res = await runOmp(ctx, 0, { model: 'acme/model-1', system: 's', task: 't', files: kase.workspace, outDir: out, hardKillSeconds: 3 });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - started < 30000, 'settles soon after the kill');
  const pids = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'fake_pids');
  assert.ok(pids, 'the stand-in reported its process ids');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(alive(pids.pid), false, 'the omp process is gone');
  assert.equal(alive(pids.grandchild), false, 'and so is the process it started');
  assert.equal(res.sawModelOutput, true);
  assert.equal(ctx.live.size, 0);
}));

test('an infrastructure failure is retried and the answer of the retry is stored', () => withFake('flaky', async (ctx, out) => {
  const fast = structuredClone(protocol);
  fast.run.retry_backoff_seconds = [0, 0];
  const fastHashes = protocolHashes(fast);
  const env = { ctx, protocol: fast, hashes: fastHashes, runRoot: out, runId: 'unit', catalogue: new Map(), ompVer: 'omp/18.4.4', stop: { reason: null }, genStats: 'off' };
  const task = { model: 'acme/model-1', kase, arm: 'raw', rep: 1 };
  const meta = await runTask(env, task, 0);
  assert.deepEqual([meta.status, meta.failure, meta.final, meta.stop_reason], ['ok', null, true, 'stop']);
  assert.deepEqual([meta.arm_sha256, meta.core_sha256, meta.protocol_sha256], [fastHashes.core, fastHashes.core, fastHashes.protocol], 'a raw-arm run is stored under the core hash');
  assert.equal(meta.key, resumeKey({ armSha: fastHashes.core, model: task.model, inputHash: kase.inputHash, arm: 'raw', rep: 1 }));
  assert.notEqual(fastHashes.core, hashes.core, 'a change to the run settings is a change to the core, as it always was');
  assert.equal(meta.attempts.length, 1);
  assert.equal(meta.attempts[0].failure, 'infra');
  assert.match(meta.attempts[0].detail, /429/);
  assert.deepEqual([meta.usd, meta.usd_source, meta.effort, meta.sheet.ok, meta.sheet.findings], [0.00123, 'omp', 'high', true, 1]);
  assert.equal(meta.checks.ok, true);
  const dir = path.join(out, 'raw', 'acme__model-1', 'fx-01-v.raw.1');
  for (const name of ['meta.json', 'events.jsonl', 'request.json', 'requests.jsonl', 'answer.md', 'sheet.json', 'stderr.txt', 'attempts/1/events.jsonl']) assert.ok(fs.existsSync(path.join(dir, name)), name);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sheet.json'), 'utf8')).findings[0].function, 'withdrawAll');
  assert.ok(listAll(dir).every((f) => !fs.readFileSync(f, 'utf8').includes(KEY)), 'the key is in no stored file');
  assert.ok(storedRun(out, fastHashes, task, []), 'the stored run is recognised and will not be run again');
  assert.equal(storedRun(out, hashes, task, []), null, 'under another core hash it is not');
}));

test('a profile-arm run is stored under the hash of its profile, and nothing is sent when the prompts are not the recorded ones', () => withFake('ok', async (ctx, out) => {
  const env = { ctx, protocol, hashes, runRoot: out, runId: 'unit', catalogue: new Map(), ompVer: 'omp/18.4.4', stop: { reason: null }, genStats: 'off' };
  const task = { model: 'acme/model-1', kase, arm: 'solidity', rep: 1 };
  const meta = await runTask(env, task, 0);
  assert.deepEqual([meta.status, meta.engine_source, meta.profile_sha256], ['ok', 'frozen', protocol.engine.profiles.solidity.system_sha256]);
  assert.deepEqual([meta.arm_sha256, meta.core_sha256], [hashes.arms.solidity, hashes.core]);
  assert.notEqual(meta.arm_sha256, hashes.core);
  assert.ok(storedRun(out, hashes, task, []));

  // the product text was frozen again while this invocation was running: protocol.json in memory records another text
  const dir = path.join(out, 'raw', 'acme__model-1', 'fx-01-v.solidity.1');
  const before = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
  const other = structuredClone(protocol);
  other.engine.profiles.solidity.system_sha256 = '0'.repeat(64);
  const calls = Number(fs.readFileSync(path.join(ctx.worker(0).home, 'fake-omp-calls'), 'utf8'));
  await assert.rejects(runTask({ ...env, protocol: other, hashes: protocolHashes(other) }, task, 0), /prompts\/frozen\/solidity\.md is not what protocol\.json records .*nothing was sent/);
  assert.equal(Number(fs.readFileSync(path.join(ctx.worker(0).home, 'fake-omp-calls'), 'utf8')), calls, 'omp was not started');
  assert.equal(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'), before, 'and the stored run was left alone');
  // the same for a prompt file of the core, on any arm
  const core = structuredClone(protocol);
  core.files['prompts/answer-sheet.md'] = '1'.repeat(64);
  await assert.rejects(runTask({ ...env, protocol: core, hashes: protocolHashes(core) }, { ...task, arm: 'raw' }, 0), /prompts\/answer-sheet\.md is not what protocol\.json records/);
  // a profile with no frozen text recorded has no hash to run under
  const none = structuredClone(protocol);
  delete none.engine.profiles.solidity;
  await assert.rejects(runTask({ ...env, protocol: none, hashes: protocolHashes(none) }, task, 0), /records no frozen text for the solidity profile/);
}));

test('nothing is sent once protocol.json on disk gives the task\'s arm another hash than this invocation runs under', () => withFake('ok', async (ctx, out) => {
  // what `run` hands to every task: the file it loaded, to be looked at again when the task starts
  const file = path.join(out, 'protocol.json');
  const write = (fn = () => {}) => { const p = structuredClone(protocol); fn(p); fs.writeFileSync(file, JSON.stringify(p)); };
  write();
  const env = { ctx, protocol, hashes, protocolFile: file, runRoot: out, runId: 'unit', catalogue: new Map(), ompVer: 'omp/18.4.4', stop: { reason: null }, genStats: 'off' };
  const task = (arm, rep) => ({ model: 'acme/model-1', kase, arm, rep });
  const calls = () => { try { return Number(fs.readFileSync(path.join(ctx.worker(0).home, 'fake-omp-calls'), 'utf8')); } catch { return 0; } };
  assert.equal((await runTask(env, task('raw', 1), 0)).status, 'ok', 'the file as it was loaded: the task runs');
  // changes that leave the hash of the task's arm alone do not stop it: an engine commit, the text of another profile
  write((p) => { p.engine.commit = 'f'.repeat(40); p.engine.dirty = false; });
  assert.equal((await runTask(env, task('raw', 2), 0)).status, 'ok');
  assert.equal((await runTask(env, task('solidity', 1), 0)).status, 'ok');
  write((p) => { p.engine.profiles.report.system_sha256 = '0'.repeat(64); });
  assert.equal((await runTask(env, task('raw', 3), 0)).status, 'ok', 'a raw-arm task goes on when a product text is recorded again');
  assert.equal((await runTask(env, task('solidity', 2), 0)).status, 'ok', 'and so does a task of another profile');
  assert.equal(calls(), 5);
  // the core was edited and its hashes recorded again (freeze --no-engine) while the batch was running
  write((p) => { p.omp.routing.data_collection = 'deny'; });
  await assert.rejects(runTask(env, task('raw', 4), 0), /protocol\.json has changed since this invocation started: the raw arm now runs under [0-9a-f]{16}, this invocation under [0-9a-f]{16}; nothing was sent for acme\/model-1 fx-01-v\.raw\.4\. Run the command again/);
  await assert.rejects(runTask(env, task('solidity', 3), 0), /the solidity arm now runs under [0-9a-f]{16}/);
  // the hash of one profile was recorded again without its frozen file having changed (a hand edit)
  write((p) => { p.engine.profiles.solidity.system_sha256 = '0'.repeat(64); });
  await assert.rejects(runTask(env, task('solidity', 3), 0), /the solidity arm now runs under [0-9a-f]{16}/);
  assert.equal((await runTask(env, task('raw', 4), 0)).status, 'ok', 'which does not concern the raw arm');
  // a file that cannot be read (half written, or gone) stops the task as well
  fs.writeFileSync(file, '{ "omp": ');
  await assert.rejects(runTask(env, task('raw', 5), 0), /the raw arm now runs under no hash \(the file cannot be read\)/);
  fs.rmSync(file);
  await assert.rejects(runTask(env, task('raw', 5), 0), /the file cannot be read/);
  assert.equal(calls(), 6, 'omp was started for the six tasks that ran, and for none of the refused ones');
  assert.equal(fs.existsSync(path.join(out, 'raw', 'acme__model-1', 'fx-01-v.raw.5')), false, 'and nothing was stored for them');
  assert.equal(fs.existsSync(path.join(out, 'raw', 'acme__model-1', 'fx-01-v.solidity.3')), false);
}));

test('run, freeze a changed product text, run again: only the runs of that profile are made again', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-refreeze-'));
  const saved = [process.env.PAYDIRT_OMP, process.env.PAYDIRT_OMP_ARGS];
  process.env.PAYDIRT_OMP = process.execPath;
  process.env.PAYDIRT_OMP_ARGS = JSON.stringify([FAKE, 'ok']);
  let ctx = null;
  try {
    // a bench directory of its own, so that a freeze can put a new product text in it
    const bench = path.join(tmp, 'bench'), runRoot = path.join(tmp, 'runs', 'r');
    for (const dir of ['prompts', 'harness']) fs.cpSync(path.join(BENCH, dir), path.join(bench, dir), { recursive: true });
    const cases = loadCases([path.join(BENCH, 'tests', 'fixtures', 'cases')]);
    const tasks = cases.flatMap((k) => protocol.arms[k.family].map((arm) => ({ model: 'acme/model-1', kase: k, arm, rep: 1 })));
    ctx = createInvocation({ benchDir: bench, protocol, key: KEY });
    const started = () => { try { return Number(fs.readFileSync(path.join(ctx.worker(0).home, 'fake-omp-calls'), 'utf8')); } catch { return 0; } };
    // what `run` does with a plan: skip what is stored under the hash of its arm, make the rest
    const invoke = async (proto) => {
      const h = protocolHashes(proto);
      const env = { ctx, protocol: proto, hashes: h, benchDir: bench, runRoot, runId: 'r', catalogue: new Map(), ompVer: 'omp/18.4.4', stop: { reason: null }, genStats: 'off' };
      const queue = tasks.filter((t) => !storedRun(runRoot, h, t, []));
      for (const t of queue) await runTask(env, t, 0);
      return queue.map((t) => runName(t.kase.id, t.arm, t.rep)).sort();
    };
    const metaFile = (name) => path.join(runRoot, 'raw', 'acme__model-1', name, 'meta.json');
    const names = tasks.map((t) => runName(t.kase.id, t.arm, t.rep)).sort();
    assert.deepEqual(names, ['fx-01-f.raw.1', 'fx-01-f.solidity.1', 'fx-01-v.raw.1', 'fx-01-v.solidity.1', 'fx-02-a.raw.1', 'fx-02-a.report.1', 'fx-02-o.raw.1', 'fx-02-o.report.1']);

    assert.deepEqual(await invoke(protocol), names, 'first invocation: every run is made');
    assert.equal(started(), 8);
    assert.deepEqual(await invoke(protocol), [], 'second invocation: every run is found');
    const stored = Object.fromEntries(names.map((n) => [n, fs.readFileSync(metaFile(n), 'utf8')]));

    // the product changes its report profile, and the freeze takes the new text and records its hash
    const { next, texts } = await freezeProtocol(protocol, {
      benchDir: bench,
      live: async (id) => ({ sent: `${frozenProfile(id, bench)}${id === 'report' ? '\n\nOne more rule for reports.' : ''}`, engine_profile: id, mode: 'bounty' }),
      engineInfo: () => ({ commit: 'c'.repeat(40), dirty: false, files: {} }),
    });
    for (const [id, sent] of Object.entries(texts)) writeFrozen(id, sent, bench);
    assert.equal(next.hashes.core, hashes.core);

    assert.deepEqual(await invoke(next), ['fx-02-a.report.1', 'fx-02-o.report.1'], 'after the freeze: the two report runs, and nothing else');
    assert.equal(started(), 10, 'two runs were bought again, not eight');
    for (const n of names.filter((x) => !x.includes('.report.'))) assert.equal(fs.readFileSync(metaFile(n), 'utf8'), stored[n], `${n} was left as it was`);
    for (const n of ['fx-02-a.report.1', 'fx-02-o.report.1']) {
      const meta = JSON.parse(fs.readFileSync(metaFile(n), 'utf8'));
      assert.deepEqual([meta.arm_sha256, meta.core_sha256, meta.profile_sha256], [next.hashes.arms.report, hashes.core, next.engine.profiles.report.system_sha256]);
      assert.notEqual(meta.arm_sha256, JSON.parse(stored[n]).arm_sha256);
      assert.ok(JSON.parse(fs.readFileSync(path.join(path.dirname(metaFile(n)), 'request.json'), 'utf8')).instructions.includes('One more rule for reports.'), 'the new text is what was sent');
    }
    assert.deepEqual(await invoke(next), [], 'and then every run is found again');

    // an invocation that was started before the freeze still holds the old protocol: it sends nothing for the changed profile
    await assert.rejects(invoke(protocol), /prompts\/frozen\/report\.md is not what protocol\.json records .*nothing was sent/);
    assert.equal(started(), 10);
    assert.equal(JSON.parse(fs.readFileSync(metaFile('fx-02-a.report.1'), 'utf8')).arm_sha256, next.hashes.arms.report, 'and the runs made after the freeze are not touched by it');
  } finally {
    ctx?.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [i, name] of ['PAYDIRT_OMP', 'PAYDIRT_OMP_ARGS'].entries()) { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }
  }
});

function listAll(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listAll(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
