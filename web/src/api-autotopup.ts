// Explicit, revocable consent for automatic prepaid API purchases. Stripe
// holds payment credentials; the database holds consent and one pending charge.
import type Stripe from 'stripe';
import { MICRO_USD, TOPUP_USD } from './api-credits.ts';
import { API_PAYMENT_TAG, localStripeTest, syncApiTopup } from './api-topups.ts';
import type { Topup } from './api-topups.ts';
import { sha256 } from './crypto.ts';
import { seconds } from './env.ts';
import type { Env } from './env.ts';
import { ApiError } from './http.ts';
import { inferenceStatus } from './inference.ts';

const SETUP_TAG = 'bounty-operator-api-autotopup';
const CONSENT_VERSION = 'api-autotopup-2026-10-14';
const THRESHOLDS = [5, 10, 20];
const CAPS = [20, 50, 100, 200, 500];
const idOf = (value: string | { id: string } | null | undefined): string | null => typeof value === 'string' ? value : value?.id ?? null;
const utcMonth = (now: number): string => new Date(now * 1000).toISOString().slice(0, 7);

interface Settings {
  account_id: string; customer_id: string; enabled: number; amount_micro: number; threshold_micro: number; monthly_cap_micro: number;
  payment_method: string | null; payment_method_summary: string | null; setup_id: string | null; revision: number;
  consent_at: number | null; consent_version: string | null; pause_reason: string | null; next_check_at: number; updated_at: number;
}
interface Setup {
  id: string; account_id: string | null; customer_id: string; checkout_id: string | null; setup_intent: string | null;
  amount_micro: number; threshold_micro: number; monthly_cap_micro: number; consent_at: number; consent_version: string;
  settings_revision: number; status: string; created_at: number;
}
interface Configuration { amount: number; threshold: number; cap: number }

export async function autoTopupAvailable(env: Env): Promise<boolean> {
  const live = env.BILLING_MODE === 'live' && /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? '') && Boolean(env.STRIPE_PRICE_ID);
  return env.API_AUTOTOPUPS_ENABLED === 'true' && env.API_TOPUPS_ENABLED === 'true' &&
    Boolean(env.STRIPE_WEBHOOK_SECRET) && (live || localStripeTest(env)) && (await inferenceStatus(env)) === 'available';
}

function configuration(body: Record<string, unknown>): Configuration {
  const { amount_usd: amount, threshold_usd: threshold, monthly_cap_usd: cap } = body;
  if (typeof amount !== 'number' || !(TOPUP_USD as readonly number[]).includes(amount)) throw new ApiError('Choose a $20, $50 or $100 automatic top-up.');
  if (typeof threshold !== 'number' || !THRESHOLDS.includes(threshold) || threshold >= amount) throw new ApiError('Choose a $5, $10 or $20 threshold below the top-up amount.');
  if (typeof cap !== 'number' || !CAPS.includes(cap) || cap < amount) throw new ApiError('Choose a monthly limit of $20, $50, $100, $200 or $500, at least the top-up amount.');
  if (body.consent !== true) throw new ApiError('Explicit consent is required for automatic top-ups.', 400, 'consent_required');
  return { amount: amount * MICRO_USD, threshold: threshold * MICRO_USD, cap: cap * MICRO_USD };
}

async function requireAvailable(env: Env): Promise<void> {
  if (!(await autoTopupAvailable(env))) throw new ApiError('Automatic API top-ups are not open right now.', 503, 'topups_unavailable');
}

function methodSummary(method: Stripe.PaymentMethod): string {
  return JSON.stringify({ type: method.type, brand: method.card?.brand ?? null,
    last4: method.card?.last4 ?? method.us_bank_account?.last4 ?? method.sepa_debit?.last4 ?? method.au_becs_debit?.last4 ?? null,
    exp_month: method.card?.exp_month ?? null, exp_year: method.card?.exp_year ?? null });
}

