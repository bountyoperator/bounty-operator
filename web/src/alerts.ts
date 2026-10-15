// Owner alerts. The */15 cron reads the RunPod account once, works out whether
// the Model API can sell, and emails the owner about every way sales can stop:
// a low RunPod balance, an account under its minimum balance, no model able to
// sell (supplier budget used up or ended, cost rule expired or missing), a cost
// rule or budget window close to its end, a supplier budget nearly used up, and
// a RunPod account that can no longer be read. Each condition sends at most one
// email per 24 hours. An unreadable RunPod answer changes nothing: it never
// sends a paused or a recovery email. This module only reads and sends: it
// never starts a worker, moves money or touches customer data.

import type { Env } from './env.ts';
import { inferenceSalesReport } from './inference.ts';
import type { SalesBlock, SalesReport } from './inference.ts';
import { currentSupplierBudgets } from './supplier-costs.ts';
import type { SupplierBudget } from './supplier-costs.ts';

const RUNPOD_GRAPHQL = 'https://api.runpod.io/graphql';
const RUNPOD_BILLING = 'https://console.runpod.io/user/billing';
const ALERT_FROM = 'alerts@bountyoperator.com';
const DAY = 86400;
// Warn this long before a cost rule or a budget window ends.
const ENDING_WARNING = 7 * DAY;
// Warn when a supplier budget window has less than this share of its limit left.
const BUDGET_LOW_SHARE = 0.2;
// Tell the owner the watch is blind after this long without one good RunPod read.
// Short, because only RunPod-hosted models sell: a read that keeps failing is an outage.
const UNREADABLE_AFTER = 3600;
// Used when RUNPOD_ALERT_USD is unset, blank or unreadable. USD.
const DEFAULT_THRESHOLD_USD = 10;
// One plain address. It goes into a header, so no spaces, angle brackets or line breaks.
const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const PROVIDER_NAMES: Readonly<Record<string, string>> = { runpod: 'RunPod', infron: 'Infron', orcarouter: 'OrcaRouter' };

interface RunpodAccount {
  clientBalance: number | null;
  underBalance: boolean;
}

interface Email { subject: string; lines: string[] }

// cloudflare:email cannot be imported outside the Workers runtime, so the
// constructor is pulled in lazily and only on the send path. Tests set a
// stand-in here so that path runs under node:test without the real module.
type EmailMessageCtor = new (from: string, to: string, raw: string) => EmailMessage;
let emailMessageOverride: EmailMessageCtor | null = null;

/** Test seam: supply a stand-in for cloudflare:email's EmailMessage. Pass null to clear. */
export function setEmailMessageForTests(ctor: EmailMessageCtor | null): void {
  emailMessageOverride = ctor;
}

async function emailMessageCtor(): Promise<EmailMessageCtor> {
  if (emailMessageOverride) return emailMessageOverride;
  const module = await import('cloudflare:email');
  return module.EmailMessage as unknown as EmailMessageCtor;
}

