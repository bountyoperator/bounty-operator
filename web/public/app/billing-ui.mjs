/**
 * The Operator plan in the browser: what it includes, the trip to Stripe and
 * back, and the messages for each billing answer.
 *
 * Imports ./api.mjs, ./events.mjs and ./ui.mjs. Nothing here opens a dialog:
 * account.mjs decides who is signed in and portal.mjs shows the Billing tab.
 *
 * Exports
 *   Plan
 *     PRICE_LINE                       'US$10 a week'
 *     OPERATOR_ACTIVE                  the sentence shown once Operator is on (also split as _TITLE and _BODY)
 *     PLAN_ROWS                        Free against Operator, row by row (SPEC section 2)
 *     planLabel(account?)              -> 'Signed out' | 'Free' | 'Operator' | 'Past due'
 *     planChip(account?)               -> <span class="chip …">
 *     planTable()                      -> <table> of PLAN_ROWS
 *   Stripe, out
 *     goToCheckout()                   -> Promise<void>   saves the workbench, then leaves for Stripe Checkout
 *     goToBillingPortal()              -> Promise<void>   the same for the Stripe customer portal
 *     beforeLeaving(fn)                -> unregister()    run `fn` before either redirect
 *   Stripe, back
 *     readCheckoutReturn(search?)      -> { state: 'complete' | 'cancelled', sessionId } | null
 *     confirmCheckout({ sessionId, attempts, delayMs }?) -> Promise<{ active, attempts, error }>
 *     rememberPlace() / takePlace()    where the visitor was when they left
 *   Messages
 *     billingMessage(error)            -> { tone, title, body, action }
 *     showBanner({ tone, title, body, actions, busy, dismissible }) -> element
 *     hideBanner()
 *     showCheckoutNote(text)           -> element | null   the quiet line in the pricing section
 *
 * Billing answers (web/src/billing.ts) and what the user is offered
 *   billing_exists        the account already has a subscription  -> Manage subscription
 *   billing_none          nothing to manage yet                   -> Get Operator
 *   billing_unavailable   subscriptions are closed, or Stripe did not answer -> try again
 *   billing_busy          a checkout is already being opened      -> try again
 *   rate_limited          too many billing calls                  -> wait
 */

import { ApiError, currentAccount, planOf, refreshAccount, request } from './api.mjs';
import { button, el, formatCountdown, icon } from './ui.mjs';

export const PRICE_LINE = 'US$10 a week';
export const OPERATOR_ACTIVE_TITLE = 'Operator is active.';
export const OPERATOR_ACTIVE_BODY = 'Unlimited reviews, gauntlet and panel are unlocked.';
export const OPERATOR_ACTIVE = `${OPERATOR_ACTIVE_TITLE} ${OPERATOR_ACTIVE_BODY}`;

/** SPEC section 2, in the order a buyer reads it. `free` and `operator` are the cell texts. */
export const PLAN_ROWS = Object.freeze([
  { feature: 'Reviews on your API key', free: '1 a day (resets 00:00 UTC)', operator: 'Unlimited' },
  { feature: 'Gauntlet', detail: 'Eight stages, from scope to a verdict dossier.', free: 'Example', operator: 'Included' },
  { feature: 'Panel review', detail: 'Two to four models in parallel, then a cross-examination.', free: 'Example', operator: 'Included' },
  { feature: 'Reviews at once', free: '1', operator: '4' },
  { feature: 'All 11 review types', free: 'Included', operator: 'Included' },
  { feature: 'Copy-paste reviews in your chat app, free tools, repo import', free: 'Included', operator: 'Included' },
]);

const CHECKOUT_PATH = '/api/billing/checkout';
const PORTAL_PATH = '/api/billing/portal';
const RECONCILE_PATH = '/api/billing/reconcile';
const CHECKOUT_SESSION = /^cs_live_[A-Za-z0-9]{1,200}$/;
const RECONCILE_ATTEMPTS = 5;
const RECONCILE_DELAY_MS = 2000;
const PLACE_KEY = 'bo:return';
const PLACE_MAX_AGE_MS = 2 * 3600 * 1000;
const BANNER_ID = 'checkout-banner';
const NOTE_ID = 'checkout-note';

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const PLAN_LABELS = { anon: 'Signed out', free: 'Free', operator: 'Operator', past_due: 'Past due' };

