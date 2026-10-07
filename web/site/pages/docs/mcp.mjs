// /mcp — Bounty Operator MCP server: install, tools, prompts, tokens.
//
// Server facts follow web/src/mcp.ts (POST /api/mcp, five tools, which of them
// need a bok_ token, X-Provider-Key) and mcp/src (the local server: the same
// five plus run_gauntlet_plan, files by path). The three core profiles
// (general, solidity, report) are prepared for the agent's own model. Every
// other profile is hosted: prepare_review refuses it with `hosted_profile` and
// run_review runs it, which covers seven of the eight gauntlet stages. The
// method of a hosted profile is on the server only and no tool returns it, so
// this page says what each tool answers for one and nothing about the method.
// Client commands were checked on 2 October 2026 against:
//   Claude Code  https://code.claude.com/docs/en/mcp
//   Codex        https://developers.openai.com/codex/mcp and /codex/cli/reference
//   Cursor       https://cursor.com/docs/context/mcp and /docs/mcp/install-links
//
// The three prompt names below are the contract this page documents. The MCP
// endpoint and the local server must register prompts under the same names.

import { GAUNTLET, PROFILES, reviewProfile } from '../../../public/profiles.mjs';
import { PROVIDERS } from '../../../public/providers.mjs';
import { LIMITS } from '../../../public/review-core.mjs';
import { button, chip, codeBlock, disclosure, faq, html, inline, table, tabs } from '../../components.mjs';
import { breadcrumbsLd, faqPageLd } from '../../layout.mjs';
import { DOCS_STYLES, UPDATED, docPage, facts, nextStep } from './_shared.mjs';
import { NOT_COUNTED } from '../../plans.mjs';

const PATH = '/mcp';
const SERVER = 'bounty-operator';
const ENDPOINT = 'https://bountyoperator.com/api/mcp';
const TARBALL = 'https://bountyoperator.com/dl/bounty-operator-mcp.tgz';
const CHECKSUMS = '/dl/SHA256SUMS.txt';
const TOKEN_VAR = 'BOUNTY_OPERATOR_TOKEN';
const MODEL_VAR = 'BOUNTY_OPERATOR_MODEL';
const ROOT_VAR = 'BOUNTY_OPERATOR_ROOT';
const KEY_VAR = 'OPENROUTER_API_KEY';
// A hosted review on the remote endpoint runs for up to 15 minutes. Claude
// Code's per-server `timeout` (milliseconds) ends a call at that time even
// while progress arrives, and Codex stops a call after `tool_timeout_sec`, so
// both are set above the longest review.
const CLAUDE_TIMEOUT_MS = 1200000;
const CODEX_TIMEOUT_S = 1200;

const json = (value) => JSON.stringify(value, null, 2);

/** Said once on this page: the clients that cannot wait for a long hosted review. */
export const CLIENT_LIMIT =
  'claude.ai and Claude Desktop stop any tool call after 240 seconds, and a hosted review runs for up to 15 minutes. Run hosted reviews from Claude Code, Codex or the website. `prepare_review` and `build_packet` for the three core profiles work in every client.';
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Read from the engine, so the page cannot drift from what the servers do.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const CORE = PROFILES.filter((profile) => profile.listed && !profile.hosted);
const CORE_NAMES = CORE.map((profile) => profile.name);
const CORE_SENTENCE = `${CORE_NAMES.slice(0, -1).join(', ')} and ${CORE_NAMES.at(-1)}`;
const HOSTED_STAGES = GAUNTLET.filter((id) => reviewProfile(id).hosted).length;
const CORE_STAGES = GAUNTLET.filter((id) => !reviewProfile(id).hosted);
if (CORE.length !== 3) throw new Error(`/mcp is written for three core profiles; the engine has ${CORE.length}.`);
if (CORE_STAGES.join() !== 'report') throw new Error(`/mcp says the report stage is the one core stage of the gauntlet; the engine has ${CORE_STAGES.join(', ') || 'none'}.`);

