/**
 * The account panel: sign-in, the signed-in sheet, checkout, and the header
 * control. This is the module other teams import.
 *
 *   import { requireSignIn, startCheckout, openAccount, onAccountChange } from './account.mjs';
 *
 *   if (!(await requireSignIn({ reason: 'review' }))) return;   // the visitor closed the dialog
 *   runTheReview();
 *
 * Exports
 *   openAccount({ tab }?)            -> Promise<void>      signed out: the sign-in dialog; signed in: the account sheet
 *   requireSignIn({ reason }?)       -> Promise<boolean>   true once the visitor is signed in (at once when they already are);
 *                                                          false when they close the dialog. After a new account it
 *                                                          resolves when the recovery code has been saved.
 *   onAccountChange(fn, { immediate }?) -> unsubscribe()   fn(account, previous) on every change of the account
 *   startCheckout()                  -> Promise<boolean>   sign-in if needed, save the workbench, go to Stripe Checkout.
 *                                                          false when nothing was opened; the reason is shown in Billing.
 *   openBillingPortal()              -> Promise<boolean>   the same for the Stripe customer portal
 *   initAccount()                    -> void               wires the page; runs by itself when the module loads in a browser
 *   REASONS                          the built-in reasons: 'review', 'operator', 'billing', 'account'
 *   reasonText(reason, returning)    -> string             the line the dialog shows for a reason
 *   headerControl(account)           -> { label, chip, tone, name }    what the header button says for an account
 *
 * `reason` is one of the REASONS keys, or your own sentence. It is the first
 * line of the dialog:
 *   'review'    "Create a free account to run this review. One passkey prompt, no email."
 *   'operator'  "Operator is US$10 a week. Account first, then Stripe."
 *
 * What the module wires without being asked
 *   #account-button                       the header control: "Sign in", or the plan chip and "Account"
 *   a[href="/#account"], a[href="#account"]   open the panel in place
 *   [data-account-action="open|signin|checkout|billing"]   buttons on any page; data-account-reason names the reason
 *   location.hash === '#account'          opens the panel on load
 *   ?checkout=complete                    confirms the payment (POST /api/billing/reconcile, up to five times),
 *                                         shows the bar at the top of the page and puts the visitor back where they were
 *   ?checkout=cancelled                   a quiet line in the pricing section
 *   the passkey re-check                  registered with api.mjs: a `reauth` answer opens "Confirm it's you"
 *
 * DOM ids
 *   #account-dialog  #account-dialog-title  #account-reason  #account-create  #account-signin
 *   #account-capability  #account-status  #account-recover  #account-recovery-input  #account-recover-submit
 *   #recovery-code  #recovery-copy  #recovery-download  #recovery-saved
 *   #reauth-dialog  #reauth-confirm  #reauth-cancel  #reauth-status
 *   #checkout-banner  #checkout-note
 *   The signed-in sheet's ids are listed in portal.mjs.
 *
 * Nothing sensitive is stored: localStorage["bo:known"] = "1" says only that
 * this browser has signed in before, and decides which button comes first.
 */

import { ApiError, account as loadAccount, currentAccount, planOf, request, setReauthHandler, subscribeAccount, track } from './api.mjs';
import {
  OPERATOR_ACTIVE,
  OPERATOR_ACTIVE_BODY,
  OPERATOR_ACTIVE_TITLE,
  cleanReturnUrl,
  confirmCheckout,
  goToBillingPortal,
  goToCheckout,
  readCheckoutReturn,
  showBanner,
  showCheckoutNote,
  takePlace,
} from './billing-ui.mjs';
import { EVENTS } from './events.mjs';
import { PASSKEY_PROVIDERS, isCancelled, passkeySupport, registerPasskey, signInWithPasskey } from './passkey.mjs';
import { clearStatus, closePortal, dialogShell, isPortalOpen, onPortalSignedOut, openPortal, portalPasskeyIds, recoveryPanel, setStatus } from './portal.mjs';
import { announce, button, dialogController, el, formatCountdown, icon, isBusy, on, setBusy } from './ui.mjs';

const KNOWN_KEY = 'bo:known';
const RECOVERY_CODE = /^[A-Za-z0-9_-]{43}$/;
const STYLESHEET = '/css/account.css';

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Why the dialog opened. `create` is the line for a new visitor, `signin` for
 * a browser that has signed in before, `next` what the last button does.
 */
