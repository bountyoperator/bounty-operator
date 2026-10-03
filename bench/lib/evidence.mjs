// Private run evidence. Superseded directories are retained outside raw/, so only the
// current record is scored, while the budget still counts every recorded invocation.
import fs from 'node:fs';
import path from 'node:path';
import { RUN_SCHEMA } from './runs.mjs';

function inside(root, target) {
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`run path is outside its root: ${target}`);
  return rel;
}

// Reject links/junctions in the path before a move, rather than trusting its spelling.
function checkedPath(root, target) {
  const rel = inside(root, path.resolve(target));
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`run path must contain real directories only: ${current}`);
    inside(root, fs.realpathSync(current));
  }
  return path.join(root, rel);
}

/** A single run id beneath the chosen runs directory; dot and parent are not ids. */
export function resolveRunRoot(runsRoot, runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') throw new Error('--run-id may contain letters, digits, dot, dash and underscore only, and must name a child directory');
  const base = fs.existsSync(runsRoot) ? fs.realpathSync(runsRoot) : path.resolve(runsRoot);
  return checkedPath(base, path.join(base, runId));
}

/** Move one whole raw/model/run directory to a fresh private archive slot. */
export function archiveStoredRun(runRoot, dir) {
  const root = fs.realpathSync(runRoot);
  const source = checkedPath(root, dir);
  const parts = path.relative(root, source).split(path.sep);
  if (parts.length !== 3 || parts[0] !== 'raw') throw new Error(`only a raw/model/run directory can be archived: ${source}`);
  if (!fs.existsSync(source)) return null;
  const archive = checkedPath(root, path.join(root, 'superseded'));
  fs.mkdirSync(archive, { recursive: true });
  // mkdtemp reserves a new slot atomically: the destination can never replace an old run.
  const slot = fs.mkdtempSync(path.join(archive, 'attempt-'));
  const target = checkedPath(root, path.join(slot, ...parts));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  return target;
}

function directories(root, dir) {
  const checked = checkedPath(root, dir);
  if (!fs.existsSync(checked)) return [];
  return fs.readdirSync(checked, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => checkedPath(root, path.join(checked, e.name)));
}

/** Current raw directories only. The caller decides how to classify their contents. */
export function rawRunDirectories(runRoot) {
  if (!fs.existsSync(runRoot)) return [];
  const root = fs.realpathSync(runRoot);
  return directories(root, path.join(root, 'raw')).flatMap((model) => directories(root, model));
}

function readMetas(dirs) {
  const result = [];
  for (const dir of dirs) {
    try {
      const file = path.join(dir, 'meta.json');
      if (!fs.lstatSync(file).isFile()) continue;
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (meta?.schema === RUN_SCHEMA) result.push({ dir, meta });
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
  }
  return result;
}

/** Archived records are for cost/history only, never inputs to scoring or resume. */
export function archivedRuns(runRoot) {
  if (!fs.existsSync(runRoot)) return [];
  const root = fs.realpathSync(runRoot);
  const dirs = directories(root, path.join(root, 'superseded')).flatMap((slot) => {
    return directories(root, path.join(slot, 'raw')).flatMap((model) => directories(root, model));
  });
  return readMetas(dirs);
}

// usd_all_attempts belongs to one invocation. usd_prior_attempts is deliberately not
// added here: those invocations have their own archived records and would count twice.
export function recordedRunCost(meta) {
  const cost = meta?.usd_all_attempts ?? meta?.usd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

export function storedSpend(runRoot) {
  return [...readMetas(rawRunDirectories(runRoot)), ...archivedRuns(runRoot)].reduce((sum, { meta }) => sum + recordedRunCost(meta), 0);
}

export function priorAttemptSpend(runRoot, key) {
  return Math.round(archivedRuns(runRoot).filter(({ meta }) => meta.key === key).reduce((sum, { meta }) => sum + recordedRunCost(meta), 0) * 1e9) / 1e9;
}
