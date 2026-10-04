/**
 * The gauntlet: the eight stages run in order as ordinary hosted reviews, each
 * one reading the answers of the stages before it.
 *
 * A stage is a normal POST /api/review with a profile id. The earlier answers
 * travel as extra files named stage-<n>-<profile>.md, placed after the user's
 * own files so that every cited `input-N/...` keeps its number from stage to
 * stage. The server gates the run through the daily allowance; this module
 * also checks the plan first, so a free account is told before its one review
 * is spent on stage 1.
 *
 * The run stops early when a stage returns drop or hold-duplicate, unless the
 * user asks for the remaining stages. Finished stages are kept through a
 * cancel, a provider error, an exhausted allowance and a reload (they live in
 * sessionStorage for the tab), and the run resumes at the stage that did not
 * finish.
 *
 * Exports
 *   initGauntlet()                       wire the Gauntlet row of the Run step. Call after initProviders() and initRun().
 *   runGauntlet({ force, restart })      -> Promise<void>   start, or resume, now
 *   Shared with ./panel.mjs
 *     preflight({ feature, showNote, checkKey }) -> Promise<{ state, request, acknowledge } | null>
 *     upgradeNote({ feature, plan, kept, retry }) -> HTMLElement
 *     liveController(nodes), liveBox(label)
 *     effectiveMode(state)               -> 'bounty' | 'own-code'
 *   Pure helpers (tested; scripts/build-examples.mjs runs the same ones)
 *     compactStage(review)               -> string   verdict, headline, findings table and the stage's own sections
 *     compactFile(file)                  -> { name, content }   a file whose content is that summary
 *     extraInputs(files, extras, { focus, context, compact }) -> { files, extras, compact, masked, warnings }
 *     stageInputs(files, stages, { focus, context })          -> the same, for stage records
 *     signatureOf(files, extra?)         -> string   identifies the files a run was made on
 *     stageStates(run)                   -> ('waiting' | 'running' | 'done' | 'stopped' | 'failed')[]
 *     stageFileName, panelFileName       re-exported from ./dossier.mjs
 *
 * DOM this module owns: #wb-row-gauntlet and everything inside it
 * (#wb-gauntlet-stages, #wb-gauntlet-note, #wb-gauntlet-run, #wb-gauntlet-alt,
 * #wb-gauntlet-hint, #wb-gauntlet-live and its children).
 * Storage: sessionStorage["bo:gauntlet:run"]: finished stage answers; no key, no source file.
 */

import { parseReview } from '../parse.mjs';
import { GAUNTLET, reviewProfile } from '../profiles.mjs';
import { LIMITS, checkInputs, describeFinding } from '../review-core.mjs';
import { account, currentAccount, planOf, streamReview, subscribeAccount, track } from './api.mjs';
import {
  VERDICT_LABELS, gauntletResult, openExampleRun, panelFileName, stageFileName, stageLabel, stageRecord, stageStrip, stopsRun,
} from './dossier.mjs';
import { EVENTS } from './events.mjs';
import { checkCredentials, credentials, markInvalid } from './providers-ui.mjs';
import { sectionKey } from './results.mjs';
import { ensureSignedIn, failureFor, openAccount, upgrade } from './run.mjs';
import { readSession, removeSession, workbench, writeSession } from './state.mjs';
import { button, clear, el, formatElapsed, notice, on, qs, setBusy, startTimer } from './ui.mjs';
import { maskLine, reportInputError, say, scan, setStep, view, warningsAccepted } from './workbench.mjs';

export { panelFileName, stageFileName };

const RUN_KEY = 'bo:gauntlet:run';
const TOTAL = GAUNTLET.length;
const PRICE = 'US$10 a week';
const CELL_CHARS = 400;
const MASK_PASSES = 4;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function clip(text, max = CELL_CHARS) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function refText(ref) {
  return ref.end !== ref.start ? `${ref.label}:${ref.start}-${ref.end}` : `${ref.label}:${ref.start}`;
}

