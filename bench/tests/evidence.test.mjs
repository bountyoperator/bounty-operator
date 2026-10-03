// Synthetic records and the offline fake omp only: never calls a model provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveStoredRun, archivedRuns, priorAttemptSpend, recordedRunCost, resolveRunRoot, storedSpend } from '../lib/evidence.mjs';
import { RUN_SCHEMA, modelDir, resumeKey, runName } from '../lib/runs.mjs';
import { createInvocation } from '../lib/omp.mjs';
import { loadCases } from '../lib/cases.mjs';
import { protocolHashes } from '../lib/protocol.mjs';
import { loadProtocol, runTask, storedRun } from '../bench.mjs';
import { sweepStray } from '../tools/sweep-stray.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-evidence-'));
function cleanup(root) {
  assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}paydirt-evidence-`));
  fs.rmSync(root, { recursive: true, force: true });
}
function record(root, name, meta, events = '') {
  const dir = path.join(root, 'raw', 'acme__model', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schema: RUN_SCHEMA, model: 'acme/model', ...meta }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events);
  fs.writeFileSync(path.join(dir, 'request.json'), '{"synthetic":true}\n');
  return dir;
}

test('archiving retains the complete directory, uses distinct slots and preserves recorded budget once', () => {
  const root = temporary();
  try {
    const first = record(root, 'case.raw.1', { key: 'same', usd: 0.5, usd_all_attempts: 1.25, usd_prior_attempts: 100 });
    const binary = Buffer.from([0, 1, 255, 10]);
    fs.mkdirSync(path.join(first, 'attempts', '1'), { recursive: true });
    fs.writeFileSync(path.join(first, 'attempts', '1', 'events.jsonl'), binary);
    const initialMeta = fs.readFileSync(path.join(first, 'meta.json'));
    const kept = archiveStoredRun(root, first);
    assert.equal(fs.existsSync(first), false);
    assert.deepEqual(fs.readFileSync(path.join(kept, 'meta.json')), initialMeta);
    assert.deepEqual(fs.readFileSync(path.join(kept, 'attempts', '1', 'events.jsonl')), binary);
    assert.equal(storedSpend(root), 1.25, 'internal retries and carried prior costs are not counted again');

    const second = record(root, 'case.raw.1', { key: 'same', usd: 0.75, usd_all_attempts: 2, usd_prior_attempts: 1.25 });
    const keptAgain = archiveStoredRun(root, second);
    assert.notEqual(keptAgain, kept);
    assert.deepEqual(fs.readFileSync(path.join(kept, 'meta.json')), initialMeta, 'a later archive never overwrites earlier evidence');
    record(root, 'case.raw.1', { key: 'new', usd: 0.5 });
    assert.equal(storedSpend(root), 3.75, 'archived invocations and current record each count once');
    assert.equal(priorAttemptSpend(root, 'same'), 3.25);
    assert.equal(priorAttemptSpend(root, 'new'), 0, 'another key is not charged to the new outcome');
    assert.equal(archivedRuns(root).length, 2);
    assert.equal(recordedRunCost({ usd_all_attempts: 0, usd: 5 }), 0);
  } finally { cleanup(root); }
});

test('sweep dry-run changes nothing; apply archives provider faults and leaves real answers/failures', () => {
  const root = temporary();
  const strayEvent = JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Read this {"path":"src/A.sol"}' }] } });
  try {
    const stray = record(root, 'stray.raw.1', { key: 'stray', status: 'failed', failure: 'empty', usd_all_attempts: 1 }, strayEvent);
    const stalled = record(root, 'stalled.raw.1', { key: 'stalled', failure: 'error', failure_detail: 'OpenAI responses stream stalled while waiting for the next event', usd: 2 });
    const genuine = record(root, 'loop.raw.1', { failure: 'error', failure_detail: 'Thinking loop detected', usd: 3 });
    const answered = record(root, 'answer.raw.1', { status: 'ok', failure: null, usd: 4 }, '{}');
    const before = new Map([stray, stalled, genuine, answered].map((dir) => [dir, fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')]));
    const dry = sweepStray(root, { log: () => {} });
    assert.deepEqual([dry.seen, dry.stray.length], [4, 2]);
    assert.equal(fs.existsSync(path.join(root, 'superseded')), false);
    for (const [dir, bytes] of before) assert.equal(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'), bytes);
    const applied = sweepStray(root, { apply: true, log: () => {} });
    assert.equal(applied.stray.length, 2);
    assert.equal(fs.existsSync(stray), false);
    assert.equal(fs.existsSync(stalled), false);
    assert.equal(fs.existsSync(genuine), true);
    assert.equal(fs.existsSync(answered), true);
    for (const entry of applied.stray) assert.equal(fs.readFileSync(path.join(entry.archived, 'meta.json'), 'utf8'), before.get(entry.dir));
    assert.equal(storedSpend(root), 10, 'sweeping cannot reset the recorded run budget');
    assert.equal(priorAttemptSpend(root, 'stray'), 1, 'a retry after sweep can recover its prior spend');
    assert.equal(sweepStray(root, { apply: true, log: () => {} }).stray.length, 0);
  } finally { cleanup(root); }
});

test('archive and sweep reject paths outside the run root and linked directories', (t) => {
  const root = temporary();
  const outside = temporary();
  try {
    for (const id of ['.', '..', '../outside', 'a/b', 'a\\b', 'C:\\outside']) assert.throws(() => resolveRunRoot(root, id), /run-id/);
    assert.equal(resolveRunRoot(root, '2026-10'), path.join(fs.realpathSync(root), '2026-10'));
    const source = record(root, 'case.raw.1', { usd: 1 });
    assert.throws(() => archiveStoredRun(root, outside), /outside its root/);
    assert.throws(() => archiveStoredRun(root, path.join(root, 'raw')), /only a raw\/model\/run/);
    try { fs.symlinkSync(outside, path.join(root, 'superseded'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('directory-link check unavailable on this host'); return; } throw error; }
    assert.throws(() => archiveStoredRun(root, source), /real directories only/);
    assert.equal(fs.existsSync(source), true, 'source stays intact when the destination is invalid');
    fs.symlinkSync(outside, path.join(root, 'raw', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => sweepStray(root, { apply: true, log: () => {} }), /real directories only/);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was moved outside the intended run');
  } finally { cleanup(root); cleanup(outside); }
});

test('offline runner preserves replaced evidence and carries cost only for the matching resume key', async () => {
  const root = temporary();
  const saved = [process.env.PAYDIRT_OMP, process.env.PAYDIRT_OMP_ARGS];
  process.env.PAYDIRT_OMP = process.execPath;
  process.env.PAYDIRT_OMP_ARGS = JSON.stringify([path.join(BENCH, 'tests', 'fixtures', 'fake-omp.mjs'), 'ok']);
  const { protocol, hashes } = loadProtocol();
  const ctx = createInvocation({ benchDir: BENCH, protocol, key: 'sk-or-v1-SYNTHETIC-EVIDENCE-TEST' });
  try {
    const [kase] = loadCases([path.join(BENCH, 'tests', 'fixtures', 'cases')], { glob: 'fx-01-v' });
    const task = { model: 'acme/model', kase, arm: 'raw', rep: 1 };
    const key = resumeKey({ armSha: hashes.core, model: task.model, inputHash: kase.inputHash, arm: task.arm, rep: task.rep });
    const name = runName(kase.id, task.arm, task.rep);
    const dir = record(root, name, { key, final: false, failure: 'infra', usd: 0.5, usd_all_attempts: 1.25 });
    fs.writeFileSync(path.join(dir, 'operator-note.txt'), 'preserve me\n');
    const env = { ctx, protocol, hashes, runRoot: root, runId: 'unit', catalogue: new Map(), ompVer: 'omp/18.4.4', stop: { reason: null }, genStats: 'off' };
    const first = await runTask(env, task, 0);
    assert.deepEqual([first.usd_prior_attempts, first.usd_all_attempts], [1.25, 0.00123]);
    assert.equal(fs.readFileSync(path.join(archivedRuns(root)[0].dir, 'operator-note.txt'), 'utf8'), 'preserve me\n');
    assert.ok(storedRun(root, hashes, task, []));
    assert.equal(storedSpend(root), 1.25123);

    archiveStoredRun(root, path.join(root, 'raw', modelDir(task.model), name));
    assert.equal(storedRun(root, hashes, task, []), null, 'archived answers never suppress a retry or become scored current runs');
    const second = await runTask(env, task, 0);
    assert.equal(second.usd_prior_attempts, 1.25123, 'a removed current record recovers cost from archives');
    assert.equal(Math.round(storedSpend(root) * 1e9), 1252460000);

    const changed = structuredClone(protocol);
    changed.run.infra_retries++;
    const third = await runTask({ ...env, protocol: changed, hashes: protocolHashes(changed) }, task, 0);
    assert.equal(third.usd_prior_attempts, 0, 'an outcome under a changed key starts its own cost total');
    assert.equal(archivedRuns(root).length, 3);
    assert.equal(Math.round(storedSpend(root) * 1e9), 1253690000, 'the budget retains every old-key invocation too');
  } finally {
    ctx.destroy();
    cleanup(root);
    for (const [i, name] of ['PAYDIRT_OMP', 'PAYDIRT_OMP_ARGS'].entries()) { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }
  }
});
