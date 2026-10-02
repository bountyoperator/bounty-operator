// Errors a tool reports to the agent, and the scrubbing of secrets from
// everything the server writes.

/**
 * A failure the agent is meant to read and act on. `code` is the same stable
 * value the website and the remote endpoint use; `extra` is merged into the body.
 */
export class ToolError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {Record<string, unknown>} [extra]
   */
  constructor(message, code = 'bad_input', extra = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.extra = extra;
  }
}

/** The body of a failed tool call: `{ error, code, ...extra }`. */
export function errorBody(error) {
  return { ...error.extra, error: error.message, code: error.code };
}

export function messageOf(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

const MIN_SECRET_CHARS = 8;

/**
 * The secret values this process holds: the connection token and every
 * provider key. Short values are skipped, since replacing them would mangle
 * ordinary text.
 *
 * @param {Record<string, string | undefined>} env
 * @param {readonly string[]} names
 * @returns {string[]}
 */
export function secretsIn(env, names) {
  const values = names.map((name) => env[name]).filter((value) => typeof value === 'string' && value.length >= MIN_SECRET_CHARS);
  // Longest first, so a secret that contains another is replaced whole.
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

function scrubText(text, secrets) {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join('[redacted]');
  return result;
}

/**
 * A copy of `value` with every secret replaced in every string, keys included.
 *
 * @template T
 * @param {T} value
 * @param {readonly string[]} secrets
 * @returns {T}
 */
export function scrub(value, secrets) {
  if (!secrets.length) return value;
  if (typeof value === 'string') return /** @type {T} */ (scrubText(value, secrets));
  if (Array.isArray(value)) return /** @type {T} */ (value.map((entry) => scrub(entry, secrets)));
  if (value && typeof value === 'object') {
    return /** @type {T} */ (
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [scrubText(key, secrets), scrub(entry, secrets)]))
    );
  }
  return value;
}
