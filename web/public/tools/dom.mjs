// DOM helpers shared by the free-tool pages.
//
// Everything a user or a file supplies reaches the page through textContent.
// Nothing is ever parsed as markup, and nothing here makes a network call.

const COPIED_MS = 2000;

/**
 * Creates an element. `props` sets attributes; `class`, `text` and `dataset`
 * are handled by name. Children are nodes or strings.
 *
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {(Node | string | null | undefined | false)[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = String(value);
    else if (name === 'text') node.textContent = String(value);
    else if (name === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** An icon span, as the build-time helper emits it. */
export function icon(name) {
  return el('span', { class: `icon icon--${name}`, 'aria-hidden': 'true' });
}

/** A chip. Tones: observed, unproven, ok, danger, neutral. */
export function chip(label, tone = 'neutral', { dashed = false } = {}) {
  return el('span', { class: dashed ? 'chip chip--dashed' : 'chip', 'data-tone': tone, text: label });
}

/** A file reference chip: the file part shortens, the line part stays whole. */
export function refChip(file, line) {
  const node = el('span', { class: 'ref', title: line ? `${file}:${line}` : file }, [el('span', { class: 'ref__file', text: file })]);
  if (line) node.append(el('span', { class: 'ref__lines', text: `:${line}` }));
  return node;
}

/** A SHA-256 shown in full, in four groups of sixteen so it wraps between groups on a phone. */
export function hashText(sha256) {
  const groups = sha256.match(/.{1,16}/g) ?? [sha256];
  return el('span', { class: 'tool-hash', title: `sha256: ${sha256}` }, groups.map((group) => el('span', { text: group })));
}

export function clear(node) {
  node.replaceChildren();
}

export function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}

/** A notice block, built like the build-time notice() helper. */
export function notice(tone, title, body) {
  const icons = { info: 'info', success: 'ok', warn: 'warn', error: 'error' };
  const content = el('div', { class: 'notice__content' }, [el('p', { class: 'notice__title', text: title })]);
  if (body) content.append(el('div', { class: 'notice__body' }, [el('p', { text: body })]));
  return el('div', { class: `notice notice--${tone}`, role: tone === 'error' ? 'alert' : null }, [icon(icons[tone]), content]);
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Older browsers and non-secure contexts: copy through a temporary field.
  const field = el('textarea', { class: 'visually-hidden', readonly: true, 'aria-hidden': 'true' });
  field.value = text;
  document.body.append(field);
  field.select();
  const done = document.execCommand('copy');
  field.remove();
  if (!done) throw new Error('Copy is not available in this browser.');
}

/**
 * Copies text and confirms it on the button for two seconds: the label reads
 * "Copied" and the icon becomes a tick. Works for icon-only buttons too, where
 * the label is the visually hidden text.
 *
 * @param {HTMLElement} button
 * @param {string} text
 */
export async function copyWithFeedback(button, text) {
  const label = button.querySelector('.btn__label, .visually-hidden');
  const mark = button.querySelector('.icon');
  if (button.dataset.busy) return;
  button.dataset.busy = '';
  const originalLabel = label?.textContent ?? '';
  const originalIcon = mark?.className ?? '';

  let copied = true;
  try {
    await writeClipboard(text);
  } catch {
    copied = false;
  }
  if (label) label.textContent = copied ? 'Copied' : 'Copy failed';
  if (mark && copied) mark.className = 'icon icon--check';
  if (copied) button.dataset.copied = '';

  window.setTimeout(() => {
    if (label) label.textContent = originalLabel;
    if (mark) mark.className = originalIcon;
    delete button.dataset.copied;
    delete button.dataset.busy;
  }, COPIED_MS);
}

