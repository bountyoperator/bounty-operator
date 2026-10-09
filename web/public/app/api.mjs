/**
 * Calls to the Worker: the account cache, JSON requests, the streamed review,
 * the passkey re-check and the event counter.
 *
 * This module imports nothing but ./events.mjs and touches no DOM, so any page
 * can load it.
 *
 * Exports
 *   class ApiError(message, { code, status, data })
 *   toApiError(status, body, { retryAfter }?)        -> ApiError
 *
 *   account()                                        -> Promise<Account>   cached; the first call loads it
 *   currentAccount()                                 -> Account            synchronous snapshot
 *   refreshAccount()                                 -> Promise<Account>   always asks the Worker
 *   subscribeAccount(listener, { immediate }?)       -> unsubscribe()
 *   planOf(account?)                                 -> 'anon' | 'free' | 'operator' | 'past_due'
 *
 *   request(path, { method, body, signal }?)         -> Promise<any>       parsed JSON, or null for 204
 *   streamReview(body, { onDelta, onDone, onError, signal }?) -> Promise<ReviewResult | null>
 *   createSseParser(onEvent)                         -> { feed(text), end() }
 *
 *   setReauthHandler(handler)                        -> unregister()
 *   withReauth(fn)                                   -> Promise<result of fn>
 *
 *   track(event)                                     -> boolean            fire-and-forget
 *
 * Errors
 *   Every failure is an ApiError. Switch on `error.code`, show `error.message`.
 *   `error.status` is the HTTP status, or 0 when no HTTP error answer exists.
 *   `error.data` holds the other fields of the Worker's error body.
 *
 *   Codes from the Worker (web/src): signin, reauth, csrf, origin, token,
 *   passkey, challenge_expired, recovery, last_passkey, connection_limit,
 *   forbidden, bad_request, too_large, bad_profile, bad_provider, bad_model,
 *   bad_key, bad_input, bad_event, privacy_block and privacy_warn
 *   (data.findings), daily_used (data.resetsAt, data.upgradeUrl),
 *   operator_only (data.profile, data.upgradeUrl), output_withheld,
 *   review_running, provider (data.kind, data.retryAfter), provider_policy
 *   (data.blocked, data.detail: the provider blocked the request under its
 *   usage policy; not counted), review_failed, reviews_paused, rate_limited (data.retryAfter), billing_exists,
 *   billing_unavailable, billing_busy, billing_none, not_found,
 *   method_not_allowed, internal.
 *
 *   Codes this module adds:
 *     network       the request never reached the Worker
 *     aborted       the caller's AbortSignal fired
 *     timeout       a streamed review went silent (data.partial)
 *     stream_ended  the stream closed with no `done` and no `error` (data.partial)
 *     bad_response  the answer was not the JSON or event stream expected
 *     unavailable   a 5xx answer with no JSON body
 *
 * What the module does without being asked
 *   - A POST answered with `csrf` reloads the account and is sent once more.
 *     The first attempt was refused before any handler ran.
 *   - An answer with code `signin` marks the cached account signed out.
 *   - A successful answer that carries `signedIn` (sign-in, registration,
 *     recovery, sign-out) or ends the account updates the cache and reloads it,
 *     so nobody has to call refreshAccount() after those calls.
 *   - streamReview() reloads the account when it settles, because a review
 *     changes `usage`.
 *   - The account is reloaded when the tab becomes visible after a minute away.
 *
 * @typedef {object} Usage
 * @property {'free' | 'weekly' | 'past_due'} plan
 * @property {number} usedToday
 * @property {number | null} remainingToday   null on the paid plan
 * @property {number} running
 * @property {number} concurrency              1 on free, 4 on Operator
 * @property {string} resetsAt                 ISO 8601, the next 00:00 UTC
 * @property {string | null} paidUntil         ISO 8601
 *
 * @typedef {object} Account
 * @property {boolean} loaded        false until the first answer from GET /api/account
 * @property {boolean} signedIn
 * @property {string} csrf           '' when signed out
 * @property {Usage | null} usage    null when signed out
 * @property {'live' | 'unavailable'} billing
 * @property {boolean} hasSubscription
 * @property {{ files: number, fileBytes: number, totalBytes: number, promptChars: number, totalLines?: number } | null} limits   the engine's LIMITS; null until loaded
 * @property {{ usd: number, interval: string } | null} price
 * @property {string} version
 *
 * @typedef {object} ReviewBody       what POST /api/review reads
 * @property {{ name: string, content: string }[]} files
 * @property {string} [prompt]        the focus text; empty uses the profile's default
 * @property {string} [profile]       profile id; empty means 'general'
 * @property {string} provider
 * @property {string} [model]         empty uses the provider's default
 * @property {string} apiKey          sent with this request only; never stored
 * @property {object} [context]
 * @property {'bounty' | 'own-code'} [mode]
 * @property {boolean} [acknowledgeWarnings]
 *
 * @typedef {object} ReviewResult     the `done` event, and the JSON answer
 * @property {string} review
 * @property {{ label: string, bytes: number, sha256: string, lines: number }[]} manifest
 * @property {{ id: string, name: string }} profile
 * @property {'bounty' | 'own-code'} mode
 * @property {string} model
 * @property {boolean} truncated        the answer was cut short: the output cap, or a provider that broke off mid-answer
 * @property {boolean} refused          the model or the provider declined. A short refusal is not counted; a long answer the model ended with one is
 * @property {'anthropic-cyber' | 'anthropic-reasoning' | 'openai-cyber' | 'guardrail' | 'policy'} [blocked]   the provider blocked the review; never counted. See ./blocked.mjs
 * @property {{ input: number | null, output: number | null }} usage   provider token counts
 *
 * @typedef {{ event: string, data: string }} SseEvent
 */