// Supporting lists a later stage does not decide on.
const LEFT_OUT = new Set(['hardening', 'checked and safe']);
const FIELD_LINE = /^[A-Z][A-Za-z' /-]{0,40}:\s*\S/;

/**
 * A stage answer cut down to what the later stages decide on: its verdict and
 * headline, one row per finding, and the stage's own sections as rows and
 * fields. Paths, tests, code blocks and prose are left out. Used only when the
 * full answers do not fit the input limits.
 *
 * @param {string} review
 * @returns {string}
 */
export function compactStage(review) {
  const parsed = parseReview(review);
  if (!parsed.ok) return `${String(review ?? '').slice(0, 4000)}\n`;

  const lines = [
    '# Review',
    `Verdict: ${parsed.verdict}`,
    `Mode: ${parsed.mode}`,
    `Headline: ${clip(parsed.headline)}`,
    '',
    'Summary of the stage output: verdict, headline, findings and section rows. The prose was left out to fit the size limit.',
  ];
  if (parsed.findings.length) {
    lines.push('', '## Findings');
    for (const finding of parsed.findings) {
      lines.push(`- ${[
        finding.id,
        finding.severity || 'unrated',
        finding.basis || 'not stated',
        clip(finding.title, 200),
        finding.locations.map(refText).join('; ') || 'none',
        clip(finding.impact) || 'none',
        `gap: ${clip(finding.gap, 200) || 'none'}`,
      ].join(' | ')}`);
    }
  }
  for (const section of parsed.sections) {
    if (LEFT_OUT.has(sectionKey(section.title))) continue;
    const body = section.rows
      ? section.rows.map((row) => `- ${row.map((cell) => clip(cell)).join(' | ')}`)
      : String(section.text ?? '').split('\n').filter((line) => FIELD_LINE.test(line)).map((line) => clip(line, 600));
    if (body.length) lines.push('', `## ${section.title}`, ...body);
  }
  return `${lines.join('\n')}\n`;
}

function extraIndex(finding, baseCount) {
  const match = /^input-(\d{1,3})$/.exec(finding.source);
  return match ? Number(match[1]) - 1 - baseCount : -1;
}

function withExtras(files, extras, focus, context) {
  const list = extras.map((file) => ({ name: file.name, content: file.content }));
  let masked = 0;
  for (let pass = 0; ; pass += 1) {
    // Throws when a limit is broken: file count, bytes or lines.
    const coverage = checkInputs([...files, ...list], focus, context);
    const inExtras = coverage.findings.filter((finding) => extraIndex(finding, files.length) >= 0);
    const blocked = inExtras.filter((finding) => finding.severity === 'block' && finding.line > 0);
    if (!blocked.length || pass >= MASK_PASSES) {
      return { files: [...files, ...list], extras: list, masked, warnings: inExtras.filter((finding) => finding.severity === 'warn').length };
    }
    // A model can repeat something the privacy check blocks. That line is
    // masked in its answer before the answer travels on; the user's own files
    // are never changed here.
    for (const finding of blocked) {
      const at = extraIndex(finding, files.length);
      list[at] = { name: list[at].name, content: maskLine(list[at].content, finding.line, describeFinding(finding).split(' · ').pop()) };
      masked += 1;
    }
  }
}

/**
 * The files of a run that carries earlier answers: the user's files, then the
 * extras, in that order. When they do not fit the input limits and `compact`
 * is given, every extra is replaced by `compact(extra)` and the fit is tried
 * once more; the limit error is thrown when that does not fit either.
 *
 * @param {{ name: string, content: string }[]} files
 * @param {{ name: string, content: string }[]} extras
 * @param {{ focus?: string, context?: object, compact?: ((file: { name: string, content: string }) => { name: string, content: string }) | null }} [options]
 * @returns {{ files: { name: string, content: string }[], extras: { name: string, content: string }[], compact: boolean, masked: number, warnings: number }}
 */
export function extraInputs(files, extras, { focus = '', context, compact = null } = {}) {
  try {
    return { ...withExtras(files, extras, focus, context), compact: false };
  } catch (error) {
    if (!compact || !extras.length) throw error;
  }
  return { ...withExtras(files, extras.map(compact), focus, context), compact: true };
}

/** A file whose content is the summary of a stage answer. */
export function compactFile(file) {
  return { name: file.name, content: compactStage(file.content) };
}

/**
 * The files stage `stages.length + 1` receives: the user's files, then each
 * earlier answer as stage-<n>-<profile>.md.
 *
 * @param {{ name: string, content: string }[]} files
 * @param {{ file: string, review: string }[]} stages
 * @param {{ focus?: string, context?: object }} [options]
 */
export function stageInputs(files, stages, { focus = '', context } = {}) {
  const extras = stages.map((stage) => ({ name: stage.file, content: stage.review }));
  return extraInputs(files, extras, { focus, context, compact: compactFile });
}

/**
 * Identifies the material a run was made on, so finished stages are never
 * continued on other files. FNV-1a over names and contents.
 *
 * @param {{ name: string, content: string }[]} files
 * @param {string} [extra]  Anything else the run depends on.
 */
export function signatureOf(files, extra = '') {
  let hash = 0x811c9dc5;
  const feed = (text) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const file of files) {
    feed(file.name);
    feed(file.content);
  }
  feed(extra);
  return `${files.length}:${hash.toString(16).padStart(8, '0')}`;
}

