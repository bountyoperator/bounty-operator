/**
 * The signed-in account panel: a full-height sheet with five sections.
 *
 *   Overview      plan, today's usage with the reset countdown, running reviews, the paid period, a failed payment
 *   Reviews       recent hosted reviews: profile, channel, time, status
 *   Connections   tokens for AI clients; the secret is shown once with install commands
 *   Security      passkeys, the recovery code, sessions, the data export, account deletion
 *   Billing       Get Operator, Manage in Stripe, what Operator includes
 *
 * Imports ./api.mjs, ./billing-ui.mjs, ./events.mjs, ./passkey.mjs and ./ui.mjs.
 * account.mjs opens it; other modules go through account.mjs.
 *
 * Exports
 *   TABS                                [{ id, label, icon }]
 *   openPortal({ tab, error, message }?) -> Promise<string>   resolves when the sheet closes
 *   closePortal()
 *   isPortalOpen()                      -> boolean
 *   portalPasskeyIds()                  -> string[]   the account's credential ids, once the sheet has loaded
 *   onPortalSignedOut(fn)               -> unregister()   the session ended while the sheet was open
 *
 *   Shared with account.mjs
 *     dialogShell(id, { className, title })  -> { dialog, title, body, close }
 *     recoveryPanel({ code, intro, savedLabel, onSaved }) -> element
 *     copyButton({ text, label, variant, size, onCopied }) -> button
 *     setStatus(node, { tone, title, body, actions }) / clearStatus(node)
 *
 *   View models (no DOM; used by the panels and by the tests)
 *     usageSummary(usage, now?)         -> { plan, today, running, period }
 *     reviewRows(portal)                -> [{ id, profile, channel, when, status, statusLabel }]
 *     connectionCommands(token)         -> [{ id, label, name, code, wrap, note }]
 *     MCP_ENDPOINT, MCP_PACKAGE, TOKEN_VAR
 *
 * DOM ids
 *   #portal-dialog  #portal-dialog-title  #portal-plan  #portal-tabs  #portal-status
 *   #portal-tab-<id> and #portal-panel-<id> for overview, reviews, connections, security, billing
 *   Overview     #overview-upgrade  #overview-manage  #overview-update-card
 *   Connections  #connection-label  #connection-create  #connection-secret  #connection-token  #connection-done
 *   Security     #passkey-add  #recovery-rotate  #signout  #signout-all  #data-export  #account-delete
 *   Billing      #billing-checkout  #billing-manage
 *
 * The sheet never stores a secret: a new connection token and a new recovery
 * code live in a module variable until the user dismisses them (Done, I saved
 * it), the session changes or the page unloads.
 */

import { ApiError, currentAccount, planOf, request, subscribeAccount, track, withReauth } from './api.mjs';
import { PRICE_LINE, billingMessage, goToBillingPortal, goToCheckout, planChip, planTable } from './billing-ui.mjs';
import { EVENTS } from './events.mjs';
import { addPasskey, isCancelled } from './passkey.mjs';
import {
  announce,
  button,
  clear,
  copyText,
  dialogController,
  download,
  el,
  formatCountdown,
  formatDate,
  icon,
  isBusy,
  on,
  setBusy,
  timeUntil,
  toDate,
} from './ui.mjs';

export const TABS = Object.freeze([
  { id: 'overview', label: 'Overview', icon: 'user' },
  { id: 'reviews', label: 'Reviews', icon: 'clock' },
  { id: 'connections', label: 'Connections', icon: 'terminal' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'billing', label: 'Billing', icon: 'file' },
]);

export const MCP_ENDPOINT = 'https://bountyoperator.com/api/mcp';
export const MCP_PACKAGE = 'https://bountyoperator.com/dl/bounty-operator-mcp.tgz';
export const TOKEN_VAR = 'BOUNTY_OPERATOR_TOKEN';
const KEY_VAR = 'OPENROUTER_API_KEY';
const MCP_SERVER = 'bounty-operator';
const MAX_CONNECTIONS = 3;
const FREE_DAILY_REVIEWS = 1;
const COUNTDOWN_MS = 30000;
const COPIED_MS = 2000;

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/**
 * Today's allowance in words and numbers.
 *
 * @param {import('./api.mjs').Usage | null | undefined} usage
 * @param {number} [now]
 * @returns {{ plan: 'free' | 'operator' | 'past_due', today: { value: string, note: string, meter: { value: number, max: number } | null }, running: { value: string, note: string, meter: { value: number, max: number } }, period: { value: string, note: string } | null }}
 */
export function usageSummary(usage, now = Date.now()) {
  const source = usage ?? {};
  const plan = source.plan === 'weekly' ? 'operator' : source.plan === 'past_due' ? 'past_due' : 'free';
  const used = Number(source.usedToday) || 0;
  const running = Number(source.running) || 0;
  const concurrency = Number(source.concurrency) || 1;
  const reset = formatCountdown(timeUntil(source.resetsAt, now));

  let today;
  if (plan === 'operator') {
    today = { value: String(used), note: 'No daily cap.', meter: null };
  } else {
    // The Worker sends what is left, not the allowance. With nothing left the
    // allowance is the free plan's one review, however many ran while Operator was on.
    const remaining = Number(source.remainingToday) || 0;
    const allowance = remaining > 0 ? used + remaining : FREE_DAILY_REVIEWS;
    const spent = Math.min(used, allowance);
    today = {
      value: `${spent} of ${allowance}`,
      note: remaining > 0 ? `${remaining} left. Resets in ${reset}.` : `Used. Next free review in ${reset}.`,
      meter: { value: spent, max: allowance },
    };
  }

  return {
    plan,
    today,
    running: {
      value: `${running} of ${concurrency}`,
      note: running > 0 ? (running === 1 ? 'One review is running.' : `${running} reviews are running.`) : 'Nothing running.',
      meter: { value: Math.min(running, concurrency), max: concurrency },
    },
    period: plan === 'operator' && toDate(source.paidUntil) ? { value: formatDate(source.paidUntil), note: 'Renews or ends on this date. Stripe shows which.' } : null,
  };
}

