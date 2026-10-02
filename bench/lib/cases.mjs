// Paydirt cases: loading, hashing, the workspace copy a model sees, and lint
// (schema, twin discipline, leak checks, and with --proofs the executable proofs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const TRUTH_SCHEMA = 'paydirt.truth/1';
export const FAMILIES = Object.freeze({
  'find-sol': { variants: ['vulnerable', 'fixed'], profile: 'solidity', ext: ['.sol'] },
  'find-ts': { variants: ['vulnerable', 'fixed'], profile: 'general', ext: ['.ts', '.tsx'] },
  // a challenge workspace may also carry the papers a triager has next to the code: the
  // programme rules, a changelog and a deployments manifest (workspace root only)
  challenge: { variants: ['overclaimed', 'accurate'], profile: 'report', ext: ['.sol', '.ts', '.tsx'], docs: ['programme.md', 'CHANGELOG.md', 'deployments.json'] },
});
export const DRAFT = 'draft-report.md';
/** Is `file` (workspace-relative) a supporting document that its family allows next to the sources? */
export const isSupportingDoc = (family, file) => (FAMILIES[family]?.docs ?? []).includes(file);
const RATED = ['critical', 'high', 'medium', 'low', 'info'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Every file under `dir`, as sorted posix-style relative paths (dotfiles included). */
export function listFiles(dir, skip = () => false) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip(r, e)) continue;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

function countLines(text) {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function readJson(file, problems, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { problems.push(`${label}: ${e.code === 'ENOENT' ? 'missing' : `not valid JSON (${e.message})`}`); return null; }
}

/** Load one case directory. Never throws; structural problems are collected in `problems`. */
export function loadCase(dir) {
  const problems = [];
  const id = path.basename(dir);
  const kase = { id, dir, problems, case: readJson(path.join(dir, 'case.json'), problems, 'case.json'), truth: readJson(path.join(dir, 'truth.json'), problems, 'truth.json'), truthMd: null, workspace: [], entries: [] };
  try { kase.truthMd = fs.readFileSync(path.join(dir, 'truth.md'), 'utf8'); } catch { problems.push('truth.md: missing'); }
  try { kase.entries = fs.readdirSync(dir).sort(); } catch { /* reported above */ }
  const ws = path.join(dir, 'workspace');
  if (!fs.existsSync(ws)) problems.push('workspace/: missing');
  for (const rel of listFiles(ws)) {
    const bytes = fs.readFileSync(path.join(ws, rel));
    let text = null;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* reported by lint */ }
    kase.workspace.push({ path: rel, bytes, text, sha256: sha256(bytes), lines: text === null ? 0 : countLines(text) });
  }
  kase.pair = kase.case?.pair ?? null;
  kase.family = kase.case?.family ?? null;
  kase.variant = kase.case?.variant ?? null;
  kase.inputHash = inputHash(kase);
  return kase;
}

/**
 * Hash of everything a model can see for this case (the task fields and the workspace).
 * Answer keys are not part of it, so correcting a truth file does not invalidate stored runs.
 */
export function inputHash(kase) {
  const h = crypto.createHash('sha256');
  h.update('paydirt.input/1\n');
  h.update(JSON.stringify({ id: kase.id, family: kase.case?.family ?? null, profile: kase.case?.profile ?? null, focus: kase.case?.focus ?? null }));
  for (const f of kase.workspace) h.update(`\n${f.path}\0${f.sha256}`);
  return h.digest('hex');
}

/** Hash of the whole case directory (inputs and answer key), used for held-case commitments. */
export function caseHash(kase) {
  const h = crypto.createHash('sha256');
  h.update('paydirt.case/1');
  for (const rel of listFiles(kase.dir)) h.update(`\n${rel}\0${sha256(fs.readFileSync(path.join(kase.dir, rel)))}`);
  return h.digest('hex');
}

/** Glob with * and ? over case ids; comma-separated alternatives. */
export function matchGlob(text, pattern) {
  if (!pattern) return true;
  return String(pattern).split(',').map((p) => p.trim()).filter(Boolean).some((p) => {
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return re.test(text);
  });
}

/** Load every case under the given roots (a root is a directory of case directories). */
export function loadCases(roots, { glob = null } = {}) {
  const cases = [];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith('_') || !matchGlob(name, glob)) continue;
      const kase = loadCase(path.join(root, name));
      kase.root = root;
      cases.push(kase);
    }
  }
  return cases;
}

/** Group cases into pairs. `author` is the vendor part of truth.assistant (the drafting model). */
export function pairsOf(cases) {
  const map = new Map();
  for (const c of cases) {
    if (!c.pair) continue;
    if (!map.has(c.pair)) map.set(c.pair, { pair: c.pair, family: c.family, visibility: c.case?.visibility ?? 'held', author: null, cases: {}, members: [] });
    const p = map.get(c.pair);
    p.members.push(c);
    if (c.variant) p.cases[c.variant] = c.id;
    if (c.case?.visibility !== 'public') p.visibility = 'held';
    const assistant = c.truth?.assistant;
    if (!p.author && typeof assistant === 'string' && assistant.trim()) p.author = assistant.split('/')[0].trim().toLowerCase();
  }
  for (const p of map.values()) p.author ??= 'unknown';
  return [...map.values()].sort((a, b) => (a.pair < b.pair ? -1 : 1));
}