function balanceThreshold(env: Env): number {
  const raw = env.RUNPOD_ALERT_USD?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_THRESHOLD_USD;
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function micro(amount: number): string {
  return money(amount / 1_000_000);
}

function when(at: number): string {
  return `${new Date(at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function inDays(left: number): string {
  if (left < DAY) return 'in less than a day';
  const days = Math.floor(left / DAY);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function provider(name: string): string {
  return PROVIDER_NAMES[name] ?? name;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One read of the RunPod account. Only a 200 answer with no GraphQL errors and
 * a real boolean underBalance counts; anything else is null, and null changes
 * nothing downstream.
 */
async function readRunpod(env: Env): Promise<RunpodAccount | null> {
  try {
    const response = await fetch(RUNPOD_GRAPHQL, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ myself { clientBalance underBalance } }' }),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return null;
    }
    const result: unknown = await response.json();
    // GraphQL can answer 200 with errors beside partial data. Any error makes the answer unknown.
    if (!object(result) || (result.errors != null && !(Array.isArray(result.errors) && result.errors.length === 0))) return null;
    const myself = object(result.data) ? result.data.myself : undefined;
    if (!object(myself) || typeof myself.underBalance !== 'boolean') return null;
    const balance = myself.clientBalance;
    return { clientBalance: typeof balance === 'number' && Number.isFinite(balance) ? balance : null, underBalance: myself.underBalance };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The email itself: a minimal plain-text MIME message, built by hand.
// ---------------------------------------------------------------------------

function buildMime(from: string, to: string, subject: string, text: string, now: number): string {
  const headers = [
    `From: Bounty Operator Alerts <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@bountyoperator.com>`,
    `Date: ${new Date(now * 1000).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
  ];
  // 7bit promises plain ASCII; operator-entered names are the only text that
  // could break it. A header keeps no line break at all.
  const header = (value: string) => value.replace(/[^\x20-\x7e]/g, '?');
  const body = text.replace(/\r/g, '').replace(/[^\n\x20-\x7e]/g, '?');
  // MIME wants CRLF line endings throughout, header block and body alike.
  return `${headers.map(header).join('\r\n')}\r\n\r\n${body.replace(/\n/g, '\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// One watch pass, and the 24-hour slot each condition's email takes.
// ---------------------------------------------------------------------------

interface Pass {
  env: Env & { ALERT_EMAIL: SendEmail };
  to: string;
  now: number;
  /** The "Current RunPod balance" line every email ends with. */
  balance: string;
  sent: string[];
  held: string[];
  failed: string[];
  error?: string;
}

async function send(pass: Pass, email: Email): Promise<void> {
  const text = [
    'Bounty Operator automatic alert.',
    '',
    ...email.lines,
    '',
    `Current RunPod balance: ${pass.balance}.`,
    '',
    'The Worker checks every 15 minutes and sends each kind of alert at most once a day.',
  ].join('\n');
  const EmailMessageClass = await emailMessageCtor();
  await pass.env.ALERT_EMAIL.send(new EmailMessageClass(ALERT_FROM, pass.to, buildMime(ALERT_FROM, pass.to, email.subject, text, pass.now)));
}

/**
 * Emails the owner about one condition unless an email for it went out in the
 * last 24 hours. The slot is taken before sending, so two overlapping runs
 * cannot both send, and handed back when the send fails, so the next run tries
 * again. A failed send is recorded on the pass, never thrown.
 */
async function notify(pass: Pass, id: string, note: string, email: Email): Promise<'sent' | 'held' | 'failed'> {
  const { env, now } = pass;
  const claim = await env.DB.prepare(
    'INSERT INTO operator_alerts (id, last_sent, note, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET last_sent = excluded.last_sent, note = excluded.note, updated_at = excluded.updated_at ' +
    'WHERE operator_alerts.last_sent <= ?',
  ).bind(id, now, note, now, now - DAY).run();
  if (claim.meta.changes !== 1) {
    pass.held.push(id);
    return 'held';
  }
  try {
    await send(pass, email);
  } catch (error) {
    await env.DB.prepare('UPDATE operator_alerts SET last_sent = 0, updated_at = ? WHERE id = ? AND last_sent = ?').bind(now, id, now).run();
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    pass.failed.push(id);
    pass.error ??= message;
    console.error('Owner alert email failed', { condition: id, message });
    return 'failed';
  }
  pass.sent.push(id);
  return 'sent';
}

/** A row that only remembers state (last sales status, failing-since time); it never sends. */
async function readState(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT note FROM operator_alerts WHERE id = ?').bind(id).first<{ note: string | null }>();
  return row?.note ?? null;
}

async function writeState(env: Env, id: string, note: string, now: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO operator_alerts (id, last_sent, note, updated_at) VALUES (?, 0, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at',
  ).bind(id, note, now).run();
}

// ---------------------------------------------------------------------------
// What each email says.
// ---------------------------------------------------------------------------

const ADD_FUNDS = `What to do: add funds at ${RUNPOD_BILLING}, or turn on RunPod auto-pay so the balance tops up on its own.`;

function underBalanceEmail(status: SalesReport['status']): Email {
  const effect = {
    paused: 'The Model API is not selling: every model that could sell runs on RunPod. Customers cannot spend credit or buy more until the account is funded.',
    available: 'Models on other providers still sell, but the RunPod-hosted models cannot run.',
    unavailable: 'Model sales have also stopped for another reason; a separate email explains it.',
    off: 'Model inference is switched off (INFERENCE_ENABLED), so nothing is on sale either way.',
    unknown: 'Whether any model can still sell is not known.',
  }[status];
  return {
    subject: status === 'paused' ? 'Bounty Operator: RunPod is out of funds and model sales are paused' : 'Bounty Operator: RunPod account is out of funds',
    lines: ['RunPod reports the account is under its minimum balance, so no RunPod worker can start.', effect, '', ADD_FUNDS],
  };
}

function lowBalanceEmail(threshold: number): Email {
  return {
    subject: 'Bounty Operator: RunPod balance is low',
    lines: [
      `The RunPod balance has dropped below the ${money(threshold)} alert threshold (RUNPOD_ALERT_USD).`,
      'When it runs out, RunPod workers stop and the models hosted there stop selling.',
      '',
      ADD_FUNDS,
    ],
  };
}

const BLOCK_REASONS: Readonly<Record<SalesBlock, string>> = {
  no_cost_rule: 'no valid SUPPLIER_COST_RULES entry prices it',
  cost_rule_expired: 'its SUPPLIER_COST_RULES entry has expired',
  no_budget_window: 'no enabled, funded supplier budget window covers now for its provider (the window ended, is disabled, or was never opened)',
  budget_exhausted: "its provider's supplier budget window is used up",
  usage_check: 'a request in the last ten minutes reported usage beyond its limits, so it is held while that is checked',
};

const BLOCK_FIXES: Readonly<Record<SalesBlock, string>> = {
  no_cost_rule: 'Add a verified quote for the model to SUPPLIER_COST_RULES and deploy. One invalid entry makes the whole list ignored.',
  cost_rule_expired: "Renew the expired SUPPLIER_COST_RULES entry: check the provider's current price, update its rates, revision, source and validUntil, and deploy.",
  no_budget_window: 'Open a funded supplier_budget_windows row for that provider: enabled = 1, covering now, limit_micro above zero.',
  budget_exhausted: 'Raise limit_micro on the current supplier_budget_windows row for that provider, after recording the matching supplier funding.',
  usage_check: 'This clears by itself after ten minutes. If it repeats, look at inference_requests rows with failure_code usage_limit_exceeded.',
};

function blockedLines(report: SalesReport): string[] {
  return report.blocked.map((block) => {
    const rule = report.rules.find((entry) => entry.id === block.id);
    const reason = block.reason === 'cost_rule_expired' && rule ? `its SUPPLIER_COST_RULES entry expired on ${when(rule.validUntil)}` : BLOCK_REASONS[block.reason];
    return `- ${block.id}: ${reason}.`;
  });
}

function stoppedEmail(report: SalesReport): Email {
  const why = report.noModels
    ? ['No model in INFERENCE_MODELS is usable: the list is empty or invalid, or every model is disabled or missing its provider key.']
    : ['Why, model by model:', ...blockedLines(report)];
  const fixes = report.noModels
    ? ['- Check INFERENCE_MODELS and the provider secrets (RUNPOD_API_KEY, INFRON_API_KEY, ORCAROUTER_API_KEY), or set INFERENCE_ENABLED to "false" if sales should be off.']
    : [...new Set(report.blocked.map((block) => BLOCK_FIXES[block.reason]))].map((fix) => `- ${fix}`);
  return {
    subject: 'Bounty Operator: model sales have stopped',
    lines: [
      'The Model API is not selling: inference is switched on, but no model can take a paid request, so new top-ups are closed too.',
      '',
      ...why,
      '',
      'What to do:',
      ...fixes,
      '',
      'You will get one email when sales resume. While they stay stopped, this email repeats once a day.',
    ],
  };
}

/**
 * A RunPod pause that stops sales, when the out-of-funds email for the day has
 * already gone out and so cannot carry it. Same stop, said once.
 */
function pausedEmail(report: SalesReport): Email {
  const also = report.blocked.length ? ['', 'Other models, and why they cannot sell:', ...blockedLines(report)] : [];
  return {
    subject: 'Bounty Operator: model sales have stopped, RunPod is out of funds',
    lines: [
      'The Model API is not selling: RunPod reports the account under its minimum balance and no model on another provider can sell, so no model can take a paid request and new top-ups are closed too.',
      ...also,
      '',
      ADD_FUNDS,
      '',
      'You will get one email when sales resume.',
    ],
  };
}

function resumedEmail(report: SalesReport, heldUntil: number | null): Email {
  const still = report.blocked.length ? ['', 'Still not selling:', ...blockedLines(report)] : [];
  // The stop that just ended holds its slot for the rest of the day, so say so rather than leave this the last word.
  const held = heldUntil ? ['', `If sales stop the same way again before ${when(heldUntil)}, the email about it waits until then.`] : [];
  return {
    subject: 'Bounty Operator: model sales are back',
    lines: ['The Model API is selling again: at least one model can take paid requests.', ...still, ...held],
  };
}

function ruleEmail(rule: SalesReport['rules'][number], now: number): Email {
  const name = provider(rule.provider);
  const expired = rule.validUntil <= now;
  return {
    subject: expired ? `Bounty Operator: the cost rule for ${rule.id} has expired` : `Bounty Operator: the cost rule for ${rule.id} expires ${inDays(rule.validUntil - now)}`,
    lines: [
      expired
        ? `The SUPPLIER_COST_RULES entry for ${rule.id} (${name}) expired on ${when(rule.validUntil)}. ${rule.id} has not sold since: the gateway admits no request without an unexpired cost rule.`
        : `The SUPPLIER_COST_RULES entry for ${rule.id} (${name}) is valid until ${when(rule.validUntil)}, ${inDays(rule.validUntil - now)}. When it expires, ${rule.id} stops selling: the gateway admits no request without an unexpired cost rule.`,
      '',
      `What to do: check ${name}'s current price, update the entry's rates, revision, source and validUntil, and deploy.`,
      '',
      'This warning repeats once a day until the rule is renewed.',
    ],
  };
}

function budgetEndingEmail(budget: SupplierBudget, now: number): Email {
  const name = provider(budget.provider);
  return {
    subject: `Bounty Operator: the ${name} supplier budget ends ${inDays(budget.ends_at - now)}`,
    lines: [
      `The ${name} supplier budget window ${budget.id} ends on ${when(budget.ends_at)}, ${inDays(budget.ends_at - now)}, and no funded window follows it.`,
      `When it ends, the ${name} models stop selling.`,
      '',
      `What to do: add a funded supplier_budget_windows row for ${budget.provider} that starts when this one ends (enabled = 1, limit_micro above zero), or move this window's ends_at later.`,
      '',
      'This warning repeats once a day until a window follows it.',
    ],
  };
}

