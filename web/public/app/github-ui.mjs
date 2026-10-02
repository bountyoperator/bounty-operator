/**
 * GitHub import: a file, folder, repository, commit or pull request link,
 * read at one exact commit. A link to a file imports it at once; any other
 * link opens a picker with a checkbox tree, file-type filters, a preset that
 * leaves out tests, mocks and lib, and a live meter against the limits.
 *
 * Requests go from this tab to api.github.com. A token for a private
 * repository is held in a variable and never stored.
 *
 * Exports
 *   initGithub()                         wire #wb-github and #wb-github-dialog
 *   Pure helpers (tested)
 *     extensionOf(path)                  -> '.sol' | ''
 *     isTestPath(path)                   -> boolean   tests, mocks, lib, scripts, vendored code
 *     candidateFiles(files, prefix)      -> files under `prefix` with a text extension
 *     extensionCounts(files)             -> [{ extension, count }] most common first
 *     defaultExtensions(counts)          -> Set of extensions switched on at the start
 *     visibleFiles(files, filters)       -> the files the tree shows
 *     buildTree(files, prefix)           -> { name, path, dirs: Map, files: [] }
 *     pickDefaults(visible, room)        -> Set of paths ticked at the start
 *     selectionSummary(selected, sizes, existing) -> { files, bytes, lines, over, text }
 *     reasonFrom(path, message)          -> the error as a clause that follows the file name
 *
 * DOM this module owns: #wb-github-url, #wb-github-go, #wb-github-token,
 * #wb-github-status and everything inside #wb-github-dialog.
 */

import { githubReference, importGithubFiles, listGithubTree, pullRequestFiles, resolveCommit } from '../github.mjs';
import { LIMITS } from '../review-core.mjs';
import { track } from './api.mjs';
import { EVENTS } from './events.mjs';
import { addEntries, hasTextExtension, isSkippedPath } from './files.mjs';
import { workbench } from './state.mjs';
import { announce, button, clear, dialogController, el, formatBytes, icon, on, qs, qsa, setBusy } from './ui.mjs';
import { returnFocus, say, totals, view } from './workbench.mjs';

const CONCURRENT = 6;
const EXPAND_ALL_BELOW = 80;
// Lines are not known until a file is fetched. Source averages about 34 bytes a line.
const BYTES_PER_LINE = 34;
const DOC_EXTENSIONS = new Set(['.md', '.json', '.toml', '.yaml', '.yml', '.txt', '.csv', '.log', '.sarif', '.diff', '.patch']);