import { isClientEvent } from './events.mjs';

const ACCOUNT_PATH = '/api/account';
const REVIEW_PATH = '/api/review';
const EVENT_PATH = '/api/event';
const DELETE_PATH = '/api/account/delete';
const RECONCILE_PATH = '/api/billing/reconcile';

// The Worker waits up to 180 seconds for the provider's first byte.
const FIRST_BYTE_MS = 300000;
// The Worker writes a keep-alive comment every 5 seconds. Once the first bytes
// have arrived the path is known to stream, and a minute of silence means the
// connection is dead.
const IDLE_MS = 60000;
// One SSE line. The `done` event carries the whole review and the manifest.
const MAX_LINE_CHARS = 16000000;
const STALE_AFTER_MS = 60000;
const SIGNED_OUT_RECHECK_MS = 5000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  /**
   * @param {string} message  Text written for the user.
   * @param {{ code?: string, status?: number, data?: Record<string, unknown> }} [details]
   */
  constructor(message, { code = 'bad_response', status = 0, data = {} } = {}) {
    super(message);
    this.name = 'ApiError';
    /** The stable value to switch on. */
    this.code = code;
    /** HTTP status, or 0 when no HTTP error answer exists. */
    this.status = status;
    /** The other fields of the error body: findings, resetsAt, retryAfter, kind, blocked, detail, partial. */
    this.data = data;
  }
}

