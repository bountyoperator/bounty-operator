// What a signed-in user sees about their own account: status, the portal
// listing, the data export and deletion.

import { PROFILES } from '../public/profiles.mjs';
import { LIMITS } from '../public/review-core.mjs';

import { clearSessionCookie, currentSession } from './auth.ts';
import type { Session } from './auth.ts';
import { apiTopupsClosure, apiTopupsDecision, billingReady, hasLiveSubscription, mayStillBill, subscriptionSummary } from './billing.ts';
import { PRICE, VERSION, seconds } from './env.ts';
import type { Call, Env } from './env.ts';
import { currentProfileId } from './hosted.ts';
import { ApiError, json } from './http.ts';
import { usage } from './quota.mjs';
import { apiCreditData, hasApiLiability } from './api-credits.ts';
import { inferenceBilling, inferenceCatalog, shownInferenceStatus, topupBilling } from './inference.ts';

const HISTORY_ROWS = 30;

function billingState(env: Env): 'live' | 'unavailable' {
  return billingReady(env) ? 'live' : 'unavailable';
}

/** GET /api/account: what the page needs to draw itself, signed in or not. */
export async function accountStatus({ env, request }: Call): Promise<Response> {
  const session = await currentSession(env, request);
  const signedIn = Boolean(session);
  const [currentUsage, hasSubscription, subscription] = session
    ? await Promise.all([
        usage(env.DB, session.account_id, seconds()),
        hasLiveSubscription(env.DB, session.account_id),
        subscriptionSummary(env.DB, session.account_id),
      ])
    : [null, false, null];
  return json({
    signedIn,
    csrf: session?.csrf,
    usage: currentUsage,
    billing: billingState(env),
    hasSubscription,
    subscription,
    limits: LIMITS,
    price: PRICE,
    version: VERSION,
  });
}

/** What a connection token may read: usage and the public limits. */
export async function clientStatus(env: Env, accountId: string): Promise<Record<string, unknown>> {
  return {
    usage: await usage(env.DB, accountId, seconds()),
    billing: billingState(env),
    limits: LIMITS,
    price: PRICE,
    version: VERSION,
  };
}

/** What the account panel shows. Exported for tests. */
export async function portalData(env: Env, accountId: string): Promise<Record<string, unknown>> {
  const now = seconds();
  // One hosting read for the whole panel. The manual buttons, the automatic
  // top-up summary and the catalog all wait for it, so they cannot disagree
  // and a cold cache costs one RunPod request instead of three.
  const billing = inferenceBilling(env);
  const [account, passkeys, connections, reviews, hasSubscription, subscription, currentUsage, apiData, apiBilling, models] = await Promise.all([
    env.DB.prepare('SELECT id, created_at, email FROM accounts WHERE id = ?').bind(accountId).first(),
    env.DB.prepare('SELECT id, label, created_at FROM passkeys WHERE account_id = ? ORDER BY created_at').bind(accountId).all(),
    env.DB.prepare('SELECT id, label, created_at, expires, last_used FROM api_tokens WHERE account_id = ? AND expires > ? ORDER BY created_at DESC')
      .bind(accountId, now)
      .all(),
    env.DB.prepare('SELECT id, created_at, status, profile, channel FROM reviews WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(accountId, HISTORY_ROWS)
      .all(),
    hasLiveSubscription(env.DB, accountId),
    subscriptionSummary(env.DB, accountId),
    usage(env.DB, accountId, now),
    apiCreditData(env, accountId, false, billing),
    billing,
    inferenceCatalog(env, billing),
  ]);
  // An unknown hosting state is shown as available, but closes top-ups. The
  // panel is given the closure as well, so its text names the actual cause.
  // Top-ups stay open while only a payment-refilled supplier budget is short.
  const apiStatus = shownInferenceStatus(apiBilling.status);
  const topups = apiTopupsDecision(env, await topupBilling(env, apiBilling));
  return {
    account: { ...account, hasSubscription },
    subscription,
    passkeys: passkeys.results,
    connections: connections.results,
    // A row stored by an earlier release may carry an id that has since been renamed.
    reviews: reviews.results.map((row) => (typeof row.profile === 'string' ? { ...row, profile: currentProfileId(row.profile) } : row)),
    usage: currentUsage,
    profiles: PROFILES.map((profile) => ({ id: profile.id, name: profile.name })),
    api: { ...apiData, enabled: apiStatus === 'available', status: apiStatus, topups_enabled: topups.open, topups_closure: apiTopupsClosure(topups), models },
  };
}

export async function portal({ env }: Call, session: Session): Promise<Response> {
  return json(await portalData(env, session.account_id));
}

/** Everything stored about the account, minus the hashes that guard it. */
export async function exportAccount({ env }: Call, session: Session): Promise<Response> {
  const accountId = session.account_id;
  const [panel, account, subscriptions, autoTopup, reviews] = await Promise.all([
    portalData(env, accountId),
    env.DB.prepare('SELECT stripe_customer FROM accounts WHERE id = ?').bind(accountId).first<{ stripe_customer: string | null }>(),
    env.DB.prepare('SELECT id, status, paid_until, price_id, billing_interval, period_end, cancel_at_period_end, updated_at FROM subscriptions WHERE account_id = ? ORDER BY updated_at').bind(accountId).all(),
    env.DB.prepare('SELECT enabled, amount_micro, threshold_micro, monthly_cap_micro, payment_method, payment_method_summary, consent_at, consent_version, pause_reason, updated_at FROM api_autotopup_settings WHERE account_id = ?').bind(accountId).first(),
    // Every stored review row, not only the panel's most recent ones.
    env.DB.prepare('SELECT id, created_at, day, status, profile, channel FROM reviews WHERE account_id = ? ORDER BY created_at DESC').bind(accountId).all(),
  ]);
  return json({
    ...panel,
    api: await apiCreditData(env, accountId, true),
    reviews: reviews.results.map((row) => (typeof row.profile === 'string' ? { ...row, profile: currentProfileId(row.profile) } : row)),
    billing: { stripeCustomer: account?.stripe_customer ?? null, subscriptions: subscriptions.results, autoTopup: autoTopup ?? null },
    exportedAt: new Date().toISOString(),
    note: 'Files, prompts, API keys and review text are never stored. Token hashes and passkey public keys are left out of this export.',
  });
}

export async function deleteAccount({ env }: Call, session: Session): Promise<Response> {
  if (await hasApiLiability(env, session.account_id)) {
    throw new ApiError('API credit, a running request or a pending payment remains. Contact support to settle the balance before deleting your account.', 409, 'api_balance_exists');
  }
  // Deleting the account while Stripe can still bill would leave a
  // subscription nobody is able to cancel.
  if (await mayStillBill(env, session.account_id)) {
    throw new ApiError('Cancel the subscription in Manage subscription first. The account can be deleted once it has ended.', 409, 'billing_exists');
  }
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(session.account_id).run();
  return json({ deleted: true }, 200, { cookies: [clearSessionCookie(env)] });
}
