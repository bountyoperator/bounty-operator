#!/usr/bin/env node
// Paydirt offline smoke: every case of a set through the real runner and the real scorer, with a
// stand-in for omp that answers from a prepared answer book. No network, no key, no spend.
//   node bench/tools/offline-smoke.mjs [--set scored|public|reserve|all] [--arms raw] [--keep] [--runs-dir <dir>]
//
// Three answer books are run, and each has a known result:
//   key     the answer the key calls right on every input          -> every pair right
//   flag    the planted location reported on both twins, and every
//           draft rejected with a quote                            -> no pair right (bites and false rejections)
//   silent  no finding anywhere, every draft approved              -> no pair right (misses and missed overclaims)
// What this proves: each case loads, its workspace is copied and jailed as in a real run, the
// routing block reaches every request and passes the check, the answer sheet is read back from the
// stored event stream, and the scorer and the answer key agree on what right and wrong look like
// for that pair. What it cannot prove: anything about a real model or a real provider (that is
// `bench.mjs selftest`, which costs under one cent).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DRAFT, loadCases, pairsOf } from '../lib/cases.mjs';
import { createInvocation } from '../lib/omp.mjs';
import { scoreInput } from '../lib/score.mjs';
import { toScoreRun } from '../lib/runs.mjs';
import { loadProtocol, pairFilter, runTask, storedRun } from '../bench.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(BENCH, 'tests', 'fixtures', 'fake-omp.mjs');
const out = (line = '') => process.stdout.write(`${line}\n`);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const F = '```';

/** The digest the stand-in computes for a workspace (see tests/fixtures/fake-omp.mjs). */
export function workspaceDigest(kase) {
  const h = crypto.createHash('sha256');
  for (const f of [...kase.workspace].sort((a, b) => (a.path < b.path ? -1 : 1))) h.update(`${f.path}\0${f.sha256}\n`);
  return h.digest('hex');
}

const sheetText = (sheet) => `Stand-in answer.\n\n${F}json\n${JSON.stringify({ findings: [], rejected: [], verdict: 'n/a', max_severity: 'unrated', ...sheet })}\n${F}\n`;
const finding = (region, severity, claim) => ({ file: region.file, function: region.functions?.[0] ?? '', line_start: region.lines[0][0], line_end: Math.min(region.lines[0][1], region.lines[0][0] + 39), severity, claim });

/** A sentence of the draft, 20 to 300 characters, taken from the given line ranges (or from anywhere). */
function quoteFrom(kase, ranges) {
  const lines = (kase.workspace.find((f) => f.path === DRAFT)?.text ?? '').split('\n');
  const pool = ranges ? ranges.flatMap(([a, b]) => lines.slice(a - 1, b)) : lines;
  const pick = pool.map((l) => l.trim()).find((l) => l.length >= 30 && l.length <= 300 && /[a-z]{4}/i.test(l)) ?? pool.map((l) => l.trim()).find((l) => l.length >= 20);
  return pick ? pick.slice(0, 300) : null;
}

/** The answer of one book for one case. */
export function answerFor(book, kase) {
  const t = kase.truth;
  if (kase.family === 'challenge') {
    if (book === 'silent') return sheetText({ verdict: 'supported', max_severity: t.report.max_severity });
    const reject = book === 'flag' || kase.variant === 'overclaimed';
    if (!reject) return sheetText({ verdict: 'supported', max_severity: t.report.max_severity });
    const quote = quoteFrom(kase, kase.variant === 'overclaimed' ? t.report.false_claims.flatMap((c) => c.draft_lines) : null);
    return sheetText({ verdict: 'overclaimed', max_severity: t.report.max_severity, rejected: quote ? [{ quote }] : [] });
  }
  if (book === 'silent') return sheetText({});
  if (kase.variant === 'vulnerable') return sheetText({ findings: t.planted.filter((p) => p.primary).map((p) => finding(p, p.severity[0], 'the planted mechanism')), max_severity: t.planted[0].severity[0] });
  return book === 'flag' ? sheetText({ findings: [finding(t.patched_region, 'high', 'the same report on the fixed twin')], max_severity: 'high' }) : sheetText({});
}

