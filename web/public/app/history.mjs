/**
 * Local history: finished reviews kept in this browser, in IndexedDB.
 *
 * Off until the user turns it on. A saved review is its packet, its manifest
 * and a few facts about it (profile, model, verdict, time), plus the review
 * text the packet is built from. Source files, evidence fields outside the
 * packet, API keys and tokens are never saved, and nothing is uploaded.
 *
 * Exports
 *   initHistory()                      wire #wb-history-open and #wb-history-dialog
 *   historyEnabled()                   -> boolean
 *   setHistoryEnabled(on)              -> boolean   whether the choice could be stored
 *   saveReview({ result, packet, verdict, headline, counts })   -> Promise<string | null>   the id
 *   listReviews()                      -> Promise<Record[]>   newest first
 *   deleteReview(id), clearReviews()   -> Promise<void>
 *   exportAll()                        -> Promise<string>     JSON
 *   historyRecord(input)               -> Record              pure, tested: the only fields that are stored
 *   resultFrom(record)                 -> WorkbenchResult     pure, tested: what a stored record opens as
 *   outcomeMark(record)                -> '' | 'Blocked' | 'Declined'   pure, tested: the mark of a row that is not a review
 *
 * Events on #workspace
 *   wb:history   detail { enabled }   the switch changed; results.mjs saves the review on screen when it turns on
 *
 * DOM this module owns: #wb-history-open and everything inside #wb-history-dialog.
 */

import { blockOf } from './blocked.mjs';
import { workbench } from './state.mjs';
import { announce, button, clear, dialogController, download, el, formatDate, on, qs, setBusy } from './ui.mjs';
import { emit, returnFocus, setStep, view } from './workbench.mjs';

const DB_NAME = 'bo-history';
const DB_VERSION = 1;
const STORE = 'reviews';
const FLAG_KEY = 'bo:history';
const MAX_ENTRIES = 200;
const PACKET_MAX_CHARS = 2000000;
const CONFIRM_MS = 5000;

const VERDICT_LABELS = Object.freeze({
  submit: 'Submit',
  'rewrite-then-submit': 'Rewrite, then submit',
  'prove-first': 'Prove first',
  'hold-duplicate': 'Hold: duplicate',
  drop: 'Drop',
  'fix-before-deploy': 'Fix before deploy',
  'no-blocking-issues': 'No blocking issues',
});

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

export function historyEnabled() {
  try {
    return globalThis.localStorage?.getItem(FLAG_KEY) === 'on';
  } catch {
    return false;
  }
}

/** @param {boolean} enabled */
export function setHistoryEnabled(enabled) {
  try {
    if (enabled) globalThis.localStorage.setItem(FLAG_KEY, 'on');
    else globalThis.localStorage.removeItem(FLAG_KEY);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function text(value, max = 400) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * The record that is stored for a review. Built field by field from this
 * list, so nothing else on a result (and nothing from the workbench state)
 * can reach storage.
 *
 * @param {{ result: import('./state.mjs').WorkbenchResult, packet: string, verdict?: string, headline?: string, counts?: object, now?: Date }} input
 */
export function historyRecord({ result, packet, verdict = '', headline = '', counts = null, now = new Date() }) {
  const savedAt = now.toISOString();
  const created = text(result.timestamp, 40) || savedAt;
  const manifest = Array.isArray(result.manifest)
    ? result.manifest.map((entry) => ({
      label: text(entry.label, 300),
      bytes: Number(entry.bytes) || 0,
      sha256: text(entry.sha256, 64),
      lines: Number.isFinite(entry.lines) ? entry.lines : null,
    }))
    : [];
  return {
    id: created,
    savedAt,
    created,
    profileId: text(result.profile?.id, 40),
    profileName: text(result.profile?.name, 80),
    mode: text(result.mode, 20),
    source: text(result.source, 20),
    provider: text(result.provider, 40),
    model: text(result.model, 200),
    truncated: result.truncated === true,
    refused: result.refused === true,
    ...(blockOf(result.blocked) ? { blocked: blockOf(result.blocked) } : {}),
    verdict: text(verdict, 40),
    headline: text(headline, 300),
    counts: counts && typeof counts === 'object'
      ? { critical: Number(counts.critical) || 0, high: Number(counts.high) || 0, medium: Number(counts.medium) || 0 }
      : null,
    manifest,
    review: text(result.review, PACKET_MAX_CHARS),
    packet: text(packet, PACKET_MAX_CHARS),
  };
}

/** The result a stored record shows as, read only. Only a known block id comes back out of storage. */
export function resultFrom(record) {
  return {
    review: record.review,
    manifest: record.manifest,
    profile: { id: record.profileId, name: record.profileName },
    mode: record.mode,
    provider: record.provider,
    model: record.model,
    truncated: record.truncated,
    refused: record.refused,
    ...(blockOf(record.blocked) ? { blocked: blockOf(record.blocked) } : {}),
    source: record.source,
    timestamp: record.created,
  };
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function openDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The history database is in use by another tab.'));
  });
}

