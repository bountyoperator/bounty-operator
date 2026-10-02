/**
 * The workbench core: the three steps, the status line, the Load form
 * (profile, mode, focus, evidence), the privacy check and the prompt preview.
 *
 * Every other workbench module builds on this one and none of them is
 * imported here, so the dependency runs one way:
 *
 *   state.mjs, ui.mjs, api.mjs  <-  workbench.mjs  <-  files, github-ui, providers-ui,
 *                                                      run, pasteback, results, source-pane,
 *                                                      history  <-  main.mjs
 *
 * Nothing touches the document until initWorkbench() is called, so the pure
 * helpers below can be imported under node.
 *
 * Exports
 *   Constants
 *     STEP_LABELS                      { files: 'Load', review: 'Run', results: 'Result' }
 *     WORK_FIELDS                      the state fields that are "the work": files, focus, context, profile, mode, result
 *   Stores
 *     view                             Store<{ example, via, keyProvider, ack, history }>   UI state beside the workbench store
 *   Steps and status
 *     initWorkbench()                  -> boolean   false when the page has no #workspace
 *     setStep(step, { scroll, focus }) show a step: scrolls the workbench into view and moves focus to the panel title
 *     goTo(step)                       -> boolean   the guarded version the stepper uses
 *     say(message, { tone, error, action, hold })   the status line, with an optional button
 *     emit(name, detail)               dispatch a `wb:<name>` event on #workspace
 *     returnFocus(control)             focus the control that opened a dialog, for its onClose
 *   Input
 *     fileStats(file)                  -> { bytes, lines }
 *     totals(files)                    -> { files, bytes, lines }
 *     scan(state?)                     -> { coverage, error }       the privacy check, never throws
 *     warningsAccepted(coverage)       -> boolean
 *     prepare({ acknowledge })         -> Promise<Prepared>         throws the engine's error
 *     buildPrompt()                    -> Promise<{ text, prepared } | null>   reports the failure itself; core profiles only
 *     buildPreview()                   -> Promise<{ text, hosted } | null>     the prompt, or for a hosted profile the request that leaves
 *     isHosted(profileId)              -> boolean   the server adds the profile's method at run time
 *     hostedLine(profileId)            -> string    the one line shown where a prompt would be offered
 *     reportInputError(error)          show a prepare()/scan() failure and take the user to it
 *     promptFileName(profileId)        -> 'bounty-operator-prompt-<profile>.md'
 *   Work
 *     hasWork(state?)                  -> boolean
 *     enterExample(example, result)    load an example; real work is put aside
 *     beginRealWork()                  -> boolean   leave the example before real material is added
 *     leaveExample()                   -> boolean   back to the work that was put aside, or to a blank workbench
 *     clearAll()                       a true reset, with Undo
 *   Pure helpers (tested)
 *     stepStates(state, viewState)     -> { files, review, results }  each 'done' | 'current' | 'todo'
 *     profileGroups(profiles)          -> [{ title, profiles }]
 *     evidenceGroups(profileId)        -> [{ title, fields }]
 *     warnSignature(coverage)          -> string
 *     maskLine(content, line, label)   -> string
 *     findingTarget(finding)           -> { kind: 'line' | 'file' | 'focus' | 'context', index?, line?, field? }
 *
 * Events on #workspace (CustomEvent, bubbling)
 *   wb:step     detail { step, previous }
 *   wb:clear    the workbench was cleared: modules empty their own fields
 *   wb:example  detail { id }   an example was loaded or left ('' when left)
 *
 * DOM this module owns: #workspace[data-step][data-busy], #wb-stepper buttons
 * [data-step-target], #wb-status, #wb-profiles, #wb-profile-detail, #wb-mode,
 * #wb-focus, #wb-evidence, #wb-privacy, #wb-preview, #wb-continue, #wb-clear,
 * #wb-summary and the preview dialog.
 */

import { CONTEXT_FIELDS, evidenceStatus, profileNeeds } from '../evidence.mjs';
import { CORE_PROFILE_IDS, PROFILES, reviewProfile } from '../profiles.mjs';
import { PROVIDERS } from '../providers.mjs';
import { LIMITS, checkInputs, describeFinding, prepareRequest, prepareReview, promptExport, splitLines, textBytes } from '../review-core.mjs';
import { track } from './api.mjs';
import { EVENTS } from './events.mjs';
import { STEPS, createStore, initialState, readSession, removeSession, workbench, writeSession } from './state.mjs';
import { announce, button, clear, copyText, dialogController, download, el, formatBytes, icon, notice, on, qs, qsa } from './ui.mjs';

export const STEP_LABELS = Object.freeze({ files: 'Load', review: 'Run', results: 'Result' });
export const WORK_FIELDS = Object.freeze(['files', 'focus', 'context', 'profile', 'mode', 'result']);

const VIEW_KEY = 'bo:workbench:view';
const STASH_KEY = 'bo:workbench:stash';
const VIA = Object.freeze(['connect', 'key', 'export']);
const STATUS_CLEAR_MS = 10000;
const SCAN_DELAY_MS = 150;
const FINDINGS_SHOWN = 12;

// ---------------------------------------------------------------------------
// View state: what the workbench shows that is not the work itself
// ---------------------------------------------------------------------------