function budgetLowEmail(budget: SupplierBudget, remaining: number, exhausted: boolean, status: SalesReport['status']): Email {
  const name = provider(budget.provider);
  const share = budget.limit_micro > 0 ? Math.max(0, Math.floor((remaining / budget.limit_micro) * 100)) : 0;
  // What is left on sale once this provider's models stop.
  const rest = {
    available: 'Models on other providers still sell.',
    paused: 'Nothing else is selling either: RunPod reports the account under its minimum balance.',
    unknown: 'Whether anything else still sells is not known: the RunPod account could not be read.',
    unavailable: 'Nothing else is selling either; a separate email explains it.',
    off: 'Model inference is switched off (INFERENCE_ENABLED), so nothing is on sale either way.',
  }[status];
  return {
    subject: exhausted ? `Bounty Operator: the ${name} supplier budget is used up` : `Bounty Operator: the ${name} supplier budget is nearly used up`,
    lines: [
      `The ${name} supplier budget window ${budget.id} has ${micro(Math.max(0, remaining))} of ${micro(budget.limit_micro)} left (${share}%).`,
      exhausted
        ? `That is too little to hold one more request, so the ${name} models have stopped selling. ${rest}`
        : `When too little is left to hold one more request, the ${name} models stop selling.`,
      '',
      'What to do: record the matching supplier funding, then raise limit_micro on this supplier_budget_windows row.',
    ],
  };
}

