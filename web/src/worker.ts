// The router. Every request enters here, and every response leaves through
// finalize(), which is the only place security and cache headers are set.

import { PROFILES } from '../public/profiles.mjs';
import { boundedBody } from '../public/review-core.mjs';

import { accountStatus, clientStatus, deleteAccount, exportAccount, portal } from './account.ts';
import {
  addPasskeyOptions,
  addPasskeyVerify,
  bearerAccount,
  createConnection,
  loginOptions,
  loginVerify,
  logout,
  logoutEverywhere,
  recover,
  registerOptions,
  registerVerify,
  removePasskey,
  requireRecentAuth,
  requireSession,
  revokeConnection,
  rotateRecovery,
} from './auth.ts';
import type { Session } from './auth.ts';
import { billingFailure, billingLogFields, billingReady, createCheckout, createPortal, handleWebhook, reconcileCheckout } from './billing.ts';
import { VERSION, seconds } from './env.ts';
import type { Call, Env } from './env.ts';
import { CLIENT_EVENTS, count } from './funnel.ts';
import { METHOD_SOURCE, missingMethods } from './hosted.ts';
import { ApiError, aliasRedirect, canonicalRedirect, compressPage, errorResponse, finalize, internalError, json, pageRedirect, readJson, redirectResponse } from './http.ts';
import { mcpEndpoint } from './mcp.ts';
import { reapStaleLeases, usage } from './quota.mjs';
import { clientKey, edgeLimit, rateLimit } from './rate.ts';
import { REVIEWS_PER_10_MIN, REVIEW_BODY_BYTES, parseReviewRequest, runHostedReview, streamHostedReview } from './review.ts';
import { serveAsset } from './static.ts';

const AUTH_REQUESTS_PER_HOUR = 90;
const BILLING_REQUESTS_PER_10_MIN = 6;
const RECONCILES_PER_10_MIN = 12;
const EVENTS_PER_10_MIN = 60;
const WEBHOOK_BODY_BYTES = 1000000;
const WEBHOOK_PATH = '/api/stripe/webhook';
const DAILY_CRON = '17 3 * * *';

type Handler = (call: Call) => Promise<Response>;
type SessionHandler = (call: Call, session: Session) => Promise<Response>;

// ---------------------------------------------------------------------------
// Who may call a route
// ---------------------------------------------------------------------------

/** A route for the site's own pages. Another origin cannot make a browser send this request. */
function fromSite(handler: Handler): Handler {
  return async (call) => {
    if (call.request.headers.get('origin') !== call.env.SITE_ORIGIN) {
      throw new ApiError('Request origin is not allowed.', 403, 'origin');
    }
    return handler(call);
  };
}

/** A sign-in route: from the site, and limited per network address. */
function authRoute(handler: Handler): Handler {
  return fromSite(async (call) => {
    await rateLimit(call.env.DB, `auth:${await clientKey(call.env, call.request)}`, AUTH_REQUESTS_PER_HOUR, 3600);
    return handler(call);
  });
}

/** A read for the signed-in user. */
function signedInRead(handler: SessionHandler): Handler {
  return async (call) => handler(call, await requireSession(call.env, call.request, { csrf: false }));
}

/** A change by the signed-in user: from the site, with the session's CSRF token. */
function signedIn(handler: SessionHandler): Handler {
  return fromSite(async (call) => handler(call, await requireSession(call.env, call.request)));
}

/** A change to the account's credentials: also needs a passkey check from the last ten minutes. */
function recentlyVerified(handler: SessionHandler): Handler {
  return signedIn(async (call, session) => {
    requireRecentAuth(session);
    return handler(call, session);
  });
}

// ---------------------------------------------------------------------------
// Handlers too small for a module of their own
// ---------------------------------------------------------------------------

async function health({ env }: Call): Promise<Response> {
  // On a public origin the address hashes need their secret key: without it
  // they fall back to a value derived from the origin, which anyone can compute.
  const ipKey = env.IP_HASH_KEY || !env.SITE_ORIGIN.startsWith('https:') ? 'ok' : 'missing';
  const body = {
    status: ipKey === 'ok' ? 'ok' : 'degraded',
    version: VERSION,
    billing: billingReady(env) ? 'live' : 'unavailable',
    reviews: env.AI_REVIEW_ENABLED === 'true',
    // 'hosted' when the Worker was built with the production method. A build
    // from the community stub, or one that lacks a profile, says so here.
    profiles: METHOD_SOURCE === 'private' && missingMethods().length === 0 ? 'hosted' : 'community',
    db: 'ok',
    ipKey,
    deployment: env.CF_VERSION_METADATA?.id,
  };
  try {
    // Reads a column from every migration, so a deploy that is ahead of the
    // database schema reports itself instead of failing each review.
    await env.DB.batch([
      env.DB.prepare('SELECT profile, channel, lease_until FROM reviews LIMIT 1'),
      env.DB.prepare('SELECT auth_at FROM sessions LIMIT 1'),
      env.DB.prepare('SELECT email FROM accounts LIMIT 1'),
      env.DB.prepare('SELECT n FROM funnel_daily LIMIT 1'),
    ]);
    return json(body);
  } catch {
    return json({ ...body, status: 'degraded', db: 'error' }, 503);
  }
}

