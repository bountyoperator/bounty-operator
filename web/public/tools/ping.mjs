// A name-only counter for the free tools, the report templates and the MCP page.
//
// ping(name) asks the server to add one to a per-day total. The request is
// POST /api/event with the body {"event":"<name>"} and nothing else: no file
// name, no hash, no text, no size and no count. The names are the fixed list
// below, each of which the server also has to know (CLIENT_EVENTS in
// web/src/funnel.ts). No cookie is sent, and the page neither waits for the
// answer nor reads it. This is the only module of a tool page that makes a
// request, and it is the whole of what the page sends after it has loaded.

/** The names a page may report. Anything else is dropped before a request is made. */
export const PING_EVENTS = Object.freeze([
  'tool_report_check',
  'tool_secret_check',
  'tool_slither_focus',
  'tool_verify',
  'tool_acceptance_rates',
  'template_copied',
  'mcp_command_copied',
]);

const EVENT_PATH = '/api/event';
const sent = new Set();

/**
 * Counts one named action, at most once per page load.
 *
 * @param {string} event  One of PING_EVENTS.
 * @returns {boolean} Whether a request was started.
 */
export function ping(event) {
  if (!PING_EVENTS.includes(event) || sent.has(event) || typeof fetch !== 'function') return false;
  sent.add(event);
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
