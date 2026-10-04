// Hosted reviews: validate, reserve the allowance, call the user's provider,
// and settle the reservation. The provider key lives only in the request.

import { reviewProfile } from '../public/profiles.mjs';
import { ProviderError, provider as findProvider, providerReview, providerStream, validateProviderRequest } from '../public/providers.mjs';
import { checkInputs, prepareReview } from '../public/review-core.mjs';

import { seconds } from './env.ts';
import type { Call, Env } from './env.ts';
import { count } from './funnel.ts';
import { instructionsFor, outputScanner } from './hosted.ts';
import { ApiError, errorBody } from './http.ts';
import { LEASE_SECONDS, extendLease, finishReview, paidAccess, reserveReview } from './quota.mjs';

export type Channel = 'web' | 'mcp';

type ProviderAnswer = Omit<Awaited<ReturnType<typeof providerReview>>, 'text'>;
type InputFiles = Parameters<typeof checkInputs>[0];
type ContextInput = Parameters<typeof checkInputs>[2];
type PrepareOptions = NonNullable<Parameters<typeof prepareReview>[3]>;

export type Prepared = Awaited<ReturnType<typeof prepareReview>>;

export interface ReviewInputs {
  files: InputFiles;
  prompt: string;
  profileId: string;
  context: ContextInput;
  mode: PrepareOptions['mode'];
  acknowledgeWarnings: boolean;
}

export interface ReviewRequest extends ReviewInputs {
  provider: string;
  model: string;
  apiKey: string;
}

export interface ReviewResult {
  review: string;
  manifest: Prepared['manifest'];
  profile: { id: string; name: string };
  mode: string;
  model: string;
  truncated: boolean;
  refused: boolean;
  /** Tokens the provider counted for this call. */
  usage: ProviderAnswer['usage'];
}

export const REVIEW_BODY_BYTES = 1500000;

// The whole call must end inside the lease, or the slot is handed out twice.
const SINGLE_ANSWER_LIMIT_MS = (LEASE_SECONDS - 30) * 1000;
const LEASE_RENEW_SECONDS = 60;
// A comment line is written whenever the provider is silent this long. It keeps
// proxies from closing an idle stream, and a failed write is how the Worker
// learns that the reader has gone when no abort signal arrives.
const KEEP_ALIVE_MS = 5000;
// A reader that disconnects after this much of a streamed review has had a review.
// The same length decides whether an answer the provider cut short counts.
const COUNTED_AFTER_CHARS = 2000;

/** A refusal is not a review, and neither is an answer that broke off before it said anything. */
function counts(answer: { refused: boolean; truncated: boolean }, chars: number): boolean {
  if (answer.refused) return false;
  return !answer.truncated || chars >= COUNTED_AFTER_CHARS;
}

const KEEP_ALIVE = Symbol('keep-alive');

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function providerShapeError(error: unknown): ApiError {
  const message = messageOf(error, 'Select a supported provider.');
  let code = 'bad_key';
  if (message.includes('supported provider')) code = 'bad_provider';
  else if (message.includes('model identifier')) code = 'bad_model';
  return new ApiError(message, 400, code);
}

/** The stored id of the requested profile. An empty value means the general profile. */
export function resolveProfileId(value: unknown): string {
  const id = value === undefined || value === null || value === '' ? 'general' : value;
  try {
    if (typeof id !== 'string') throw new Error();
    // reviewProfile also resolves an id an earlier release stored.
    return reviewProfile(id).id;
  } catch {
    throw new ApiError('Choose a supported review profile.', 400, 'bad_profile');
  }
}

/**
 * Checks everything about a review request that needs no I/O: profile,
 * provider, model and key shape. Nothing has been reserved or sent when this
 * throws. `apiKey` comes from the body on the web and from a header over MCP.
 */
export function parseReviewRequest(body: Record<string, unknown>, apiKey: unknown = body.apiKey): ReviewRequest {
  const profileId = resolveProfileId(body.profile);

  let selected;
  try {
    selected = findProvider(body.provider as string);
  } catch (error) {
    throw providerShapeError(error);
  }
  const model = body.model === undefined || body.model === null || body.model === '' ? selected.defaultModel : body.model;
  try {
    validateProviderRequest({ provider: selected.id, model, apiKey });
  } catch (error) {
    throw providerShapeError(error);
  }

  return {
    ...parseReviewInputs(body, profileId),
    provider: selected.id,
    model: model as string,
    apiKey: apiKey as string,
  };
}

