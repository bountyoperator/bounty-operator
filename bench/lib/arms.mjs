// Paydirt arms: what each run is told.
//
//   raw      system = prompts/system.txt
//   profile  system = prompts/system.txt + prompts/profile-bridge.md + the product's own
//            Context block for a request with no context + the product's own system message
//            for that review profile (review contract + profile instructions + output format)
//   task     identical in every arm: prompts/raw-task.md (with the case focus) + prompts/answer-sheet.md
//
// So a profile arm differs from the raw arm by exactly one thing: the product's review
// instructions. THE ONLY IMPORT OF THE PRODUCT ENGINE IN THE HARNESS IS IN THIS FILE.
// Contract coded against (web/public/review-core.mjs as checked at integration, 3 Oct 2026):
//   prepareReview(files, prompt = '', profileId = 'general', options = {}) ->
//     { messages: [{ role: 'system', content }, { role: 'user', content }], profile, mode, ... }
//     messages[0].content = REVIEW_CONTRACT + profile.instructions + format notes + output format
//     messages[1].content = "## Request" + "## Context" (carries "Mode: ...") + "## Untrusted files" + the files
//   checkInputs(files, prompt = '', context?) -> { findings: [{ kind, severity: 'block'|'warn' }], blocking, warnings }
//     It throws above LIMITS (50 files, 120 KB a file, 240 KB and 20,000 lines in total); lint reports that as the case's error.
// The contract says "Mode comes from Context and fixes the Verdict vocabulary", and the product
// puts that Context block in the user message. The benchmark's user message is the task, so the
// Context block the product sends for a request without context is carried in the system prompt,
// between the bridge and the product's system message. Nothing else of the product's user message
// is used: its Request line is replaced by the task and its inline files by the workspace.
//
// FROZEN TEXT. `freeze` writes the product text of each profile (Context block + system message)
// to prompts/frozen/<profile>.md and records its hash in protocol.json. Runs send the frozen
// file, not whatever the engine produces at that moment: the product keeps changing, a benchmark
// run must not change with it half way, and the public archive (which has no web/ directory)
// must be able to rebuild every prompt. `run` says so when the live engine has moved on.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE_FILES = ['web/public/review-core.mjs', 'web/public/profiles.mjs'];
const ENGINE_ENTRY = path.resolve(BENCH, '..', 'web', 'public', 'review-core.mjs');
const PLACEHOLDER = [{ name: 'placeholder.txt', content: 'placeholder\n' }];

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const lf = (text) => String(text).replace(/\r\n?/g, '\n');

export function readPrompt(name, benchDir = BENCH) {
  return lf(fs.readFileSync(path.join(benchDir, 'prompts', name), 'utf8'));
}

let enginePromise = null;
function engine() {
  enginePromise ??= import(pathToFileURL(ENGINE_ENTRY).href);
  return enginePromise;
}