async function profiles(): Promise<Response> {
  // Metadata only. A hosted profile has no method in this list, or anywhere else a client can reach.
  const listed = PROFILES.filter((profile) => profile.listed).map(({ id, name, tagline, description, mode, needs, next, hosted, sections }) => ({
    id,
    name,
    tagline,
    description,
    mode,
    needs,
    next,
    hosted,
    sections,
  }));
  return json({ profiles: listed });
}

async function review(call: Call, session: Session): Promise<Response> {
  // The limit comes before the body is read: a flood costs one counter, not a 1.5 MB parse.
  await rateLimit(call.env.DB, `review:${session.account_id}`, REVIEWS_PER_10_MIN, 600);
  const body = await readJson(call.request, REVIEW_BODY_BYTES);
  const input = parseReviewRequest(body);
  if (body.stream === true) return streamHostedReview(call, session.account_id, input, 'web');
  return json(await runHostedReview(call, session.account_id, input, 'web'));
}

async function clientReview(call: Call): Promise<Response> {
  const accountId = await bearerAccount(call);
  await rateLimit(call.env.DB, `review:${accountId}`, REVIEWS_PER_10_MIN, 600);
  const body = await readJson(call.request, REVIEW_BODY_BYTES);
  return json(await runHostedReview(call, accountId, parseReviewRequest(body), 'mcp'));
}

async function clientAccount(call: Call): Promise<Response> {
  return json(await clientStatus(call.env, await bearerAccount(call)));
}

async function event({ env, ctx, request }: Call): Promise<Response> {
  await rateLimit(env.DB, `event:${await clientKey(env, request)}`, EVENTS_PER_10_MIN, 600);
  const body = await readJson(request, 200, true);
  if (typeof body.event !== 'string' || !CLIENT_EVENTS.has(body.event)) {
    throw new ApiError('Unknown event.', 400, 'bad_event');
  }
  count(env, ctx, body.event);
  return new Response(null, { status: 204 });
}

/** Wraps a billing call: limited per account, and every Stripe failure becomes a coded error. */
function billingRoute(limitKey: string, max: number, handler: SessionHandler): Handler {
  return signedIn(async (call, session) => {
    await rateLimit(call.env.DB, `${limitKey}:${session.account_id}`, max, 600);
    try {
      return await handler(call, session);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        console.error('Billing call failed', { path: call.url.pathname, ...billingLogFields(error) });
      }
      throw billingFailure(error);
    }
  });
}

const checkout = billingRoute('billing', BILLING_REQUESTS_PER_10_MIN, async ({ env, ctx }, session) =>
  json({ url: await createCheckout(env, ctx, session.account_id) }),
);

const billingPortal = billingRoute('billing', BILLING_REQUESTS_PER_10_MIN, async ({ env }, session) =>
  json({ url: await createPortal(env, session.account_id) }),
);

const reconcile = billingRoute('reconcile', RECONCILES_PER_10_MIN, async ({ env, ctx, request }, session) => {
  const body = await readJson(request, 2000);
  await reconcileCheckout(env, ctx, session.account_id, body.sessionId);
  return json({ usage: await usage(env.DB, session.account_id, seconds()) });
});