function defaultKeyProvider() {
  // "My own API key" opens on the first provider that is not the one-click one.
  return (PROVIDERS.find((provider) => provider.id !== 'openrouter') ?? PROVIDERS[0]).id;
}

/**
 * @typedef {object} ViewState
 * @property {string} example       id of the loaded example; '' while the work is the user's own
 * @property {'connect' | 'key' | 'export'} via   how the review runs
 * @property {string} keyProvider   the provider chosen under "My own API key"
 * @property {string} ack           signature of the privacy warnings the user accepted
 * @property {object | null} history  a saved review opened read-only: { result, context, savedAt }
 */
export const view = createStore(() => ({
  example: '',
  via: 'connect',
  keyProvider: defaultKeyProvider(),
  ack: '',
  history: null,
}));

function storedView() {
  const stored = readSession(VIEW_KEY);
  if (!stored || typeof stored !== 'object') return {};
  const restored = {};
  if (typeof stored.example === 'string') restored.example = stored.example.slice(0, 80);
  if (VIA.includes(stored.via)) restored.via = stored.via;
  if (PROVIDERS.some((provider) => provider.id === stored.keyProvider)) restored.keyProvider = stored.keyProvider;
  if (typeof stored.ack === 'string') restored.ack = stored.ack.slice(0, 20000);
  return restored;
}

