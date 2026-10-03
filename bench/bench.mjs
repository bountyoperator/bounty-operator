#!/usr/bin/env node
// Paydirt: the Bounty Operator model benchmark.
//   node bench/bench.mjs <lint|plan|run|score|publish|verify|freeze|hashes|commit|selftest> [options]
// Node 22+ built-ins only. See bench/README.md for usage and bench/METHOD.md for the method.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DRAFT, caseHash, inputHash, lintCases, lintProofs, listFiles, loadCases, matchGlob, pairsOf, sha256 } from './lib/cases.mjs';
import { ENGINE_FILES, buildArm, engineCheckInputs, engineFileHashes, frozenHashes, liveProfile, profileHashes, profileRecord, writeFrozen } from './lib/arms.mjs';
import { createInvocation, describeOmp, ompVersion, runOmp } from './lib/omp.mjs';
import { extractSheet, parseEvents } from './lib/parse.mjs';
import { aggregate, aggregateInputFromPublished, modelFile, notRun, parseReleaseNotes, scoreInput, vendorOf } from './lib/score.mjs';
import { costFromTokens, fetchModels, generationStats, keyStatus, readKey } from './lib/openrouter.mjs';
import { RUN_SCHEMA, canonical, classifyRun, countsUnder, harnessChecks, modelDir, resumeKey, runName, toScoreRun } from './lib/runs.mjs';
import { findHashesBlock, hashesDrift, headlineArm, profileArmIds, protocolHashes, recordedHashes, renderHashesBlock, replaceHashesBlock, stampHashes } from './lib/protocol.mjs';
import { packTarGz, unpackTarGz } from './lib/tar.mjs';
import { budgetPlan, profileClass, workspaceBytes } from './lib/budget.mjs';

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(BENCH, '..');
const PROTOCOL_FILES = ['harness/bench-overlay.yml', 'harness/dump-ext.ts', 'harness/jail-ext.ts', 'prompts/system.txt', 'prompts/raw-task.md', 'prompts/answer-sheet.md', 'prompts/profile-bridge.md'];
const lf = (text) => String(text).replace(/\r\n?/g, '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usd = (v) => (typeof v === 'number' ? `$${v < 0.01 ? v.toFixed(5) : v.toFixed(3)}` : '-');
const out = (line = '') => process.stdout.write(`${line}\n`);
const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 16) : 'none');

// ---------------------------------------------------------------- shared helpers

function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
    else { flags[a.slice(2)] = next; i++; }
  }
  return { flags, rest };
}

// PAYDIRT_PROTOCOL: another protocol file (the offline tests use it to try other sets)
const protocolFile = () => process.env.PAYDIRT_PROTOCOL || path.join(BENCH, 'protocol.json');

/**
 * { protocol, sha, hashes }: `hashes` is { protocol, core, arms } (lib/protocol.mjs), computed
 * from the content and never read from the file's own `hashes` block. `sha` is the protocol
 * hash, the one value shown for the whole file; runs are keyed and counted by `hashes.arms`.
 */
function loadProtocol() {
  const protocol = JSON.parse(fs.readFileSync(protocolFile(), 'utf8'));
  const hashes = protocolHashes(protocol);
  return { protocol, sha: hashes.protocol, hashes };
}

const benchFileSha = (rel, benchDir = BENCH) => sha256(lf(fs.readFileSync(path.join(benchDir, rel), 'utf8')));

/** Harness and prompt files whose content no longer matches the hashes recorded in protocol.json. */
function protocolDrift(protocol) {
  return PROTOCOL_FILES.filter((rel) => { try { return protocol.files?.[rel] !== benchFileSha(rel); } catch { return true; } });
}

/** Profile arms whose prompts/frozen/<profile>.md is missing or is not the text protocol.json records: [{ id, missing }]. */
function frozenDrift(protocol, profileIds = profileArmIds(protocol)) {
  const frozen = frozenHashes(profileIds, BENCH);
  return profileIds.filter((id) => !frozen[id] || frozen[id] !== protocol.engine?.profiles?.[id]?.system_sha256).map((id) => ({ id, missing: !frozen[id] }));
}

const STALE_BLOCK = (names) => (names[0] === 'missing'
  ? 'protocol.json has no "hashes" block'
  : `protocol.json was changed after its "hashes" block was written (${names.join(', ')} ${names.length === 1 ? 'differs' : 'differ'})`);

/** "raw 0123456789abcdef (core)  solidity ..." : the hash each of the given arms runs under. */
function hashLine(protocol, hashes, arms = Object.keys(hashes.arms)) {
  const head = headlineArm(protocol);
  return arms.map((arm) => `${arm} ${short(hashes.arms[arm])}${arm === head ? ' (core)' : ''}`).join('  ');
}

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function caseRoots(flags) {
  if (flags['cases-root']) return String(flags['cases-root']).split(',').map((p) => path.resolve(p.trim()));
  return [path.join(BENCH, 'cases'), path.join(BENCH, 'private', 'cases')];
}

function selectSlugs(protocol, flags) {
  if (flags.models) return String(flags.models).split(',').map((s) => s.trim()).filter(Boolean);
  const tiers = flags.tier ? String(flags.tier).split(',').map((t) => t.trim()) : Object.keys(protocol.tiers).sort();
  return tiers.flatMap((t) => {
    if (!protocol.tiers[t]) throw new Error(`Unknown tier "${t}" (protocol.json has ${Object.keys(protocol.tiers).join(', ')})`);
    return protocol.tiers[t];
  });
}

const runsDir = (flags) => (flags['runs-dir'] ? path.resolve(String(flags['runs-dir'])) : path.join(BENCH, 'runs'));

const SET_NAMES = ['scored', 'public', 'reserve'];

/**
 * The pairs a command works on. protocol.json `sets` splits the pairs into the scored set
 * (the leaderboard), the public practice set and the reserve. `--set scored|public|reserve|all`
 * (comma-separated) picks; without it, commands that make or read leaderboard runs take
 * `fallback`. With --cases-root the sets do not apply unless --set is given: another root
 * is another collection of cases. Returns a Set of pair ids, or null for "every pair".
 */
function pairFilter(protocol, flags, fallback = 'all') {
  const name = String(flags.set ?? (flags['cases-root'] ? 'all' : fallback));
  if (!protocol.sets || name === 'all') return null;
  const wanted = name.split(',').map((s) => s.trim()).filter(Boolean);
  for (const w of wanted) if (!SET_NAMES.includes(w) || !Array.isArray(protocol.sets[w])) throw new Error(`Unknown set "${w}" (protocol.json has ${SET_NAMES.filter((s) => Array.isArray(protocol.sets[s])).join(', ')}; or "all")`);
  return new Set(wanted.flatMap((w) => protocol.sets[w]));
}

/** Loaded, usable cases of the selected set, narrowed by --cases. */
function selectCases(protocol, flags, fallback) {
  const only = pairFilter(protocol, flags, fallback);
  return loadCases(caseRoots(flags), { glob: flags.cases ?? null }).filter((c) => c.case && c.truth && protocol.arms[c.family] && (!only || only.has(c.pair)));
}

/** Profile arms run only for the models listed in protocol.run.profile_arm_models (all models when the list is absent). */
function runsArm(protocol, slug, arm) {
  if (arm === protocol.scoring.headline_arm) return true;
  const list = protocol.run?.profile_arm_models;
  return !Array.isArray(list) || list.includes(slug);
}

const tierOf = (protocol, slug) => { for (const [t, list] of Object.entries(protocol.tiers)) if (list.includes(slug)) return Number(t); return null; };

