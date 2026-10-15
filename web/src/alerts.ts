// Owner alerts. The */15 cron reads the RunPod funding level and whether model
// inference is selling, and emails the owner when the balance runs low or
// sales pause, so nobody has to watch the dashboard. This module only reads
// and sends: it never starts a worker, moves money or touches customer data.

import { SUPPORT_EMAIL } from './env.ts';
import type { Env } from './env.ts';
import { inferenceStatus } from './inference.ts';

const RUNPOD_GRAPHQL = 'https://api.runpod.io/graphql';
const ALERT_FROM = 'alerts@bountyoperator.com';
const DAY = 86400;
// Used when RUNPOD_ALERT_USD is unset or unreadable. USD.
const DEFAULT_THRESHOLD_USD = 10;

// The hosting account exposes its balance through the same GraphQL endpoint the
// pause check uses, with the same 5-second budget and no-follow of redirects.
interface RunpodBalance {
  clientBalance: number | null;
  underBalance: boolean;
}

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
  const value = Number(env.RUNPOD_ALERT_USD);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_THRESHOLD_USD;
}

function money(balance: number | null): string {
  return balance === null ? 'unknown' : `$${balance.toFixed(2)}`;
}

/** Reads the hosting account balance. Returns null on any failure, so a bad read sends nothing. */
async function runpodBalance(env: Env): Promise<RunpodBalance | null> {
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
    const result = await response.json() as { data?: { myself?: { clientBalance?: unknown; underBalance?: unknown } } };
    const myself = result?.data?.myself;
    if (!myself) return null;
    return {
      clientBalance: typeof myself.clientBalance === 'number' && Number.isFinite(myself.clientBalance) ? myself.clientBalance : null,
      underBalance: myself.underBalance === true,
    };
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
  // MIME wants CRLF line endings throughout, header block and body alike.
  return `${headers.join('\r\n')}\r\n\r\n${text.replace(/\r?\n/g, '\r\n')}\r\n`;
}

/** Sends one alert to the owner. Does nothing if no send_email binding is configured. */
async function sendOwnerEmail(env: Env, subject: string, text: string, now: number): Promise<boolean> {
  if (!env.ALERT_EMAIL) return false;
  // With a destination_address on the binding, this address must match it.
  const to = env.ALERT_EMAIL_TO || SUPPORT_EMAIL;
  const EmailMessageClass = await emailMessageCtor();
  await env.ALERT_EMAIL.send(new EmailMessageClass(ALERT_FROM, to, buildMime(ALERT_FROM, to, subject, text, now)));
  return true;
}

function lowBalanceEmail(balance: RunpodBalance, threshold: number): { subject: string; text: string } {
  const amount = money(balance.clientBalance);
  const reason = balance.underBalance
    ? 'RunPod reports the account is under its minimum balance, so serverless workers will not start and the Model API cannot sell.'
    : `The RunPod balance is ${amount}, below the $${threshold} alert threshold.`;
  return {
    subject: balance.underBalance ? 'Bounty Operator: RunPod account is out of funds' : 'Bounty Operator: RunPod balance is low',
    text: [
      'Bounty Operator automatic alert.',
      '',
      reason,
      `Current RunPod balance: ${amount}.`,
      '',
      'What to do: add funds at https://console.runpod.io/user/billing, or turn on RunPod auto-pay so the balance tops up on its own.',
      '',
      'While the balance is empty, model sales pause and customers cannot spend credit.',
    ].join('\n'),
  };
}

const INFERENCE_PAUSED = {
  subject: 'Bounty Operator: model inference paused',
  text: [
    'Bounty Operator automatic alert.',
    '',
    'Model inference has changed from available to paused, so the Model API is not selling right now.',
    '',
    'The usual cause is an empty RunPod balance. Add funds at https://console.runpod.io/user/billing, or turn on RunPod auto-pay.',
  ].join('\n'),
};

const INFERENCE_RECOVERED = {
  subject: 'Bounty Operator: model inference back online',
  text: [
    'Bounty Operator automatic alert.',
    '',
    'Model inference is available again. The Model API is back to selling.',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Per-condition bookkeeping, kept in the operator_alerts table.
// ---------------------------------------------------------------------------

async function readAlert(env: Env, id: string): Promise<{ last_sent: number; note: string | null } | null> {
  return env.DB.prepare('SELECT last_sent, note FROM operator_alerts WHERE id = ?').bind(id).first<{ last_sent: number; note: string | null }>();
}

async function writeAlert(env: Env, id: string, lastSent: number, note: string, now: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO operator_alerts (id, last_sent, note, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET last_sent = excluded.last_sent, note = excluded.note, updated_at = excluded.updated_at',
  ).bind(id, lastSent, note, now).run();
}

/** Low balance or underBalance: email at most once per 24 hours, and clear the hold when it recovers. */
async function checkBalance(env: Env, balance: RunpodBalance, now: number): Promise<string> {
  const threshold = balanceThreshold(env);
  const low = balance.underBalance || (balance.clientBalance !== null && balance.clientBalance < threshold);
  const prior = await readAlert(env, 'runpod_balance');
  if (!low) {
    // Recovered (or never low): reset so the next dip warns at once.
    if (prior && (prior.last_sent !== 0 || prior.note !== 'ok')) await writeAlert(env, 'runpod_balance', 0, 'ok', now);
    return 'ok';
  }
  if (prior && now - prior.last_sent < DAY) return 'suppressed';
  const { subject, text } = lowBalanceEmail(balance, threshold);
  await sendOwnerEmail(env, subject, text, now);
  await writeAlert(env, 'runpod_balance', now, 'low', now);
  return 'sent';
}

/** Inference flipping between available and paused: one email on each edge. */
async function checkInferenceTransition(env: Env, statusNow: string, now: number): Promise<string | null> {
  const prior = await readAlert(env, 'inference_status');
  const priorStatus = prior?.note ?? null;
  let edge: string | null = null;
  if (priorStatus === 'available' && statusNow === 'paused') edge = 'paused';
  else if (priorStatus === 'paused' && statusNow === 'available') edge = 'recovered';

  if (edge === 'paused') await sendOwnerEmail(env, INFERENCE_PAUSED.subject, INFERENCE_PAUSED.text, now);
  else if (edge === 'recovered') await sendOwnerEmail(env, INFERENCE_RECOVERED.subject, INFERENCE_RECOVERED.text, now);

  if (priorStatus !== statusNow) await writeAlert(env, 'inference_status', edge ? now : (prior?.last_sent ?? 0), statusNow, now);
  return edge;
}

/**
 * One watch pass, for the fifteen-minute cron. Reads the RunPod balance and the
 * current inference status, and warns the owner by email when either needs
 * attention. Never throws: a bad RunPod read, or a missing binding, is a quiet no-op.
 */
export async function monitorRunpod(env: Env, now: number): Promise<Record<string, unknown>> {
  if (!env.ALERT_EMAIL) return { status: 'disabled' };
  if (!env.RUNPOD_API_KEY) return { status: 'not_configured' };

  const result: Record<string, unknown> = { status: 'ok' };

  // Inference availability. inferenceStatus never throws and skips the network
  // entirely when inference is switched off, so a balance-only setup is cheap.
  const inferenceEdge = await checkInferenceTransition(env, await inferenceStatus(env), now);
  if (inferenceEdge) result.inference = inferenceEdge;

  // Funding level. A failed read warns about nothing and leaves prior state.
  const balance = await runpodBalance(env);
  if (!balance) {
    result.balance = 'unknown';
    return result;
  }
  result.balance = await checkBalance(env, balance, now);
  return result;
}
