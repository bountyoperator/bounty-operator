/**
 * Client event names.
 *
 * These are the only names POST /api/event accepts (the Worker's list is
 * CLIENT_EVENTS in web/src/funnel.ts; web/tests/app-foundation.test.mjs fails
 * when the two differ). Each one adds 1 to a per-day counter. No account id,
 * no address and no content travels with it.
 *
 * Exports
 *   EVENTS                 { EXAMPLE_LOADED: 'example_loaded', … } frozen
 *   CLIENT_EVENTS          readonly string[] of every value in EVENTS
 *   isClientEvent(name)    boolean
 *
 * Use
 *   import { track } from './api.mjs';
 *   import { EVENTS } from './events.mjs';
 *   track(EVENTS.PROMPT_EXPORTED);
 *
 * When to send each one
 *   EXAMPLE_LOADED       the bundled example was loaded into the workbench
 *   PROMPT_EXPORTED      a checked prompt was copied or downloaded
 *   REPLY_PASTED         a model reply was pasted back and parsed
 *   PACKET_SAVED         a review packet was downloaded or copied
 *   REPO_IMPORTED        files were imported from GitHub
 *   SIGNIN_OPENED        the account dialog opened for a signed-out visitor
 *   UPGRADE_CLICKED      a control that starts Operator checkout was pressed
 *   GAUNTLET_STARTED     a gauntlet run began
 *   GAUNTLET_FINISHED    a gauntlet run reached its verdict stage
 *   PANEL_STARTED        a panel review began
 *   PANEL_FINISHED       a panel review finished its cross-examination
 *   TOOL_REPORT_CHECK    the report check ran
 *   TOOL_SECRET_CHECK    the secret check ran
 *   TOOL_SLITHER_FOCUS   the Slither focus tool ran
 *   TOOL_VERIFY          the packet verifier ran
 *   TEMPLATE_COPIED      a report template was copied
 *   MCP_COMMAND_COPIED   an MCP install command was copied
 */

/** @type {Readonly<Record<string, string>>} */
export const EVENTS = Object.freeze({
  EXAMPLE_LOADED: 'example_loaded',
  PROMPT_EXPORTED: 'prompt_exported',
  REPLY_PASTED: 'reply_pasted',
  PACKET_SAVED: 'packet_saved',
  REPO_IMPORTED: 'repo_imported',
  SIGNIN_OPENED: 'signin_opened',
  UPGRADE_CLICKED: 'upgrade_clicked',
  GAUNTLET_STARTED: 'gauntlet_started',
  GAUNTLET_FINISHED: 'gauntlet_finished',
  PANEL_STARTED: 'panel_started',
  PANEL_FINISHED: 'panel_finished',
  TOOL_REPORT_CHECK: 'tool_report_check',
  TOOL_SECRET_CHECK: 'tool_secret_check',
  TOOL_SLITHER_FOCUS: 'tool_slither_focus',
  TOOL_VERIFY: 'tool_verify',
  TOOL_ACCEPTANCE_RATES: 'tool_acceptance_rates',
  TEMPLATE_COPIED: 'template_copied',
  MCP_COMMAND_COPIED: 'mcp_command_copied',
});

/** @type {readonly string[]} */
export const CLIENT_EVENTS = Object.freeze(Object.values(EVENTS));

const NAMES = new Set(CLIENT_EVENTS);

/**
 * True when the Worker accepts `name` at POST /api/event.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isClientEvent(name) {
  return typeof name === 'string' && NAMES.has(name);
}