function saveView() {
  const { example, via, keyProvider, ack } = view.get();
  writeSession(VIEW_KEY, { example, via, keyProvider, ack });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * How each step shows in the stepper.
 *
 * @param {{ step: string, files: unknown[], result: unknown }} state
 * @param {{ history?: unknown }} [viewState]
 * @returns {{ files: string, review: string, results: string }}
 */
export function stepStates(state, viewState = {}) {
  const current = STEPS.includes(state.step) ? state.step : STEPS[0];
  const at = STEPS.indexOf(current);
  const hasResult = Boolean(state.result) || Boolean(viewState.history);
  const done = {
    files: state.files.length > 0 && at > 0,
    review: hasResult && current === 'results',
    results: false,
  };
  return Object.fromEntries(STEPS.map((step) => [step, step === current ? 'current' : done[step] ? 'done' : 'todo']));
}

const GROUP_TITLES = Object.freeze({
  either: 'Review code',
  bounty: 'Test a finding before you file it',
  'own-code': 'Review your own code',
});

/**
 * The listed profiles, grouped by what they are for.
 *
 * @param {readonly { id: string, mode: string, listed: boolean }[]} [profiles]
 * @returns {{ title: string, profiles: object[] }[]}
 */
export function profileGroups(profiles = PROFILES) {
  const groups = new Map();
  for (const profile of profiles) {
    if (!profile.listed) continue;
    const title = GROUP_TITLES[profile.mode] ?? GROUP_TITLES.either;
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(profile);
  }
  return [...groups].map(([title, members]) => ({ title, profiles: members }));
}

const EVIDENCE_GROUPS = Object.freeze([
  { title: 'Target', keys: ['target', 'scope', 'version', 'proofRevision'] },
  { title: 'Programme rules', keys: ['rules', 'impactList', 'impactRow', 'exclusions', 'economics'] },
  { title: 'Proof', keys: ['proof', 'proofLog', 'mocks', 'loss', 'actors'] },
  { title: 'Prior art', keys: ['prior', 'cloneDepth', 'ownHistory'] },
  { title: 'Submission', keys: ['readBack'] },
  { title: 'Notes', keys: ['notes'] },
]);

/**
 * The Context fields a profile reads, grouped for the form. Notes is always
 * offered. A field the groups above do not know lands under "More".
 *
 * @param {string} profileId
 * @returns {{ title: string, fields: import('../evidence.mjs').ContextField[] }[]}
 */
export function evidenceGroups(profileId) {
  const wanted = new Map(profileNeeds(profileId).context.filter(Boolean).map((field) => [field.key, field]));
  const notes = CONTEXT_FIELDS.find((field) => field.key === 'notes');
  if (notes) wanted.set('notes', notes);

  const groups = [];
  for (const group of EVIDENCE_GROUPS) {
    const fields = group.keys.filter((key) => wanted.has(key)).map((key) => wanted.get(key));
    for (const key of group.keys) wanted.delete(key);
    if (fields.length) groups.push({ title: group.title, fields });
  }
  if (wanted.size) groups.push({ title: 'More', fields: [...wanted.values()] });
  return groups;
}

/**
 * Identifies a set of privacy warnings, so an acceptance applies to exactly
 * the lines the user saw. Any change to the flagged lines changes it.
 *
 * @param {{ findings: { source: string, name: string, line: number, kind: string, severity: string }[], warnings: number } | null} coverage
 * @returns {string}
 */
export function warnSignature(coverage) {
  if (!coverage || !coverage.warnings) return '';
  const parts = coverage.findings
    .filter((finding) => finding.severity === 'warn')
    .map((finding) => `${finding.source}:${finding.line}:${finding.kind}`);
  return `${coverage.warnings}|${parts.join(',')}`;
}

/**
 * Replaces one line of a file with a marker, keeping every line break, so the
 * line numbers of the rest of the file do not move.
 *
 * @param {string} content
 * @param {number} line  1-based.
 * @param {string} [label]  What was there, in words: "AWS access key".
 * @returns {string}
 */
export function maskLine(content, line, label = 'secret') {
  const parts = String(content).split(/(\r\n|\r|\n)/);
  const at = (line - 1) * 2;
  if (!Number.isInteger(line) || line < 1 || at >= parts.length) return content;
  parts[at] = `[masked: ${label}]`;
  return parts.join('');
}

/**
 * Where a privacy finding points, so the list can offer the action that fixes it.
 *
 * @param {{ source: string, name: string, line: number }} finding
 * @returns {{ kind: 'line' | 'file' | 'focus' | 'context', index?: number, line?: number, field?: string }}
 */
export function findingTarget(finding) {
  const input = /^input-(\d{1,3})(-name)?$/.exec(finding.source);
  if (input) {
    const index = Number(input[1]) - 1;
    return input[2] || finding.line < 1 ? { kind: 'file', index } : { kind: 'line', index, line: finding.line };
  }
  if (finding.source === 'context') return { kind: 'context', field: finding.name };
  return { kind: 'focus' };
}

/** @param {string} profileId */
export function promptFileName(profileId) {
  return `bounty-operator-prompt-${String(profileId).replace(/[^a-z0-9-]/gi, '') || 'review'}.md`;
}

const stats = new WeakMap();

/**
 * Size and line count of one file, measured once per file object.
 *
 * @param {{ name: string, content: string }} file
 * @returns {{ bytes: number, lines: number }}
 */
export function fileStats(file) {
  let measured = stats.get(file);
  if (!measured) {
    let bytes = 0;
    try {
      bytes = textBytes(file.content);
    } catch {
      bytes = String(file.content ?? '').length;
    }
    measured = { bytes, lines: splitLines(file.content).length };
    stats.set(file, measured);
  }
  return measured;
}

/**
 * @param {{ name: string, content: string }[]} files
 * @returns {{ files: number, bytes: number, lines: number }}
 */
export function totals(files) {
  let bytes = 0;
  let lines = 0;
  for (const file of files) {
    const measured = fileStats(file);
    bytes += measured.bytes;
    lines += measured.lines;
  }
  return { files: files.length, bytes, lines };
}

/** True when the state holds anything the user would miss. */
export function hasWork(state = workbench.get()) {
  return state.files.length > 0 || state.focus.trim() !== '' || Boolean(state.result);
}

function pick(state, fields) {
  return Object.fromEntries(fields.map((field) => [field, state[field]]));
}

// ---------------------------------------------------------------------------
// Status line and events
// ---------------------------------------------------------------------------

let root = null;
let statusTimer = null;

/**
 * Dispatches `wb:<name>` on the workbench section.
 *
 * @param {string} name
 * @param {unknown} [detail]
 */
export function emit(name, detail) {
  root?.dispatchEvent(new CustomEvent(`wb:${name}`, { bubbles: true, detail }));
}

/**
 * Writes the status line under the stepper. Errors and warnings stay until
 * the next message; progress and success lines clear themselves unless `hold`.
 *
 *   say('3 files added.');
 *   say(error.message, { error: true });
 *   say('Cleared.', { action: { label: 'Undo', onClick: restore } });
 *
 * @param {string} message
 * @param {{ tone?: 'info' | 'success' | 'warn' | 'error', error?: boolean, hold?: boolean, action?: { label: string, onClick: () => void } }} [options]
 */
export function say(message, { tone = 'info', error = false, hold = false, action } = {}) {
  clearTimeout(statusTimer);
  statusTimer = null;
  const kind = error ? 'error' : tone;
  // With a button the line is rebuilt at once, so the button is never lost to the re-announce delay.
  if (action) announce('');
  const node = announce(message, { tone: kind, error });
  if (!node || !message) return;

  if (action) {
    const content = node.querySelector('.notice__content');
    content?.append(
      button({
        label: action.label,
        size: 'sm',
        className: 'wb__status-action',
        onClick: () => {
          say('');
          action.onClick();
        },
      }),
    );
  }
  if (!hold && !action && (kind === 'info' || kind === 'success')) {
    statusTimer = setTimeout(() => announce(''), STATUS_CLEAR_MS);
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function panel(step) {
  return qs(`#wb-panel-${step}`);
}

function paintStepper() {
  const states = stepStates(workbench.get(), view.get());
  STEPS.forEach((step, index) => {
    const control = qs(`#wb-step-${step}`);
    if (!control) return;
    const state = states[step];
    control.dataset.state = state;
    if (state === 'current') control.setAttribute('aria-current', 'step');
    else control.removeAttribute('aria-current');

    const marker = control.querySelector('.stepper__marker');
    marker?.replaceChildren(state === 'done' ? icon('check') : el('span', { 'aria-hidden': 'true' }, index + 1));
    control.querySelector('.visually-hidden')?.remove();
    if (state === 'done') control.append(el('span', { class: 'visually-hidden' }, ', done'));
  });
}

function paintStep(step, previous) {
  if (!root) return;
  root.dataset.step = step;
  for (const name of STEPS) {
    const node = panel(name);
    if (!node) continue;
    const shown = name === step;
    node.hidden = !shown;
    node.classList.toggle('panel-enter', shown && step !== previous);
  }
  paintStepper();
}

/**
 * Shows a step. The workbench scrolls into view and focus moves to the panel
 * title, so the next Tab lands in the panel and a screen reader says where
 * the user is.
 *
 * @param {'files' | 'review' | 'results'} step
 * @param {{ scroll?: boolean, focus?: boolean }} [options]
 */
export function setStep(step, { scroll = true, focus = true } = {}) {
  if (!STEPS.includes(step)) return;
  const previous = workbench.get().step;
  // Leaving the result of a saved review returns to the user's own work.
  if (step !== 'results' && view.get().history) view.set({ history: null });
  workbench.set({ step });
  // The store paints on change; paint here too when the step did not change.
  if (previous === step) paintStep(step, previous);

  if (!root) return;
  if (scroll) root.scrollIntoView({ block: 'start' });
  if (focus) panel(step)?.querySelector('.wb__title')?.focus({ preventScroll: true });
  if (previous !== step) emit('step', { step, previous });
}

/**
 * Puts focus back on the control that opened a dialog. Safari does not focus
 * a button when it is clicked: focus lands on the nearest focusable ancestor,
 * and that is where the browser returns it when the dialog closes.
 *
 * @param {Element | null | undefined} control
 */
export function returnFocus(control) {
  if (control?.isConnected && typeof control.focus === 'function') control.focus({ preventScroll: true });
}

/** The first control of a row, for sending the user to what needs fixing. */
function focusControl(selector) {
  const node = qs(selector);
  if (!node) return;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: 'center' });
}

function tryContinue() {
  const state = workbench.get();
  if (!state.files.length) {
    say('Add at least one file. Drop it, paste it, or import it from GitHub.', { error: true });
    setStep('files', { scroll: false, focus: false });
    focusControl('#wb-pick-files');
    return false;
  }

  const { coverage, error } = scan(state);
  renderPrivacy(coverage, error);
  if (error) {
    say(error.message, { error: true });
    setStep('files', { scroll: false, focus: false });
    focusControl('#wb-privacy');
    return false;
  }
  if (coverage.blocking > 0) {
    say(`${count(coverage.blocking, 'secret')} found. Mask the line or remove the file, then continue.`, { error: true });
    setStep('files', { scroll: false, focus: false });
    focusControl('#wb-privacy');
    return false;
  }
  if (coverage.warnings > 0 && !warningsAccepted(coverage)) {
    say(`${count(coverage.warnings, 'line')} flagged. Check them below, then continue.`, { tone: 'warn' });
    setStep('files', { scroll: false, focus: false });
    focusControl('#wb-privacy-ack');
    return false;
  }
  say('');
  setStep('review');
  return true;
}

/**
 * Goes to a step if the workbench is ready for it, and says why when it is not.
 *
 * @param {'files' | 'review' | 'results'} step
 * @returns {boolean}
 */
export function goTo(step) {
  const state = workbench.get();
  if (state.busy && step !== state.step) {
    say('A review is running. Cancel it to change the input.', { tone: 'warn' });
    return false;
  }
  if (step === 'review') return tryContinue();
  if (step === 'results' && !state.result && !view.get().history) {
    say('No result yet. Run a review, or load the example.', { tone: 'warn' });
    return false;
  }
  setStep(step);
  return true;
}

function count(number, noun) {
  return `${number.toLocaleString('en-US')} ${noun}${number === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Privacy check
// ---------------------------------------------------------------------------

/**
 * Runs the engine's input check on the current work. Never throws: a limit
 * the input breaks comes back as `error`.
 *
 * @param {import('./state.mjs').WorkbenchState} [state]
 * @returns {{ coverage: ReturnType<typeof checkInputs> | null, error: Error | null }}
 */
export function scan(state = workbench.get()) {
  if (!state.files.length) return { coverage: null, error: null };
  try {
    return { coverage: checkInputs(state.files, state.focus, state.context), error: null };
  } catch (error) {
    return { coverage: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** True when the user accepted exactly these warnings. */
export function warningsAccepted(coverage) {
  return Boolean(coverage) && coverage.warnings > 0 && view.get().ack === warnSignature(coverage);
}

function privacyAction(finding) {
  const target = findingTarget(finding);
  const file = target.index === undefined ? null : workbench.get().files[target.index];

  if (target.kind === 'line' && file) {
    return button({
      label: 'Mask the line',
      size: 'sm',
      attrs: { 'aria-label': `Mask line ${target.line} of ${file.name}` },
      onClick: () => {
        const label = describeFinding(finding).split(' · ').pop();
        // The list is rebuilt after every change, so `file` is still the file this button was drawn for.
        workbench.set((state) => ({
          files: state.files.map((entry) => (entry === file ? { name: entry.name, content: maskLine(entry.content, target.line, label) } : entry)),
        }));
        rescan();
        say(`Line ${target.line} of ${file.name} is masked in this tab. The file on disk is unchanged.`, { tone: 'success' });
      },
    });
  }
  if (target.kind === 'file' && file) {
    return button({
      label: 'Remove the file',
      size: 'sm',
      attrs: { 'aria-label': `Remove ${file.name}` },
      onClick: () => {
        workbench.set((state) => ({ files: state.files.filter((entry) => entry !== file) }));
        rescan();
        say(`${file.name} removed.`, { tone: 'success' });
      },
    });
  }
  if (target.kind === 'context') {
    return button({
      label: 'Edit the field',
      size: 'sm',
      onClick: () => {
        const details = qs('#wb-evidence');
        if (details) details.open = true;
        focusControl(`#wb-ctx-${target.field}`);
      },
    });
  }
  return button({ label: 'Edit the focus', size: 'sm', onClick: () => focusControl('#wb-focus') });
}

