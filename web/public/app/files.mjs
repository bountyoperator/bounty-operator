/**
 * Files: the drop zone, the pickers, folder drops, paste with a name chosen
 * from what was pasted, the file list and the size meter.
 *
 * A file that cannot be added is named with the reason and the rest of the
 * batch is kept. Nothing is uploaded here: files stay in the workbench store.
 *
 * Exports
 *   EXTENSIONS, ACCEPT              what the pickers offer and a folder drop reads
 *   initFiles()                     wire #wb-drop, #wb-paste, #wb-files, #wb-meter
 *   addEntries(entries, options)    -> { added, replaced, errors }   add decoded { name, content } files
 *   showFileErrors(errors, title?)  list files that were not added
 *   Pure helpers (tested)
 *     createIntake(current)         -> { full, take(name, content), reject(name, reason), result() }
 *     planAdd(current, incoming)    -> { files, added, replaced, errors }
 *     isSkippedPath(path)           -> boolean   build output, dependencies, lock files
 *     hasTextExtension(name)        -> boolean
 *     suggestName(text, { existing, wantsDraft })  -> string
 *     uniqueName(name, existing)    -> string
 *     meterText(sum)                -> '148 / 240 KB · 12 / 50 files · 3,210 lines'
 *     summarizeErrors(errors)       -> errors with long runs of one reason folded into one line
 *
 * DOM this module owns: #wb-drop[data-over], #wb-file-input, #wb-folder-input,
 * #wb-pick-files, #wb-pick-folder, #wb-paste-*, #wb-file-errors, #wb-files
 * (li[data-file]), #wb-meter.
 */

import { profileNeeds } from '../evidence.mjs';
import { LIMITS, splitLines, textBytes, validName } from '../review-core.mjs';
import { workbench } from './state.mjs';
import { button, clear, el, formatBytes, icon, on, qs } from './ui.mjs';
import { beginRealWork, fileStats, say, setStep, totals } from './workbench.mjs';

export const EXTENSIONS = Object.freeze([
  '.sol', '.vy', '.rs', '.move', '.cairo', '.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.yul', '.huff',
  '.circom', '.md', '.json', '.toml', '.yaml', '.yml', '.txt', '.fc', '.func', '.tact', '.nr', '.leo', '.ak', '.zok',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.java', '.kt', '.swift', '.rb', '.php', '.cs', '.sh', '.sql', '.graphql',
  '.proto', '.sarif', '.diff', '.patch', '.log', '.csv',
]);

export const ACCEPT = [...EXTENSIONS, 'text/*'].join(',');

const SKIPPED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'out', 'cache', 'artifacts', 'target', 'coverage', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode', 'typechain', 'typechain-types', 'broadcast',
]);
const SKIPPED_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'poetry.lock', 'bun.lockb', 'foundry.lock', '.ds_store',
]);

const WALK_LIMIT = 2000;
const LIST_COLLAPSED = 8;
const FOLDED_REASONS = 4;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** True for a path a folder drop leaves out: dependencies, build output, lock files. */
export function isSkippedPath(path) {
  const segments = String(path).split('/');
  const name = segments[segments.length - 1].toLowerCase();
  if (SKIPPED_FILES.has(name)) return true;
  return segments.slice(0, -1).some((segment) => SKIPPED_DIRECTORIES.has(segment.toLowerCase()));
}

/** True when the name ends in one of EXTENSIONS. */
export function hasTextExtension(name) {
  const lower = String(name).toLowerCase();
  return EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * `name`, or `name-2`, `name-3`, … when the name is taken. The number goes in
 * front of the extension: `Vault-2.sol`.
 */
export function uniqueName(name, existing) {
  const taken = new Set(existing);
  if (!taken.has(name)) return name;
  const slash = name.lastIndexOf('/');
  const dot = name.indexOf('.', slash + 2);
  const stem = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? '' : name.slice(dot);
  for (let number = 2; number < 1000; number += 1) {
    const candidate = `${stem}-${number}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${extension}`;
}

function looksLikeJson(text) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed) || trimmed.length > 2000000) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