/**
 * How each stage shows in the strip.
 *
 * @param {{ status: string, stages: unknown[], failedAt?: number | null }} run
 * @returns {('waiting' | 'running' | 'done' | 'stopped' | 'failed')[]}
 */
export function stageStates(run) {
  const done = run.stages.length;
  return GAUNTLET.map((profileId, index) => {
    if (index < done) return 'done';
    if (run.status === 'running') return index === done ? 'running' : 'waiting';
    if (run.status === 'gate' || run.status === 'done') return 'stopped';
    if (run.status === 'stopped' && run.failedAt === index) return 'failed';
    return 'waiting';
  });
}

/** The mode the workbench is in: a profile with a fixed mode decides it. */
export function effectiveMode(state = workbench.get()) {
  try {
    const profile = reviewProfile(state.profile);
    return profile.mode === 'either' ? state.mode : profile.mode;
  } catch {
    return state.mode;
  }
}

// ---------------------------------------------------------------------------
// Shared with the panel: the live box, the plan check, the upgrade note
// ---------------------------------------------------------------------------

const LIVE_STATES = Object.freeze({ running: 'Running', done: 'Done', failed: 'Failed', queued: 'Stopped' });

/**
 * Drives one live box: the state chip, the clock, the label and the text as
 * it is written.
 *
 * @param {{ box: Element, chip: Element | null, clock: Element | null, what: Element | null, text: Element | null, cancel?: Element | null }} nodes
 */
export function liveController({ box, chip, clock, what, text, cancel = null }) {
  let node = null;
  let stopClock = null;
  const setChip = (status, label) => {
    if (!chip) return;
    chip.dataset.status = status;
    chip.textContent = label ?? LIVE_STATES[status] ?? status;
  };
  return {
    box,
    /** A new answer starts: the text is emptied and the clock restarts. */
    start(label) {
      box.hidden = false;
      setChip('running');
      if (what) what.textContent = label;
      node = document.createTextNode('');
      if (text) clear(text).append(node);
      if (cancel) cancel.hidden = false;
      stopClock?.();
      stopClock = startTimer((elapsed) => {
        if (clock) clock.textContent = formatElapsed(elapsed);
      });
    },
    write(delta) {
      if (!node) return;
      const follow = text ? text.scrollHeight - text.scrollTop - text.clientHeight < 48 : false;
      node.appendData(delta);
      if (text && follow) text.scrollTop = text.scrollHeight;
    },
    /** The answer ended. `status` is done, failed or queued (stopped). */
    end(status, label, chipLabel) {
      stopClock?.();
      stopClock = null;
      setChip(status, chipLabel);
      if (what && label !== undefined) what.textContent = label;
      if (cancel) cancel.hidden = true;
    },
    hide() {
      stopClock?.();
      stopClock = null;
      box.hidden = true;
    },
    get written() {
      return node ? node.data.length : 0;
    },
  };
}

/** A live box built from script, for a run that shows several at once. */
export function liveBox(label) {
  const chip = el('span', { class: 'chip status', dataset: { status: 'queued' }, text: 'Waiting' });
  const clock = el('span', { class: 'wb-live__clock num', 'aria-hidden': 'true', text: '0:00' });
  const what = el('span', { class: 'wb-live__what', text: label });
  const text = el('pre', { class: 'wb-live__text', tabindex: '0', role: 'log', 'aria-live': 'off', 'aria-label': `${label}: the review as it is written` });
  const box = el('div', { class: 'wb-live rn-stream' }, el('div', { class: 'wb-live__head' }, chip, clock, what), text);
  return liveController({ box, chip, clock, what, text });
}

const FEATURES = Object.freeze({
  gauntlet: {
    title: 'The gauntlet runs on Operator.',
    text: 'Eight reviews on one finding, one after another. Operator has no daily limit. The free plan has 1 review a day.',
    example: 'See the gauntlet on the example',
    unit: 'stage',
  },
  panel: {
    title: 'The panel runs on Operator.',
    text: 'Up to four reviews at once, then a cross-check. Operator runs four at a time with no daily limit. The free plan has 1 review a day.',
    example: 'See the panel on the example',
    unit: 'model review',
  },
});

function count(number, noun) {
  return `${number} ${noun}${number === 1 ? '' : 's'}`;
}