export const REASONS = Object.freeze({
  review: {
    create: 'Create a free account to run this review. One passkey prompt, no email.',
    signin: 'Sign in to run this review. One passkey prompt.',
    next: 'run the review',
  },
  operator: {
    create: 'Operator is US$10 a week. Account first, then Stripe.',
    signin: 'Operator is US$10 a week. Sign in first, then Stripe.',
    next: 'continue to Stripe',
  },
  billing: {
    create: 'Sign in to manage billing. Stripe holds the card and the invoices.',
    signin: 'Sign in to manage billing. Stripe holds the card and the invoices.',
    next: 'open billing',
  },
  account: {
    create: 'A free account runs 1 review a day on your own key. One passkey prompt, no email.',
    signin: 'Sign in with the passkey on this device. No password, no email.',
    next: '',
  },
});

/**
 * The first line of the dialog.
 *
 * @param {string} [reason]  A REASONS key, or a sentence of your own.
 * @param {boolean} [returning]  This browser has signed in before.
 * @returns {string}
 */
export function reasonText(reason, returning = false) {
  if (typeof reason === 'string' && Object.hasOwn(REASONS, reason)) return REASONS[reason][returning ? 'signin' : 'create'];
  if (typeof reason === 'string' && reason.trim() !== '') return reason.trim();
  return REASONS.account[returning ? 'signin' : 'create'];
}

function nextStep(reason) {
  return typeof reason === 'string' && Object.hasOwn(REASONS, reason) ? REASONS[reason].next : '';
}

/**
 * What the header control shows for an account.
 *
 * @param {import('./api.mjs').Account} value
 * @returns {{ label: string, chip: string, tone: 'neutral' | 'operator' | 'danger', name: string }}  `name` is the accessible name.
 */
export function headerControl(value) {
  const plan = planOf(value);
  if (plan === 'anon') return { label: 'Sign in', chip: '', tone: 'neutral', name: 'Sign in' };
  if (plan === 'past_due') return { label: 'Account', chip: 'Past due', tone: 'danger', name: 'Account, payment failed' };
  if (plan === 'operator') return { label: 'Account', chip: 'Operator', tone: 'operator', name: 'Account, Operator plan' };
  return { label: 'Account', chip: 'Free', tone: 'neutral', name: 'Account, Free plan' };
}

// ---------------------------------------------------------------------------
// "Has this browser signed in before": one flag, nothing about the account
// ---------------------------------------------------------------------------

function isKnown() {
  try {
    return globalThis.localStorage?.getItem(KNOWN_KEY) === '1';
  } catch {
    return false;
  }
}

function markKnown() {
  try {
    globalThis.localStorage?.setItem(KNOWN_KEY, '1');
  } catch {
    // Storage is blocked: Create account stays the first button.
  }
}

// ---------------------------------------------------------------------------
// The sign-in dialog
// ---------------------------------------------------------------------------

/** @type {{ dialog: HTMLDialogElement, title: HTMLElement, close: HTMLElement, body: HTMLElement } | null} */
let signIn = null;
/** @type {ReturnType<typeof dialogController> | null} */
let signInController = null;
/** 'entry' while choosing how to sign in, 'code' while the recovery code is on screen. */
let view = 'entry';
let reason = 'account';
/** What happens after sign-in when nobody is waiting on requireSignIn(): 'portal' or ''. */
let after = '';
let afterTab = '';
/** @type {Promise<boolean> | null} */
let waiting = null;
/** @type {((signedIn: boolean) => void) | null} */
let settle = null;
let succeeded = false;
/** True while a passkey prompt or the recovery request is running. */
let pending = false;
let support = { webauthn: true, platform: true };
let supportChecked = false;

function statusNode() {
  return signIn?.body.querySelector('#account-status') ?? null;
}