function fallbackFor(status) {
  if (status === 413) return { code: 'too_large', message: 'Request exceeds the size limit.' };
  if (status === 429) return { code: 'rate_limited', message: 'Too many requests. Wait a minute and try again.' };
  if (status >= 500) return { code: 'unavailable', message: `The service did not answer (HTTP ${status}). Try again in a minute.` };
  if (status >= 400) return { code: 'bad_response', message: `The request failed (HTTP ${status}).` };
  return { code: 'bad_response', message: 'The service sent an answer that could not be read. Try again.' };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Builds the ApiError for an error answer. `body` is the parsed JSON
 * `{ error, code, …extra }`; anything else gets a message chosen by status.
 *
 * @param {number} status
 * @param {unknown} body
 * @param {{ retryAfter?: string | number | null }} [options]  The Retry-After header, used when the body has no `retryAfter`.
 * @returns {ApiError}
 */
export function toApiError(status, body, { retryAfter = null } = {}) {
  const { error, code, ...data } = isRecord(body) ? body : {};
  const fallback = fallbackFor(status);
  const seconds = Number(retryAfter);
  if (data.retryAfter === undefined && retryAfter !== null && retryAfter !== '' && Number.isFinite(seconds) && seconds >= 0) {
    data.retryAfter = seconds;
  }
  return new ApiError(typeof error === 'string' && error ? error : fallback.message, {
    code: typeof code === 'string' && code ? code : fallback.code,
    status,
    data,
  });
}

function abortedError() {
  return new ApiError('Stopped.', { code: 'aborted' });
}

/** Turns anything thrown on the way to the Worker into an ApiError. */
function asApiError(error) {
  if (error instanceof ApiError) return error;
  if (error && typeof error === 'object' && error.name === 'AbortError') return abortedError();
  return new ApiError('Could not reach Bounty Operator. Check the connection and try again.', { code: 'network' });
}

/** Runs a caller's callback. A bug in it is reported and never interrupts the call in progress. */
function safely(callback, ...values) {
  if (typeof callback !== 'function') return;
  try {
    callback(...values);
  } catch (error) {
    if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
    else console.error(error);
  }
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

function assertApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new TypeError('request() takes a path that starts with /api/.');
  }
}

function jsonHeaders(mutating) {
  const headers = { Accept: 'application/json' };
  if (mutating) {
    headers['Content-Type'] = 'application/json';
    if (cached.csrf) headers['X-CSRF-Token'] = cached.csrf;
  }
  return headers;
}

async function readJsonBody(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One JSON exchange. Resolves with the parsed body, or throws an ApiError. */
async function exchange(path, method, body, signal) {
  if (signal?.aborted) throw abortedError();
  const mutating = method !== 'GET' && method !== 'HEAD';

  let response;
  let parsed;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: jsonHeaders(mutating),
      // A POST always carries a JSON object: the Worker refuses any other body.
      ...(mutating ? { body: JSON.stringify(body === undefined ? {} : body) } : {}),
      signal,
    });
    parsed = response.status === 204 ? null : await readJsonBody(response);
  } catch (error) {
    throw asApiError(error);
  }

  if (!response.ok) throw toApiError(response.status, parsed, { retryAfter: response.headers.get('retry-after') });
  if (parsed === undefined) throw toApiError(0, null);
  return parsed;
}

// ---------------------------------------------------------------------------
// Account cache
// ---------------------------------------------------------------------------

/** @type {Account} */
const SIGNED_OUT = Object.freeze({
  loaded: false,
  signedIn: false,
  csrf: '',
  usage: null,
  billing: 'unavailable',
  hasSubscription: false,
  limits: null,
  price: null,
  version: '',
});

/** @type {Account} */
let cached = SIGNED_OUT;
/** What subscribers were last told. */
let published = JSON.stringify(SIGNED_OUT);
let publishedAccount = cached;
let loadedAt = 0;
/** @type {Promise<Account> | null} */
let inflight = null;
let sequence = 0;
/** @type {Set<(account: Account, previous: Account) => void>} */
const accountListeners = new Set();

function normalizeAccount(body) {
  const source = isRecord(body) ? body : {};
  const signedIn = source.signedIn === true;
  return Object.freeze({
    loaded: true,
    signedIn,
    csrf: signedIn && typeof source.csrf === 'string' ? source.csrf : '',
    usage: signedIn && isRecord(source.usage) ? Object.freeze({ ...source.usage }) : null,
    billing: source.billing === 'live' ? 'live' : 'unavailable',
    hasSubscription: signedIn && source.hasSubscription === true,
    limits: isRecord(source.limits) ? Object.freeze({ ...source.limits }) : cached.limits,
    price: isRecord(source.price) ? Object.freeze({ ...source.price }) : cached.price,
    version: typeof source.version === 'string' ? source.version : cached.version,
  });
}