export async function autoTopupData(env: Env, accountId: string): Promise<Record<string, unknown>> {
  const month = utcMonth(seconds());
  const [settings, usage, available] = await Promise.all([
    env.DB.prepare('SELECT * FROM api_autotopup_settings WHERE account_id = ?').bind(accountId).first<Settings>(),
    env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN auto_month = ? AND status IN ('pending', 'paid') THEN amount_micro ELSE 0 END), 0) AS spent,
      COALESCE(MAX(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending FROM api_topups WHERE account_id = ? AND source = 'automatic'`)
      .bind(month, accountId).first<{ spent: number; pending: number }>(),
    autoTopupAvailable(env),
  ]);
  const amount = settings?.amount_micro ?? 20 * MICRO_USD;
  const cap = settings?.monthly_cap_micro ?? 100 * MICRO_USD;
  return { available, enabled: Boolean(settings?.enabled),
    status: settings?.enabled ? 'enabled' : settings?.pause_reason ? 'paused' : settings?.setup_id ? 'setup_pending' : 'off',
    amount_usd: amount / MICRO_USD, threshold_usd: (settings?.threshold_micro ?? 5 * MICRO_USD) / MICRO_USD,
    monthly_cap_usd: cap / MICRO_USD, spent_this_month_usd: (usage?.spent ?? 0) / MICRO_USD, month,
    payment_method: settings?.payment_method_summary ? JSON.parse(settings.payment_method_summary) : null,
    pause_reason: settings?.pause_reason ?? null, pending: Boolean(usage?.pending), cap_reached: (usage?.spent ?? 0) + amount > cap };
}

/** The saved method remains disabled until a verified setup webhook arrives. */
export async function createAutoTopupSetup(env: Env, api: Stripe, accountId: string, customer: string, body: Record<string, unknown>): Promise<string> {
  await requireAvailable(env);
  const config = configuration(body);
  if (typeof body.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.request_id)) throw new ApiError('A setup request ID is required.');
  const id = await sha256(`auto-setup:${accountId}:${body.request_id}`);
  const now = seconds();
  // All four statements are one transaction. Only a new setup reservation may
  // change the settings revision; a retried old request cannot undo a disable.
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO api_autotopup_settings(account_id, customer_id, updated_at) VALUES(?, ?, ?)').bind(accountId, customer, now),
    env.DB.prepare(`INSERT OR IGNORE INTO api_autotopup_setups(id, account_id, customer_id, amount_micro, threshold_micro, monthly_cap_micro, consent_at, consent_version, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, accountId, customer, config.amount, config.threshold, config.cap, now, CONSENT_VERSION, now, now),
    env.DB.prepare(`UPDATE api_autotopup_settings SET enabled = 0, amount_micro = ?, threshold_micro = ?, monthly_cap_micro = ?, setup_id = ?,
      consent_at = ?, consent_version = ?, pause_reason = NULL, revision = revision + 1, updated_at = ?
      WHERE account_id = ? AND customer_id = ? AND EXISTS(SELECT 1 FROM api_autotopup_setups WHERE id = ? AND settings_revision = 0 AND status = 'pending')`)
      .bind(config.amount, config.threshold, config.cap, id, now, CONSENT_VERSION, now, accountId, customer, id),
    env.DB.prepare(`UPDATE api_autotopup_setups SET settings_revision = (SELECT revision FROM api_autotopup_settings WHERE account_id = ? AND setup_id = ?)
      WHERE id = ? AND settings_revision = 0`).bind(accountId, id, id),
  ]);
  const row = await env.DB.prepare('SELECT * FROM api_autotopup_setups WHERE id = ?').bind(id).first<Setup>();
  if (!row || row.account_id !== accountId || row.customer_id !== customer || row.amount_micro !== config.amount || row.threshold_micro !== config.threshold || row.monthly_cap_micro !== config.cap) throw new ApiError('This setup request has already been used.', 409, 'setup_conflict');
  const current = await env.DB.prepare('SELECT * FROM api_autotopup_settings WHERE account_id = ?').bind(accountId).first<Settings>();
  if (row.status !== 'pending' || current?.setup_id !== id || current.revision !== row.settings_revision) throw new ApiError('This setup has ended. Start a new setup.', 409, 'setup_ended');
  if (row.checkout_id) {
    const existing = await api.checkout.sessions.retrieve(row.checkout_id);
    if (existing.status === 'open' && existing.url) return existing.url;
    throw new ApiError('This setup has ended. Refresh your account.', 409, 'setup_ended');
  }
  if (row.created_at < now - 1700) throw new ApiError('This setup request has expired. Start a new setup.', 409, 'setup_ended');
  const session = await api.checkout.sessions.create({
    mode: 'setup', currency: 'usd', customer, client_reference_id: accountId,
    metadata: { app: SETUP_TAG, setup_id: id, account_id: accountId },
    setup_intent_data: { metadata: { app: SETUP_TAG, setup_id: id, account_id: accountId }, description: 'Optional automatic API credit top-ups' },
    success_url: `${env.SITE_ORIGIN}/?api_autotopup=complete#account/api`,
    cancel_url: `${env.SITE_ORIGIN}/?api_autotopup=cancelled#account/api`,
    expires_at: row.created_at + 3600,
    custom_text: { submit: { message: `Save this payment method for automatic US$${config.amount / MICRO_USD} API top-ups when available credit is below US$${config.threshold / MICRO_USD}, up to US$${config.cap / MICRO_USD} per UTC calendar month, until disabled in your account. [Terms](${env.SITE_ORIGIN}/terms).` } },
  }, { idempotencyKey: `api-auto-setup-${id}` });
  if (!session.url) throw new ApiError('Payment method setup could not be opened.', 503, 'billing_unavailable');
  await env.DB.prepare('UPDATE api_autotopup_setups SET checkout_id = ?, setup_intent = ?, updated_at = ? WHERE id = ? AND checkout_id IS NULL')
    .bind(session.id, idOf(session.setup_intent), seconds(), id).run();
  return session.url;
}

