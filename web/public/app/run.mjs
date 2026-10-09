/**
 * The hosted run: checks the key before asking for a sign-in, streams the
 * review with an elapsed timer and a Cancel button, and turns every failure
 * into a sentence that names the cause and the next action.
 *
 * The account dialog and Stripe checkout belong to ./account.mjs, which is
 * loaded when first needed:
 *   requireSignIn({ reason: 'review' }) -> Promise<boolean>
 *   startCheckout()                     -> Promise<boolean>   counts the click itself
 *   openAccount({ tab })
 * On a page without it the workbench still works: the hosted run says to sign
 * in and offers the chat-subscription path, and the upgrade button opens /pricing.
 *
 * Exports
 *   initRun()                         wire #wb-run, #wb-cancel, the quota line and the upgrade panel
 *   runReview({ acknowledge })        -> Promise<void>   start a hosted run now
 *   failureFor(error, via)            -> { message, tone, field?, upgrade?, operatorOnly?, warn?, partial?, signin?, blocked? }   pure, tested
 *   finishedLine(result, elapsed)     -> { message, tone, hold }   what the status line says about a finished run          pure, tested
 *   quotaLine(account)                -> { text, used }                                                   pure, tested
 *   listedProfile(id)                 -> boolean   a profile a single run may use                          pure, tested
 *   ensureSignedIn(), upgrade(), openAccount()   the account steps, shared with ./gauntlet.mjs and ./panel.mjs
 *
 * DOM this module owns: #wb-run, #wb-quota, #wb-upgrade, #wb-run-warn,
 * #wb-live, #wb-elapsed, #wb-live-what, #wb-live-text, #wb-cancel.
 */

import { describeFinding, manifestFor } from '../review-core.mjs';
import { reviewProfile } from '../profiles.mjs';
import { account, currentAccount, planOf, streamReview, subscribeAccount, track } from './api.mjs';
import { blockedCopy, blockedNotice } from './blocked.mjs';
import { EVENTS } from './events.mjs';
import { checkCredentials, clearInvalid, credentials, markInvalid, setVia } from './providers-ui.mjs';
import { saveWorkbench, workbench } from './state.mjs';
import { button, clear, el, formatCountdown, formatElapsed, notice, on, qs, setBusy, startTimer, timeUntil } from './ui.mjs';
import { reportInputError, say, scan, setStep, view, warningsAccepted } from './workbench.mjs';

const PRICE = 'US$10 a week';
const PARTIAL_WORTH_KEEPING = 400;
const COUNTDOWN_REFRESH_MS = 30000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function seconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : 0;
}

function wait(retryAfter) {
  const amount = seconds(retryAfter);
  if (!amount) return '';
  return amount < 90 ? ` Try again in ${amount} seconds.` : ` Try again in ${Math.ceil(amount / 60)} minutes.`;
}

/**
 * What to tell the user about a failed run, by error code.
 *
 * @param {{ code?: string, message?: string, data?: Record<string, any> }} error  An ApiError.
 * @param {'connect' | 'key' | 'export'} [via]
 * @returns {{ message: string, tone: 'error' | 'warn' | 'info', field?: 'key' | 'model' | 'connect', upgrade?: boolean, operatorOnly?: boolean, warn?: boolean, block?: boolean, signin?: boolean, partial?: string, exportHint?: boolean, blocked?: string }}
 */
