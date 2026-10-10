// The Operator subscription: US$10 a week through Stripe Checkout. Access is
// always recomputed from Stripe's current state, never taken from an event
// payload, so a replayed or forged-looking event cannot grant anything.

import Stripe from 'stripe';

import { seconds } from './env.ts';
import type { Env } from './env.ts';
import { count } from './funnel.ts';
import { ApiError } from './http.ts';
import { RENEWAL_GRACE_SECONDS } from './quota.mjs';

const PRICE_CENTS = 1000;
const CHECKOUT_SECONDS = 3600;
const PRICE_CHECK_SECONDS = 600;
/** A renewal invoice older than this that is still unpaid no longer carries access. */
const RENEWAL_WINDOW_SECONDS = 86400;
/**
 * A subscription is read from Stripe again from this long before its stored
 * end of access. The stored end holds the renewal grace, so the first read
 * comes twelve hours before the paid period ends.
 */
const RESYNC_AHEAD_SECONDS = 18 * 3600;
/** The least time between two such reads of one subscription. */
const RESYNC_EVERY_SECONDS = 3600;
/** Reads per scheduled run. One read is up to three calls to Stripe, and a run on the free Workers plan may make 50. */
const RESYNC_BATCH = 4;
/** A subscription that still cannot be read this long after its access ended is left alone. */
const RESYNC_GIVE_UP_SECONDS = 7 * 86400;
const APP_TAG = 'bounty-operator';

/** Stripe statuses of a subscription that has ended and will not bill again. */
const ENDED_STATUSES = ['canceled', 'incomplete_expired'];

export function billingReady(env: Env): boolean {
  const key = env.STRIPE_SECRET_KEY ?? '';
  const liveKey = key.startsWith('rk_live_') || key.startsWith('sk_live_');
  return env.BILLING_MODE === 'live' && liveKey && Boolean(env.STRIPE_PRICE_ID && env.STRIPE_WEBHOOK_SECRET);
}

function unavailable(message = 'Subscriptions are not open right now. The free plan works as usual.'): ApiError {
  return new ApiError(message, 503, 'billing_unavailable');
}

function alreadySubscribed(): ApiError {
  return new ApiError('This account already has a subscription. Open Manage subscription.', 409, 'billing_exists');
}