/** Updating or re-enabling a previously verified method needs fresh consent. */
export async function updateAutoTopup(env: Env, api: Stripe, accountId: string, body: Record<string, unknown>): Promise<void> {
  await requireAvailable(env);
  const config = configuration(body);
  const row = await env.DB.prepare('SELECT * FROM api_autotopup_settings WHERE account_id = ?').bind(accountId).first<Settings>();
  if (!row?.payment_method) throw new ApiError('Save a payment method through Stripe first.', 409, 'setup_required');
  const method = await api.paymentMethods.retrieve(row.payment_method);
  if (method.livemode !== !localStripeTest(env) || idOf(method.customer) !== row.customer_id) throw new ApiError('Save a payment method through Stripe again.', 409, 'setup_required');
  const changed = await env.DB.prepare(`UPDATE api_autotopup_settings SET enabled = 1, amount_micro = ?, threshold_micro = ?, monthly_cap_micro = ?,
    payment_method_summary = ?, setup_id = NULL, revision = revision + 1, consent_at = ?, consent_version = ?, pause_reason = NULL, next_check_at = ?, updated_at = ?
    WHERE account_id = ? AND revision = ? AND payment_method = ?`)
    .bind(config.amount, config.threshold, config.cap, methodSummary(method), seconds(), CONSENT_VERSION, seconds(), seconds(), accountId, row.revision, row.payment_method).run();
  if (!changed.meta.changes) throw new ApiError('Settings changed in another request. Refresh your account.', 409, 'settings_conflict');
}

/** No Stripe call is needed to revoke consent, including during an outage. */
export async function disableAutoTopup(env: Env, accountId: string): Promise<void> {
  const now = seconds();
  await env.DB.batch([
    env.DB.prepare('UPDATE api_autotopup_settings SET enabled = 0, setup_id = NULL, pause_reason = NULL, revision = revision + 1, updated_at = ? WHERE account_id = ?').bind(now, accountId),
    env.DB.prepare("UPDATE api_autotopup_setups SET status = 'cancelled', updated_at = ? WHERE account_id = ? AND status = 'pending'").bind(now, accountId),
    env.DB.prepare("UPDATE api_topups SET status = 'failed', updated_at = ? WHERE account_id = ? AND source = 'automatic' AND status = 'pending' AND initiated_at = 0").bind(now, accountId),
  ]);
}