/** Runs `work(store)` in one transaction and resolves with its request's result. */
async function withStore(mode, work) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/** @returns {Promise<ReturnType<typeof historyRecord>[]>} Newest first. */
export async function listReviews() {
  const records = (await withStore('readonly', (store) => store.getAll())) ?? [];
  return records.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

/**
 * Stores one review. Resolves with its id, or null when history is off.
 *
 * @param {Parameters<typeof historyRecord>[0]} input
 */
export async function saveReview(input) {
  if (!historyEnabled() || !input?.result?.review) return null;
  const record = historyRecord(input);
  await withStore('readwrite', (store) => store.put(record));

  const all = await listReviews();
  for (const old of all.slice(MAX_ENTRIES)) await withStore('readwrite', (store) => store.delete(old.id));
  return record.id;
}

/** @param {string} id */
export async function deleteReview(id) {
  await withStore('readwrite', (store) => store.delete(id));
}

export async function clearReviews() {
  await withStore('readwrite', (store) => store.clear());
}

/** Every saved review as one JSON document. */
export async function exportAll() {
  const reviews = await listReviews();
  return `${JSON.stringify({ tool: 'Bounty Operator', exported: new Date().toISOString(), reviews }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof dialogController> | null} */
let dialog = null;
let confirmTimer = null;

function status(message, options = {}) {
  announce(message, { target: '#wb-history-status', ...options });
}

/**
 * The mark of a saved answer that is not a review: the provider blocked it, or
 * the model declined. '' for a review.
 *
 * @param {{ blocked?: unknown, refused?: unknown }} record
 * @returns {'' | 'Blocked' | 'Declined'}
 */
export function outcomeMark(record) {
  if (blockOf(record?.blocked)) return 'Blocked';
  return record?.refused === true ? 'Declined' : '';
}

function row(record) {
  const mark = outcomeMark(record);
  const title = record.headline || (mark ? `${mark}: ${record.profileName || 'Review'}` : record.profileName || 'Review');
  const facts = [record.profileName, record.model, `${record.manifest.length} file${record.manifest.length === 1 ? '' : 's'}`, formatDate(record.savedAt, { time: true })].filter(Boolean);
  return el('li', { class: 'wb-history__item', dataset: { id: record.id } },
    el('div', { class: 'wb-history__text' },
      record.verdict ? el('span', { class: 'chip verdict', dataset: { verdict: record.verdict }, text: VERDICT_LABELS[record.verdict] ?? record.verdict }) : null,
      // A blocked or declined answer has no verdict: the row says which it is, in the unproven ink.
      mark ? el('span', { class: 'chip', dataset: { tone: 'unproven', outcome: mark.toLowerCase() }, text: mark }) : null,
      el('p', { class: 'wb-history__title', text: title }),
      el('p', { class: 'fine', text: facts.join(' · ') })),
    el('div', { class: 'wb-history__actions' },
      button({ label: 'Open', size: 'sm', attrs: { 'data-open': record.id } }),
      button({ label: `Download the packet of ${title}`, icon: 'download', iconOnly: true, size: 'sm', variant: 'quiet', attrs: { 'data-download': record.id } }),
      button({ label: `Delete ${title}`, icon: 'trash', iconOnly: true, size: 'sm', variant: 'quiet', attrs: { 'data-delete': record.id } })));
}

let records = [];

async function refresh() {
  const list = qs('#wb-history-list');
  const toggle = qs('#wb-history-on');
  if (toggle) toggle.checked = historyEnabled();
  if (!list) return;
  try {
    records = await listReviews();
  } catch {
    records = [];
    clear(list);
    status('This browser blocks site storage here, so history cannot be kept.', { tone: 'warn' });
    return;
  }
  clear(list);
  if (!records.length) {
    list.append(el('li', { class: 'wb-history__empty muted', text: historyEnabled() ? 'No saved reviews yet. The next finished review is saved here.' : 'No saved reviews.' }));
  } else {
    list.append(...records.map(row));
  }
  for (const id of ['#wb-history-clear', '#wb-history-export']) {
    const control = qs(id);
    if (control) control.hidden = records.length === 0;
  }
}

function resetConfirm() {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  const control = qs('#wb-history-clear');
  const label = control?.querySelector('.btn__label');
  if (label) label.textContent = 'Delete all';
  if (control) delete control.dataset.armed;
}

/** Wires the history button and dialog. Call after initWorkbench(). */
export function initHistory() {
  const element = qs('#wb-history-dialog');
  const opener = qs('#wb-history-open');
  if (!element || !opener) return;
  // Opening a saved review moves focus to the result; every other close returns it to the History button.
  let opening = false;
  dialog = dialogController(element, {
    initialFocus: '#wb-history-on',
    onClose: () => {
      resetConfirm();
      if (!opening) returnFocus(opener);
      opening = false;
    },
  });

  on(opener, 'click', async () => {
    status('');
    await refresh();
    dialog.open();
  });

  on(qs('#wb-history-on'), 'change', async (event) => {
    const enabled = event.target.checked;
    if (!setHistoryEnabled(enabled)) {
      event.target.checked = false;
      status('This browser blocks site storage here, so the choice cannot be kept.', { tone: 'warn' });
      return;
    }
    emit('history', { enabled });
    status(enabled ? 'History is on. Finished reviews are saved in this browser from now on.' : 'History is off. Saved reviews stay until you delete them.', { tone: 'success' });
    // The review on screen is saved by the result view; give it a moment, then list it.
    setTimeout(refresh, 150);
  });

  const list = qs('#wb-history-list');
  on(list, 'click', '[data-open]', (event, control) => {
    const record = records.find((entry) => entry.id === control.dataset.open);
    if (!record) return;
    if (workbench.get().busy) {
      status('A review is running. Open a saved one when it finishes.', { tone: 'warn' });
      return;
    }
    view.set({ history: { result: resultFrom(record), context: {}, packet: record.packet, savedAt: record.savedAt } });
    opening = true;
    dialog.close();
    setStep('results');
  });
  on(list, 'click', '[data-download]', (event, control) => {
    const record = records.find((entry) => entry.id === control.dataset.download);
    if (!record) return;
    const name = `bounty-operator-${record.profileId || 'review'}-${record.created.slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.md`;
    download(name, record.packet, 'text/markdown');
    status('Packet downloaded.', { tone: 'success' });
  });
  on(list, 'click', '[data-delete]', async (event, control) => {
    const id = control.dataset.delete;
    const items = Array.from(list.querySelectorAll('[data-delete]'));
    const at = items.indexOf(control);
    await deleteReview(id).catch(() => {});
    if (view.get().history?.result?.timestamp === id) view.set({ history: null });
    await refresh();
    status('Deleted.', { tone: 'success' });
    // Focus stays in the list, on the review that took this one's place.
    const remaining = Array.from(list.querySelectorAll('[data-delete]'));
    (remaining[Math.min(at, remaining.length - 1)] ?? qs('#wb-history-on'))?.focus();
  });

  on(qs('#wb-history-clear'), 'click', async (event) => {
    const control = event.currentTarget;
    const label = control.querySelector('.btn__label');
    if (!('armed' in control.dataset)) {
      // Deleting everything takes a second press.
      control.dataset.armed = '';
      if (label) label.textContent = `Press again to delete ${records.length}`;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(resetConfirm, CONFIRM_MS);
      return;
    }
    resetConfirm();
    setBusy(control, true);
    await clearReviews().catch(() => {});
    setBusy(control, false);
    view.set({ history: null });
    await refresh();
    status('All saved reviews are deleted.', { tone: 'success' });
    qs('#wb-history-on')?.focus();
  });

  on(qs('#wb-history-export'), 'click', async () => {
    try {
      download(`bounty-operator-history-${new Date().toISOString().slice(0, 10)}.json`, await exportAll(), 'application/json');
      status('Exported.', { tone: 'success' });
    } catch {
      status('The saved reviews could not be read.', { error: true });
    }
  });
}
