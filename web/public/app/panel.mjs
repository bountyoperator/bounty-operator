/**
 * The panel: two to four models review the same files at once, then one of
 * them cross-examines the reviews against the source and keeps what the code
 * proves.
 *
 * Every seat is an ordinary POST /api/review with the profile chosen on the
 * Load step. The cross-examination is one more, with the profile `panel` and
 * the model reviews as extra files named panel-<n>-<model>.md, placed after
 * the user's own files. The server allows four hosted reviews at once on
 * Operator; this module never starts more.
 *
 * Seats can share one OpenRouter key or each use a provider's own key. A key
 * typed in a seat is held in memory by ./providers-ui.mjs, exactly like one
 * typed in the key field, and is never stored.
 *
 * Finished model reviews are kept through a cancel, a failed seat and an
 * exhausted allowance, so the next run asks only the models that did not
 * answer.
 *
 * Exports
 *   initPanel()                          wire the Panel row of the Run step. Call after initGauntlet().
 *   runPanel()                           -> Promise<void>
 *   Pure helpers (tested)
 *     MIN_SEATS, MAX_SEATS
 *     defaultSeats(providerId)           -> [{ provider, model }]   up to three models, one per vendor first
 *     cleanSeats(value)                  -> { seats, judge } | null   validates what was stored
 *     seatKey(seat)                      -> 'openrouter/anthropic/claude-sonnet-5.5'
 *     seatProblems(seats)                -> [{ index, message }]   seats: [{ provider, model, apiKey }]
 *     pickJudge(judge, answered)         -> index of the seat that cross-examines
 *     runPool(items, limit, work)        -> Promise<({ value } | { error })[]>
 *
 * DOM this module owns: #wb-row-panel and everything inside it (#wb-panel-seats,
 * #wb-panel-note, #wb-panel-run, #wb-panel-cancel, #wb-panel-hint, #wb-panel-live).
 * Storage: sessionStorage["bo:panel:seats"] (providers and model ids) and
 * ["bo:panel:run"] (finished model reviews). No key, no source file.
 */

import { parseReview } from '../parse.mjs';
import { reviewProfile } from '../profiles.mjs';
import { PROVIDERS, validateProviderRequest } from '../providers.mjs';
import { account, currentAccount, planOf, streamReview, subscribeAccount, track } from './api.mjs';
import { blockOf, blockedCopy, blockedNotice } from './blocked.mjs';
import { VERDICT_LABELS, openExampleRun, panelFileName, panelResult, seatRecord } from './dossier.mjs';
import { EVENTS } from './events.mjs';
import { compactFile, effectiveMode, extraInputs, liveBox, preflight, signatureOf, upgradeNote } from './gauntlet.mjs';
import { checkCredentials, heldKey, holdKey, modelUsageNote } from './providers-ui.mjs';
import { ensureSignedIn, failureFor } from './run.mjs';
import { EXPORT_PROVIDER, readSession, removeSession, workbench, writeSession } from './state.mjs';
import { button, clear, el, formatElapsed, icon, notice, on, qs, setBusy } from './ui.mjs';
import { say, setStep, view } from './workbench.mjs';

export const MIN_SEATS = 2;
export const MAX_SEATS = 4;

const SEATS_KEY = 'bo:panel:seats';
const RUN_KEY = 'bo:panel:run';
const CONCURRENCY = 4;
const DEFAULT_SEATS = 3;
const SLOT_RETRIES = 5;
const MODEL_ID = /^[\x21-\x7e]{1,200}$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function providerOf(id) {
  return PROVIDERS.find((entry) => entry.id === id) ?? PROVIDERS[0];
}

function vendorOf(modelId) {
  return modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : modelId;
}

/**
 * The seats a provider's model list suggests: up to three, one per vendor
 * first, because three different models catch more than three sizes of one.
 *
 * @param {string} providerId
 * @returns {{ provider: string, model: string }[]}
 */