const STATUS_LABELS = { completed: ['done', 'Completed'], running: ['running', 'Running'], failed: ['failed', 'Failed'] };
const CHANNEL_LABELS = { web: 'Workbench', mcp: 'AI client' };

/**
 * The review history, newest first, with names in place of ids.
 *
 * @param {{ reviews?: object[], profiles?: { id: string, name: string }[] } | null} portal
 * @returns {{ id: string, profile: string, channel: string, when: string, status: string, statusLabel: string }[]}
 */
export function reviewRows(portal) {
  const names = new Map((portal?.profiles ?? []).map((profile) => [profile.id, profile.name]));
  return (portal?.reviews ?? []).map((review) => {
    const [status, statusLabel] = STATUS_LABELS[review.status] ?? ['queued', String(review.status ?? 'Unknown')];
    return {
      id: String(review.id),
      profile: names.get(review.profile) ?? String(review.profile ?? 'Review'),
      channel: CHANNEL_LABELS[review.channel] ?? String(review.channel ?? ''),
      when: formatDate(review.created_at, { time: true }),
      status,
      statusLabel,
    };
  });
}

/**
 * Ready-to-paste setup for a new connection token, one entry per client. The
 * commands match the ones on /mcp.
 *
 * @param {string} token  bok_…
 * @returns {{ id: string, label: string, name: string, code: string, wrap: boolean, note: string }[]}
 */
export function connectionCommands(token) {
  const cursor = {
    mcpServers: {
      [MCP_SERVER]: {
        url: MCP_ENDPOINT,
        headers: { Authorization: `Bearer ${token}`, 'X-Provider-Key': `\${env:${KEY_VAR}}` },
      },
    },
  };
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      name: 'Terminal',
      code: `claude mcp add --transport http ${MCP_SERVER} ${MCP_ENDPOINT} --header "Authorization: Bearer ${token}" --header "X-Provider-Key: $${KEY_VAR}"`,
      wrap: true,
      note: `Your shell fills in $${KEY_VAR}, the provider key reviews run on. In PowerShell write $env:${KEY_VAR}.`,
    },
    {
      id: 'codex',
      label: 'Codex',
      name: 'Terminal',
      code: `export ${TOKEN_VAR}=${token} && codex mcp add ${MCP_SERVER} --url ${MCP_ENDPOINT} --bearer-token-env-var ${TOKEN_VAR}`,
      wrap: true,
      note: `Codex reads ${TOKEN_VAR} each time it starts, so keep the export in your shell profile. The provider key header is set in ~/.codex/config.toml.`,
    },
    {
      id: 'cursor',
      label: 'Cursor',
      name: '~/.cursor/mcp.json',
      code: JSON.stringify(cursor, null, 2),
      wrap: false,
      note: `Cursor fills in \${env:${KEY_VAR}} from your environment.`,
    },
    {
      id: 'local',
      label: 'Local (npx)',
      name: 'Terminal',
      code: `claude mcp add --env ${TOKEN_VAR}=${token} --env ${KEY_VAR}=$${KEY_VAR} --transport stdio ${MCP_SERVER} -- npx -y ${MCP_PACKAGE}`,
      wrap: true,
      note: 'Runs the server on your machine. Files are read and checked there before a review is sent.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Pieces shared with the sign-in dialog
// ---------------------------------------------------------------------------

/**
 * Finds the <dialog> the page fragment emitted, or creates it, and gives it
 * the standard head: title and close button.
 *
 * @param {string} id
 * @param {{ className: string, title: string }} options
 * @returns {{ dialog: HTMLDialogElement, title: HTMLElement, head: HTMLElement, close: HTMLElement }}
 */
export function dialogShell(id, { className, title }) {
  let dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById(id));
  if (!dialog) {
    dialog = /** @type {HTMLDialogElement} */ (el('dialog', { id, class: className, closedby: 'any', 'aria-labelledby': `${id}-title` }));
    document.body.append(dialog);
  }
  // The page fragment emits the head already; a dialog created here gets the same one.
  let head = dialog.querySelector(':scope > .dialog__head');
  let heading = head?.querySelector('.dialog__title') ?? null;
  let close = head?.querySelector('.dialog__close') ?? null;
  if (!head || !heading || !close) {
    heading = el('h2', { class: 'dialog__title', id: `${id}-title` });
    close = el('button', { class: 'dialog__close', type: 'button', 'data-close-dialog': true, 'aria-label': 'Close' }, icon('x'));
    head = el('header', { class: 'dialog__head' }, heading, close);
  }
  heading.textContent = title;
  dialog.replaceChildren(head);
  return { dialog, title: heading, head, close };
}

/**
 * Fills a notice element. An empty notice takes no space, so the same node
 * serves as the live region of its dialog.
 *
 * @param {Element | null} node
 * @param {{ tone?: 'info' | 'success' | 'warn' | 'error', title: string, body?: string, actions?: Node[] }} message
 */
export function setStatus(node, { tone = 'info', title, body = '', actions = [] }) {
  if (!node) return;
  const icons = { info: 'info', success: 'ok', warn: 'warn', error: 'error' };
  const kind = Object.hasOwn(icons, tone) ? tone : 'info';
  for (const name of Object.keys(icons)) node.classList.toggle(`notice--${name}`, name === kind);
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.replaceChildren(
    icon(icons[kind]),
    el(
      'div',
      { class: 'notice__content' },
      el('p', { class: 'notice__title', text: title }),
      body || actions.length
        ? el('div', { class: 'notice__body' }, body ? el('p', { text: body }) : null, actions.length ? el('div', { class: 'cluster cluster--tight' }, actions) : null)
        : null,
    ),
  );
}

/** @param {Element | null} node */
export function clearStatus(node) {
  node?.replaceChildren();
}

/**
 * A button that copies `text` and says so on itself for two seconds.
 *
 * @param {{ text: string | (() => string), label?: string, variant?: string, size?: string, id?: string, onCopied?: () => void }} options
 * @returns {HTMLButtonElement}
 */