/** Saves text as a file through a temporary object URL. */
export function downloadText(name, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const anchor = el('a', { href: url, download: name, class: 'visually-hidden' });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);
const MAX_DROPPED = 400;

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry, prefix, out) {
  if (out.length >= MAX_DROPPED) return;
  if (entry.isFile) {
    out.push({ file: await entryFile(entry), path: `${prefix}${entry.name}` });
    return;
  }
  if (!entry.isDirectory || SKIP_DIRECTORIES.has(entry.name)) return;
  const reader = entry.createReader();
  // readEntries returns the directory in batches; an empty batch ends it.
  for (;;) {
    const batch = await readEntries(reader);
    if (!batch.length) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

/**
 * The files of a drop, with folders walked. `.git` and `node_modules` are left
 * out; at most 400 files are returned.
 *
 * @param {DataTransfer} transfer
 * @returns {Promise<{ file: File, path: string }[]>}
 */
export async function droppedFiles(transfer) {
  const entries = [...(transfer.items ?? [])]
    .map((item) => (item.kind === 'file' && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return pickedFiles(transfer.files);

  const out = [];
  for (const entry of entries) await walk(entry, '', out);
  return out;
}

/** The files of a file input, keeping the folder path when a folder was chosen. */
export function pickedFiles(list) {
  return [...(list ?? [])]
    .filter((file) => !(file.webkitRelativePath || '').split('/').some((segment) => SKIP_DIRECTORIES.has(segment)))
    .slice(0, MAX_DROPPED)
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

async function hasBom(file) {
  const head = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  return head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
}

/**
 * Reads files as UTF-8 text. A file over `maxBytes` is returned under
 * `skipped` with the reason.
 *
 * @param {{ file: File, path: string }[]} entries
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<{ files: { name: string, content: string, bom: boolean, size: number }[], skipped: { name: string, reason: string }[] }>}
 */
export async function readTextFiles(entries, { maxBytes = 5_000_000 } = {}) {
  const files = [];
  const skipped = [];
  for (const { file, path } of entries) {
    if (file.size > maxBytes) {
      skipped.push({ name: path, reason: `Over ${formatBytes(maxBytes)}.` });
      continue;
    }
    try {
      files.push({ name: path, content: await file.text(), bom: await hasBom(file), size: file.size });
    } catch {
      skipped.push({ name: path, reason: 'Could not be read.' });
    }
  }
  return { files, skipped };
}

/**
 * Wires a drop zone: the wrapped file inputs and a drop both call `onFiles`
 * with `{ file, path }` entries.
 *
 * @param {HTMLElement} zone
 * @param {(entries: { file: File, path: string }[]) => void} onFiles
 */
export function wireDrop(zone, onFiles) {
  for (const input of zone.querySelectorAll('input[type="file"]')) {
    input.addEventListener('change', () => {
      const entries = pickedFiles(input.files);
      // Clearing the value lets the same file be chosen twice in a row.
      input.value = '';
      if (entries.length) onFiles(entries);
    });
  }
  const over = (event) => {
    event.preventDefault();
    zone.classList.add('is-over');
  };
  zone.addEventListener('dragenter', over);
  zone.addEventListener('dragover', over);
  zone.addEventListener('dragleave', (event) => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-over');
  });
  zone.addEventListener('drop', async (event) => {
    event.preventDefault();
    zone.classList.remove('is-over');
    const entries = await droppedFiles(event.dataTransfer);
    if (entries.length) onFiles(entries);
  });
}

export function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

// ---------------------------------------------------------------------------
// Workbench handoff
// ---------------------------------------------------------------------------

const HANDOFF_KEY = 'bo:handoff';

/**
 * True for an ordinary primary click. A click with a modifier key, or the
 * middle button, opens a new tab, and a new tab does not share this tab's
 * session storage: that click follows the plain link instead.
 *
 * @param {MouseEvent} event
 */
export function isPlainClick(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Stores `{ files, profile, focus, context }` for the workbench and opens it.
 * Returns false when the browser refuses the storage write; the caller then
 * leaves the visitor on the page with a message.
 *
 * @param {{ files: { name: string, content: string }[], profile: string, focus: string, context: object }} payload
 * @returns {boolean}
 */
export function sendToWorkbench(payload) {
  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(payload));
  } catch {
    return false;
  }
  window.location.assign('/#workspace');
  return true;
}