function publish() {
  const next = JSON.stringify(cached);
  if (next === published) return;
  const previous = publishedAccount;
  published = next;
  publishedAccount = cached;
  for (const listener of [...accountListeners]) safely(listener, cached, previous);
}

function signedOutCopy() {
  return Object.freeze({ ...cached, signedIn: false, csrf: '', usage: null, hasSubscription: false });
}

/**
 * The cached account as it is right now. Before the first load it is the
 * signed-out default with `loaded: false`.
 *
 * @returns {Account}
 */
export function currentAccount() {
  return cached;
}

/**
 * Asks the Worker for the account and updates the cache. Subscribers hear
 * about it when something changed.
 *
 * @returns {Promise<Account>}
 */
export function refreshAccount() {
  sequence += 1;
  const ticket = sequence;
  const promise = exchange(ACCOUNT_PATH, 'GET')
    .then((body) => {
      // Only the newest answer is applied; an older caller waits for it.
      if (ticket !== sequence) return inflight ?? cached;
      cached = normalizeAccount(body);
      loadedAt = Date.now();
      publish();
      return cached;
    })
    .finally(() => {
      if (inflight === promise) inflight = null;
    });
  inflight = promise;
  return promise;
}

/**
 * The account. The first call loads it; later calls resolve from the cache.
 * While a reload is in flight every caller gets that reload.
 *
 * @returns {Promise<Account>}
 */
export function account() {
  if (inflight) return inflight;
  if (cached.loaded) return Promise.resolve(cached);
  return refreshAccount();
}

/**
 * Calls `listener(account, previous)` whenever the cached account changes.
 * With `immediate`, it is also called once now.
 *
 * @param {(account: Account, previous: Account) => void} listener
 * @param {{ immediate?: boolean }} [options]
 * @returns {() => void} unsubscribe
 */
export function subscribeAccount(listener, { immediate = false } = {}) {
  accountListeners.add(listener);
  if (immediate) safely(listener, cached, cached);
  return () => accountListeners.delete(listener);
}

/**
 * The plan in one word.
 *
 * @param {Account} [value]  Defaults to the cached account.
 * @returns {'anon' | 'free' | 'operator' | 'past_due'}
 */
export function planOf(value = cached) {
  if (!value?.signedIn) return 'anon';
  if (value.usage?.plan === 'weekly') return 'operator';
  if (value.usage?.plan === 'past_due') return 'past_due';
  return 'free';
}

function reloadQuietly() {
  // Subscribers hear the full account when the reload lands. If it fails they
  // hear what is known so far.
  refreshAccount().catch(publish);
}

/** Folds what a successful answer says about the session into the cache. */
function adoptAnswer(path, body) {
  if (!isRecord(body)) return;

  if (path === ACCOUNT_PATH) {
    cached = normalizeAccount(body);
    loadedAt = Date.now();
    publish();
  } else if (typeof body.signedIn === 'boolean') {
    cached = body.signedIn
      ? Object.freeze({ ...cached, signedIn: true, csrf: typeof body.csrf === 'string' ? body.csrf : cached.csrf })
      : signedOutCopy();
    reloadQuietly();
  } else if (path === DELETE_PATH && body.deleted === true) {
    cached = signedOutCopy();
    reloadQuietly();
  } else if (path === RECONCILE_PATH && isRecord(body.usage)) {
    cached = Object.freeze({ ...cached, usage: Object.freeze({ ...body.usage }) });
    reloadQuietly();
  }
}

