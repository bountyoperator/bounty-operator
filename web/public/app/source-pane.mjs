/**
 * The source pane: the lines a review cites, read from the files in this tab,
 * with the cited lines marked and a few lines of context around them.
 *
 * Exports
 *   initSourcePane()                       wire #wb-source-dialog
 *   openSource(ref, { files, manifest, trigger })   show `ref` = { label, start, end }; focus returns to `trigger`
 *   Pure helpers (tested)
 *     fileForLabel(label, files, manifest) -> { name, content } | null
 *     excerpt(content, ref, context)       -> { lines: [{ n, text, cited }], first, last, total }
 *
 * DOM this module owns: everything inside #wb-source-dialog.
 */

import { splitLines } from '../review-core.mjs';
import { clear, copyText, dialogController, el, on, qs } from './ui.mjs';
import { returnFocus } from './workbench.mjs';

const CONTEXT_LINES = 6;
const WHOLE_FILE_LIMIT = 4000;

/**
 * The file a manifest label names. Labels are `input-N/<name>`; the file is
 * taken by position and its name must still match, so a file that was removed
 * or replaced since the review is not shown under another file's label.
 *
 * @param {string} label
 * @param {{ name: string, content: string }[]} files
 * @param {{ label: string }[]} [manifest]
 */
export function fileForLabel(label, files, manifest = []) {
  const at = manifest.findIndex((entry) => entry.label === label);
  const position = at !== -1 ? at : Number(/^input-(\d{1,3})\//.exec(label)?.[1] ?? 0) - 1;
  const file = files?.[position];
  if (!file || label !== `input-${position + 1}/${file.name}`) return null;
  return file;
}

/**
 * The cited lines of a file with `context` lines on each side.
 *
 * @param {string} content
 * @param {{ start: number, end: number }} ref
 * @param {number} [context]  Infinity gives the whole file.
 */
export function excerpt(content, ref, context = CONTEXT_LINES) {
  const all = splitLines(content);
  const total = all.length;
  const start = Math.min(Math.max(1, ref.start), Math.max(1, total));
  const end = Math.min(Math.max(start, ref.end), Math.max(1, total));
  const first = Math.max(1, start - context);
  const last = Math.min(total, end + context);
  const lines = [];
  for (let n = first; n <= last; n += 1) lines.push({ n, text: all[n - 1] ?? '', cited: n >= start && n <= end });
  return { lines, first, last, total, start, end };
}

/** @type {ReturnType<typeof dialogController> | null} */
let dialog = null;
let shown = null;
/** The chip that opened the pane; focus goes back to it. */
let trigger = null;

function draw() {
  const body = qs('#wb-source-body');
  if (!body || !shown) return;
  const { file, ref, whole } = shown;
  const view = excerpt(file.content, ref, whole ? Infinity : CONTEXT_LINES);
  const range = ref.end !== ref.start ? `${view.start}–${view.end}` : `${view.start}`;

  clear(body).append(el('figure', { class: 'code code--numbered' },
    el('figcaption', { class: 'code__bar' },
      el('span', { class: 'code__name', text: shown.label }),
      el('span', { class: 'code__range', text: `cited ${range} of ${view.total}` })),
    el('pre', { class: 'code__pre', id: 'wb-source-code', tabindex: '0', role: 'region', 'aria-label': `Source: ${shown.label}` },
      el('code', {}, view.lines.map((line) => el('span', {
        class: ['code__line', line.cited ? 'is-hl' : 'is-dim'],
        'data-n': String(line.n),
        text: `${line.text}\n`,
      }))))));

  shown.meta = whole ? `${view.total.toLocaleString('en-US')} lines` : `Lines ${view.first}–${view.last} of ${view.total.toLocaleString('en-US')}`;
  const meta = qs('#wb-source-meta');
  if (meta) meta.textContent = shown.meta;
  const all = qs('#wb-source-all');
  if (all) {
    const label = all.querySelector('.btn__label');
    if (label) label.textContent = whole ? 'Show the cited lines' : 'Show the whole file';
    // Nothing to toggle when the excerpt already is the whole file, or the file is very long.
    all.hidden = (!whole && view.total <= view.lines.length) || view.total > WHOLE_FILE_LIMIT;
  }
}

/** Brings the first cited line into view, with its context above it. */
function reveal() {
  qs('#wb-source-body')?.querySelector('.is-hl')?.scrollIntoView({ block: 'center' });
}

/**
 * Opens the pane on a cited location.
 *
 * @param {{ label: string, start: number, end: number }} ref
 * @param {{ files: { name: string, content: string }[], manifest?: { label: string }[], trigger?: Element | null }} source
 */
export function openSource(ref, { files, manifest = [], trigger: opener = null }) {
  if (!dialog) return;
  trigger = opener;
  const file = fileForLabel(ref.label, files, manifest);
  const body = qs('#wb-source-body');
  if (!file) {
    shown = null;
    if (body) clear(body).append(el('p', { class: 'wb-note', text: `${ref.label} is no longer loaded in this tab, so its lines cannot be shown.` }));
    for (const id of ['#wb-source-all', '#wb-source-copy']) {
      const control = qs(id);
      if (control) control.hidden = true;
    }
    dialog.open();
    return;
  }
  shown = { file, ref, label: ref.label, whole: false, meta: '' };
  const copy = qs('#wb-source-copy');
  if (copy) copy.hidden = false;
  draw();
  dialog.open();
  reveal();
}

/** Wires the source dialog. Call once. */
export function initSourcePane() {
  const element = qs('#wb-source-dialog');
  if (!element) return;
  dialog = dialogController(element, { initialFocus: '#wb-source-code', onClose: () => returnFocus(trigger) });

  on(qs('#wb-source-all'), 'click', () => {
    if (!shown) return;
    shown.whole = !shown.whole;
    draw();
    reveal();
    qs('#wb-source-code')?.focus({ preventScroll: true });
  });
  on(qs('#wb-source-copy'), 'click', async () => {
    if (!shown) return;
    const { lines } = excerpt(shown.file.content, shown.ref, 0);
    const copied = await copyText(lines.map((line) => line.text).join('\n'));
    // The line under the code doubles as the dialog's status line.
    const meta = qs('#wb-source-meta');
    if (!meta) return;
    meta.textContent = copied ? 'Cited lines copied.' : 'The browser refused the copy. Select the lines and copy them.';
    setTimeout(() => {
      if (shown && meta.isConnected) meta.textContent = shown.meta;
    }, 2500);
  });
}