/** Write the model-visible files of a case into `dest` (created fresh). Nothing else is copied. */
export function copyWorkspace(kase, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of kase.workspace) {
    const target = path.join(dest, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.bytes);
  }
}

// ---------------------------------------------------------------- line diff

/** Changed hunks between two line arrays: [{ a: [start, end), b: [start, end) }] (0-based, end exclusive). */
export function diffHunks(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf), y = b.slice(pre, b.length - suf);
  const n = x.length, m = y.length;
  if (!n && !m) return [];
  if (n * m > 4_000_000) return [{ a: [pre, pre + n], b: [pre, pre + m] }];
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
  }
  const hunks = [];
  let i = 0, j = 0, open = null;
  const close = () => { if (open) { hunks.push({ a: [open.i + pre, i + pre], b: [open.j + pre, j + pre] }); open = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { close(); i++; j++; continue; }
    open ??= { i, j };
    if (j >= m || (i < n && table[(i + 1) * w + j] >= table[i * w + j + 1])) i++; else j++;
  }
  close();
  return hunks;
}

const within = (line, ranges, tol = 0) => ranges.some(([s, e]) => line >= s - tol && line <= e + tol);

// ---------------------------------------------------------------- lint

const FORBIDDEN_NAME = /(^|\/)(truth\.(json|md)|case\.json|agents\.md|claude\.md|gemini\.md|\.mcp\.json|\.env(\..*)?)$|(^|\/)\.[^/]+(\/|$)|\.t\.sol$|\.(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__)\//i;
const LEAK_NAME = /vulnerab|fixed|patched|insecure|exploit/i;
const HINT = /\b(vulnerab\w*|exploit\w*|decoy|planted|@audit\w*|bug|hack\w*|FIXME|XXX)\b/i;

function isRanges(value) {
  return Array.isArray(value) && value.length > 0 && value.every((r) => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 1 && r[1] >= r[0]);
}

/** Split "<file>:<test name>" at the last colon. */
export function splitProofRef(ref) {
  if (typeof ref !== 'string') return null;
  const at = ref.lastIndexOf(':');
  if (at <= 0 || at === ref.length - 1) return null;
  return { file: ref.slice(0, at).replace(/\\/g, '/'), test: ref.slice(at + 1).trim() };
}

/** Resolve a proof reference to a file on disk. Engineers write it relative to the proof project, to bench/, or to the repo root. */
export function resolveProof(ref, { benchDir, pair }) {
  const parts = splitProofRef(ref);
  if (!parts) return null;
  const project = path.join(benchDir, 'verify', pair);
  for (const base of [project, benchDir, path.dirname(benchDir)]) {
    const abs = path.join(base, ...parts.file.split('/'));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { ...parts, abs, rel: path.relative(project, abs).replace(/\\/g, '/') };
  }
  return { ...parts, abs: null, rel: null };
}

/**
 * Static lint of loaded cases. Returns { errors: [], warnings: [] }, each entry
 * { scope: <case or pair id>, rule, message }.
 *   opts.benchDir     bench/ (to find proof projects)
 *   opts.checkInputs  optional async (files) => { blocking, warnings } from the product engine
 */