export function failureFor(error, via = 'key') {
  const data = error?.data ?? {};
  const text = error?.message || 'The review did not finish. Run it again.';
  const partial = typeof data.partial === 'string' && data.partial.length >= PARTIAL_WORTH_KEEPING ? data.partial : undefined;
  const keyField = via === 'connect' ? 'connect' : 'key';

  switch (error?.code) {
    case 'aborted':
      return { message: partial ? 'Stopped. What arrived can be opened as a cut-off review.' : 'Stopped. No review was produced.', tone: 'info', partial };
    case 'signin':
      return { message: 'Sign in to run a review on your API key. Copy-paste reviews in your chat app need no account.', tone: 'warn', signin: true };
    case 'daily_used':
      return { message: "Today's free review is used.", tone: 'warn', upgrade: true };
    case 'operator_only':
      // The profile runs only inside the gauntlet or a panel review, and the plan does not cover those.
      return { message: text, tone: 'warn', upgrade: true, operatorOnly: true };
    case 'output_withheld':
      // The server's sentence says what happened and what to do; the model field is where to act.
      return { message: text, tone: 'error', field: 'model' };
    case 'review_running':
      return { message: 'A review is already running on this account. Start the next one when it finishes.', tone: 'warn' };
    case 'privacy_block':
      return { message: text, tone: 'error', block: true };
    case 'privacy_warn':
      return { message: 'The check found an email or IP address. Confirm below to send it as it is.', tone: 'warn', warn: true };
    case 'bad_key':
      return { message: text, tone: 'error', field: keyField };
    case 'bad_model':
      return { message: text, tone: 'error', field: 'model' };
    case 'provider_policy': {
      // The provider blocked the request under its usage policy: the key and the model id are fine.
      const copy = blockedCopy(error);
      return { message: copy.line, tone: 'warn', blocked: copy.block };
    }
    case 'provider': {
      if (data.kind === 'auth') {
        return {
          message: via === 'connect' ? `${text} Disconnect and connect OpenRouter again.` : text,
          tone: 'error',
          field: keyField,
        };
      }
      if (data.kind === 'model') return { message: text, tone: 'error', field: 'model' };
      // The provider's sentence can carry the wait itself; it is said once.
      return { message: /\bRetry after \d+ seconds\./.test(text) ? text : `${text}${wait(data.retryAfter)}`, tone: 'error', partial };
    }
    case 'rate_limited':
      return { message: `Too many requests from this address.${wait(data.retryAfter) || ' Try again in a minute.'}`, tone: 'warn' };
    case 'reviews_paused':
      return { message: text, tone: 'warn', exportHint: true };
    case 'too_large':
      return { message: 'The request is over the 1.5 MB limit. Remove a file or shorten the evidence fields.', tone: 'error' };
    case 'network':
      return { message: 'Bounty Operator could not be reached. Check the connection and run it again. Your files are still in this tab.', tone: 'error' };
    case 'timeout':
    case 'stream_ended':
      return { message: partial ? `${text} What arrived can be opened as a cut-off review.` : text, tone: 'error', partial };
    case 'csrf':
      return { message: 'The session changed in another tab. Reload this page and run it again.', tone: 'error' };
    default:
      return { message: text, tone: 'error', partial };
  }
}

/**
 * What the status line says when a run comes back with an answer. A blocked
 * or refused answer is not a review, so it never reads as "Review done".
 *
 * @param {{ blocked?: string, refused?: boolean, truncated?: boolean }} result
 * @param {number} elapsed  milliseconds
 * @returns {{ message: string, tone: 'warn' | 'success', hold: boolean }}
 */
export function finishedLine(result, elapsed) {
  const blocked = blockedCopy(result);
  if (blocked) return { message: blocked.line, tone: 'warn', hold: true };
  if (result.refused) return { message: 'The model declined to answer. Its reply is shown as written.', tone: 'warn', hold: true };
  if (result.truncated) return { message: 'The answer was cut off before it finished. What arrived is shown.', tone: 'warn', hold: true };
  return { message: `Review done in ${formatElapsed(elapsed)}.`, tone: 'success', hold: false };
}

/**
 * True for a profile a single hosted run may use: one the workbench lists.
 * The unlisted ones are steps of the gauntlet and of a panel review.
 *
 * @param {string} id
 */
export function listedProfile(id) {
  try {
    return typeof id === 'string' && reviewProfile(id).listed === true;
  } catch {
    return false;
  }
}

/**
 * The line under the Run button, and whether the free review is used up.
 *
 * @param {import('./api.mjs').Account} current
 * @returns {{ text: string, used: boolean, pastDue: boolean }}
 */
export function quotaLine(current) {
  const plan = planOf(current);
  const usage = current.usage;
  const used = plan !== 'operator' && Boolean(usage) && usage.remainingToday === 0;
  if (!current.loaded) return { text: '', used: false, pastDue: false };
  if (plan === 'anon') return { text: '1 free review a day with your own key. You create the account when you run it.', used: false, pastDue: false };
  if (plan === 'operator') return { text: 'Operator: unlimited reviews.', used: false, pastDue: false };
  if (plan === 'past_due') return { text: 'Operator payment failed. Update the card in your account to get unlimited reviews back.', used, pastDue: true };
  const left = usage?.remainingToday ?? 1;
  return { text: `Free plan: ${left} review${left === 1 ? '' : 's'} left today.`, used, pastDue: false };
}