export function copyButton({ text, label = 'Copy', variant = 'secondary', size = 'md', id, onCopied }) {
  const control = button({ label, variant, size, icon: 'copy', id });
  let timer = null;
  on(control, 'click', async () => {
    const copied = await copyText(typeof text === 'function' ? text() : text);
    const labelNode = control.querySelector('.btn__label');
    const iconNode = control.querySelector('.icon');
    if (!labelNode) return;
    clearTimeout(timer);
    labelNode.textContent = copied ? 'Copied' : 'Copy failed. Select the text.';
    if (iconNode) iconNode.className = `icon icon--${copied ? 'check' : 'warn'}`;
    control.toggleAttribute('data-copied', copied);
    if (copied && typeof onCopied === 'function') onCopied();
    timer = setTimeout(() => {
      labelNode.textContent = label;
      if (iconNode) iconNode.className = 'icon icon--copy';
      control.removeAttribute('data-copied');
    }, COPIED_MS);
  });
  return control;
}

function recoveryFile(code) {
  const day = new Date().toISOString().slice(0, 10);
  return [
    'Bounty Operator recovery code',
    '',
    code,
    '',
    'Signs you in at https://bountyoperator.com when no passkey is at hand.',
    'It works once. Signing in with it shows a new code.',
    `Saved ${day}.`,
    '',
  ].join('\n');
}

/**
 * The recovery code, shown once: the code, Copy, Download and the button that
 * says it is stored.
 *
 * @param {{ code: string, intro: string, savedLabel?: string, onSaved: () => void }} options
 * @returns {HTMLElement}
 */