/** The message for a failed sign-in step. `flow` is 'create', 'signin' or 'recover'. */
function signInFailure(error, flow) {
  if (!(error instanceof ApiError)) return { tone: 'error', title: 'That did not work. Try again.' };
  if (isCancelled(error)) return { tone: 'info', title: 'The passkey prompt was closed. Nothing changed.' };

  switch (error.code) {
    case 'rate_limited': {
      const seconds = Number(error.data?.retryAfter);
      return {
        tone: 'warn',
        title: 'Too many attempts from this network.',
        body: Number.isFinite(seconds) && seconds > 0 ? `Try again in ${formatCountdown(seconds * 1000)}.` : 'Try again in a few minutes.',
      };
    }
    case 'passkey':
      return flow === 'signin'
        ? { tone: 'warn', title: 'That passkey is not linked to an account here.', body: 'Pick another passkey, create an account, or use your recovery code.' }
        : { tone: 'error', title: 'The passkey could not be verified.', body: 'Try again. If it keeps failing, use a different passkey provider.' };
    case 'challenge_expired':
      return { tone: 'warn', title: 'The passkey request expired.', body: 'Press the button again. A prompt stays valid for five minutes.' };
    case 'recovery':
      return { tone: 'error', title: 'That recovery code was not accepted.', body: 'A code works once. Check for a missing character, or use the newest code you saved.' };
    case 'passkey_unsupported':
      return { tone: 'warn', title: error.message };
    case 'network':
      return { tone: 'error', title: error.message };
    default:
      return { tone: 'error', title: error.message };
  }
}

function showFailure(error, flow) {
  setStatus(statusNode(), signInFailure(error, flow));
}

function finish() {
  succeeded = true;
  signInController?.close('signed-in');
}

/**
 * A request is in flight: the dialog stays until it settles. An account
 * created behind a closed dialog would have a recovery code nobody saw.
 */
function setPending(value) {
  pending = value;
  if (signIn && view === 'entry') signIn.close.hidden = value;
}

function showCode(code, { recovered = false } = {}) {
  if (!signIn.dialog.open) {
    // Closed some other way while the request ran: the code is still shown.
    succeeded = false;
    waiting = new Promise((resolve) => {
      settle = resolve;
    });
    signInController.open();
  }
  view = 'code';
  const step = nextStep(reason);
  signIn.title.textContent = 'Save your recovery code';
  signIn.close.hidden = true;
  signIn.body.replaceChildren(
    recoveryPanel({
      code,
      intro: recovered
        ? 'You are signed in. The code you used is spent. This is the new one. Add a passkey for this device under Account, Security.'
        : 'Your account is ready. This code signs you in if the passkey is ever lost.',
      savedLabel: step ? `I saved it, ${step}` : 'I saved it',
      onSaved: finish,
    }),
  );
  signIn.body.querySelector('#recovery-copy')?.focus();
}

async function runPasskey(control, flow) {
  if (isBusy(control)) return;
  const other = signIn.body.querySelector(flow === 'create' ? '#account-signin' : '#account-create');
  setBusy(control, true, 'Waiting for your passkey');
  other?.setAttribute('aria-disabled', 'true');
  setPending(true);
  setStatus(statusNode(), { tone: 'info', title: 'Follow the passkey prompt from your browser or device.' });
  try {
    if (flow === 'create') {
      const created = await registerPasskey();
      markKnown();
      showCode(created.recoveryCode);
      return;
    }
    await signInWithPasskey();
    markKnown();
    finish();
  } catch (error) {
    showFailure(error, flow);
  } finally {
    setBusy(control, false);
    other?.removeAttribute('aria-disabled');
    setPending(false);
  }
}

async function runRecovery(control, input) {
  if (isBusy(control)) return;
  const code = input.value.trim();
  if (!RECOVERY_CODE.test(code)) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    setStatus(statusNode(), { tone: 'warn', title: 'A recovery code is 43 characters: letters, digits, - and _.', body: `This one has ${code.length}.` });
    return;
  }
  setBusy(control, true, 'Checking');
  setPending(true);
  clearStatus(statusNode());
  try {
    const recovered = await request('/api/auth/recover', { body: { code } });
    markKnown();
    // No passkey on this device yet: the sheet opens on Security, where one is added.
    if (after === 'portal') afterTab = 'security';
    showCode(recovered.recoveryCode, { recovered: true });
  } catch (error) {
    showFailure(error, 'recover');
  } finally {
    setBusy(control, false);
    setPending(false);
  }
}

function capabilityNotice() {
  const node = el('div', { class: 'notice', id: 'account-capability' });
  if (!support.webauthn) {
    setStatus(node, {
      tone: 'warn',
      title: 'This browser cannot use passkeys.',
      body: `Open the site in a current Chrome, Edge, Safari or Firefox. A passkey comes from ${PASSKEY_PROVIDERS}.`,
    });
  } else if (!support.platform) {
    setStatus(node, {
      tone: 'info',
      title: 'No passkey provider is set up on this device.',
      body: 'Turn on Windows Hello or Touch ID, or use iCloud Keychain, Google Password Manager, 1Password, Bitwarden or a security key with a PIN.',
    });
  }
  return node;
}