async function stripeWebhook({ env, ctx, request }: Call): Promise<Response> {
  let body: string;
  try {
    body = await boundedBody(request, WEBHOOK_BODY_BYTES);
  } catch {
    throw new ApiError('Request exceeds the size limit.', 413, 'too_large');
  }
  try {
    return await handleWebhook(env, ctx, request, body);
  } catch (error) {
    // A failed sync answers 5xx, so Stripe delivers the event again.
    console.error('Stripe webhook failed', billingLogFields(error));
    throw billingFailure(error);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ROUTES: Readonly<Record<string, Readonly<Record<string, Handler>>>> = {
  '/api/health': { GET: health },
  '/api/profiles': { GET: profiles },
  '/api/account': { GET: accountStatus },
  '/api/portal': { GET: signedInRead(portal) },
  '/api/account/export': { GET: signedInRead(exportAccount) },
  '/api/account/delete': { POST: recentlyVerified(deleteAccount) },

  '/api/auth/register/options': { POST: authRoute(registerOptions) },
  '/api/auth/register/verify': { POST: authRoute(registerVerify) },
  '/api/auth/login/options': { POST: authRoute(loginOptions) },
  '/api/auth/login/verify': { POST: authRoute(loginVerify) },
  '/api/auth/recover': { POST: authRoute(recover) },
  '/api/auth/add/options': { POST: recentlyVerified(addPasskeyOptions) },
  '/api/auth/add/verify': { POST: signedIn(addPasskeyVerify) },
  '/api/auth/logout': { POST: signedIn(logout) },
  '/api/auth/logout-all': { POST: signedIn(logoutEverywhere) },
  '/api/auth/rotate-recovery': { POST: recentlyVerified(rotateRecovery) },
  '/api/passkeys/remove': { POST: recentlyVerified(removePasskey) },
  '/api/connections/create': { POST: recentlyVerified(createConnection) },
  '/api/connections/revoke': { POST: signedIn(revokeConnection) },

  '/api/review': { POST: signedIn(review) },
  '/api/client/review': { POST: clientReview },
  '/api/client/account': { GET: clientAccount },
  '/api/mcp': { POST: mcpEndpoint },
  '/api/event': { POST: fromSite(event) },

  '/api/billing/checkout': { POST: checkout },
  '/api/billing/portal': { POST: billingPortal },
  '/api/billing/reconcile': { POST: reconcile },
  [WEBHOOK_PATH]: { POST: stripeWebhook },
};

async function route(call: Call): Promise<Response> {
  const { env, request, url } = call;
  const methods = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
  if (!methods) throw new ApiError('Endpoint not found.', 404, 'not_found');

  // HEAD is answered as GET; the runtime drops the body.
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const handler = Object.hasOwn(methods, method) ? methods[method] : null;
  if (!handler) {
    throw new ApiError('Method not allowed.', 405, 'method_not_allowed', { allow: Object.keys(methods).join(', ') });
  }

  // Stripe signs its webhooks and sends them from many addresses, so an
  // address limit there would only drop real events.
  if (request.method === 'POST' && url.pathname !== WEBHOOK_PATH) {
    await edgeLimit(env, await clientKey(env, request));
  }
  return handler(call);
}

async function handleApi(call: Call): Promise<Response> {
  try {
    return await route(call);
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    // Only the path and the error class are logged: never a body, a key, file
    // contents, a Stripe payload or an upstream message.
    console.error('Request failed', { path: call.url.pathname, name: error instanceof Error ? error.name : 'unknown' });
    return errorResponse(internalError());
  }
}

// ---------------------------------------------------------------------------
// Scheduled cleanup
// ---------------------------------------------------------------------------

async function purgeExpired(env: Env, now: number): Promise<Record<string, number>> {
  const day = 86400;
  const oldestFunnelDay = new Date((now - 400 * day) * 1000).toISOString().slice(0, 10);
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
    env.DB.prepare('DELETE FROM challenges WHERE expires < ?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires < ?').bind(now),
    env.DB.prepare('DELETE FROM api_tokens WHERE expires < ?').bind(now),
    env.DB.prepare('DELETE FROM reviews WHERE created_at < ?').bind(now - 7 * day),
    env.DB.prepare('DELETE FROM stripe_events WHERE created_at < ?').bind(now - 30 * day),
    env.DB.prepare('DELETE FROM funnel_daily WHERE day < ?').bind(oldestFunnelDay),
  ]);
  const names = ['sessions', 'challenges', 'rateLimits', 'apiTokens', 'reviews', 'stripeEvents', 'funnelDays'];
  return Object.fromEntries(names.map((name, index) => [name, results[index].meta.changes]));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const call: Call = { request, env, ctx, url };

    const location = canonicalRedirect(request.method, url, env.SITE_ORIGIN) ?? aliasRedirect(request.method, url) ?? pageRedirect(request.method, url);
    if (location) return finalize(redirectResponse(location), 'redirect', url.pathname);

    if (url.pathname.startsWith('/api/')) return finalize(await handleApi(call), 'api', url.pathname);
    return compressPage(finalize(await serveAsset(call), 'static', url.pathname), request);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = seconds();
    // Every run frees reviews whose Worker was stopped mid-call. The daily run also purges expired rows.
    const reapedLeases = await reapStaleLeases(env.DB, now);
    const purged = controller.cron === DAILY_CRON ? await purgeExpired(env, now) : {};
    console.log('Scheduled cleanup', { cron: controller.cron, reapedLeases, ...purged });
  },
} satisfies ExportedHandler<Env>;