export async function lintCases(cases, opts = {}) {
  const errors = [], warnings = [];
  const err = (scope, rule, message) => errors.push({ scope, rule, message });
  const warn = (scope, rule, message) => warnings.push({ scope, rule, message });
  const canaries = new Map();

  for (const c of cases) {
    const id = c.id;
    for (const p of c.problems) err(id, 'layout', p);
    for (const e of c.entries) if (!['case.json', 'truth.json', 'truth.md', 'workspace'].includes(e)) warn(id, 'layout', `unexpected entry in the case directory: ${e}`);
    if (!c.case || !c.truth) continue;
    const k = c.case, t = c.truth;
    const fam = FAMILIES[k.family];

    // case.json
    if (k.id !== id) err(id, 'case.id', `case.json id "${k.id}" does not match the directory name`);
    if (typeof k.pair !== 'string' || !k.pair || !String(k.id).startsWith(`${k.pair}-`)) err(id, 'case.pair', 'pair must be a non-empty prefix of id (id = <pair>-<suffix>)');
    if (!fam) { err(id, 'case.family', `family must be one of ${Object.keys(FAMILIES).join(', ')}`); continue; }
    if (!fam.variants.includes(k.variant)) err(id, 'case.variant', `variant "${k.variant}" is not valid for ${k.family} (${fam.variants.join(' | ')})`);
    if (k.profile !== fam.profile) err(id, 'case.profile', `profile must be "${fam.profile}" for ${k.family} (got "${k.profile}")`);
    if (!['held', 'public'].includes(k.visibility)) err(id, 'case.visibility', 'visibility must be "held" or "public"');
    const inPrivate = /[\\/]private[\\/]/.test(c.dir);
    if (k.visibility === 'held' && !inPrivate && /[\\/]bench[\\/]cases[\\/]/.test(c.dir)) err(id, 'case.visibility', 'a held case must not live in bench/cases (it would be published)');
    if (k.visibility === 'public' && inPrivate) warn(id, 'case.visibility', 'case is marked public but still lives under bench/private');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(k.authored ?? ''))) err(id, 'case.authored', 'authored must be YYYY-MM-DD');
    if (typeof k.focus !== 'string' || !k.focus.trim() || /[\r\n]/.test(k.focus.trim())) err(id, 'case.focus', 'focus must be one non-empty line');
    const files = Array.isArray(k.files) ? k.files : [];
    if (!files.length || files.some((f) => typeof f !== 'string' || !f || f.startsWith('/') || f.includes('\\') || f.split('/').includes('..'))) err(id, 'case.files', 'files must be a non-empty list of workspace-relative posix paths');

    // workspace
    const wsMap = new Map(c.workspace.map((f) => [f.path, f]));
    for (const f of files) if (!wsMap.has(f)) err(id, 'workspace.missing', `listed file is not in workspace/: ${f}`);
    for (const f of c.workspace) {
      const isDraft = k.family === 'challenge' && f.path === DRAFT;
      const isDoc = isSupportingDoc(k.family, f.path); // programme.md, CHANGELOG.md, deployments.json of a challenge case
      if (!files.includes(f.path) && !isDraft) err(id, 'workspace.extra', `workspace/ holds a file that case.json does not list: ${f.path}`);
      if (FORBIDDEN_NAME.test(f.path)) err(id, 'workspace.forbidden', `truth, test, dotfile or agent-context file in workspace/: ${f.path}`);
      if (LEAK_NAME.test(f.path)) err(id, 'workspace.name-leak', `file name reveals the variant: ${f.path}`);
      if (!isDraft && !isDoc && !fam.ext.includes(path.extname(f.path).toLowerCase())) warn(id, 'workspace.type', `unexpected file type for ${k.family}: ${f.path}`);
      if (f.text === null) { err(id, 'encoding', `${f.path} is not valid UTF-8`); continue; }
      if (f.text.includes('\0')) err(id, 'encoding', `${f.path} contains NUL bytes`);
      if (f.text.includes('\r')) err(id, 'line-endings', `${f.path} has CR characters (LF only)`);
      if (f.text && !f.text.endsWith('\n')) warn(id, 'line-endings', `${f.path} does not end with a newline`);
      if (!isDraft && !isDoc && f.lines > 400) warn(id, 'realism', `${f.path} has ${f.lines} lines (target 120-400)`);
      const lower = f.text.toLowerCase();
      for (const needle of [id, k.pair, 'paydirt', 'truth.json', 'canary']) {
        if (typeof needle === 'string' && needle && lower.includes(needle.toLowerCase())) err(id, 'leak', `${f.path} contains "${needle}"`);
      }
      if (!isDraft && !isDoc) { // the papers of a bounty programme say "bug" and "exploit" for ordinary reasons
        const lines = f.text.split('\n');
        let shown = 0;
        for (let i = 0; i < lines.length && shown < 4; i++) {
          const m = HINT.exec(lines[i]);
          if (m) { warn(id, 'hint', `${f.path}:${i + 1} contains "${m[0]}" (check it does not give the answer away)`); shown++; }
        }
      }
    }
    if (k.family === 'challenge' && !wsMap.has(DRAFT)) err(id, 'workspace.draft', `challenge cases need workspace/${DRAFT}`);
    const sources = c.workspace.filter((f) => f.path !== DRAFT && !isSupportingDoc(k.family, f.path));
    if (sources.length < 1 || sources.length > 3) warn(id, 'realism', `${sources.length} source files (target 1-3)`);
    const longest = Math.max(0, ...sources.map((f) => f.lines));
    if (sources.length && longest < 120) warn(id, 'realism', `the longest source file has ${longest} lines (target 120-400)`);
    for (const meta of ['case.json', 'truth.json', 'truth.md']) {
      try { if (fs.readFileSync(path.join(c.dir, meta), 'utf8').includes('\r')) err(id, 'line-endings', `${meta} has CR characters (LF only)`); } catch { /* reported as layout */ }
    }

    // truth.json
    if (t.schema !== TRUTH_SCHEMA) err(id, 'truth.schema', `schema must be "${TRUTH_SCHEMA}"`);
    if (t.pair !== k.pair || t.variant !== k.variant) err(id, 'truth.identity', 'truth.json pair/variant do not match case.json');
    if (t.origin !== 'original') err(id, 'truth.origin', 'origin must be "original" (no reused material)');
    if (typeof t.assistant !== 'string' || !t.assistant.trim()) err(id, 'truth.assistant', 'assistant must name the drafting model slug');
    if (typeof t.canary !== 'string' || !UUID.test(t.canary)) err(id, 'truth.canary', 'canary must be a UUID');
    else {
      if (canaries.has(t.canary)) err(id, 'truth.canary', `canary is shared with ${canaries.get(t.canary)}`);
      canaries.set(t.canary, id);
      const needle = t.canary.toLowerCase();
      for (const f of c.workspace) if (f.text?.toLowerCase().includes(needle)) err(id, 'leak', `the canary appears in workspace/${f.path}`);
      if (JSON.stringify(k).toLowerCase().includes(needle)) err(id, 'leak', 'the canary appears in case.json');
    }
    if (!c.truthMd || !c.truthMd.trim()) err(id, 'truth.md', 'truth.md is empty');

    const region = (label, r, { needFunctions = true } = {}) => {
      if (!r || typeof r !== 'object') { err(id, 'truth.region', `${label}: missing`); return; }
      const f = wsMap.get(r.file);
      if (!f) { err(id, 'truth.region', `${label}: file "${r.file}" is not in the workspace`); return; }
      if (!isRanges(r.lines)) { err(id, 'truth.region', `${label}: lines must be [[start, end], ...] with 1 <= start <= end`); return; }
      for (const [a, b] of r.lines) if (b > f.lines) err(id, 'truth.lines', `${label}: lines ${a}-${b} are past the end of ${r.file} (${f.lines} lines)`);
      const fns = Array.isArray(r.functions) ? r.functions : [];
      if (needFunctions && (!fns.length || fns.some((n) => typeof n !== 'string' || !n))) err(id, 'truth.functions', `${label}: functions must be a non-empty list of names`);
      for (const n of fns) if (typeof n === 'string' && n && f.text !== null && !new RegExp(`(^|[^\\w$])${n.replace(/[$]/g, '\\$')}([^\\w$]|$)`).test(f.text)) err(id, 'truth.functions', `${label}: "${n}" does not occur in ${r.file}`);
    };
    const proofRef = (label, ref) => {
      if (!opts.benchDir || k.family === 'challenge') return;
      const r = resolveProof(ref, { benchDir: opts.benchDir, pair: k.pair });
      if (!r) { err(id, 'truth.proof', `${label}: proof must be "<test file>:<test name>"`); return; }
      if (!r.abs) { err(id, 'truth.proof', `${label}: proof file not found: ${r.file}`); return; }
      if (fs.readFileSync(r.abs, 'utf8').includes(r.test)) return;
      // the test may be inherited from a shared base in the same proof project
      const project = path.join(opts.benchDir, 'verify', k.pair);
      const skip = (rel, e) => e.isDirectory() && (['out', 'cache', 'node_modules', 'broadcast'].includes(e.name) || rel === 'lib' || rel === 'src');
      const elsewhere = listFiles(project, skip).some((rel) => { try { return fs.readFileSync(path.join(project, rel), 'utf8').includes(r.test); } catch { return false; } });
      if (!elsewhere) err(id, 'truth.proof', `${label}: test "${r.test}" not found in ${r.file} or anywhere in the proof project`);
    };

    const planted = Array.isArray(t.planted) ? t.planted : null;
    if (!planted) err(id, 'truth.planted', 'planted must be an array');
    const seen = new Set();
    for (const p of planted ?? []) {
      const label = `planted ${p?.id ?? '?'}`;
      if (typeof p?.id !== 'string' || seen.has(p.id)) err(id, 'truth.planted', `${label}: ids must be unique strings`);
      seen.add(p?.id);
      if (typeof p?.primary !== 'boolean') err(id, 'truth.planted', `${label}: primary must be true or false`);
      region(label, p);
      if (!Array.isArray(p?.severity) || !p.severity.length || p.severity.some((s) => !RATED.includes(s))) err(id, 'truth.severity', `${label}: severity must list accepted levels from ${RATED.join(', ')}`);
      if (typeof p?.mechanism !== 'string' || !p.mechanism.trim()) err(id, 'truth.planted', `${label}: mechanism is required`);
      proofRef(label, p?.proof);
    }
    for (const d of Array.isArray(t.decoys) ? t.decoys : []) {
      const label = `decoy ${d?.id ?? '?'}`;
      region(label, d);
      if (typeof d?.why !== 'string' || !d.why.trim()) err(id, 'truth.decoy', `${label}: why is required`);
      proofRef(label, d?.proof);
    }
    if (!Array.isArray(t.decoys)) err(id, 'truth.decoys', 'decoys must be an array');
    else if (k.family !== 'challenge' && (t.decoys.length < 1 || t.decoys.length > 3)) warn(id, 'truth.decoys', `${t.decoys.length} decoys (target one or two)`);
    for (const a of Array.isArray(t.acceptable) ? t.acceptable : []) region('acceptable entry', a, { needFunctions: false });

    if (k.variant === 'vulnerable') {
      if (!(planted ?? []).some((p) => p?.primary === true)) err(id, 'truth.planted', 'a vulnerable variant needs at least one primary planted bug');
      if (t.patched_region !== null) err(id, 'truth.patched_region', 'patched_region must be null on a vulnerable variant');
    }
    if (k.variant === 'fixed') {
      if ((planted ?? []).length) err(id, 'truth.planted', 'planted must be [] on a fixed variant');
      region('patched_region', t.patched_region);
    }
    if (k.family === 'challenge') {
      const r = t.report;
      const draft = wsMap.get(DRAFT);
      if (!r || typeof r !== 'object') err(id, 'truth.report', 'challenge cases need a report object');
      else {
        const want = k.variant === 'overclaimed' ? 'overclaimed' : 'supported';
        if (r.verdict !== want) err(id, 'truth.report', `report.verdict must be "${want}" on the ${k.variant} draft`);
        if (![...RATED, 'unrated'].includes(r.max_severity)) err(id, 'truth.report', 'report.max_severity must be a severity level');
        const claims = Array.isArray(r.false_claims) ? r.false_claims : null;
        if (!claims) err(id, 'truth.report', 'report.false_claims must be an array');
        else if (k.variant === 'overclaimed' && !claims.length) err(id, 'truth.report', 'an overclaimed draft needs at least one false claim');
        else if (k.variant === 'accurate' && claims.length) err(id, 'truth.report', 'an accurate draft must have no false claims');
        for (const cl of claims ?? []) {
          if (!isRanges(cl?.draft_lines)) err(id, 'truth.report', `false claim ${cl?.id ?? '?'}: draft_lines must be [[start, end], ...]`);
          else if (draft) for (const [a, b] of cl.draft_lines) if (b > draft.lines) err(id, 'truth.lines', `false claim ${cl.id}: lines ${a}-${b} are past the end of ${DRAFT} (${draft.lines} lines)`);
        }
      }
    } else if (t.report !== null && t.report !== undefined) err(id, 'truth.report', 'report must be null outside the challenge family');

    if (opts.checkInputs) {
      try {
        const res = await opts.checkInputs(c.workspace.filter((f) => f.text !== null).map((f) => ({ name: f.path, content: f.text })));
        // informational: the benchmark never sends files through the product's uploader, but a
        // public case that the hosted product refuses would be awkward to demo
        if (res.blocking > 0) warn(id, 'engine.checkInputs', `the hosted product's input check would refuse this workspace (${res.kinds.join(', ')})`);
        else if (res.warnings > 0) warn(id, 'engine.checkInputs', `the hosted product's input check warns on this workspace (${res.kinds.join(', ')})`);
      } catch (e) { warn(id, 'engine.checkInputs', `could not run the product's input check: ${e.message}`); }
    }
  }

  // pairs
  for (const p of pairsOf(cases)) {
    const fam = FAMILIES[p.family];
    if (!fam) continue;
    const scope = p.pair;
    const byVariant = new Map(p.members.map((m) => [m.variant, m]));
    if (p.members.length !== 2 || !fam.variants.every((v) => byVariant.has(v))) { err(scope, 'pair.members', `a ${p.family} pair needs exactly one ${fam.variants.join(' and one ')} case (found: ${p.members.map((m) => `${m.id}=${m.variant}`).join(', ')})`); continue; }
    const [a, b] = fam.variants.map((v) => byVariant.get(v));
    if (!a.case || !b.case || !a.truth || !b.truth) continue;
    for (const key of ['family', 'profile', 'focus', 'visibility']) if (a.case[key] !== b.case[key]) err(scope, 'pair.task', `${key} differs between the twins (the task text must not reveal the variant)`);
    if (JSON.stringify(a.case.files) !== JSON.stringify(b.case.files)) err(scope, 'pair.files', 'the twins list different files');
    if (a.truth.assistant !== b.truth.assistant) warn(scope, 'pair.assistant', 'the twins record different drafting models');
    const aw = new Map(a.workspace.map((f) => [f.path, f])), bw = new Map(b.workspace.map((f) => [f.path, f]));
    const names = [...new Set([...aw.keys(), ...bw.keys()])].sort();
    const differing = names.filter((n) => aw.get(n)?.sha256 !== bw.get(n)?.sha256);

    if (p.family === 'challenge') {
      for (const n of differing) if (n !== DRAFT) err(scope, 'pair.twin', `${n} differs between the two drafts' workspaces (only ${DRAFT} may differ)`);
      if (!differing.includes(DRAFT)) err(scope, 'pair.twin', `${DRAFT} is identical in both variants`);
      continue;
    }
    if (opts.benchDir && !fs.existsSync(path.join(opts.benchDir, 'verify', p.pair))) err(scope, 'pair.proof', `no proof project at bench/verify/${p.pair}`);
    const patch = b.truth.patched_region;
    if (!differing.length) { err(scope, 'pair.twin', 'the vulnerable and fixed workspaces are identical'); continue; }
    if (!patch || !isRanges(patch.lines)) continue;
    let changed = 0;
    for (const n of differing) {
      if (n !== patch.file) { err(scope, 'pair.twin', `${n} differs between the twins but the patch is in ${patch.file}`); continue; }
      const va = aw.get(n), fb = bw.get(n);
      if (!va || !fb || va.text === null || fb.text === null) { err(scope, 'pair.twin', `${n} is missing or unreadable in one twin`); continue; }
      const hunks = diffHunks(va.text.split('\n'), fb.text.split('\n'));
      const plantedRanges = (a.truth.planted ?? []).filter((x) => x.file === n && isRanges(x.lines)).flatMap((x) => x.lines);
      let nearPlanted = false;
      for (const h of hunks) {
        changed += Math.max(h.a[1] - h.a[0], h.b[1] - h.b[0]);
        const fixedLines = h.b[1] > h.b[0] ? Array.from({ length: h.b[1] - h.b[0] }, (_, i) => h.b[0] + 1 + i) : null;
        const ok = fixedLines ? fixedLines.every((l) => within(l, patch.lines)) : within(h.b[0], patch.lines, 1) || within(h.b[0] + 1, patch.lines, 1);
        if (!ok) err(scope, 'pair.twin', `${n}: the twins differ at fixed-file lines ${h.b[0] + 1}-${Math.max(h.b[1], h.b[0] + 1)}, outside patched_region ${JSON.stringify(patch.lines)}`);
        for (let l = h.a[0]; l <= Math.max(h.a[1], h.a[0] + 1); l++) if (within(l, plantedRanges, 3)) nearPlanted = true;
      }
      if (hunks.length && plantedRanges.length && !nearPlanted) warn(scope, 'pair.twin', `${n}: the patch does not touch the planted lines of the vulnerable variant`);
    }
    if (changed > 30) warn(scope, 'pair.twin', `the patch changes ${changed} lines (keep twins minimal)`);
    const ids = (t) => (t.decoys ?? []).map((d) => d.id).sort().join(',');
    if (ids(a.truth) !== ids(b.truth)) warn(scope, 'pair.decoys', 'the twins list different decoys');
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------- executable proofs

function findBinary(name, envVar, extraDirs) {
  if (process.env[envVar]) return process.env[envVar];
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) for (const ext of exts) {
    const candidate = path.join(dir, name + ext);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/** Run `forge test --json` and return Map("<test file>" -> Map(testName -> 'pass'|'fail'|'skip')). */
function forgeResults(forge, project, profile) {
  const env = { ...process.env };
  if (profile) env.FOUNDRY_PROFILE = profile; else delete env.FOUNDRY_PROFILE;
  const r = spawnSync(forge, ['test', '--offline', '--json'], { cwd: project, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000, windowsHide: true });
  if (r.error) return { error: `forge could not run: ${r.error.message}` };
  const line = String(r.stdout ?? '').split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  let json;
  try { json = JSON.parse(line); } catch { return { error: `forge produced no JSON result (exit ${r.status}): ${String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 600)}` }; }
  const suites = new Map();
  for (const [key, suite] of Object.entries(json)) {
    const file = key.slice(0, key.lastIndexOf(':')).replace(/\\/g, '/');
    const tests = suites.get(file) ?? new Map();
    for (const [name, res] of Object.entries(suite?.test_results ?? {})) {
      const status = String(res?.status ?? '').toLowerCase();
      tests.set(name.replace(/\(.*$/, ''), status === 'success' ? 'pass' : status === 'skipped' ? 'skip' : 'fail');
    }
    suites.set(file, tests);
  }
  return { suites };
}

/** Per-test outcomes from a node test run: TAP lines, "ok name" lines, or a trailing JSON summary. */
export function parseNodeTestOutput(stdout) {
  const results = new Map();
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const tap = /^(not ok|ok)\s+(?:\d+\s+-\s+)?(.+?)\s*(?:#.*)?$/.exec(raw);
    if (tap && !/^\s/.test(raw)) { results.set(tap[2].trim(), tap[1] === 'ok' ? 'pass' : 'fail'); continue; }
    const at = raw.indexOf('{');
    if (at < 0 || !/^(PAYDIRT_RESULT\s+)?\{/.test(raw.trim())) continue;
    try {
      const j = JSON.parse(raw.slice(at));
      if (j.results && typeof j.results === 'object') for (const [n, v] of Object.entries(j.results)) results.set(n, /pass|ok|true/i.test(String(v)) ? 'pass' : 'fail');
      for (const n of Array.isArray(j.passed) ? j.passed : []) results.set(n, 'pass');
      for (const n of Array.isArray(j.failed) ? j.failed : []) results.set(n, 'fail');
    } catch { /* not a summary line */ }
  }
  return results;
}

const lookup = (results, name) => {
  if (results.has(name)) return results.get(name);
  for (const [k, v] of results) if (k.startsWith(`${name} `) || k.startsWith(`${name}:`) || k.startsWith(`${name}(`)) return v;
  return undefined;
};

function nodeResults(project, variantCase, testFile) {
  const env = { ...process.env, PAYDIRT_VARIANT: variantCase.variant, PAYDIRT_VARIANT_DIR: path.join(variantCase.dir, 'workspace'), PAYDIRT_VARIANT_SRC: path.join(variantCase.dir, 'workspace', 'src'), PAYDIRT_CASE_DIR: variantCase.dir };
  delete env.NODE_OPTIONS;
  const runner = path.join(project, 'run.mjs');
  const args = fs.existsSync(runner) ? [runner, variantCase.dir] : ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', testFile];
  const r = spawnSync(process.execPath, args, { cwd: project, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, windowsHide: true });
  if (r.error) return { error: `node could not run the proof: ${r.error.message}` };
  const results = parseNodeTestOutput(r.stdout);
  if (!results.size) return { error: `the proof run reported no tests (exit ${r.status}): ${String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 500)}` };
  return { results };
}

/**
 * Run each find pair's proof. The planted proof must pass on the vulnerable variant and
 * fail on the fixed twin; every decoy proof must pass on the variant that lists it; the
 * proof must be built from the same sources the model sees.
 * Supported layouts:
 *   Solidity  foundry.toml with [profile.vulnerable] + [profile.fixed], or one profile with a
 *             test file per variant (the fixed file repeats the planted test and it fails there)
 *   TypeScript  run.mjs <case dir> (preferred), else node --test with PAYDIRT_VARIANT_DIR set
 */
export function lintProofs(cases, { benchDir, log = () => {} } = {}) {
  const errors = [], warnings = [];
  const err = (scope, rule, message) => errors.push({ scope, rule, message });
  const forge = findBinary('forge', 'PAYDIRT_FORGE', [path.join(os.homedir(), '.foundry', 'bin')]);
  for (const p of pairsOf(cases)) {
    if (p.family === 'challenge') {
      // A challenge pair has no planted test. Its proof project holds the tests behind the
      // answer key (the accurate draft's claims hold, each false claim of the overclaimed
      // draft is refuted). The project must compile the code the model sees, and every test
      // in it must pass.
      const project = path.join(benchDir, 'verify', p.pair);
      if (!fs.existsSync(path.join(project, 'foundry.toml'))) { warnings.push({ scope: p.pair, rule: 'proof.project', message: `no Foundry proof project at bench/verify/${p.pair}; the answer key of this challenge pair is not backed by tests` }); continue; }
      if (!forge) { err(p.pair, 'proof.forge', 'forge not found (set PAYDIRT_FORGE or add Foundry to PATH)'); continue; }
      log(`proof ${p.pair} ...`);
      const started = Date.now();
      const skip = (rel, e) => e.isDirectory() && (['out', 'cache', 'node_modules', 'broadcast'].includes(e.name) || rel === 'lib');
      const hashes = new Set(listFiles(project, skip).map((rel) => sha256(fs.readFileSync(path.join(project, rel)))));
      for (const kase of p.members) for (const f of kase.workspace) {
        if (!FAMILIES.challenge.ext.includes(path.extname(f.path).toLowerCase())) continue; // the draft and the papers are not compiled
        if (!hashes.has(f.sha256)) err(p.pair, 'proof.sources', `${kase.id}: workspace/${f.path} is not byte-identical to a source in the proof project`);
      }
      const R = forgeResults(forge, project, null);
      if (R.error) { err(p.pair, 'proof.run', R.error); continue; }
      let ran = 0;
      for (const [file, tests] of R.suites) for (const [name, status] of tests) {
        ran++;
        if (status !== 'pass') err(p.pair, 'proof.result', `${file}:${name} should pass but was "${status}"`);
      }
      if (!ran) err(p.pair, 'proof.result', 'the proof project ran no tests');
      log(`proof ${p.pair} done in ${((Date.now() - started) / 1000).toFixed(1)}s (${ran} tests)`);
      continue;
    }
    const vul = p.members.find((m) => m.variant === 'vulnerable'), fix = p.members.find((m) => m.variant === 'fixed');
    if (!vul?.truth || !fix?.truth) continue;
    const project = path.join(benchDir, 'verify', p.pair);
    if (!fs.existsSync(project)) { err(p.pair, 'proof.project', `no proof project at bench/verify/${p.pair}`); continue; }
    const refs = (kase, list) => (list ?? []).map((x) => ({ id: x.id, ...(resolveProof(x.proof, { benchDir, pair: p.pair }) ?? {}) }));
    const planted = refs(vul, vul.truth.planted), decoyV = refs(vul, vul.truth.decoys), decoyF = refs(fix, fix.truth.decoys);
    if (!planted.length) { err(p.pair, 'proof.planted', 'the vulnerable variant lists no planted proof'); continue; }
    log(`proof ${p.pair} ...`);
    const started = Date.now();

    if (p.family === 'find-sol') {
      if (!forge) { err(p.pair, 'proof.forge', 'forge not found (set PAYDIRT_FORGE or add Foundry to PATH)'); continue; }
      // the proof must compile the sources the model sees
      const skip = (rel, e) => e.isDirectory() && (['out', 'cache', 'node_modules', 'broadcast'].includes(e.name) || rel === 'lib');
      const projectFiles = listFiles(project, skip).map((rel) => ({ rel, sha: sha256(fs.readFileSync(path.join(project, rel))) }));
      const hasVariantDirs = projectFiles.some((f) => /(^|\/)(vulnerable|fixed)\//i.test(f.rel));
      for (const kase of [vul, fix]) for (const f of kase.workspace) {
        const same = projectFiles.filter((x) => x.sha === f.sha256);
        const okHere = hasVariantDirs ? same.some((x) => new RegExp(`(^|/)${kase.variant}/`, 'i').test(x.rel)) : same.length > 0;
        if (!okHere) err(p.pair, 'proof.sources', `${kase.id}: workspace/${f.path} is not byte-identical to a ${hasVariantDirs ? `${kase.variant}/ ` : ''}source in the proof project`);
      }
      let toml = '';
      try { toml = fs.readFileSync(path.join(project, 'foundry.toml'), 'utf8'); } catch { err(p.pair, 'proof.project', 'foundry.toml is missing'); continue; }
      const profiles = /^\s*\[profile\.vulnerable\]/m.test(toml) && /^\s*\[profile\.fixed\]/m.test(toml);
      const expectPass = (suites, ref, label) => {
        const got = ref.rel ? lookup(suites.get(ref.rel) ?? new Map(), ref.test) : undefined;
        if (got !== 'pass') err(p.pair, 'proof.result', `${label} ${ref.file}:${ref.test} should pass but ${got === undefined ? 'was not run' : `was "${got}"`}`);
      };
      if (profiles) {
        const V = forgeResults(forge, project, 'vulnerable'), F = forgeResults(forge, project, 'fixed');
        if (V.error || F.error) { err(p.pair, 'proof.run', V.error ?? F.error); continue; }
        for (const ref of planted) {
          expectPass(V.suites, ref, `planted ${ref.id} (vulnerable profile)`);
          const got = lookup(F.suites.get(ref.rel) ?? new Map(), ref.test);
          if (got !== 'fail') err(p.pair, 'proof.result', `planted ${ref.id} ${ref.file}:${ref.test} should fail under the fixed profile but ${got === undefined ? 'was not run' : `was "${got}"`}`);
        }
        for (const ref of decoyV) expectPass(V.suites, ref, `decoy ${ref.id} (vulnerable profile)`);
        for (const ref of decoyF) expectPass(F.suites, ref, `decoy ${ref.id} (fixed profile)`);
      } else {
        const R = forgeResults(forge, project, null);
        if (R.error) { err(p.pair, 'proof.run', R.error); continue; }
        const expectedFailures = new Set();
        const fixedFiles = new Set();
        for (const ref of planted) {
          expectPass(R.suites, ref, `planted ${ref.id}`);
          const candidates = [...new Set([...decoyF.map((d) => d.rel), ref.rel?.replace(/vulnerable/gi, (m) => (m[0] === 'V' ? (m[1] === 'U' ? 'FIXED' : 'Fixed') : 'fixed'))].filter((x) => x && x !== ref.rel))];
          for (const [file, tests] of R.suites) if (file !== ref.rel && !candidates.includes(file) && lookup(tests, ref.test) !== undefined) candidates.push(file);
          const twin = candidates.find((file) => lookup(R.suites.get(file) ?? new Map(), ref.test) !== undefined);
          if (!twin) { err(p.pair, 'proof.result', `planted ${ref.id}: no test named ${ref.test} runs against the fixed sources (expected a fixed-variant test file that repeats it)`); continue; }
          const got = lookup(R.suites.get(twin), ref.test);
          if (got !== 'fail') err(p.pair, 'proof.result', `planted ${ref.id}: ${twin}:${ref.test} should fail on the fixed twin but was "${got}"`);
          expectedFailures.add(`${twin}:${ref.test}`);
          fixedFiles.add(twin);
        }
        for (const ref of [...decoyV, ...decoyF]) expectPass(R.suites, ref, `decoy ${ref.id}`);
        // further exploit variants (other "planted" tests) may also fail on the fixed sources; nothing else may fail
        for (const [file, tests] of R.suites) for (const [name, status] of tests) {
          if (status !== 'fail' || expectedFailures.has(`${file}:${name}`)) continue;
          if (fixedFiles.has(file) && /planted/i.test(name)) continue;
          err(p.pair, 'proof.result', `unexpected failing test ${file}:${name}`);
        }
      }
    } else {
      const testFile = planted[0].abs;
      if (!testFile) { err(p.pair, 'proof.project', `proof file not found: ${planted[0].file}`); continue; }
      const V = nodeResults(project, vul, testFile), F = nodeResults(project, fix, testFile);
      if (V.error || F.error) { err(p.pair, 'proof.run', V.error ?? F.error); continue; }
      for (const ref of planted) {
        const v = lookup(V.results, ref.test), f = lookup(F.results, ref.test);
        if (v !== 'pass') err(p.pair, 'proof.result', `planted ${ref.id} ${ref.test} should pass on the vulnerable variant but ${v === undefined ? 'was not run' : `was "${v}"`}`);
        if (f !== 'fail') err(p.pair, 'proof.result', `planted ${ref.id} ${ref.test} should fail on the fixed twin but ${f === undefined ? 'was not run' : `was "${f}"`}`);
      }
      for (const [list, res, label] of [[decoyV, V.results, 'vulnerable'], [decoyF, F.results, 'fixed']]) for (const ref of list) {
        const got = lookup(res, ref.test);
        if (got !== 'pass') err(p.pair, 'proof.result', `decoy ${ref.id} ${ref.test} should pass on the ${label} variant but ${got === undefined ? 'was not run' : `was "${got}"`}`);
      }
      for (const [name, status] of F.results) if (status === 'fail' && !/planted/i.test(name) && !planted.some((ref) => name === ref.test || name.startsWith(ref.test))) err(p.pair, 'proof.result', `unexpected failing test on the fixed twin: ${name}`);
      for (const [name, status] of V.results) if (status === 'fail') err(p.pair, 'proof.result', `unexpected failing test on the vulnerable variant: ${name}`);
    }
    log(`proof ${p.pair} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return { errors, warnings };
}