/**
 * The panel that takes the place of the Run button when the plan does not
 * cover the run: what the run needs, the price, and the example.
 *
 * @param {{ feature: 'gauntlet' | 'panel', plan: string, kept?: number, used?: boolean, retry?: (() => void) | null }} options
 */
export function upgradeNote({ feature, plan, kept = 0, used = false, retry = null }) {
  const copy = FEATURES[feature];
  const keptLine = kept > 0 ? ` ${count(kept, `finished ${copy.unit}`)} ${kept === 1 ? 'is' : 'are'} kept in this tab.` : '';
  const pastDue = plan === 'past_due';
  const title = pastDue ? 'The Operator payment failed.' : used ? "Today's free review is used." : copy.title;
  const text = pastDue ? `Update the card to run it.${keptLine}` : `${copy.text}${keptLine}`;

  const actions = [
    pastDue
      ? button({ label: 'Update the card', variant: 'primary', attrs: { 'data-upgrade': 'card' }, onClick: openAccount })
      : button({ label: `Get Operator. ${PRICE}`, variant: 'primary', iconEnd: 'arrow-right', attrs: { 'data-upgrade': 'go' }, onClick: upgrade }),
  ];
  if (plan === 'anon' && retry) {
    actions.push(button({
      label: 'I have Operator: sign in',
      attrs: { 'data-upgrade': 'signin' },
      onClick: async () => {
        if (await ensureSignedIn()) retry();
      },
    }));
  }
  actions.push(button({ label: copy.example, variant: 'quiet', attrs: { 'data-upgrade': 'example' }, onClick: () => openExampleRun(feature) }));

  return el('div', { class: 'wb-upgrade rn-upgrade', dataset: { feature } },
    el('p', { class: 'wb-upgrade__title', text: title }),
    el('p', { class: 'wb-upgrade__text', text }),
    el('div', { class: 'wb-actions' }, actions));
}

/**
 * Everything that must hold before an Operator run starts: no run in
 * progress, files loaded, the plan, the key, the privacy check. Reports the
 * first thing that does not hold and returns null.
 *
 * The plan is checked before the key: nobody is asked for a key, or signed
 * in, for a run their plan does not include.
 *
 * @param {{ feature: 'gauntlet' | 'panel', showNote: (node: Node | null) => void, checkKey?: boolean, retry?: () => void }} options
 * @returns {Promise<{ state: import('./state.mjs').WorkbenchState, request: ReturnType<typeof credentials>, acknowledge: boolean } | null>}
 */