const CODE_START = /^\s*(?:\/\/|\/\*|\*\/?|import |from |def |class |fn |func |function |pragma |use |let |const |var |return |if |for |while |else|elif |try|except|#include|#\[|@\w+)/;
const CODE_END = /[;{}(),:=\]\\]\s*$/;
const CODE_ASSIGN = /^\s*[\w.[\]'"]+\s*[-+*/%|&^]?=(?!=)\s*\S/;

/** The share of non-empty lines that read as code. Prose and Markdown score low. */
function codeShare(lines) {
  const filled = lines.filter((line) => line.trim());
  if (!filled.length) return 0;
  const code = filled.filter((line) => CODE_START.test(line) || CODE_END.test(line) || CODE_ASSIGN.test(line));
  return code.length / filled.length;
}

const LANGUAGES = [
  ['circom', /\bpragma\s+circom\b|\btemplate\s+\w+\s*\([^)]*\)\s*\{/],
  ['sol', /\bpragma\s+solidity\b|\b(?:abstract\s+)?(?:contract|library|interface)\s+[A-Z]\w*[^;{]*\{/],
  ['vy', /^#\s*(?:@version|pragma\s+version)\b|^@(?:external|internal|view|payable|deploy)\s*$/m],
  ['cairo', /#\[starknet::|\bfelt252\b|^%lang\s+starknet/m],
  ['move', /\bmodule\s+[\w:]+\s*\{[\s\S]*?\bfun\s+\w+/],
  ['huff', /#define\s+(?:macro|function|constant)\b/],
  ['rs', /\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(|\bimpl(?:<[^>]*>)?\s+\w+|#\[derive\(|\bpub\s+(?:fn|struct|enum|mod)\b/],
  ['go', /^package\s+\w+\s*$/m],
  ['py', /^\s*(?:def|class)\s+\w+[^\n]*:\s*(?:#.*)?$|^(?:from\s+[\w.]+\s+import|import\s+[\w.]+)\s/m],
  ['ts', /\binterface\s+\w+\s*\{|\bimport\s+type\b|:\s*(?:string|number|boolean|unknown|void)\b|\bas\s+const\b/],
  ['js', /\b(?:const|let|var)\s+\w+\s*=|=>\s*[{(]|\brequire\(|\bmodule\.exports\b|\bexport\s+(?:default|const|function)\b/],
  ['diff', /^diff --git |^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m],
];

function contractName(text) {
  const match = /\b(?:contract|library|interface)\s+([A-Z]\w{0,60})/.exec(text);
  return match ? match[1] : 'pasted';
}

/**
 * A file name for pasted text, chosen from what the text is: `Vault.sol` for a
 * contract, `draft-report.md` for prose when the profile reads a draft,
 * `tool-output.json` for scanner output.
 *
 * @param {string} text
 * @param {{ existing?: string[], wantsDraft?: boolean }} [options]
 * @returns {string}
 */
export function suggestName(text, { existing = [], wantsDraft = false } = {}) {
  const source = String(text ?? '');
  let name = 'pasted.txt';

  const json = looksLikeJson(source);
  const lines = source.split('\n', 400);
  const fenced = lines.some((line) => /^\s{0,3}(?:```|~~~)/.test(line));
  const heading = lines.some((line) => /^#{1,4}\s+\S/.test(line));
  const prose = fenced || (codeShare(lines) < 0.25 && (heading || /[a-z]{3,}[.!?]\s+[A-Z]/.test(source)));

  if (json) {
    const isSarif = Array.isArray(json.runs) && typeof json.version === 'string';
    const isScan = isSarif || Boolean(json.results) || Boolean(json.detectors) || Boolean(json.findings);
    name = isSarif ? 'scan.sarif.json' : isScan ? 'tool-output.json' : 'pasted.json';
  } else if (/^(?:INFO:Detectors:|Detector: |# Aderyn Analysis Report)/m.test(source)) {
    name = /^# Aderyn/m.test(source) ? 'aderyn-report.md' : 'tool-output.txt';
  } else if (prose) {
    const hasDraft = existing.some((entry) => /(?:^|\/)(?:draft|report)[^/]*\.(?:md|txt)$/i.test(entry));
    name = wantsDraft && !hasDraft ? 'draft-report.md' : 'notes.md';
  } else {
    const language = LANGUAGES.find(([, pattern]) => pattern.test(source));
    if (language) name = language[0] === 'sol' ? `${contractName(source)}.sol` : `pasted.${language[0]}`;
  }
  return uniqueName(name, existing);
}

function kilobytes(bytes) {
  return formatBytes(bytes);
}

/**
 * Takes files one at a time against the engine's limits. A file with the name
 * of one already loaded replaces it.
 *
 * @param {{ name: string, content: string }[]} current
 */
export function createIntake(current) {
  const files = [...current];
  const added = [];
  const replaced = [];
  const errors = [];
  const sum = totals(files);

  function reject(name, reason) {
    errors.push({ name, reason });
    return false;
  }

  function take(name, content) {
    if (!validName(name)) return reject(String(name).slice(0, 120) || 'unnamed file', 'has a name the review cannot cite');
    let bytes;
    try {
      bytes = textBytes(content);
    } catch {
      return reject(name, 'is not UTF-8 text');
    }
    if (bytes === 0 || !content.trim()) return reject(name, 'is empty');
    if (bytes > LIMITS.fileBytes) return reject(name, `is ${kilobytes(bytes)}; one file holds ${kilobytes(LIMITS.fileBytes)} at most`);

    const lines = splitLines(content).length;
    const at = files.findIndex((file) => file.name === name);
    const old = at === -1 ? { bytes: 0, lines: 0 } : fileStats(files[at]);

    if (at === -1 && files.length >= LIMITS.files) return reject(name, `was left out: ${LIMITS.files} files is the limit`);
    if (sum.bytes - old.bytes + bytes > LIMITS.totalBytes) return reject(name, `was left out: the ${kilobytes(LIMITS.totalBytes)} total is full`);
    if (sum.lines - old.lines + lines > LIMITS.totalLines) {
      return reject(name, `was left out: the ${LIMITS.totalLines.toLocaleString('en-US')}-line total is full`);
    }

    const file = { name, content };
    sum.bytes += bytes - old.bytes;
    sum.lines += lines - old.lines;
    if (at === -1) {
      files.push(file);
      added.push(name);
    } else {
      files[at] = file;
      replaced.push(name);
    }
    return true;
  }

  return {
    /** True when no new name fits: reading more files from a folder is pointless. */
    get full() {
      return files.length >= LIMITS.files || sum.bytes >= LIMITS.totalBytes;
    },
    take,
    reject,
    result: () => ({ files, added, replaced, errors }),
  };
}

/**
 * @param {{ name: string, content: string }[]} current
 * @param {{ name: string, content: string }[]} incoming
 */
export function planAdd(current, incoming) {
  const intake = createIntake(current);
  for (const entry of incoming) intake.take(entry?.name, entry?.content);
  return intake.result();
}

/** `148 / 240 KB · 12 / 50 files · 3,210 lines` */
export function meterText(sum) {
  const used = formatBytes(sum.bytes);
  const limit = formatBytes(LIMITS.totalBytes);
  const unit = limit.slice(limit.lastIndexOf(' '));
  // "148 KB / 240 KB" reads better as "148 / 240 KB" when both share the unit.
  const bytes = used.endsWith(unit) ? `${used.slice(0, -unit.length)} / ${limit}` : `${used} / ${limit}`;
  return `${bytes} · ${sum.files} / ${LIMITS.files} files · ${sum.lines.toLocaleString('en-US')} lines`;
}

/**
 * Folds a long run of files left out for the same reason into one line, so a
 * dropped repository does not print four hundred of them.
 *
 * @param {{ name: string, reason: string }[]} errors
 * @returns {{ name: string, reason: string }[]}
 */
export function summarizeErrors(errors) {
  const byReason = new Map();
  for (const error of errors) {
    if (!byReason.has(error.reason)) byReason.set(error.reason, []);
    byReason.get(error.reason).push(error.name);
  }
  const lines = [];
  for (const [reason, names] of byReason) {
    const shown = names.length > FOLDED_REASONS + 1 ? names.slice(0, FOLDED_REASONS) : names;
    for (const name of shown) lines.push({ name, reason });
    const rest = names.length - shown.length;
    if (rest > 0) lines.push({ name: `${rest.toLocaleString('en-US')} more files`, reason: reason.replace(/^(is|has|was)\b/, (verb) => ({ is: 'are', has: 'have', was: 'were' })[verb]) });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

/**
 * Lists the files that were not added, each with its reason.
 *
 * @param {{ name: string, reason: string }[]} errors
 * @param {string} [title]
 */
export function showFileErrors(errors, title) {
  const target = qs('#wb-file-errors');
  if (!target) return;
  clear(target);
  if (!errors.length) return;

  const lines = summarizeErrors(errors);
  const heading = title ?? `${errors.length === 1 ? '1 file was' : `${errors.length.toLocaleString('en-US')} files were`} not added`;
  target.append(
    icon('warn'),
    el('div', { class: 'notice__content' },
      el('p', { class: 'notice__title', text: heading }),
      el('div', { class: 'notice__body' },
        el('ul', { class: 'wb-flags' }, lines.map((line) => el('li', { class: 'wb-flag' },
          el('span', { class: 'wb-flag__where mono', text: line.name }),
          el('span', { class: 'wb-flag__kind', text: `${line.reason}.` })))),
        el('div', {}, button({ label: 'Dismiss', variant: 'quiet', size: 'sm', onClick: () => clear(target) })))),
  );
}

function plural(number, noun) {
  return `${number.toLocaleString('en-US')} ${noun}${number === 1 ? '' : 's'}`;
}

/**
 * Adds decoded files to the workbench. An example that is loaded is removed
 * first. Returns what happened; the status line and the error list are
 * updated here.
 *
 * @param {{ name: string, content: string }[]} entries
 * @param {{ errors?: { name: string, reason: string }[], quiet?: boolean }} [options]
 *   `errors` are files that already failed before decoding; `quiet` leaves the status line to the caller.
 * @returns {{ added: string[], replaced: string[], errors: { name: string, reason: string }[], leftExample: boolean }}
 */
export function addEntries(entries, { errors: earlier = [], quiet = false } = {}) {
  const leftExample = entries.length > 0 ? beginRealWork() : false;
  const plan = planAdd(workbench.get().files, entries);
  const errors = [...earlier, ...plan.errors];

  if (plan.added.length || plan.replaced.length) workbench.set({ files: plan.files });
  showFileErrors(errors);

  if (!quiet) {
    const parts = [];
    if (plan.added.length) parts.push(`${plural(plan.added.length, 'file')} added`);
    if (plan.replaced.length) parts.push(`${plural(plan.replaced.length, 'file')} replaced`);
    const done = parts.length ? `${parts.join(', ')}.` : '';
    const lead = leftExample ? 'The example is gone. ' : '';
    if (errors.length && !done) say(`${lead}Nothing was added. The reasons are listed under the drop zone.`, { error: true });
    else if (errors.length) say(`${lead}${done} ${plural(errors.length, 'file')} left out, listed under the drop zone.`, { tone: 'warn' });
    else if (done) say(`${lead}${done}`, { tone: 'success' });
  }
  return { added: plan.added, replaced: plan.replaced, errors, leftExample };
}

async function decode(file) {
  if (file.size > LIMITS.fileBytes) {
    throw new Error(`is ${formatBytes(file.size)}; one file holds ${formatBytes(LIMITS.fileBytes)} at most`);
  }
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('is not UTF-8 text');
  }
}

/**
 * Reads picked or dropped files and adds them.
 *
 * @param {{ file: File, path: string }[]} picked
 * @param {{ fromFolder?: boolean, notRead?: number, folder?: boolean }} [options]
 *   `fromFolder` filters by path and extension; `folder` only words the message for an empty result.
 */
async function addPicked(picked, { fromFolder = false, notRead = 0, folder = fromFolder } = {}) {
  if (workbench.get().busy) {
    say('A review is running. Cancel it to change the files.', { tone: 'warn' });
    return;
  }
  // The example goes before the limits are counted, so its files take no room.
  const leftExample = picked.length > 0 ? beginRealWork() : false;
  const intake = createIntake(workbench.get().files);
  let leftOut = notRead;

  for (const { file, path } of picked) {
    if (fromFolder && (isSkippedPath(path) || !hasTextExtension(path))) continue;
    if (intake.full && !workbench.get().files.some((entry) => entry.name === path)) {
      leftOut += 1;
      continue;
    }
    try {
      intake.take(path, await decode(file));
    } catch (error) {
      intake.reject(path, error instanceof Error ? error.message : 'could not be read');
    }
  }

  const plan = intake.result();
  if (leftOut > 0) plan.errors.push({ name: `${leftOut.toLocaleString('en-US')} more files`, reason: 'were left out: the limits are reached' });
  if (plan.added.length || plan.replaced.length) workbench.set({ files: plan.files });
  showFileErrors(plan.errors);

  const parts = [];
  if (plan.added.length) parts.push(`${plural(plan.added.length, 'file')} added`);
  if (plan.replaced.length) parts.push(`${plural(plan.replaced.length, 'file')} replaced`);
  const lead = leftExample ? 'The example is gone. ' : '';
  if (!parts.length && !plan.errors.length) {
    say(folder ? 'That folder holds no source or text files.' : 'No files were chosen.', { tone: 'warn' });
  } else if (!parts.length) {
    say(`${lead}Nothing was added. The reasons are listed under the drop zone.`, { error: true });
  } else if (plan.errors.length) {
    say(`${lead}${parts.join(', ')}. ${plural(plan.errors.length, 'file')} left out, listed under the drop zone.`, { tone: 'warn' });
  } else {
    say(`${lead}${parts.join(', ')}.`, { tone: 'success' });
  }
  if (workbench.get().step !== 'files') setStep('files', { focus: false });
}

// ---------------------------------------------------------------------------
// Drop: files and folders
// ---------------------------------------------------------------------------

function readBatch(reader) {
  return new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
}

function entryFile(entry) {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

/** Walks dropped file-system entries. Skipped folders are never opened. */
async function walk(entries) {
  const found = [];
  const queue = [...entries];
  let fromFolder = false;
  let notRead = 0;

  while (queue.length) {
    const entry = queue.shift();
    if (!entry) continue;
    const path = entry.fullPath.replace(/^\/+/, '');
    if (entry.isDirectory) {
      fromFolder = true;
      if (SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      const reader = entry.createReader();
      // A directory reader returns its entries in batches until one comes back empty.
      for (;;) {
        const batch = await readBatch(reader);
        if (!batch.length) break;
        queue.push(...batch);
      }
    } else if (entry.isFile) {
      const nested = path.includes('/');
      if (nested && (isSkippedPath(path) || !hasTextExtension(path))) continue;
      if (found.length >= WALK_LIMIT) {
        notRead += 1;
        continue;
      }
      const file = await entryFile(entry);
      if (file) found.push({ file, path });
    }
  }
  found.sort((a, b) => a.path.localeCompare(b.path));
  return { found, fromFolder, notRead };
}

function carriesFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

async function onDrop(event) {
  const transfer = event.dataTransfer;
  // Entries must be taken before the first await: the transfer is emptied when the handler returns.
  const entries = Array.from(transfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));
  const plain = Array.from(transfer.files ?? []);

  if (entries.length && entries.every(Boolean)) {
    const { found, fromFolder, notRead } = await walk(entries);
    // Files inside a dropped folder were filtered while walking; loose files are taken as given.
    await addPicked(found, { fromFolder: false, notRead, folder: fromFolder });
    return;
  }
  await addPicked(plain.map((file) => ({ file, path: file.name })));
}

// ---------------------------------------------------------------------------
// File list and meter
// ---------------------------------------------------------------------------

let expanded = false;

function renderList() {
  const list = qs('#wb-files');
  const meter = qs('#wb-meter');
  if (!list) return;
  const { files } = workbench.get();
  clear(list);

  const collapsed = !expanded && files.length > LIST_COLLAPSED + 2;
  const shown = collapsed ? files.slice(0, LIST_COLLAPSED) : files;
  for (const file of shown) {
    const measured = fileStats(file);
    // The folder part gives way first, so a long path still shows its file name.
    const slash = file.name.lastIndexOf('/') + 1;
    list.append(el('li', { class: 'wb-file', dataset: { file: file.name } },
      icon('file'),
      el('span', { class: 'wb-file__name mono', title: file.name },
        slash ? el('span', { class: 'wb-file__dir', text: file.name.slice(0, slash) }) : null,
        el('span', { class: 'wb-file__base', text: file.name.slice(slash) })),
      el('span', { class: 'wb-file__meta num', text: `${formatBytes(measured.bytes)} · ${plural(measured.lines, 'line')}` }),
      button({ label: `Remove ${file.name}`, icon: 'x', iconOnly: true, variant: 'quiet', className: 'wb-file__remove', attrs: { 'data-remove': file.name } })));
  }
  if (files.length > LIST_COLLAPSED + 2) {
    list.append(el('li', { class: 'wb-file wb-file--more' }, button({
      label: collapsed ? `Show all ${files.length} files` : 'Show fewer',
      variant: 'quiet',
      size: 'sm',
      attrs: { 'aria-expanded': String(!collapsed), id: 'wb-files-toggle' },
      onClick: () => {
        expanded = collapsed;
        renderList();
        qs('#wb-files-toggle')?.focus();
      },
    })));
  }

  if (meter) {
    const sum = totals(files);
    meter.hidden = files.length === 0;
    clear(meter);
    if (files.length) {
      const share = Math.max(sum.bytes / LIMITS.totalBytes, sum.files / LIMITS.files, sum.lines / LIMITS.totalLines);
      if (share >= 0.9) meter.dataset.full = '';
      else delete meter.dataset.full;
      meter.append(
        el('progress', { class: 'meter', max: String(LIMITS.totalBytes), value: String(Math.min(sum.bytes, LIMITS.totalBytes)), 'aria-label': 'Share of the size limit in use' }),
        el('p', { class: 'wb-meter__text meta num', text: meterText(sum) }),
      );
    }
  }
}

function removeFile(name) {
  const { files, busy } = workbench.get();
  if (busy) {
    say('A review is running. Cancel it to change the files.', { tone: 'warn' });
    return;
  }
  const at = files.findIndex((file) => file.name === name);
  if (at === -1) return;
  workbench.set({ files: files.filter((file, index) => index !== at) });
  // Focus stays in the list: on the file that took this one's place, else on the picker.
  const buttons = Array.from(qs('#wb-files')?.querySelectorAll('[data-remove]') ?? []);
  (buttons[Math.min(at, buttons.length - 1)] ?? qs('#wb-pick-files'))?.focus();
  say(`${name} removed.`);
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

function wantsDraft() {
  try {
    return profileNeeds(workbench.get().profile).inputs.some((need) => need.id === 'draft');
  } catch {
    return false;
  }
}

function suggestion(text) {
  return suggestName(text, { existing: workbench.get().files.map((file) => file.name), wantsDraft: wantsDraft() });
}

function wirePaste() {
  const text = qs('#wb-paste-text');
  const name = qs('#wb-paste-name');
  const add = qs('#wb-paste-add');
  if (!text || !name || !add) return;

  const refresh = () => {
    name.placeholder = suggestion(text.value);
  };
  refresh();
  on(text, 'input', () => {
    text.removeAttribute('aria-invalid');
    refresh();
  });
  workbench.select((state) => state.profile, refresh);
  workbench.select((state) => state.files, refresh);

  on(add, 'click', () => {
    if (!text.value.trim()) {
      text.setAttribute('aria-invalid', 'true');
      say('Paste some text first.', { error: true });
      text.focus();
      return;
    }
    if (workbench.get().busy) {
      say('A review is running. Cancel it to change the files.', { tone: 'warn' });
      return;
    }
    const typed = name.value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    // A typed name that is taken gets a number: a paste never replaces a loaded file.
    const fileName = typed ? uniqueName(typed, workbench.get().files.map((file) => file.name)) : suggestion(text.value);
    const outcome = addEntries([{ name: fileName, content: text.value }], { quiet: true });
    if (outcome.added.length) {
      text.value = '';
      name.value = '';
      refresh();
      say(`${outcome.leftExample ? 'The example is gone. ' : ''}Added as ${fileName}.`, { tone: 'success' });
      text.focus();
    } else {
      say(`${fileName} ${outcome.errors[0]?.reason ?? 'was not added'}.`, { error: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Wires the Files row. Call after initWorkbench(). */
export function initFiles() {
  const root = qs('#workspace');
  const zone = qs('#wb-drop');
  const fileInput = qs('#wb-file-input');
  const folderInput = qs('#wb-folder-input');
  if (!root || !zone || !fileInput) return;

  fileInput.accept = ACCEPT;
  on(qs('#wb-pick-files'), 'click', () => fileInput.click());
  on(fileInput, 'change', async () => {
    const picked = Array.from(fileInput.files ?? []).map((file) => ({ file, path: file.name }));
    fileInput.value = '';
    await addPicked(picked);
  });

  const folderButton = qs('#wb-pick-folder');
  if (folderInput && 'webkitdirectory' in folderInput) {
    on(folderButton, 'click', () => folderInput.click());
    on(folderInput, 'change', async () => {
      const picked = Array.from(folderInput.files ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
      folderInput.value = '';
      picked.sort((a, b) => a.path.localeCompare(b.path));
      const eligible = picked.filter(({ path }) => !isSkippedPath(path) && hasTextExtension(path));
      await addPicked(eligible.slice(0, WALK_LIMIT), { fromFolder: true, notRead: Math.max(0, eligible.length - WALK_LIMIT) });
    });
  } else if (folderButton) {
    // No folder picker in this browser: a folder can still be dropped.
    folderButton.hidden = true;
  }

  // A drop anywhere on the workbench counts, so a near miss does not open the file in the tab.
  on(root, 'dragenter dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    zone.dataset.over = '';
  });
  on(root, 'dragleave', (event) => {
    if (!root.contains(event.relatedTarget)) delete zone.dataset.over;
  });
  on(root, 'drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    delete zone.dataset.over;
    onDrop(event).catch(() => say('The dropped files could not be read.', { error: true }));
  });

  on(qs('#wb-files'), 'click', '[data-remove]', (event, control) => removeFile(control.dataset.remove));
  root.addEventListener('wb:clear', () => {
    expanded = false;
    showFileErrors([]);
    for (const id of ['#wb-paste-text', '#wb-paste-name']) {
      const field = qs(id);
      if (field) field.value = '';
    }
  });

  wirePaste();
  workbench.select((state) => state.files, renderList, { immediate: true });
}