function findingList(findings, total, withActions) {
  const shown = findings.slice(0, FINDINGS_SHOWN);
  const list = el('ul', { class: 'wb-flags' }, shown.map((finding) => {
    const [where, ...kind] = describeFinding(finding).split(' · ');
    return el('li', { class: 'wb-flag' },
      el('span', { class: 'wb-flag__where mono', text: where }),
      el('span', { class: 'wb-flag__kind', text: kind.join(' · ') }),
      withActions ? privacyAction(finding) : null);
  }));
  if (total > shown.length) list.append(el('li', { class: 'wb-flag wb-flag--more', text: `and ${count(total - shown.length, 'more line')}` }));
  return list;
}

/**
 * Fills #wb-privacy from a scan. Secrets are listed as file:line and kind,
 * never the text, with no way to send them. Emails and addresses are listed
 * with a button that accepts them.
 */
export function renderPrivacy(coverage, error = null) {
  const target = qs('#wb-privacy');
  if (!target) return;
  clear(target);
  if (error) {
    target.append(notice('error', error.message));
    return;
  }
  if (!coverage) return;

  const blocking = coverage.findings.filter((finding) => finding.severity === 'block');
  const warnings = coverage.findings.filter((finding) => finding.severity === 'warn');

  if (coverage.blocking > 0) {
    target.append(notice('error', `${count(coverage.blocking, 'secret')} found. Nothing leaves this tab until they are gone.`, findingList(blocking, coverage.blocking, true)));
  }
  if (coverage.warnings > 0) {
    if (warningsAccepted(coverage)) {
      target.append(el('p', { class: 'wb-note' }, icon('check'), `${count(coverage.warnings, 'line')} with an email or IP address accepted.`));
    } else {
      const body = el('div', { class: 'stack stack--12' },
        findingList(warnings, coverage.warnings, false),
        el('div', {}, button({
          label: 'These are fine, continue',
          id: 'wb-privacy-ack',
          size: 'sm',
          onClick: () => {
            view.set({ ack: warnSignature(coverage) });
            renderPrivacy(coverage);
            if (coverage.blocking === 0) goTo('review');
          },
        })));
      target.append(notice('warn', `${count(coverage.warnings, 'line')} with an email or a public IP address.`, body));
    }
  }
  if (coverage.blocking === 0 && coverage.warnings === 0) {
    const sum = totals(workbench.get().files);
    target.append(el('p', { class: 'wb-note' }, icon('shield'), `No secrets found in ${count(sum.files, 'file')}, ${count(sum.lines, 'line')}.`));
  }
}