/**
 * @param {import('./api.mjs').Account} [value]
 * @returns {string}
 */
export function planLabel(value = currentAccount()) {
  return PLAN_LABELS[planOf(value)];
}

/**
 * The plan as a chip: grey for Free, blue for Operator, red for a failed payment.
 *
 * @param {import('./api.mjs').Account} [value]
 * @returns {HTMLElement}
 */
export function planChip(value = currentAccount()) {
  const plan = planOf(value);
  if (plan === 'past_due') return el('span', { class: 'chip', dataset: { tone: 'danger', plan }, text: PLAN_LABELS.past_due });
  return el('span', { class: 'chip status', dataset: { status: plan === 'operator' ? 'operator' : 'free', plan }, text: PLAN_LABELS[plan] });
}

function planCell(text, plan) {
  const included = text === 'Included';
  return el(
    'td',
    { dataset: { plan, label: plan === 'free' ? 'Free' : 'Operator' } },
    included ? [icon('check'), el('span', { class: 'visually-hidden', text: 'Included' })] : text,
  );
}

/**
 * Free against Operator as a table.
 *
 * @returns {HTMLElement}
 */
export function planTable() {
  const head = el('tr', null, el('th', { scope: 'col', text: 'What you get' }), el('th', { scope: 'col', text: 'Free' }), el('th', { scope: 'col' }, 'Operator'));
  const rows = PLAN_ROWS.map((row) =>
    el(
      'tr',
      null,
      el('th', { scope: 'row' }, el('span', { class: 'plan-table__feature', text: row.feature }), row.detail ? el('span', { class: 'plan-table__detail', text: row.detail }) : null),
      planCell(row.free, 'free'),
      planCell(row.operator, 'operator'),
    ),
  );
  return el(
    'table',
    { class: 'plan-table' },
    el('caption', { class: 'visually-hidden', text: 'Free and Operator compared' }),
    el('thead', null, head),
    el('tbody', null, rows),
  );
}

// ---------------------------------------------------------------------------
// Leaving for Stripe
// ---------------------------------------------------------------------------

/** @type {Set<() => unknown>} */
const leaveHooks = new Set();

/**
 * Registers a function to run just before the page leaves for Stripe. Use it
 * to store anything the workbench snapshot does not cover.
 *
 * @param {() => unknown} fn
 * @returns {() => void} unregister
 */
export function beforeLeaving(fn) {
  leaveHooks.add(fn);
  return () => leaveHooks.delete(fn);
}

function report(error) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
  else console.error(error);
}

/** Stores the workbench for this tab, so the files and the form are there on the way back. */
async function persistWork() {
  for (const hook of [...leaveHooks]) {
    try {
      await hook();
    } catch (error) {
      report(error);
    }
  }
  // Only a page that shows the workbench holds its state. Anywhere else the
  // store is empty and saving it would overwrite what the tab has stored.
  if (typeof document === 'undefined' || !document.getElementById('workspace')) return;
  try {
    const state = await import('./state.mjs');
    state.saveWorkbench();
  } catch (error) {
    report(error);
  }
}

function sessionStore() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Notes the page, the anchor and the scroll position, so the return can put the visitor back. */
export function rememberPlace() {
  const place = {
    path: globalThis.location?.pathname ?? '/',
    hash: globalThis.location?.hash ?? '',
    y: Math.max(0, Math.round(globalThis.scrollY ?? 0)),
    at: Date.now(),
  };
  try {
    sessionStore()?.setItem(PLACE_KEY, JSON.stringify(place));
  } catch {
    // Storage is blocked or full: the visitor lands at the top of the page.
  }
  return place;
}

/**
 * Reads the stored place once and removes it. Null when there is none or it
 * is older than two hours.
 *
 * @returns {{ path: string, hash: string, y: number, at: number } | null}
 */