async function syncSetup(env: Env, api: Stripe, row: Setup): Promise<void> {
  if (row.status !== 'pending' || !row.account_id || !row.checkout_id) return;
  const session = await api.checkout.sessions.retrieve(row.checkout_id, { expand: ['setup_intent.payment_method'] });
  if (session.livemode !== !localStripeTest(env) || session.mode !== 'setup' || session.currency !== 'usd' || idOf(session.customer) !== row.customer_id ||
    session.client_reference_id !== row.account_id || session.metadata?.app !== SETUP_TAG || session.metadata?.setup_id !== row.id || session.metadata?.account_id !== row.account_id) throw new Error('Automatic top-up setup verification failed');
  if (session.status === 'expired') {
    await env.DB.batch([
      env.DB.prepare("UPDATE api_autotopup_setups SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(seconds(), row.id),
      env.DB.prepare('UPDATE api_autotopup_settings SET setup_id = NULL, updated_at = ? WHERE account_id = ? AND setup_id = ? AND revision = ?').bind(seconds(), row.account_id, row.id, row.settings_revision),
    ]);
    return;
  }
  const setup = session.setup_intent && (typeof session.setup_intent === 'string' ? await api.setupIntents.retrieve(session.setup_intent, { expand: ['payment_method'] }) : session.setup_intent);
  if (session.status !== 'complete' || !setup || setup.status !== 'succeeded') return;
  if (setup.livemode !== !localStripeTest(env) || setup.usage !== 'off_session' || idOf(setup.customer) !== row.customer_id ||
    setup.metadata?.app !== SETUP_TAG || setup.metadata?.setup_id !== row.id || setup.metadata?.account_id !== row.account_id) throw new Error('Automatic top-up consent verification failed');
  if (!setup.payment_method) throw new Error('Automatic top-up method missing');
  const method = typeof setup.payment_method === 'string' ? await api.paymentMethods.retrieve(setup.payment_method) : setup.payment_method;
  if (method.livemode !== !localStripeTest(env) || idOf(method.customer) !== row.customer_id) throw new Error('Automatic top-up payment method ownership failed');
  await env.DB.batch([
    env.DB.prepare(`UPDATE api_autotopup_settings SET enabled = 1, payment_method = ?, payment_method_summary = ?, setup_id = NULL,
      pause_reason = NULL, next_check_at = ?, updated_at = ? WHERE account_id = ? AND setup_id = ? AND revision = ? AND customer_id = ?`)
      .bind(method.id, methodSummary(method), seconds(), seconds(), row.account_id, row.id, row.settings_revision, row.customer_id),
    env.DB.prepare("UPDATE api_autotopup_setups SET status = 'confirmed', setup_intent = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(setup.id, seconds(), row.id),
  ]);
}

/** Called only after Stripe webhook signature/environment verification. */
export async function applyAutoTopupSetupEvent(env: Env, api: Stripe, event: Stripe.Event): Promise<boolean> {
  if (event.type === 'payment_method.detached') {
    const method = event.data.object as Stripe.PaymentMethod;
    const current = await api.paymentMethods.retrieve(method.id);
    await env.DB.prepare(`UPDATE api_autotopup_settings SET enabled = 0, pause_reason = 'payment_method_unavailable', setup_id = NULL,
      payment_method = NULL, payment_method_summary = NULL, revision = revision + 1, updated_at = ? WHERE payment_method = ? AND customer_id IS NOT ?`)
      .bind(seconds(), method.id, idOf(current.customer)).run();
    return true;
  }
  if (event.type.startsWith('checkout.session.')) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.app !== SETUP_TAG || !session.metadata.setup_id) return false;
    const row = await env.DB.prepare('SELECT * FROM api_autotopup_setups WHERE id = ?').bind(session.metadata.setup_id).first<Setup>();
    if (!row || row.account_id !== session.client_reference_id || row.account_id !== session.metadata.account_id || row.customer_id !== idOf(session.customer) || (row.checkout_id && row.checkout_id !== session.id)) throw new Error('Automatic top-up setup ownership failed');
    await env.DB.prepare('UPDATE api_autotopup_setups SET checkout_id = ? WHERE id = ? AND checkout_id IS NULL').bind(session.id, row.id).run();
    await syncSetup(env, api, { ...row, checkout_id: session.id });
    return true;
  }
  if (event.type.startsWith('setup_intent.')) {
    const setup = event.data.object as Stripe.SetupIntent;
    if (setup.metadata?.app !== SETUP_TAG || !setup.metadata.setup_id) return false;
    const row = await env.DB.prepare('SELECT * FROM api_autotopup_setups WHERE id = ?').bind(setup.metadata.setup_id).first<Setup>();
    if (!row || row.customer_id !== idOf(setup.customer) || row.account_id !== setup.metadata.account_id || (row.setup_intent && row.setup_intent !== setup.id)) throw new Error('Automatic top-up setup ownership failed');
    // Checkout's signed completion also binds sessions whose create response
    // was lost. An early SetupIntent event must not bypass that association.
    await syncSetup(env, api, row);
    return true;
  }
  return false;
}