/** The part of a request that describes what to review. The engine checks the values themselves. */
export function parseReviewInputs(body: Record<string, unknown>, profileId: string): ReviewInputs {
  const prompt = body.prompt ?? '';
  if (typeof prompt !== 'string') throw new ApiError('Instructions must be text.', 400, 'bad_input');
  return {
    files: body.files as InputFiles,
    prompt,
    profileId,
    context: body.context as ContextInput,
    mode: body.mode as PrepareOptions['mode'],
    acknowledgeWarnings: body.acknowledgeWarnings === true,
  };
}

function assertReviewsEnabled(env: Env): void {
  if (env.AI_REVIEW_ENABLED !== 'true') {
    throw new ApiError('Reviews on your API key are paused. Copy-paste reviews in your chat app still work.', 503, 'reviews_paused');
  }
}

// The two profiles that exist only inside an Operator run: the last stage of
// the gauntlet and the cross-examination of a panel review.
const OPERATOR_RUNS: Readonly<Record<string, string>> = Object.freeze({
  verdict: 'the last stage of the gauntlet',
  panel: 'the cross-examination of a panel review',
});

/** True for a profile that runs only as part of the gauntlet or a panel review. */
export function operatorOnly(profileId: string): boolean {
  return Object.hasOwn(OPERATOR_RUNS, profileId) || !reviewProfile(profileId).listed;
}

/**
 * Refuses a gauntlet or panel profile for an account without an active
 * Operator plan. Runs before the inputs are read: nothing is reserved, nothing
 * reaches the provider and the daily review stays unused.
 */
export async function assertPlanCovers(env: Env, accountId: string, profileId: string): Promise<void> {
  if (!operatorOnly(profileId)) return;
  if (await paidAccess(env.DB, accountId, seconds())) return;
  const profile = reviewProfile(profileId);
  const part = OPERATOR_RUNS[profile.id] ?? 'part of an Operator run';
  throw new ApiError(
    `${profile.name} is ${part}, which runs on Operator. Nothing was sent to the provider and today's review was not used.`,
    403,
    'operator_only',
    { profile: profile.id, upgradeUrl: `${env.SITE_ORIGIN}/pricing` },
  );
}

/** What a caller is told when it asks for the method of a hosted profile. */
export function hostedProfileError(profileId: string): ApiError {
  const profile = reviewProfile(profileId);
  return new ApiError(
    `${profile.name} runs on the server. Call run_review with profile "${profile.id}", your connection token and your provider key in the X-Provider-Key header.`,
    400,
    'hosted_profile',
    { profile: profile.id },
  );
}