/** A shell command: one line, wrapped on screen, copied as one line. */
const shell = (code, label) => codeBlock({ code, name: 'Terminal', numbers: false, wrap: true, copy: true, label });
/** A config file: lines kept as written. `label` names the block when two share a file name. */
const file = (code, name, label) => codeBlock({ code, name, numbers: false, copy: true, label });

// ---------------------------------------------------------------------------
// Install commands per client
// ---------------------------------------------------------------------------

const cursorRemote = { url: ENDPOINT };
const cursorLocal = { type: 'stdio', command: 'npx', args: ['-y', TARBALL] };
const cursorInstallLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER}&config=${encodeURIComponent(
  Buffer.from(JSON.stringify(cursorRemote)).toString('base64'),
)}`;

const CLIENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    remote: shell(`claude mcp add --transport http ${SERVER} ${ENDPOINT}`, 'Claude Code: add the remote endpoint'),
    local: html`${shell(`claude mcp add --transport stdio ${SERVER} -- npx -y ${TARBALL}`, 'Claude Code: add the local server')}
<p class="fine">${inline('On Windows outside WSL, start it through `cmd`: end the command with `-- cmd /c npx -y` and the same address.')}</p>`,
    token: html`
<p>${inline('Remote endpoint, in `.mcp.json` at the root of your project. The two headers carry your account token and your provider key, and Claude Code fills in each `${NAME}` from your environment:')}</p>
${file(
  json({
    mcpServers: {
      [SERVER]: {
        type: 'http',
        url: ENDPOINT,
        headers: { Authorization: `Bearer \${${TOKEN_VAR}}`, 'X-Provider-Key': `\${${KEY_VAR}}` },
        timeout: CLAUDE_TIMEOUT_MS,
      },
    },
  }),
  '.mcp.json',
  'Claude Code: remote endpoint with a token',
)}
<p>Local server. The same two values go in as environment variables:</p>
${file(
  json({
    mcpServers: {
      [SERVER]: { command: 'npx', args: ['-y', TARBALL], env: { [TOKEN_VAR]: `\${${TOKEN_VAR}}`, [KEY_VAR]: `\${${KEY_VAR}}` }, timeout: CLAUDE_TIMEOUT_MS },
    },
  }),
  '.mcp.json',
  'Claude Code: local server with a token',
)}
<p class="fine">${inline(`\`timeout\` is in milliseconds, and the call ends then even while progress arrives: \`${CLAUDE_TIMEOUT_MS}\` is 20 minutes, above the longest hosted review. \`claude mcp add\` has no timeout option, so use the file. If the server is already added, run \`claude mcp remove ${SERVER}\` first. On Windows outside WSL, start the local server through \`cmd\`: \`"command": "cmd"\` with \`"/c", "npx"\` at the front of \`args\`.`)}</p>`,
  },
  {
    id: 'codex',
    label: 'Codex',
    remote: shell(`codex mcp add ${SERVER} --url ${ENDPOINT}`, 'Codex: add the remote endpoint'),
    local: shell(`codex mcp add ${SERVER} -- npx -y ${TARBALL}`, 'Codex: add the local server'),
    token: html`
