// Calls to the Bounty Operator account API, made with the connection token
// from this process's environment. The token is sent to one origin only.

import { boundedBody } from '../lib/review-core.mjs';
import { ToolError } from './errors.mjs';

export const SITE_ORIGIN = 'https://bountyoperator.com';
export const TOKEN_VAR = 'BOUNTY_OPERATOR_TOKEN';
export const ORIGIN_VAR = 'BOUNTY_OPERATOR_ORIGIN';

const TOKEN = /^bok_[A-Za-z0-9_-]{43}$/;
// A development server on this machine, such as `wrangler dev`.
const LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;
// An account call answers in seconds, and a JSON review within the Worker's
// 270-second single-answer limit. Node's fetch also stops waiting for response
// headers after 300 seconds, so a JSON call can never wait longer than this.
export const TIMEOUT_MS = 300000;
// A streamed review on a Bounty Operator model may first wait for the model to
// start. The Worker allows 600 seconds for that and 300 for generation, 930 in
// all (BOUNTY_OPERATOR_CALL_LIMIT_MS in lib/providers.mjs); this limit leaves
// room for transport. The stream opens at once and a keep-alive arrives every
// 15 seconds or less, so Node's header and body limits never end it.
export const STREAM_TIMEOUT_MS = 960000;
const RESPONSE_BYTES = 4000000;
// A stream wraps every piece of the review in its own event and ends with the
// whole review again, so its wire size is several times the text.
const STREAM_BYTES = 32000000;
// One event. `done` carries the whole review and the manifest.
const EVENT_CHARS = 8000000;

/**
 * The origin and token to call with. Throws a ToolError the agent can act on
 * when the token is missing or malformed.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ origin: string, token: string }}
 */
export function hostedConfig(env) {
  const origin = (env[ORIGIN_VAR] || SITE_ORIGIN).replace(/\/$/, '');
  if (origin !== SITE_ORIGIN && !LOOPBACK.test(origin)) {
    throw new ToolError(`${ORIGIN_VAR} must be ${SITE_ORIGIN} or a development address on this machine, such as http://localhost:8787.`, 'bad_origin');
  }

  const token = env[TOKEN_VAR] || '';
  if (!token) {
    throw new ToolError(
      `Set ${TOKEN_VAR} in this server's environment. Create a connection token in the account panel at ${SITE_ORIGIN}/#account. list_profiles, prepare_review, run_gauntlet_plan and build_packet work with no token.`,
      'token',
    );
  }
  if (!TOKEN.test(token)) {
    throw new ToolError(`${TOKEN_VAR} is not a connection token. A token starts with bok_ and is shown once, when the connection is created.`, 'token');
  }
  return { origin, token };
}