async function prepare(input: ReviewInputs, hosted: boolean): Promise<Prepared> {
  let coverage;
  try {
    coverage = checkInputs(input.files, input.prompt, input.context);
  } catch (error) {
    throw new ApiError(messageOf(error, 'The files could not be read.'), 400, 'bad_input');
  }

  try {
    return await prepareReview(input.files, input.prompt, input.profileId, {
      acknowledgeWarnings: input.acknowledgeWarnings,
      context: input.context,
      mode: input.mode,
      coverage,
      instructionsFor: hosted ? instructionsFor : undefined,
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'privacy_block' || code === 'privacy_warn') {
      throw new ApiError(messageOf(error, 'Privacy check found sensitive material.'), 422, code, {
        findings: (error as { findings?: unknown }).findings ?? [],
      });
    }
    if (code === 'hosted_profile') {
      if (!hosted) throw hostedProfileError(input.profileId);
      // The build holds no method for this profile. Nothing was reserved or sent.
      console.error('Hosted profile has no method', { profile: input.profileId });
      throw new ApiError('This review profile is not available right now. Nothing was counted.', 503, 'profile_unavailable');
    }
    throw new ApiError(messageOf(error, 'The review request is not valid.'), 400, 'bad_input');
  }
}

/**
 * Runs the size limits and the privacy scan, then builds the provider messages
 * for a review this server runs. A hosted profile gets its method here. The
 * result holds that method in `messages`: it goes to the provider and is never
 * returned to a client.
 *
 * Every failure is an ApiError: `bad_input`, `privacy_block` or `privacy_warn`,
 * the last two with the findings attached.
 */
export function prepareChecked(input: ReviewInputs): Promise<Prepared> {
  return prepare(input, true);
}

/**
 * The same checks for a review the caller's own model writes, whose messages
 * are handed back. Only a core profile has a method to hand back: a hosted
 * one fails with `hosted_profile` before any file is read.
 */
export async function prepareOpen(input: ReviewInputs): Promise<Prepared> {
  if (reviewProfile(input.profileId).hosted) throw hostedProfileError(input.profileId);
  return prepare(input, false);
}

async function reserve(env: Env, ctx: ExecutionContext, accountId: string, profileId: string, channel: Channel): Promise<string> {
  const id = crypto.randomUUID();
  const now = seconds();
  const outcome = await reserveReview(env.DB, accountId, id, now, { profile: profileId, channel });
  if (outcome.ok) return id;

  if (outcome.reason === 'review_running') {
    throw new ApiError('This account is running as many reviews as its plan allows. Start the next one when one finishes.', 409, 'review_running');
  }
  count(env, ctx, 'quota_hit');
  const resetsAt = new Date((Math.floor(now / 86400) + 1) * 86400000).toISOString();
  throw new ApiError("Today's free review is used. The next one opens at 00:00 UTC. Operator has no daily limit.", 429, 'daily_used', {
    resetsAt,
    upgradeUrl: `${env.SITE_ORIGIN}/pricing`,
  });
}

/**
 * Returns a function that ends the reservation exactly once. The database
 * write runs after the response, so a failed write cannot cost the user a
 * review the provider has already written.
 */
function createSettler(env: Env, ctx: ExecutionContext, accountId: string, reviewId: string, profileId: string) {
  let settled = false;
  return (counted: boolean): void => {
    if (settled) return;
    settled = true;
    ctx.waitUntil(
      finishReview(env.DB, accountId, reviewId, counted).catch((error: unknown) => {
        console.error('Review bookkeeping failed', { name: error instanceof Error ? error.name : 'unknown' });
      }),
    );
    count(env, ctx, counted ? `review_ok:${profileId}` : 'review_fail');
  };
}

/**
 * The answer repeated the profile's method. It is stopped, nothing of the
 * repeated text is returned, and the attempt uses the review.
 */
function withheld(): ApiError {
  return new ApiError(
    'The model repeated its instructions instead of reviewing, so the answer was stopped and the call used one review. Run it again or choose a stronger model.',
    502,
    'output_withheld',
  );
}

/** What the client is told when a reserved review does not complete. */
export function reviewFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ProviderError) {
    const extra: Record<string, unknown> = { kind: error.kind };
    if (error.retryAfter) extra.retryAfter = error.retryAfter;
    return new ApiError(error.message, error.kind === 'timeout' ? 504 : 502, 'provider', extra);
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    const limit = SINGLE_ANSWER_LIMIT_MS / 1000;
    return new ApiError(
      `Provider did not finish within ${limit} seconds. Run the review again with streaming on, or pick a faster model.`,
      504,
      'provider',
      { kind: 'timeout' },
    );
  }
  return new ApiError('The review did not finish. It was not counted against your allowance. Run it again.', 502, 'review_failed');
}

function toResult(prepared: Prepared, review: string, answer: ProviderAnswer): ReviewResult {
  return {
    review,
    manifest: prepared.manifest,
    profile: { id: prepared.profile.id, name: prepared.profile.name },
    mode: prepared.mode,
    model: answer.model,
    truncated: answer.truncated,
    refused: answer.refused,
    usage: answer.usage,
  };
}

function providerCall(input: ReviewRequest, prepared: Prepared, signal: AbortSignal) {
  return { provider: input.provider, model: input.model, apiKey: input.apiKey, prepared, signal };
}