function unreadableEmail(since: number, status: SalesReport['status']): Email {
  return {
    subject: 'Bounty Operator: the RunPod account cannot be read',
    lines: [
      `Every read of the RunPod account since ${when(since)} has failed, so the balance and pause alerts cannot see it.`,
      status === 'unknown'
        ? 'Only RunPod-hosted models can sell, and a model whose funding cannot be read takes no paid request: the Model API is selling nothing and taking no top-up while the read keeps failing.'
        : 'RunPod-hosted model sales may stop without a warning while this lasts.',
      '',
      'What to do: check that the RUNPOD_API_KEY secret is still valid (a rotated or revoked key fails) and that https://api.runpod.io/graphql answers.',
    ],
  };
}

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------

/** Remembers when RunPod reads started failing, and says so once the watch has been blind for an hour. */
async function checkRunpodRead(pass: Pass, account: RunpodAccount | null, status: SalesReport['status']): Promise<'read' | 'unreadable'> {
  const { env, now } = pass;
  const state = await readState(env, 'runpod_read');
  if (account) {
    if (state !== 'ok') await writeState(env, 'runpod_read', 'ok', now);
    return 'read';
  }
  const since = state && /^\d{1,12}$/.test(state) ? Number(state) : null;
  if (since === null) await writeState(env, 'runpod_read', String(now), now);
  else if (now - since >= UNREADABLE_AFTER) await notify(pass, 'runpod_unreadable', `failing since ${since}`, unreadableEmail(since, status));
  return 'unreadable';
}

