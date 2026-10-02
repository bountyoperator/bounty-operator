// What a signed-in user sees about their own account: status, the portal
// listing, the data export and deletion.

import { PROFILES } from '../public/profiles.mjs';
import { LIMITS } from '../public/review-core.mjs';

import { clearSessionCookie, currentSession } from './auth.ts';
import type { Session } from './auth.ts';
import { billingReady, hasLiveSubscription } from './billing.ts';
import { PRICE, VERSION, seconds } from './env.ts';
import type { Call, Env } from './env.ts';
import { currentProfileId } from './hosted.ts';
import { ApiError, json } from './http.ts';
import { usage } from './quota.mjs';

const HISTORY_ROWS = 30;

function billingState(env: Env): 'live' | 'unavailable' {
  return billingReady(env) ? 'live' : 'unavailable';
}

/** GET /api/account: what the page needs to draw itself, signed in or not. */
export async function accountStatus({ env, request }: Call): Promise<Response> {
  const session = await currentSession(env, request);
  const signedIn = Boolean(session);
  return json({
    signedIn,
    csrf: session?.csrf,
    usage: session ? await usage(env.DB, session.account_id, seconds()) : null,
    billing: billingState(env),
    hasSubscription: session ? await hasLiveSubscription(env.DB, session.account_id) : false,
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
  const [account, passkeys, connections, reviews, hasSubscription, currentUsage] = await Promise.all([
    env.DB.prepare('SELECT id, created_at, email FROM accounts WHERE id = ?').bind(accountId).first(),
    env.DB.prepare('SELECT id, label, created_at FROM passkeys WHERE account_id = ? ORDER BY created_at').bind(accountId).all(),
    env.DB.prepare('SELECT id, label, created_at, expires, last_used FROM api_tokens WHERE account_id = ? AND expires > ? ORDER BY created_at DESC')
      .bind(accountId, now)
      .all(),
    env.DB.prepare('SELECT id, created_at, status, profile, channel FROM reviews WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(accountId, HISTORY_ROWS)
      .all(),
    hasLiveSubscription(env.DB, accountId),
    usage(env.DB, accountId, now),
  ]);

  return {
    account: { ...account, hasSubscription },
    passkeys: passkeys.results,
    connections: connections.results,
    // A row stored by an earlier release may carry an id that has since been renamed.
    reviews: reviews.results.map((row) => (typeof row.profile === 'string' ? { ...row, profile: currentProfileId(row.profile) } : row)),
    usage: currentUsage,
    profiles: PROFILES.map((profile) => ({ id: profile.id, name: profile.name })),
  };
}

export async function portal({ env }: Call, session: Session): Promise<Response> {
  return json(await portalData(env, session.account_id));
}

/** Everything stored about the account, minus the hashes that guard it. */
export async function exportAccount({ env }: Call, session: Session): Promise<Response> {
  return json({
    ...(await portalData(env, session.account_id)),
    exportedAt: new Date().toISOString(),
    note: 'Files, prompts, API keys and review text are never stored. Token hashes and passkey public keys are left out of this export.',
  });
}

export async function deleteAccount({ env }: Call, session: Session): Promise<Response> {
  // Deleting the account while Stripe can still bill would leave a
  // subscription nobody is able to cancel.
  if (await hasLiveSubscription(env.DB, session.account_id)) {
    throw new ApiError('Cancel the subscription in Manage subscription first. The account can be deleted once it has ended.', 409, 'billing_exists');
  }
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(session.account_id).run();
  return json({ deleted: true }, 200, { cookies: [clearSessionCookie(env)] });
}