/** The product's system message for a review profile: { text, engine_profile }. */
export async function profileSystem(profileId) {
  const { prepareReview } = await engine();
  if (typeof prepareReview !== 'function') throw new Error('review-core.mjs does not export prepareReview');
  const used = profileId;
  const prepared = await prepareReview(PLACEHOLDER, '', profileId, { acknowledgeWarnings: true, mode: 'bounty' });
  const system = prepared?.messages?.[0];
  if (system?.role !== 'system' || typeof system.content !== 'string' || !system.content.trim()) {
    throw new Error(`prepareReview("${used}") did not return a system message in messages[0]`);
  }
  const text = lf(system.content).trim();
  // the product's Context block (it carries the Mode the contract refers to); the pre-rewrite engine had none
  const user = prepared?.messages?.[1];
  const block = typeof user?.content === 'string' ? /(?:^|\n)(## Context\n[\s\S]*?)(?=\n\n## |\n*$)/.exec(lf(user.content)) : null;
  const context = block ? block[1].trim() : '';
  if (/\bMode comes from Context\b/.test(text) && !/^Mode: \S+/m.test(context)) {
    throw new Error(`prepareReview("${used}") refers to a Context block with a Mode, but its user message carries none`);
  }
  return { text, context, engine_profile: used, mode: prepared.mode ?? null };
}

/** The product text a profile arm sends, as the live engine produces it now. */
export async function liveProfile(profileId) {
  const p = await profileSystem(profileId);
  return { sent: [p.context, p.text].filter(Boolean).join('\n\n'), engine_profile: p.engine_profile, mode: p.mode };
}

export const frozenPath = (profileId, benchDir = BENCH) => path.join(benchDir, 'prompts', 'frozen', `${profileId}.md`);

/** The frozen product text of a profile (written by `freeze`), or null when there is none. */
export function frozenProfile(profileId, benchDir = BENCH) {
  if (!/^[a-z0-9-]+$/.test(String(profileId))) return null;
  try { return lf(fs.readFileSync(frozenPath(profileId, benchDir), 'utf8')).trim() || null; } catch { return null; }
}

/** sha256 of each frozen profile text (null when the file is missing). */
export function frozenHashes(profileIds, benchDir = BENCH) {
  return Object.fromEntries(profileIds.map((id) => { const t = frozenProfile(id, benchDir); return [id, t === null ? null : sha256(t)]; }));
}

/** Run the product's privacy/input check on a workspace. Used by lint. */
export async function engineCheckInputs(files) {
  const { checkInputs } = await engine();
  let result;
  try { result = checkInputs(files, ''); }
  catch (e) {
    // the pre-rewrite engine rejects names with a path separator; retry with flat names
    if (!/filename/i.test(String(e?.message))) throw e;
    result = checkInputs(files.map((f, i) => ({ name: `${i + 1}-${f.name.split('/').pop()}`, content: f.content })), '');
  }
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const blocking = typeof result.blocking === 'number' ? result.blocking : findings.filter((f) => f.severity !== 'warn' && !['email-address', 'ip-address'].includes(f.kind)).length;
  const warnings = typeof result.warnings === 'number' ? result.warnings : findings.length - blocking;
  return { blocking, warnings, kinds: [...new Set(findings.map((f) => f.kind))] };
}

/** sha256 of each engine source file (LF-normalised), for protocol.json. */
export function engineFileHashes(repoRoot = path.resolve(BENCH, '..')) {
  const out = {};
  for (const rel of ENGINE_FILES) {
    try { out[rel] = sha256(lf(fs.readFileSync(path.join(repoRoot, rel), 'utf8'))); } catch { out[rel] = null; }
  }
  return out;
}

export function armsFor(protocol, family) {
  return protocol.arms[family] ?? [];
}

const taskFrom = (kase, rawTask, answerSheet) => {
  const focus = String(kase.case?.focus ?? '').trim() || 'Review the files in this workspace.';
  return `${rawTask.replace('{{focus}}', focus).trim()}\n\n${answerSheet.trim()}\n`;
};

/** The task text (first user message). Identical in every arm. */
export function taskText(kase, benchDir = BENCH) {
  return taskFrom(kase, readPrompt('raw-task.md', benchDir), readPrompt('answer-sheet.md', benchDir));
}

/**
 * Build one arm for one case:
 * { arm, system, task, system_sha256, task_sha256, engine_profile, engine_source, profile_sha256, sources }.
 * `arm` is "raw" or a profile id. A profile arm sends the frozen product text when
 * prompts/frozen/<profile>.md exists, else the live engine's text (`engine_source` says which).
 * `sources` is the sha256 of every prompt file the texts were built from, in the form
 * protocol.json `files` records it, and `profile_sha256` the hash of the product text sent:
 * the runner compares both with protocol.json before it sends anything, so a run is never
 * stored under a hash that does not cover what it sent.
 */
export async function buildArm(arm, kase, { benchDir = BENCH, headline = 'raw' } = {}) {
  const read = { 'prompts/system.txt': readPrompt('system.txt', benchDir), 'prompts/raw-task.md': readPrompt('raw-task.md', benchDir), 'prompts/answer-sheet.md': readPrompt('answer-sheet.md', benchDir) };
  const base = read['prompts/system.txt'].trim();
  let system = base, engineProfile = null, engineSource = null, profileSha = null;
  if (arm !== headline) {
    let sent = frozenProfile(arm, benchDir);
    if (sent !== null) { engineProfile = arm; engineSource = 'frozen'; }
    else { const live = await liveProfile(arm); sent = live.sent; engineProfile = live.engine_profile; engineSource = 'live'; }
    profileSha = sha256(sent);
    read['prompts/profile-bridge.md'] = readPrompt('profile-bridge.md', benchDir);
    system = [base, read['prompts/profile-bridge.md'].trim(), sent].join('\n\n');
  }
  system += '\n';
  const task = taskFrom(kase, read['prompts/raw-task.md'], read['prompts/answer-sheet.md']);
  const sources = Object.fromEntries(Object.entries(read).map(([rel, text]) => [rel, sha256(text)]));
  return { arm, system, task, system_sha256: sha256(system), task_sha256: sha256(task), engine_profile: engineProfile, engine_source: engineSource, profile_sha256: profileSha, sources };
}

/** The protocol.json record of one product text (`live` is what liveProfile returns). */
export const profileRecord = (live) => ({ system_sha256: sha256(live.sent), engine_profile: live.engine_profile, mode: live.mode, chars: live.sent.length });

/** sha256 of the live engine's product text per profile (what `freeze` would record now). */
export async function profileHashes(profileIds) {
  const out = {};
  for (const id of profileIds) out[id] = profileRecord(await liveProfile(id));
  return out;
}

/** Write prompts/frozen/<profile>.md: the product text a profile arm sends from now on. */
export function writeFrozen(profileId, sent, benchDir = BENCH) {
  fs.mkdirSync(path.dirname(frozenPath(profileId, benchDir)), { recursive: true });
  fs.writeFileSync(frozenPath(profileId, benchDir), `${sent}\n`);
}