/**
 * Under its minimum balance, or below RUNPOD_ALERT_USD. Only a good read gets
 * here. True when the out-of-funds email of this pass carries the sales stop,
 * so that checkSales does not send a second email about the same stop.
 */
async function checkBalance(pass: Pass, account: RunpodAccount, status: SalesReport['status']): Promise<boolean> {
  if (account.underBalance) {
    const outcome = await notify(pass, 'runpod_under_balance', 'under balance', underBalanceEmail(status));
    // Held means an earlier email took the slot, and that one may have gone out while other models still sold.
    // A failed send hands the slot back, and the next run sends this same email, stop and all.
    return status === 'paused' && outcome !== 'held';
  }
  const threshold = balanceThreshold(pass.env);
  if (account.clientBalance !== null && account.clientBalance < threshold) {
    await notify(pass, 'runpod_balance_low', `below ${money(threshold)}`, lowBalanceEmail(threshold));
  }
  return false;
}

/**
 * When the next email about a stop like this one could go out, or null when it
 * could go out now. A budget stop has one slot. A RunPod pause is announced by
 * whichever of its two slots is free, so it waits only while both are held,
 * and then until the earlier of the two frees.
 */
async function stopHeldUntil(env: Env, prior: string, now: number): Promise<number | null> {
  const ids = prior === 'paused' ? ['model_sales_paused', 'runpod_under_balance'] : ['model_sales_stopped'];
  let earliest = Infinity;
  for (const id of ids) {
    const row = await env.DB.prepare('SELECT last_sent FROM operator_alerts WHERE id = ?').bind(id).first<{ last_sent: number }>();
    const free = row ? row.last_sent + DAY : 0;
    if (free <= now) return null;
    earliest = Math.min(earliest, free);
  }
  return earliest;
}

/**
 * Sales stopped (inference on, no model can sell) and a move into a RunPod
 * pause are each reported once a day while they last; a pause the combined
 * out-of-funds email already carried is not repeated here. When sales come
 * back after a stop or a pause, one email says so. 'unknown' is no change: the
 * last known status is kept.
 */
async function checkSales(pass: Pass, report: SalesReport, announced: boolean): Promise<void> {
  const { env, now } = pass;
  if (report.status === 'unknown') return;
  const prior = await readState(env, 'model_sales');
  let outcome: string | null = null;
  if (report.status === 'unavailable') {
    const note = report.noModels ? 'no models' : report.blocked.map((block) => `${block.id}:${block.reason}`).join(' ');
    await notify(pass, 'model_sales_stopped', note.slice(0, 500), stoppedEmail(report));
  } else if (report.status === 'paused' && prior !== 'paused' && !announced) {
    outcome = await notify(pass, 'model_sales_paused', 'runpod under balance', pausedEmail(report));
  } else if (report.status === 'available' && (prior === 'unavailable' || prior === 'paused')) {
    outcome = await notify(pass, 'model_sales_resumed', `after ${prior}`, resumedEmail(report, await stopHeldUntil(env, prior, now)));
  }
  // A stop or recovery email that failed to send keeps the old status, so the next run tries again.
  if (prior !== report.status && outcome !== 'failed') await writeState(env, 'model_sales', report.status, now);
}