// ---------------------------------------------------------------------------
// Account and billing, loaded when needed
// ---------------------------------------------------------------------------

async function load(path) {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

/** Signs the visitor in when needed. Shared with the gauntlet and the panel. */
export async function ensureSignedIn() {
  if (currentAccount().signedIn) return true;
  const fresh = await account().catch(() => currentAccount());
  if (fresh.signedIn) return true;

  const module = await load('./account.mjs');
  if (typeof module?.requireSignIn === 'function') {
    // The work is stored before the dialog opens: a passkey prompt can reload some browsers.
    saveWorkbench();
    try {
      return Boolean(await module.requireSignIn({ reason: 'review' }));
    } catch {
      return false;
    }
  }
  return false;
}

/** Starts Operator checkout, or opens /pricing on a page without the account panel. */
export async function upgrade() {
  saveWorkbench();
  const module = await load('./account.mjs');
  if (typeof module?.startCheckout === 'function') {
    // startCheckout() counts the click, signs in when needed and reports its own failures in the Billing tab.
    try {
      await module.startCheckout();
    } catch (error) {
      say(error instanceof Error && error.message ? error.message : 'Checkout could not be opened. Try again.', { error: true });
    }
    return;
  }
  track(EVENTS.UPGRADE_CLICKED);
  window.location.assign('/pricing');
}

/** Opens the Billing tab of the account panel. */
export async function openAccount() {
  const module = await load('./account.mjs');
  if (typeof module?.openAccount === 'function') module.openAccount({ tab: 'billing' });
  else qs('#account-button')?.click();
}

// ---------------------------------------------------------------------------
// Quota line and upgrade panel
// ---------------------------------------------------------------------------

let countdownTimer = null;
let forcedReset = '';

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

function showUpgrade(resetsAt, pastDue = false) {
  const panel = qs('#wb-upgrade');
  const actions = qs('#wb-run-actions');
  if (!panel) return;
  stopCountdown();
  const opens = el('span', { class: 'num' });
  const tick = () => {
    const left = timeUntil(resetsAt);
    opens.textContent = left > 0 ? `The next one opens in ${formatCountdown(left)}, at 00:00 UTC.` : 'The next one is open: run the review again.';
    if (left <= 0) {
      stopCountdown();
      forcedReset = '';
      account().then(paintQuota).catch(() => {});
    }
  };
  tick();
  countdownTimer = setInterval(tick, COUNTDOWN_REFRESH_MS);

  clear(panel).append(
    el('p', { class: 'wb-upgrade__title', text: pastDue ? "The Operator payment failed and today's free review is used." : "Today's free review is used." }),
    el('p', { class: 'wb-upgrade__text' }, opens),
    el('div', { class: 'wb-actions' },
      pastDue
        ? button({ label: 'Update the card', variant: 'primary', id: 'wb-upgrade-go', onClick: openAccount })
        : button({ label: `Get Operator. ${PRICE}`, variant: 'primary', id: 'wb-upgrade-go', iconEnd: 'arrow-right', onClick: upgrade }),
      button({ label: 'Use my chat subscription, free', id: 'wb-upgrade-export', onClick: () => setVia('export', { focus: true }) })),
  );
  panel.hidden = false;
  if (actions) actions.hidden = true;
}

function hideUpgrade() {
  stopCountdown();
  const panel = qs('#wb-upgrade');
  const actions = qs('#wb-run-actions');
  if (panel) {
    panel.hidden = true;
    clear(panel);
  }
  if (actions) actions.hidden = false;
}

function paintQuota() {
  const current = currentAccount();
  const line = quotaLine(current);
  const target = qs('#wb-quota');
  if (target) target.textContent = line.text;

  // A `daily_used` answer is newer than the cached account until the account reloads.
  const stillForced = forcedReset && timeUntil(forcedReset) > 0 && planOf(current) !== 'operator';
  if (line.used || stillForced) showUpgrade(current.usage?.resetsAt ?? forcedReset, line.pastDue);
  else hideUpgrade();
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** @type {AbortController | null} */
let controller = null;

function liveState(status, what) {
  const box = qs('#wb-live');
  if (!box) return;
  box.hidden = false;
  const chip = box.querySelector('.chip');
  if (chip) {
    chip.dataset.status = status;
    chip.textContent = { running: 'Running', failed: 'Failed', done: 'Done', queued: 'Stopped' }[status] ?? status;
  }
  const label = qs('#wb-live-what');
  if (label) label.textContent = what;
  const cancel = qs('#wb-cancel');
  if (cancel) cancel.hidden = status !== 'running';
}

function hideLive() {
  const box = qs('#wb-live');
  if (box) box.hidden = true;
}

function renderWarnAsk(findings) {
  const target = qs('#wb-run-warn');
  if (!target) return;
  const list = el('ul', { class: 'wb-flags' }, (findings ?? []).slice(0, 12).map((finding) => {
    const [where, ...kind] = describeFinding(finding).split(' · ');
    return el('li', { class: 'wb-flag' }, el('span', { class: 'wb-flag__where mono', text: where }), el('span', { class: 'wb-flag__kind', text: kind.join(' · ') }));
  }));
  const body = el('div', { class: 'stack stack--12' }, list, el('div', {}, button({
    label: 'These are fine, send',
    id: 'wb-run-ack',
    size: 'sm',
    onClick: () => {
      clear(target);
      runReview({ acknowledge: true });
    },
  })));
  clear(target).append(notice('warn', 'Lines with an email or a public IP address', body));
  qs('#wb-run-ack')?.focus();
}

async function keepPartial(text, request) {
  const state = workbench.get();
  const profile = reviewProfile(state.profile);
  workbench.set({
    result: {
      review: text,
      manifest: await manifestFor(state.files),
      profile: { id: profile.id, name: profile.name },
      mode: profile.mode === 'either' ? state.mode : profile.mode,
      provider: request.provider,
      model: request.model,
      truncated: true,
      refused: false,
      usage: { input: null, output: null },
      source: 'ai',
      timestamp: new Date().toISOString(),
    },
  });
  setStep('results');
}

async function handleFailure(error, request, options) {
  const failure = failureFor(error, request.via);

  if (failure.signin && !options.retried) {
    if (await ensureSignedIn()) {
      await runReview({ ...options, retried: true });
      return;
    }
  }
  if (failure.block) {
    reportInputError(Object.assign(new Error(failure.message), { code: 'privacy_block' }));
    return;
  }
  if (failure.warn) {
    say(failure.message, { tone: 'warn' });
    renderWarnAsk(error.data?.findings);
    return;
  }
  if (failure.operatorOnly) {
    // Today's review is untouched: the daily panel stays as it is and the line offers the plan.
    say(failure.message, { tone: 'warn', hold: true, action: { label: `Get Operator. ${PRICE}`, onClick: upgrade } });
    return;
  }
  if (failure.upgrade) {
    forcedReset = typeof error.data?.resetsAt === 'string' ? error.data.resetsAt : '';
    paintQuota();
    say(failure.message, { tone: 'warn' });
    qs('#wb-upgrade-go')?.focus();
    return;
  }
  if (failure.field) {
    say(failure.message, { error: true });
    markInvalid(failure.field, failure.message);
    return;
  }
  if (failure.blocked) {
    // The notice sits under the Run button, beside the model choice it asks the user to change.
    const target = qs('#wb-run-warn');
    const block = blockedNotice(error);
    if (target && block) clear(target).append(block);
    say(failure.message, { tone: 'warn', hold: true });
    return;
  }

  const actions = [];
  if (failure.partial) actions.push({ label: 'Open what arrived', onClick: () => keepPartial(failure.partial, request) });
  else if (failure.exportHint) actions.push({ label: 'Use my chat subscription', onClick: () => setVia('export', { focus: true }) });
  say(failure.message, { tone: failure.tone, error: failure.tone === 'error', action: actions[0], hold: true });
}

/**
 * Runs the review on the user's provider through the Worker.
 *
 * Order: files, key shape, privacy, sign-in, allowance, then the upload. A
 * missing key is asked for before an account is, and nothing is uploaded when
 * today's free review is already used.
 *
 * @param {{ acknowledge?: boolean, retried?: boolean }} [options]
 */
export async function runReview(options = {}) {
  const state = workbench.get();
  if (state.busy) return;
  const runButton = qs('#wb-run');
  const warnBox = qs('#wb-run-warn');
  if (warnBox) clear(warnBox);

  if (!state.files.length) {
    say('Add at least one file first.', { error: true });
    setStep('files');
    return;
  }
  // A profile the workbench does not list runs only as a step of the gauntlet
  // or of a panel review. A single run of one is never sent from here.
  if (!listedProfile(state.profile)) {
    workbench.set({ profile: 'general', mode: state.mode });
    say('That profile runs only inside the gauntlet or a panel review. The profile is back on Code security review: pick the one you want on the Load step.', { tone: 'warn', hold: true });
    setStep('files');
    return;
  }
  if (!checkCredentials()) return;
  const request = credentials();

  const { coverage, error: inputError } = scan(state);
  if (inputError) {
    reportInputError(inputError);
    return;
  }
  if (coverage.blocking > 0) {
    reportInputError(Object.assign(new Error('Secrets found.'), { code: 'privacy_block' }));
    return;
  }
  const accepted = options.acknowledge === true || warningsAccepted(coverage);
  if (coverage.warnings > 0 && !accepted) {
    reportInputError(Object.assign(new Error('Flagged lines.'), { code: 'privacy_warn' }));
    return;
  }

  if (!(await ensureSignedIn())) {
    say('Sign in to run a review on your API key. Copy-paste reviews in your chat app need no account.', {
      tone: 'warn',
      hold: true,
      action: { label: 'Use my chat subscription', onClick: () => setVia('export', { focus: true }) },
    });
    return;
  }
  // A sign-in a moment ago is still reloading the account: wait for its allowance.
  const signedIn = await account().catch(() => currentAccount());
  if (quotaLine(signedIn).used) {
    paintQuota();
    say("Today's free review is used.", { tone: 'warn' });
    qs('#wb-upgrade-go')?.focus();
    return;
  }

  // The run starts here.
  controller = new AbortController();
  workbench.set({ busy: true });
  setBusy(runButton, true, 'Running');
  const text = document.createTextNode('');
  const live = qs('#wb-live-text');
  if (live) clear(live).append(text);
  liveState('running', `${request.model} · waiting for the first token`);
  say('Review running.', { hold: true });
  const clock = qs('#wb-elapsed');
  const stopClock = startTimer((elapsed) => {
    if (clock) clock.textContent = formatElapsed(elapsed);
  });

  let failure = null;
  let result = null;
  let started = false;
  try {
    result = await streamReview({
      files: state.files,
      prompt: state.focus,
      profile: state.profile,
      provider: request.provider,
      model: request.model,
      apiKey: request.apiKey,
      context: state.context,
      mode: state.mode,
      // Also true after the server asked: its scan can flag a line the local one let through.
      acknowledgeWarnings: options.acknowledge === true || (coverage.warnings > 0 && accepted),
    }, {
      signal: controller.signal,
      onDelta: (delta) => {
        if (!started) {
          started = true;
          liveState('running', request.model);
        }
        const follow = live ? live.scrollHeight - live.scrollTop - live.clientHeight < 48 : false;
        text.appendData(delta);
        if (live && follow) live.scrollTop = live.scrollHeight;
      },
    });
  } catch (error) {
    failure = error;
  }

  const elapsed = stopClock();
  controller = null;
  setBusy(runButton, false);
  workbench.set({ busy: false });

  if (failure) {
    liveState(failure.code === 'aborted' ? 'queued' : 'failed', failure.code === 'aborted' ? 'Stopped' : 'Did not finish');
    if (!text.data) hideLive();
    await handleFailure(failure, request, options);
    return;
  }

  hideLive();
  clearInvalid();
  workbench.set({
    result: { ...result, provider: request.provider, source: 'ai', timestamp: new Date().toISOString() },
  });
  setStep('results');
  const line = finishedLine(result, elapsed);
  say(line.message, { tone: line.tone, hold: line.hold });
}

/** Wires the Run row. Call after initProviders(). */
export function initRun() {
  const runButton = qs('#wb-run');
  if (!runButton) return;

  on(runButton, 'click', () => runReview());
  on(qs('#wb-cancel'), 'click', () => controller?.abort());
  on(qs('#wb-key'), 'keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runReview();
    }
  });

  subscribeAccount(paintQuota, { immediate: true });
  view.select((state) => state.via, paintQuota);
  qs('#workspace')?.addEventListener('wb:step', () => {
    const warn = qs('#wb-run-warn');
    if (warn) clear(warn);
    if (!workbench.get().busy) hideLive();
  });
  // Leaving the page with a review running loses it: ask first.
  window.addEventListener('beforeunload', (event) => {
    if (workbench.get().busy) event.preventDefault();
  });
}