function renderEntry() {
  view = 'entry';
  const returning = isKnown();
  signIn.title.textContent = returning ? 'Sign in' : 'Create your account';
  signIn.close.hidden = false;

  const blocked = !support.webauthn;
  const create = button({
    label: 'Create account',
    variant: returning ? 'secondary' : 'primary',
    size: returning ? 'md' : 'lg',
    block: true,
    icon: 'key',
    id: 'account-create',
    attrs: blocked ? { 'aria-disabled': 'true', 'aria-describedby': 'account-capability' } : {},
    onClick: (event) => {
      if (!blocked) runPasskey(event.currentTarget, 'create');
    },
  });
  const enter = button({
    label: returning ? 'Sign in with a passkey' : 'I have an account. Sign in',
    variant: returning ? 'primary' : 'secondary',
    size: returning ? 'lg' : 'md',
    block: true,
    icon: returning ? 'key' : undefined,
    id: 'account-signin',
    attrs: blocked ? { 'aria-disabled': 'true', 'aria-describedby': 'account-capability' } : {},
    onClick: (event) => {
      if (!blocked) runPasskey(event.currentTarget, 'signin');
    },
  });

  const input = el('input', {
    class: 'input mono',
    id: 'account-recovery-input',
    type: 'text',
    name: 'recovery-code',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    maxlength: '80',
    'aria-describedby': 'account-recovery-help',
    onInput: (event) => event.currentTarget.removeAttribute('aria-invalid'),
  });
  const submit = button({ label: 'Sign in with the code', type: 'submit', block: true, id: 'account-recover-submit' });
  const recover = el(
    'details',
    { class: 'disclosure account__recover', id: 'account-recover' },
    el('summary', { class: 'disclosure__summary' }, 'Use a recovery code', el('span', { class: 'disclosure__hint', text: 'No passkey at hand' })),
    el(
      'form',
      {
        class: 'disclosure__body account__recover-form',
        novalidate: true,
        onSubmit: (event) => {
          event.preventDefault();
          runRecovery(submit, input);
        },
      },
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'label', for: 'account-recovery-input', text: 'Recovery code' }),
        input,
        el('p', { class: 'help', id: 'account-recovery-help', text: 'The 43 characters saved when the account was created. It works once: a new code is shown after sign-in.' }),
      ),
      submit,
    ),
  );

  // With no passkey support the code is the one way in: show it open.
  recover.open = blocked;

  // When the device has no passkey provider the capability notice names what works instead.
  const fine =
    support.webauthn && support.platform
      ? el('p', { class: 'account__fine' }, icon('lock'), el('span', { text: `Your device PIN, fingerprint or face. Works with ${PASSKEY_PROVIDERS}.` }))
      : null;
  signIn.body.replaceChildren(
    ...[
      el('p', { class: 'account__reason', id: 'account-reason', text: reasonText(reason, returning) }),
      el('div', { class: 'account__actions' }, returning ? [enter, create] : [create, enter]),
      fine,
      capabilityNotice(),
      el('div', { class: 'notice', id: 'account-status', role: 'status' }),
      recover,
    ].filter(Boolean),
  );
}

function buildSignIn() {
  if (signIn) return;
  const shell = dialogShell('account-dialog', { className: 'dialog dialog--sm account-dialog', title: 'Sign in' });
  shell.dialog.classList.add('dialog', 'dialog--sm', 'account-dialog');
  const body = el('div', { class: 'dialog__body account__body' });
  shell.dialog.append(body);
  signIn = { dialog: shell.dialog, title: shell.title, close: shell.close, body };

  signInController = dialogController(shell.dialog, {
    // A recovery code that was never saved is an account that cannot be recovered.
    canDismiss: () => view !== 'code' && !pending,
    onClose: () => {
      const signedIn = succeeded;
      const then = after;
      const tab = afterTab;
      const done = settle;
      settle = null;
      waiting = null;
      succeeded = false;
      pending = false;
      after = '';
      afterTab = '';
      view = 'entry';
      signIn.body.replaceChildren();
      if (done) done(signedIn);
      if (signedIn && then === 'portal') {
        const message = tab === 'security' ? { title: 'Add a passkey for this device.', body: 'The recovery code let you in once. A passkey signs you in next time.' } : undefined;
        openPortal({ tab: tab || 'overview', message });
      }
    },
  });
}

