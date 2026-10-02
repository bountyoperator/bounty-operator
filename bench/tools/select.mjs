#!/usr/bin/env node
// Paydirt set selection: which pairs are scored, which are published as practice material and
// which are kept in reserve.
//   node bench/tools/select.mjs            print the selection the rule gives today and compare it with protocol.json
//   node bench/tools/select.mjs --apply    write it: protocol.json (sets, selection.status), the case folders
//                                          (public pairs live in bench/cases and are marked public), bench/.gitignore
//                                          (the proofs of public pairs) and the table in METHOD.md
//
// The rule is in protocol.json `selection` and is applied here, mechanically:
//   1. every pair in `always_scored` (the hard pairs) is scored;
//   2. the other pairs are ordered inside their family, hardest first, by
//        a. the share of difficulty probes that got the pair right (tools/probe.mjs, unranked models only),
//        b. the share of probed twins that were right,
//        c. `prior_order`, written before the probe was complete;
//      a pair with no completed probe is ordered as if no probe got it right;
//   3. each family is filled to `family_targets` from the top of that order, skipping a pair whose
//      bug class is already `class_cap` times in the scored set;
//   4. of what is left in a family, the `public_per_family` easiest pairs become the public practice
//      set and the others the reserve.
// Nothing here calls a model or spends anything: it reads the probe's stored answers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCases, pairsOf } from '../lib/cases.mjs';
import { recordedHashes, renderHashesBlock, replaceHashesBlock, stampHashes } from '../lib/protocol.mjs';
import { PROBE_DEFAULTS, PROBE_MODELS, buildProbePrompt, summarise } from './probe.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(BENCH, '..');
const out = (line = '') => process.stdout.write(`${line}\n`);
const FAMILY_ORDER = ['challenge', 'find-ts', 'find-sol'];
const BEGIN = '<!-- selection:begin (written by tools/select.mjs; do not edit by hand) -->';
const END = '<!-- selection:end -->';

/**
 * Apply the rule. Pure.
 *   pairs    [{ pair, family }]
 *   rows     summarise() rows of the probe: { pair, probes, right, first_right, second_right }
 *   config   protocol.selection
 *   classes  { pair: bug class } (held with the cases; absent labels are never capped)
 * Returns { scored, public, reserve, order: { family: [pair, ...] }, skipped: [{ pair, class }], problems: [] }.
 */