async function runBook(book, { protocol, hashes, cases, arms, runsDir }) {
  const answers = Object.fromEntries(cases.map((c) => [workspaceDigest(c), answerFor(book, c)]));
  const answersFile = path.join(runsDir, `${book}-answers.json`);
  fs.writeFileSync(answersFile, JSON.stringify(answers));
  const saved = [process.env.PAYDIRT_OMP, process.env.PAYDIRT_OMP_ARGS];
  process.env.PAYDIRT_OMP = process.execPath;
  process.env.PAYDIRT_OMP_ARGS = JSON.stringify([FAKE, 'sheet', answersFile]);
  const ctx = createInvocation({ benchDir: BENCH, protocol, key: 'sk-or-v1-OFFLINE-SMOKE-NOT-A-KEY' });
  const env = { ctx, protocol, hashes, runRoot: path.join(runsDir, book), runId: `offline-${book}`, catalogue: new Map(), ompVer: protocol.omp.version, stop: { reason: null }, genStats: 'off' };
  const model = `stand-in/${book}`;
  const tasks = cases.flatMap((kase) => protocol.arms[kase.family].filter((a) => arms.includes(a)).map((arm) => ({ model, kase, arm, rep: 1 })));
  const outcomes = [];
  const problems = [];
  try {
    const queue = [...tasks];
    const worker = async (index) => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        const meta = await runTask(env, task, index);
        const dir = path.join(env.runRoot, 'raw', model.replace(/[^A-Za-z0-9._-]+/g, '__'), `${task.kase.id}.${task.arm}.1`);
        const eventsText = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
        const outcome = scoreInput(task.kase, task.kase.truth, toScoreRun({ meta, eventsText, draft: task.kase.workspace.find((f) => f.path === DRAFT)?.text ?? null }), protocol.scoring);
        outcomes.push({ ...outcome, arm: task.arm });
        if (meta.failure) problems.push(`${task.kase.id}.${task.arm}: run failed (${meta.failure}: ${meta.failure_detail})`);
        if (meta.checks?.ok !== true) problems.push(`${task.kase.id}.${task.arm}: harness checks ${JSON.stringify(meta.checks)}`);
        if (protocol.omp.routing && meta.checks?.routing !== true) problems.push(`${task.kase.id}.${task.arm}: the routing block was not on every request`);
        // the run is stored under the hash of its arm (the core hash for the raw arm) and is found again under it
        if (meta.arm_sha256 !== hashes.arms[task.arm] || meta.core_sha256 !== hashes.core) problems.push(`${task.kase.id}.${task.arm}: stored under ${meta.arm_sha256}, not under the hash of the ${task.arm} arm`);
        if (!meta.failure && !storedRun(env.runRoot, hashes, task, [])) problems.push(`${task.kase.id}.${task.arm}: the stored run is not recognised as done`);
      }
    };
    await Promise.all(Array.from({ length: 4 }, (_, i) => worker(i)));
  } finally {
    ctx.destroy();
    for (const [i, name] of ['PAYDIRT_OMP', 'PAYDIRT_OMP_ARGS'].entries()) { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }
  }
  return { outcomes, problems, runs: tasks.length };
}

async function main() {
  const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const eq = a.indexOf('='); return eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), true]; }));
  const argv = process.argv.slice(2);
  for (const name of ['set', 'arms', 'runs-dir', 'cases-root']) { const at = argv.indexOf(`--${name}`); if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) flags[name] = argv[at + 1]; }
  const { protocol, sha, hashes } = loadProtocol();
  const roots = flags['cases-root'] ? String(flags['cases-root']).split(',').map((p) => path.resolve(p.trim())) : [path.join(BENCH, 'cases'), path.join(BENCH, 'private', 'cases')];
  const only = pairFilter(protocol, flags, 'scored');
  const cases = loadCases(roots).filter((c) => c.case && c.truth && protocol.arms[c.family] && (!only || only.has(c.pair)));
  const pairs = pairsOf(cases).filter((p) => Object.keys(p.cases).length === 2);
  if (!pairs.length) throw new Error('No complete pair selected.');
  const arms = String(flags.arms ?? protocol.scoring.headline_arm).split(',').map((a) => a.trim());
  const runsDir = flags['runs-dir'] ? path.resolve(String(flags['runs-dir'])) : fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-offline-'));
  fs.mkdirSync(runsDir, { recursive: true });
  out(`Paydirt offline smoke  protocol ${sha.slice(0, 16)}  set ${String(flags.set ?? (flags['cases-root'] ? 'all' : 'scored'))}: ${pairs.length} pairs, ${cases.length} inputs, arms ${arms.join(',')}; stand-in omp, no network`);
  out(`  hashes: ${arms.map((arm) => `${arm} ${String(hashes.arms[arm]).slice(0, 16)}`).join('  ')}`);
  let failed = 0;
  try {
    for (const book of ['key', 'flag', 'silent']) {
      const { outcomes, problems, runs } = await runBook(book, { protocol, hashes, cases, arms, runsDir });
      for (const arm of arms) {
        const byCase = new Map(outcomes.filter((o) => o.arm === arm).map((o) => [o.case, o]));
        if (!byCase.size) continue;
        const armPairs = pairs.filter((p) => protocol.arms[p.family].includes(arm));
        const expected = book === 'key' ? armPairs.length : 0;
        const right = armPairs.filter((p) => Object.values(p.cases).every((id) => byCase.get(id)?.correct === true));
        const wrongOnes = armPairs.filter((p) => !right.includes(p)).map((p) => p.pair);
        const ok = right.length === expected && !problems.length;
        if (!ok) failed++;
        out(`  ${ok ? 'PASS' : 'FAIL'}  ${book.padEnd(6)} arm ${arm.padEnd(9)} ${runs} runs  pairs right ${right.length}/${armPairs.length} (expected ${expected})${book === 'key' && wrongOnes.length ? `  wrong: ${wrongOnes.join(', ')}` : ''}${book !== 'key' && right.length ? `  right: ${right.map((p) => p.pair).join(', ')}` : ''}`);
        if (book === 'key') for (const p of armPairs.filter((x) => !right.includes(x))) for (const id of Object.values(p.cases)) { const o = byCase.get(id); if (o && !o.correct) out(`        ${id}: ${JSON.stringify({ failure: o.failure, hits: (o.hits ?? []).length, bite: o.bite, verdict: o.verdict, quote_hit: o.quote_hit })}`); }
      }
      for (const p of problems.slice(0, 12)) out(`        ${p}`);
    }
  } finally { if (!flags.keep && !flags['runs-dir']) fs.rmSync(runsDir, { recursive: true, force: true }); else out(`  runs kept in ${runsDir}`); }
  out(failed ? `offline smoke: ${failed} check(s) FAILED` : 'offline smoke: all checks passed');
  return failed ? 1 : 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().then((code) => { process.exitCode = code ?? 0; }, (error) => { process.stderr.write(`error: ${error.message}\n`); process.exitCode = 1; });
