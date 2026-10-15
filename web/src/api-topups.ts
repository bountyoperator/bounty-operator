// Prepaid API credit is issued only from a verified, settled Stripe payment.
import type Stripe from 'stripe';
import { MICRO_USD, TOPUP_USD } from './api-credits.ts';
import { sha256 } from './crypto.ts';
import { seconds } from './env.ts';
import type { Env } from './env.ts';
import { ApiError } from './http.ts';

export const API_PAYMENT_TAG = 'bounty-operator-api';
const TAG = API_PAYMENT_TAG;
export interface Topup { id: string; account_id: string | null; customer_id: string; checkout_id: string | null; payment_intent: string | null; amount_micro: number; credited_micro: number; refunded_micro: number; dispute_at: number; dispute_blocked: number; dispute_open: number; revision: number; status: string; created_at: number; source: 'checkout' | 'automatic'; auto_month: string | null; auto_revision: number | null; payment_method: string | null; initiated_at: number; payment_verified_at: number }
const idOf = (value: string | { id: string } | null | undefined): string | null => typeof value === 'string' ? value : value?.id ?? null;

/** Why a purchase is closed: the model service's billing status, or 'closed' when configuration does not allow it. */
export type TopupClosure = 'closed' | 'unavailable' | 'paused' | 'unknown';

/** The refusal for a new purchase. It is thrown before any Stripe request, so nothing has been charged. */
export function topupsUnavailable(reason: TopupClosure, automatic = false): ApiError {
  const kind = automatic ? 'Automatic API top-ups' : 'API top-ups';
  if (reason === 'unknown') {
    return new ApiError(`${kind} are unavailable because the model hosting status could not be confirmed. No charge was made. Try again in a few minutes.`, 503, 'topups_unavailable', { retryAfter: 60 });
  }
  if (reason === 'paused') return new ApiError(`${kind} are closed while model inference is paused.`, 503, 'topups_unavailable');
  return new ApiError(`${kind} are not open right now.`, 503, 'topups_unavailable');
}

/** Test money is accepted only by an explicitly configured localhost Worker. */
export function localStripeTest(env: Env): boolean {
  try { return env.BILLING_MODE === 'test' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.SITE_ORIGIN).hostname) && /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? ''); }
  catch { return false; }
}