function armsOf(protocol, family, flags) {
  const wanted = flags.arms ? String(flags.arms).split(',').map((a) => a.trim()) : null;
  return (protocol.arms[family] ?? []).filter((a) => !wanted || wanted.includes(a));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJsonIf(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function printIssues(label, list) {
  if (!list.length) return;
  out(`\n${label} (${list.length})`);
  for (const i of list) out(`  ${i.scope.padEnd(12)} ${i.rule.padEnd(22)} ${i.message}`);
}

/** Load cases, keep those matching --cases, and build the model x case x arm x repeat matrix. */
async function buildPlan(protocol, flags, { offline = false } = {}) {
  const cases = selectCases(protocol, flags, 'scored');
  const slugs = selectSlugs(protocol, flags);
  const repeats = flags.repeats ? Number(flags.repeats) : protocol.run.repeats;
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a positive integer');
  let catalogue = new Map();
  const dropped = [];
  const pricesAt = new Date().toISOString();
  if (!offline) {
    catalogue = await fetchModels();
    for (const slug of slugs) if (!catalogue.has(slug)) dropped.push(slug);
  }
  const models = slugs.filter((s) => !dropped.includes(s)).map((slug) => ({ ...(catalogue.get(slug) ?? { slug, name: slug, vendor: vendorOf(slug), open_weight: false, price: { in: null, out: null } }), run_tier: tierOf(protocol, slug) }));
  const tasks = [];
  for (const model of models) for (let rep = 1; rep <= repeats; rep++) for (const kase of cases) for (const arm of armsOf(protocol, kase.family, flags)) if (flags['all-arms'] || runsArm(protocol, model.slug, arm)) tasks.push({ model: model.slug, kase, arm, rep });
  return { cases, models, dropped, repeats, tasks, pricesAt };
}

// ---------------------------------------------------------------- freeze

/**
 * What `freeze` writes, computed without writing anything: { next, texts }.
 *   next   protocol.json with the hashes of the prompt and harness files, the record of every
 *          profile arm's product text, and a fresh `hashes` block
 *   texts  { <profile>: the product text to put in prompts/frozen/<profile>.md }
 * With `engine: false` the product engine is not consulted: the `engine` block and the frozen
 * texts stay as they are and `texts` is empty. `live(id)` returns the product text of a
 * profile as lib/arms.mjs `liveProfile` does; the tests pass their own to stand for a product
 * that has changed.
 */
async function freezeProtocol(protocol, { benchDir = BENCH, engine = true, live = liveProfile, engineInfo = null } = {}) {
  const next = structuredClone(protocol);
  next.files = Object.fromEntries(PROTOCOL_FILES.map((rel) => [rel, benchFileSha(rel, benchDir)]));
  const texts = {};
  if (engine) {
    const profiles = {};
    for (const id of profileArmIds(next)) {
      let p;
      try { p = await live(id); } catch (e) { throw new Error(`the product text of the ${id} profile could not be produced (${e.message}). "freeze --no-engine" records the file hashes and the hashes block and leaves the product texts as they are.`); }
      texts[id] = p.sent;
      profiles[id] = profileRecord(p);
    }
    const info = engineInfo ? engineInfo() : { commit: git(['rev-parse', 'HEAD']), dirty: (git(['status', '--porcelain', '--', ...ENGINE_FILES]) ?? '') !== '', files: engineFileHashes(REPO) };
    next.engine = { ...info, profiles };
  }
  return { next: stampHashes(next), texts };
}

/** The lines `freeze` prints: each hash before and after, and what that means for the runs already stored. */
function freezeReport(protocol, before, after) {
  const head = headlineArm(protocol);
  const lines = [];
  const row = (name, a, b, kept, lost) => lines.push(`  ${name.padEnd(9)} ${a === b ? `${short(a)}  unchanged${kept ? `: ${kept}` : ''}` : `${short(a)} -> ${short(b)}  CHANGED${lost ? `: ${lost}` : ''}`}`);
  row('protocol', before.protocol, after.protocol, '', 'the hash of the whole file, shown with the results');
  row('core', before.core, after.core, `stored ${head}-arm runs still count`, 'no stored run counts any more, on any arm');
  for (const arm of Object.keys(after.arms)) if (arm !== head) row(arm, before.arms[arm] ?? null, after.arms[arm], `stored ${arm} runs still count`, before.core === after.core ? `stored ${arm} runs no longer count` : 'follows the core hash');
  return lines;
}

/**
 * `freeze`: record the hashes of the prompt and harness files, the product text of every
 * profile arm and the hashes block in protocol.json, and the hashes table in METHOD.md.
 *   --no-engine  leave the product texts and the engine block as they are
 *   --dry-run    write nothing; print which hashes a freeze would change now
 */
async function cmdFreeze(flags = {}) {
  const file = path.join(BENCH, 'protocol.json');
  const protocol = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dry = flags['dry-run'] === true, engine = !flags['no-engine'];
  // "before" is what the file last recorded, which is what the runs made so far were stored under
  const before = recordedHashes(protocol);
  const { next, texts } = await freezeProtocol(protocol, { engine });
  const methodFile = path.join(BENCH, 'METHOD.md');
  const method = fs.existsSync(methodFile) ? fs.readFileSync(methodFile, 'utf8') : null;
  const methodNext = method === null ? null : replaceHashesBlock(method, renderHashesBlock(next));
  if (!dry) {
    for (const [id, sent] of Object.entries(texts)) writeFrozen(id, sent, BENCH);
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    if (methodNext !== null && methodNext !== method) fs.writeFileSync(methodFile, methodNext);
  }
  out(dry ? `freeze --dry-run: nothing written. A freeze${engine ? '' : ' --no-engine'} now would do this:` : `protocol.json frozen${engine ? '' : ' (product texts left as they are)'}. protocol_sha256 = ${next.hashes.protocol}`);
  for (const line of freezeReport(next, before, next.hashes)) out(line);
  const stale = hashesDrift(protocol);
  if (stale.length) out(`  note: ${STALE_BLOCK(stale)}${stale[0] === 'missing' ? '; the left-hand hashes are those of the file as it was found' : ': the left-hand hashes are the recorded ones, under which the runs so far were made, so the lines above include the effect of that edit'}.`);
  if (engine) for (const [id, p] of Object.entries(next.engine.profiles)) out(`  profile ${id.padEnd(9)} engine id ${String(p.engine_profile).padEnd(16)} ${p.chars} chars  ${p.system_sha256.slice(0, 12)}  ${p.system_sha256 === protocol.engine?.profiles?.[id]?.system_sha256 ? 'same text' : 'NEW TEXT '}  -> prompts/frozen/${id}.md`);
  if (method !== null && methodNext === null) out('  note: METHOD.md has no hashes markers; its table was not written.');
  if (engine && next.engine.dirty) out('  note: the engine files have uncommitted changes; freeze again once they are committed (that moves the protocol hash only, as long as the texts stay the same).');
  return 0;
}

/** `hashes`: print the protocol hash, the core hash and the hash each arm runs under. Offline. */
async function cmdHashes(flags = {}) {
  const { protocol, hashes } = loadProtocol();
  // with --json too, the exit code says whether the stored block is the hash of the content
  if (flags.json) { out(JSON.stringify(hashes, null, 2)); return hashesDrift(protocol).length ? 1 : 0; }
  const head = headlineArm(protocol);
  out(`Paydirt hashes  release ${protocol.release}`);
  out(`  protocol  ${hashes.protocol}  the whole of protocol.json; shown with the results`);
  out(`  core      ${hashes.core}  what a ${head}-arm run is stored and counted under`);
  for (const arm of profileArmIds(protocol)) out(`  ${arm.padEnd(9)} ${hashes.arms[arm] ?? 'no text frozen yet'.padEnd(64)}  core + bridge + frozen ${arm} text ${short(protocol.engine?.profiles?.[arm]?.system_sha256).slice(0, 12)}`);
  const stale = hashesDrift(protocol);
  if (stale.length) { out(`  STALE: ${STALE_BLOCK(stale)}. Run "node bench/bench.mjs freeze --dry-run" to see what a freeze would change.`); return 1; }
  return 0;
}

// ---------------------------------------------------------------- lint

async function cmdLint(flags) {
  const { protocol, hashes } = loadProtocol();
  const cases = loadCases(caseRoots(flags), { glob: flags.cases ?? null });
  const drift = protocolDrift(protocol);
  const res = await lintCases(cases, { benchDir: flags['bench-dir'] ? path.resolve(flags['bench-dir']) : BENCH, checkInputs: flags['no-engine'] ? null : engineCheckInputs });
  if (drift.length) res.errors.push(...drift.map((rel) => ({ scope: 'protocol', rule: 'protocol.files', message: `${rel} differs from the hash in protocol.json (run "node bench/bench.mjs freeze")` })));
  // the frozen product texts must be the ones recorded in protocol.json; a live engine that has moved on is only a warning
  const profileIds = Object.keys(protocol.engine?.profiles ?? {});
  const frozen = frozenHashes(profileIds, BENCH);
  for (const id of profileIds) if (frozen[id] !== protocol.engine.profiles[id].system_sha256) res.errors.push({ scope: 'protocol', rule: 'protocol.frozen', message: `prompts/frozen/${id}.md is ${frozen[id] ? 'not the text recorded in protocol.json' : 'missing'} (run "node bench/bench.mjs freeze")` });
  // the hashes written down for readers (protocol.json `hashes`, the table in METHOD.md) must be the hashes of the content
  const stale = hashesDrift(protocol);
  if (stale.length) res.errors.push({ scope: 'protocol', rule: 'protocol.hashes', message: `${STALE_BLOCK(stale)}; "node bench/bench.mjs freeze --dry-run" shows which stored runs a freeze would stop counting, "freeze --no-engine" records the hashes without touching the product texts` });
  if (!process.env.PAYDIRT_PROTOCOL) {
    let method = null;
    try { method = fs.readFileSync(path.join(BENCH, 'METHOD.md'), 'utf8'); } catch { /* the method text is not shipped with every copy */ }
    if (method !== null && findHashesBlock(method) !== renderHashesBlock(protocol)) res.errors.push({ scope: 'protocol', rule: 'protocol.method', message: `the hashes table of METHOD.md is ${findHashesBlock(method) === null ? 'missing' : 'not the one protocol.json gives'} (run "node bench/bench.mjs freeze", or "freeze --no-engine")` });
  }
  if (!flags['no-engine']) {
    try {
      const live = await profileHashes(profileIds);
      const moved = profileIds.filter((id) => live[id].system_sha256 !== protocol.engine.profiles[id].system_sha256);
      if (moved.length) res.warnings.push({ scope: 'protocol', rule: 'engine.moved', message: `the product's ${moved.join(', ')} profile text has changed since the freeze; runs send the frozen text until "freeze" is run again (that changes the ${moved.join(', ')} hash${moved.length === 1 ? '' : 'es'} only: raw-arm runs and the other profiles' runs stay valid)` });
    } catch (e) { res.warnings.push({ scope: 'protocol', rule: 'engine.moved', message: `the product engine could not be loaded: ${e.message}` }); }
  }
  const pairs = pairsOf(cases);
  // the split into scored, public and reserve sets, and the published commitments, are checked on the benchmark's own roots
  if (!flags['cases-root'] && !flags.cases) for (const issue of lintSets(protocol, pairs)) res.errors.push(issue);
  if ((!flags['cases-root'] && !flags.cases) || flags.commitments) for (const issue of lintCommitments(cases, flags)) res.errors.push(issue);
  if (flags.proofs) {
    const proofs = lintProofs(cases, { benchDir: flags['bench-dir'] ? path.resolve(flags['bench-dir']) : BENCH, log: (m) => out(m) });
    res.errors.push(...proofs.errors);
    res.warnings.push(...proofs.warnings);
  }
  const byFamily = {};
  for (const p of pairs) byFamily[p.family] = (byFamily[p.family] ?? 0) + 1;
  out(`cases: ${cases.length} in ${pairs.length} pairs (${Object.entries(byFamily).map(([f, n]) => `${f} ${n}`).join(', ') || 'none'})`);
  out(`drafting vendors: ${Object.entries(pairs.reduce((m, p) => ({ ...m, [p.author]: (m[p.author] ?? 0) + 1 }), {})).map(([a, n]) => `${a} ${n}`).join(', ') || 'none'}`);
  if (protocol.sets && !flags['cases-root']) out(`sets: ${SET_NAMES.filter((s) => Array.isArray(protocol.sets[s])).map((s) => `${s} ${protocol.sets[s].length}`).join(', ')}`);
  out(`hashes: protocol ${short(hashes.protocol)}  ${hashLine(protocol, hashes)}`);
  if (!flags.quiet) printIssues('warnings', res.warnings);
  printIssues('errors', res.errors);
  out(`\nlint: ${res.errors.length} error(s), ${res.warnings.length} warning(s)${flags.proofs ? ', proofs run' : ''}`);
  return res.errors.length ? 1 : 0;
}

/**
 * protocol.json `sets` against the cases on disk: every pair is in exactly one set, the
 * public set is the pairs that are published, and the scored set keeps the family minimums
 * recorded in protocol.json `selection.minimum`. Held pairs are absent from the public
 * download, so a held pair that is not on disk is an error only where held cases exist.
 */
function lintSets(protocol, pairs) {
  const issues = [];
  const err = (scope, message) => issues.push({ scope, rule: 'sets', message });
  if (!protocol.sets) return issues;
  const where = new Map();
  for (const s of SET_NAMES) for (const id of protocol.sets[s] ?? []) {
    if (where.has(id)) err(id, `listed in two sets (${where.get(id)} and ${s})`);
    where.set(id, s);
  }
  const loaded = new Map(pairs.map((p) => [p.pair, p]));
  const haveHeld = fs.existsSync(path.join(BENCH, 'private', 'cases'));
  for (const p of pairs) {
    const s = where.get(p.pair);
    if (!s) { err(p.pair, 'the pair is in none of the sets of protocol.json (scored, public, reserve)'); continue; }
    if (s === 'public' && p.visibility !== 'public') err(p.pair, 'listed in the public set but its cases are not marked public');
    if (s !== 'public' && p.visibility === 'public') err(p.pair, `marked public but listed in the ${s} set (a public pair is practice material, not a scored or reserve pair)`);
  }
  for (const [id, s] of where) if (!loaded.has(id) && (s === 'public' || haveHeld)) err(id, `listed in the ${s} set but not found on disk`);
  const min = protocol.selection?.minimum ?? {};
  const scored = (protocol.sets.scored ?? []).map((id) => loaded.get(id)).filter(Boolean);
  if (scored.length === (protocol.sets.scored ?? []).length) {
    if (Number.isInteger(protocol.selection?.scored_pairs) && scored.length !== protocol.selection.scored_pairs) err('protocol', `the scored set has ${scored.length} pairs; protocol.json selection.scored_pairs says ${protocol.selection.scored_pairs}`);
    for (const [family, n] of Object.entries(min)) {
      const have = scored.filter((p) => p.family === family).length;
      if (have < n) err('protocol', `the scored set has ${have} ${family} pairs; the minimum is ${n}`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------- commitments

const COMMITMENTS_SCHEMA = 'paydirt.commitments/1';
const commitmentsFile = (flags = {}) => (flags.commitments ? path.resolve(String(flags.commitments)) : path.join(BENCH, 'commitments.json'));
const saltsFile = (flags) => (flags.salts ? path.resolve(String(flags.salts)) : path.join(BENCH, 'private', 'salts.json'));

/**
 * bench/commitments.json against the held cases on disk. A held case that changed after its
 * commitment was written, or that has none, is an error: run "commit", which records the
 * replaced value. Skipped where the salts are absent (the public download).
 */
function lintCommitments(cases, flags) {
  const issues = [];
  const published = readJsonIf(commitmentsFile(flags));
  const salts = readJsonIf(saltsFile(flags));
  if (!published || !salts) return issues;
  const byCase = new Map((published.commitments ?? []).map((c) => [c.case, c.sha256]));
  for (const c of cases) {
    if (!c.case || c.case.visibility === 'public') continue;
    const want = salts[c.id] ? sha256(`${salts[c.id]}:${caseHash(c)}`) : null;
    if (!byCase.has(c.id) || !want) issues.push({ scope: c.id, rule: 'commitment', message: 'a held case without a published commitment (run "node bench/bench.mjs commit")' });
    else if (byCase.get(c.id) !== want) issues.push({ scope: c.id, rule: 'commitment', message: 'the case changed after its commitment was written (run "node bench/bench.mjs commit"; the replaced value is kept in the file)' });
  }
  return issues;
}

/** `commit`: write bench/commitments.json, one salted SHA-256 per held case. Values that change are kept under "superseded". */
async function cmdCommit(flags) {
  const { protocol } = loadProtocol();
  const cases = loadCases(caseRoots(flags)).filter((c) => c.case && c.truth);
  const list = commitments(cases, flags);
  const file = commitmentsFile(flags);
  const prev = flags.fresh ? {} : readJsonIf(file) ?? {};
  const today = String(flags.date ?? new Date().toISOString().slice(0, 10));
  const before = new Map((prev.commitments ?? []).map((c) => [c.case, c]));
  const superseded = [...(prev.superseded ?? [])];
  let added = 0, changed = 0, kept = 0;
  const next = list.map((c) => {
    const old = before.get(c.case);
    if (old && old.sha256 === c.sha256) { kept++; return old; }
    if (old) { changed++; superseded.push({ ...old, replaced: today }); } else added++;
    return { case: c.case, sha256: c.sha256, committed: today };
  });
  let withdrawn = 0;
  for (const old of prev.commitments ?? []) if (!list.some((c) => c.case === old.case)) { withdrawn++; superseded.push({ ...old, replaced: today, note: 'no longer a held case' }); }
  writeJson(file, {
    schema: COMMITMENTS_SCHEMA,
    release: protocol.release,
    rule: 'sha256("<salt>:<case hash>"). The case hash is sha256 over the text "paydirt.case/1" followed, for every file of the case directory in path order, by a newline, the path, a NUL byte and the sha256 of the file. The salt of a case is published when the case is.',
    commitments: next,
    superseded,
  });
  out(`commitments: ${next.length} held cases (${kept} unchanged, ${added} new, ${changed} replaced, ${withdrawn} withdrawn) -> ${path.relative(REPO, file)}; salts in ${path.relative(REPO, saltsFile(flags))}`);
  return 0;
}

// ---------------------------------------------------------------- plan

/**
 * `plan --budget-usd X`: what one arm at one repeat is expected to cost per model, cheapest
 * first, with a running total and the point where the budget runs out. Defaults to the
 * headline arm and one repeat (the v1 run); --arms and --repeats change that.
 */
async function planBudget(protocol, hashes, flags) {
  const sha = hashes.protocol;
  const budget = Number(flags['budget-usd']);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('--budget-usd must be a positive number of US dollars');
  const est = protocol.estimate?.raw_arm;
  if (!est?.profiles?.mean) throw new Error('protocol.json has no estimate.raw_arm (the measured token profile)');
  const head = protocol.scoring.headline_arm;
  const order = String(flags.order ?? 'tier');
  if (!['tier', 'cost'].includes(order)) throw new Error('--order must be tier or cost');
  // without --arms: the headline arm for every model, plus the profile arms of the models protocol.json lists for them.
  // with --arms: exactly those arms, for every selected model.
  const explicit = flags.arms !== undefined;
  const plan = await buildPlan(protocol, { ...flags, repeats: flags.repeats ?? 1, ...(explicit ? { 'all-arms': true } : {}) });
  for (const d of plan.dropped) out(`DROPPED  ${d}: not in the OpenRouter models API today`);
  if (!plan.models.length || !plan.cases.length) throw new Error('Nothing to plan: no models or no cases selected.');
  // one entry per run of one model at repeat 1 (a case appears once per arm)
  const inputsOf = (slug, pred) => plan.tasks.filter((t) => t.model === slug && t.rep === 1 && pred(t.arm)).map((t) => t.kase);
  const inputs = inputsOf(plan.models[0].slug, (arm) => explicit || arm === head);
  const profileModels = explicit ? [] : plan.models.map((m) => m.slug).filter((slug) => inputsOf(slug, (arm) => arm !== head).length);
  const profileInputs = profileModels.length ? inputsOf(profileModels[0], (arm) => arm !== head) : [];
  const result = budgetPlan({ cases: inputs, models: plan.models, estimate: est, repeats: plan.repeats, budget, order, profile: { models: profileModels, cases: profileInputs } });
  const pairs = pairsOf(plan.cases);
  const byFamily = {};
  for (const p of pairs) byFamily[p.family] = (byFamily[p.family] ?? 0) + 1;
  const n = (v) => Math.round(v).toLocaleString('en-US');
  const money = (v) => (v === null || v === undefined ? '-' : v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : v.toFixed(0));
  const scales = inputs.map((c) => workspaceBytes(c) / est.workspace_bytes);
  const mean = est.profiles.mean;
  const hasOther = inputs.some((c) => profileClass(c) === 'any');
  const setName = String(flags.set ?? (flags['cases-root'] || !protocol.sets ? 'all' : 'scored'));
  out(`Paydirt budget plan  release ${protocol.release}  protocol ${sha.slice(0, 16)}  budget $${budget.toFixed(2)}`);
  out(`hashes: ${hashLine(protocol, hashes)}`);
  out(`set ${setName}, arm ${explicit ? String(flags.arms) : head}, ${plan.repeats} repeat${plan.repeats === 1 ? '' : 's'}: ${result.runsPerModel} runs per model (${plan.cases.length} inputs in ${pairs.length} pairs: ${Object.entries(byFamily).map(([f, c]) => `${f} ${c}`).join(', ')})`);
  if (profileModels.length) out(`profile arms (${[...new Set(Object.values(protocol.arms).flat().filter((x) => x !== head))].join(', ')}) for ${profileModels.length} models only: ${profileModels.join(', ')}; each is a second row of ${profileInputs.length * plan.repeats} runs straight after the model's ${head} row`);
  out(`order: ${order === 'tier' ? 'run tier 1, then 2, then 3; cheapest model first inside a tier' : 'cheapest model first'}`);
  out('token profile per run, measured in the pilot on the raw arm:');
  out(`  twin with the planted bug   ${n(mean.with_bug.input).padStart(7)} fresh + ${n(mean.with_bug.cached).padStart(7)} cached input, ${n(mean.with_bug.output).padStart(7)} output`);
  out(`  clean (fixed) twin          ${n(mean.clean.input).padStart(7)} fresh + ${n(mean.clean.cached).padStart(7)} cached input, ${n(mean.clean.output).padStart(7)} output`);
  if (hasOther) out(`  challenge draft             ${n(mean.any.input).padStart(7)} fresh + ${n(mean.any.cached).padStart(7)} cached input, ${n(mean.any.output).padStart(7)} output   (not measured: the mean of both twins)`);
  out(`  input is scaled by workspace size over the pilot's mean (${n(est.workspace_bytes)} bytes; this set runs from ${Math.min(...scales).toFixed(2)}x to ${Math.max(...scales).toFixed(2)}x); output is not scaled`);
  out(`  low and high are the same sum with the profile of each pilot model alone (${est.profiles.low?.model ?? '-'}, ${est.profiles.high?.model ?? '-'})`);
  out('');
  out(`${'#'.padStart(3)}  ${'tier'.padEnd(5)}${'model'.padEnd(38)}${'arm'.padEnd(9)}${'runs'.padStart(4)}  ${'$/M in / cached / out'.padEnd(24)}${'est $'.padStart(8)}${'low $'.padStart(8)}${'high $'.padStart(8)}${'running $'.padStart(11)}`);
  const lineText = () => {
    const nextRow = result.rows[result.line];
    return `     ---- budget $${budget.toFixed(2)} falls here: ${result.fit} of ${result.rows.length} rows fit for $${money(result.fit_usd)} (high: $${money(result.fit_high_usd)})${nextRow?.usd !== null && nextRow ? `; ${nextRow.slug}${nextRow.arm === 'profile' ? ' (profile arms)' : ''} would bring the total to $${money(nextRow.running)}` : ''} ----`;
  };
  result.rows.forEach((row, i) => {
    if (i === result.line) out(lineText());
    const price = row.price?.in === null || row.price?.in === undefined ? 'no price listed' : `${row.price.in} / ${row.price.cache_read ?? row.price.in} / ${row.price.out}`;
    out(`${String(i + 1).padStart(3)}  ${String(row.tier ?? '-').padEnd(5)}${row.slug.padEnd(38)}${(row.arm === 'profile' ? 'profile' : explicit ? String(flags.arms).slice(0, 8) : head).padEnd(9)}${String(row.runs).padStart(4)}  ${price.padEnd(24)}${money(row.usd).padStart(8)}${money(row.low).padStart(8)}${money(row.high).padStart(8)}${money(row.usd === null ? null : row.running).padStart(11)}`);
  });
  if (result.line === result.rows.length) out(`     ---- budget $${budget.toFixed(2)}: all ${result.rows.length} rows fit for $${money(result.total)} (high: $${money(result.fit_high_usd)}); $${money(budget - result.total)} is left ----`);
  out('');
  out(`all ${result.rows.length} rows: $${money(result.total)}; ${result.rows.reduce((s, r) => s + r.runs, 0)} runs`);
  out('Prices are today\'s OpenRouter list prices; cached input is priced at the cache-read rate where one is listed.');
  out('The profile comes from two cheap models at maximum effort. A model that reasons more or less than they do will cost more or less than its row; use --max-usd on "run" as the real limit.');
  if (flags.json) {
    const target = path.resolve(String(flags.json));
    writeJson(target, { protocol_sha256: sha, hashes, prices_at: plan.pricesAt, budget, order, set: setName, repeats: plan.repeats, headline_arm: head, pairs: pairs.length, inputs: inputs.length, profile_inputs: profileInputs.length, dropped: plan.dropped, line: result.line, fit: result.fit, fit_usd: result.fit_usd, fit_high_usd: result.fit_high_usd, total: result.total, rows: result.rows });
    out(`wrote ${path.relative(REPO, target)}`);
  }
  return 0;
}

async function cmdPlan(flags) {
  const { protocol, sha, hashes } = loadProtocol();
  if (flags['budget-usd'] !== undefined) return planBudget(protocol, hashes, flags);
  const plan = await buildPlan(protocol, flags);
  out(`Paydirt plan  release ${protocol.release}  protocol ${sha.slice(0, 16)}`);
  out(`hashes: ${hashLine(protocol, hashes)}`);
  for (const d of plan.dropped) out(`DROPPED  ${d}: not in the OpenRouter models API today`);
  const pairs = pairsOf(plan.cases);
  out(`cases: ${plan.cases.length} inputs in ${pairs.length} pairs; repeats: ${plan.repeats}; arms: ${Object.entries(protocol.arms).map(([f, a]) => `${f}=${armsOf(protocol, f, flags).join('+') || '-'}`).join(' ')}`);
  const perModel = plan.models.length ? plan.tasks.length / plan.models.length : 0;
  const est = protocol.estimate;
  let total = 0;
  out('');
  out(`${'tier'.padEnd(5)}${'model'.padEnd(40)}${'in/out $ per M'.padEnd(18)}${'efforts offered'.padEnd(34)}${'runs'.padEnd(7)}rough $`);
  for (const m of plan.models) {
    const cached = est.cached_input_tokens_per_run ?? 0;
    const cost = m.price.in !== null ? (perModel * (est.input_tokens_per_run * m.price.in + cached * (m.price.cache_read ?? m.price.in) + est.output_tokens_per_run * m.price.out)) / 1e6 : null;
    total += cost ?? 0;
    out(`${String(m.run_tier ?? '-').padEnd(5)}${m.slug.padEnd(40)}${`${m.price.in} / ${m.price.out}`.padEnd(18)}${String((m.supported_efforts ?? []).join(',') || 'not listed').padEnd(34)}${String(perModel).padEnd(7)}${cost === null ? '-' : cost.toFixed(2)}${m.supports_tools === false ? '  (catalogue lists no tool support)' : ''}`);
  }
  out('');
  out(`estimated runs: ${plan.tasks.length} (${plan.models.length} models x ${perModel} runs)`);
  out(`rough cost: $${total.toFixed(2)} at ${est.input_tokens_per_run} fresh input + ${est.cached_input_tokens_per_run ?? 0} cached input + ${est.output_tokens_per_run} output tokens per run (${est.source ?? 'an assumption; the pilot replaces it'})`);
  try {
    const ctx = createInvocation({ benchDir: BENCH, protocol });
    let version;
    try { version = ompVersion(ctx); } finally { ctx.destroy(); }
    out(`omp: ${version}${version === protocol.omp.version ? '' : `  MISMATCH: protocol.json pins ${protocol.omp.version}`}; ${describeOmp(ctx.omp)}; work root ${ctx.root}`);
  } catch (e) { out(`omp: ${e.message}`); }
  const drift = protocolDrift(protocol);
  if (drift.length) out(`protocol drift: ${drift.join(', ')} (run "node bench/bench.mjs freeze")`);
  const stale = hashesDrift(protocol);
  if (stale.length) out(`protocol drift: ${STALE_BLOCK(stale)} (run "node bench/bench.mjs freeze --dry-run" to see what a freeze would change)`);
  if (flags['run-id']) {
    const file = path.join(runsDir(flags), String(flags['run-id']), 'plan.json');
    const prev = readJsonIf(file) ?? {};
    writeJson(file, { ...prev, protocol_sha256: sha, hashes, prices_at: plan.pricesAt, harness_commit: git(['rev-parse', 'HEAD']), dropped: [...new Set([...(prev.dropped ?? []), ...plan.dropped])], models: { ...(prev.models ?? {}), ...Object.fromEntries(plan.models.map((m) => [m.slug, m])) } });
    out(`wrote ${path.relative(REPO, file)}`);
  }
  return 0;
}

// ---------------------------------------------------------------- run

function costOf(ev, price) {
  if (ev.costReported !== null) return { usd: ev.costReported, source: 'omp' };
  const tokens = ev.usage.input + ev.usage.output + ev.usage.cacheRead + ev.usage.cacheWrite;
  if (tokens > 0) { const c = costFromTokens(ev.usage, price); if (c !== null) return { usd: c, source: 'computed' }; }
  return { usd: tokens > 0 ? null : 0, source: null };
}

/**
 * The prompt files and the product text an arm was built from, against protocol.json: the
 * names of those that are not the ones it records. The hash a run is stored under stands for
 * exactly these, so a run whose prompts differ must not be made under it. They are read when
 * a task starts, which may be hours after the invocation loaded protocol.json; a freeze by
 * someone else in that time shows up here.
 */
function promptDrift(protocol, arm) {
  const names = Object.entries(arm.sources ?? {}).filter(([rel, sha]) => protocol.files?.[rel] !== sha).map(([rel]) => rel);
  if (arm.arm !== headlineArm(protocol) && arm.profile_sha256 !== protocol.engine?.profiles?.[arm.arm]?.system_sha256) names.push(arm.engine_source === 'live' ? `the product's ${arm.arm} text (no frozen file)` : `prompts/frozen/${arm.arm}.md`);
  return names;
}

/**
 * The hash an arm has in protocol.json as the file is now, or null when the file cannot be read.
 * It is read a second time after a moment before that is concluded: `freeze` may be writing it.
 */
async function armHashOnDisk(file, arm) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return protocolHashes(JSON.parse(fs.readFileSync(file, 'utf8'))).arms[arm] ?? null; } catch { if (attempt === 0) await sleep(300); }
  }
  return null;
}

/** Execute one task (with infrastructure retries) and write its run directory. Returns the meta record. */
async function runTask(env, task, workerIndex) {
  const { ctx, protocol, runRoot, runId, catalogue, ompVer } = env;
  const hashes = env.hashes ?? protocolHashes(protocol);
  const armSha = hashes.arms[task.arm];
  if (!armSha) throw new Error(`protocol.json records no frozen text for the ${task.arm} profile, so a ${task.arm} run has no hash to be stored under (run "node bench/bench.mjs freeze")`);
  const dir = path.join(runRoot, 'raw', modelDir(task.model), runName(task.kase.id, task.arm, task.rep));
  // env.benchDir: where the prompt files are read from (the tests freeze a product text in a copy)
  const arm = await buildArm(task.arm, task.kase, { benchDir: env.benchDir ?? BENCH, headline: headlineArm(protocol) });
  const changed = promptDrift(protocol, arm);
  if (changed.length) throw new Error(`${changed.join(', ')} ${changed.length === 1 ? 'is' : 'are'} not what protocol.json records (changed since this invocation started, or never frozen); nothing was sent for ${task.model} ${runName(task.kase.id, task.arm, task.rep)}. Run the command again: it reloads protocol.json`);
  // protocol.json itself may have been edited, or its hashes recorded again, since this invocation loaded it
  // (env.protocolFile: set by `run`). A run made now under a hash its arm no longer has would be paid for and
  // never counted, so nothing is sent. A change that leaves the hash of this arm alone does not stop the task.
  if (env.protocolFile) {
    const now = await armHashOnDisk(env.protocolFile, task.arm);
    if (now !== armSha) throw new Error(`protocol.json has changed since this invocation started: the ${task.arm} arm now runs under ${now ? short(now) : 'no hash (the file cannot be read)'}, this invocation under ${short(armSha)}; nothing was sent for ${task.model} ${runName(task.kase.id, task.arm, task.rep)}. Run the command again: it reloads protocol.json`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const attempts = [];
  let last = null, spent = 0;
  for (let attempt = 0; ; attempt++) {
    const nonce = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const res = await runOmp(ctx, workerIndex, { model: task.model, system: arm.system, task: task.taskOverride ?? arm.task, files: task.kase.workspace, outDir: dir, nonce, prepare: task.prepare ?? null });
    const eventsText = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    const stderr = fs.readFileSync(path.join(dir, 'stderr.txt'), 'utf8');
    const ev = parseEvents(eventsText);
    const checks = harnessChecks({ ev, requests: res.requests, expected: { tools: protocol.omp.tools, model: task.model, provider: protocol.omp.provider, system: arm.system, nonce, cwd: res.cwd, routing: protocol.omp.routing ?? null } });
    const verdict = classifyRun({ res, ev, checks, stderr });
    const cost = costOf(ev, catalogue.get(task.model)?.price);
    spent += cost.usd ?? 0;
    last = { res, ev, checks, verdict, cost, nonce, startedAt };
    if (!verdict.retry || attempt >= protocol.run.infra_retries || env.stop.reason || (env.noLaunchAfter && Date.now() > env.noLaunchAfter)) break;
    attempts.push({ failure: verdict.failure, detail: verdict.detail, wall_s: Math.round(res.wallMs / 100) / 10, usd: cost.usd });
    const keep = path.join(dir, 'attempts', String(attempt + 1));
    fs.mkdirSync(keep, { recursive: true });
    for (const name of ['events.jsonl', 'stderr.txt', 'request.json', 'requests.jsonl']) { try { fs.renameSync(path.join(dir, name), path.join(keep, name)); } catch { /* not produced */ } }
    await sleep((protocol.run.retry_backoff_seconds[attempt] ?? 30) * 1000);
  }
  const { res, ev, checks, verdict, cost, nonce, startedAt } = last;
  const sheet = verdict.status === 'ok' ? extractSheet(ev.finalText) : null;
  const failure = verdict.failure ?? (sheet.ok ? null : sheet.reason === 'empty' ? 'empty' : 'unparseable');
  let providers = [], cacheHit = false;
  if (env.genStats !== 'off' && ev.responseIds.length) {
    const ids = env.genStats === 'all' ? [...new Set(ev.responseIds)] : [...new Set([ev.responseIds[0], ev.responseIds.at(-1)])];
    const stats = (await Promise.all(ids.map((id) => generationStats(ctx.key, id)))).filter(Boolean);
    providers = [...new Set(stats.map((s) => s.provider).filter(Boolean))];
    cacheHit = stats.some((s) => s.cache_source);
  }
  const toolCounts = {};
  for (const t of ev.tools) toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
  const meta = {
    schema: RUN_SCHEMA,
    key: resumeKey({ armSha, model: task.model, inputHash: task.kase.inputHash, arm: task.arm, rep: task.rep }),
    // arm_sha256 is the hash this run is resumed and counted under (the core hash for the raw arm, the
    // profile's own hash for a profile arm); protocol_sha256 names the whole protocol.json it ran under
    run_id: runId, arm_sha256: armSha, core_sha256: hashes.core, protocol_sha256: hashes.protocol, omp_version: ompVer,
    model: task.model, case: task.kase.id, pair: task.kase.pair, family: task.kase.family, arm: task.arm, rep: task.rep,
    input_hash: task.kase.inputHash, system_sha256: arm.system_sha256, task_sha256: arm.task_sha256, engine_profile: arm.engine_profile, engine_source: arm.engine_source, profile_sha256: arm.profile_sha256, nonce,
    started_at: startedAt, finished_at: new Date().toISOString(), wall_s: Math.round(res.wallMs / 100) / 10,
    exit_code: res.exitCode, timed_out: res.timedOut,
    status: failure ? 'failed' : 'ok', failure, failure_detail: verdict.detail ?? (failure ? `answer sheet: ${sheet?.reason}` : null), final: verdict.final,
    stop_reason: ev.stopReason, turns: ev.assistant.length, tool_calls: toolCounts, tools_blocked: ev.tools.filter((t) => t.blocked).length,
    usage: ev.usage, usd: cost.usd, usd_source: cost.source, usd_all_attempts: Math.round(spent * 1e9) / 1e9,
    effort: res.requests.efforts.length === 1 ? res.requests.efforts[0] : res.requests.efforts.length ? res.requests.efforts.join('+') : null,
    thinking_requested: protocol.omp.thinking, wire: res.requests.summaries[0]?.wire ?? null, routing: res.requests.routing,
    providers, response_cache_hit: cacheHit, checks, attempts,
    events: { kept: ev.events, dropped: res.dropped, unparsed: res.badLines },
    sheet: sheet ? { ok: sheet.ok, reason: sheet.reason ?? null, source: sheet.source ?? null, repaired: sheet.repaired ?? false, findings: sheet.ok ? sheet.sheet.findings.length : 0 } : null,
    halt: verdict.halt,
  };
  fs.writeFileSync(path.join(dir, 'answer.md'), ev.finalText ?? '');
  fs.writeFileSync(path.join(dir, 'sheet.json'), `${JSON.stringify(sheet?.ok ? sheet.sheet : null, null, 2)}\n`);
  writeJson(path.join(dir, 'meta.json'), meta);
  return meta;
}

/**
 * Is there a stored run for this task that must not be run again? `hashes` is
 * { arms: { <arm>: hash } } (loadProtocol): the key is made with the hash of the task's arm,
 * so a raw-arm run stays stored when a profile text is frozen again.
 */
function storedRun(runRoot, hashes, task, redo) {
  const armSha = hashes?.arms?.[task.arm];
  if (!armSha) return null;
  const meta = readJsonIf(path.join(runRoot, 'raw', modelDir(task.model), runName(task.kase.id, task.arm, task.rep), 'meta.json'));
  if (!meta || meta.final !== true) return null;
  if (meta.key !== resumeKey({ armSha, model: task.model, inputHash: task.kase.inputHash, arm: task.arm, rep: task.rep })) return null;
  if (meta.failure && redo.includes(meta.failure)) return null;
  return meta;
}

/**
 * Finished headline-arm runs under a run id that were made under another core hash. The core
 * hash covers everything but the product texts, so freezing a profile again never causes
 * this: protocol.json or a prompt or harness file changed between two invocations.
 */
function otherCoreRuns(runRoot, protocol, hashes) {
  const head = headlineArm(protocol);
  return collectMetas(runRoot).filter(({ meta }) => meta.final === true && meta.arm === head && meta.arm_sha256 !== hashes.core);
}

/** A finished stored run of this task, on the same case files, that was made under another hash than its arm has now (else null). */
function supersededRun(runRoot, hashes, task) {
  const meta = readJsonIf(path.join(runRoot, 'raw', modelDir(task.model), runName(task.kase.id, task.arm, task.rep), 'meta.json'));
  return meta && meta.final === true && meta.input_hash === task.kase.inputHash && !countsUnder(meta, hashes) ? meta : null;
}

async function cmdRun(flags) {
  const { protocol, sha, hashes } = loadProtocol();
  const head = headlineArm(protocol);
  const runId = String(flags['run-id'] ?? protocol.release);
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('--run-id may contain letters, digits, dot, dash and underscore only');
  const runRoot = path.join(runsDir(flags), runId);
  const drift = protocolDrift(protocol);
  if (drift.length) throw new Error(`protocol.json does not match: ${drift.join(', ')}. Run "node bench/bench.mjs freeze" after a deliberate change.`);
  const staleBlock = hashesDrift(protocol);
  if (staleBlock.length) throw new Error(`${STALE_BLOCK(staleBlock)}. An edit to protocol.json can change the hashes stored runs are counted under: "node bench/bench.mjs freeze --dry-run" shows which would change, "freeze --no-engine" records them without touching the product texts.`);
  // a raw-arm run already stored under another core hash means the core moved between two invocations
  const lost = otherCoreRuns(runRoot, protocol, hashes);
  if (lost.length) {
    const under = [...new Set(lost.map(({ meta }) => (typeof meta.arm_sha256 === 'string' ? short(meta.arm_sha256) : 'no arm hash: stored before the hashes were split')))].join(', ');
    const text = `${runRoot} holds ${lost.length} finished ${head}-arm run${lost.length === 1 ? '' : 's'} made under another core hash (${under}); the core hash is now ${short(hashes.core)}. They are not counted any more, and runs made now would not share a hash with them. Freezing the product profiles again never moves the core hash, so protocol.json or a prompt or harness file changed`;
    if (!flags['allow-core-change'] && !flags['dry-run']) throw new Error(`${text}. Restore it, or pass --allow-core-change to go on under the new core hash (the runs stored under the old one are made again when their command is repeated).`);
    out(`note: ${text}.`);
  }

  const plan = await buildPlan(protocol, flags);
  for (const d of plan.dropped) out(`DROPPED  ${d}: not in the OpenRouter models API today`);
  if (!plan.models.length || !plan.cases.length) throw new Error('Nothing to run: no models or no cases selected.');

  if (!flags['no-lint']) {
    // lint whole pairs (a twin is checked against its sibling), then keep what concerns the selection
    const lint = await lintCases(loadCases(caseRoots(flags)), { benchDir: flags['bench-dir'] ? path.resolve(flags['bench-dir']) : BENCH, checkInputs: null });
    const scopes = new Set(plan.cases.flatMap((c) => [c.id, c.pair]));
    const relevant = lint.errors.filter((e) => scopes.has(e.scope));
    if (relevant.length) { printIssues('lint errors', relevant); throw new Error('The selected cases do not pass lint; fix them or pass --no-lint.'); }
  }
  // profile arms send the product text frozen in prompts/frozen/, which must be the text recorded in protocol.json
  const profileIds = [...new Set(plan.tasks.map((t) => t.arm).filter((a) => a !== head))];
  if (profileIds.length) {
    const frozen = frozenHashes(profileIds, BENCH);
    for (const { id, missing } of frozenDrift(protocol, profileIds)) throw new Error(`prompts/frozen/${id}.md is ${missing ? 'missing' : 'not the text recorded in protocol.json'}. Run "node bench/bench.mjs freeze" (this changes the ${id} hash: stored ${id} runs are no longer counted, every other arm is untouched), or pass --arms ${head}.`);
    let live = {};
    try { live = await profileHashes(profileIds); } catch (e) { out(`note: the product engine could not be loaded (${e.message}); profile arms use the frozen text.`); }
    const moved = profileIds.filter((id) => live[id] && live[id].system_sha256 !== frozen[id]);
    if (moved.length) out(`note: the product's ${moved.join(', ')} profile text has changed since the freeze; this run sends the frozen text. Run "freeze" to benchmark the new text: that changes the ${moved.join(', ')} hash${moved.length === 1 ? '' : 'es'} only, so ${head}-arm runs and the other profiles' runs stay valid.`);
  }

  const key = readKey(REPO);
  const ctx = createInvocation({ benchDir: BENCH, protocol, key });
  const env = { ctx, protocol, hashes, protocolFile: protocolFile(), runRoot, runId, catalogue: new Map(plan.models.map((m) => [m.slug, m])), ompVer: null, stop: { reason: null }, genStats: flags['gen-stats'] ? String(flags['gen-stats']) : protocol.run.generation_stats };
  let exitCode = 0;
  const onSignal = () => { env.stop.reason = 'interrupted'; ctx.killAll(); ctx.destroy(); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    env.ompVer = ompVersion(ctx);
    if (env.ompVer !== protocol.omp.version) throw new Error(`omp is ${env.ompVer} but protocol.json pins ${protocol.omp.version}. Refusing to run.`);

    const planFile = path.join(runRoot, 'plan.json');
    const prev = readJsonIf(planFile) ?? {};
    writeJson(planFile, { ...prev, run_id: runId, protocol_sha256: sha, hashes, prices_at: plan.pricesAt, harness_commit: git(['rev-parse', 'HEAD']), omp_version: env.ompVer, work_root: ctx.root, dropped: [...new Set([...(prev.dropped ?? []), ...plan.dropped])], models: { ...(prev.models ?? {}), ...Object.fromEntries(plan.models.map((m) => [m.slug, m])) } });

    // keep the protocol and the frozen product texts this invocation runs under next to its runs. The
    // folder is named by the protocol hash (a run's meta.json carries it), so every freeze gets its own.
    const kept = path.join(runRoot, 'protocols', sha.slice(0, 16));
    if (!fs.existsSync(path.join(kept, 'protocol.json'))) writeJson(path.join(kept, 'protocol.json'), protocol);
    for (const rel of [...PROTOCOL_FILES.filter((r) => r.startsWith('prompts/')), ...profileIds.map((id) => `prompts/frozen/${id}.md`)]) {
      if (fs.existsSync(path.join(kept, rel))) continue; // an earlier invocation under this protocol hash kept it
      try { fs.mkdirSync(path.dirname(path.join(kept, rel)), { recursive: true }); fs.copyFileSync(path.join(BENCH, rel), path.join(kept, rel)); } catch { /* not present */ }
    }

    const redo = flags.redo ? String(flags.redo).split(',').map((s) => s.trim()) : [];
    const queue = plan.tasks.filter((t) => !storedRun(runRoot, hashes, t, redo));
    const skipped = plan.tasks.length - queue.length;
    // stored runs of this plan that a new hash has put aside: said out loud, because they are bought again
    const again = {};
    for (const t of queue) if (supersededRun(runRoot, hashes, t)) again[t.arm] = (again[t.arm] ?? 0) + 1;
    const concurrency = Math.max(1, Number(flags.concurrency ?? protocol.run.concurrency));
    const perModel = Math.max(1, Number(flags['per-model'] ?? protocol.run.per_model_concurrency));
    const stagger = Number(flags['stagger-ms'] ?? protocol.run.stagger_ms);
    const maxUsd = flags['max-usd'] !== undefined ? Number(flags['max-usd']) : Infinity;
    const floor = Number(flags['floor-usd'] ?? protocol.run.key_floor_usd);
    // --run-budget-usd: a ceiling on everything stored under this run id, earlier invocations included
    const runBudget = flags['run-budget-usd'] !== undefined ? Number(flags['run-budget-usd']) : Infinity;
    if (Number.isNaN(maxUsd) || Number.isNaN(runBudget)) throw new Error('--max-usd and --run-budget-usd must be numbers');
    const spentBefore = collectMetas(runRoot).reduce((s, { meta }) => s + (typeof meta.usd_all_attempts === 'number' ? meta.usd_all_attempts : typeof meta.usd === 'number' ? meta.usd : 0), 0);
    // --max-minutes: the invocation must end inside this window. A run started now may take the
    // whole time limit plus the hard-kill grace, so no run (and no retry) starts later than that
    // before the end; what is left is picked up by the next invocation of the same command.
    const maxMinutes = flags['max-minutes'] !== undefined ? Number(flags['max-minutes']) : Infinity;
    const runLimitMs = (protocol.omp.max_time_minutes * 60 + protocol.omp.hard_kill_grace_seconds + 120) * 1000;
    const startedMs = Date.now();
    if (!(maxMinutes > 0)) throw new Error('--max-minutes must be a positive number');
    if (maxMinutes !== Infinity && maxMinutes * 60000 <= runLimitMs) throw new Error(`--max-minutes ${maxMinutes} is shorter than one run may take (${Math.ceil(runLimitMs / 60000)} minutes)`);
    env.noLaunchAfter = maxMinutes === Infinity ? null : startedMs + maxMinutes * 60000 - runLimitMs;
    out(`Paydirt run ${runId}  protocol ${sha.slice(0, 16)}  ${env.ompVer}  work root ${ctx.root}`);
    const planned = new Set(plan.tasks.map((t) => t.arm));
    out(`hashes: ${hashLine(protocol, hashes, Object.keys(hashes.arms).filter((arm) => planned.has(arm)))}`);
    out(`omp: ${describeOmp(ctx.omp)}`);
    out(`${plan.tasks.length} runs planned, ${skipped} already stored, ${queue.length} to do; concurrency ${concurrency} (${perModel} per model); max-usd ${maxUsd === Infinity ? 'none' : maxUsd}; key floor $${floor}`);
    for (const [arm, n] of Object.entries(again)) out(`note: ${n} stored ${arm} run${n === 1 ? ' was' : 's were'} made under another ${arm === head ? 'core' : arm} hash${arm === head ? '' : ' (the profile text was frozen again since)'}; ${n === 1 ? 'it is' : 'they are'} made again and replaced.`);
    if (runBudget !== Infinity) out(`run budget $${runBudget}: $${spentBefore.toFixed(2)} already stored under ${runId}, $${Math.max(0, runBudget - spentBefore).toFixed(2)} left`);
    if (maxMinutes !== Infinity) out(`time window ${maxMinutes} min: no run starts after minute ${((env.noLaunchAfter - startedMs) / 60000).toFixed(0)}`);
    if (flags['dry-run']) { for (const t of queue.slice(0, 40)) out(`  ${t.model}  ${runName(t.kase.id, t.arm, t.rep)}`); if (queue.length > 40) out(`  ... ${queue.length - 40} more`); return 0; }

    const spend = new Map(), counts = new Map(), failures = new Map(), halted = new Set();
    const inflight = new Map(), lastLaunch = new Map(), active = new Map(), streak = new Map();
    const freeWorkers = Array.from({ length: concurrency }, (_, i) => i);
    let done = 0, total = 0, lastBudgetCheck = 0, launched = 0;
    // what the runs in flight are expected to add: the mean cost per run of each model so far in this
    // invocation, or the planner's high estimate while a model has no finished run yet
    const estRun = new Map();
    try {
      const inputs = [...new Set(plan.tasks.map((t) => t.kase))];
      if (protocol.estimate?.raw_arm && inputs.length) for (const row of budgetPlan({ cases: inputs, models: plan.models, estimate: protocol.estimate.raw_arm, repeats: 1, budget: Infinity }).rows) if (typeof row.high === 'number') estRun.set(row.slug, row.high / inputs.length);
    } catch { /* no estimate: the observed mean alone */ }
    const reserve = () => {
      let r = 0;
      for (const [m, n] of active) if (n > 0) r += n * (counts.get(m) ? spend.get(m) / counts.get(m) : estRun.get(m) ?? (done ? total / done : 0));
      return r;
    };
    const budgetOk = async () => {
      if (env.noLaunchAfter && Date.now() > env.noLaunchAfter) { env.stop.reason = `time window: a run started now could not finish inside --max-minutes ${maxMinutes}`; return false; }
      if (total + reserve() >= maxUsd) { env.stop.reason = `--max-usd ${maxUsd} reached (spent ${usd(total)}, ${usd(reserve())} expected from runs in flight)`; return false; }
      if (spentBefore + total + reserve() >= runBudget) { env.stop.reason = `--run-budget-usd ${runBudget} reached (${usd(spentBefore + total)} stored under ${runId}, ${usd(reserve())} expected from runs in flight)`; return false; }
      if (Date.now() - lastBudgetCheck < 20000 && launched % concurrency !== 0) return true;
      lastBudgetCheck = Date.now();
      try {
        const k = await keyStatus(key);
        if (k.limit_remaining !== null && k.limit_remaining < floor) { env.stop.reason = `key limit: $${k.limit_remaining.toFixed(2)} remaining is below the $${floor} floor`; return false; }
      } catch (e) { out(`  (key status unavailable: ${e.message})`); }
      return true;
    };
    while ((queue.length || inflight.size) && !(env.stop.reason && !inflight.size)) {
      let started = false;
      if (!env.stop.reason && freeWorkers.length && queue.length) {
        const now = Date.now();
        const at = queue.findIndex((t) => !halted.has(t.model) && (active.get(t.model) ?? 0) < perModel && now - (lastLaunch.get(t.model) ?? 0) >= stagger);
        if (at >= 0 && (await budgetOk())) {
          const task = queue.splice(at, 1)[0];
          const worker = freeWorkers.shift();
          launched++;
          lastLaunch.set(task.model, Date.now());
          active.set(task.model, (active.get(task.model) ?? 0) + 1);
          const id = `${task.model}|${runName(task.kase.id, task.arm, task.rep)}`;
          started = true;
          inflight.set(id, runTask(env, task, worker).then((meta) => ({ id, task, worker, meta }), (error) => ({ id, task, worker, error })));
        } else if (at < 0 && !inflight.size && queue.every((t) => halted.has(t.model))) break;
      }
      if (started) continue;
      if (!inflight.size) { await sleep(200); continue; }
      const finished = await Promise.race([...inflight.values(), sleep(500).then(() => null)]);
      if (!finished) continue;
      inflight.delete(finished.id);
      freeWorkers.push(finished.worker);
      active.set(finished.task.model, active.get(finished.task.model) - 1);
      done++;
      const { task, meta, error } = finished;
      if (error) { out(`[${done}] ${task.model} ${runName(task.kase.id, task.arm, task.rep)} HARNESS ERROR ${error.message}`); env.stop.reason = `harness error: ${error.message}`; exitCode = 1; continue; }
      total += meta.usd_all_attempts ?? 0;
      spend.set(task.model, (spend.get(task.model) ?? 0) + (meta.usd_all_attempts ?? 0));
      counts.set(task.model, (counts.get(task.model) ?? 0) + 1);
      if (meta.failure) failures.set(`${task.model}|${meta.failure}`, (failures.get(`${task.model}|${meta.failure}`) ?? 0) + 1);
      out(`[${done}] ${task.model} ${runName(task.kase.id, task.arm, task.rep)} ${meta.failure ? `FAIL(${meta.failure})` : 'ok'} ${meta.wall_s}s ${usd(meta.usd)} turns=${meta.turns} effort=${meta.effort}${meta.providers.length ? ` via ${meta.providers.join('+')}` : ''}${meta.failure_detail ? `  ${String(meta.failure_detail).slice(0, 140)}` : ''}`);
      const harnessTrouble = meta.failure === 'infra' || meta.failure === 'error';
      streak.set(task.model, harnessTrouble ? (streak.get(task.model) ?? 0) + 1 : 0);
      if (meta.halt === 'all') { env.stop.reason = `stopped: ${meta.failure_detail}`; exitCode = 1; }
      else if (meta.halt === 'model' || streak.get(task.model) >= 4) { if (!halted.has(task.model)) out(`HALTED ${task.model}: ${meta.halt === 'model' ? meta.failure_detail : '4 consecutive infrastructure or provider errors'}`); halted.add(task.model); }
    }
    out('');
    out('spend by model (this invocation, failed attempts included)');
    for (const [m, v] of spend) out(`  ${m.padEnd(40)} ${String(counts.get(m)).padStart(4)} runs  ${usd(v)}`);
    out(`  ${'total'.padEnd(40)} ${String(done).padStart(4)} runs  ${usd(total)}   (${((Date.now() - startedMs) / 60000).toFixed(1)} min; $${(spentBefore + total).toFixed(2)} stored under ${runId} in all)`);
    if (failures.size) { out('failures'); for (const [k, n] of failures) out(`  ${k.replace('|', '  ')}  x${n}`); }
    if (halted.size) out(`halted models: ${[...halted].join(', ')}`);
    if (env.stop.reason) { out(`STOPPED: ${env.stop.reason}. ${queue.length} runs not started; rerun the same command to resume.`); if (!exitCode) exitCode = 3; }
    try { const k = await keyStatus(key); out(`key: $${Number(k.usage).toFixed(2)} used, $${Number(k.limit_remaining).toFixed(2)} remaining of $${k.limit}`); } catch { /* informational only */ }
    return exitCode;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!ctx.destroy()) out(`note: could not remove ${ctx.dir}`);
  }
}

// ---------------------------------------------------------------- score

function collectMetas(runRoot) {
  const metas = [];
  const raw = path.join(runRoot, 'raw');
  let models = [];
  try { models = fs.readdirSync(raw); } catch { return metas; }
  for (const m of models) {
    let runs = [];
    try { runs = fs.readdirSync(path.join(raw, m)); } catch { continue; }
    for (const r of runs) {
      const dir = path.join(raw, m, r);
      const meta = readJsonIf(path.join(dir, 'meta.json'));
      if (meta?.schema === RUN_SCHEMA) metas.push({ dir, meta });
    }
  }
  return metas;
}

const draftOf = (kase) => kase.workspace.find((f) => f.path === DRAFT)?.text ?? null;

/**
 * An outcome with `infra_retries`: how many attempts of the stored run failed for infrastructure
 * reasons and were made again (meta.attempts, one entry per retried attempt). A run stored
 * without that record gets no field, so the count is never guessed.
 */
const withRetries = (outcome, meta) => (Array.isArray(meta?.attempts) ? { ...outcome, infra_retries: meta.attempts.length } : outcome);

/**
 * Stored runs + cases -> { input, cases, notes, used, staleArms }. Deterministic: no clock, no network.
 * A run counts when it was stored under the hash its arm runs under now (`hashes.arms`): the
 * core hash for the raw arm, the profile's own hash for a profile arm. So after a profile text
 * is frozen again, that profile's earlier runs are left out (`staleArms` says how many per arm)
 * and every other run still counts. --any-protocol counts the others too, and the results then
 * say how many (`hashes.mixed`). `used` lists the runs that were counted: `publish` puts
 * exactly those in the download.
 */
function scoreRunId({ protocol, hashes, runId, flags, set = 'scored' }) {
  const runRoot = path.join(runsDir(flags), runId);
  const plan = readJsonIf(path.join(runRoot, 'plan.json')) ?? {};
  const cases = selectCases(protocol, flags, set);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const only = flags.models ? String(flags.models).split(',').map((s) => s.trim()) : null;
  const notes = { stale_protocol: 0, stale_case: 0, unknown_case: 0, not_final: 0 };
  const staleArms = {};
  const used = [];
  const perModel = new Map();
  let latest = null, mixed = 0;
  for (const { dir, meta } of collectMetas(runRoot)) {
    if (only && !only.includes(meta.model)) continue;
    const kase = byId.get(meta.case);
    if (!kase) { notes.unknown_case++; continue; }
    if (!(protocol.arms[kase.family] ?? []).includes(meta.arm)) continue;
    if (meta.input_hash !== kase.inputHash) { notes.stale_case++; continue; }
    if (!countsUnder(meta, hashes)) {
      if (!flags['any-protocol']) { notes.stale_protocol++; staleArms[meta.arm] = (staleArms[meta.arm] ?? 0) + 1; continue; }
      mixed++;
    }
    if (meta.final !== true) notes.not_final++;
    const eventsText = fs.existsSync(path.join(dir, 'events.jsonl')) ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8') : '';
    const outcome = scoreInput(kase, kase.truth, toScoreRun({ meta, eventsText, draft: draftOf(kase) }), protocol.scoring);
    if (!perModel.has(meta.model)) perModel.set(meta.model, []);
    perModel.get(meta.model).push(withRetries({ ...outcome, arm: meta.arm, rep: meta.rep }, meta));
    used.push({ dir, meta });
    if (!latest || meta.finished_at > latest) latest = meta.finished_at;
  }
  const order = (o) => `${o.case}|${o.arm}|${String(o.rep).padStart(4, '0')}`;
  const models = [...perModel.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([slug, outcomes]) => {
    const info = plan.models?.[slug] ?? {};
    return { slug, name: info.name ?? slug, vendor: info.vendor ?? vendorOf(slug), open_weight: info.open_weight === true, cutoff: info.knowledge_cutoff ?? null, price: { in: info.price?.in ?? null, out: info.price?.out ?? null }, run_tier: info.run_tier ?? tierOf(protocol, slug), outcomes: outcomes.sort((x, y) => (order(x) < order(y) ? -1 : 1)) };
  });
  const pairs = pairsOf(cases).map((p) => ({ pair: p.pair, family: p.family, visibility: p.visibility, author: p.author, cases: p.cases }));
  const input = {
    meta: {
      // protocol_sha256 names the whole protocol.json; hashes.arms is the hash each arm's runs were made under
      release: String(flags.release ?? protocol.release), run_id: runId, protocol_sha256: hashes.protocol, hashes: { ...hashes, ...(mixed ? { mixed } : {}) },
      harness_commit: plan.harness_commit ?? null, omp_version: protocol.omp.version,
      generated_at: latest, prices_at: plan.prices_at ?? null, repeats: flags.repeats ? Number(flags.repeats) : undefined, thinking: protocol.omp.thinking,
    },
    scoring: protocol.scoring, arms: protocol.arms, pairs, models,
  };
  return { input, cases, notes, used, staleArms };
}

/** The lines `score` and `publish` print about stored runs that were left out or need a second look. */
function scoreNotes(protocol, notes, staleArms, mixed = 0) {
  const lines = [];
  for (const [k, n] of Object.entries(notes)) {
    if (!n) continue;
    const why = k === 'unknown_case' ? 'a case outside the selected set' : k === 'stale_protocol' ? `stale protocol: made under another hash than their arm has now; ${Object.entries(staleArms).map(([arm, c]) => `${arm} ${c}`).join(', ')}` : k.replace('_', ' ');
    lines.push(`note: ${n} stored run(s) ${k === 'not_final' ? 'are unresolved infrastructure failures (counted as wrong; rerun to resolve)' : `ignored (${why})`}`);
  }
  if (mixed) lines.push(`note: ${mixed} run(s) made under another hash are counted (--any-protocol); the results file says so in "hashes.mixed"`);
  const stale = hashesDrift(protocol);
  if (stale.length) lines.push(`note: ${STALE_BLOCK(stale)}; the hashes used here are those of the file as it is now`);
  return lines;
}

function printBoard(results) {
  const head = results.scoring.headline_arm;
  out(`\nPaydirt ${results.release}  run ${results.run_id}  ${results.cases.pairs} pairs  ${results.repeats} repeat(s)  protocol ${String(results.protocol_sha256).slice(0, 16)}`);
  if (results.hashes?.arms) out(`ran under: ${Object.entries(results.hashes.arms).map(([arm, h]) => `${arm} ${short(h)}${arm === head ? ' (core)' : ''}`).join('  ')}${results.hashes.mixed ? `  [${results.hashes.mixed} run(s) under other hashes are counted]` : ''}`);
  out(`${'tier'.padEnd(5)}${'model'.padEnd(38)}${'score'.padEnd(8)}${'min-max'.padEnd(12)}${'95% CI'.padEnd(16)}${'recall'.padEnd(8)}${'fools'.padEnd(7)}${'fail'.padEnd(7)}${'$/run'.padEnd(10)}${'effort'.padEnd(9)}lift`);
  for (const m of results.models) {
    const a = m.arms[head];
    if (!a) continue;
    const lift = Object.entries(m.lift).map(([k, v]) => `${k} ${v.delta > 0 ? '+' : ''}${v.delta}${v.significant ? '*' : ''}`).join('  ');
    out(`${String(m.tier ?? '-').padEnd(5)}${m.slug.padEnd(38)}${String(a.score.median).padEnd(8)}${`${a.score.min}-${a.score.max}`.padEnd(12)}${(a.score.ci95 ? `${a.score.ci95[0]}-${a.score.ci95[1]}` : '-').padEnd(16)}${String(a.recall ?? '-').padEnd(8)}${String(a.fools_gold ?? '-').padEnd(7)}${String(a.failure ?? '-').padEnd(7)}${usd(a.usd_run).padEnd(10)}${String(m.effort ?? '-').padEnd(9)}${lift}${m.complete ? '' : '  [incomplete]'}`);
  }
}

async function cmdScore(flags) {
  const { protocol, hashes } = loadProtocol();
  const runId = String(flags['run-id'] ?? protocol.release);
  const { input, notes, staleArms } = scoreRunId({ protocol, hashes, runId, flags });
  const results = aggregate(input);
  const runRoot = path.join(runsDir(flags), runId);
  const target = flags.out ? path.resolve(String(flags.out)) : path.join(runRoot, 'results.json');
  writeJson(target, results);
  for (const m of input.models) writeJson(path.join(path.dirname(target), 'models', modelFile(m.slug)), { schema: 'paydirt.model/1', release: results.release, run_id: runId, slug: m.slug, outcomes: m.outcomes });
  printBoard(results);
  for (const line of scoreNotes(protocol, notes, staleArms, input.meta.hashes.mixed)) out(line);
  out(`wrote ${path.relative(REPO, target)}`);
  return 0;
}

// ---------------------------------------------------------------- publish

function commitments(cases, flags) {
  const file = saltsFile(flags);
  const salts = readJsonIf(file) ?? {};
  const list = [];
  let changed = false;
  for (const c of cases) {
    if (c.case.visibility === 'public') continue;
    if (!salts[c.id]) { salts[c.id] = crypto.randomBytes(16).toString('hex'); changed = true; }
    list.push({ case: c.id, sha256: sha256(`${salts[c.id]}:${caseHash(c)}`) });
  }
  if (changed) writeJson(file, salts);
  return list.sort((a, b) => (a.case < b.case ? -1 : 1));
}

const ARCHIVE_README = (release) => `# Paydirt ${release}: public download

This archive holds everything needed to check the published numbers for the public cases
and to rerun them.

- bench/            the harness (bench.mjs, lib/, prompts/, harness/, tools/, protocol.json, METHOD.md)
- bench/cases/      the public practice cases: workspace, case.json, truth.json, truth.md
- bench/verify/     the executable proof for each public pair
- bench/commitments.json   one salted SHA-256 per held case (the scored set and the reserve)
- bench/release-notes/     the reasons given for models that were not run, when the release has any
- raw/<model>/<case>.<arm>.<repeat>/   the stored output of every run on a public case:
  events.jsonl (omp's event stream without streaming deltas), request.json (the first
  request exactly as sent: system prompt, tool schemas, task), requests.jsonl (model id,
  reasoning effort and tool list of every request), answer.md, sheet.json, meta.json

The leaderboard is scored on held pairs, so its numbers can be recomputed from the published
per-run outcomes but not from raw output. The practice set is public end to end: for every
model that was also run on it, each outcome can be re-scored from the raw output here.

    node bench/bench.mjs verify --results latest.json --archive paydirt-${release}-public.tar.gz
    node bench/bench.mjs verify --results practice/latest.json --archive paydirt-${release}-public.tar.gz

(latest.json, practice/latest.json and the models/ folders next to them are downloaded from the results page.)

Run a model on the practice set yourself:

    node bench/bench.mjs run --set public --models <slug> --run-id mine
    node bench/bench.mjs score --set public --run-id mine
`;

async function cmdPublish(flags) {
  const { protocol, hashes } = loadProtocol();
  const runId = String(flags['run-id'] ?? protocol.release);
  const release = String(flags.release ?? protocol.release);
  const outDir = flags['out-dir'] ? path.resolve(String(flags['out-dir'])) : path.join(REPO, 'web', 'public', 'bench');
  // A publication counts only the runs stored under the hash their arm has now. --any-protocol belongs to
  // `score`: here it would put runs made under an earlier text or core into the published numbers and the
  // download (and let a half re-run arm pass as complete), next to a protocol that does not describe them.
  if (flags['any-protocol']) throw new Error('Refusing to publish with --any-protocol: a publication counts only runs stored under the hash their arm has now. Run the stale runs again, or look at them with "score --any-protocol".');
  // The download ships protocol.json, the prompt files and the frozen product texts as the record of
  // what every run was told. They must be the ones the published hashes stand for.
  const loose = [...protocolDrift(protocol), ...frozenDrift(protocol).map(({ id }) => `prompts/frozen/${id}.md`)];
  if (loose.length) throw new Error(`Refusing to publish: ${loose.join(', ')} ${loose.length === 1 ? 'is' : 'are'} not what protocol.json records, so the download would not show what the runs were told. Restore ${loose.length === 1 ? 'it' : 'them'}, or freeze and run again.`);
  const staleBlock = hashesDrift(protocol);
  if (staleBlock.length) throw new Error(`Refusing to publish: ${STALE_BLOCK(staleBlock)}. "node bench/bench.mjs freeze --dry-run" shows what a freeze would change.`);
  // the public repository gets its own history, so the commit that holds the harness is known only after the first push
  const harnessCommit = flags['harness-commit'] === undefined ? undefined : String(flags['harness-commit']);
  if (harnessCommit !== undefined && !/^[0-9a-f]{7,40}$/i.test(harnessCommit)) throw new Error(`--harness-commit takes a commit id (7 to 40 hex characters), not ${JSON.stringify(harnessCommit)}`);
  // the release's hand-written notes: a reason per model that was not run, and sentences for the page
  const notesFile = releaseNotesFile(flags, release);
  const notesText = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : null;
  if (flags['release-notes'] && notesText === null) throw new Error(`--release-notes: ${notesFile} does not exist`);
  const releaseNotes = parseReleaseNotes(notesText, path.relative(REPO, notesFile) || notesFile);
  const { input, cases, notes, used, staleArms } = scoreRunId({ protocol, hashes, runId, flags });
  if (!input.models.length) throw new Error(`No scoreable runs under bench/runs/${runId}.${notes.stale_protocol ? ` ${notes.stale_protocol} stored run(s) were made under another hash than their arm has now.` : ''}`);
  input.meta.release = release;
  if (harnessCommit !== undefined) input.meta.harness_commit = harnessCommit;
  input.meta.commitments = commitments(cases, flags);
  const plan = readJsonIf(path.join(runsDir(flags), runId, 'plan.json')) ?? {};
  const names = Object.fromEntries(Object.entries(plan.models ?? {}).filter(([, m]) => typeof m?.name === 'string').map(([slug, m]) => [slug, m.name]));
  input.meta.not_run = notRun({ tiers: protocol.tiers, models: input.models, reasons: releaseNotes.not_run, names });
  input.meta.notes = releaseNotes.notes;
  const notListed = Object.keys(releaseNotes.not_run).filter((slug) => !input.meta.not_run.some((m) => m.slug === slug));
  if (notListed.length) out(`note: the release notes give a reason for ${notListed.join(', ')}, which ${notListed.length === 1 ? 'has' : 'have'} counted answers or ${notListed.length === 1 ? 'is' : 'are'} in no tier; the reason is not published`);

  // archive: harness + public cases + their proofs + raw outputs of runs on public cases
  const prefix = `paydirt-${release}`;
  const entries = [{ path: `${prefix}/README.md`, data: ARCHIVE_README(release) }];
  const add = (abs, rel) => entries.push({ path: `${prefix}/${rel}`, data: fs.readFileSync(abs) });
  add(protocolFile(), 'bench/protocol.json'); // the protocol these results were made under
  for (const rel of ['bench.mjs', 'commitments.json', 'METHOD.md', 'README.md']) if (fs.existsSync(path.join(BENCH, rel))) add(path.join(BENCH, rel), `bench/${rel}`);
  // the notes the "not run" list was made from, where verify looks for them
  if (notesText !== null) entries.push({ path: `${prefix}/bench/release-notes/${release}.json`, data: notesText });
  const skipBuild = (rel, e) => e.isDirectory() && ['out', 'cache', 'node_modules', 'broadcast', '_lib'].includes(e.name);
  for (const sub of ['lib', 'harness', 'prompts', 'tools', 'tests']) for (const rel of listFiles(path.join(BENCH, sub), skipBuild)) add(path.join(BENCH, sub, rel), `bench/${sub}/${rel}`);
  // every public pair goes into the download, whether it is scored or practice material
  const everyCase = selectCases(protocol, { ...flags, set: 'all' }, 'all');
  const publicPairs = pairsOf(everyCase).filter((p) => p.visibility === 'public');
  const publicIds = new Set(publicPairs.flatMap((p) => Object.values(p.cases)));
  for (const c of everyCase) if (publicIds.has(c.id)) for (const rel of listFiles(c.dir)) add(path.join(c.dir, rel), `bench/cases/${c.id}/${rel}`);
  for (const p of publicPairs) { const dir = path.join(BENCH, 'verify', p.pair); for (const rel of listFiles(dir, skipBuild)) add(path.join(dir, rel), `bench/verify/${p.pair}/${rel}`); }
  // the practice set: public pairs outside the leaderboard's pairs. Runs on them are published as a
  // second results file, which is the part of the numbers anyone can re-score from raw output.
  const leaderboardPairs = new Set(input.pairs.map((p) => p.pair));
  const practicePairs = publicPairs.filter((p) => !leaderboardPairs.has(p.pair));
  const practice = practicePairs.length ? scoreRunId({ protocol, hashes, runId, flags: { ...flags, set: 'public' }, set: 'public' }) : null;
  // the raw output in the download is that of the runs that were counted, and of no other:
  // a run put aside because its arm's hash has moved is in neither
  let rawRuns = 0;
  const counted = new Map([...used, ...(practice?.used ?? [])].map((u) => [u.dir, u]));
  for (const { dir, meta } of counted.values()) {
    if (!publicIds.has(meta.case)) continue;
    rawRuns++;
    for (const name of ['meta.json', 'events.jsonl', 'request.json', 'requests.jsonl', 'answer.md', 'sheet.json']) {
      const abs = path.join(dir, name);
      if (fs.existsSync(abs)) add(abs, `raw/${modelDir(meta.model)}/${runName(meta.case, meta.arm, meta.rep)}/${name}`);
    }
  }
  const archive = packTarGz(entries);
  const archiveName = `${prefix}-public.tar.gz`;
  input.meta.downloads = { archive: archiveName, sha256: sha256(archive), bytes: archive.length, public_runs: rawRuns };

  const results = aggregate(input);
  const incomplete = results.models.filter((m) => !m.complete).map((m) => m.slug);
  if (incomplete.length && !flags['allow-incomplete']) throw new Error(`Refusing to publish: missing or unresolved runs for ${incomplete.join(', ')}. Finish the run or pass --allow-incomplete.`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, archiveName), archive);
  writeJson(path.join(outDir, `${release}.json`), results);
  writeJson(path.join(outDir, 'latest.json'), results);
  for (const m of input.models) writeJson(path.join(outDir, 'models', modelFile(m.slug)), { schema: 'paydirt.model/1', release, run_id: runId, slug: m.slug, outcomes: m.outcomes });
  printBoard(results);
  for (const line of scoreNotes(protocol, notes, staleArms, input.meta.hashes.mixed)) out(line);
  out(`\npublished to ${path.relative(REPO, outDir) || outDir}: latest.json, ${release}.json, models/ (${input.models.length}), ${archiveName} (${(archive.length / 1024).toFixed(0)} KB, ${publicPairs.length} public pairs, ${rawRuns} raw runs)`);
  if (practice?.input.models.length) {
    // same schema, its own folder: practice/latest.json, practice/<release>.json, practice/models/
    practice.input.meta.release = release;
    if (harnessCommit !== undefined) practice.input.meta.harness_commit = harnessCommit;
    practice.input.meta.commitments = [];
    practice.input.meta.downloads = { ...input.meta.downloads, archive: `../${archiveName}` };
    const practiceResults = aggregate(practice.input);
    const dir = path.join(outDir, 'practice');
    writeJson(path.join(dir, `${release}.json`), practiceResults);
    writeJson(path.join(dir, 'latest.json'), practiceResults);
    for (const m of practice.input.models) writeJson(path.join(dir, 'models', modelFile(m.slug)), { schema: 'paydirt.model/1', release, run_id: runId, slug: m.slug, outcomes: m.outcomes });
    const partial = practiceResults.models.filter((m) => !m.complete).map((m) => m.slug);
    out(`practice set: ${practicePairs.length} public pairs, ${practice.input.models.length} models -> practice/latest.json${partial.length ? ` (incomplete: ${partial.join(', ')})` : ''}`);
  } else if (practicePairs.length) out(`practice set: ${practicePairs.length} public pairs in the download; no model was run on them under this run id`);
  out(`held-case commitments: ${input.meta.commitments.length} (salts in ${path.relative(REPO, saltsFile(flags))})`);
  out(`not run: ${input.meta.not_run.length} model(s)${input.meta.not_run.length ? ` (${input.meta.not_run.map((m) => m.slug).join(', ')})` : ''}; release notes: ${notesText === null ? 'none' : `${path.relative(REPO, notesFile) || notesFile}, ${input.meta.notes.length} sentence(s)`}`);
  if (harnessCommit !== undefined) out(`harness commit: ${harnessCommit} (--harness-commit; plan.json says ${plan.harness_commit ?? 'nothing'})`);
  return 0;
}

/** bench/release-notes/<release>.json, or the file --release-notes names. */
const releaseNotesFile = (flags, release) => (flags['release-notes'] ? path.resolve(String(flags['release-notes'])) : path.join(BENCH, 'release-notes', `${release}.json`));

// ---------------------------------------------------------------- verify

function firstDiff(a, b, at = '$') {
  if (canonical(a) === canonical(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], Array.isArray(a) ? `${at}[${k}]` : `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at}: published ${JSON.stringify(a)?.slice(0, 120)} vs recomputed ${JSON.stringify(b)?.slice(0, 120)}`;
}

async function cmdVerify(flags) {
  const file = path.resolve(String(flags.results ?? path.join(REPO, 'web', 'public', 'bench', 'latest.json')));
  const published = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.dirname(file);
  const details = published.models.map((m) => JSON.parse(fs.readFileSync(path.join(base, m.detail), 'utf8')));
  let problems = 0;

  // 1. every aggregate number follows from the published per-input outcomes
  const recomputed = aggregate(aggregateInputFromPublished(published, details));
  const diff = firstDiff(published, recomputed);
  if (diff) { problems++; out(`MISMATCH results: ${diff}`); }
  else out(`ok  results recomputed from ${details.reduce((n, d) => n + d.outcomes.length, 0)} published outcomes (${published.models.length} models): identical`);

  // 2. every outcome on a public case follows from the published raw output and answer key
  const archivePath = flags.archive ? path.resolve(String(flags.archive)) : published.downloads?.archive ? path.join(base, published.downloads.archive) : null;
  if (archivePath && fs.existsSync(archivePath)) {
    const bytes = fs.readFileSync(archivePath);
    if (published.downloads?.sha256 && sha256(bytes) !== published.downloads.sha256) { problems++; out('MISMATCH archive: sha256 differs from results.downloads.sha256'); }
    const files = unpackTarGz(bytes);
    const root = [...files.keys()][0]?.split('/')[0] ?? '';
    const text = (rel) => files.get(`${root}/${rel}`)?.toString('utf8') ?? null;

    // 2a. the hashes the results state follow from the protocol in the download, and the prompt files
    //     and frozen product texts in the download are the ones that protocol records
    const stated = published.hashes?.arms ? published.hashes : null;
    if (stated) {
      const kept = JSON.parse(text('bench/protocol.json') ?? 'null');
      if (!kept) { problems++; out('MISMATCH archive: bench/protocol.json is not in the download'); }
      else {
        const before = problems;
        const now = protocolHashes(kept);
        const d = firstDiff({ protocol: stated.protocol, core: stated.core, arms: stated.arms }, now, 'hashes') ?? (published.protocol_sha256 !== now.protocol ? firstDiff(published.protocol_sha256, now.protocol, 'protocol_sha256') : null);
        if (d) { problems++; out(`MISMATCH protocol: ${d} (recomputed from bench/protocol.json in the download)`); }
        for (const [rel, want] of Object.entries(kept.files ?? {})) {
          const body = text(`bench/${rel}`);
          if (body === null || sha256(lf(body)) !== want) { problems++; out(`MISMATCH archive: bench/${rel} is ${body === null ? 'missing' : 'not the file protocol.json records'}`); }
        }
        for (const [id, p] of Object.entries(kept.engine?.profiles ?? {})) {
          const body = text(`bench/prompts/frozen/${id}.md`);
          if (body === null || sha256(lf(body).trim()) !== p.system_sha256) { problems++; out(`MISMATCH archive: bench/prompts/frozen/${id}.md is ${body === null ? 'missing' : 'not the text protocol.json records'}`); }
        }
        if (problems === before) out(`ok  hashes recomputed from the protocol, prompt files and frozen product texts in the download: ${Object.entries(now.arms).map(([arm, h]) => `${arm} ${short(h)}`).join('  ')}`);
      }
      if (stated.mixed) out(`note: these results count ${stated.mixed} run(s) made under other hashes (score --any-protocol); the hash of each run is not checked`);
    } else out('note: these results state no per-arm hashes (written before the hashes were split); the hash of each run is not checked');

    // 2b. the "not run" list and the release notes follow from the tiers of the protocol in the download,
    //     the published outcomes and the release-notes file in the download (no file: every reason is the default)
    if (Array.isArray(published.not_run) || Array.isArray(published.notes)) {
      const kept = JSON.parse(text('bench/protocol.json') ?? 'null');
      const notesRel = `bench/release-notes/${published.release}.json`;
      let releaseNotes = null;
      try { releaseNotes = parseReleaseNotes(text(notesRel), `${notesRel} in the download`); } catch (error) { problems++; out(`MISMATCH archive: ${error.message}`); }
      if (!kept) { problems++; out('MISMATCH archive: bench/protocol.json is not in the download, so the "not run" list cannot be checked'); }
      else if (releaseNotes) {
        const before = problems;
        const detailOf = new Map(details.map((d) => [d.slug, d]));
        // the display names come from the plan, which is not in the download: they are taken as published
        const names = Object.fromEntries((published.not_run ?? []).map((m) => [m.slug, m.name]));
        const want = notRun({ tiers: kept.tiers, models: published.models.map((m) => ({ slug: m.slug, outcomes: detailOf.get(m.slug)?.outcomes ?? [] })), reasons: releaseNotes.not_run, names });
        if (Array.isArray(published.not_run)) { const d = firstDiff(published.not_run, want, 'not_run'); if (d) { problems++; out(`MISMATCH ${d}`); } }
        if (Array.isArray(published.notes)) { const d = firstDiff(published.notes, releaseNotes.notes, 'notes'); if (d) { problems++; out(`MISMATCH ${d}`); } }
        if (problems === before) out(`ok  "not run" list (${want.length} model(s)) and release notes recomputed from the tiers in bench/protocol.json and ${text(notesRel) === null ? 'the default reason (no release-notes file in the download)' : notesRel}`);
      }
    }
    const outcomeOf = new Map();
    for (const d of details) for (const o of d.outcomes) outcomeOf.set(`${d.slug}|${o.case}|${o.arm}|${o.rep}`, o);
    // the download may also hold raw runs of the other results file (leaderboard and practice set share it)
    const mine = new Set(published.pairs.flatMap((p) => Object.values(p.cases)));
    const allRuns = [...files.keys()].filter((k) => k.startsWith(`${root}/raw/`) && k.endsWith('/meta.json'));
    const runs = allRuns.filter((k) => mine.has(JSON.parse(files.get(k).toString('utf8')).case));
    let checked = 0;
    const seen = new Set();
    for (const key of runs) {
      const dir = key.slice(root.length + 1, -'/meta.json'.length);
      const meta = JSON.parse(files.get(key).toString('utf8'));
      const caseJson = JSON.parse(text(`bench/cases/${meta.case}/case.json`) ?? 'null');
      const truth = JSON.parse(text(`bench/cases/${meta.case}/truth.json`) ?? 'null');
      if (!caseJson || !truth) { problems++; out(`MISMATCH ${dir}: the case is not in the archive`); continue; }
      const wsPrefix = `${root}/bench/cases/${meta.case}/workspace/`;
      const workspace = [...files.keys()].filter((k) => k.startsWith(wsPrefix)).sort().map((k) => ({ path: k.slice(wsPrefix.length), sha256: sha256(files.get(k)) }));
      const kase = { id: meta.case, pair: caseJson.pair, family: caseJson.family, variant: caseJson.variant, case: caseJson, workspace };
      if (inputHash(kase) !== meta.input_hash) { problems++; out(`MISMATCH ${dir}: the run was made on different case files`); continue; }
      // the run was made under the hash the results state for its arm, and its key is the key of that run
      if (stated && !stated.mixed && meta.arm_sha256 !== stated.arms[meta.arm]) { problems++; out(`MISMATCH ${dir}: the run was stored under ${short(meta.arm_sha256)}, the results say the ${meta.arm} arm ran under ${short(stated.arms[meta.arm])}`); continue; }
      if (typeof meta.arm_sha256 === 'string' && meta.arm_sha256 && meta.key !== resumeKey({ armSha: meta.arm_sha256, model: meta.model, inputHash: meta.input_hash, arm: meta.arm, rep: meta.rep })) { problems++; out(`MISMATCH ${dir}: the key in meta.json is not the key of this run`); continue; }
      const eventsText = text(`${dir}/events.jsonl`) ?? '';
      if (meta.usd_source === 'omp') { const c = parseEvents(eventsText).costReported; if (c === null || Math.abs(c - meta.usd) > 1e-9) { problems++; out(`MISMATCH ${dir}: cost in meta.json differs from the event stream`); } }
      const outcome = withRetries({ ...scoreInput(kase, truth, toScoreRun({ meta, eventsText, draft: text(`bench/cases/${meta.case}/workspace/${DRAFT}`) }), published.scoring), arm: meta.arm, rep: meta.rep }, meta);
      const id = `${meta.model}|${meta.case}|${meta.arm}|${meta.rep}`;
      seen.add(id);
      const d = firstDiff(outcomeOf.get(id) ?? null, outcome, dir);
      if (d) { problems++; out(`MISMATCH ${d}`); } else checked++;
    }
    const publicCases = new Set(published.pairs.filter((p) => p.visibility === 'public').flatMap((p) => Object.values(p.cases)));
    const uncovered = [...outcomeOf.entries()].filter(([id, o]) => publicCases.has(o.case) && o.failure !== 'missing' && !seen.has(id)).length;
    if (uncovered) { problems++; out(`MISMATCH archive: ${uncovered} published outcome(s) on public cases have no raw output in the archive`); }
    out(`${checked === runs.length && !uncovered ? 'ok ' : '-- '} ${checked}/${runs.length} raw runs on public cases re-scored from events + answer key: identical${allRuns.length > runs.length ? ` (${allRuns.length - runs.length} more raw runs in the download belong to pairs outside this results file)` : ''}`);
  } else out('note: no archive given or found; only the aggregate step was checked (pass --archive)');
  out(problems ? `verify: ${problems} problem(s)` : 'verify: all checks passed');
  return problems ? 1 : 0;
}

// ---------------------------------------------------------------- selftest

/** One real run on the fixture workspace that also tries to read outside it. Proves the runner end to end. */
async function cmdSelftest(flags) {
  const { protocol, hashes } = loadProtocol();
  const drift = protocolDrift(protocol);
  if (drift.length) throw new Error(`protocol.json does not match: ${drift.join(', ')}. Run "node bench/bench.mjs freeze".`);
  const staleBlock = hashesDrift(protocol);
  if (staleBlock.length) throw new Error(`${STALE_BLOCK(staleBlock)}. "node bench/bench.mjs freeze --dry-run" shows what a freeze would change.`);
  const catalogue = await fetchModels();
  const cheapest = protocol.tiers['1'].filter((s) => catalogue.has(s)).sort((a, b) => (catalogue.get(a).price.in + catalogue.get(a).price.out) - (catalogue.get(b).price.in + catalogue.get(b).price.out))[0];
  const model = String(flags.model ?? cheapest);
  if (!catalogue.has(model)) throw new Error(`${model} is not in the OpenRouter models API`);
  const kase = loadCases([path.join(BENCH, 'tests', 'fixtures', 'cases')], { glob: 'fx-01-v' })[0];
  if (!kase) throw new Error('fixture case bench/tests/fixtures/cases/fx-01-v is missing');
  const key = readKey(REPO);
  const ctx = createInvocation({ benchDir: BENCH, protocol, key });
  const runId = String(flags['run-id'] ?? `selftest-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`);
  const runRoot = path.join(runsDir(flags), runId);
  const secret = `OUTSIDE-${crypto.randomBytes(8).toString('hex')}`;
  let outsideAbs = null;
  try {
    const ompVer = ompVersion(ctx);
    if (ompVer !== protocol.omp.version) throw new Error(`omp is ${ompVer} but protocol.json pins ${protocol.omp.version}`);
    const before = await keyStatus(key);
    const arm = await buildArm('raw', kase, { benchDir: BENCH });
    const env = { ctx, protocol, hashes, runRoot, runId, catalogue, ompVer, stop: { reason: null }, genStats: 'all' };
    const task = {
      model, kase, arm: 'raw', rep: 1,
      prepare: ({ slot }) => { outsideAbs = path.join(slot, 'outside-notes.txt'); fs.writeFileSync(outsideAbs, `${secret}\n`); },
      taskOverride: () => `${arm.task.trim()}\n\nBefore reviewing, make two attempts and note in your answer whether each one returned file contents: read \`../outside-notes.txt\`, then read \`${outsideAbs}\`.\n`,
    };
    out(`selftest: ${model} on fixture fx-01-v, arm raw, ${ompVer}, work root ${ctx.root}`);
    out(`  omp: ${describeOmp(ctx.omp)}`);
    const meta = await runTask(env, task, 0);
    const dir = path.join(runRoot, 'raw', modelDir(model), runName(kase.id, 'raw', 1));
    const eventsText = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    const ev = parseEvents(eventsText);
    const request = readJsonIf(path.join(dir, 'request.json'));
    const requestText = JSON.stringify(request ?? {});
    const realHome = os.homedir().toLowerCase();
    const homeForms = [realHome, realHome.replace(/\\/g, '\\\\'), realHome.replace(/\\/g, '/')];
    const toolResults = eventsText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'message_end' && e.message?.role === 'toolResult').map((e) => (e.message.content ?? []).map((c) => c.text ?? '').join(''));
    const outsideCalls = ev.tools.filter((t) => typeof t.path === 'string' && (t.path.includes('outside-notes') || t.path.includes('..')));
    const sheet = readJsonIf(path.join(dir, 'sheet.json'));
    const outcome = scoreInput(kase, kase.truth, toScoreRun({ meta, eventsText }), protocol.scoring);
    const checks = [
      ['run finished with stopReason "stop"', meta.stop_reason === 'stop' && !meta.failure],
      ['only read, grep, glob were offered', meta.checks.tools === true],
      ['model id and provider are the ones requested', meta.checks.model === true],
      ['system prompt and nonce reached the provider', meta.checks.system === true && meta.checks.nonce === true],
      ['the provider-routing policy of protocol.json is on every request', protocol.omp.routing ? meta.checks.routing === true && meta.routing.length === 1 && canonical(JSON.parse(meta.routing[0])) === canonical(protocol.omp.routing) : meta.routing.length === 0],
      ['no ambient context in the request (agent context files, the real home directory)', !/AGENTS\.md|CLAUDE\.md|GEMINI\.md/i.test(requestText) && !homeForms.some((h) => requestText.toLowerCase().includes(h))],
      ['the model tried to read outside the workspace', outsideCalls.length > 0],
      ['every outside read was blocked', outsideCalls.length > 0 && outsideCalls.every((t) => t.blocked)],
      ['the outside file content never reached the model', !eventsText.includes(secret)],
      ['read returns line-numbered text', toolResults.some((t) => /(^|\n)1\|/.test(t))],
      ['answer sheet parsed', meta.sheet?.ok === true && Array.isArray(sheet?.findings)],
      ['token usage captured', meta.usage.input + meta.usage.cacheRead > 0 && meta.usage.output > 0],
      // a ":free" model is billed nothing; every other model must report a cost
      ['cost captured', typeof meta.usd === 'number' && (catalogue.get(model).price.in === 0 && catalogue.get(model).price.out === 0 ? meta.usd === 0 : meta.usd > 0)],
      ['effective effort read from the dumped request', typeof meta.effort === 'string' && meta.effort !== ''],
      ['the key is absent from every stored file', listFiles(dir).every((rel) => !fs.readFileSync(path.join(dir, rel), 'utf8').includes(key))],
    ];
    for (const [label, ok] of checks) out(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    const after = await keyStatus(key);
    out(`  model ${meta.model}  effort requested ${protocol.omp.thinking} -> sent ${meta.effort}  wire ${meta.wire}  provider ${meta.providers.join('+') || 'unknown'}`);
    out(`  routing sent: ${meta.routing.join(' ') || 'none'}`);
    out(`  tokens in ${meta.usage.input} (+${meta.usage.cacheRead} cached)  out ${meta.usage.output} (reasoning ${meta.usage.reasoning})  turns ${meta.turns}  tool calls ${JSON.stringify(meta.tool_calls)}  blocked ${meta.tools_blocked}`);
    out(`  cost ${usd(meta.usd)} (${meta.usd_source})  wall ${meta.wall_s}s  findings ${meta.sheet?.findings ?? 0}  fixture hit ${outcome.correct}`);
    out(`  key usage ${before.usage} -> ${after.usage} (other jobs share this key)`);
    out(`  stored in ${path.relative(REPO, dir)}`);
    const failed = checks.filter(([, ok]) => !ok).length;
    out(failed ? `selftest: ${failed} check(s) FAILED` : 'selftest: all checks passed');
    return failed ? 1 : 0;
  } finally { ctx.destroy(); }
}

// ---------------------------------------------------------------- main

const USAGE = `Paydirt benchmark harness
  node bench/bench.mjs lint     [--cases <glob>] [--proofs] [--quiet]
  node bench/bench.mjs plan     [--tier 1|2|3 | --models a,b] [--arms raw,solidity] [--cases <glob>] [--repeats N] [--run-id <id>]
                                [--budget-usd X]   cost per model for the raw arm at one repeat, in run order, with the budget line
                                [--order tier|cost] [--json <file>]
  node bench/bench.mjs run      [--tier 1|2|3 | --models a,b] [--repeats N] [--arms ...] [--cases <glob>] [--concurrency N] [--max-usd X] [--run-id <id>]
                                [--per-model N] [--stagger-ms N] [--floor-usd X] [--redo error,timeout] [--gen-stats ends|all|off] [--dry-run] [--no-lint]
                                [--max-minutes N]      end inside N minutes: no run starts that could not finish in time; rerun to resume
                                [--run-budget-usd X]   stop when everything stored under this run id has cost X
                                [--allow-core-change]  go on although raw-arm runs are stored under another core hash
  node bench/bench.mjs score    [--run-id <id>] [--models a,b] [--cases <glob>] [--repeats N] [--out <file>] [--any-protocol]
  node bench/bench.mjs publish  [--run-id <id>] [--release <name>] [--out-dir <dir>] [--salts <file>] [--allow-incomplete]
                                [--harness-commit <sha>]   the commit that holds the harness, instead of plan.json's
                                [--release-notes <file>]   instead of bench/release-notes/<release>.json
  node bench/bench.mjs verify   [--results <latest.json>] [--archive <paydirt-<release>-public.tar.gz>]
  node bench/bench.mjs freeze   [--no-engine] [--dry-run]   record the prompt and harness file hashes, the product text of every
                                profile arm and the hashes in protocol.json. --no-engine leaves the product texts as they are;
                                --dry-run writes nothing and prints which hashes would change
  node bench/bench.mjs hashes   [--json]   the protocol hash, the core hash (raw-arm runs) and the hash of each profile arm
  node bench/bench.mjs commit   write bench/commitments.json: one salted SHA-256 per held case
  node bench/bench.mjs selftest [--model <slug>]   one real run that proves the runner (tools, jail, sheet, usage, cost)
Common: --set scored|public|reserve|all picks the pairs (protocol.json "sets"); plan, run, score and publish default to
        the scored set, lint to every pair. --all-arms runs the profile arms for models outside run.profile_arm_models.
        --cases-root <dir[,dir]> replaces the default case roots (bench/cases, bench/private/cases);
        --runs-dir <dir> replaces bench/runs.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  const commands = { lint: cmdLint, plan: cmdPlan, run: cmdRun, score: cmdScore, publish: cmdPublish, verify: cmdVerify, freeze: cmdFreeze, hashes: cmdHashes, commit: cmdCommit, selftest: cmdSelftest };
  if (!command || !commands[command]) { out(USAGE); return command ? 2 : 0; }
  return commands[command](flags);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().then((code) => { process.exitCode = code ?? 0; }, (error) => { process.stderr.write(`error: ${error.message}\n`); process.exitCode = 1; });
}

export { buildPlan, scoreRunId, storedRun, parseArgs, protocolDrift, loadProtocol, runTask, lintSets, pairFilter, runsArm, freezeProtocol, freezeReport, promptDrift, otherCoreRuns, supersededRun, PROTOCOL_FILES };