function stripeClient(env: Env): Stripe {
  if (!billingReady(env)) throw unavailable();
  return new Stripe(env.STRIPE_SECRET_KEY!, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    timeout: 15000,
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface StripeErrorLike {
  type?: unknown;
  code?: unknown;
}

function stripeErrorType(error: unknown): string {
  const type = (error as StripeErrorLike | null)?.type;
  return typeof type === 'string' && type.startsWith('Stripe') ? type : '';
}

/**
 * Turns whatever a billing call threw into the error the client is shown.
 * Stripe's own message is never passed on: it can name internal ids.
 */
export function billingFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  switch (stripeErrorType(error)) {
    case 'StripeRateLimitError':
      return new ApiError('Billing is busy. Try again in a minute.', 503, 'billing_unavailable', { retryAfter: 60 });
    case 'StripeConnectionError':
    case 'StripeAPIError':
      return new ApiError('The payment provider did not answer. Try again in a minute.', 503, 'billing_unavailable', { retryAfter: 60 });
    case 'StripeIdempotencyError':
      return new ApiError('A checkout is already being opened for this account. Try again in a few seconds.', 409, 'billing_busy', {
        retryAfter: 5,
      });
    default:
      return unavailable();
  }
}

/** What may be logged about a billing failure: the error class and Stripe's code, never a message or payload. */
export function billingLogFields(error: unknown): { name: string; type: string; code: string } {
  const code = (error as StripeErrorLike | null)?.code;
  return {
    name: error instanceof Error ? error.name : 'unknown',
    type: stripeErrorType(error),
    code: typeof code === 'string' ? code : '',
  };
}

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

export type Standing =
  /** Active with a paid invoice. The payments behind the invoice are still to be checked. */
  | { kind: 'paid'; periodEnd: number; invoiceId: string }
  /** Active, and the renewal invoice is being collected. Existing access continues until `graceUntil`. */
  | { kind: 'renewing'; graceUntil: number }
  | { kind: 'lapsed'; status: string };

type SubscriptionItem = Stripe.Subscription['items']['data'][number];

/** The subscription's single item when it is exactly one Operator plan at US$10 a week. */
function operatorItem(subscription: Stripe.Subscription, priceId: string): SubscriptionItem | null {
  if (subscription.items.data.length !== 1) return null;
  const item = subscription.items.data[0];
  const price = item.price;
  const matches =
    price.id === priceId &&
    item.quantity === 1 &&
    price.currency === 'usd' &&
    price.unit_amount === PRICE_CENTS &&
    price.recurring?.interval === 'week' &&
    price.recurring.interval_count === 1;
  return matches ? item : null;
}

/** Where a subscription stands, from the subscription and its expanded latest invoice alone. */
export function subscriptionStanding(subscription: Stripe.Subscription, priceId: string, now: number): Standing {
  // Our label for a subscription Stripe calls active that does not carry access.
  const lapsed: Standing = { kind: 'lapsed', status: subscription.status === 'active' ? 'unpaid' : subscription.status };

  const item = operatorItem(subscription, priceId);
  const invoice = subscription.latest_invoice;
  if (!item || !subscription.livemode || subscription.status !== 'active' || subscription.pause_collection) return lapsed;
  if (!invoice || typeof invoice === 'string') return lapsed;

  if (invoice.status === 'paid' && invoice.amount_paid >= PRICE_CENTS) {
    return { kind: 'paid', periodEnd: item.current_period_end, invoiceId: invoice.id! };
  }

  // Stripe creates the renewal invoice as a draft and charges it about an
  // hour later. The subscriber has not missed a payment during that hour.
  const collecting = invoice.status === 'draft' || invoice.status === 'open';
  if (collecting && invoice.created > now - RENEWAL_WINDOW_SECONDS) {
    return { kind: 'renewing', graceUntil: invoice.created + RENEWAL_GRACE_SECONDS };
  }
  return lapsed;
}

/** The stored end of access for a paid period: the period end plus the renewal grace. */
export function paidUntilFor(periodEnd: number): number {
  return periodEnd + RENEWAL_GRACE_SECONDS;
}

type ChargeFacts = Pick<Stripe.Charge, 'paid' | 'refunded' | 'currency' | 'amount' | 'amount_refunded'>;

/** How many cents of one invoice payment are settled: paid in USD, not refunded, not under dispute. */
export function settledCents(amountPaid: number | null | undefined, charge: ChargeFacts, hasOpenDispute: boolean): number {
  if (!charge.paid || charge.refunded || charge.currency !== 'usd' || hasOpenDispute) return 0;
  return Math.min(amountPaid ?? 0, Math.max(0, charge.amount - charge.amount_refunded));
}

async function hasOpenDispute(api: Stripe, charge: Stripe.Charge): Promise<boolean> {
  if (!charge.disputed) return false;
  const disputes = await api.disputes.list({ charge: charge.id, limit: 100 });
  return disputes.has_more || disputes.data.some((dispute) => !['won', 'warning_closed'].includes(dispute.status));
}

/** True when the payments behind an invoice add up to the full price. */
async function invoiceSettled(api: Stripe, invoiceId: string): Promise<boolean> {
  const payments = await api.invoicePayments.list({
    invoice: invoiceId,
    status: 'paid',
    limit: 10,
    expand: ['data.payment.payment_intent'],
  });
  if (payments.has_more) return false;

  let settled = 0;
  for (const payment of payments.data) {
    const intent = payment.payment.payment_intent;
    const chargeRef = payment.payment.charge || (intent && typeof intent !== 'string' ? intent.latest_charge : null);
    if (!chargeRef) continue;
    const charge = typeof chargeRef === 'string' ? await api.charges.retrieve(chargeRef) : chargeRef;
    settled += settledCents(payment.amount_paid, charge, await hasOpenDispute(api, charge));
  }
  return settled >= PRICE_CENTS;
}

// A subscription Stripe has ended never comes back, so a stored end is final.
// Syncs run concurrently and a slower one may have read Stripe before the end:
// it must not write an older state over it.
const FINAL = `subscriptions.status NOT IN (${ENDED_STATUSES.map((status) => `'${status}'`).join(', ')})`;

function writeSubscription(env: Env, id: string, accountId: string, status: string, paidUntil: number): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO subscriptions (id, account_id, status, paid_until, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, paid_until = excluded.paid_until, updated_at = excluded.updated_at
     WHERE ${FINAL}`,
  )
    .bind(id, accountId, status, paidUntil, seconds())
    .run();
}

/**
 * Stores a paid subscription as active. Returns true only for the one write
 * that turned it active: a first insert, or a stored row that was not active.
 * Every statement is atomic, so a burst of concurrent syncs (Checkout sends
 * about six webhooks at once) reports the activation once.
 */
async function activate(env: Env, id: string, accountId: string, paidUntil: number): Promise<boolean> {
  const now = seconds();
  const inserted = await env.DB.prepare(
    "INSERT INTO subscriptions (id, account_id, status, paid_until, updated_at) VALUES (?, ?, 'active', ?, ?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(id, accountId, paidUntil, now)
    .run();
  if (inserted.meta.changes > 0) return true;

  const turned = await env.DB.prepare(
    `UPDATE subscriptions SET status = 'active', paid_until = ?, updated_at = ? WHERE id = ? AND status <> 'active' AND ${FINAL}`,
  )
    .bind(paidUntil, now, id)
    .run();
  if (turned.meta.changes > 0) return true;

  await env.DB.prepare("UPDATE subscriptions SET paid_until = ?, updated_at = ? WHERE id = ? AND status = 'active'")
    .bind(paidUntil, now, id)
    .run();
  return false;
}

/** Extends an entitlement that is already active. Returns false when there was none. */
async function extendActive(env: Env, id: string, graceUntil: number): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE subscriptions SET paid_until = MAX(paid_until, ?), updated_at = ? WHERE id = ? AND status = 'active'",
  )
    .bind(graceUntil, seconds(), id)
    .run();
  return result.meta.changes > 0;
}

/**
 * Stores what a subscription entitles the account to. `settled` says whether
 * the payments behind a paid invoice added up to the full price.
 */
export async function storeStanding(
  env: Env,
  ctx: ExecutionContext,
  subscriptionId: string,
  accountId: string,
  standing: Standing,
  settled: boolean,
): Promise<void> {
  if (standing.kind === 'paid' && settled) {
    if (await activate(env, subscriptionId, accountId, paidUntilFor(standing.periodEnd))) count(env, ctx, 'sub_active');
    return;
  }
  // A renewal in progress extends access that exists. It never creates access.
  if (standing.kind === 'renewing' && (await extendActive(env, subscriptionId, standing.graceUntil))) return;

  const status = standing.kind === 'lapsed' ? standing.status : 'unpaid';
  await writeSubscription(env, subscriptionId, accountId, status, 0);
}

/**
 * Reads the subscription from Stripe and stores what it entitles the account
 * to. With `accountId`, a subscription that belongs to another account is ignored.
 */
export async function syncSubscription(env: Env, ctx: ExecutionContext, subscriptionId: string, accountId?: string): Promise<void> {
  const api = stripeClient(env);
  const subscription = await api.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const account = await env.DB.prepare('SELECT id FROM accounts WHERE stripe_customer = ?').bind(customerId).first<{ id: string }>();
  if (!account || (accountId && accountId !== account.id)) return;

  const standing = subscriptionStanding(subscription, env.STRIPE_PRICE_ID, seconds());
  const settled = standing.kind === 'paid' && (await invoiceSettled(api, standing.invoiceId));
  await storeStanding(env, ctx, subscription.id, account.id, standing, settled);
}

/**
 * Reads from Stripe the active subscriptions whose paid period is about to end
 * or has ended, so a renewal, a cancellation or a failed payment reaches this
 * database when its webhook did not. Without it a subscriber who paid for the
 * next week would lose access six hours into it. Returns how many were read.
 */
export async function resyncEndingSubscriptions(env: Env, ctx: ExecutionContext, now: number): Promise<number> {
  if (!billingReady(env)) return 0;
  const due = await env.DB.prepare(
    `SELECT id FROM subscriptions
     WHERE status = 'active' AND paid_until < ? AND paid_until > ? AND updated_at < ?
     ORDER BY updated_at LIMIT ?`,
  )
    .bind(now + RESYNC_AHEAD_SECONDS, now - RESYNC_GIVE_UP_SECONDS, now - RESYNC_EVERY_SECONDS, RESYNC_BATCH)
    .all<{ id: string }>();

  let read = 0;
  for (const { id } of due.results) {
    try {
      await syncSubscription(env, ctx, id);
      read += 1;
    } catch (error) {
      console.error('Subscription resync failed', billingLogFields(error));
    }
    // A read that failed or wrote nothing has still had its turn: the row waits
    // like the others and cannot hold a place in every run.
    await env.DB.prepare("UPDATE subscriptions SET updated_at = ? WHERE id = ? AND status = 'active' AND updated_at < ?")
      .bind(now, id, now - RESYNC_EVERY_SECONDS)
      .run()
      .catch(() => {});
  }
  return read;
}

/**
 * True while Stripe may still bill the account: a stored subscription that has
 * not ended, or one at Stripe that never reached this database (its webhooks
 * failed and the success page was closed before it synced). A Stripe customer
 * is asked directly; without billing configured the link alone counts.
 */
export async function mayStillBill(env: Env, accountId: string): Promise<boolean> {
  if (await hasLiveSubscription(env.DB, accountId)) return true;
  const account = await env.DB.prepare('SELECT stripe_customer FROM accounts WHERE id = ?').bind(accountId).first<{ stripe_customer: string | null }>();
  if (!account?.stripe_customer) return false;
  if (!billingReady(env)) return true;
  const subscriptions = await stripeClient(env).subscriptions.list({ customer: account.stripe_customer, status: 'all', limit: 100 });
  return subscriptions.data.some((subscription) => !ENDED_STATUSES.includes(subscription.status));
}

/** True while the account has a stored subscription that Stripe may still bill. */
export async function hasLiveSubscription(db: D1Database, accountId: string): Promise<boolean> {
  const placeholders = ENDED_STATUSES.map(() => '?').join(', ');
  const row = await db
    .prepare(`SELECT 1 FROM subscriptions WHERE account_id = ? AND status NOT IN (${placeholders}) LIMIT 1`)
    .bind(accountId, ...ENDED_STATUSES)
    .first();
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Checkout and the customer portal
// ---------------------------------------------------------------------------

let priceVerified = { id: '', until: 0 };

/** Confirms that the configured price is the live US$10 weekly plan before anyone is sent to pay it. */
async function verifiedClient(env: Env): Promise<Stripe> {
  const api = stripeClient(env);
  const now = seconds();
  if (priceVerified.id === env.STRIPE_PRICE_ID && priceVerified.until > now) return api;

  const price = await api.prices.retrieve(env.STRIPE_PRICE_ID);
  const valid =
    price.active &&
    price.livemode &&
    price.currency === 'usd' &&
    price.unit_amount === PRICE_CENTS &&
    price.recurring?.interval === 'week' &&
    price.recurring.interval_count === 1;
  if (!valid) throw unavailable();

  priceVerified = { id: env.STRIPE_PRICE_ID, until: now + PRICE_CHECK_SECONDS };
  return api;
}

async function customerFor(env: Env, api: Stripe, accountId: string): Promise<string> {
  const account = await env.DB.prepare('SELECT stripe_customer FROM accounts WHERE id = ?').bind(accountId).first<{ stripe_customer: string | null }>();
  if (!account) throw new ApiError('Sign in to continue.', 401, 'signin');
  if (account.stripe_customer) return account.stripe_customer;

  const created = await api.customers.create(
    { metadata: { app: APP_TAG, account_id: accountId } },
    { idempotencyKey: `bounty-customer-${accountId}` },
  );
  // Two requests may both create a customer; the first stored id wins.
  await env.DB.prepare('UPDATE accounts SET stripe_customer = ? WHERE id = ? AND stripe_customer IS NULL').bind(created.id, accountId).run();
  const stored = await env.DB.prepare('SELECT stripe_customer FROM accounts WHERE id = ?').bind(accountId).first<{ stripe_customer: string }>();
  return stored!.stripe_customer;
}

/** Returns the Stripe Checkout URL for the Operator plan. */
export async function createCheckout(env: Env, ctx: ExecutionContext, accountId: string): Promise<string> {
  const api = await verifiedClient(env);

  const active = await env.DB.prepare("SELECT 1 FROM subscriptions WHERE account_id = ? AND status = 'active' AND paid_until > ? LIMIT 1")
    .bind(accountId, seconds())
    .first();
  if (active) throw alreadySubscribed();

  const customer = await customerFor(env, api, accountId);

  // A subscription paid for before its webhook arrived is found here and synced.
  const subscriptions = await api.subscriptions.list({ customer, status: 'all', limit: 100 });
  for (const subscription of subscriptions.data) {
    const isOperator = subscription.items.data.some((item) => item.price.id === env.STRIPE_PRICE_ID);
    if (!isOperator || ENDED_STATUSES.includes(subscription.status)) continue;
    await syncSubscription(env, ctx, subscription.id, accountId);
    throw alreadySubscribed();
  }

  const open = await api.checkout.sessions.list({ customer, status: 'open', limit: 10 });
  const pending = open.data.find((session) => session.metadata?.app === APP_TAG && session.mode === 'subscription');
  if (pending?.url) return pending.url;

  // Stripe requires at least 30 minutes between now and expiry, so the time is
  // read here, after every slower call above.
  const expiresAt = seconds() + CHECKOUT_SECONDS;
  const origin = env.SITE_ORIGIN;
  const session = await api.checkout.sessions.create(
    {
      mode: 'subscription',
      customer,
      client_reference_id: accountId,
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${origin}/?checkout=complete&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing?checkout=cancelled`,
      metadata: { app: APP_TAG, account_id: accountId },
      subscription_data: { metadata: { app: APP_TAG, account_id: accountId } },
      expires_at: expiresAt,
      // Stripe's page is a sheet of the site's paper: the bone ground and the black box of
      // .theme-light in base.css. Stripe sets the ink on each itself.
      branding_settings: { display_name: 'Bounty Operator', background_color: '#f4f1ea', button_color: '#121214' },
      custom_text: {
        submit: {
          message: `US$10 every week until cancelled. By subscribing, you agree to the [Bounty Operator terms](${origin}/terms). AI provider usage is billed separately.`,
        },
      },
    },
    { idempotencyKey: `bounty-checkout-${accountId}-${expiresAt}` },
  );
  if (!session.url) throw unavailable();

  count(env, ctx, 'checkout_created');
  return session.url;
}