/** Opens the dialog and returns the promise requireSignIn() hands out. */
function openSignIn(nextReason, { then = '', tab = '' } = {}) {
  buildSignIn();
  if (waiting && signIn.dialog.open) {
    // Already open: a second caller waits on the same outcome.
    return waiting;
  }
  reason = nextReason ?? 'account';
  after = then;
  afterTab = tab;
  succeeded = false;
  waiting = new Promise((resolve) => {
    settle = resolve;
  });
  renderEntry();
  signInController.open();
  track(EVENTS.SIGNIN_OPENED);

  if (!supportChecked) {
    passkeySupport().then((result) => {
      supportChecked = true;
      support = result;
      // Only the notice and the disabled state depend on it: redraw when the entry view is still up and idle.
      if (signIn.dialog.open && view === 'entry' && !signIn.body.querySelector('[aria-busy="true"]') && (!result.webauthn || !result.platform)) {
        const open = signIn.body.querySelector('#account-recover')?.open;
        const hadFocus = signIn.body.contains(document.activeElement);
        renderEntry();
        if (open) signIn.body.querySelector('#account-recover').open = true;
        // The redraw replaced the button that had focus: put it back on the first one.
        if (hadFocus) signIn.body.querySelector('.account__actions .btn')?.focus();
      }
    });
  }
  return waiting;
}

// ---------------------------------------------------------------------------
// "Confirm it's you"
// ---------------------------------------------------------------------------

let reauth = null;
let reauthController = null;

function buildReauth() {
  if (reauth) return;
  const shell = dialogShell('reauth-dialog', { className: 'dialog dialog--sm reauth-dialog', title: "Confirm it's you" });
  shell.dialog.classList.add('dialog', 'dialog--sm', 'reauth-dialog');
  const status = el('div', { class: 'notice', id: 'reauth-status', role: 'status' });
  const confirm = button({ label: 'Confirm with passkey', variant: 'primary', icon: 'key', id: 'reauth-confirm' });
  const cancel = button({ label: 'Cancel', variant: 'quiet', id: 'reauth-cancel' });
  shell.dialog.append(
    el(
      'div',
      { class: 'dialog__body' },
      el('p', { class: 'reauth__text', text: 'This change needs a passkey check from the last ten minutes. One prompt, then it continues.' }),
      status,
      el('div', { class: 'reauth__actions' }, confirm, cancel),
    ),
  );
  reauth = { dialog: shell.dialog, status, confirm, cancel };
  reauthController = dialogController(shell.dialog, { initialFocus: () => confirm });
}

/**
 * The handler api.mjs calls when the Worker answers `reauth`. Resolves true
 * once the passkey check passed, false when the user backed out.
 */