export async function preflight({ feature, showNote, checkKey = true, retry = null }) {
  const state = workbench.get();
  if (state.busy) {
    say('A review is running. Cancel it, or wait for it to finish.', { tone: 'warn' });
    return null;
  }
  if (!state.files.length) {
    say('Add at least one file first.', { error: true });
    setStep('files');
    return null;
  }

  const current = await account().catch(() => currentAccount());
  const plan = planOf(current);
  if (plan !== 'operator') {
    showNote(upgradeNote({ feature, plan, retry }));
    say(plan === 'past_due' ? 'The Operator payment failed.' : FEATURES[feature].title, { tone: 'warn' });
    qs(`#wb-row-${feature} [data-upgrade]`)?.focus();
    return null;
  }

  if (checkKey && !checkCredentials()) return null;
  const request = credentials();

  const { coverage, error } = scan(state);
  if (error) {
    reportInputError(error);
    return null;
  }
  if (coverage.blocking > 0) {
    reportInputError(Object.assign(new Error('Secrets found.'), { code: 'privacy_block' }));
    return null;
  }
  if (coverage.warnings > 0 && !warningsAccepted(coverage)) {
    reportInputError(Object.assign(new Error('Flagged lines.'), { code: 'privacy_warn' }));
    return null;
  }
  return { state, request, acknowledge: coverage.warnings > 0 };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GauntletRun
 * @property {string} signature   the files the stages were run on
 * @property {ReturnType<typeof stageRecord>[]} stages   finished stages, in order
 * @property {'idle' | 'running' | 'gate' | 'stopped' | 'done'} status
 * @property {object[]} manifest  the manifest of the last finished stage
 * @property {string} provider
 * @property {boolean} force      run past a gate
 * @property {number | null} failedAt  the stage that did not finish
 * @property {{ name: string, content: string }[]} sent  the stage files as the last stage received them
 */

function idleRun(signature = '') {
  return { signature, stages: [], status: 'idle', manifest: [], provider: '', force: false, failedAt: null, sent: [] };
}

/** @type {GauntletRun} */
let run = idleRun();
/** @type {AbortController | null} */
let controller = null;
/** The dossier built from the run as it stands, so opening it twice shows one result. */
let dossier = null;
let exampleHasRun = false;

function persist() {
  if (!run.stages.length) {
    removeSession(RUN_KEY);
    return;
  }
  // A run that was in flight comes back as stopped: its last stage never finished.
  writeSession(RUN_KEY, { v: 1, ...run, status: run.status === 'running' ? 'stopped' : run.status });
}

function restore() {
  const stored = readSession(RUN_KEY);
  if (!stored || stored.v !== 1 || !Array.isArray(stored.stages) || !stored.stages.length) return;
  const stages = stored.stages.filter((stage) => stage && typeof stage.review === 'string' && typeof stage.profileId === 'string');
  // The stages are a prefix of the gauntlet, in order, or they are nothing.
  if (stages.length !== stored.stages.length || stages.some((stage, index) => stage.profileId !== GAUNTLET[index])) return;
  if (stored.signature !== signatureOf(workbench.get().files)) {
    removeSession(RUN_KEY);
    return;
  }
  run = {
    ...idleRun(stored.signature),
    stages,
    status: ['gate', 'stopped', 'done'].includes(stored.status) ? stored.status : 'stopped',
    manifest: Array.isArray(stored.manifest) ? stored.manifest : [],
    provider: typeof stored.provider === 'string' ? stored.provider : '',
    force: stored.force === true,
    sent: Array.isArray(stored.sent) ? stored.sent : [],
  };
}

function showNote(node) {
  const target = qs('#wb-gauntlet-note');
  if (!target) return;
  clear(target);
  if (node) target.append(node);
  const actions = qs('#wb-gauntlet-actions');
  if (actions) actions.hidden = Boolean(node?.classList?.contains('wb-upgrade')) && run.stages.length === 0;
}

function baseCount() {
  return Math.max(0, run.manifest.length - Math.max(0, run.stages.length - 1));
}

/** Opens one finished stage as the single hosted review it is. */
function openStage(index) {
  const stage = run.stages[index];
  if (!stage || workbench.get().busy) return;
  workbench.set({
    result: {
      review: stage.review,
      manifest: run.manifest.slice(0, baseCount() + index),
      profile: { id: stage.profileId, name: stage.name },
      mode: 'bounty',
      provider: run.provider,
      model: stage.model,
      truncated: stage.truncated === true,
      refused: false,
      usage: stage.usage,
      source: 'ai',
      timestamp: stage.at ?? new Date().toISOString(),
    },
  });
  setStep('results');
  say(`Stage ${index + 1} of the gauntlet, ${stageLabel(stage.profileId)}, opened as a single review. The run is kept on the Run step.`, { hold: true });
}

function openDossier() {
  if (!run.stages.length) return;
  if (!dossier || dossier.stages.length !== run.stages.length) {
    // A stage file that travelled shortened or masked is recorded as it was sent.
    const stages = run.stages.map((stage, index) => {
      const sent = run.sent[index]?.content;
      return sent && sent !== stage.review ? { ...stage, sent } : stage;
    });
    dossier = gauntletResult({ stages, manifest: run.manifest, provider: run.provider, timestamp: stages[stages.length - 1].at });
  }
  workbench.set({ result: dossier });
  setStep('results');
}

function setLabel(control, label) {
  const node = control?.querySelector('.btn__label');
  if (node && node.textContent !== label) node.textContent = label;
}

function paint() {
  const row = qs('#wb-row-gauntlet');
  if (!row) return;
  const state = workbench.get();
  const { via, example } = view.get();
  row.hidden = via === 'export';

  const states = stageStates(run);
  const strip = stageStrip(GAUNTLET.map((profileId, index) => {
    const stage = run.stages[index];
    return {
      number: index + 1,
      label: stageLabel(profileId),
      state: states[index],
      verdict: stage?.verdict,
      title: stage?.headline || reviewProfile(profileId).tagline,
      onOpen: stage && run.status !== 'running' ? () => openStage(index) : null,
    };
  }), { id: 'wb-gauntlet-stages', label: 'Gauntlet stages' });
  qs('#wb-gauntlet-stages')?.replaceWith(strip);

  const runButton = qs('#wb-gauntlet-run');
  const bounty = effectiveMode(state) === 'bounty';
  const done = run.stages.length;
  const plan = planOf(currentAccount());

  let label = 'Run the gauntlet';
  let alt = null;
  let hint = plan === 'operator'
    ? 'Eight reviews on the model chosen above, one after another.'
    : 'An Operator run. The example shows a whole one without an account.';
  if (example && run.status === 'idle') {
    label = exampleHasRun ? 'Show the gauntlet on this example' : 'Run the gauntlet';
    if (exampleHasRun) hint = 'Stored with the example: eight model answers, generated stage by stage. No account needed.';
  } else if (!bounty) {
    hint = 'The gauntlet tests a finding against a programme. Pick "A bounty target" on the Load step.';
  } else if (run.status === 'gate') {
    label = 'Open the dossier';
    alt = { label: 'Run the remaining stages anyway', onClick: () => runGauntlet({ force: true }) };
    hint = `Ended at stage ${done} of ${TOTAL}.`;
  } else if (run.status === 'done') {
    label = 'Open the dossier';
    alt = { label: 'Run it again', onClick: () => runGauntlet({ restart: true }) };
    hint = `${count(done, 'stage')} finished.`;
  } else if (run.status === 'stopped' && done > 0) {
    label = `Resume at stage ${done + 1}`;
    alt = { label: 'Start over', onClick: () => runGauntlet({ restart: true }) };
    hint = `${count(done, 'finished stage')} of ${TOTAL} kept in this tab. Select a finished stage to read it.`;
  }

  if (run.status !== 'running') {
    setLabel(runButton, label);
    if (!bounty && !example) runButton?.setAttribute('aria-disabled', 'true');
    else runButton?.removeAttribute('aria-disabled');
  }
  const hintNode = qs('#wb-gauntlet-hint');
  if (hintNode) hintNode.textContent = hint;

  // The upgrade panel stands in for the button, until the plan covers the run or stages are waiting to resume.
  if (plan === 'operator' && qs('#wb-gauntlet-note .wb-upgrade')) showNote(null);
  const actions = qs('#wb-gauntlet-actions');
  if (actions) actions.hidden = Boolean(qs('#wb-gauntlet-note .wb-upgrade')) && done === 0;

  qs('#wb-gauntlet-alt')?.remove();
  if (alt && run.status !== 'running') {
    runButton?.after(button({ label: alt.label, variant: 'quiet', id: 'wb-gauntlet-alt', onClick: alt.onClick }));
  }
}

function gateNote(stage) {
  const left = TOTAL - stage.number;
  return notice('warn', `Stage ${stage.number}, ${stageLabel(stage.profileId)}: ${VERDICT_LABELS[stage.verdict] ?? stage.verdict}`, el('div', { class: 'stack stack--8' },
    stage.headline ? el('p', { text: stage.headline }) : null,
    el('p', { text: `This verdict ends the report, so the run stopped. ${count(left, 'stage')} ${left === 1 ? 'was' : 'were'} not run.` })));
}

/** Tells the user why the run stopped, and leaves the way on in the row. */
async function reportStop(stop, request, options) {
  const done = run.stages.length;
  const at = `stage ${done + 1}, ${stageLabel(GAUNTLET[done])}`;
  const keptLine = done > 0 ? ` ${count(done, 'finished stage')} ${done === 1 ? 'is' : 'are'} kept.` : '';

  if (stop.kind === 'gate') {
    const stage = run.stages[done - 1];
    showNote(gateNote(stage));
    say(`The gauntlet ended at stage ${stage.number}: ${VERDICT_LABELS[stage.verdict] ?? stage.verdict}.`, { tone: 'warn', hold: true });
    qs('#wb-gauntlet-run')?.focus();
    return;
  }
  if (stop.kind === 'aborted') {
    say(`Stopped during ${at}.${keptLine}`, { hold: true });
    return;
  }
  if (stop.kind === 'input') {
    say(`${stop.error.message} The earlier stage answers travel with each stage: remove a file to make room.`, { error: true });
    return;
  }
  if (stop.kind === 'refused') {
    showNote(notice('warn', `The model declined ${at}`, `A refusal is not counted against the allowance.${keptLine} Resume to ask again, or pick another model above.`));
    say(`The model declined ${at}.`, { tone: 'warn', hold: true });
    return;
  }
  if (stop.kind === 'format') {
    showNote(notice('warn', `${at[0].toUpperCase()}${at.slice(1)} has no verdict`, `${stop.truncated ? 'The answer was cut off before it finished.' : 'The answer is not in the review format, so its verdict cannot be read.'}${keptLine} Resume to run the stage again, or pick another model above.`));
    say(`The gauntlet stopped at ${at}: the answer has no verdict.`, { tone: 'warn', hold: true });
    return;
  }

  const failure = failureFor(stop.error, request.via);
  if (failure.signin && !options.retried) {
    if (await ensureSignedIn()) {
      await runGauntlet({ ...options, retried: true });
      return;
    }
  }
  if (failure.upgrade) {
    // The allowance ran out in the middle, or the server refused a stage the plan
    // does not cover: the plan lapsed, or the account is on the free plan after all.
    const current = await account().catch(() => currentAccount());
    const used = !failure.operatorOnly;
    showNote(upgradeNote({ feature: 'gauntlet', plan: planOf(current) === 'operator' ? 'free' : planOf(current), kept: done, used, retry: () => runGauntlet() }));
    say(`${used ? "Today's free review is used." : FEATURES.gauntlet.title}${keptLine}`, { tone: 'warn', hold: true });
    qs('#wb-row-gauntlet [data-upgrade]')?.focus();
    return;
  }
  if (failure.block || failure.warn) {
    say(`${failure.message}${keptLine}`, { tone: failure.tone, error: failure.tone === 'error', hold: true });
    return;
  }
  if (failure.field) {
    say(`${failure.message}${keptLine}`, { error: true });
    markInvalid(failure.field, failure.message);
    return;
  }
  showNote(notice(failure.tone === 'error' ? 'error' : 'warn', `${at[0].toUpperCase()}${at.slice(1)} did not finish`, `${failure.message}${keptLine}`));
  say(`The gauntlet stopped at ${at}.${keptLine}`, { tone: failure.tone, error: failure.tone === 'error', hold: true });
}

/**
 * Runs the gauntlet on the loaded files, or resumes the run this tab holds.
 *
 * @param {{ force?: boolean, restart?: boolean, retried?: boolean }} [options]
 *   `force` runs past a stage that returned drop or hold-duplicate; `restart` discards the finished stages.
 */
export async function runGauntlet(options = {}) {
  if (workbench.get().busy) return;
  showNote(null);

  // An example shows its stored run: no model is called and no account is needed.
  if (view.get().example && exampleHasRun && run.status === 'idle') {
    await openExampleRun('gauntlet', view.get().example);
    return;
  }

  const state = workbench.get();
  if (effectiveMode(state) !== 'bounty') {
    say('The gauntlet tests a finding against a programme. Pick "A bounty target" on the Load step.', { tone: 'warn' });
    return;
  }
  const room = LIMITS.files - (TOTAL - 1);
  if (state.files.length > room) {
    const over = state.files.length - room;
    say(`The gauntlet adds ${TOTAL - 1} stage files to yours. Remove ${count(over, 'file')} to stay within ${LIMITS.files}.`, { error: true });
    return;
  }

  const ready = await preflight({ feature: 'gauntlet', showNote, retry: () => runGauntlet(options) });
  if (!ready) return;
  const { request, acknowledge } = ready;

  const signature = signatureOf(state.files);
  if (options.restart || run.signature !== signature || run.status === 'done') run = idleRun(signature);
  if (options.force) run.force = true;
  dossier = null;

  const runButton = qs('#wb-gauntlet-run');
  const live = liveController({
    box: qs('#wb-gauntlet-live'),
    chip: qs('#wb-gauntlet-live .chip'),
    clock: qs('#wb-gauntlet-elapsed'),
    what: qs('#wb-gauntlet-what'),
    text: qs('#wb-gauntlet-text'),
    cancel: qs('#wb-gauntlet-cancel'),
  });

  controller = new AbortController();
  run.status = 'running';
  run.failedAt = null;
  run.provider = request.provider;
  workbench.set({ busy: true });
  setBusy(runButton, true, 'Running');
  if (!run.stages.length) track(EVENTS.GAUNTLET_STARTED);
  const stopClock = startTimer(() => {});
  let stop = null;

  for (let index = run.stages.length; index < TOTAL; index += 1) {
    const profileId = GAUNTLET[index];
    const name = stageLabel(profileId);
    paint();

    let inputs;
    try {
      inputs = stageInputs(state.files, run.stages, { context: state.context });
    } catch (error) {
      stop = { kind: 'input', error: error instanceof Error ? error : new Error(String(error)) };
      break;
    }
    run.sent = inputs.extras;

    live.start(`Stage ${index + 1} of ${TOTAL} · ${name} · ${request.model}`);
    say(`Gauntlet running: stage ${index + 1} of ${TOTAL}, ${name}.`, { hold: true });
    const began = Date.now();
    let result;
    try {
      result = await streamReview({
        files: inputs.files,
        prompt: '',
        profile: profileId,
        provider: request.provider,
        model: request.model,
        apiKey: request.apiKey,
        context: state.context,
        mode: 'bounty',
        // A stage answer can hold an address the check flags; the user's own lines were accepted before the run.
        acknowledgeWarnings: acknowledge || inputs.warnings > 0,
      }, { signal: controller.signal, onDelta: live.write });
    } catch (error) {
      stop = { kind: error?.code === 'aborted' ? 'aborted' : 'error', error };
      break;
    }
    if (result.refused) {
      stop = { kind: 'refused' };
      break;
    }

    const record = stageRecord({
      number: index + 1,
      profileId,
      review: result.review,
      model: result.model || request.model,
      usage: result.usage,
      elapsed: Date.now() - began,
      truncated: result.truncated,
    });
    if (!record.verdict) {
      stop = { kind: 'format', truncated: result.truncated === true };
      break;
    }
    run.stages.push({ ...record, at: new Date().toISOString() });
    if (Array.isArray(result.manifest)) run.manifest = result.manifest;
    persist();

    if (stopsRun(record.verdict) && index < TOTAL - 1 && !run.force) {
      stop = { kind: 'gate' };
      break;
    }
  }

  const elapsed = stopClock();
  controller = null;
  setBusy(runButton, false);
  workbench.set({ busy: false });

  if (!stop) {
    live.hide();
    run.status = 'done';
    persist();
    paint();
    track(EVENTS.GAUNTLET_FINISHED);
    openDossier();
    say(`Gauntlet done in ${formatElapsed(elapsed)}: ${TOTAL} stages, one dossier.`, { tone: 'success' });
    return;
  }

  if (stop.kind === 'gate') {
    live.hide();
    run.status = 'gate';
  } else {
    run.status = 'stopped';
    // A stage that never started (the allowance, the plan, a sign-in, the input limits) did not fail.
    const started = stop.kind !== 'aborted' && stop.kind !== 'input' && !['daily_used', 'operator_only', 'signin'].includes(stop.error?.code);
    run.failedAt = started ? run.stages.length : null;
    const where = `Stage ${run.stages.length + 1} of ${TOTAL} · ${stageLabel(GAUNTLET[run.stages.length])}`;
    if (live.written) live.end(stop.kind === 'aborted' ? 'queued' : 'failed', `${where} · ${stop.kind === 'aborted' ? 'stopped' : 'did not finish'}`);
    else live.hide();
  }
  persist();
  paint();
  await reportStop(stop, request, options);
}

/** Wires the Gauntlet row. Call after initProviders() and initRun(). */
export function initGauntlet() {
  const runButton = qs('#wb-gauntlet-run');
  if (!runButton) return;

  restore();

  on(runButton, 'click', () => {
    if (runButton.getAttribute('aria-disabled') === 'true') {
      say('The gauntlet tests a finding against a programme. Pick "A bounty target" on the Load step.', { tone: 'warn' });
      return;
    }
    if (run.status === 'gate' || run.status === 'done') openDossier();
    else runGauntlet();
  });
  on(qs('#wb-gauntlet-cancel'), 'click', () => controller?.abort());

  // Finished stages belong to the files they were run on.
  workbench.select((state) => state.files, (files) => {
    if (run.status === 'running') return;
    if (run.stages.length && run.signature !== signatureOf(files)) {
      run = idleRun();
      dossier = null;
      persist();
      showNote(null);
      qs('#wb-gauntlet-live')?.setAttribute('hidden', '');
    }
    paint();
  });
  workbench.select((state) => `${state.profile}|${state.mode}`, paint);
  view.select((state) => `${state.via}|${state.example}`, () => {
    showNote(null);
    refreshExample();
  });
  subscribeAccount(paint);
  qs('#workspace')?.addEventListener('wb:step', (event) => {
    if (event.detail?.step === 'review') paint();
  });
  qs('#workspace')?.addEventListener('wb:clear', () => {
    run = idleRun();
    dossier = null;
    persist();
    showNote(null);
    qs('#wb-gauntlet-live')?.setAttribute('hidden', '');
    paint();
  });

  refreshExample();
}

/** Learns whether the loaded example carries a stored run, then paints. */
function refreshExample() {
  const id = view.get().example;
  if (!id) {
    exampleHasRun = false;
    paint();
    return;
  }
  paint();
  import('../example.mjs').then((module) => {
    const list = Array.isArray(module.EXAMPLES) ? module.EXAMPLES : [];
    exampleHasRun = Boolean(list.find((entry) => entry.id === id)?.gauntlet);
    paint();
  }).catch(() => {});
}
