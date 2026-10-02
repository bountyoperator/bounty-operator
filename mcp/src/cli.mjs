// What the command does: serve MCP on stdio, or print the version or the help.

import { PROVIDERS } from '../lib/providers.mjs';
import { ORIGIN_VAR, TOKEN_VAR } from './hosted.mjs';
import { VERSION, serveStdio } from './server.mjs';
import { MODEL_VAR } from './tools.mjs';

const TARBALL = 'https://bountyoperator.com/dl/bounty-operator-mcp.tgz';

const HELP = `bounty-operator-mcp ${VERSION}

MCP server for Bounty Operator. It speaks MCP over stdio: an MCP client starts
it, you do not run it by hand.

Add it to a client:
  Claude Code   claude mcp add --transport stdio bounty-operator -- npx -y ${TARBALL}
  Codex         codex mcp add bounty-operator -- npx -y ${TARBALL}
  Cursor        { "mcpServers": { "bounty-operator": { "command": "npx", "args": ["-y", "${TARBALL}"] } } }

Tools with no account: list_profiles, prepare_review, run_gauntlet_plan, build_packet.
Tools with a connection token: account, run_review.

Environment:
  ${TOKEN_VAR.padEnd(24)} connection token (bok_...) from the account panel
  ${MODEL_VAR.padEnd(24)} model id run_review uses when the call names none
  ${'BOUNTY_OPERATOR_ROOT'.padEnd(24)} project folder that paths resolve under (default: the working directory)
  ${ORIGIN_VAR.padEnd(24)} a development server on this machine, such as http://localhost:8787
  Provider keys for run_review: ${PROVIDERS.map((provider) => provider.envVar).join(', ')}

Options:
  --version   print the version
  --help      print this text

Setup for every client: https://bountyoperator.com/mcp
`;

/**
 * @param {string[]} argv  Command-line arguments after the script name.
 * @returns {Promise<void>}
 */
export async function run(argv) {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  if (process.stdin.isTTY) {
    process.stderr.write(`bounty-operator-mcp ${VERSION} is waiting for an MCP client on stdin. Run with --help for the install commands.\n`);
  }
  await serveStdio().done;
}