/** Cost rules and budget windows that will stop sales soon, and budgets nearly used up. */
async function checkSupply(pass: Pass, report: SalesReport): Promise<void> {
  const { env, now } = pass;
  if (report.status === 'off') return;
  for (const rule of report.rules) {
    const left = rule.validUntil - now;
    if (left >= ENDING_WARNING) continue;
    // With no model selling, the sales-stopped email already names an expired rule.
    if (left <= 0 && report.status === 'unavailable') continue;
    await notify(pass, `supplier_rule:${rule.id}`, `valid until ${rule.validUntil}`, ruleEmail(rule, now));
  }
  const providers = new Set(report.rules.filter((rule) => rule.validUntil > now).map((rule) => rule.provider));
  if (!providers.size) return;
  for (const budget of await currentSupplierBudgets(env, now)) {
    if (!providers.has(budget.provider)) continue;
    if (budget.ends_at - now < ENDING_WARNING && !budget.continued) {
      await notify(pass, `budget_ending:${budget.id}`, `ends ${budget.ends_at}`, budgetEndingEmail(budget, now));
    }
    const remaining = budget.limit_micro - budget.reserved_micro - budget.consumed_micro;
    // With no model selling, the sales-stopped email already says a budget is used up.
    if (report.status !== 'unavailable' && budget.limit_micro > 0 && remaining < budget.limit_micro * BUDGET_LOW_SHARE) {
      const exhausted = report.blocked.some((block) => block.reason === 'budget_exhausted' && report.rules.some((rule) => rule.id === block.id && rule.provider === budget.provider));
      await notify(pass, `budget_low:${budget.id}`, `${remaining} of ${budget.limit_micro} left`, budgetLowEmail(budget, remaining, exhausted, report.status));
    }
  }
}

/**
 * One watch pass, for the fifteen-minute cron. Off without the ALERT_EMAIL
 * binding; not configured without ALERT_EMAIL_TO, the address the binding's
 * destination_address pins (there is no default recipient). A failed send is
 * logged and reported in the result, and its condition retries on the next
 * run. A D1 failure is thrown, for the caller to log.
 */
export async function monitorRunpod(env: Env, now: number): Promise<Record<string, unknown>> {
  if (!env.ALERT_EMAIL) return { status: 'disabled' };
  const to = env.ALERT_EMAIL_TO?.trim() ?? '';
  if (!ADDRESS.test(to)) return { status: 'not_configured', missing: 'ALERT_EMAIL_TO' };

  // One RunPod read per pass decides both the balance and the RunPod pause.
  const account = env.RUNPOD_API_KEY ? await readRunpod(env) : null;
  const balance = !env.RUNPOD_API_KEY ? 'not checked (no RUNPOD_API_KEY)'
    : !account ? 'could not be read'
      : account.clientBalance === null ? 'not reported by RunPod' : money(account.clientBalance);
  const pass: Pass = { env: env as Pass['env'], to, now, balance, sent: [], held: [], failed: [] };
  const report = await inferenceSalesReport(env, !account ? 'unknown' : account.underBalance ? 'paused' : 'funded', now);

  const runpod = env.RUNPOD_API_KEY ? await checkRunpodRead(pass, account, report.status) : 'not_configured';
  const announced = account ? await checkBalance(pass, account, report.status) : false;
  await checkSales(pass, report, announced);
  await checkSupply(pass, report);

  return {
    status: pass.failed.length ? 'error' : 'ok',
    runpod,
    balance: account?.clientBalance ?? null,
    sales: report.status,
    sent: pass.sent,
    held: pass.held,
    ...(pass.failed.length ? { failed: pass.failed, error: pass.error } : {}),
  };
}