/** Returns the Stripe customer-portal URL, where a subscriber updates the card or cancels. */
export async function createPortal(env: Env, accountId: string): Promise<string> {
  const api = stripeClient(env);
  const account = await env.DB.prepare('SELECT stripe_customer FROM accounts WHERE id = ?').bind(accountId).first<{ stripe_customer: string | null }>();
  if (!account?.stripe_customer) throw new ApiError('This account has no subscription to manage.', 400, 'billing_none');

  const session = await api.billingPortal.sessions.create({
    customer: account.stripe_customer,
    return_url: `${env.SITE_ORIGIN}/#account`,
    ...(env.STRIPE_PORTAL_CONFIGURATION ? { configuration: env.STRIPE_PORTAL_CONFIGURATION } : {}),
  });
  return session.url;
}

/** Called when the browser returns from Checkout: syncs the new subscription without waiting for the webhook. */
export async function reconcileCheckout(env: Env, ctx: ExecutionContext, accountId: string, sessionId: unknown): Promise<void> {
  if (typeof sessionId !== 'string' || !/^cs_live_[A-Za-z0-9]{1,200}$/.test(sessionId)) {
    throw new ApiError('Checkout reference is not valid.', 400, 'bad_request');
  }
  const api = stripeClient(env);
  const session = await api.checkout.sessions.retrieve(sessionId);
  const account = await env.DB.prepare('SELECT stripe_customer FROM accounts WHERE id = ?').bind(accountId).first<{ stripe_customer: string | null }>();

  const belongs =
    session.client_reference_id === accountId && session.customer === account?.stripe_customer && session.metadata?.app === APP_TAG;
  if (!belongs) throw new ApiError('This checkout belongs to another account.', 403, 'forbidden');

  if (session.status === 'complete' && session.subscription) {
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    await syncSubscription(env, ctx, subscriptionId, accountId);
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

function idOf(reference: string | { id: string } | null | undefined): string | null {
  if (!reference) return null;
  return typeof reference === 'string' ? reference : reference.id;
}

/** Keeps the receipt address, so a subscriber who loses passkey and recovery code can still be reached. */
async function storeReceiptEmail(env: Env, session: Stripe.Checkout.Session): Promise<void> {
  const customer = idOf(session.customer);
  const email = session.customer_details?.email;
  if (!customer || !email || email.length > 320) return;
  await env.DB.prepare('UPDATE accounts SET email = ? WHERE stripe_customer = ?').bind(email, customer).run();
}

async function syncCustomerSubscriptions(env: Env, ctx: ExecutionContext, api: Stripe, customer: string): Promise<void> {
  const subscriptions = await api.subscriptions.list({ customer, status: 'all', limit: 100 });
  for (const subscription of subscriptions.data) {
    if (subscription.items.data.some((item) => item.price.id === env.STRIPE_PRICE_ID)) {
      await syncSubscription(env, ctx, subscription.id);
    }
  }
}

async function applyEvent(env: Env, ctx: ExecutionContext, api: Stripe, event: Stripe.Event): Promise<void> {
  if (event.type.startsWith('customer.subscription.')) {
    await syncSubscription(env, ctx, (event.data.object as Stripe.Subscription).id);
    return;
  }

  if (event.type.startsWith('invoice.')) {
    const invoice = event.data.object as { subscription?: string; parent?: { subscription_details?: { subscription?: string } } };
    const subscriptionId = invoice.subscription || invoice.parent?.subscription_details?.subscription;
    if (subscriptionId) await syncSubscription(env, ctx, subscriptionId);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    await storeReceiptEmail(env, session);
    const subscriptionId = idOf(session.subscription);
    if (subscriptionId) await syncSubscription(env, ctx, subscriptionId);
    return;
  }

  if (event.type === 'charge.refunded' || event.type.startsWith('charge.dispute.')) {
    const chargeRef = event.type === 'charge.refunded' ? (event.data.object as Stripe.Charge).id : (event.data.object as Stripe.Dispute).charge;
    const charge = typeof chargeRef === 'string' ? await api.charges.retrieve(chargeRef) : chargeRef;
    const customer = idOf(charge?.customer);
    if (customer) await syncCustomerSubscriptions(env, ctx, api, customer);
  }
}

/**
 * Handles a Stripe webhook. The signature is checked against the raw body, and
 * an event is recorded only after it was applied, so a failure makes Stripe retry.
 */
export async function handleWebhook(env: Env, ctx: ExecutionContext, request: Request, body: string): Promise<Response> {
  const rejected = new Response('Invalid signature', { status: 400 });
  const signature = request.headers.get('stripe-signature');
  if (!signature || !billingReady(env)) return rejected;

  const api = stripeClient(env);
  let event: Stripe.Event;
  try {
    event = await api.webhooks.constructEventAsync(body, signature, env.STRIPE_WEBHOOK_SECRET!, 300, Stripe.createSubtleCryptoProvider());
  } catch {
    return rejected;
  }
  if (!event.livemode) return new Response('Wrong environment', { status: 400 });

  const seen = await env.DB.prepare('SELECT 1 FROM stripe_events WHERE id = ?').bind(event.id).first();
  if (seen) return new Response('OK');

  await applyEvent(env, ctx, api, event);
  await env.DB.prepare('INSERT OR IGNORE INTO stripe_events (id, created_at) VALUES (?, ?)').bind(event.id, seconds()).run();
  return new Response('OK');
}