export function defaultSeats(providerId) {
  const provider = providerOf(providerId);
  const picked = [];
  const vendors = new Set();
  for (const model of provider.models) {
    if (picked.length === DEFAULT_SEATS) break;
    if (vendors.has(vendorOf(model.id))) continue;
    vendors.add(vendorOf(model.id));
    picked.push(model.id);
  }
  for (const model of provider.models) {
    if (picked.length === DEFAULT_SEATS) break;
    if (!picked.includes(model.id)) picked.push(model.id);
  }
  return picked.map((model) => ({ provider: provider.id, model }));
}

/**
 * Validates stored seats. Null when they are not two to four seats on known
 * providers.
 *
 * @param {unknown} value
 * @returns {{ seats: { provider: string, model: string }[], judge: number } | null}
 */
export function cleanSeats(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.seats)) return null;
  const seats = value.seats
    .filter((seat) => seat && PROVIDERS.some((entry) => entry.id === seat.provider))
    .map((seat) => ({ provider: seat.provider, model: typeof seat.model === 'string' && (seat.model === '' || MODEL_ID.test(seat.model)) ? seat.model : '' }));
  if (seats.length !== value.seats.length || seats.length < MIN_SEATS || seats.length > MAX_SEATS) return null;
  const judge = Number.isInteger(value.judge) && value.judge >= 0 && value.judge < seats.length ? value.judge : 0;
  return { seats, judge };
}

/** @param {{ provider: string, model: string }} seat */
export function seatKey(seat) {
  return `${seat.provider}/${seat.model}`;
}

/**
 * What stops a set of seats from running: a missing key, a model id or key
 * the provider would refuse, the same model twice.
 *
 * @param {{ provider: string, model: string, apiKey: string }[]} seats
 * @returns {{ index: number, field: 'key' | 'model', message: string }[]}
 */