/** Runs a hosted review and returns the whole answer. */
export async function runHostedReview({ env, ctx, request }: Call, accountId: string, input: ReviewRequest, channel: Channel): Promise<ReviewResult> {
  assertReviewsEnabled(env);
  await assertPlanCovers(env, accountId, input.profileId);
  const prepared = await prepareChecked(input);
  const reviewId = await reserve(env, ctx, accountId, input.profileId, channel);
  const settle = createSettler(env, ctx, accountId, reviewId, input.profileId);

  // request.signal aborts when the client disconnects, which stops the provider call.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(SINGLE_ANSWER_LIMIT_MS)]);
  try {
    const { text, ...answer } = await providerReview(providerCall(input, prepared, signal));
    const scanner = outputScanner(input.profileId);
    if (scanner) {
      scanner.push(text);
      scanner.finish();
      if (scanner.leaked) {
        settle(true);
        throw withheld();
      }
    }
    settle(counts(answer, text.length));
    return toResult(prepared, text, answer);
  } catch (error) {
    settle(false);
    throw reviewFailure(error);
  }
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Yields the source's values, and KEEP_ALIVE whenever it stays silent for `intervalMs`. */
async function* withKeepAlive<T>(source: AsyncIterable<T>, intervalMs: number): AsyncGenerator<T | typeof KEEP_ALIVE> {
  const iterator = source[Symbol.asyncIterator]();
  let next = iterator.next();
  try {
    for (;;) {
      // The timer never leaves the closure that made it, so its type is
      // whatever setTimeout returns: a number under the Workers types, a
      // Timeout object under Node's. Both type sets accept that for clearTimeout.
      let stopTimer = (): void => {};
      const silence = new Promise<typeof KEEP_ALIVE>((resolve) => {
        const timer = setTimeout(() => resolve(KEEP_ALIVE), intervalMs);
        stopTimer = () => clearTimeout(timer);
      });
      const winner = await Promise.race([next, silence]).finally(() => stopTimer());

      if (winner === KEEP_ALIVE) {
        yield KEEP_ALIVE;
        continue;
      }
      if (winner.done) return;
      yield winner.value;
      next = iterator.next();
    }
  } finally {
    // The consumer stopped early. Close the source without waiting on a read
    // that may never return; the caller has aborted the provider request.
    next.catch(() => {});
    void iterator.return?.(undefined)?.catch(() => {});
  }
}

/**
 * Runs a hosted review as server-sent events: `delta` {text} while the model
 * writes, then one `done` with the same body the JSON route returns, or one
 * `error` {error, code}.
 *
 * Errors the provider reports before its first token (bad key, unknown model,
 * rate limit) are thrown, so the caller answers them as ordinary JSON errors.
 */
export async function streamHostedReview({ env, ctx, request }: Call, accountId: string, input: ReviewRequest, channel: Channel): Promise<Response> {
  assertReviewsEnabled(env);
  await assertPlanCovers(env, accountId, input.profileId);
  const prepared = await prepareChecked(input);
  const reviewId = await reserve(env, ctx, accountId, input.profileId, channel);
  const settle = createSettler(env, ctx, accountId, reviewId, input.profileId);

  const abort = new AbortController();
  let clientGone = false;
  const onDisconnect = (): void => {
    clientGone = true;
    abort.abort();
  };
  if (request.signal.aborted) onDisconnect();
  else request.signal.addEventListener('abort', onDisconnect, { once: true });

  let events: Awaited<ReturnType<typeof providerStream>>;
  try {
    events = await providerStream(providerCall(input, prepared, abort.signal));
  } catch (error) {
    settle(false);
    throw reviewFailure(error);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (text: string): Promise<void> => {
    try {
      await writer.write(encoder.encode(text));
    } catch (error) {
      // The reader is gone: stop the provider call at once.
      onDisconnect();
      throw error;
    }
  };

  let leaseRenewedAt = seconds();
  const keepLease = (): void => {
    const now = seconds();
    if (now - leaseRenewedAt < LEASE_RENEW_SECONDS) return;
    leaseRenewedAt = now;
    ctx.waitUntil(extendLease(env.DB, accountId, reviewId, now).catch(() => {}));
  };

  // The answer of a hosted profile passes through the scanner, which holds
  // text back until it is known not to open a copy of the method.
  const scanner = outputScanner(input.profileId);
  const checked = (released: string): string => {
    if (scanner?.leaked) {
      settle(true);
      throw withheld();
    }
    return released;
  };

  const pump = async (): Promise<void> => {
    const parts: string[] = [];
    let delivered = 0;
    let finished = false;
    const deliver = async (text: string): Promise<void> => {
      if (!text) return;
      await send(sseEvent('delta', { text }));
      delivered += text.length;
    };
    try {
      for await (const event of withKeepAlive(events, KEEP_ALIVE_MS)) {
        keepLease();
        if (event === KEEP_ALIVE) {
          await send(': keep-alive\n\n');
        } else if (event.type === 'delta') {
          parts.push(event.text);
          await deliver(scanner ? checked(scanner.push(event.text)) : event.text);
        } else {
          if (scanner) await deliver(checked(scanner.finish()));
          finished = true;
          settle(counts(event, delivered));
          await send(sseEvent('done', toResult(prepared, parts.join(''), event)));
        }
      }
      if (!finished) throw new Error('The provider stream ended without a result.');
      await writer.close();
    } catch (error) {
      abort.abort();
      settle(clientGone && delivered >= COUNTED_AFTER_CHARS);
      if (!finished && !clientGone) {
        await send(sseEvent('error', errorBody(reviewFailure(error)))).catch(() => {});
      }
      await writer.close().catch(() => {});
    } finally {
      request.signal.removeEventListener('abort', onDisconnect);
    }
  };
  // waitUntil keeps the Worker alive to settle the reservation after the client has left.
  ctx.waitUntil(pump());

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' },
  });
}