function confirmIdentity() {
  buildReauth();
  clearStatus(reauth.status);
  let confirmed = false;

  const offs = [
    on(reauth.confirm, 'click', async () => {
      if (isBusy(reauth.confirm)) return;
      const before = currentAccount().csrf;
      setBusy(reauth.confirm, true, 'Waiting for your passkey');
      clearStatus(reauth.status);
      try {
        const answer = await signInWithPasskey({ allow: portalPasskeyIds() });
        if (before && answer?.csrf && answer.csrf !== before) {
          // The passkey belongs to another account, and the Worker signed that one in.
          setStatus(reauth.status, { tone: 'warn', title: 'That passkey belongs to a different account.', body: 'You are now signed in to it. The change was not made.' });
          return;
        }
        confirmed = true;
        reauthController.close('confirmed');
      } catch (error) {
        setStatus(reauth.status, signInFailure(error, 'signin'));
      } finally {
        setBusy(reauth.confirm, false);
      }
    }),
    on(reauth.cancel, 'click', () => reauthController.close()),
  ];

  return reauthController.open().then(() => {
    for (const off of offs) off();
    return confirmed;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function loaded() {
  try {
    return await loadAccount();
  } catch {
    return currentAccount();
  }
}

/**
 * Makes sure the visitor is signed in, opening the dialog when they are not.
 *
 * @param {{ reason?: string }} [options]  A REASONS key ('review', 'operator', 'billing', 'account') or your own sentence.
 * @returns {Promise<boolean>} true when signed in; false when the dialog was closed.
 */
export async function requireSignIn({ reason: why } = {}) {
  const current = await loaded();
  if (current.signedIn) return true;
  if (typeof document === 'undefined') return false;
  return openSignIn(why ?? 'account');
}

/**
 * Opens the account panel: the sign-in dialog for a signed-out visitor (the
 * sheet follows once they are in), the sheet for a signed-in one.
 *
 * @param {{ tab?: 'overview' | 'reviews' | 'connections' | 'security' | 'billing' }} [options]
 * @returns {Promise<void>}
 */
export async function openAccount({ tab } = {}) {
  const current = await loaded();
  if (current.signedIn) {
    // The header control always lands on Overview: the plan and today's usage.
    if (!isPortalOpen() || tab) openPortal({ tab: tab ?? 'overview' });
    return;
  }
  openSignIn('account', { then: 'portal', tab: tab ?? '' });
}

/**
 * Subscribes to the account. `fn(account, previous)` runs on every change:
 * sign-in, sign-out, a finished review, an upgrade.
 *
 * @param {(account: import('./api.mjs').Account, previous: import('./api.mjs').Account) => void} fn
 * @param {{ immediate?: boolean }} [options]  Also call `fn` now with the current account.
 * @returns {() => void} unsubscribe
 */
export function onAccountChange(fn, options) {
  return subscribeAccount(fn, options);
}

/**
 * Starts Operator checkout: signs the visitor in when needed, stores the
 * workbench for the tab, and leaves for Stripe. When checkout cannot open,
 * the Billing section says why and offers the next step.
 *
 * @returns {Promise<boolean>} true when the page is leaving for Stripe.
 */
export async function startCheckout() {
  track(EVENTS.UPGRADE_CLICKED);
  if (!(await requireSignIn({ reason: 'operator' }))) return false;

  // The account reloads after sign-in; wait for the plan before deciding.
  const current = await loaded();
  if (planOf(current) === 'operator') {
    openPortal({ tab: 'billing', message: { tone: 'success', title: 'Operator is already active on this account.' } });
    return false;
  }
  if (current.billing !== 'live') {
    openPortal({ tab: 'billing' });
    return false;
  }
  try {
    await goToCheckout();
    return true;
  } catch (error) {
    openPortal({ tab: 'billing', error });
    return false;
  }
}

/**
 * Opens the Stripe customer portal: card, invoices, cancel.
 *
 * @returns {Promise<boolean>} true when the page is leaving for Stripe.
 */
export async function openBillingPortal() {
  if (!(await requireSignIn({ reason: 'billing' }))) return false;
  try {
    await goToBillingPortal();
    return true;
  } catch (error) {
    openPortal({ tab: 'billing', error });
    return false;
  }
}

// ---------------------------------------------------------------------------
// The header control
// ---------------------------------------------------------------------------

/** The button on the home page, and the link that stands in for it on every other page. */
function headerControls() {
  return [...document.querySelectorAll('#account-button, .site-header__actions a[href="/#account"]')];
}

function renderHeader(value = currentAccount()) {
  const model = headerControl(value);
  for (const control of headerControls()) {
    control.classList.add('account-control');
    control.dataset.plan = planOf(value);
    const chip = model.chip
      ? el('span', { class: ['chip', model.tone !== 'danger' && 'status'], dataset: { status: model.tone === 'operator' ? 'operator' : model.tone === 'neutral' ? 'free' : null, tone: model.tone === 'danger' ? 'danger' : null }, text: model.chip })
      : null;
    const person = model.chip ? icon('user') : null;
    person?.classList.add('account-control__icon');
    control.replaceChildren(...[person, chip, el('span', { class: 'btn__label', text: model.label })].filter(Boolean));
    // The chip is short for the plan: the accessible name spells it out.
    if (model.chip) control.setAttribute('aria-label', model.name);
    else control.removeAttribute('aria-label');
  }
}

// ---------------------------------------------------------------------------
// Coming back from Stripe
// ---------------------------------------------------------------------------

function restorePlace(place) {
  if (!place || place.path !== location.pathname) return;
  const target = place.hash ? document.getElementById(place.hash.slice(1)) : null;
  // The workbench restores its own step first; scroll once it has laid out.
  requestAnimationFrame(() => {
    if (target) target.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, place.y);
  });
}

async function confirmPayment(sessionId, { retried = false } = {}) {
  showBanner({ tone: 'info', title: 'Confirming your payment with Stripe.', busy: true, dismissible: false });

  const current = await loaded();
  if (!current.signedIn) {
    showBanner({
      tone: 'info',
      title: 'Sign in to finish activating Operator.',
      actions: [
        button({
          label: 'Sign in',
          variant: 'primary',
          size: 'sm',
          onClick: async () => {
            if (await requireSignIn({ reason: 'Sign in to finish activating Operator.' })) confirmPayment(sessionId);
          },
        }),
      ],
    });
    return;
  }
  if (planOf(current) === 'operator') {
    showBanner({ tone: 'success', title: OPERATOR_ACTIVE_TITLE, body: OPERATOR_ACTIVE_BODY });
    return;
  }
  if (current.billing !== 'live') {
    showBanner({ tone: 'warn', title: 'Subscriptions are not open right now.', body: 'The free plan works as usual.' });
    return;
  }

  const result = await confirmCheckout({ sessionId });
  if (result.active) {
    showBanner({ tone: 'success', title: OPERATOR_ACTIVE_TITLE, body: OPERATOR_ACTIVE_BODY });
    announce(OPERATOR_ACTIVE);
    return;
  }
  if (result.error?.code === 'signin' && !retried) {
    // The session ended on the way back: this pass shows the Sign in bar.
    confirmPayment(sessionId, { retried: true });
    return;
  }
  const retry = button({ label: 'Check again', size: 'sm', onClick: () => confirmPayment(sessionId) });
  if (result.error) {
    showBanner({ tone: 'error', title: 'The payment could not be confirmed yet.', body: result.error.message, actions: [retry] });
  } else {
    showBanner({ tone: 'warn', title: 'Stripe has not confirmed the payment yet.', body: 'Check again in a minute. Nothing is charged twice.', actions: [retry] });
  }
}

function handleCheckoutReturn() {
  const returned = readCheckoutReturn();
  if (!returned) return;
  cleanReturnUrl();
  const place = takePlace();

  if (returned.state === 'cancelled') {
    const text = 'Checkout closed. Nothing was charged.';
    if (!showCheckoutNote(text)) showBanner({ tone: 'info', title: text });
    restorePlace(place);
    return;
  }
  restorePlace(place);
  confirmPayment(returned.sessionId);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function ensureStyles() {
  if (document.querySelector(`link[rel="stylesheet"][href="${STYLESHEET}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLESHEET }));
}

function openFromHash() {
  if (location.hash !== '#account') return;
  // Stripe's customer portal returns to /#account: show Billing, where the change is.
  const fromStripe = /^https:\/\/([a-z0-9-]+\.)*stripe\.com\//.test(document.referrer);
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  openAccount(fromStripe ? { tab: 'billing' } : {});
}

const ACTIONS = {
  open: () => openAccount(),
  signin: (control) => requireSignIn({ reason: control.dataset.accountReason }),
  checkout: () => startCheckout(),
  billing: () => openBillingPortal(),
};

let wired = false;

/**
 * Wires the page. Runs once; the module calls it when it loads in a browser.
 */
export function initAccount() {
  if (wired || typeof document === 'undefined') return;
  wired = true;

  ensureStyles();
  setReauthHandler(confirmIdentity);
  onPortalSignedOut(() => openSignIn('account', { then: 'portal' }));

  on(document, 'click', '#account-button, a[href="/#account"], a[href="#account"]', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    openAccount();
  });
  on(document, 'click', '[data-account-action]', (event, control) => {
    const action = ACTIONS[control.dataset.accountAction];
    if (!action) return;
    event.preventDefault();
    action(control);
  });
  on(window, 'hashchange', openFromHash);

  // The page ships with "Sign in" on the control; it changes once the account is known.
  subscribeAccount((value, previous) => {
    renderHeader(value);
    if (value.signedIn) markKnown();
    // Signed out in another tab while the sheet is open here.
    if (previous.signedIn && !value.signedIn && isPortalOpen()) closePortal();
  });

  loaded().then((value) => {
    renderHeader(value);
    if (value.signedIn) markKnown();
    openFromHash();
    handleCheckoutReturn();
  });
}

initAccount();