<p>${inline('Remote endpoint, in `~/.codex/config.toml`. Codex reads both values from your environment:')}</p>
${file(
  `[mcp_servers.${SERVER}]
url = "${ENDPOINT}"
bearer_token_env_var = "${TOKEN_VAR}"
env_http_headers = { "X-Provider-Key" = "${KEY_VAR}" }
tool_timeout_sec = ${CODEX_TIMEOUT_S}`,
  '~/.codex/config.toml',
  'Codex: remote endpoint with a token',
)}
<p>Local server:</p>
${file(
  `[mcp_servers.${SERVER}]
command = "npx"
args = ["-y", "${TARBALL}"]
env_vars = ["${TOKEN_VAR}", "${KEY_VAR}"]
tool_timeout_sec = ${CODEX_TIMEOUT_S}`,
  '~/.codex/config.toml',
  'Codex: local server with a token',
)}
<p class="fine">${inline(`Codex stops a tool call after 60 seconds by default, so keep the \`tool_timeout_sec\` line: ${CODEX_TIMEOUT_S} seconds is above the longest hosted review. On the remote endpoint a hosted review runs until the model finishes, for up to 15 minutes, and sends progress every 10 seconds. Through the local server it ends within 270 seconds.`)}</p>`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    remote: html`${file(json({ mcpServers: { [SERVER]: cursorRemote } }), '~/.cursor/mcp.json', 'Cursor: the remote endpoint')}
<p class="install__alt">${button({ label: 'Add to Cursor', href: cursorInstallLink, size: 'sm', icon: 'plus' })}<span class="fine">Opens Cursor and adds the remote endpoint.</span></p>`,
    local: file(json({ mcpServers: { [SERVER]: cursorLocal } }), '~/.cursor/mcp.json', 'Cursor: the local server'),
    token: html`