function noteSignedOut() {
  if (!cached.signedIn) return;
  cached = signedOutCopy();
  publish();
  // A reload that was already in flight is from before the refusal: this one replaces it.
  refreshAccount().catch(() => {});
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !cached.loaded || inflight) return;
    if (Date.now() - loadedAt > STALE_AFTER_MS) refreshAccount().catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// request()
// ---------------------------------------------------------------------------

/**
 * One JSON call to the Worker.
 *
 * `method` defaults to POST when `body` is given and GET otherwise. Cookies are
 * sent, and every non-GET call carries the session's X-CSRF-Token.
 *
 *   const portal = await request('/api/portal');
 *   await request('/api/connections/revoke', { body: { id } });
 *
 * @param {string} path  Must start with /api/.
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options]
 * @returns {Promise<any>} The parsed JSON body; null for a 204.
 * @throws {ApiError}
 */
export async function request(path, { method, body, signal } = {}) {
  assertApiPath(path);
  const verb = String(method ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
  const mutating = verb !== 'GET' && verb !== 'HEAD';

  // The CSRF token comes with the account, so a change waits for the first load.
  if (mutating && !cached.loaded) await account().catch(() => {});

  let answer;
  try {
    answer = await exchange(path, verb, body, signal);
  } catch (error) {
    if (error.code === 'signin') noteSignedOut();
    if (!mutating || error.code !== 'csrf') throw error;
    // The session changed in another tab. Take its token and send the call again.
    await refreshAccount();
    answer = await exchange(path, verb, body, signal);
  }
  adoptAnswer(path, answer);
  return answer;
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

/**
 * An incremental parser for a `text/event-stream` body. Feed it decoded text
 * in any chunking; it calls `onEvent({ event, data })` once per complete event.
 * Comment lines (the Worker's `: keep-alive`) are skipped. `event` is
 * 'message' when the stream names none, and `data` is the joined data lines,
 * not yet parsed as JSON.
 *
 * Call `end()` when the body closes: an event whose closing blank line never
 * arrived is delivered then.
 *
 * @param {(event: SseEvent) => void} onEvent
 * @returns {{ feed(text: string): void, end(): void }}
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let scanned = 0;
  let atStart = true;
  let skipLineFeed = false;
  let name = '';
  /** @type {string[]} */
  let data = [];

  function dispatch() {
    const event = { event: name || 'message', data: data.join('\n') };
    const hasData = data.length > 0;
    name = '';
    data = [];
    if (hasData) onEvent(event);
  }

  function line(text) {
    if (text === '') {
      dispatch();
      return;
    }
    if (text.startsWith(':')) return;

    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
    // `id` and `retry` are not used by the Worker.
  }

  function feed(text) {
    if (typeof text !== 'string' || text === '') return;
    let chunk = text;
    if (atStart) {
      atStart = false;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    if (skipLineFeed && chunk !== '') {
      // The previous chunk ended in a carriage return: this line feed belongs to it.
      skipLineFeed = false;
      if (chunk.charCodeAt(0) === 10) chunk = chunk.slice(1);
    }
    buffer += chunk;

    let start = 0;
    for (let index = scanned; index < buffer.length; index += 1) {
      const code = buffer.charCodeAt(index);
      if (code !== 10 && code !== 13) continue;
      line(buffer.slice(start, index));
      if (code === 13) {
        if (index + 1 === buffer.length) skipLineFeed = true;
        else if (buffer.charCodeAt(index + 1) === 10) index += 1;
      }
      start = index + 1;
    }
    buffer = buffer.slice(start);
    scanned = buffer.length;
    if (buffer.length > MAX_LINE_CHARS) throw new ApiError('The review stream sent a line that is too long to read.', { code: 'bad_response' });
  }

  function end() {
    if (buffer !== '') line(buffer);
    buffer = '';
    scanned = 0;
    dispatch();
  }

  return { feed, end };
}

function parseEventData(text) {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// streamReview()
// ---------------------------------------------------------------------------

async function signedInAccount() {
  let current = await account();
  // Signed in from another tab since the last load: look once more before refusing.
  if (!current.signedIn && Date.now() - loadedAt > SIGNED_OUT_RECHECK_MS) current = await refreshAccount();
  if (!current.signedIn) throw new ApiError('Sign in to continue.', { code: 'signin', status: 401 });
  return current;
}

async function readEventStream(response, { onDelta, progress, arm }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = null;
  let failure = null;

  const parser = createSseParser(({ event, data }) => {
    if (result || failure) return;
    const payload = parseEventData(data);
    if (event === 'delta') {
      if (payload && typeof payload.text === 'string' && payload.text !== '') {
        progress.partial += payload.text;
        safely(onDelta, payload.text);
      }
    } else if (event === 'done') {
      // A `done` that does not parse was cut off; the stream then ends without a result.
      if (payload) result = payload;
    } else if (event === 'error') {
      failure = toApiError(0, payload ?? { error: 'The review did not finish. Run it again.', code: 'review_failed' });
    }
  });

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        parser.feed(decoder.decode());
        parser.end();
        break;
      }
      arm('idle');
      parser.feed(decoder.decode(value, { stream: true }));
      if (result || failure) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (failure) throw failure;
  if (!result) {
    throw new ApiError('The connection closed before the review finished. Run it again.', { code: 'stream_ended' });
  }
  if (typeof result.review !== 'string') result.review = progress.partial;
  return result;
}

async function runReview(body, { onDelta, signal }, progress, limits) {
  await signedInAccount();
  if (signal?.aborted) throw abortedError();

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  // Until the first bytes arrive the limit is long: the provider may think
  // before it writes, and a proxy that buffers delivers everything at the end.
  const waits = { first: limits.firstByteMs ?? FIRST_BYTE_MS, idle: limits.idleMs ?? IDLE_MS };
  let quiet = '';
  let timer = null;
  const arm = (phase) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      quiet = phase;
      controller.abort();
    }, waits[phase]);
  };

  const payload = JSON.stringify({ ...body, stream: true });
  try {
    for (let attempt = 0; ; attempt += 1) {
      arm('first');
      const response = await fetch(REVIEW_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { ...jsonHeaders(true), Accept: 'text/event-stream, application/json' },
        body: payload,
        signal: controller.signal,
      });

      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      if (response.ok && type.startsWith('text/event-stream') && response.body) {
        return await readEventStream(response, { onDelta, progress, arm });
      }

      // Not a stream: an error the Worker found before the first token, or a whole review as JSON.
      const parsed = await readJsonBody(response);
      if (!response.ok) {
        const failure = toApiError(response.status, parsed, { retryAfter: response.headers.get('retry-after') });
        if (failure.code === 'csrf' && attempt === 0) {
          await refreshAccount();
          continue;
        }
        if (failure.code === 'signin') noteSignedOut();
        throw failure;
      }
      if (!isRecord(parsed) || typeof parsed.review !== 'string') throw toApiError(0, null);
      progress.partial = parsed.review;
      if (parsed.review !== '') safely(onDelta, parsed.review);
      return parsed;
    }
  } catch (error) {
    if (quiet === 'idle') {
      throw new ApiError(`The review stream went silent for ${Math.round(waits.idle / 1000)} seconds. Check the connection and run it again.`, { code: 'timeout' });
    }
    if (quiet === 'first') {
      throw new ApiError('The provider did not start answering in time. Run the review again, or pick a faster model.', { code: 'timeout' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Runs a hosted review and reports the answer as it is written.
 *
 * POSTs `{ ...body, stream: true }` to /api/review. `onDelta(text)` receives
 * each piece of the review. Then exactly one of these happens:
 *   - `onDone(result)` and the promise resolves with `result`;
 *   - the call fails: with `onError` given, `onError(apiError)` is called and
 *     the promise resolves with null; without it, the promise rejects with the
 *     ApiError.
 *
 * When the Worker answers with JSON in place of an event stream, a whole
 * review is delivered as one `onDelta` and then `onDone`.
 *
 * Aborting `signal` stops the review: the error has code `aborted`. Any text
 * that arrived before a failure is in `error.data.partial`.
 *
 * A provider that breaks off mid-answer is not an error: the Worker sends what
 * was written as `done` with `truncated: true`. Check `result.truncated` and
 * `result.refused` before treating a result as a complete review.
 *
 * The API key in `body` is sent and then forgotten: this module keeps no copy.
 *
 * @param {ReviewBody} body
 * @param {{ onDelta?: (text: string) => void, onDone?: (result: ReviewResult) => void, onError?: (error: ApiError) => void, signal?: AbortSignal }} [handlers]
 * @param {{ firstByteMs?: number, idleMs?: number }} [limits]  Silence limits; the defaults are 300 s and 60 s. For tests.
 * @returns {Promise<ReviewResult | null>}
 */
export async function streamReview(body, { onDelta, onDone, onError, signal } = {}, limits = {}) {
  const progress = { partial: '' };
  let result;
  try {
    result = await runReview(body, { onDelta, signal }, progress, limits);
  } catch (error) {
    const failure = signal?.aborted ? abortedError() : asApiError(error);
    if (progress.partial !== '' && failure.data.partial === undefined) failure.data.partial = progress.partial;
    // A refused or failed review can still have changed the allowance.
    if (cached.signedIn) refreshAccount().catch(() => {});
    if (typeof onError !== 'function') throw failure;
    safely(onError, failure);
    return null;
  }
  refreshAccount().catch(() => {});
  safely(onDone, result);
  return result;
}

// ---------------------------------------------------------------------------
// Passkey re-check
// ---------------------------------------------------------------------------

/** @type {((error: ApiError) => unknown) | null} */
let reauthHandler = null;
/** @type {Promise<unknown> | null} */
let reauthInFlight = null;

/**
 * Registers the function that performs a passkey check when the Worker asks
 * for one. It receives the `reauth` ApiError. It resolves when the check
 * succeeded; it resolves with `false`, or throws, when the user cancelled.
 * One handler is active at a time.
 *
 * @param {((error: ApiError) => unknown) | null} handler
 * @returns {() => void} unregister
 */
export function setReauthHandler(handler) {
  reauthHandler = typeof handler === 'function' ? handler : null;
  return () => {
    if (reauthHandler === handler) reauthHandler = null;
  };
}

/**
 * Runs `fn` now. If it fails with code `reauth`, the registered handler
 * performs a passkey check and `fn` runs once more. Calls that need the check
 * at the same moment share one prompt.
 *
 *   const created = await withReauth(() => request('/api/connections/create', { body: { label } }));
 *
 * Routes that ask for it: /api/auth/rotate-recovery, /api/auth/add/options,
 * /api/passkeys/remove, /api/connections/create, /api/account/delete.
 *
 * With no handler registered, or when the handler resolves with `false`, the
 * `reauth` error is thrown as it came.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withReauth(fn) {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'reauth' || !reauthHandler) throw error;

    if (!reauthInFlight) {
      const handler = reauthHandler;
      reauthInFlight = Promise.resolve()
        .then(() => handler(error))
        .finally(() => {
          reauthInFlight = null;
        });
    }
    const confirmed = await reauthInFlight;
    if (confirmed === false) throw error;
    return fn();
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Adds one to the day's counter for a client event. Fire-and-forget: it
 * returns at once, never throws, and survives a page navigation. Names are the
 * constants in ./events.mjs; any other value is dropped and returns false.
 * No cookie is sent.
 *
 * @param {string} event
 * @returns {boolean} Whether the event was sent.
 */
export function track(event) {
  if (!isClientEvent(event) || typeof fetch !== 'function') return false;
  try {
    fetch(EVENT_PATH, {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }),
    }).catch(() => {});
  } catch {
    return false;
  }
  return true;
}