let scanTimer = null;

function rescan() {
  clearTimeout(scanTimer);
  scanTimer = null;
  const { coverage, error } = scan();
  renderPrivacy(coverage, error);
}

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(rescan, SCAN_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the provider messages for the current work.
 * Throws the engine's error: `code` is `privacy_block` or `privacy_warn` with
 * `findings` for a privacy stop; any other error is a limit or a bad value.
 *
 * @param {{ acknowledge?: boolean }} [options]
 */
export function prepare({ acknowledge = false } = {}) {
  const state = workbench.get();
  return prepareReview(state.files, state.focus, state.profile, {
    context: state.context,
    mode: state.mode,
    acknowledgeWarnings: acknowledge,
  });
}

/**
 * Shows why the input cannot be sent and takes the user to the Load step.
 *
 * @param {Error & { code?: string }} error
 */
export function reportInputError(error) {
  const { coverage, error: scanError } = scan();
  renderPrivacy(coverage, scanError);
  if (error.code === 'privacy_block') {
    say('Secrets found. Mask the line or remove the file, then continue.', { error: true });
  } else if (error.code === 'privacy_warn') {
    say('Lines with an email or IP address are flagged. Check them, then continue.', { tone: 'warn' });
  } else {
    say(error.message, { error: true });
  }
  if (workbench.get().step !== 'files') setStep('files', { focus: false });
  focusControl(error.code === 'privacy_warn' ? '#wb-privacy-ack' : '#wb-privacy');
}

/**
 * True for a profile whose method the server adds at run time: it has no prompt
 * to preview, copy or download, and no reply to paste back.
 *
 * @param {string} profileId
 * @returns {boolean}
 */
export function isHosted(profileId) {
  const profile = safeProfile(profileId);
  return profile.hosted === true || !profile.instructions;
}

/**
 * The one line shown for a hosted profile wherever a prompt would be offered.
 *
 * @param {string} profileId
 * @returns {string}
 */
export function hostedLine(profileId) {
  const names = CORE_PROFILE_IDS.map((id) => reviewProfile(id).name);
  return `${safeProfile(profileId).name} runs on our server with your key. Prompt export covers ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`;
}

/** True when the current work can be sent: files are there and the privacy check lets them through. Reports the reason when not. */
function inputsReady(state) {
  if (!state.files.length) {
    say('Add at least one file first.', { error: true });
    if (state.step !== 'files') setStep('files', { focus: false });
    focusControl('#wb-pick-files');
    return false;
  }
  const { coverage, error } = scan(state);
  if (error) {
    reportInputError(error);
    return false;
  }
  if (coverage.warnings > 0 && !warningsAccepted(coverage) && coverage.blocking === 0) {
    reportInputError(Object.assign(new Error('Flagged lines.'), { code: 'privacy_warn' }));
    return false;
  }
  return true;
}

/**
 * The exported prompt for the current work, or null after reporting why it
 * cannot be built. Warnings the user accepted are let through; nothing is sent
 * by building it. Only a core profile has a prompt: for a hosted one this
 * says so in one line and returns null.
 *
 * @returns {Promise<{ text: string, prepared: Awaited<ReturnType<typeof prepareReview>> } | null>}
 */
export async function buildPrompt() {
  const state = workbench.get();
  if (state.files.length && isHosted(state.profile)) {
    say(hostedLine(state.profile), { tone: 'warn', hold: true });
    return null;
  }
  if (!inputsReady(state)) return null;
  try {
    const prepared = await prepare({ acknowledge: true });
    return { text: promptExport(prepared), prepared };
  } catch (failure) {
    reportInputError(failure);
    return null;
  }
}

/**
 * What the preview shows. For a core profile it is the whole prompt. For a
 * hosted profile it is the request: the focus, the Context and every file.
 * The provider key travels with it and is not shown. The method is added on
 * the server and is not part of it.
 *
 * @returns {Promise<{ text: string, hosted: boolean } | null>}
 */
export async function buildPreview() {
  const state = workbench.get();
  if (!state.files.length || !isHosted(state.profile)) {
    const built = await buildPrompt();
    return built ? { text: built.text, hosted: false } : null;
  }
  if (!inputsReady(state)) return null;
  try {
    const prepared = await prepareRequest(state.files, state.focus, state.profile, {
      context: state.context,
      mode: state.mode,
      acknowledgeWarnings: true,
    });
    return { text: prepared.request, hosted: true };
  } catch (failure) {
    reportInputError(failure);
    return null;
  }
}

function wirePreview() {
  const element = qs('#wb-preview-dialog');
  if (!element) return;
  const dialog = dialogController(element, { initialFocus: '#wb-preview-text', onClose: () => returnFocus(qs('#wb-preview')) });
  let text = '';

  on(qs('#wb-preview'), 'click', async () => {
    const built = await buildPreview();
    if (!built) return;
    text = built.text;
    const sum = totals(workbench.get().files);
    const size = `${text.length.toLocaleString('en-US')} characters, about ${Math.round(text.length / 4).toLocaleString('en-US')} tokens. ${count(sum.files, 'file')}, every line numbered.`;
    const title = qs('#wb-preview-dialog-title');
    if (title) title.textContent = built.hosted ? 'The request' : 'The prompt your model receives';
    const body = qs('#wb-preview-text');
    body.textContent = text;
    body.setAttribute('aria-label', built.hosted ? 'Request' : 'Prompt');
    element.dataset.hosted = String(built.hosted);
    // A hosted profile has no prompt to take away: the request is shown, the export buttons are not.
    qs('#wb-preview-note').textContent = built.hosted
      ? `${hostedLine(workbench.get().profile)} Below is the request: your focus, the context and the files. ${size}`
      : size;
    for (const control of [qs('#wb-preview-copy'), qs('#wb-preview-download')]) {
      if (control) control.hidden = built.hosted;
    }
    announce('', { target: '#wb-preview-status' });
    dialog.open();
    qs('#wb-preview-text').scrollTop = 0;
    // Focus lands on the text, which on a phone scrolls the dialog past the note above it.
    const toTop = () => {
      element.scrollTop = 0;
    };
    toTop();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(toTop);
  });

  on(qs('#wb-preview-copy'), 'click', async () => {
    const copied = await copyText(text);
    announce(copied ? 'Prompt copied.' : 'The browser refused the copy. Select the text and copy it.', { target: '#wb-preview-status', tone: copied ? 'success' : 'warn' });
    if (copied) track(EVENTS.PROMPT_EXPORTED);
  });

  on(qs('#wb-preview-download'), 'click', () => {
    download(promptFileName(workbench.get().profile), text, 'text/markdown');
    announce('Prompt downloaded.', { target: '#wb-preview-status', tone: 'success' });
    track(EVENTS.PROMPT_EXPORTED);
  });
}

// ---------------------------------------------------------------------------
// Profile, mode, focus, evidence
// ---------------------------------------------------------------------------

function safeProfile(id) {
  try {
    return reviewProfile(id);
  } catch {
    return reviewProfile('general');
  }
}

function renderProfiles() {
  const target = qs('#wb-profiles');
  if (!target) return;
  clear(target);
  for (const group of profileGroups()) {
    target.append(el('fieldset', { class: 'wb-profiles__group' },
      el('legend', { class: 'meta', text: group.title }),
      el('div', { class: 'wb-picks' }, group.profiles.map((profile) => el('label', { class: 'wb-pick' },
        el('input', { type: 'radio', name: 'wb-profile', value: profile.id }),
        el('span', { class: 'wb-pick__body' },
          el('span', { class: 'wb-pick__name', text: profile.name }),
          el('span', { class: 'wb-pick__tag', text: profile.tagline })))))));
  }
}

const MODE_HELP = Object.freeze({
  bounty: 'Verdict: submit, rewrite then submit, prove first, hold as a duplicate, or drop.',
  'own-code': 'Verdict: fix before deploy, or no blocking issues.',
});

function paintProfile() {
  const state = workbench.get();
  const profile = safeProfile(state.profile);

  for (const radio of qsa('input[name="wb-profile"]')) radio.checked = radio.value === profile.id;

  const detail = qs('#wb-profile-detail');
  if (detail) {
    const needs = profileNeeds(profile.id).inputs;
    clear(detail).append(
      el('p', { class: 'wb-detail__text', text: profile.description }),
      needs.length
        ? el('div', { class: 'wb-detail__needs' },
          el('p', { class: 'meta', text: 'What to load' }),
          el('ul', { class: 'wb-needs' }, needs.map((need) => el('li', {}, el('strong', { text: need.label }), ' ', need.hint))))
        : null,
    );
  }

  const modeBox = qs('#wb-mode');
  if (modeBox) modeBox.hidden = profile.mode !== 'either';
  const focus = qs('#wb-focus');
  if (focus) focus.placeholder = profile.defaultFocus;

  renderEvidence();
  paintMode();
  paintSummary();
}

function paintMode() {
  const { mode } = workbench.get();
  for (const radio of qsa('input[name="wb-mode"]')) radio.checked = radio.value === mode;
  const help = qs('#wb-mode-help');
  if (help) help.textContent = MODE_HELP[mode] ?? '';
  paintEvidenceStatus();
  paintSummary();
}

function contextControl(field, value) {
  const id = `wb-ctx-${field.key}`;
  const common = { id, name: id, 'data-context': field.key, 'aria-describedby': `${id}-help` };
  if (field.kind === 'choice') {
    return el('select', { ...common, class: 'select', value: value || field.options[0].value },
      field.options.map((option) => el('option', { value: option.value, text: option.label })));
  }
  if (field.kind === 'text') {
    return el('textarea', { ...common, class: 'textarea', rows: '3', maxlength: String(field.maxChars), value: value ?? '' });
  }
  return el('input', { ...common, class: 'input', type: 'text', maxlength: String(field.maxChars), autocomplete: 'off', value: value ?? '' });
}

function renderEvidence() {
  const target = qs('#wb-evidence-fields');
  if (!target) return;
  const { context, profile } = workbench.get();
  clear(target);
  for (const group of evidenceGroups(safeProfile(profile).id)) {
    target.append(el('fieldset', { class: 'wb-evidence__group' },
      el('legend', { class: 'meta', text: group.title }),
      group.fields.map((field) => {
        const id = `wb-ctx-${field.key}`;
        return el('div', { class: 'field' },
          el('label', { class: 'label', for: id, text: field.label }),
          contextControl(field, context[field.key]),
          el('p', { class: 'help', id: `${id}-help`, text: field.hint }));
      })));
  }
  paintEvidenceStatus();
}

function paintEvidenceStatus() {
  const target = qs('#wb-evidence-status');
  if (!target) return;
  const { context, mode, profile } = workbench.get();
  try {
    target.textContent = evidenceStatus(context, mode, safeProfile(profile).id);
  } catch (error) {
    target.textContent = error instanceof Error ? error.message : 'A field cannot be read.';
  }
}

/** Puts the stored values into the form, leaving the field being typed in alone. */
function syncEvidenceValues() {
  const { context } = workbench.get();
  for (const control of qsa('[data-context]')) {
    if (control === document.activeElement) continue;
    const field = CONTEXT_FIELDS.find((entry) => entry.key === control.dataset.context);
    const value = context[control.dataset.context] ?? (field?.kind === 'choice' ? field.options[0].value : '');
    if (control.value !== value) control.value = value;
  }
  paintEvidenceStatus();
}

function paintSummary() {
  const target = qs('#wb-summary');
  if (!target) return;
  const state = workbench.get();
  const sum = totals(state.files);
  const profile = safeProfile(state.profile);
  const mode = profile.mode === 'either' ? state.mode : profile.mode;
  clear(target).append(
    el('strong', { text: profile.name }),
    ` · ${mode === 'own-code' ? 'my own code' : 'a bounty target'} · ${count(sum.files, 'file')} · ${formatBytes(sum.bytes)} · ${count(sum.lines, 'line')}`,
  );
}

// ---------------------------------------------------------------------------
// Example, stash, clear
// ---------------------------------------------------------------------------

let stash = null;

function blankWork() {
  return pick(initialState(), WORK_FIELDS);
}

function takeStash() {
  const saved = stash ?? readSession(STASH_KEY);
  stash = null;
  removeSession(STASH_KEY);
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.files)) return null;
  return pick({ ...blankWork(), ...saved }, WORK_FIELDS);
}