export function takePlace() {
  let place = null;
  try {
    const store = sessionStore();
    const raw = store?.getItem(PLACE_KEY);
    store?.removeItem(PLACE_KEY);
    place = raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  const valid =
    place &&
    typeof place === 'object' &&
    typeof place.path === 'string' &&
    place.path.startsWith('/') &&
    typeof place.hash === 'string' &&
    /^(#[\w-]{1,80})?$/.test(place.hash) &&
    Number.isFinite(place.y) &&
    Number.isFinite(place.at) &&
    Date.now() - place.at < PLACE_MAX_AGE_MS;
  return valid ? { path: place.path, hash: place.hash, y: Math.max(0, place.y), at: place.at } : null;
}

function stripeUrl(value) {
  let url = null;
  try {
    url = new URL(String(value));
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:') {
    throw new ApiError('Stripe did not return a page to open. Try again.', { code: 'bad_response' });
  }
  return url.href;
}

async function leaveFor(path) {
  const answer = await request(path, { body: {} });
  const url = stripeUrl(answer?.url);
  await persistWork();
  rememberPlace();
  globalThis.location.assign(url);
}

/**
 * Opens Stripe Checkout for the Operator plan. The caller makes sure the user
 * is signed in. Throws an ApiError the Billing tab can show; see billingMessage().
 *
 * @returns {Promise<void>}
 */
export function goToCheckout() {
  return leaveFor(CHECKOUT_PATH);
}

/**
 * Opens the Stripe customer portal: card, invoices, cancel.
 *
 * @returns {Promise<void>}
 */
export function goToBillingPortal() {
  return leaveFor(PORTAL_PATH);
}

// ---------------------------------------------------------------------------
// Coming back from Stripe
// ---------------------------------------------------------------------------

/**
 * What the query string says about a Stripe round trip.
 *
 * @param {string} [search]  Defaults to location.search.
 * @returns {{ state: 'complete' | 'cancelled', sessionId: string } | null}  `sessionId` is '' unless it has the shape of a live Checkout session.
 */
export function readCheckoutReturn(search = globalThis.location?.search ?? '') {
  const params = new URLSearchParams(search);
  const state = params.get('checkout');
  if (state !== 'complete' && state !== 'cancelled') return null;
  const sessionId = params.get('session_id') ?? '';
  return { state, sessionId: CHECKOUT_SESSION.test(sessionId) ? sessionId : '' };
}

/** Takes `checkout` and `session_id` out of the address bar, so a reload does not repeat the return. */
export function cleanReturnUrl() {
  const { location, history } = globalThis;
  if (!location || !history || typeof history.replaceState !== 'function') return;
  const params = new URLSearchParams(location.search);
  params.delete('checkout');
  params.delete('session_id');
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Worth another try a moment later. Anything else is a decision, not a delay.
const RETRYABLE = new Set(['network', 'unavailable', 'internal', 'billing_unavailable', 'billing_busy']);

/**
 * Asks the Worker whether the subscription is active, up to `attempts` times,
 * `delayMs` apart. With a session id it calls POST /api/billing/reconcile,
 * which reads the Checkout session from Stripe without waiting for the
 * webhook; without one it reloads the account.
 *
 * @param {{ sessionId?: string, attempts?: number, delayMs?: number, send?: typeof request, reload?: typeof refreshAccount, wait?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<{ active: boolean, attempts: number, error: ApiError | null }>}
 */
export async function confirmCheckout({
  sessionId = '',
  attempts = RECONCILE_ATTEMPTS,
  delayMs = RECONCILE_DELAY_MS,
  send = request,
  reload = refreshAccount,
  wait = sleep,
} = {}) {
  let error = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await wait(delayMs);
    try {
      if (sessionId) {
        const answer = await send(RECONCILE_PATH, { body: { sessionId } });
        if (answer?.usage?.plan === 'weekly') return { active: true, attempts: attempt, error: null };
      } else if (planOf(await reload()) === 'operator') {
        return { active: true, attempts: attempt, error: null };
      }
      error = null;
    } catch (failure) {
      error = failure instanceof ApiError ? failure : new ApiError('The payment could not be confirmed. Try again.', { code: 'bad_response' });
      if (!RETRYABLE.has(error.code)) return { active: false, attempts: attempt, error };
    }
  }
  return { active: false, attempts, error };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function waitText(error) {
  const seconds = Number(error?.data?.retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? `Try again in ${formatCountdown(seconds * 1000)}.` : 'Try again in a minute.';
}

/**
 * What to tell the user about a billing error, and the one action to offer.
 *
 * @param {ApiError} error
 * @returns {{ tone: 'info' | 'warn' | 'error', title: string, body: string, action: 'manage' | 'checkout' | 'signin' | null }}
 */
export function billingMessage(error) {
  const text = error instanceof Error && error.message ? error.message : 'Billing did not answer. Try again in a minute.';
  switch (error?.code) {
    case 'billing_exists':
      return {
        tone: 'info',
        title: 'This account already has a subscription.',
        body: 'Card, invoices and cancellation are in Stripe.',
        action: 'manage',
      };
    case 'billing_none':
      return { tone: 'info', title: 'This account has no subscription yet.', body: `Operator is ${PRICE_LINE}.`, action: 'checkout' };
    case 'billing_unavailable':
      return { tone: 'warn', title: text, body: '', action: null };
    case 'billing_busy':
      return { tone: 'warn', title: text, body: '', action: null };
    case 'rate_limited':
      return { tone: 'warn', title: 'Too many billing requests from this account.', body: waitText(error), action: null };
    case 'signin':
      return { tone: 'info', title: 'Sign in to continue.', body: '', action: 'signin' };
    default:
      return { tone: 'error', title: text, body: '', action: null };
  }
}

const BANNER_ICONS = { info: 'info', success: 'ok', warn: 'warn', error: 'error' };

/**
 * Shows the bar at the top of the page: the payment result after Checkout.
 * Calling it again replaces what the bar says. It stays in view while the
 * page scrolls, so it is seen wherever the visitor is put back.
 *
 * @param {{ tone?: 'info' | 'success' | 'warn' | 'error', title: string, body?: string, actions?: Node[], busy?: boolean, dismissible?: boolean }} options
 * @returns {HTMLElement}
 */
export function showBanner({ tone = 'info', title, body = '', actions = [], busy = false, dismissible = true } = {}) {
  const kind = Object.hasOwn(BANNER_ICONS, tone) ? tone : 'info';
  let banner = document.getElementById(BANNER_ID);
  if (!banner) {
    banner = el('div', { id: BANNER_ID, class: 'account-banner' });
    const header = document.querySelector('.site-header');
    if (header) header.before(banner);
    else document.body.prepend(banner);
  }
  banner.dataset.tone = kind;
  banner.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  banner.toggleAttribute('aria-busy', busy);

  const close = dismissible
    ? button({ label: 'Dismiss', variant: 'quiet', size: 'sm', icon: 'x', iconOnly: true, className: 'account-banner__close', onClick: hideBanner })
    : null;
  banner.replaceChildren(
    el(
      'div',
      { class: 'wrap account-banner__inner' },
      busy ? el('span', { class: 'account-banner__spinner', 'aria-hidden': 'true' }) : icon(BANNER_ICONS[kind]),
      el('p', { class: 'account-banner__text' }, el('strong', { text: title }), body ? ` ${body}` : null),
      actions.length ? el('div', { class: 'account-banner__actions' }, actions) : null,
      close,
    ),
  );
  return banner;
}

export function hideBanner() {
  document.getElementById(BANNER_ID)?.remove();
}

/**
 * Puts a quiet line in the pricing section. The section is the element marked
 * [data-checkout-note], else #pricing. Returns null when the page has neither.
 *
 * @param {string} text
 * @returns {HTMLElement | null}
 */
export function showCheckoutNote(text) {
  document.getElementById(NOTE_ID)?.remove();
  const slot = document.querySelector('[data-checkout-note]');
  const section = slot ?? document.getElementById('pricing');
  if (!section) return null;
  const note = el('p', { id: NOTE_ID, class: 'account-note', role: 'status' }, icon('info'), el('span', { text }));
  const heading = slot ? null : section.querySelector('.section-head, h1, h2');
  if (slot) slot.append(note);
  else if (heading) heading.after(note);
  else section.prepend(note);
  return note;
}