/**
 * One request to the account API. `body` makes it a POST. Every failure is a
 * ToolError carrying the server's own message and code when it sent them.
 *
 * With `stream`, the body also carries `stream: true` and the Worker answers
 * with server-sent events once the review is reserved: `status` while a hosted
 * model starts, `delta` while it writes, then one `done` with the same body
 * the JSON route returns, or one `error` with the same body a JSON error has.
 * `onStatus(message)` receives the status message, and `onStatus(null)` comes
 * when the first text arrives after one. An answer that is not a stream (an
 * error found before the review was reserved, or a server that does not
 * stream) is read as JSON, as without `stream`.
 *
 * @param {{ env: Record<string, string | undefined>, fetch: typeof fetch, signal?: AbortSignal, version: string }} ctx
 * @param {string} path
 * @param {unknown} [body]
 * @param {{ stream?: boolean, onStatus?: (message: string | null) => void }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function hostedCall(ctx, path, body, { stream = false, onStatus } = {}) {
  const { origin, token } = hostedConfig(ctx.env);
  const limitMs = stream ? STREAM_TIMEOUT_MS : TIMEOUT_MS;
  const timeout = AbortSignal.timeout(limitMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: stream ? 'text/event-stream, application/json' : 'application/json',
    'User-Agent': `bounty-operator-mcp/${ctx.version}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const sent = stream && body && typeof body === 'object' ? { ...body, stream: true } : body;

  let response;
  let text;
  let outcome = null;
  try {
    response = await ctx.fetch(origin + path, {
      method: sent === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal,
      headers,
      body: sent === undefined ? undefined : JSON.stringify(sent),
    });
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (stream && response.ok && type.startsWith('text/event-stream') && response.body) {
      outcome = await readEvents(response, onStatus);
    } else {
      text = await boundedBody(response, RESPONSE_BYTES);
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (ctx.signal?.aborted) throw new ToolError('The call was cancelled.', 'cancelled');
    if (timeout.aborted) {
      throw new ToolError(`Bounty Operator did not answer within ${limitMs / 1000} seconds. Call account to see whether the review was counted.`, 'timeout');
    }
    if (response) {
      throw new ToolError('The connection to Bounty Operator closed before its answer was complete. Call again; after run_review, call account first to see whether the review was counted.', 'network');
    }
    throw new ToolError(`Bounty Operator could not be reached at ${origin}. Check the connection and call again.`, 'network');
  }

  if (outcome) {
    if (outcome.event === 'error') throw failureOf(outcome.data);
    return outcome.data;
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Handled below: an answer that is not JSON is reported by its status.
  }
  const isObject = Boolean(data) && typeof data === 'object' && !Array.isArray(data);

  if (!response.ok) {
    if (isObject && typeof data.error === 'string') throw failureOf(data);
    throw new ToolError(`Bounty Operator answered with HTTP ${response.status}.`, 'hosted');
  }
  if (!isObject) throw new ToolError('Bounty Operator returned an answer this server cannot read.', 'hosted');
  return data;
}

/** The ToolError for an error body: `{ error, code?, ...extra }`, from JSON or an `error` event. */
function failureOf(data) {
  const { error, code, ...extra } = data;
  return new ToolError(error, typeof code === 'string' ? code : 'hosted', extra);
}

/** The data of one event block, or null for a comment such as `: keep-alive`. */
function parseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(data.join('\n'));
  } catch {
    // An event whose data is not JSON carries nothing this server reads.
  }
  return { event, data: parsed };
}

/**
 * Reads a review's event stream until its `done` or `error`. Returns that
 * event, `{ event, data }`. Throws a ToolError when the stream breaks a limit
 * or ends without an outcome; any other throw is a broken connection.
 */
async function readEvents(response, onStatus) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let writing = false;
  let status = false;

  const take = (block) => {
    const parsed = parseBlock(block);
    if (!parsed) return null;
    const { event, data } = parsed;
    const isObject = Boolean(data) && typeof data === 'object' && !Array.isArray(data);
    if (event === 'delta') {
      if (isObject && typeof data.text === 'string' && data.text !== '') {
        writing = true;
        if (status) {
          status = false;
          safely(onStatus, null);
        }
      }
      return null;
    }
    if (event === 'status') {
      // Only news from before the review starts is passed on.
      if (!writing && isObject && typeof data.message === 'string' && data.message !== '') {
        status = true;
        safely(onStatus, data.message.slice(0, 300));
      }
      return null;
    }
    if (event === 'done') {
      // A `done` that does not parse was cut off; the stream then ends without a result.
      return isObject ? { event, data } : null;
    }
    if (event === 'error') {
      return { event, data: isObject && typeof data.error === 'string' ? data : { error: 'The review did not finish. Call account to see whether it was counted, then call again.', code: 'hosted' } };
    }
    return null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        // An event is complete only at its blank line; what is left was cut off.
        break;
      }
      bytes += value.byteLength;
      if (bytes > STREAM_BYTES) throw new ToolError('Bounty Operator sent a longer answer than this server reads.', 'hosted');
      // Normalised as a whole, so a CRLF split between two reads is caught too.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const outcome = take(block);
        if (outcome) return outcome;
      }
      if (buffer.length > EVENT_CHARS) throw new ToolError('Bounty Operator sent a longer answer than this server reads.', 'hosted');
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new ToolError('The connection closed before the review finished. Call account to see whether it was counted, then call again.', 'network');
}

/** Calls a handler and ignores what it throws: a progress message never fails a review. */
function safely(handler, value) {
  try {
    handler?.(value);
  } catch {
    // Ignored.
  }
}