async function pause(env: Env, row: Topup, reason = 'reconciliation_required'): Promise<void> {
  await env.DB.prepare('UPDATE api_autotopup_settings SET enabled = 0, pause_reason = ?, updated_at = ? WHERE account_id = ? AND revision = ?')
    .bind(reason, seconds(), row.account_id, row.auto_revision).run();
}

async function sendAttempt(env: Env, api: Stripe, row: Topup, now: number): Promise<void> {
  if (!row.account_id || !row.payment_method || !(await autoTopupAvailable(env))) return;
  // This compare-and-set is the send boundary. A disable before it wins; a
  // disable after it sees a payment already in progress, which may settle.
  const claimed = await env.DB.prepare(`UPDATE api_topups SET initiated_at = ?, updated_at = ? WHERE id = ? AND initiated_at = 0 AND status = 'pending' AND auto_month = ?
    AND EXISTS(SELECT 1 FROM api_autotopup_settings WHERE account_id = ? AND enabled = 1 AND revision = ? AND payment_method = ?)`)
    .bind(now, now, row.id, utcMonth(now), row.account_id, row.auto_revision, row.payment_method).run();
  if (!claimed.meta.changes) {
    await env.DB.prepare("UPDATE api_topups SET status = 'failed', updated_at = ? WHERE id = ? AND initiated_at = 0 AND status = 'pending'").bind(now, row.id).run();
    return;
  }
  try {
    const intent = await api.paymentIntents.create({
      amount: row.amount_micro / 10000, currency: 'usd', customer: row.customer_id, payment_method: row.payment_method,
      off_session: true, confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      description: 'Automatic BountyOperator API credit top-up',
      metadata: { app: API_PAYMENT_TAG, source: 'automatic', topup_id: row.id, account_id: row.account_id },
    }, { idempotencyKey: `api-autotopup-${row.id}` });
    await env.DB.prepare('UPDATE api_topups SET payment_intent = ?, updated_at = ? WHERE id = ? AND payment_intent IS NULL').bind(intent.id, seconds(), row.id).run();
    if (['requires_action', 'requires_payment_method', 'requires_confirmation', 'requires_capture', 'canceled'].includes(intent.status)) await syncApiTopup(env, api, row.id);
    // No credit here. Only the verified succeeded webhook authorizes it.
  } catch (error) {
    const failure = error as { code?: string; payment_intent?: Stripe.PaymentIntent; raw?: { payment_intent?: Stripe.PaymentIntent } };
    const intent = failure.payment_intent ?? failure.raw?.payment_intent;
    await pause(env, row, failure.code === 'authentication_required' ? 'authentication_required' : intent ? 'payment_failed' : 'reconciliation_required');
    if (intent?.id) {
      await env.DB.prepare('UPDATE api_topups SET payment_intent = ?, updated_at = ? WHERE id = ? AND payment_intent IS NULL').bind(intent.id, seconds(), row.id).run();
      await syncApiTopup(env, api, row.id);
    }
    // With no returned id the outcome is unknown. The pending reservation
    // stays locked for read-only recovery; we never retry a charge blindly.
  }
}

/** Bounded cron work. Settlements mark accounts due; new purchases never run
 * while inference holds make the available balance temporarily look lower. */
