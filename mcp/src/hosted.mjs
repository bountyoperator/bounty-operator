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
// A hosted review answers within 270 seconds.
const TIMEOUT_MS = 300000;
const RESPONSE_BYTES = 4000000;

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
 * @param {{ env: Record<string, string | undefined>, fetch: typeof fetch, signal?: AbortSignal, version: string }} ctx
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<Record<string, any>>}
 */
export async function hostedCall(ctx, path, body) {
  const { origin, token } = hostedConfig(ctx.env);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': `bounty-operator-mcp/${ctx.version}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  let text;
  try {
    response = await ctx.fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await boundedBody(response, RESPONSE_BYTES);
  } catch {
    if (ctx.signal?.aborted) throw new ToolError('The call was cancelled.', 'cancelled');
    if (timeout.aborted) {
      throw new ToolError(`Bounty Operator did not answer within ${TIMEOUT_MS / 1000} seconds. Call account to see whether the review was counted.`, 'timeout');
    }
    throw new ToolError(`Bounty Operator could not be reached at ${origin}. Check the connection and call again.`, 'network');
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Handled below: an answer that is not JSON is reported by its status.
  }
  const isObject = Boolean(data) && typeof data === 'object' && !Array.isArray(data);

  if (!response.ok) {
    if (isObject && typeof data.error === 'string') {
      const { error, code, ...extra } = data;
      throw new ToolError(error, typeof code === 'string' ? code : 'hosted', extra);
    }
    throw new ToolError(`Bounty Operator answered with HTTP ${response.status}.`, 'hosted');
  }
  if (!isObject) throw new ToolError('Bounty Operator returned an answer this server cannot read.', 'hosted');
  return data;
}
