// Prepaid API credit is issued only from a verified, settled Stripe payment.
import type Stripe from 'stripe';
import { MICRO_USD, TOPUP_USD } from './api-credits.ts';
import { sha256 } from './crypto.ts';
import { seconds } from './env.ts';
import type { Env } from './env.ts';
import { ApiError } from './http.ts';

const TAG = 'bounty-operator-api';
interface Topup { id: string; account_id: string | null; customer_id: string; checkout_id: string | null; payment_intent: string | null; amount_micro: number; credited_micro: number; refunded_micro: number; dispute_at: number; dispute_blocked: number; dispute_open: number; revision: number; status: string; created_at: number }
const idOf = (value: string | { id: string } | null | undefined): string | null => typeof value === 'string' ? value : value?.id ?? null;

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
export async function syncApiTopup(env: Env, api: Stripe, topupId: string, eventTime = 0): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.DB.prepare('SELECT * FROM api_topups WHERE id = ?').bind(topupId).first<Topup>();
    if (!row?.checkout_id || !row.account_id) return;
    const session = await api.checkout.sessions.retrieve(row.checkout_id, { expand: ['payment_intent.latest_charge'] });
    if (session.livemode !== !localStripeTest(env) || session.mode !== 'payment' || session.currency !== 'usd' || session.amount_total !== row.amount_micro / 10000 || session.amount_subtotal !== session.amount_total ||
      session.metadata?.app !== TAG || session.metadata?.topup_id !== row.id || session.metadata?.account_id !== row.account_id || session.client_reference_id !== row.account_id || idOf(session.customer) !== row.customer_id) throw new Error('API checkout verification failed');
    const intent = session.payment_intent;
    let status = session.status === 'expired' ? 'expired' : 'pending';
    let refund = row.refunded_micro;
    let blocked = row.dispute_blocked;
    let disputeOpen = row.dispute_open;
    let disputeAt = row.dispute_at;
    let credit = row.credited_micro;
    if (session.status === 'complete' && session.payment_status === 'unpaid' && intent && typeof intent !== 'string' && ['canceled', 'requires_payment_method'].includes(intent.status)) status = 'failed';
    if (session.status === 'complete' && session.payment_status === 'paid') {
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
      credit = blocked ? 0 : row.amount_micro - refund;
      status = 'paid';
    } else if (row.status === 'paid') {
      // Settled payments cannot be reverted by an older pending snapshot.
      return;
    }
    const updated = await env.DB.prepare(`UPDATE api_topups SET status = ?, credited_micro = ?, refunded_micro = ?, dispute_blocked = ?, dispute_open = ?, dispute_at = ?,
      payment_intent = COALESCE(?, payment_intent), revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
      .bind(status, credit, refund, blocked, disputeOpen, disputeAt, idOf(intent), seconds(), row.id, row.revision).run();
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
  const rows = await env.DB.prepare("SELECT * FROM api_topups WHERE status = 'pending' AND (checkout_id IS NOT NULL OR created_at < ?) ORDER BY updated_at LIMIT 4").bind(now - 7200).all<Topup>();
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