export function selectSets({ pairs, rows, config, classes = {} }) {
  const rowOf = new Map(rows.map((r) => [r.pair, r]));
  const always = new Set(config.always_scored ?? []);
  const problems = [];
  const classCount = new Map();
  const take = (pair) => { const c = classes[pair]; if (c) classCount.set(c, (classCount.get(c) ?? 0) + 1); };
  const scored = [], publicSet = [], reserve = [], skipped = [], order = {};
  for (const p of pairs) if (always.has(p.pair)) { scored.push(p.pair); take(p.pair); }
  for (const id of always) if (!pairs.some((p) => p.pair === id)) problems.push(`always_scored names ${id}, which is not on disk`);
  const families = [...FAMILY_ORDER, ...[...new Set(pairs.map((p) => p.family))].filter((f) => !FAMILY_ORDER.includes(f)).sort()];
  for (const family of families) {
    const prior = config.prior_order?.[family] ?? [];
    const key = (p) => {
      const r = rowOf.get(p.pair);
      const probes = r?.probes ?? 0;
      const at = prior.indexOf(p.pair);
      return [probes ? r.right / probes : 0, probes ? (r.first_right + r.second_right) / (2 * probes) : 0, at < 0 ? Infinity : at, p.pair];
    };
    const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return x[3] < y[3] ? -1 : 1; };
    const candidates = pairs.filter((p) => p.family === family && !always.has(p.pair)).sort(cmp);
    order[family] = candidates.map((p) => p.pair);
    const target = config.family_targets?.[family] ?? 0;
    let have = pairs.filter((p) => p.family === family && always.has(p.pair)).length;
    const rest = [];
    for (const p of candidates) {
      const c = classes[p.pair];
      if (have >= target) { rest.push(p.pair); continue; }
      if (c && (classCount.get(c) ?? 0) >= (config.class_cap ?? Infinity)) { skipped.push({ pair: p.pair, class: c }); rest.push(p.pair); continue; }
      scored.push(p.pair); take(p.pair); have++;
    }
    if (have < target) problems.push(`${family}: only ${have} pairs can be scored, the target is ${target}`);
    // `rest` is hardest first: the easiest go public, the others stay in reserve
    const nPublic = Math.min(config.public_per_family?.[family] ?? 0, rest.length);
    if (nPublic < (config.public_per_family?.[family] ?? 0)) problems.push(`${family}: only ${nPublic} pairs are left for the public set, the target is ${config.public_per_family[family]}`);
    reserve.push(...rest.slice(0, rest.length - nPublic));
    publicSet.push(...rest.slice(rest.length - nPublic));
  }
  if (Number.isInteger(config.scored_pairs) && scored.length !== config.scored_pairs) problems.push(`the rule gives ${scored.length} scored pairs; scored_pairs is ${config.scored_pairs}`);
  for (const [family, n] of Object.entries(config.minimum ?? {})) {
    const have = scored.filter((id) => pairs.find((p) => p.pair === id)?.family === family).length;
    if (have < n) problems.push(`the scored set has ${have} ${family} pairs; the minimum is ${n}`);
  }
  const sort = (list) => [...list].sort();
  return { scored: sort(scored), public: sort(publicSet), reserve: sort(reserve), order, skipped, problems };
}