export async function processAutoTopups(env: Env, api: Stripe, now = seconds()): Promise<number> {
  const setups = await env.DB.prepare("SELECT * FROM api_autotopup_setups WHERE status = 'pending' AND checkout_id IS NOT NULL AND updated_at <= ? ORDER BY updated_at LIMIT 4")
    .bind(now - 60).all<Setup>();
  for (const setup of setups.results) {
    await syncSetup(env, api, setup).catch(() => {});
    await env.DB.prepare('UPDATE api_autotopup_setups SET updated_at = ? WHERE id = ?').bind(now, setup.id).run();
  }
  const pending = await env.DB.prepare("SELECT * FROM api_topups WHERE source = 'automatic' AND status = 'pending' AND updated_at <= ? ORDER BY updated_at LIMIT 4")
    .bind(now - 60).all<Topup>();
  for (const row of pending.results) {
    try {
      if (row.payment_intent) await syncApiTopup(env, api, row.id);
      else if (!row.initiated_at) {
        await sendAttempt(env, api, row, now);
      } else {
        const intents = await api.paymentIntents.list({ customer: row.customer_id, limit: 100, created: { gte: row.created_at - 60, lte: row.initiated_at + 3600 } });
        const found = intents.data.find((intent) => intent.metadata?.app === API_PAYMENT_TAG && intent.metadata?.source === 'automatic' && intent.metadata?.topup_id === row.id && intent.metadata?.account_id === row.account_id);
        if (found) {
          await env.DB.prepare('UPDATE api_topups SET payment_intent = ? WHERE id = ? AND payment_intent IS NULL').bind(found.id, row.id).run();
          await syncApiTopup(env, api, row.id);
        } else if (!intents.has_more && row.initiated_at < now - 7200) {
          await pause(env, row);
          await env.DB.prepare("UPDATE api_topups SET status = 'failed', updated_at = ? WHERE id = ? AND payment_intent IS NULL AND status = 'pending'").bind(now, row.id).run();
        }
      }
    } catch {
      await pause(env, row);
    }
    await env.DB.prepare('UPDATE api_topups SET updated_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  if (!(await autoTopupAvailable(env))) return pending.results.length;
  const due = await env.DB.prepare(`SELECT account_id FROM api_autotopup_settings WHERE enabled = 1 AND payment_method IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at LIMIT 4`)
    .bind(now).all<{ account_id: string }>();
  for (const { account_id: accountId } of due.results) {
    const id = `auto-${crypto.randomUUID()}`;
    // SQLite executes this as a single atomic statement. The sum includes
    // both successful and reserved charges; refunds never reset a monthly cap.
    const reserved = await env.DB.prepare(`INSERT INTO api_topups(id, account_id, customer_id, amount_micro, source, auto_month, auto_revision, payment_method, created_at, updated_at)
      SELECT ?, s.account_id, s.customer_id, s.amount_micro, 'automatic', ?, s.revision, s.payment_method, ?, ? FROM api_autotopup_settings s
      JOIN accounts a ON a.id = s.account_id AND a.stripe_customer = s.customer_id
      LEFT JOIN api_wallets w ON w.account_id = s.account_id
      WHERE s.account_id = ? AND s.enabled = 1 AND s.payment_method IS NOT NULL AND s.consent_at IS NOT NULL
      AND COALESCE(w.balance_micro, 0) >= 0 AND COALESCE(w.balance_micro, 0) - COALESCE(w.reserved_micro, 0) < s.threshold_micro
      AND NOT EXISTS(SELECT 1 FROM inference_requests WHERE account_id = s.account_id AND status = 'running')
      AND NOT EXISTS(SELECT 1 FROM api_topups WHERE account_id = s.account_id AND (dispute_open = 1 OR (source = 'automatic' AND status = 'pending')))
      AND NOT EXISTS(SELECT 1 FROM api_monthly_grants WHERE account_id = s.account_id AND dispute_open = 1)
      AND s.amount_micro + (SELECT COALESCE(SUM(amount_micro), 0) FROM api_topups WHERE account_id = s.account_id AND source = 'automatic' AND auto_month = ? AND status IN ('pending', 'paid')) <= s.monthly_cap_micro`)
      .bind(id, utcMonth(now), now, now, accountId, utcMonth(now)).run();
    await env.DB.prepare('UPDATE api_autotopup_settings SET next_check_at = ? WHERE account_id = ?').bind(now + 300, accountId).run();
    if (!reserved.meta.changes) continue;
    const row = await env.DB.prepare('SELECT * FROM api_topups WHERE id = ?').bind(id).first<Topup>();
    if (row) await sendAttempt(env, api, row, now);
  }
  return pending.results.length + due.results.length;
}