<p>${inline('Remote endpoint. Cursor fills `${env:NAME}` from your environment:')}</p>
${file(
  json({
    mcpServers: {
      [SERVER]: {
        url: ENDPOINT,
        headers: { Authorization: `Bearer \${env:${TOKEN_VAR}}`, 'X-Provider-Key': `\${env:${KEY_VAR}}` },
      },
    },
  }),
  '~/.cursor/mcp.json',
  'Cursor: remote endpoint with a token',
)}
<p>Local server:</p>
${file(
  json({
    mcpServers: {
      [SERVER]: { ...cursorLocal, env: { [TOKEN_VAR]: `\${env:${TOKEN_VAR}}`, [KEY_VAR]: `\${env:${KEY_VAR}}` } },
    },
  }),
  '~/.cursor/mcp.json',
  'Cursor: local server with a token',
)}
<p class="fine">${inline('Use `.cursor/mcp.json` in a project folder to add the server to that project only.')}</p>`,
  },
];

const install = html`<section class="install" data-tabs aria-labelledby="install-title">
<h2 class="visually-hidden" id="install-title">Install</h2>
${tabs({ label: 'Client', items: CLIENTS.map((client, index) => ({ id: client.id, label: client.label, selected: index === 0 })) })}
${CLIENTS.map(
  (client) => html`<div class="install__panel" id="panel-${client.id}">
<h3 class="install__client">${client.label}</h3>
<div class="install__route">
<p class="install__label"><span class="meta">Remote endpoint</span>${chip('Nothing to install', { tone: 'observed' })}</p>
${client.remote}
</div>
${disclosure({ summary: 'Run a local server instead', hint: 'Node 22 or later', body: client.local })}
${disclosure({ summary: 'Add your account token', hint: 'for account and run_review', body: html`<div class="install__token">${client.token}</div>` })}
</div>`,
)}
<p class="install__foot fine">${inline('No account needed for either route. `list_profiles`, `prepare_review` for the three core profiles and `build_packet` work as soon as the server is added.')} The local package is listed with its SHA-256 in <a href="${CHECKSUMS}">SHA256SUMS.txt</a>.</p>
<p class="install__foot fine">${inline(CLIENT_LIMIT)}</p>
</section>`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const noAccount = () => chip('No account', { tone: 'ok' });
const needsToken = () => chip('Account token', { tone: 'observed' });
const localOnly = () => chip('Local server', { tone: 'neutral' });

const TOOLS = [
  ['list_profiles', 'The review profiles and what each one needs as input. Every profile carries `hosted`: false for a core profile, true for a hosted one.', noAccount()],
  [
    'prepare_review',
    'For the three core profiles: runs the privacy check on the files, then returns a SHA-256 manifest and the exact review request. Your agent’s own model answers it. A hosted profile is refused with `hosted_profile`.',
    noAccount(),
  ],
  [
    'run_gauntlet_plan',
    `The ${WORDS[GAUNTLET.length]} gauntlet stages in order, the Context fields still empty and the call that ends the run. The plan names the tool that runs each stage.`,
    html`${noAccount()}${localOnly()}`,
  ],
  [
    'build_packet',
    'Turns a finished review into the evidence packet: the manifest with hashes, your context, the review and a link to verify it.',
    noAccount(),
  ],
  ['account', 'Your plan, the reviews used today and when the allowance resets.', needsToken()],
  [
    'run_review',
    'A hosted review of any profile on the provider and model you name, and the only way to run a hosted profile. Returns the review, the manifest and your remaining allowance.',
    html`${needsToken()}${chip('Provider key', { tone: 'neutral' })}`,
  ],
];

const tools = html`
<div class="prose">
<p>${inline('The remote endpoint exposes five tools. Three run with no account, so an agent can prepare a review and package the result on the first call. The local server adds a sixth, `run_gauntlet_plan`, and reads files by path.')}</p>
<p>${inline(`${CORE_SENTENCE} are the three core profiles. \`prepare_review\` hands their request to your agent’s own model. Every other profile runs on the hosted service through \`run_review\`, and so do ${WORDS[HOSTED_STAGES]} of the gauntlet’s stages.`)}</p>
</div>
<ul class="tool-list" aria-label="Tools">
${TOOLS.map(
  ([name, text, needs]) => html`<li class="tool-list__item">
<p class="tool-list__name"><code>${name}</code></p>
<p class="tool-list__needs">${needs}</p>
<p class="tool-list__text">${inline(text)}</p>
</li>`,
)}
</ul>
<div class="prose">
<p>${inline(`A call takes up to ${LIMITS.files} text files, ${LIMITS.fileBytes / 1000} KB per file, ${LIMITS.totalBytes / 1000} KB and ${LIMITS.totalLines.toLocaleString('en-US')} lines in total. File names are repo-relative paths such as \`src/Vault.sol\`. When the privacy check blocks a file, the result lists the file, the line and the kind of match, and never the matched text.`)}</p>
<p>${inline(`The remote endpoint takes file text inline as \`files\`. On the local server, \`prepare_review\` and \`run_review\` also take \`paths\`: the server reads those files under its working directory, so your agent does not send the text. A client that starts the server outside your project sets \`${ROOT_VAR}\` to the project folder.`)}</p>
<p>A first request to try:</p>
</div>
${codeBlock({
  code: 'Use bounty-operator to prepare a Solidity review of src/Vault.sol. Answer the request it returns, then build the packet.',
  name: 'Prompt',
  numbers: false,
  wrap: true,
  copy: true,
  label: 'A first request',
})}`;

// ---------------------------------------------------------------------------
// Core and hosted profiles
// ---------------------------------------------------------------------------

const HOSTED_EXAMPLE = reviewProfile('triage');
if (!HOSTED_EXAMPLE.hosted) throw new Error('/mcp shows the refusal of a hosted profile; triage is no longer one.');

/**
 * What the remote endpoint answers when prepare_review is called with a hosted
 * profile. A test calls the endpoint and compares, so the page cannot drift.
 */
export const HOSTED_REFUSAL = {
  profile: HOSTED_EXAMPLE.id,
  error: `${HOSTED_EXAMPLE.name} runs on the server. Call run_review with profile "${HOSTED_EXAMPLE.id}", your connection token and your provider key in the X-Provider-Key header.`,
  code: 'hosted_profile',
};

// What each tool answers for a hosted profile.
const HOSTED_ANSWERS = [
  ['list_profiles', 'The profile with its name, its description, the inputs it reads and `hosted: true`.'],
  ['prepare_review', 'A failed call with the code `hosted_profile`, the profile id and a sentence that names `run_review`. It is refused before any file is read.'],
  ['run_review', 'The review, its verdict, the reference check, the manifest and your remaining allowance. It uses one hosted review. `verdict` and `panel` run on Operator only.'],
  ['build_packet', 'The evidence packet for the review `run_review` returned. Pass `source: "ai"`.'],
];

const hosted = html`
<div class="prose">
<p>${inline(`\`list_profiles\` marks every profile. \`hosted: false\` is one of the three core profiles: its method is open source and \`prepare_review\` hands it to your agent. \`hosted: true\` is a hosted profile: the service adds its method when \`run_review\` runs and sends it with your files to the provider you named, under your key. It is not in the local package or in the public repository, and no tool or prompt returns it.`)}</p>
<p>For a hosted profile the tools answer like this:</p>
</div>
<ul class="tool-list tool-list--commands" aria-label="What each tool returns for a hosted profile">
${HOSTED_ANSWERS.map(
  ([name, text]) => html`<li class="tool-list__item">
<p class="tool-list__name"><code>${name}</code></p>
<p class="tool-list__text">${inline(text)}</p>
</li>`,
)}
</ul>
<div class="prose">
<p>${inline(`The refusal, as the remote endpoint returns it for \`${HOSTED_EXAMPLE.id}\`:`)}</p>
</div>
${codeBlock({ code: json(HOSTED_REFUSAL), name: 'prepare_review', numbers: false, wrap: true, label: 'The result of prepare_review for a hosted profile' })}
<div class="prose">
<p>${inline(`The local server returns the same code and names \`${TOKEN_VAR}\` in the sentence. \`run_review\` sends the files and your provider key to the service, which adds the method of the profile, calls your provider and returns the review.`)}</p>
</div>`;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

// The names the endpoint registers (PROMPTS in web/src/mcp.ts). A test compares the two lists.
const PROMPTS = [
  ['challenge-report', 'Checks every claim in your draft report against the code it cites, then builds the evidence packet.'],
  ['solidity-review', 'Maps entry points and invariants in the contracts you name and reports what the code proves, with file and line.'],
  ['gauntlet', 'Takes a finding through the pre-submission stages in order and ends with one verdict. Its hosted stages run through `run_review`.'],
];

const prompts = html`
<div class="prose">
<p>${inline(`The server ships three prompts. A client that supports MCP prompts lists them as commands. In Claude Code, type \`/\` and pick one, or type the full name:`)}</p>
</div>
<ul class="tool-list tool-list--commands" aria-label="Prompts">
${PROMPTS.map(
  ([name, text]) => html`<li class="tool-list__item">
<p class="tool-list__name"><code>/mcp__${SERVER}__${name}</code></p>
<p class="tool-list__text">${inline(text)}</p>
</li>`,
)}
</ul>
<div class="prose">
<p>${inline('`challenge-report` and `solidity-review` prepare the review with `prepare_review`, have your agent’s own model answer and end with `build_packet`, so both work with no account.')}</p>
<p>${inline(`\`gauntlet\` lists the ${WORDS[GAUNTLET.length]} stages with the tool that runs each one. ${capital(WORDS[HOSTED_STAGES])} are hosted and run through \`run_review\`. The report stage is a core profile, so your agent’s own model answers it from \`prepare_review\`. The run needs an account token and your provider key, and it uses ${WORDS[HOSTED_STAGES]} hosted reviews. Free covers one hosted review per UTC day, so a full run takes Operator. On the local server the prompt starts from \`run_gauntlet_plan\`.`)}</p>
</div>`;

// ---------------------------------------------------------------------------
// Agent pack: the repository is a plugin and a skills source (pack/, skills/)
// ---------------------------------------------------------------------------

const REPO_SLUG = 'bountyoperator/bounty-operator';
const PROVIDER_KEY_VAR = 'BOUNTY_OPERATOR_PROVIDER_KEY';

const pack = html`
<div class="prose">
<p>${inline('The repository is also a Claude Code plugin with five skills. `challenge-report`, `solidity-review` and `code-security-review` carry the three core methods and run on your agent’s own model with no account. `gauntlet` runs the eight stages through this server. `hunt-with-gate` runs only when you call it by name: it checks a finding before any report is written and never submits anything.')}</p>
</div>
${shell(`claude plugin marketplace add ${REPO_SLUG}\nclaude plugin install bounty-operator@bounty-operator`, 'Install the Claude Code plugin')}
<div class="prose">
<p>${inline(`The plugin adds this server too. It reads \`${TOKEN_VAR}\` and \`${PROVIDER_KEY_VAR}\` from the environment you start Claude Code in; both can stay unset for the core skills. Codex, Cursor and other agents take the skills with one command and the server with the commands above:`)}</p>
</div>
${shell(`npx skills add ${REPO_SLUG}`, 'Install the skills in any agent')}`;

// ---------------------------------------------------------------------------
// Account token
// ---------------------------------------------------------------------------

const token = html`
<div class="grid grid--2 token-split">
<div class="token-split__col">
<h3 class="h4">Works with no token</h3>
<ul class="token-split__list">
<li><code>list_profiles</code></li>
<li><code>prepare_review</code>, for the three core profiles</li>
<li><code>build_packet</code></li>
<li><code>run_gauntlet_plan</code>, on the local server</li>
<li>The <code>challenge-report</code> and <code>solidity-review</code> prompts</li>
</ul>
<p class="fine">Your agent’s own model does the review. Nothing is counted against an allowance.</p>
</div>
<div class="token-split__col">
<h3 class="h4">Needs a token</h3>
<ul class="token-split__list">
<li><code>account</code></li>
<li><code>run_review</code>, with your provider key</li>
<li>The <code>gauntlet</code> prompt, which runs its hosted stages with <code>run_review</code></li>
</ul>
<p class="fine">A hosted review uses the same allowance as the website: one per UTC day on Free, unlimited on Operator at US$10 per week.</p>
</div>
</div>
<div class="prose">
<h3 id="create-token">Create a token</h3>
<ol>
<li>Sign in at <a href="/#account">bountyoperator.com</a> with your passkey and open the account panel.</li>
<li>Under Connections, name the connection after the client that will use it, and create it.</li>
<li>${inline('Copy the token. It starts with `bok_` and is shown once.')}</li>
<li>${inline(`Set it as \`${TOKEN_VAR}\` in your environment and add the server with the token command for your client.`)}</li>
</ol>
<p>A token lasts 90 days. An account holds three at a time. Revoke one in the account panel and it stops working at once.</p>
<h3 id="provider-key">Your provider key</h3>
<p><code>run_review</code> runs on your own model key. The remote endpoint takes it in the <code class="nowrap">X-Provider-Key</code> header. The local server reads it from the provider’s environment variable:</p>
</div>
${table({
  label: 'Provider key variables',
  columns: [{ label: 'Provider' }, { label: 'Environment variable', mono: true }],
  rows: PROVIDERS.map((provider) => [provider.label, provider.envVar]),
  dense: true,
  className: 'provider-table',
})}
<div class="prose">
<p>${inline(`The remote endpoint uses the provider’s default model when a call names none. The local server needs a model: pass \`model\`, or set \`${MODEL_VAR}\`.`)}</p>
</div>`;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const permissions = html`${facts([
  {
    icon: 'key',
    title: 'A token does two things',
    text: 'It reads your usage and runs a review. Billing, passkeys, recovery and deletion stay behind your passkey. We keep a SHA-256 of the token, its label and its last-used time.',
  },
  {
    icon: 'file',
    title: 'The server sees what your agent passes',
    text: 'The remote endpoint receives file contents as tool arguments and nothing else from your machine. The local server reads only the paths your agent names under its working directory.',
  },
  {
    icon: 'shield',
    title: 'A hosted review goes through our server',
    text: 'The run_review tool sends the files and your provider key to bountyoperator.com. The server adds the method of the profile, calls your provider and returns the review. It stores none of it.',
  },
  {
    icon: 'lock',
    title: 'Keys stay out of the transcript',
    text: 'The provider key travels in a header or an environment variable, never as a tool argument.',
  },
  {
    icon: 'refresh',
    title: 'Stateless endpoint',
    text: 'Each request stands alone. There is no MCP session to resume and no stream held open.',
  },
  {
    icon: 'terminal',
    title: 'Local means local',
    text: 'On the local server, preparing a review, planning a gauntlet and building a packet run on your machine with no network call.',
  },
])}
<p class="fine">The <a href="/security">security page</a> has the full data flow, what is stored and how to report a vulnerability.</p>`;

// ---------------------------------------------------------------------------
// Failed calls
// ---------------------------------------------------------------------------

// The codes an agent meets first, with what each one means for the allowance.
// They are raised by web/src/review.ts and the engine; a test checks each one exists there.
export const ERROR_CODES = [
  ['hosted_profile', '`prepare_review` was called with a hosted profile. Nothing was read and nothing was counted. Call `run_review`.'],
  ['privacy_block', 'The privacy check found a secret. The result lists the file, the line and the kind of each match. Remove it and call again.'],
  ['privacy_warn', 'The privacy check found an email or an IP address. Call again with `acknowledgeWarnings: true` to send the files as they are.'],
  ['daily_used', 'The free review of the day is used. The result carries `resetsAt`, the time the next one opens.'],
  ['operator_only', '`run_review` was called with `verdict` or `panel` on an account without Operator. Those two profiles run only inside the gauntlet and a panel review. Nothing was sent to the provider and the review of the day is not used.'],
  ['review_running', 'The account is running as many reviews as its plan allows. Call again when one finishes.'],
  ['provider', 'Your provider refused the call or timed out: a rejected key, an unknown model, a rate limit. The review is not counted.'],
  [
    'output_withheld',
    'The model repeated its instructions instead of reviewing, so the answer was stopped and the call used one review. Run it again or choose a stronger model.',
  ],
];

const errors = html`
<div class="prose">
<p>${inline('A failed tool call comes back as a result with `isError` set and one JSON object: `error`, a sentence your agent can act on, and `code`, a value that does not change. Both servers use the same codes.')}</p>
</div>
<ul class="tool-list tool-list--commands" aria-label="Error codes">
${ERROR_CODES.map(
  ([code, text]) => html`<li class="tool-list__item">
<p class="tool-list__name"><code>${code}</code></p>
<p class="tool-list__text">${inline(text)}</p>
</li>`,
)}
</ul>
<div class="prose">
<p>${inline('`account` and `run_review` without a valid token are answered with HTTP 401 by the remote endpoint, which is what makes a client ask for the token. The local server returns the code `token`.')}</p>
</div>`;

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

const FAQ = [
  {
    q: 'Do I need an account to use the MCP server?',
    a: 'No. `list_profiles`, `prepare_review` and `build_packet` work with no account and no key, and so do the `challenge-report` and `solidity-review` prompts: your agent’s own model answers the prepared request of a core profile. An account token adds `account`, `run_review` for every profile, and the `gauntlet` prompt.',
  },
  {
    q: 'Should I use the remote endpoint or the local server?',
    a: 'The remote endpoint needs nothing installed and works on any machine the client runs on. The local server needs Node 22 or later, keeps review preparation on your machine, reads files by path and adds `run_gauntlet_plan`. The other five tools are the same on both.',
  },
  {
    q: 'What does a hosted review cost through MCP?',
    a: `\`run_review\` shares one allowance with the website: one hosted review per UTC day on Free, any profile, and unlimited on Operator at US$10 per week. A gauntlet run over MCP uses ${WORDS[HOSTED_STAGES]} hosted reviews, one for every stage but the report stage, so a full run takes Operator. ${NOT_COUNTED} Your model provider bills its own usage to your key.`,
  },
  {
    q: 'Which profiles can my agent’s own model run?',
    a: `The three core profiles: ${CORE_SENTENCE}. \`prepare_review\` returns their method and the request. Every other profile is hosted: \`prepare_review\` refuses it with \`hosted_profile\` and \`run_review\` runs it on the service, on your provider key.`,
  },
  {
    q: 'How much output can a hosted model use?',
    a: 'Reasoning and the answer share one output allowance. A streamed review (the website, and run_review from a client that reads a stream) gives the listed models that take it 64,000 tokens: Claude Opus 5.5, Sonnet 5.5 and Fable 5.1, GPT-6.1 Sol, Astra and Luna, Grok 4.7, and the models in the OpenRouter list. On OpenRouter, Gemini 3.8 Flash, Qwen3.8 27B, Qwen3.8 Max 0902, HY4 Preview and GLM 5.3 get 64,000 on every call. Everything else, including a model id you type and a call read as one answer, has 16,000. Reasoning defaults are preserved. Your provider bills the tokens used, so the larger allowance costs more only when the model needs it. The direct Gemini endpoint uses its provider allowance.',
  },
  {
    q: 'How do I check the service before a long run?',
    a: '`GET https://bountyoperator.com/api/health` returns the version, `reviews` (whether hosted reviews are on) and `profiles`. `profiles` reads `hosted` when the service carries the full method of every hosted profile. A Worker built from the public repository reads `community`: it runs the hosted profiles on short stand-in instructions.',
  },
  {
    q: 'Which clients work?',
    a: 'Any client that speaks MCP over Streamable HTTP or stdio. This page has the commands for Claude Code, Codex and Cursor.',
  },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const body = docPage({
  head: {
    crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'MCP server' }],
    title: 'Connect your coding agent',
    lede: 'Choose your app and copy the setup command. Core reviews need no Bounty Operator account.',
  },
  lead: install,
  sections: [
    { id: 'tools', title: 'The tools it exposes', label: 'Tools', body: tools, prose: false },
    { id: 'hosted', title: 'Core and hosted profiles', body: hosted, prose: false },
    { id: 'prompts', title: 'Three slash commands', label: 'Slash commands', body: prompts, prose: false },
    { id: 'skills', title: 'Skills and the plugin', label: 'Skills and plugin', body: pack, prose: false },
    { id: 'token', title: 'What needs an account token', label: 'Account token', body: token, prose: false },
    { id: 'permissions', title: 'What the server can reach', label: 'Permissions', body: permissions, prose: false },
    { id: 'errors', title: 'When a call fails', label: 'Failed calls', body: errors, prose: false },
    { id: 'faq', title: 'Questions', body: faq(FAQ), prose: false },
  ],
  after: nextStep({
    title: 'Prefer a browser',
    text: 'The workbench runs the same profiles with the same engine, and shows each finding as a card.',
    actions: html`${button({ label: 'Open the workbench', href: '/#workspace', variant: 'primary', iconEnd: 'arrow-right' })}${button({ label: 'Read the report guide', href: '/guide' })}`,
  }),
});

export default {
  path: PATH,
  title: 'MCP server for Claude Code, Codex, Cursor | Bounty Operator',
  label: 'MCP setup',
  description:
    'Copy-paste install for the Bounty Operator MCP server in Claude Code, Codex and Cursor, with its tools, three prompts and token setup.',
  styles: DOCS_STYLES,
  scripts: ['/docs/tabs.mjs', '/docs/copy-ping.mjs'],
  jsonld: [breadcrumbsLd([{ name: 'MCP server', path: PATH }]), faqPageLd(FAQ)],
  lastmod: UPDATED,
  body,
};