/** The probe's stored calls that were made on the prompt a case has today. */
export function readProbeStore(store, cases, models, repeats, benchDir = BENCH) {
  const calls = [];
  let stale = 0;
  for (const model of models) for (let rep = 1; rep <= repeats; rep++) for (const kase of cases) {
    const file = path.join(store, model.replace(/[^A-Za-z0-9._-]+/g, '__'), `${kase.id}.${rep}.json`);
    let kept;
    try { kept = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (kept.prompt_sha256 !== buildProbePrompt(kase, benchDir).sha256) { stale++; continue; }
    calls.push(kept);
  }
  return { calls, stale };
}

const frac = (num, den) => (den ? `${num}/${den}` : '-');

/** The block of METHOD.md between the selection markers. */
export function renderMethodBlock({ pairs, rows, sets, config, probe, classCounts }) {
  const rowOf = new Map(rows.map((r) => [r.pair, r]));
  const setOf = (id) => (sets.scored.includes(id) ? 'scored' : sets.public.includes(id) ? 'public' : 'reserve');
  const rank = { scored: 0, reserve: 1, public: 2 };
  const lines = [BEGIN, ''];
  lines.push(probe.status === 'final'
    ? `**Status: final.** Every pair the rule has to order was probed in full (${probe.models.length} models, ${probe.repeats === 1 ? 'one answer per twin' : `${probe.repeats} answers per twin`}): ${probe.probes_complete} probes are complete and ${probe.probes_void} are void because a call got no answer.${probe.unprobed.length ? ` Not probed: ${probe.unprobed.join(', ')}, which are scored whatever a probe says.` : ''}`
    : `**Status: provisional.** ${probe.probes_complete} of ${probe.probes_expected} probes are in (${pairs.length} pairs x ${probe.models.length} models x ${probe.repeats} repeat${probe.repeats === 1 ? '' : 's'}; ${probe.calls_answered} of ${probe.calls_expected} calls answered). Where the probe has not spoken, the order below rests on step 2c, the engineer's prior order, not on a measurement. The split is recomputed, and this table rewritten, when the remaining probes have run; that happens before any scored run.`, '');
  lines.push('| Pair | Family | Drafted by | Set | Probes right | Bug twin / overclaim caught | Clean twin / accurate accepted |', '|---|---|---|---|---|---|---|');
  const sorted = [...pairs].sort((a, b) => rank[setOf(a.pair)] - rank[setOf(b.pair)] || (a.pair < b.pair ? -1 : 1));
  for (const p of sorted) {
    const r = rowOf.get(p.pair);
    lines.push(`| ${p.pair} | ${p.family} | ${p.author} | ${setOf(p.pair)} | ${r?.probes ? `${(r.right / r.probes).toFixed(2)} (${frac(r.right, r.probes)})` : 'not probed'} | ${frac(r?.first_right ?? 0, r?.probes ?? 0)} | ${frac(r?.second_right ?? 0, r?.probes ?? 0)} |`);
  }
  lines.push('');
  const count = (set, family) => sets[set].filter((id) => pairs.find((p) => p.pair === id)?.family === family).length;
  // probes right over a list of pairs
  const rate = (ids) => { const rs = ids.map((id) => rowOf.get(id)).filter(Boolean); const right = rs.reduce((s, r) => s + r.right, 0), probes = rs.reduce((s, r) => s + r.probes, 0); return probes ? `${(right / probes).toFixed(2)} (${right}/${probes})` : '-'; };
  const hard = new Set(config.always_scored ?? []);
  lines.push('| Set | Pairs | find-sol | find-ts | challenge | Probes right |', '|---|---|---|---|---|---|');
  for (const s of ['scored', 'public', 'reserve']) {
    lines.push(`| ${s} | ${sets[s].length} | ${count(s, 'find-sol')} | ${count(s, 'find-ts')} | ${count(s, 'challenge')} | ${rate(sets[s])} |`);
    if (s === 'scored' && hard.size) lines.push(`| of which: the hard pairs | ${sets.scored.filter((id) => hard.has(id)).length} | | | | ${rate(sets.scored.filter((id) => hard.has(id)))} |`, `| of which: the other scored pairs | ${sets.scored.filter((id) => !hard.has(id)).length} | | | | ${rate(sets.scored.filter((id) => !hard.has(id)))} |`);
  }
  lines.push('');
  const vendors = {};
  for (const id of sets.scored) { const a = pairs.find((p) => p.pair === id)?.author ?? 'unknown'; vendors[a] = (vendors[a] ?? 0) + 1; }
  lines.push(`Drafting vendors of the scored set: ${Object.entries(vendors).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([v, n]) => `${v} ${n}`).join(', ')}.`);
  if (classCounts) lines.push('', `Bug classes of the scored find pairs (the label of a held pair is not published, the distribution is): ${Object.entries(classCounts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([c, n]) => `${c} ${n}`).join(', ')}. No class appears more than ${config.class_cap} times.`);
  lines.push('', `A probe is one small model answering both twins of a pair once. "Probes right" is the share of probes that got both twins right; a truncated answer counts as wrong, a call with no answer makes its probe void. Probe models: ${probe.models.map((m) => `\`${m}\``).join(', ')}.`, '', END);
  return lines.join('\n');
}

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

function main() {
  const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const eq = a.indexOf('='); return eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), true]; }));
  const protocolFile = path.join(BENCH, 'protocol.json');
  const protocol = JSON.parse(fs.readFileSync(protocolFile, 'utf8'));
  const config = protocol.selection;
  if (!config) throw new Error('protocol.json has no "selection" (the rule and its parameters)');
  const publicRoot = path.join(BENCH, 'cases'), heldRoot = path.join(BENCH, 'private', 'cases');
  const cases = loadCases([publicRoot, heldRoot]).filter((c) => c.case && c.truth && protocol.arms[c.family]);
  const pairs = pairsOf(cases).filter((p) => Object.keys(p.cases).length === 2);
  const models = config.probe?.models ?? PROBE_MODELS;
  // --repeats N: how many repeats of the probe to read (default: protocol.json selection.probe.repeats)
  const repeats = flags.repeats && flags.repeats !== true ? Number(flags.repeats) : config.probe?.repeats ?? PROBE_DEFAULTS.repeats;
  const store = flags.store && flags.store !== true ? path.resolve(String(flags.store)) : path.join(BENCH, 'runs', 'probe');
  const { calls, stale } = readProbeStore(store, cases, models, repeats);
  const rows = summarise({ cases, calls, models, repeats });
  const classes = (() => { try { return JSON.parse(fs.readFileSync(path.join(BENCH, 'private', 'selection.json'), 'utf8')).classes ?? {}; } catch { return {}; } })();
  const result = selectSets({ pairs, rows, config, classes });
  const probe = {
    models, repeats,
    probes_expected: pairs.length * models.length * repeats,
    probes_complete: rows.reduce((s, r) => s + r.probes, 0),
    calls_expected: cases.length * models.length * repeats,
    calls_answered: calls.filter((c) => c.answered).length,
    probes_void: rows.reduce((s, r) => s + r.void, 0),
    unprobed: rows.filter((r) => r.probes + r.void === 0).map((r) => r.pair),
  };
  // final once every pair the rule has to order (everything outside always_scored) has had all its probes attempted
  const always = new Set(config.always_scored ?? []);
  const attempted = new Map();
  for (const c of calls) attempted.set(c.pair, (attempted.get(c.pair) ?? 0) + 1);
  probe.status = pairs.every((p) => always.has(p.pair) || attempted.get(p.pair) === models.length * repeats * 2) ? 'final' : 'provisional';

  out(`Paydirt set selection: ${pairs.length} pairs; probe store ${path.relative(REPO, store)}: ${probe.calls_answered} of ${probe.calls_expected} calls answered, ${probe.probes_complete} of ${probe.probes_expected} probes complete${stale ? `, ${stale} stored calls ignored (made on an earlier version of the case)` : ''}`);
  for (const family of Object.keys(result.order)) out(`  ${family.padEnd(10)} hardest first: ${result.order[family].map((id) => { const r = rows.find((x) => x.pair === id); return `${id} ${r?.probes ? frac(r.right, r.probes) : 'n/a'}`; }).join(', ')}`);
  for (const s of result.skipped) out(`  skipped ${s.pair}: its bug class is already ${config.class_cap} times in the scored set`);
  for (const s of ['scored', 'public', 'reserve']) out(`  ${s.padEnd(8)} ${String(result[s].length).padStart(2)}: ${result[s].join(' ')}`);
  for (const p of result.problems) out(`  PROBLEM: ${p}`);
  const same = ['scored', 'public', 'reserve'].every((s) => JSON.stringify([...(protocol.sets?.[s] ?? [])].sort()) === JSON.stringify(result[s]));
  const status = probe.status;
  out(`  status: ${status}; protocol.json ${same ? 'already holds this split' : 'holds a DIFFERENT split'}${protocol.selection.status !== status ? ` (and says "${protocol.selection.status}")` : ''}`);
  if (result.problems.length) return 1;
  if (!flags.apply) { if (!same || protocol.selection.status !== status) out('  run with --apply to write it, then "node bench/bench.mjs commit" and "node bench/bench.mjs lint --proofs"'); return same && protocol.selection.status === status ? 0 : 2; }

  // ---- apply
  // 1. case folders and visibility
  const isPublic = new Set(result.public);
  let moved = 0;
  for (const c of cases) {
    const wantPublic = isPublic.has(c.pair);
    const want = path.join(wantPublic ? publicRoot : heldRoot, c.id);
    const caseFile = path.join(c.dir, 'case.json');
    const json = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
    const visibility = wantPublic ? 'public' : 'held';
    if (json.visibility !== visibility) { json.visibility = visibility; writeJson(caseFile, json); }
    if (path.resolve(c.dir) !== path.resolve(want)) { fs.mkdirSync(path.dirname(want), { recursive: true }); fs.renameSync(c.dir, want); moved++; }
  }
  // 1b. the notes of a pair name its case folders; keep those paths true (answer keys and proof notes only, never a workspace)
  let repointed = 0;
  for (const p of pairs) {
    const from = isPublic.has(p.pair) ? 'bench/private/cases/' : 'bench/cases/', to = isPublic.has(p.pair) ? 'bench/cases/' : 'bench/private/cases/';
    const files = [];
    for (const id of Object.values(p.cases)) files.push(path.join(isPublic.has(p.pair) ? publicRoot : heldRoot, id, 'truth.md'));
    const proofDir = path.join(BENCH, 'verify', p.pair);
    try { for (const name of fs.readdirSync(proofDir)) if (/\.(md|mjs)$/.test(name)) files.push(path.join(proofDir, name)); } catch { /* no proof project */ }
    for (const file of files) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const next = text.split(`${from}${p.pair}-`).join(`${to}${p.pair}-`);
      if (next !== text) { fs.writeFileSync(file, next); repointed++; }
    }
  }
  if (repointed) out(`  ${repointed} notes now name the right case folder`);
  // 2. the proofs of public pairs are tracked by git; held ones stay ignored
  const ignoreFile = path.join(BENCH, '.gitignore');
  const ignore = fs.readFileSync(ignoreFile, 'utf8').split('\n').filter((l) => !/^!\/verify\/[^/]+\/$/.test(l.trim()));
  const at = ignore.findIndex((l) => l.trim() === '/verify/*/');
  if (at < 0) throw new Error('bench/.gitignore has no "/verify/*/" line');
  ignore.splice(at + 1, 0, ...result.public.map((id) => `!/verify/${id}/`));
  fs.writeFileSync(ignoreFile, ignore.join('\n'));
  // 3. protocol.json. The sets and the selection facts are part of the core, so the hashes block is written again with them.
  const coreBefore = recordedHashes(protocol).core;
  protocol.sets = { scored: result.scored, public: result.public, reserve: result.reserve };
  const { status: _status, ...probeFacts } = probe;
  protocol.selection = { ...config, status, probe: probeFacts };
  const stamped = stampHashes(protocol);
  writeJson(protocolFile, stamped);
  // 4. METHOD.md: the selection table, and the hashes table that follows protocol.json
  const methodFile = path.join(BENCH, 'METHOD.md');
  const methodBefore = fs.readFileSync(methodFile, 'utf8');
  let method = methodBefore;
  const a = method.indexOf(BEGIN), b = method.indexOf(END);
  const classCounts = {};
  for (const id of result.scored) if (classes[id]) classCounts[classes[id]] = (classCounts[classes[id]] ?? 0) + 1;
  const block = renderMethodBlock({ pairs, rows, sets: result, config, probe, classCounts: Object.keys(classCounts).length ? classCounts : null });
  if (a >= 0 && b > a) method = method.slice(0, a) + block + method.slice(b + END.length);
  else out('  note: METHOD.md has no selection markers; the table was not written');
  method = replaceHashesBlock(method, renderHashesBlock(stamped)) ?? method;
  if (method !== methodBefore) fs.writeFileSync(methodFile, method);
  out(`  applied: ${moved} case folders moved; protocol.json, bench/.gitignore and METHOD.md written.`);
  out(`  core hash: ${stamped.hashes.core.slice(0, 16)}${coreBefore === stamped.hashes.core ? ' (unchanged: stored runs still count)' : ` (was ${coreBefore.slice(0, 16)}: no stored run counts any more, on any arm)`}`);
  out('  next: node bench/bench.mjs commit && node bench/bench.mjs lint --proofs');
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) { try { process.exitCode = main(); } catch (error) { process.stderr.write(`error: ${error.message}\n`); process.exitCode = 1; } }