/**
 * Loads an example into the workbench and opens its result. Work the user
 * already had is put aside and comes back when the example is left.
 *
 * @param {{ id: string, files: { name: string, content: string }[], focus?: string, context?: object, profile: string, mode?: string }} example
 * @param {import('./state.mjs').WorkbenchResult} result
 */
export function enterExample(example, result) {
  const state = workbench.get();
  if (!view.get().example) {
    // Whatever was put aside earlier is older than the work on screen now.
    stash = hasWork(state) ? pick(state, WORK_FIELDS) : null;
    if (stash) writeSession(STASH_KEY, stash);
    else removeSession(STASH_KEY);
  }
  const profile = safeProfile(example.profile);
  view.set({ example: example.id, ack: '', history: null });
  workbench.set({
    files: example.files.map((file) => ({ name: file.name, content: file.content })),
    focus: example.focus ?? '',
    context: { ...initialState().context, ...(example.context ?? {}) },
    profile: profile.id,
    mode: profile.mode === 'either' ? (example.mode === 'own-code' ? 'own-code' : 'bounty') : profile.mode,
    result,
  });
  emit('example', { id: example.id });
  setStep('results');
}

/**
 * Leaves the example: the work that was put aside returns, or the workbench
 * is blank, on the Load step. The provider, the model and any key are left as
 * they are. Focus does not move; call setStep() after it when it should.
 *
 * @returns {boolean} Whether an example was loaded.
 */