export async function createApiTopup(env: Env, api: Stripe, accountId: string, customer: string, amount: unknown, nonce: unknown): Promise<string> {
  if (typeof amount !== 'number' || !(TOPUP_USD as readonly number[]).includes(amount)) throw new ApiError('Choose a $20, $50 or $100 top-up.');
  if (typeof nonce !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(nonce)) throw new ApiError('A checkout request ID is required.');
  const id = await sha256(`${accountId}:${nonce}`);
  const now = seconds();
  await env.DB.prepare('INSERT OR IGNORE INTO api_topups(id, account_id, customer_id, amount_micro, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
    .bind(id, accountId, customer, amount * MICRO_USD, now, now).run();
  const topup = await env.DB.prepare('SELECT * FROM api_topups WHERE id = ?').bind(id).first<Topup>();
  if (!topup || topup.amount_micro !== amount * MICRO_USD || topup.account_id !== accountId || topup.customer_id !== customer) throw new ApiError('This checkout request has already been used.', 409, 'checkout_conflict');
  if (topup.checkout_id) {
    const existing = await api.checkout.sessions.retrieve(topup.checkout_id);
    if (existing.status === 'open' && existing.url) return existing.url;
    throw new ApiError('This checkout has ended. Refresh your balance before opening another.', 409, 'checkout_ended');
  }
  if (topup.status !== 'pending' || topup.created_at < now - 1700) throw new ApiError('This checkout request has ended. Open a new top-up.', 409, 'checkout_ended');
  const session = await api.checkout.sessions.create({
    mode: 'payment', customer, client_reference_id: accountId,
    line_items: [{ price_data: { currency: 'usd', unit_amount: amount * 100, product_data: { name: 'BountyOperator API credit', description: `US$${amount} prepaid API credit. Usage is deducted at the published model rates.` } }, quantity: 1 }],
    metadata: { app: TAG, topup_id: id, account_id: accountId },
    payment_intent_data: { metadata: { app: TAG, topup_id: id, account_id: accountId } },
    success_url: `${env.SITE_ORIGIN}/?api_checkout=complete&session_id={CHECKOUT_SESSION_ID}#account/api`,
    cancel_url: `${env.SITE_ORIGIN}/?api_checkout=cancelled#account/api`,
    // Stable across retries: Stripe rejects a reused idempotency key when any
    // parameter differs, including a freshly calculated expiration time.
    expires_at: topup.created_at + 3600,
    branding_settings: { display_name: 'Bounty Operator', background_color: '#f6e7cc', button_color: '#18232d' },
    custom_text: { submit: { message: `One-time payment. No automatic top-ups. API credit is used at the published model rates. [Terms](${env.SITE_ORIGIN}/terms).` } },
  }, { idempotencyKey: `api-topup-${id}` });
  if (!session.url) throw new ApiError('Checkout could not be opened.', 503, 'billing_unavailable');
  await env.DB.prepare('UPDATE api_topups SET checkout_id = ?, payment_intent = ?, updated_at = ? WHERE id = ? AND checkout_id IS NULL')
    .bind(session.id, idOf(session.payment_intent), seconds(), id).run();
  return session.url;
}

/** Optimistic revision check makes concurrent fulfilment/refund events retry
 * against a new Stripe read. A refund total can only move forwards. */
export async function syncApiTopup(env: Env, api: Stripe, topupId: string, eventTime = 0, verifiedAutomaticSuccess = false): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.DB.prepare('SELECT * FROM api_topups WHERE id = ?').bind(topupId).first<Topup>();
    if (!row?.account_id) return;
    const automatic = row.source === 'automatic';
    if (automatic ? !row.payment_intent : !row.checkout_id) return;
    const session = !automatic ? await api.checkout.sessions.retrieve(row.checkout_id!, { expand: ['payment_intent.latest_charge'] }) : null;
    if (session && (session.livemode !== !localStripeTest(env) || session.mode !== 'payment' || session.currency !== 'usd' || session.amount_total !== row.amount_micro / 10000 || session.amount_subtotal !== session.amount_total ||
      session.metadata?.app !== TAG || session.metadata?.topup_id !== row.id || session.metadata?.account_id !== row.account_id || session.client_reference_id !== row.account_id || idOf(session.customer) !== row.customer_id)) throw new Error('API checkout verification failed');
    let intent = automatic ? await api.paymentIntents.retrieve(row.payment_intent!, { expand: ['latest_charge'] }) : session!.payment_intent;
    if (automatic && (!intent || typeof intent === 'string' || intent.id !== row.payment_intent || intent.livemode !== !localStripeTest(env) ||
      intent.currency !== 'usd' || intent.amount !== row.amount_micro / 10000 || idOf(intent.customer) !== row.customer_id || idOf(intent.payment_method) !== row.payment_method ||
      intent.metadata?.app !== TAG || intent.metadata?.topup_id !== row.id || intent.metadata?.account_id !== row.account_id || intent.metadata?.source !== 'automatic')) throw new Error('Automatic API payment verification failed');
    let status = session?.status === 'expired' ? 'expired' : 'pending';
    let refund = row.refunded_micro;
    let blocked = row.dispute_blocked;
    let disputeOpen = row.dispute_open;
    let disputeAt = row.dispute_at;
    let credit = row.credited_micro;
    let verifiedAt = row.payment_verified_at;
    if (automatic && intent && typeof intent !== 'string' && ['canceled', 'requires_action', 'requires_payment_method', 'requires_confirmation', 'requires_capture'].includes(intent.status)) {
      const reason = intent.status === 'requires_action' || intent.last_payment_error?.code === 'authentication_required' ? 'authentication_required' : 'payment_failed';
      await env.DB.prepare('UPDATE api_autotopup_settings SET enabled = 0, pause_reason = ?, updated_at = ? WHERE account_id = ? AND revision = ?')
        .bind(reason, seconds(), row.account_id, row.auto_revision).run();
      // An unconfirmed intent must not remain payable beside a future attempt.
      // A failed cancellation leaves the durable reservation in place.
      if (intent.status !== 'canceled') intent = await api.paymentIntents.cancel(intent.id, {}, { idempotencyKey: `api-auto-cancel-${row.id}` });
      if (intent.status !== 'canceled') throw new Error('Automatic API payment cancellation pending');
      status = 'failed';
    }
    if (session?.status === 'complete' && session.payment_status === 'unpaid' && intent && typeof intent !== 'string' && ['canceled', 'requires_payment_method'].includes(intent.status)) status = 'failed';
    const paid = automatic ? intent && typeof intent !== 'string' && intent.status === 'succeeded' : session?.status === 'complete' && session.payment_status === 'paid';
    if (paid) {
      if (!intent || typeof intent === 'string' || intent.livemode !== !localStripeTest(env) || intent.status !== 'succeeded' || intent.currency !== 'usd' || intent.amount_received !== row.amount_micro / 10000 || idOf(intent.customer) !== row.customer_id || intent.metadata?.topup_id !== row.id) throw new Error('API payment verification failed');
      const charge = intent.latest_charge;
      if (!charge || typeof charge === 'string' || !charge.paid || !charge.captured || charge.currency !== 'usd' || charge.amount !== row.amount_micro / 10000 || idOf(charge.customer) !== row.customer_id) throw new Error('API charge verification failed');
      refund = Math.max(refund, charge.amount_refunded * 10000);
      if (refund > row.amount_micro) throw new Error('Invalid refund total');
      const disputes = charge.disputed ? await api.disputes.list({ charge: charge.id, limit: 100 }) : { data: [], has_more: false };
      const observedBlocked = disputes.has_more || disputes.data.some((d) => !['won', 'warning_closed'].includes(d.status)) ? 1 : 0;
      // A fresh reconciliation uses current Stripe state. A delayed event must
      // never undo a later dispute decision that has already been applied.
      if (!eventTime || eventTime >= disputeAt) {
        blocked = observedBlocked;
        disputeOpen = disputes.has_more || disputes.data.some((d) => !['won', 'lost', 'warning_closed'].includes(d.status)) ? 1 : 0;
        disputeAt = Math.max(disputeAt, eventTime);
      }
      // Automatic credit is first unlocked by a signed succeeded event. A
      // successful create response or return URL can never issue the credit.
      if (automatic && (verifiedAutomaticSuccess || !eventTime)) verifiedAt = Math.max(verifiedAt, eventTime || seconds());
      if (!automatic || verifiedAt) {
        credit = blocked ? 0 : row.amount_micro - refund;
        status = 'paid';
      }
    } else if (row.status === 'paid') {
      // Settled payments cannot be reverted by an older pending snapshot.
      return;
    }
    const updated = await env.DB.prepare(`UPDATE api_topups SET status = ?, credited_micro = ?, refunded_micro = ?, dispute_blocked = ?, dispute_open = ?, dispute_at = ?,
      payment_intent = COALESCE(?, payment_intent), payment_verified_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
      .bind(status, credit, refund, blocked, disputeOpen, disputeAt, idOf(intent), verifiedAt, seconds(), row.id, row.revision).run();
    if (updated.meta.changes) return;
  }
  throw new Error('API payment changed concurrently');
}

export async function reconcileApiTopup(env: Env, api: Stripe, accountId: string, sessionId: unknown): Promise<void> {
  const prefix = localStripeTest(env) ? /^cs_test_[A-Za-z0-9]{1,200}$/ : /^cs_live_[A-Za-z0-9]{1,200}$/;
  if (typeof sessionId !== 'string' || !prefix.test(sessionId)) throw new ApiError('Invalid checkout reference.');
  const row = await env.DB.prepare('SELECT id FROM api_topups WHERE checkout_id = ? AND account_id = ?').bind(sessionId, accountId).first<{ id: string }>();
  if (!row) throw new ApiError('This checkout does not belong to your account.', 403, 'forbidden');
  await syncApiTopup(env, api, row.id);
}

export async function applyApiPaymentEvent(env: Env, api: Stripe, event: Stripe.Event): Promise<boolean> {
  if (event.type.startsWith('payment_intent.')) {
    const intent = event.data.object as Stripe.PaymentIntent;
    if (intent.metadata?.app !== TAG || intent.metadata?.source !== 'automatic' || !intent.metadata?.topup_id) return false;
    const row = await env.DB.prepare("SELECT * FROM api_topups WHERE id = ? AND source = 'automatic'").bind(intent.metadata.topup_id).first<Topup>();
    if (!row || row.customer_id !== idOf(intent.customer) || row.account_id !== intent.metadata.account_id || (row.payment_intent && row.payment_intent !== intent.id)) throw new Error('Automatic API payment ownership failed');
    await env.DB.prepare('UPDATE api_topups SET payment_intent = ? WHERE id = ? AND payment_intent IS NULL').bind(intent.id, row.id).run();
    await syncApiTopup(env, api, row.id, event.created, event.type === 'payment_intent.succeeded');
    return true;
  }
  if (event.type.startsWith('checkout.session.')) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.app !== TAG) return false;
    const id = session.metadata?.topup_id;
    if (!id) throw new Error('API checkout metadata missing');
    // A webhook can beat the create response. Bind only the locally reserved
    // checkout whose customer and account match the signed Stripe event.
    await env.DB.prepare('UPDATE api_topups SET checkout_id = ? WHERE id = ? AND checkout_id IS NULL AND customer_id = ? AND account_id = ?')
      .bind(session.id, id, idOf(session.customer), session.client_reference_id).run();
    await syncApiTopup(env, api, id, event.created);
    return true;
  }
  if (event.type === 'charge.refunded' || event.type.startsWith('charge.dispute.')) {
    const reference = event.type === 'charge.refunded' ? (event.data.object as Stripe.Charge).id : (event.data.object as Stripe.Dispute).charge;
    const charge = typeof reference === 'string' ? await api.charges.retrieve(reference) : reference;
    const intentId = idOf(charge?.payment_intent);
    if (!intentId) return false;
    const intent = await api.paymentIntents.retrieve(intentId);
    if (intent.metadata?.app !== TAG || !intent.metadata.topup_id) return false;
    await syncApiTopup(env, api, intent.metadata.topup_id, event.created);
    return true;
  }
  return false;
}

export async function resyncPendingTopups(env: Env, api: Stripe): Promise<number> {
  const now = seconds();
  const rows = await env.DB.prepare("SELECT * FROM api_topups WHERE source = 'checkout' AND status = 'pending' AND (checkout_id IS NOT NULL OR created_at < ?) ORDER BY updated_at LIMIT 4").bind(now - 7200).all<Topup>();
  for (const row of rows.results) {
    if (!row.checkout_id) {
      // A connection can fail after Stripe creates a session but before its id
      // reaches us. Search the original one-hour creation window before closing
      // a stale reservation; incomplete pagination is never proof of absence.
      const sessions = await api.checkout.sessions.list({ customer: row.customer_id, limit: 100, created: { gte: row.created_at - 60, lte: row.created_at + 3600 } });
      const found = sessions.data.find((s) => s.metadata?.app === TAG && s.metadata?.topup_id === row.id && s.client_reference_id === row.account_id);
      if (found) await env.DB.prepare('UPDATE api_topups SET checkout_id = ? WHERE id = ? AND checkout_id IS NULL').bind(found.id, row.id).run();
      else if (!sessions.has_more) await env.DB.prepare("UPDATE api_topups SET status = 'failed', updated_at = ? WHERE id = ? AND checkout_id IS NULL AND status = 'pending'").bind(now, row.id).run();
    }
    await syncApiTopup(env, api, row.id);
    await env.DB.prepare('UPDATE api_topups SET updated_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  return rows.results.length;
}