const TEST_DIRECTORY = /(?:^|\/)(?:tests?|__tests__|mocks?|lib|libs|vendor|third[_-]?party|node_modules|scripts?|examples?|fixtures|forge-std|openzeppelin[\w-]*|\.github)\//i;
const TEST_FILE = /(?:\.t\.sol|\.s\.sol|[._-](?:test|spec|mock)\.[a-z]+|(?:^|\/)(?:Mock|Test)[A-Z]\w*\.[a-z]+|(?:Test|Mock)\.sol)$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function extensionOf(path) {
  const name = String(path).slice(String(path).lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** True for a path the "Skip tests, mocks and lib" preset leaves out. */
export function isTestPath(path) {
  return TEST_DIRECTORY.test(`${path}`) || TEST_FILE.test(path);
}

function underPrefix(path, prefix) {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The files the picker can offer: under `prefix`, with a text extension, and
 * not build output or a lock file.
 *
 * @param {{ path: string, size: number }[]} files
 * @param {string} [prefix]
 */
export function candidateFiles(files, prefix = '') {
  return files.filter((file) => underPrefix(file.path, prefix) && hasTextExtension(file.path) && !isSkippedPath(file.path));
}

/** @param {{ path: string }[]} files */
export function extensionCounts(files) {
  const counts = new Map();
  for (const file of files) {
    const extension = extensionOf(file.path);
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return [...counts]
    .map(([extension, count]) => ({ extension, count }))
    .sort((a, b) => b.count - a.count || a.extension.localeCompare(b.extension));
}

/**
 * Code is on at the start; docs and config are off unless the folder holds
 * nothing else.
 *
 * @param {{ extension: string }[]} counts
 * @returns {Set<string>}
 */
export function defaultExtensions(counts) {
  const code = counts.filter((entry) => !DOC_EXTENSIONS.has(entry.extension));
  return new Set((code.length ? code : counts).map((entry) => entry.extension));
}

/**
 * @param {{ path: string, size: number }[]} files  Candidate files.
 * @param {{ extensions: Set<string>, skipTests: boolean, search: string, only?: Set<string> | null }} filters
 */
export function visibleFiles(files, { extensions, skipTests, search, only = null }) {
  const needle = search.trim().toLowerCase();
  return files.filter((file) => (
    extensions.has(extensionOf(file.path))
    && (!skipTests || !isTestPath(file.path))
    && (!needle || file.path.toLowerCase().includes(needle))
    && (!only || only.has(file.path))
  ));
}

/**
 * Nests files into folders. With `prefix`, the tree starts at that folder.
 *
 * @param {{ path: string, size: number }[]} files
 * @param {string} [prefix]
 */
export function buildTree(files, prefix = '') {
  const root = { name: prefix, path: prefix, dirs: new Map(), files: [] };
  const cut = prefix ? prefix.length + 1 : 0;
  for (const file of files) {
    const parts = (file.path === prefix ? file.path.slice(file.path.lastIndexOf('/') + 1) : file.path.slice(cut)).split('/');
    let node = root;
    let path = prefix;
    for (const part of parts.slice(0, -1)) {
      path = path ? `${path}/${part}` : part;
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ ...file, name: parts[parts.length - 1] });
  }
  return root;
}

function tooLarge(file) {
  return file.size > LIMITS.fileBytes;
}

/**
 * The files ticked when the picker opens: everything visible when it fits in
 * the room that is left, nothing when it does not.
 *
 * @param {{ path: string, size: number }[]} visible
 * @param {{ files: number, bytes: number }} room
 * @returns {Set<string>}
 */
export function pickDefaults(visible, room) {
  const usable = visible.filter((file) => !tooLarge(file));
  const bytes = usable.reduce((sum, file) => sum + file.size, 0);
  return usable.length <= room.files && bytes <= room.bytes ? new Set(usable.map((file) => file.path)) : new Set();
}

/**
 * The meter line for a selection, counted together with what is already loaded.
 *
 * @param {Set<string>} selected
 * @param {Map<string, number>} sizes  path -> bytes
 * @param {{ files: number, bytes: number, lines: number, names?: Set<string> }} existing
 */
export function selectionSummary(selected, sizes, existing) {
  let bytes = existing.bytes;
  let files = existing.files;
  let picked = 0;
  for (const path of selected) {
    bytes += sizes.get(path) ?? 0;
    picked += sizes.get(path) ?? 0;
    // A file that is already loaded is replaced, so it does not count twice.
    if (!existing.names?.has(path)) files += 1;
  }
  const lines = existing.lines + Math.round(picked / BYTES_PER_LINE);
  const over = [];
  if (bytes > LIMITS.totalBytes) over.push('size');
  if (files > LIMITS.files) over.push('files');
  const used = formatBytes(bytes);
  const limit = formatBytes(LIMITS.totalBytes);
  const unit = limit.slice(limit.lastIndexOf(' '));
  const size = used.endsWith(unit) ? `${used.slice(0, -unit.length)} / ${limit}` : `${used} / ${limit}`;
  return {
    files,
    bytes,
    lines,
    over,
    text: `${size} · ${files} / ${LIMITS.files} files · about ${lines.toLocaleString('en-US')} lines`,
  };
}

/**
 * Turns an import error into a clause that reads after the file name:
 * "src/a.bin is not UTF-8 text." -> "is not UTF-8 text".
 */
export function reasonFrom(path, message) {
  const text = String(message ?? '').trim().replace(/\.$/, '');
  if (text.startsWith(`${path} `)) return text.slice(path.length + 1);
  return text ? `could not be fetched: ${text}` : 'could not be fetched';
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

let token = '';
/** @type {ReturnType<typeof dialogController> | null} */
let dialog = null;
let session = null;

function existingTotals() {
  const { files } = workbench.get();
  // An example is replaced by the import, so it takes no room.
  const real = view.get().example ? [] : files;
  return { ...totals(real), names: new Set(real.map((file) => file.name)) };
}

/** The files the type filters and the preset let through: what can be ticked and imported. */
function eligible() {
  return visibleFiles(session.candidates, {
    extensions: session.extensions,
    skipTests: session.skipTests,
    search: '',
    only: session.onlyChanged ? session.changed : null,
  });
}

/** The eligible files that match the path search: what the tree draws. Searching never unticks a file. */
function shown() {
  return visibleFiles(session.candidates, {
    extensions: session.extensions,
    skipTests: session.skipTests,
    search: session.search,
    only: session.onlyChanged ? session.changed : null,
  });
}

function filesBelow(node, out = []) {
  out.push(...node.files);
  for (const dir of node.dirs.values()) filesBelow(dir, out);
  return out;
}

function paintMeter() {
  const summary = selectionSummary(session.selected, session.sizes, existingTotals());
  const meter = qs('#wb-gh-meter');
  const importButton = qs('#wb-gh-import');
  if (meter) {
    meter.textContent = summary.over.length
      ? `${summary.text}. Over the limit: untick some files.`
      : summary.text;
    if (summary.over.length) meter.dataset.over = '';
    else delete meter.dataset.over;
  }
  if (importButton) {
    const label = importButton.querySelector('.btn__label');
    if (label) label.textContent = session.selected.size ? `Import ${session.selected.size} file${session.selected.size === 1 ? '' : 's'}` : 'Import';
    const blocked = session.selected.size === 0 || summary.over.length > 0;
    if (blocked) importButton.setAttribute('aria-disabled', 'true');
    else importButton.removeAttribute('aria-disabled');
  }
}

/** Sets every rendered checkbox from the selection, without rebuilding the tree. */
function paintChecks() {
  for (const box of qsa('#wb-gh-tree input[data-path]')) box.checked = session.selected.has(box.dataset.path);
  for (const box of qsa('#wb-gh-tree input[data-dir]')) {
    const node = session.nodes.get(box.dataset.dir);
    const below = node ? filesBelow(node).filter((file) => !tooLarge(file)) : [];
    const ticked = below.filter((file) => session.selected.has(file.path)).length;
    box.checked = below.length > 0 && ticked === below.length;
    box.indeterminate = ticked > 0 && ticked < below.length;
    box.disabled = below.length === 0;
  }
  paintMeter();
}

function fileRow(file) {
  const large = tooLarge(file);
  return el('li', { class: 'wb-tree__file' },
    el('label', { class: 'check wb-tree__label' },
      el('input', { class: 'check__box', type: 'checkbox', 'data-path': file.path, disabled: large }),
      el('span', { class: 'check__label wb-tree__name mono', text: file.name, title: file.path }),
      session.changed?.has(file.path) ? el('span', { class: 'chip', dataset: { tone: 'observed' }, text: 'Changed' }) : null,
      el('span', { class: 'wb-tree__size num', text: large ? `${formatBytes(file.size)}, over the file limit` : formatBytes(file.size) })));
}

function dirRow(node) {
  const open = session.expanded.has(node.path);
  const below = filesBelow(node);
  const bytes = below.reduce((sum, file) => sum + file.size, 0);
  const row = el('li', { class: 'wb-tree__dir' },
    el('div', { class: 'wb-tree__row' },
      el('button', {
        class: 'wb-tree__toggle',
        type: 'button',
        'aria-expanded': String(open),
        'aria-label': `${open ? 'Collapse' : 'Expand'} ${node.name}`,
        'data-toggle': node.path,
      }, icon(open ? 'chevron-down' : 'chevron-right')),
      el('label', { class: 'check wb-tree__label' },
        el('input', { class: 'check__box', type: 'checkbox', 'data-dir': node.path }),
        el('span', { class: 'check__label wb-tree__name mono', text: `${node.name}/` }),
        el('span', { class: 'wb-tree__size num', text: `${below.length} file${below.length === 1 ? '' : 's'} · ${formatBytes(bytes)}` }))));
  if (open) row.append(list(node));
  return row;
}

function list(node) {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  return el('ul', { class: 'wb-tree__list' }, dirs.map(dirRow), files.map(fileRow));
}

function renderTree() {
  const target = qs('#wb-gh-tree');
  if (!target) return;
  const visible = shown();
  const tree = buildTree(visible, session.prefix);
  session.nodes = new Map();
  (function index(node) {
    session.nodes.set(node.path, node);
    for (const dir of node.dirs.values()) index(dir);
  })(tree);

  clear(target);
  if (!visible.length) {
    target.append(el('p', { class: 'wb-note', text: session.candidates.length ? 'No file matches the filters.' : 'This folder holds no source or text files.' }));
  } else {
    target.append(list(tree));
  }

  const hidden = session.candidates.length - visible.length;
  const notes = [];
  if (hidden > 0) notes.push(`${hidden.toLocaleString('en-US')} file${hidden === 1 ? '' : 's'} hidden by the filters.`);
  if (session.truncated) notes.push('GitHub cut the listing short. Paste a link to a folder to see the rest.');
  if (!token) notes.push('Without a token GitHub allows 60 requests an hour, and each file is one.');
  const note = qs('#wb-gh-note');
  if (note) note.textContent = notes.join(' ');
  paintChecks();
}

function renderExtensions() {
  const target = qs('#wb-gh-exts');
  if (!target) return;
  clear(target);
  for (const { extension, count } of session.counts) {
    target.append(el('button', {
      class: 'wb-ext',
      type: 'button',
      'aria-pressed': String(session.extensions.has(extension)),
      'data-ext': extension,
    }, el('span', { class: 'mono', text: extension || 'no extension' }), el('span', { class: 'wb-ext__count num', text: String(count) })));
  }
  if (session.changed) {
    target.append(el('button', {
      class: 'wb-ext',
      type: 'button',
      'aria-pressed': String(session.onlyChanged),
      'data-only-changed': '',
    }, el('span', { text: 'Changed in the pull request' }), el('span', { class: 'wb-ext__count num', text: String(session.changed.size) })));
  }
}

/** Keeps only what is still visible ticked after a filter change. */
function pruneSelection() {
  const visible = new Set(eligible().map((file) => file.path));
  for (const path of [...session.selected]) {
    if (!visible.has(path)) session.selected.delete(path);
  }
}

function openPicker({ reference, sha, files, changed = null }) {
  const prefix = reference.kind === 'tree' && reference.path ? reference.path : '';
  const candidates = candidateFiles(files, prefix);
  const counts = extensionCounts(candidates);
  const existing = existingTotals();

  session = {
    owner: reference.owner,
    repo: reference.repo,
    sha,
    prefix,
    candidates,
    counts,
    sizes: new Map(candidates.map((file) => [file.path, file.size])),
    changed: changed ? new Set(changed) : null,
    onlyChanged: Boolean(changed),
    extensions: changed ? new Set(counts.map((entry) => entry.extension)) : defaultExtensions(counts),
    skipTests: true,
    search: '',
    selected: new Set(),
    expanded: new Set(),
    nodes: new Map(),
    truncated: files.truncated === true,
  };

  const visible = shown();
  session.selected = pickDefaults(visible, { files: LIMITS.files - existing.files, bytes: LIMITS.totalBytes - existing.bytes });
  // Small trees open fully; large ones open at the first level.
  const tree = buildTree(visible, prefix);
  (function expand(node, depth) {
    if (visible.length <= EXPAND_ALL_BELOW || depth < 1) session.expanded.add(node.path);
    for (const dir of node.dirs.values()) expand(dir, depth + 1);
  })(tree, 0);

  const source = qs('#wb-gh-source');
  if (source) {
    const where = reference.kind === 'pull'
      ? `pull request #${reference.number}`
      : prefix ? `folder ${prefix}/` : 'the whole repository';
    clear(source).append(
      el('span', { class: 'mono', text: `${reference.owner}/${reference.repo}` }),
      ' · ',
      el('span', { class: 'hash' }, el('span', { class: 'hash__algo', text: 'commit' }), sha.slice(0, 12)),
      ` · ${where}`,
    );
  }
  const search = qs('#wb-gh-search');
  if (search) search.value = '';
  const skip = qs('#wb-gh-skip');
  if (skip) skip.checked = true;
  announce('', { target: '#wb-gh-status' });

  renderExtensions();
  renderTree();
  dialog?.open();
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Fetches paths one request each, so one bad file is named and the rest arrive. */
async function fetchFiles({ owner, repo, sha, paths }, onProgress) {
  const entries = [];
  const errors = [];
  let next = 0;
  let done = 0;
  let stopped = '';

  async function worker() {
    while (next < paths.length) {
      const path = paths[next];
      next += 1;
      if (stopped) {
        errors.push({ name: path, reason: stopped });
        continue;
      }
      try {
        const [file] = await importGithubFiles({ owner, repo, sha, paths: [path], token });
        entries.push(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        errors.push({ name: path, reason: reasonFrom(path, message) });
        // A rate limit or a rejected token fails every later request the same way.
        if (/rate limit|rejected the token/i.test(message)) stopped = reasonFrom(path, message);
      }
      done += 1;
      onProgress?.(done, paths.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENT, paths.length) }, worker));
  const order = new Map(paths.map((path, index) => [path, index]));
  entries.sort((a, b) => order.get(a.name) - order.get(b.name));
  return { entries, errors };
}

function finish({ owner, repo, sha, entries, errors }) {
  const outcome = addEntries(entries, { errors, quiet: true });
  const count = outcome.added.length + outcome.replaced.length;
  if (count > 0) {
    // The commit the files come from is evidence: record it unless the user already wrote a version.
    workbench.set((state) => (state.context.version ? null : { context: { ...state.context, version: `${owner}/${repo}@${sha}` } }));
    track(EVENTS.REPO_IMPORTED);
  }
  const lead = outcome.leftExample ? 'The example is gone. ' : '';
  const from = `${owner}/${repo} at ${sha.slice(0, 7)}`;
  if (count === 0) say(`${lead}Nothing was imported from ${from}. The reasons are listed under the drop zone.`, { error: true });
  else if (outcome.errors.length) say(`${lead}Imported ${count} file${count === 1 ? '' : 's'} from ${from}. ${outcome.errors.length} left out, listed under the drop zone.`, { tone: 'warn' });
  else say(`${lead}Imported ${count} file${count === 1 ? '' : 's'} from ${from}.`, { tone: 'success' });
}

function lookupStatus(message, error = false) {
  const node = qs('#wb-github-status');
  if (!node) return;
  node.textContent = message;
  node.setAttribute('role', error ? 'alert' : 'status');
  if (error) node.dataset.tone = 'error';
  else delete node.dataset.tone;
}

async function findFiles() {
  const input = qs('#wb-github-url');
  const go = qs('#wb-github-go');
  if (!input || !go) return;
  if (workbench.get().busy) {
    say('A review is running. Cancel it to change the files.', { tone: 'warn' });
    return;
  }

  input.removeAttribute('aria-invalid');
  token = (qs('#wb-github-token')?.value ?? '').trim();
  let reference;
  try {
    reference = githubReference(input.value);
  } catch (error) {
    input.setAttribute('aria-invalid', 'true');
    lookupStatus(error.message, true);
    input.focus();
    return;
  }

  setBusy(go, true, 'Looking');
  lookupStatus('Resolving the commit.');
  try {
    const { owner, repo } = reference;
    if (reference.kind === 'blob') {
      const sha = await resolveCommit(reference, token);
      lookupStatus(`Fetching ${reference.path}.`);
      const { entries, errors } = await fetchFiles({ owner, repo, sha, paths: [reference.path] });
      lookupStatus('');
      finish({ owner, repo, sha, entries, errors });
      if (entries.length) input.value = '';
      return;
    }

    let sha;
    let changed = null;
    if (reference.kind === 'pull') {
      const pull = await pullRequestFiles({ owner, repo, number: reference.number, token });
      sha = pull.sha;
      changed = pull.paths;
    } else {
      sha = await resolveCommit(reference, token);
    }
    lookupStatus('Listing the files.');
    const files = await listGithubTree({ owner, repo, sha, token });
    lookupStatus('');
    openPicker({ reference, sha, files, changed });
  } catch (error) {
    input.setAttribute('aria-invalid', 'true');
    lookupStatus(error instanceof Error ? error.message : 'GitHub could not be read.', true);
  } finally {
    setBusy(go, false);
  }
}

async function importSelection() {
  const importButton = qs('#wb-gh-import');
  if (!session || !importButton || importButton.getAttribute('aria-disabled') === 'true') return;
  const paths = eligible().map((file) => file.path).filter((path) => session.selected.has(path));
  if (!paths.length) return;

  const { owner, repo, sha } = session;
  setBusy(importButton, true, `Fetching 0 of ${paths.length}`);
  try {
    const { entries, errors } = await fetchFiles({ owner, repo, sha, paths }, (done, total) => {
      const label = importButton.querySelector('.btn__label');
      if (label) label.textContent = `Fetching ${done} of ${total}`;
    });
    if (!entries.length) {
      announce(`Nothing was fetched. ${paths[0]} ${errors[0]?.reason ?? 'could not be fetched'}.`, { target: '#wb-gh-status', error: true });
      return;
    }
    dialog?.close();
    finish({ owner, repo, sha, entries, errors });
    const input = qs('#wb-github-url');
    if (input) input.value = '';
    session = null;
  } finally {
    setBusy(importButton, false);
    if (session) paintMeter();
  }
}

/** Wires the GitHub import. Call after initFiles(). */
export function initGithub() {
  const element = qs('#wb-github-dialog');
  const go = qs('#wb-github-go');
  if (!element || !go) return;
  dialog = dialogController(element, { initialFocus: '#wb-gh-search', onClose: () => returnFocus(qs('#wb-github-url')) });

  on(go, 'click', findFiles);
  on(qs('#wb-github-url'), 'keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findFiles();
    }
  });

  on(qs('#wb-gh-search'), 'input', (event) => {
    session.search = event.target.value;
    // While searching, every match is in view.
    if (session.search.trim()) for (const path of buildPaths(shown())) session.expanded.add(path);
    renderTree();
  });
  on(qs('#wb-gh-skip'), 'change', (event) => {
    session.skipTests = event.target.checked;
    pruneSelection();
    renderTree();
  });
  on(qs('#wb-gh-exts'), 'click', '.wb-ext', (event, control) => {
    if ('onlyChanged' in control.dataset) {
      session.onlyChanged = !session.onlyChanged;
    } else {
      const extension = control.dataset.ext;
      if (session.extensions.has(extension)) session.extensions.delete(extension);
      else session.extensions.add(extension);
    }
    pruneSelection();
    renderExtensions();
    renderTree();
    // The buttons were rebuilt: put focus back on the one that was pressed.
    const again = 'onlyChanged' in control.dataset ? qs('#wb-gh-exts [data-only-changed]') : qs(`#wb-gh-exts [data-ext="${CSS.escape(control.dataset.ext)}"]`);
    again?.focus();
  });

  const tree = qs('#wb-gh-tree');
  on(tree, 'click', '[data-toggle]', (event, control) => {
    const path = control.dataset.toggle;
    if (session.expanded.has(path)) session.expanded.delete(path);
    else session.expanded.add(path);
    renderTree();
    qs(`#wb-gh-tree [data-toggle="${CSS.escape(path)}"]`)?.focus();
  });
  on(tree, 'change', 'input[data-path]', (event, box) => {
    if (box.checked) session.selected.add(box.dataset.path);
    else session.selected.delete(box.dataset.path);
    paintChecks();
  });
  on(tree, 'change', 'input[data-dir]', (event, box) => {
    const node = session.nodes.get(box.dataset.dir);
    if (!node) return;
    for (const file of filesBelow(node)) {
      if (tooLarge(file)) continue;
      if (box.checked) session.selected.add(file.path);
      else session.selected.delete(file.path);
    }
    paintChecks();
  });

  on(qs('#wb-gh-import'), 'click', importSelection);

  qs('#workspace')?.addEventListener('wb:clear', () => {
    token = '';
    for (const id of ['#wb-github-url', '#wb-github-token']) {
      const field = qs(id);
      if (field) field.value = '';
    }
    lookupStatus('');
  });
}

/** Every folder path on the way to the given files. */
function buildPaths(files) {
  const paths = new Set();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) paths.add(parts.slice(0, depth).join('/'));
  }
  return paths;
}