export function seatProblems(seats) {
  const problems = [];
  const seen = new Map();
  seats.forEach((seat, index) => {
    const provider = providerOf(seat.provider);
    if (seen.has(seatKey(seat))) {
      problems.push({ index, field: 'model', message: `Model ${index + 1} repeats model ${seen.get(seatKey(seat)) + 1}. Pick a different model.` });
      return;
    }
    seen.set(seatKey(seat), index);
    if (!seat.apiKey) {
      problems.push({ index, field: 'key', message: `Model ${index + 1} needs the ${provider.keyLabel}.` });
      return;
    }
    try {
      validateProviderRequest(seat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The provider settings are not valid.';
      problems.push({ index, field: /model identifier/.test(message) ? 'model' : 'key', message: `Model ${index + 1}: ${message}` });
    }
  });
  return problems;
}

/**
 * The seat that cross-examines: the chosen one when it answered, else the
 * first that did. -1 when none did.
 *
 * @param {number} judge
 * @param {boolean[]} answered
 */
export function pickJudge(judge, answered) {
  return answered[judge] ? judge : answered.indexOf(true);
}

/**
 * Runs `work(item, index)` for every item, at most `limit` at a time, and
 * resolves with one `{ value }` or `{ error }` per item, in order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} work
 * @returns {Promise<({ value: R } | { error: unknown })[]>}
 */
export function runPool(items, limit, work) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.floor(limit) || 1);
  let next = 0;
  let active = 0;
  return new Promise((resolve) => {
    const pump = () => {
      if (next >= items.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < width && next < items.length) {
        const index = next;
        next += 1;
        active += 1;
        Promise.resolve()
          .then(() => work(items[index], index))
          .then((value) => {
            results[index] = { value };
          }, (error) => {
            results[index] = { error };
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    };
    pump();
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {{ provider: string, model: string }[]} */
let seats = [];
let judge = 0;
/** Until the user edits a seat, the seats follow the provider chosen above. */
let pristine = true;
/** Finished model reviews of the material identified by `signature`, by seat key. */
let held = { signature: '', records: {} };
/** @type {AbortController | null} */
let controller = null;
let exampleHasRun = false;

function activeProvider() {
  const { provider } = workbench.get();
  return provider === EXPORT_PROVIDER ? PROVIDERS[0].id : providerOf(provider).id;
}

function saveSeats() {
  if (pristine) removeSession(SEATS_KEY);
  else writeSession(SEATS_KEY, { seats, judge });
}

function persistHeld() {
  if (Object.keys(held.records).length) writeSession(RUN_KEY, { v: 1, signature: held.signature, records: held.records });
  else removeSession(RUN_KEY);
}

function keptCount() {
  return Object.keys(held.records).length;
}

function runSignature(state) {
  return signatureOf(state.files, `${state.profile}|${effectiveMode(state)}|${state.focus}|${JSON.stringify(state.context)}`);
}

// ---------------------------------------------------------------------------
// The seats
// ---------------------------------------------------------------------------

function note(node) {
  const target = qs('#wb-panel-note');
  if (!target) return;
  clear(target);
  if (node) target.append(node);
  // The upgrade panel stands in for the button, unless finished reviews are waiting.
  const actions = qs('#wb-panel-actions');
  if (actions) actions.hidden = Boolean(node?.classList?.contains('wb-upgrade')) && keptCount() === 0;
}

function seatError(index, message) {
  const error = qs(`#wb-seat-${index}-error`);
  if (!error) return;
  clear(error);
  error.hidden = !message;
  if (message) error.append(icon('error'), el('span', { text: message }));
}

function clearSeatErrors() {
  seats.forEach((seat, index) => seatError(index, ''));
  for (const control of document.querySelectorAll('#wb-panel-seats [aria-invalid]')) control.removeAttribute('aria-invalid');
}

/** The provider whose key the "Run with" rows above hold, or '' on the chat-subscription path. */
function keyedAbove() {
  const { via, keyProvider } = view.get();
  return via === 'connect' ? 'openrouter' : via === 'key' ? keyProvider : '';
}

function seatRow(seat, index) {
  const provider = providerOf(seat.provider);
  const usage = modelUsageNote(provider.id, seat.model || provider.defaultModel);
  const n = index + 1;
  const listId = `wb-seat-${index}-models`;
  return el('div', { class: 'rn-seat', dataset: { seat: index } },
    el('span', { class: 'rn-seat__n num', 'aria-hidden': 'true', text: String(n) }),
    el('select', { class: 'select rn-seat__provider', id: `wb-seat-${index}-provider`, 'aria-label': `Provider of model ${n}`, dataset: { seatProvider: index }, value: provider.id },
      PROVIDERS.map((entry) => el('option', { value: entry.id, text: entry.label }))),
    el('input', {
      class: 'input mono rn-seat__model',
      id: `wb-seat-${index}-model`,
      type: 'text',
      list: listId,
      placeholder: provider.defaultModel,
      'aria-label': `Model ${n}`,
      'aria-describedby': `wb-seat-${index}-usage wb-seat-${index}-error`,
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      maxlength: '200',
      dataset: { seatModel: index },
      value: seat.model,
    }),
    el('datalist', { id: listId }, provider.models.map((entry) => el('option', { value: entry.id, label: entry.note ? `${entry.label} · ${entry.note}` : entry.label }))),
    el('label', { class: 'rn-seat__judge', title: 'This model cross-examines the reviews' },
      el('input', { type: 'radio', name: 'wb-panel-judge', value: String(index), checked: judge === index }),
      el('span', { text: 'Cross-examines' })),
    button({ label: `Remove model ${n}`, icon: 'x', iconOnly: true, variant: 'quiet', size: 'sm', disabled: seats.length <= MIN_SEATS, attrs: { 'data-seat-remove': String(index) } }),
    // The provider chosen above uses the key given there. Any other provider takes its key here, in its first row.
    provider.id === keyedAbove() || seats.findIndex((entry) => providerOf(entry.provider).id === provider.id) !== index ? null : el('input', {
      class: 'input mono rn-seat__key',
      id: `wb-seat-${index}-key`,
      type: 'password',
      placeholder: `${provider.keyLabel}${provider.keyPrefixHint ? ` (${provider.keyPrefixHint}…)` : ''}`,
      'aria-label': `${provider.keyLabel} for model ${n}`,
      'aria-describedby': `wb-seat-${index}-error`,
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '4096',
      dataset: { seatKey: provider.id },
      value: heldKey(provider.id),
    }),
    el('p', { class: 'help rn-seat__usage', id: `wb-seat-${index}-usage`, text: usage, hidden: !usage }),
    el('p', { class: 'field-error rn-seat__error', id: `wb-seat-${index}-error`, role: 'alert', hidden: true }));
}

function paintSeats() {
  const target = qs('#wb-panel-seats');
  if (!target) return;
  clear(target).append(
    ...seats.map(seatRow),
    el('div', { class: 'rn-seats__tools' },
      button({ label: 'Add a model', id: 'wb-panel-add', variant: 'quiet', size: 'sm', icon: 'plus', disabled: seats.length >= MAX_SEATS }),
      el('p', { class: 'fine', text: 'Any model id the provider serves works. A key typed here is held in memory for this tab and never stored.' })));
}

function paint() {
  const row = qs('#wb-row-panel');
  if (!row) return;
  const { via, example } = view.get();
  row.hidden = via === 'export';

  const plan = planOf(currentAccount());
  const kept = keptCount();
  const runButton = qs('#wb-panel-run');
  const busy = controller !== null;
  let label = 'Run the panel';
  let hint = plan === 'operator'
    ? `${seats.length} reviews at once, then one cross-check.`
    : 'An Operator run: four reviews at a time.';
  if (example && exampleHasRun && !kept) {
    label = 'Show the panel on this example';
    hint = 'Stored with the example: the model reviews and their cross-examination. No account needed.';
  } else if (kept) {
    label = kept >= seats.length ? 'Run the cross-examination' : 'Run the remaining models';
    hint = `${kept} finished model review${kept === 1 ? ' is' : 's are'} kept in this tab.`;
  }
  if (!busy) {
    const node = runButton?.querySelector('.btn__label');
    if (node && node.textContent !== label) node.textContent = label;
  }
  const hintNode = qs('#wb-panel-hint');
  if (hintNode) hintNode.textContent = hint;
  if (plan === 'operator' && qs('#wb-panel-note .wb-upgrade')) note(null);
}

function setSeats(next, nextJudge = judge) {
  seats = next;
  judge = Math.min(Math.max(0, nextJudge), seats.length - 1);
  saveSeats();
  paintSeats();
  paint();
}

function followProvider() {
  if (!pristine) return;
  const wanted = defaultSeats(activeProvider());
  if (JSON.stringify(wanted) === JSON.stringify(seats)) return;
  seats = wanted;
  judge = 0;
  paintSeats();
  paint();
}

function addSeat() {
  if (seats.length >= MAX_SEATS) return;
  const provider = providerOf(seats[seats.length - 1]?.provider ?? activeProvider());
  const used = new Set(seats.filter((seat) => seat.provider === provider.id).map((seat) => seat.model || provider.defaultModel));
  const model = provider.models.find((entry) => !used.has(entry.id))?.id ?? '';
  pristine = false;
  setSeats([...seats, { provider: provider.id, model }]);
  qs(`#wb-seat-${seats.length - 1}-model`)?.focus();
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function runSeat(seat, index, { state, profile, mode, acknowledge, live, signal }) {
  const cached = held.records[seatKey(seat)];
  if (cached) {
    live.start(seat.model);
    live.write(cached.review);
    live.end('done', `${seat.model} · kept from the last run`, VERDICT_LABELS[cached.verdict] ?? 'Done');
    return cached;
  }

  const began = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    live.start(seat.model);
    try {
      const result = await streamReview({
        files: state.files,
        prompt: state.focus,
        profile: profile.id,
        provider: seat.provider,
        model: seat.model,
        apiKey: seat.apiKey,
        context: state.context,
        mode,
        acknowledgeWarnings: acknowledge,
      }, { signal, onDelta: live.write });
      if (result.refused || blockOf(result)) throw declined(result);

      const record = seatRecord({ number: index + 1, provider: seat.provider, model: seat.model, review: result.review, usage: result.usage, elapsed: Date.now() - began });
      if (!record.verdict) {
        throw Object.assign(new Error(result.truncated ? 'The answer was cut off before its verdict.' : 'The answer is not in the review format.'), { code: 'format' });
      }
      held.records[seatKey(seat)] = record;
      persistHeld();
      live.end('done', seat.model, VERDICT_LABELS[record.verdict] ?? 'Done');
      return record;
    } catch (error) {
      // Another tab holds a slot: wait for it instead of failing the seat.
      if (error?.code === 'review_running' && attempt < SLOT_RETRIES && !signal.aborted) {
        live.end('queued', `${seat.model} · waiting for a free slot`, 'Waiting');
        await sleep(3000 + attempt * 2000, signal);
        if (!signal.aborted) continue;
      }
      const aborted = error?.code === 'aborted' || signal.aborted;
      live.end(aborted ? 'queued' : 'failed', `${seat.model} · ${aborted ? 'stopped' : 'did not finish'}`);
      throw error;
    }
  }
}

/** The error for an answer that is a refusal or a provider block, carrying the block when there is one. */
function declined(result) {
  const blocked = blockOf(result);
  return Object.assign(new Error('The model declined to answer.'), { code: 'refused', ...(blocked ? { blocked } : {}) });
}

/** One row's reason. A seat the provider blocked names the block and the way on: another model in that seat. */
export function failureLine(seat, error, via) {
  const blocked = blockedCopy(error);
  if (blocked) return `${seat.model}: ${blocked.line} Pick another model for this seat.`;
  if (error?.code === 'refused' || error?.code === 'format') return `${seat.model}: ${error.message}`;
  return `${seat.model}: ${failureFor(error, via).message}`;
}

function finishRun(runButton) {
  controller = null;
  qs('#wb-panel-cancel')?.remove();
  setBusy(runButton, false);
  workbench.set({ busy: false });
  paint();
}

/**
 * Runs the panel on the loaded files with the seats in the row, or shows the
 * stored panel when an example that carries one is loaded.
 *
 * @param {{ retried?: boolean }} [options]
 */
export async function runPanel(options = {}) {
  if (workbench.get().busy) return;
  note(null);
  clearSeatErrors();

  if (view.get().example && exampleHasRun && !keptCount()) {
    await openExampleRun('panel', view.get().example);
    return;
  }

  const ready = await preflight({ feature: 'panel', showNote: note, checkKey: false, retry: () => runPanel(options) });
  if (!ready) return;
  const { state, acknowledge } = ready;
  const via = view.get().via;

  const chosen = seats.map((seat) => {
    const provider = providerOf(seat.provider);
    return { provider: provider.id, model: seat.model.trim() || provider.defaultModel, apiKey: heldKey(provider.id) };
  });
  const problems = seatProblems(chosen);
  if (problems.length) {
    for (const problem of problems) {
      seatError(problem.index, problem.message);
      qs(`#wb-seat-${problem.index}-${problem.field}`)?.setAttribute('aria-invalid', 'true');
    }
    const first = problems[0];
    say(first.message, { error: true });
    // A key that belongs under "Run with" is asked for there, the way a single run asks for it.
    if (first.field === 'key' && chosen[first.index].provider === keyedAbove()) checkCredentials();
    else (qs(`#wb-seat-${first.index}-${first.field}`) ?? qs(`[data-seat-key="${chosen[first.index].provider}"]`) ?? qs(`#wb-seat-${first.index}-model`))?.focus();
    return;
  }

  const profile = reviewProfile(state.profile);
  const mode = effectiveMode(state);
  const signature = runSignature(state);
  if (held.signature !== signature) held = { signature, records: {} };
  const fresh = keptCount() === 0;

  const runButton = qs('#wb-panel-run');
  const liveRoot = qs('#wb-panel-live');
  const boxes = chosen.map((seat) => liveBox(seat.model));
  clear(liveRoot).append(...boxes.map((entry) => entry.box));
  liveRoot.dataset.count = String(boxes.length);
  liveRoot.hidden = false;

  controller = new AbortController();
  const { signal } = controller;
  workbench.set({ busy: true });
  setBusy(runButton, true, 'Running');
  runButton.after(button({ label: 'Cancel', id: 'wb-panel-cancel', variant: 'quiet', icon: 'x', onClick: () => controller?.abort() }));
  if (fresh) track(EVENTS.PANEL_STARTED);
  say(`Panel running: ${chosen.length} models on ${profile.name}.`, { hold: true });
  const startedAt = Date.now();

  const current = await account().catch(() => currentAccount());
  const limit = Math.min(CONCURRENCY, Number(current.usage?.concurrency) || CONCURRENCY);
  const outcomes = await runPool(chosen, limit, (seat, index) => runSeat(seat, index, { state, profile, mode, acknowledge, live: boxes[index], signal }));

  const answered = outcomes.map((outcome) => Boolean(outcome && 'value' in outcome));
  const failed = outcomes.map((outcome, index) => ({ outcome, index })).filter(({ outcome }) => !outcome || 'error' in outcome);
  const keptLine = () => {
    const kept = keptCount();
    return kept ? ` ${kept} finished model review${kept === 1 ? ' is' : 's are'} kept.` : '';
  };

  if (signal.aborted) {
    finishRun(runButton);
    say(`Stopped.${keptLine()}`, { hold: true });
    return;
  }

  const quota = failed.find(({ outcome }) => outcome?.error?.code === 'daily_used');
  if (quota) {
    finishRun(runButton);
    const plan = planOf(await account().catch(() => currentAccount()));
    note(upgradeNote({ feature: 'panel', plan: plan === 'operator' ? 'free' : plan, kept: keptCount(), used: true, retry: () => runPanel() }));
    say(`Today's free review is used.${keptLine()}`, { tone: 'warn', hold: true });
    qs('#wb-row-panel [data-upgrade]')?.focus();
    return;
  }
  const signedOut = failed.find(({ outcome }) => outcome?.error?.code === 'signin');
  if (signedOut && !options.retried) {
    finishRun(runButton);
    if (await ensureSignedIn()) await runPanel({ retried: true });
    else say(`Sign in to run the panel.${keptLine()}`, { tone: 'warn', hold: true });
    return;
  }

  for (const { outcome, index } of failed) {
    const failure = failureFor(outcome?.error, via);
    seatError(index, failureLine(chosen[index], outcome?.error, via));
    if (failure.field) qs(`#wb-seat-${index}-${failure.field === 'model' ? 'model' : 'key'}`)?.setAttribute('aria-invalid', 'true');
  }
  if (answered.filter(Boolean).length < MIN_SEATS) {
    finishRun(runButton);
    // Each failed row already says why, in place.
    note(notice('error', 'Fewer than two models answered', `A panel needs two reviews to compare.${keptLine()} Each failed row above says why: fix it or swap the model, then run it again.`));
    say('The panel stopped: fewer than two models answered.', { error: true });
    return;
  }

  // The cross-examination: the reviews that arrived travel as panel-<n>-<model>.md.
  const records = outcomes.filter((outcome) => outcome && 'value' in outcome).map((outcome, index) => ({
    ...outcome.value,
    number: index + 1,
    file: panelFileName(index + 1, outcome.value.model),
  }));
  const judgeSeat = chosen[pickJudge(judge, answered)];

  let inputs;
  try {
    inputs = extraInputs(state.files, records.map((record) => ({ name: record.file, content: record.review })), { context: state.context, compact: compactFile });
  } catch (error) {
    finishRun(runButton);
    say(`${error instanceof Error ? error.message : String(error)} The model reviews travel with the cross-examination: remove a file to make room.${keptLine()}`, { error: true });
    return;
  }

  const merge = liveBox('Cross-examination');
  merge.box.classList.add('rn-stream--wide');
  liveRoot.append(merge.box);
  merge.start(`Cross-examination · ${judgeSeat.model}`);
  say(`Panel running: ${judgeSeat.model} cross-examines ${records.length} reviews.`, { hold: true });

  let result = null;
  let failure = null;
  try {
    result = await streamReview({
      files: inputs.files,
      prompt: '',
      profile: 'panel',
      provider: judgeSeat.provider,
      model: judgeSeat.model,
      apiKey: judgeSeat.apiKey,
      context: state.context,
      mode,
      acknowledgeWarnings: acknowledge || inputs.warnings > 0,
    }, { signal, onDelta: merge.write });
    if (result.refused || blockOf(result)) failure = declined(result);
    else if (!parseReview(result.review).ok) {
      failure = Object.assign(new Error(result.truncated ? 'The answer was cut off before its verdict.' : 'The answer is not in the review format.'), { code: 'format' });
    }
  } catch (error) {
    failure = error;
  }

  const elapsed = Date.now() - startedAt;
  if (failure) {
    const aborted = failure?.code === 'aborted' || signal.aborted;
    merge.end(aborted ? 'queued' : 'failed', `Cross-examination · ${judgeSeat.model} · ${aborted ? 'stopped' : 'did not finish'}`);
    finishRun(runButton);
    if (aborted) {
      say(`Stopped during the cross-examination.${keptLine()}`, { hold: true });
      return;
    }
    if (failure?.code === 'daily_used' || failure?.code === 'operator_only') {
      // The allowance ran out, or the server refused the cross-examination because the plan does not cover it.
      const used = failure.code === 'daily_used';
      const plan = planOf(await account().catch(() => currentAccount()));
      note(upgradeNote({ feature: 'panel', plan: plan === 'operator' ? 'free' : plan, kept: keptCount(), used, retry: () => runPanel() }));
      say(`${used ? "Today's free review is used." : 'The panel runs on Operator.'}${keptLine()}`, { tone: 'warn', hold: true });
      qs('#wb-row-panel [data-upgrade]')?.focus();
      return;
    }
    const blocked = blockedCopy(failure);
    if (blocked) {
      note(blockedNotice(failure, { context: `The cross-examination by ${judgeSeat.model} was blocked.${keptLine()} Let another model cross-examine.` }));
      say(`${blocked.title}: the panel stopped at the cross-examination.${keptLine()} Let another model cross-examine.`, { tone: 'warn', hold: true });
      return;
    }
    note(notice('error', 'The cross-examination did not finish', `${failureLine(judgeSeat, failure, via)}${keptLine()} Run it again, or let another model cross-examine.`));
    say('The panel stopped at the cross-examination.', { error: true });
    return;
  }

  const final = panelResult({
    seats: records.map((record, index) => (inputs.extras[index].content !== record.review ? { ...record, sent: inputs.extras[index].content } : record)),
    judge: { review: result.review, model: result.model || judgeSeat.model, provider: judgeSeat.provider, usage: result.usage, truncated: result.truncated },
    manifest: result.manifest ?? [],
    mode,
    profile: { id: profile.id, name: profile.name },
  });
  held = { signature: '', records: {} };
  persistHeld();
  finishRun(runButton);
  liveRoot.hidden = true;
  clear(liveRoot);
  track(EVENTS.PANEL_FINISHED);
  workbench.set({ result: final });
  setStep('results');
  const left = failed.map(({ index }) => chosen[index].model);
  say(left.length
    ? `Panel done in ${formatElapsed(elapsed)}. ${left.join(', ')} did not answer and ${left.length === 1 ? 'was' : 'were'} left out.`
    : `Panel done in ${formatElapsed(elapsed)}: ${records.length} reviews, one cross-examination.`, { tone: left.length ? 'warn' : 'success', hold: left.length > 0 });
}

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
    exampleHasRun = Boolean(list.find((entry) => entry.id === id)?.panel);
    paint();
  }).catch(() => {});
}

function discardHeld() {
  held = { signature: '', records: {} };
  persistHeld();
  const liveRoot = qs('#wb-panel-live');
  if (liveRoot && controller === null) {
    liveRoot.hidden = true;
    clear(liveRoot);
  }
}

/** Wires the Panel row. Call after initGauntlet(). */
export function initPanel() {
  const runButton = qs('#wb-panel-run');
  const list = qs('#wb-panel-seats');
  if (!runButton || !list) return;

  const stored = cleanSeats(readSession(SEATS_KEY));
  if (stored) {
    seats = stored.seats;
    judge = stored.judge;
    pristine = false;
  } else {
    seats = defaultSeats(activeProvider());
  }
  const kept = readSession(RUN_KEY);
  if (kept && kept.v === 1 && kept.signature === runSignature(workbench.get()) && kept.records && typeof kept.records === 'object') {
    held = { signature: kept.signature, records: kept.records };
  } else {
    removeSession(RUN_KEY);
  }

  on(runButton, 'click', () => runPanel());
  on(list, 'change', '[data-seat-provider]', (event, control) => {
    const index = Number(control.dataset.seatProvider);
    pristine = false;
    setSeats(seats.map((seat, at) => (at === index ? { provider: control.value, model: '' } : seat)));
    qs(`#wb-seat-${index}-model`)?.focus();
  });
  on(list, 'input', '[data-seat-model]', (event, control) => {
    const index = Number(control.dataset.seatModel);
    pristine = false;
    seats = seats.map((seat, at) => (at === index ? { ...seat, model: control.value.trim() } : seat));
    const provider = providerOf(seats[index].provider);
    const usage = modelUsageNote(provider.id, seats[index].model || provider.defaultModel);
    const hint = qs(`#wb-seat-${index}-usage`);
    if (hint) { hint.textContent = usage; hint.hidden = !usage; }
    control.removeAttribute('aria-invalid');
    seatError(index, '');
    saveSeats();
  });
  on(list, 'input', '[data-seat-key]', (event, control) => {
    holdKey(control.dataset.seatKey, control.value);
    control.removeAttribute('aria-invalid');
    // The same provider in another row is covered by this key too.
    for (const other of list.querySelectorAll(`[data-seat-key="${control.dataset.seatKey}"]`)) {
      if (other !== control && other.value !== control.value) other.value = control.value;
    }
  });
  on(list, 'change', 'input[name="wb-panel-judge"]', (event, control) => {
    judge = Number(control.value);
    pristine = false;
    saveSeats();
  });
  on(list, 'click', '[data-seat-remove]', (event, control) => {
    if (seats.length <= MIN_SEATS) return;
    const index = Number(control.dataset.seatRemove);
    pristine = false;
    setSeats(seats.filter((seat, at) => at !== index), judge > index ? judge - 1 : judge === index ? 0 : judge);
    qs('#wb-panel-add')?.focus();
  });
  on(list, 'click', '#wb-panel-add', addSeat);

  workbench.select((state) => state.provider, followProvider);
  // Finished reviews belong to the material they were written about.
  workbench.subscribe((state, previous) => {
    const changed = state.files !== previous.files || state.profile !== previous.profile || state.mode !== previous.mode
      || state.focus !== previous.focus || state.context !== previous.context;
    if (changed && controller === null && keptCount() && held.signature !== runSignature(state)) {
      discardHeld();
      note(null);
      paint();
    }
  });
  view.select((state) => `${state.via}|${state.example}|${state.keyProvider}`, () => {
    note(null);
    // A key that arrived, or left, changes which rows ask for one.
    if (controller === null) paintSeats();
    refreshExample();
  });
  subscribeAccount(paint);
  qs('#workspace')?.addEventListener('wb:step', (event) => {
    if (event.detail?.step !== 'review' || controller !== null) return;
    paintSeats();
    paint();
  });
  qs('#workspace')?.addEventListener('wb:clear', () => {
    discardHeld();
    note(null);
    paint();
  });

  paintSeats();
  refreshExample();
}