export function recoveryPanel({ code, intro, savedLabel = 'I saved it', onSaved }) {
  return el(
    'div',
    { class: 'recovery' },
    el('p', { class: 'recovery__intro', text: intro }),
    el('output', { class: 'recovery__code', id: 'recovery-code', 'aria-label': 'Recovery code', text: code }),
    el(
      'div',
      { class: 'recovery__actions' },
      copyButton({ text: code, label: 'Copy', id: 'recovery-copy' }),
      button({
        label: 'Download',
        icon: 'download',
        id: 'recovery-download',
        onClick: () => download('bounty-operator-recovery-code.txt', recoveryFile(code)),
      }),
    ),
    el('p', { class: 'help', text: 'Keep it in a password manager. It is shown once and stored here only as a hash.' }),
    button({ label: savedLabel, variant: 'primary', block: true, id: 'recovery-saved', onClick: onSaved }),
  );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {HTMLDialogElement | null} */
let dialog = null;
/** @type {ReturnType<typeof dialogController> | null} */
let controller = null;
let statusNode = null;
let planNode = null;
/** @type {Map<string, { tab: HTMLElement, panel: HTMLElement }>} */
const parts = new Map();

let activeTab = 'overview';
/** The last answer of GET /api/portal, or null before the first one. */
let data = null;
let loadError = null;
let loads = 0;
/** The connection token just created: memory only. */
let secret = null;
let secretClient = 'claude-code';
/** The recovery code just issued: memory only. */
let freshRecovery = '';
let draftLabel = '';
/** Which inline confirmation is open, by key. */
let confirming = '';
/** A message for one tab, shown above its content until the next action. */
let flash = null;
let countdown = null;
let sessionToken = '';
/** @type {Set<() => void>} */
const signedOutListeners = new Set();

/**
 * @param {() => void} fn  Called when the Worker says the session ended.
 * @returns {() => void}
 */
export function onPortalSignedOut(fn) {
  signedOutListeners.add(fn);
  return () => signedOutListeners.delete(fn);
}

export function isPortalOpen() {
  return Boolean(dialog?.open);
}

/** The account's passkey ids, for a confirmation prompt limited to them. */
export function portalPasskeyIds() {
  return (data?.passkeys ?? []).map((passkey) => String(passkey.id));
}

/** Drops everything loaded for the account that was signed in. */
function forgetAccount() {
  data = null;
  loadError = null;
  secret = null;
  freshRecovery = '';
  draftLabel = '';
  confirming = '';
}

function forget() {
  forgetAccount();
  flash = null;
}

/** Notes whose session this is. True when it is not the one the sheet last showed. */
function sessionChanged(account) {
  const token = account.signedIn ? account.csrf : '';
  if (token === sessionToken) return false;
  sessionToken = token;
  return true;
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

function section(title, lede, ...children) {
  return el(
    'section',
    { class: 'portal-section' },
    el('div', { class: 'portal-section__head' }, el('h3', { class: 'portal-section__title', text: title }), lede ? el('p', { class: 'portal-section__lede', text: lede }) : null),
    children,
  );
}

function meter({ value, max }, label) {
  return el('progress', { class: 'meter', max, value, 'aria-label': label }, `${value} of ${max}`);
}

function stat(label, { value, note, meter: bar }, meterLabel) {
  return el(
    'div',
    { class: 'stat' },
    el('dt', { class: 'stat__label', text: label }),
    el('dd', { class: 'stat__body' }, el('span', { class: 'stat__value', text: value }), bar ? meter(bar, meterLabel) : null, el('span', { class: 'stat__note', text: note })),
  );
}

function row({ title, meta, chips = [], actions = [], id }) {
  return el(
    'li',
    { class: 'portal-row', id },
    el(
      'div',
      { class: 'portal-row__main' },
      el('p', { class: 'portal-row__title' }, el('span', { text: title }), chips),
      meta ? el('p', { class: 'portal-row__meta', text: meta }) : null,
    ),
    actions.length ? el('div', { class: 'portal-row__actions' }, actions) : null,
  );
}

function empty(text, action) {
  return el('div', { class: 'portal-empty' }, el('p', { text }), action ?? null);
}

function skeleton() {
  return el(
    'div',
    { class: 'portal-loading', 'aria-hidden': 'true' },
    el('span', { class: 'skeleton skeleton--title' }),
    el('span', { class: 'skeleton skeleton--text' }),
    el('span', { class: 'skeleton skeleton--text' }),
    el('span', { class: 'skeleton skeleton--block' }),
  );
}

/**
 * A destructive action in two steps, in place: the trigger, then one sentence
 * saying what happens with the action and a way back.
 */
function confirmable(key, { trigger, prompt, confirm, keep = 'Cancel', run }) {
  if (confirming !== key) {
    return button({
      ...trigger,
      onClick: () => {
        confirming = key;
        render({ focus: `confirm-keep-${key}` });
      },
    });
  }
  return el(
    'div',
    { class: 'confirm', role: 'group', 'aria-label': trigger.label },
    el('p', { class: 'confirm__text', text: prompt }),
    el(
      'div',
      { class: 'confirm__actions' },
      button({ label: confirm, variant: 'danger', id: `confirm-run-${key}`, onClick: (event) => run(event.currentTarget) }),
      button({
        label: keep,
        variant: 'quiet',
        id: `confirm-keep-${key}`,
        onClick: () => {
          confirming = '';
          render({ focus: trigger.id });
        },
      }),
    ),
  );
}

function codeBlock({ name, code, wrap, onCopy }) {
  const copy = el(
    'button',
    { class: 'code__copy', type: 'button', 'data-copy': true, 'aria-label': `Copy: ${name}` },
    icon('copy'),
    el('span', { 'data-copy-label': true, text: 'Copy' }),
  );
  if (onCopy) on(copy, 'click', onCopy);
  // Each line ends with a line feed, so the text copies as written.
  const lines = code.split('\n').map((line) => el('span', { class: 'code__line' }, `${line}\n`));
  return el(
    'figure',
    { class: ['code', wrap && 'code--wrap'] },
    el('figcaption', { class: 'code__bar' }, el('span', { class: 'code__name', text: name }), copy),
    el('pre', { class: 'code__pre', tabindex: '0' }, el('code', null, lines)),
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function showFlash(message, tab = activeTab) {
  flash = message ? { tab, ...message } : null;
}

function failure(error) {
  if (!(error instanceof ApiError)) return { tone: 'error', title: 'That did not work. Try again.' };
  if (isCancelled(error) || error.code === 'reauth') return { tone: 'info', title: 'Not confirmed. Nothing changed.' };
  if (error.code.startsWith('billing_')) return billingMessage(error);
  if (error.code === 'rate_limited') {
    const seconds = Number(error.data?.retryAfter);
    return {
      tone: 'warn',
      title: 'Too many requests.',
      body: Number.isFinite(seconds) && seconds > 0 ? `Try again in ${formatCountdown(seconds * 1000)}.` : 'Try again in a minute.',
    };
  }
  if (error.code === 'last_passkey' || error.code === 'connection_limit' || error.code === 'passkey_exists') {
    return { tone: 'warn', title: error.message };
  }
  return { tone: 'error', title: error.message };
}

function sessionEnded() {
  forget();
  closePortal();
  for (const listener of [...signedOutListeners]) listener();
}

/**
 * Runs one action from a button: busy state, the call, then the result as a
 * message on the tab. Returns the call's result, or undefined when it failed.
 */
async function act(control, work, { busy, success } = {}) {
  if (isBusy(control)) return undefined;
  setBusy(control, true, busy);
  flash = null;
  clearStatus(statusNode);
  try {
    const result = await work();
    if (success) showFlash({ tone: 'success', title: typeof success === 'function' ? success(result) : success });
    return result ?? true;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'signin') {
      sessionEnded();
      return undefined;
    }
    showFlash(failure(error));
    return undefined;
  } finally {
    setBusy(control, false);
  }
}

async function load() {
  loads += 1;
  const ticket = loads;
  try {
    const answer = await request('/api/portal');
    if (ticket !== loads) return;
    data = answer;
    loadError = null;
  } catch (error) {
    if (ticket !== loads) return;
    if (error instanceof ApiError && error.code === 'signin') {
      sessionEnded();
      return;
    }
    loadError = error;
  }
  render();
}

async function checkout(control) {
  track(EVENTS.UPGRADE_CLICKED);
  await act(control, goToCheckout, { busy: 'Opening Stripe' });
  render();
}

async function manage(control) {
  await act(control, goToBillingPortal, { busy: 'Opening Stripe' });
  render();
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function upgradeButton(id) {
  const live = currentAccount().billing === 'live';
  return button({
    label: `Get Operator. ${PRICE_LINE}`,
    variant: 'primary',
    id,
    iconEnd: 'arrow-right',
    attrs: live ? {} : { 'aria-disabled': 'true', 'aria-describedby': 'billing-closed' },
    onClick: (event) => {
      if (live) checkout(event.currentTarget);
    },
  });
}

function billingClosed() {
  if (currentAccount().billing === 'live') return null;
  const node = el('div', { class: 'notice notice--info', id: 'billing-closed' });
  setStatus(node, { tone: 'info', title: 'Subscriptions are not open right now.', body: 'The free plan works as usual.' });
  return node;
}

function pastDueNotice() {
  const node = el('div', { class: 'notice notice--error', id: 'past-due' });
  setStatus(node, {
    tone: 'error',
    title: 'Payment failed. Operator is paused.',
    body: 'Update the card in Stripe. Operator returns when the payment clears. Until then the account has the free allowance.',
    actions: [button({ label: 'Update card', variant: 'primary', size: 'sm', id: 'overview-update-card', onClick: (event) => manage(event.currentTarget) })],
  });
  return node;
}

const PLAN_LINES = {
  free: ['Free plan', 'One hosted review per UTC day. Prompt export and the free tools have no limit.'],
  operator: ['Operator', 'Unlimited hosted reviews, the gauntlet and panel review. Four reviews at once.'],
};

function overviewStats(summary) {
  return el(
    'dl',
    { class: 'stats', id: 'overview-stats' },
    stat(summary.plan === 'operator' ? 'Reviews today' : 'Free review today', summary.today, 'Free reviews used today'),
    stat('Running now', summary.running, 'Reviews running'),
    summary.period ? stat('Paid through', summary.period) : stat('Operator', { value: PRICE_LINE, note: 'Unlimited reviews, gauntlet, panel.' }),
  );
}

function currentSummary() {
  return usageSummary(currentAccount().usage ?? data?.usage ?? null);
}

function renderOverview() {
  const summary = currentSummary();
  const latest = reviewRows(data)[0];

  // A failed payment is the whole story of the page: the notice stands in for the plan line.
  let top;
  if (summary.plan === 'past_due') {
    top = pastDueNotice();
  } else {
    const [headline, line] = PLAN_LINES[summary.plan];
    const action =
      summary.plan === 'operator'
        ? button({ label: 'Manage in Stripe', id: 'overview-manage', iconEnd: 'arrow-up-right', onClick: (event) => manage(event.currentTarget) })
        : upgradeButton('overview-upgrade');
    top = el(
      'div',
      { class: 'portal-hero' },
      el('div', { class: 'portal-hero__text' }, el('h3', { class: 'portal-hero__title', text: headline }), el('p', { class: 'portal-hero__line', text: line })),
      el('div', { class: 'portal-hero__action' }, action),
    );
  }

  return [
    top,
    summary.plan === 'free' ? billingClosed() : null,
    overviewStats(summary),
    section(
      'Latest review',
      null,
      latest
        ? el(
            'ul',
            { class: 'portal-list' },
            row({
              title: latest.profile,
              meta: `${latest.channel} · ${latest.when}`,
              chips: [el('span', { class: 'chip status', dataset: { status: latest.status }, text: latest.statusLabel })],
              actions: [button({ label: 'All reviews', variant: 'quiet', size: 'sm', onClick: () => selectTab('reviews', { focus: true }) })],
            }),
          )
        : data
          ? empty('No hosted review yet.', workbenchLink())
          : skeleton(),
    ),
  ];
}

function workbenchLink() {
  return el('a', { class: 'btn btn--secondary btn--sm', href: '/#workspace', onClick: () => closePortal() }, el('span', { class: 'btn__label', text: 'Open the workbench' }));
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

function renderReviews() {
  if (!data) return [skeleton()];
  const rows = reviewRows(data);
  return [
    section(
      'Recent reviews',
      'The last 30 hosted reviews, kept for seven days. Only the profile, the channel, the time and the status are stored.',
      rows.length
        ? el(
            'ul',
            { class: 'portal-list', id: 'review-list' },
            rows.map((review) =>
              row({
                title: review.profile,
                meta: `${review.channel} · ${review.when}`,
                actions: [el('span', { class: 'chip status', dataset: { status: review.status }, text: review.statusLabel })],
              }),
            ),
          )
        : empty('No hosted review yet. Run one from the workbench or from a connected AI client.', workbenchLink()),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

async function createConnection(control, label) {
  const created = await act(control, () => withReauth(() => request('/api/connections/create', { body: { label } })), { busy: 'Creating' });
  if (created && typeof created.token === 'string') {
    secret = { id: created.id, label, token: created.token, expires: created.expires };
    secretClient = 'claude-code';
    draftLabel = '';
    await load();
    render({ focus: 'connection-token-copy' });
    return;
  }
  render({ focus: 'connection-label' });
}

async function revokeConnection(control, connection) {
  const revoked = await act(control, () => request('/api/connections/revoke', { body: { id: connection.id } }), {
    busy: 'Revoking',
    success: `Revoked "${connection.label}". The client that used it is signed out.`,
  });
  confirming = '';
  if (revoked) {
    if (secret?.id === connection.id) secret = null;
    await load();
  }
  render({ focus: 'connection-label' });
}

function secretPanel() {
  const commands = connectionCommands(secret.token);
  const current = commands.find((command) => command.id === secretClient) ?? commands[0];
  const tabs = el(
    'div',
    { class: 'tabs secret__clients', role: 'tablist', 'aria-label': 'AI client' },
    commands.map((command) =>
      el('button', {
        class: 'tabs__tab',
        type: 'button',
        role: 'tab',
        id: `client-tab-${command.id}`,
        'aria-selected': command.id === current.id ? 'true' : 'false',
        'aria-controls': 'client-panel',
        tabindex: command.id === current.id ? null : '-1',
        text: command.label,
        onClick: () => {
          secretClient = command.id;
          render({ focus: `client-tab-${command.id}` });
        },
      }),
    ),
  );
  on(tabs, 'keydown', (event) => moveTab(event, commands.map((command) => command.id), current.id, (id) => {
    secretClient = id;
    render({ focus: `client-tab-${id}` });
  }));

  return el(
    'div',
    { class: 'secret', id: 'connection-secret' },
    el(
      'div',
      { class: 'secret__head' },
      el('h4', { class: 'secret__title', text: `Token for "${secret.label}"` }),
      el('p', { class: 'secret__lede', text: 'Copy it now. It is shown once and stored here only as a hash.' }),
    ),
    el(
      'div',
      { class: 'secret__token' },
      el('code', { class: 'secret__value', id: 'connection-token', text: secret.token }),
      copyButton({ text: secret.token, label: 'Copy token', size: 'sm', id: 'connection-token-copy' }),
    ),
    tabs,
    el(
      'div',
      { class: 'secret__panel', id: 'client-panel', role: 'tabpanel', 'aria-labelledby': `client-tab-${current.id}` },
      codeBlock({ name: current.name, code: current.code, wrap: current.wrap, onCopy: () => track(EVENTS.MCP_COMMAND_COPIED) }),
      el('p', { class: 'help', text: current.note }),
    ),
    el(
      'div',
      { class: 'secret__foot' },
      el('a', { class: 'link', href: '/mcp', target: '_blank', text: 'Setup for every client' }),
      button({
        label: 'Done',
        variant: 'primary',
        size: 'sm',
        id: 'connection-done',
        onClick: () => {
          secret = null;
          render({ focus: 'connection-label' });
        },
      }),
    ),
  );
}

function connectionForm(count) {
  const full = count >= MAX_CONNECTIONS;
  const input = el('input', {
    class: 'input',
    id: 'connection-label',
    type: 'text',
    name: 'label',
    maxlength: '60',
    autocomplete: 'off',
    placeholder: 'Laptop, Claude Code',
    value: draftLabel,
    disabled: full,
    'aria-describedby': 'connection-help',
    onInput: (event) => {
      draftLabel = event.currentTarget.value;
      event.currentTarget.removeAttribute('aria-invalid');
    },
  });
  const submit = button({ label: 'Create connection', variant: 'primary', type: 'submit', id: 'connection-create', icon: 'plus', disabled: full });
  return el(
    'form',
    {
      class: 'connection-form',
      novalidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        const label = draftLabel.trim();
        if (!label) {
          input.setAttribute('aria-invalid', 'true');
          input.focus();
          showFlash({ tone: 'warn', title: 'Name the connection first: the device and the client it is for.' });
          renderStatus();
          return;
        }
        createConnection(submit, label);
      },
    },
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'label', for: 'connection-label', text: 'Name' }),
      el('div', { class: 'connection-form__row' }, input, submit),
      el('p', {
        class: 'help',
        id: 'connection-help',
        text: full
          ? 'This account holds three connections. Revoke one to create another.'
          : 'One name per device and client, so a lost laptop is one revoke. Up to three, 90 days each.',
      }),
    ),
  );
}

function renderConnections() {
  if (!data) return [skeleton()];
  const connections = data.connections ?? [];
  return [
    section(
      'AI client connections',
      'A connection token lets Claude Code, Codex or Cursor run hosted reviews on this account. It reads usage and runs reviews. It cannot reach billing, passkeys or deletion.',
      secret ? secretPanel() : connectionForm(connections.length),
    ),
    section(
      `Active connections (${connections.length} of ${MAX_CONNECTIONS})`,
      null,
      connections.length
        ? el(
            'ul',
            { class: 'portal-list', id: 'connection-list' },
            connections.map((connection) =>
              row({
                id: `connection-${connection.id}`,
                title: connection.label,
                meta: [
                  `Created ${formatDate(connection.created_at)}`,
                  connection.last_used ? `Last used ${formatDate(connection.last_used, { time: true })}` : 'Never used',
                  `Expires ${formatDate(connection.expires)}`,
                ].join(' · '),
                actions: [
                  confirmable(`revoke-${connection.id}`, {
                    trigger: { label: 'Revoke', size: 'sm', id: `connection-revoke-${connection.id}`, attrs: { 'aria-label': `Revoke ${connection.label}` } },
                    prompt: 'Revoking signs out the client that uses this token.',
                    confirm: 'Revoke',
                    keep: 'Keep',
                    run: (control) => revokeConnection(control, connection),
                  }),
                ],
              }),
            ),
          )
        : empty('No connection yet.'),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

async function addAnotherPasskey(control) {
  const added = await act(control, () => withReauth(() => addPasskey()), {
    busy: 'Waiting for your passkey',
    success: 'Passkey added. Either passkey signs you in.',
  });
  if (added) await load();
  render({ focus: 'passkey-add' });
}

async function removePasskey(control, passkey) {
  const removed = await act(control, () => withReauth(() => request('/api/passkeys/remove', { body: { id: passkey.id } })), {
    busy: 'Removing',
    success: 'Passkey removed. Other browsers signed in to this account are signed out.',
  });
  confirming = '';
  if (removed) await load();
  render({ focus: 'passkey-add' });
}

async function rotateRecovery(control) {
  const rotated = await act(control, () => withReauth(() => request('/api/auth/rotate-recovery', { body: {} })), { busy: 'Replacing' });
  confirming = '';
  if (rotated && typeof rotated.recoveryCode === 'string') freshRecovery = rotated.recoveryCode;
  render({ focus: freshRecovery ? 'recovery-copy' : 'recovery-rotate' });
}

async function signOut(control, everywhere) {
  const path = everywhere ? '/api/auth/logout-all' : '/api/auth/logout';
  const done = await act(control, () => request(path, { body: {} }), { busy: 'Signing out' });
  confirming = '';
  if (done) {
    forget();
    closePortal();
    announce(everywhere ? 'Signed out everywhere.' : 'Signed out.');
    return;
  }
  render();
}

async function exportData(control) {
  await act(
    control,
    async () => {
      const exported = await request('/api/account/export');
      download(`bounty-operator-account-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(exported, null, 2), 'application/json');
    },
    { busy: 'Preparing', success: 'Downloaded. The file holds the account record, passkey and connection names, and the review history.' },
  );
  render({ focus: 'data-export' });
}

async function deleteAccount(control) {
  const deleted = await act(control, () => withReauth(() => request('/api/account/delete', { body: {} })), { busy: 'Deleting' });
  confirming = '';
  if (deleted) {
    forget();
    closePortal();
    try {
      globalThis.localStorage?.removeItem('bo:known');
    } catch {
      // Storage is blocked: there is nothing to remove.
    }
    announce('Account deleted.');
    return;
  }
  // A live subscription blocks deletion: the Billing answer names the way out.
  if (flash && flash.action === 'manage') {
    flash = {
      ...flash,
      title: 'Cancel the subscription first.',
      body: 'Stripe would keep billing an account nobody can open. Cancel in Stripe, then delete the account once the period has ended.',
    };
  }
  render({ focus: 'account-delete' });
}

function renderSecurity() {
  if (!data) return [skeleton()];
  const passkeys = data.passkeys ?? [];
  const only = passkeys.length <= 1;

  const passkeyList = el(
    'ul',
    { class: 'portal-list', id: 'passkey-list' },
    passkeys.map((passkey, index) =>
      row({
        id: `passkey-${index + 1}`,
        title: passkeys.length > 1 ? `${passkey.label || 'Passkey'} ${index + 1}` : passkey.label || 'Passkey',
        meta: [passkey.created_at ? `Added ${formatDate(passkey.created_at)}` : null, `ID ends ${String(passkey.id).slice(-6)}`].filter(Boolean).join(' · '),
        actions: only
          ? []
          : [
              confirmable(`passkey-${passkey.id}`, {
                trigger: { label: 'Remove', size: 'sm', id: `passkey-remove-${index + 1}`, attrs: { 'aria-label': `Remove passkey ${index + 1}` } },
                prompt: 'Removing it signs out every other browser on this account.',
                confirm: 'Remove passkey',
                keep: 'Keep',
                run: (control) => removePasskey(control, passkey),
              }),
            ],
      }),
    ),
  );

  const recovery = freshRecovery
    ? recoveryPanel({
        code: freshRecovery,
        intro: 'This is the new recovery code. The old one no longer works.',
        onSaved: () => {
          freshRecovery = '';
          showFlash({ tone: 'success', title: 'Recovery code replaced.' });
          render({ focus: 'recovery-rotate' });
        },
      })
    : confirmable('rotate', {
        trigger: { label: 'Replace recovery code', id: 'recovery-rotate', icon: 'refresh' },
        prompt: 'The current code stops working as soon as the new one is shown.',
        confirm: 'Replace it',
        keep: 'Keep current code',
        run: (control) => rotateRecovery(control),
      });

  return [
    section(
      'Passkeys',
      only
        ? 'One passkey signs you in. Add a second on another device or provider, so losing one does not lock you out.'
        : 'Any of these signs you in. Remove one that is lost or no longer used.',
      passkeyList,
      el('div', { class: 'portal-section__actions' }, button({ label: 'Add a passkey', id: 'passkey-add', icon: 'plus', onClick: (event) => addAnotherPasskey(event.currentTarget) })),
    ),
    section('Recovery code', 'One code signs you in when no passkey is at hand. It works once, then a new one is shown.', recovery),
    section(
      'Sessions',
      'Sign out here, or end every session and revoke every AI connection at once.',
      el(
        'div',
        { class: 'portal-section__actions' },
        button({ label: 'Sign out', id: 'signout', onClick: (event) => signOut(event.currentTarget, false) }),
        confirmable('signout-all', {
          trigger: { label: 'Sign out everywhere', id: 'signout-all' },
          prompt: 'Every browser is signed out and every AI connection is revoked.',
          confirm: 'Sign out everywhere',
          run: (control) => signOut(control, true),
        }),
      ),
    ),
    section(
      'Your data',
      'Everything stored about this account, as one JSON file. Files, prompts, API keys and review text are never stored.',
      el('div', { class: 'portal-section__actions' }, button({ label: 'Download my data', id: 'data-export', icon: 'download', onClick: (event) => exportData(event.currentTarget) })),
    ),
    section(
      'Delete account',
      'Removes the account, its passkeys, connections and review history.',
      el(
        'div',
        { class: 'portal-section__actions' },
        confirmable('delete', {
          trigger: { label: 'Delete account', variant: 'danger', id: 'account-delete', icon: 'trash' },
          prompt: 'This removes the account for good. It cannot be undone.',
          confirm: 'Delete account',
          keep: 'Keep account',
          run: (control) => deleteAccount(control),
        }),
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

function renderBilling() {
  const account = currentAccount();
  const plan = planOf(account);
  const subscribed = account.hasSubscription || plan === 'operator' || plan === 'past_due';
  const period = usageSummary(account.usage).period;

  const manageButton = button({
    label: plan === 'past_due' ? 'Update card' : 'Manage in Stripe',
    variant: plan === 'past_due' ? 'primary' : 'secondary',
    id: 'billing-manage',
    iconEnd: 'arrow-up-right',
    onClick: (event) => manage(event.currentTarget),
  });

  let current;
  if (plan === 'operator') {
    current = ['Operator', period ? `${PRICE_LINE}. Paid through ${period.value}.` : `${PRICE_LINE}.`];
  } else if (plan === 'past_due') {
    current = ['Operator, payment failed', 'The last payment did not clear. Update the card in Stripe to restore Operator.'];
  } else if (subscribed) {
    current = ['Free plan', 'A subscription exists on this account and is not active. Open Stripe to see its state.'];
  } else {
    current = ['Free plan', `One hosted review per UTC day. Operator is ${PRICE_LINE}, billed by Stripe until you cancel.`];
  }

  return [
    el(
      'div',
      { class: 'portal-hero' },
      el('div', { class: 'portal-hero__text' }, el('h3', { class: 'portal-hero__title', text: current[0] }), el('p', { class: 'portal-hero__line', text: current[1] })),
      el('div', { class: 'portal-hero__action' }, subscribed ? manageButton : upgradeButton('billing-checkout')),
    ),
    subscribed ? null : billingClosed(),
    subscribed
      ? section('Card, invoices and cancellation', 'Stripe holds the card and every invoice. Cancelling is done there too.')
      : null,
    section('What Operator includes', null, planTable()),
    el(
      'p',
      { class: 'help' },
      el('a', { class: 'link', href: '/terms', target: '_blank', text: 'Terms' }),
      ' · ',
      el('a', { class: 'link', href: 'mailto:support@bountyoperator.com', text: 'support@bountyoperator.com' }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const RENDERERS = { overview: renderOverview, reviews: renderReviews, connections: renderConnections, security: renderSecurity, billing: renderBilling };

function renderStatus() {
  if (!statusNode) return;
  if (!flash || flash.tab !== activeTab) {
    clearStatus(statusNode);
    return;
  }
  const actions = [];
  if (flash.action === 'manage') {
    actions.push(button({ label: 'Manage subscription', variant: 'primary', size: 'sm', id: 'flash-manage', onClick: (event) => manage(event.currentTarget) }));
  } else if (flash.action === 'checkout') {
    actions.push(button({ label: 'Get Operator', variant: 'primary', size: 'sm', id: 'flash-checkout', onClick: (event) => checkout(event.currentTarget) }));
  }
  setStatus(statusNode, { tone: flash.tone, title: flash.title, body: flash.body, actions });
}

function loadFailure() {
  const node = el('div', { class: 'notice notice--error' });
  setStatus(node, {
    tone: 'error',
    title: 'The account could not be loaded.',
    body: loadError instanceof Error ? loadError.message : '',
    actions: [button({ label: 'Try again', size: 'sm', onClick: () => load() })],
  });
  return node;
}

/**
 * Draws the active tab from the module state. `focus` is the id of the
 * element to focus afterwards; without it, focus stays where it was when
 * that element still exists, and otherwise moves to the panel.
 */
function render({ focus } = {}) {
  if (!dialog) return;
  const active = document.activeElement;
  const hadFocus = active instanceof HTMLElement && dialog.contains(active) && Boolean(active.closest('.portal__panel'));
  const previous = hadFocus ? active.id : '';

  if (planNode) planNode.replaceChildren(planChip());
  for (const [id, part] of parts) {
    const selected = id === activeTab;
    part.tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) part.tab.removeAttribute('tabindex');
    else part.tab.setAttribute('tabindex', '-1');
    part.panel.hidden = !selected;
    if (!selected) clear(part.panel);
  }

  const panel = parts.get(activeTab).panel;
  const needsData = activeTab !== 'billing' && activeTab !== 'overview';
  panel.replaceChildren(...[loadError && (needsData || !data) ? loadFailure() : null, ...(loadError && needsData ? [] : RENDERERS[activeTab]())].filter(Boolean));
  renderStatus();

  if (!dialog.open) return;
  const target = (focus && document.getElementById(focus)) || (previous && document.getElementById(previous));
  if (target && dialog.contains(target)) {
    if (document.activeElement !== target) target.focus({ preventScroll: !focus });
    // A block that just appeared is shown whole, not cut by the panel's edge.
    if (focus) target.closest('.confirm, .secret, .recovery')?.scrollIntoView({ block: 'nearest' });
  } else if (hadFocus || focus) {
    // The control that had focus is gone: keep the keyboard inside the panel.
    panel.focus({ preventScroll: true });
  }
}

function selectTab(id, { focus = false } = {}) {
  if (!parts.has(id)) return;
  if (id !== activeTab) {
    confirming = '';
    if (flash && flash.tab !== id) flash = null;
  }
  activeTab = id;
  render();
  const main = dialog?.querySelector('.portal__main');
  if (main) main.scrollTop = 0;
  const tab = parts.get(id).tab;
  tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (focus) tab.focus();
}

/** Arrow keys, Home and End move between tabs, as the tab pattern requires. */
function moveTab(event, ids, current, select) {
  const index = ids.indexOf(current);
  let next = -1;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % ids.length;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + ids.length) % ids.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = ids.length - 1;
  if (next === -1) return;
  event.preventDefault();
  select(ids[next]);
}

function tick() {
  if (!dialog?.open || activeTab !== 'overview') return;
  // Only the countdown changes with time. The tiles hold nothing that takes focus.
  document.getElementById('overview-stats')?.replaceWith(overviewStats(currentSummary()));
}

function build() {
  if (dialog) return;
  const shell = dialogShell('portal-dialog', { className: 'dialog dialog--lg portal', title: 'Account' });
  dialog = shell.dialog;
  dialog.classList.add('dialog', 'dialog--lg', 'portal');

  // Title and plan sit together on the left; Close stays on the right.
  planNode = el('span', { id: 'portal-plan', class: 'portal__plan' });
  const heading = el('div', { class: 'portal__heading' });
  shell.head.classList.add('portal__head');
  shell.title.before(heading);
  heading.append(shell.title, planNode);

  const tablist = el('div', { class: 'tabs portal__tabs', id: 'portal-tabs', role: 'tablist', 'aria-label': 'Account sections' });
  const main = el('div', { class: 'portal__main' });
  statusNode = el('div', { class: 'notice portal__status', id: 'portal-status', role: 'status' });
  main.append(statusNode);

  for (const tab of TABS) {
    const control = el(
      'button',
      {
        class: 'tabs__tab portal__tab',
        type: 'button',
        role: 'tab',
        id: `portal-tab-${tab.id}`,
        'aria-controls': `portal-panel-${tab.id}`,
        'aria-selected': 'false',
        tabindex: '-1',
        onClick: () => selectTab(tab.id),
      },
      icon(tab.icon),
      el('span', { text: tab.label }),
    );
    const panel = el('div', { class: 'portal__panel', id: `portal-panel-${tab.id}`, role: 'tabpanel', 'aria-labelledby': `portal-tab-${tab.id}`, tabindex: '-1', hidden: true });
    parts.set(tab.id, { tab: control, panel });
    tablist.append(control);
    main.append(panel);
  }
  on(tablist, 'keydown', (event) => moveTab(event, TABS.map((tab) => tab.id), activeTab, (id) => selectTab(id, { focus: true })));

  dialog.append(el('div', { class: 'portal__layout' }, tablist, main));

  controller = dialogController(dialog, {
    initialFocus: () => parts.get(activeTab).tab,
    // A recovery code that replaced the old one stays up until it is saved.
    canDismiss: () => !(freshRecovery && activeTab === 'security'),
    onClose: () => {
      clearInterval(countdown);
      countdown = null;
      confirming = '';
      flash = null;
      // A token or a code that was not dismissed is kept in memory: closing
      // the sheet by its Close button must not lose a code that already
      // replaced the old one. It is shown again when the sheet reopens.
    },
  });

  subscribeAccount((account) => {
    // Another session, or none: nothing loaded so far belongs on screen.
    if (sessionChanged(account)) {
      forgetAccount();
      if (!account.signedIn) closePortal();
      else if (isPortalOpen()) load();
    }
    if (isPortalOpen() && !confirming && (activeTab === 'overview' || activeTab === 'billing')) render();
    else if (planNode) planNode.replaceChildren(planChip(account));
  });
}

/**
 * Opens the account sheet. Call it for a signed-in user.
 *
 * @param {{ tab?: string, error?: ApiError, message?: { tone?: string, title: string, body?: string } }} [options]
 *   `tab` selects a section. `error` and `message` are shown above it.
 * @returns {Promise<string>} Resolves when the sheet closes.
 */
export function openPortal({ tab, error, message } = {}) {
  build();
  if (sessionChanged(currentAccount())) forget();
  if (tab && parts.has(tab)) activeTab = tab;
  // An unsaved recovery code comes first: the old one is already gone.
  if (freshRecovery) activeTab = 'security';
  confirming = '';
  if (error) showFlash(failure(error));
  else if (message) showFlash({ tone: message.tone ?? 'info', title: message.title, body: message.body });
  else flash = null;

  render();
  const closed = controller.open();
  clearInterval(countdown);
  countdown = setInterval(tick, COUNTDOWN_MS);
  load();
  return closed;
}

export function closePortal() {
  controller?.close();
}