export function leaveExample() {
  if (!view.get().example) return false;
  const saved = takeStash();
  view.set({ example: '', ack: '' });
  workbench.set({ ...blankWork(), ...(saved ?? {}), step: 'files' });
  emit('example', { id: '' });
  return true;
}

/**
 * Call before adding real material. When an example is loaded it is removed
 * first, so example files, focus and evidence never travel with real work.
 *
 * @returns {boolean} Whether an example was left.
 */
export function beginRealWork() {
  return leaveExample();
}

/** Resets files, focus, evidence, profile, mode and result. The provider, model and key stay. */
export function clearAll() {
  const state = workbench.get();
  if (state.busy) {
    say('A review is running. Cancel it first.', { tone: 'warn' });
    return;
  }
  const before = { work: pick(state, [...WORK_FIELDS, 'step']), view: view.get(), stash };
  const hadWork = hasWork(state) || Boolean(view.get().example);

  stash = null;
  removeSession(STASH_KEY);
  view.set({ example: '', ack: '', history: null });
  workbench.set({ ...blankWork(), step: 'files' });
  emit('clear');
  setStep('files', { scroll: false });

  if (!hadWork) {
    say('Nothing to clear.');
    return;
  }
  say('Cleared: files, focus, evidence and result are gone from this tab.', {
    action: {
      label: 'Undo',
      onClick: () => {
        stash = before.stash;
        view.set({ example: before.view.example, ack: before.view.ack });
        workbench.set(before.work);
        setStep(before.work.step, { scroll: false });
        say('Restored.', { tone: 'success' });
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Wires the workbench shell and the Load form. Call once, before the other
 * modules' init functions.
 *
 * @returns {boolean} False when the page has no workbench.
 */
export function initWorkbench() {
  root = qs('#workspace');
  if (!root) return false;

  view.set(storedView());
  view.subscribe((state, previous) => {
    if (state.example !== previous.example || state.via !== previous.via || state.keyProvider !== previous.keyProvider || state.ack !== previous.ack) saveView();
    if (state.history !== previous.history) paintStepper();
  });

  renderProfiles();
  const limits = qs('#wb-drop-limits');
  if (limits) {
    limits.textContent = `Source and text files. ${formatBytes(LIMITS.fileBytes)} per file. ${formatBytes(LIMITS.totalBytes)}, ${LIMITS.files} files and ${LIMITS.totalLines.toLocaleString('en-US')} lines in total.`;
  }

  // Steps
  on(root, 'click', '[data-step-target]', (event, control) => {
    goTo(control.dataset.stepTarget);
  });
  on(qs('#wb-continue'), 'click', () => goTo('review'));
  on(qs('#wb-clear'), 'click', clearAll);

  // Profile and mode
  on(qs('#wb-profiles'), 'change', 'input[name="wb-profile"]', (event, radio) => {
    const profile = safeProfile(radio.value);
    workbench.set((state) => ({ profile: profile.id, mode: profile.mode === 'either' ? state.mode : profile.mode }));
  });
  on(qs('#wb-mode'), 'change', 'input[name="wb-mode"]', (event, radio) => {
    workbench.set({ mode: radio.value === 'own-code' ? 'own-code' : 'bounty' });
  });

  // Focus and evidence
  on(qs('#wb-focus'), 'input', (event) => {
    workbench.set({ focus: event.target.value });
  });
  on(qs('#wb-evidence-fields'), 'input change', '[data-context]', (event, control) => {
    workbench.set((state) => ({ context: { ...state.context, [control.dataset.context]: control.value } }));
  });

  wirePreview();

  // Paint from the store
  workbench.select((state) => state.step, paintStep);
  workbench.select((state) => state.profile, paintProfile);
  workbench.select((state) => state.mode, paintMode);
  workbench.select((state) => state.context, syncEvidenceValues);
  workbench.select((state) => state.focus, (focus) => {
    const field = qs('#wb-focus');
    if (field && field !== document.activeElement && field.value !== focus) field.value = focus;
  });
  workbench.select((state) => state.busy, (busy) => {
    if (busy) root.dataset.busy = '';
    else delete root.dataset.busy;
  });
  workbench.subscribe((state, previous) => {
    const inputChanged = state.files !== previous.files || state.focus !== previous.focus || state.context !== previous.context;
    if (inputChanged) scheduleScan();
    if (state.files !== previous.files || state.result !== previous.result) {
      paintStepper();
      paintSummary();
    }
    // A result belongs to the files it was written about.
    if (state.files !== previous.files && state.result && state.result === previous.result) {
      workbench.set({ result: null, step: state.step === 'results' ? 'files' : state.step });
    }
  });

  const state = workbench.get();
  paintStep(state.step, state.step);
  paintProfile();
  qs('#wb-focus').value = state.focus;
  rescan();
  return true;
}
