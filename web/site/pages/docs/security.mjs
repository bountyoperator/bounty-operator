// /security — the trust page for a security audience.
//
// Facts follow SPEC section 5 (Worker contracts, headers, CSP), SPEC section 4
// (provider calls, input checks) and SECURITY.md (reporting and testing rules).
// The header block below must stay identical to what the Worker sends.

import { LIMITS } from '../../../public/review-core.mjs';
import { button, codeBlock, html, icon, inline, kv } from '../../components.mjs';
import { SITE, breadcrumbsLd } from '../../layout.mjs';
import { DOCS_STYLES, UPDATED, checklist, docPage, ext, facts, nextStep, securityLink, time } from './_shared.mjs';

const PATH = '/security';
const POLICY = `${SITE.source}/blob/main/SECURITY.md`;
const ADVISORY = `${SITE.source}/security/advisories/new`;

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.github.com https://openrouter.ai; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const HEADERS = `Content-Security-Policy: ${CSP}
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cross-Origin-Opener-Policy: same-origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()`;

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

// A hosted review, stop by stop. The Worker facts follow web/src/review.ts:
// prepareChecked adds the method, providerCall sends it with the user's key,
// and nothing of the request or the answer is written anywhere.
const FLOW = [
  {
    step: 'Your browser',
    title: 'Selects, checks, shows',
    points: [
      'You choose the files. The privacy check runs here, and the preview shows the request before it leaves the tab.',
      'GitHub imports go straight to `api.github.com`.',
      'Prompt export of a core profile ends here. Nothing is sent.',
    ],
  },
  {
    step: 'Our Worker',
    title: 'Verifies, adds the method, forgets',
    points: [
      'Checks your session, your allowance and the inputs again.',
      'Adds the review method of the profile you chose, sends the request with your API key to one fixed endpoint of your provider and streams the answer back.',
      'Holds the files, the key and the answer in memory for that one request. Writes none of them to storage or logs.',
    ],
  },
  {
    step: 'Your provider',
    title: 'Runs the model',
    points: [
      'Receives your files, your request, our review instructions and your API key.',
      'Bills your key and keeps data under its own terms.',
    ],
  },
];

const flow = html`
<ol class="flow">
${FLOW.map(
  (node, index) => html`<li class="flow__node">
<p class="meta"><span class="flow__n">${index + 1}</span>${node.step}</p>
<p class="flow__title">${node.title}</p>
<ul class="flow__points">${node.points.map((point) => html`<li>${inline(point)}</li>`)}</ul>
</li>`,
)}
</ol>
<div class="prose">
<p>The review engine is one set of modules. The browser, the Worker and the MCP server import the same files, and they are in the public repository with the three core profiles. The method of every other profile is not in the repository: the Worker adds it when a review runs.</p>
<p>${inline('For a core profile the preview is the whole prompt your model receives. For a hosted profile it is the request: your focus, your context and the files, line by line. The Worker adds the method after that, and the provider you chose is the only other party that receives it. No page, download or API response returns it.')}</p>
<p>${inline('A review started from a coding agent takes the same path: `run_review` sends the files and your provider key to the Worker, and steps 2 and 3 are unchanged.')}</p>
</div>`;

// ---------------------------------------------------------------------------
// Stored and not stored
// ---------------------------------------------------------------------------

const stored = html`
<div class="grid grid--2 ledger-split">
<div class="ledger-split__col">
<h3 class="h4">${icon('x')}Never stored</h3>
<ul class="ledger-split__list">
<li>File contents and file names</li>
<li>Instructions and evidence notes</li>
<li>Model API keys and GitHub tokens</li>
<li>Review output</li>
<li>Raw IP addresses</li>
<li>Card details</li>
<li>Passkey private keys</li>
</ul>
</div>
<div class="ledger-split__col">
<h3 class="h4">${icon('check')}Stored</h3>
<ul class="ledger-split__list">
<li>A random account identifier</li>
<li>Passkey public keys, counters and labels</li>
<li>SHA-256 hashes of the recovery code, session tokens and connection tokens</li>
<li>Per review: status, profile, channel and time, for seven days</li>
<li>Stripe customer and subscription IDs, status, paid-until time and receipt email</li>
<li>A keyed hash of your IP address for rate limits, for up to a day</li>
<li>Daily page and funnel totals with no account identifier</li>
</ul>
</div>
</div>
<div class="prose">
<p>The <a href="/privacy">privacy policy</a> has the full list with retention times.</p>
</div>`;

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const headers = html`
<div class="prose">
<p>The Worker sets these on every response, pages and API alike:</p>
</div>
${codeBlock({ code: HEADERS, name: 'Response headers', numbers: false, wrap: true, copy: true })}
<div class="prose">
<p>What the policy means in practice:</p>
</div>
${checklist([
  html`<p>${inline('Scripts and styles load from this origin only. There is no inline script, no inline style and no `eval`, so injected markup has nothing to run.')}</p>`,
  html`<p>${inline('The browser can connect to three hosts: this one, `api.github.com` for imports and `openrouter.ai` for the OpenRouter connection.')}</p>`,
  html`<p>The site cannot be framed, and forms post to this origin only.</p>`,
  html`<p>${inline('Model output and pasted text are treated as untrusted. The app writes them with `textContent` and never parses them as markup. Downloaded packets have remote images and raw HTML neutralised.')}</p>`,
])}
<div class="prose">
<p>Check it yourself:</p>
</div>
${codeBlock({ code: 'curl -sI https://bountyoperator.com/ | grep -i -E "content-security|strict-transport|cross-origin|x-frame|referrer|x-content|permissions"', name: 'Terminal', numbers: false, wrap: true, copy: true, label: 'Read the headers' })}`;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const accounts = facts([
  {
    icon: 'key',
    title: 'Passkeys only',
    text: 'No password exists to phish, reuse or leak. Sign-up asks for no email address. User verification is required on every sign-in.',
  },
  {
    icon: 'hash',
    title: 'Secrets stored as hashes',
    text: 'Session tokens, connection tokens and the recovery code are 256-bit random values. We keep their SHA-256.',
  },
  {
    icon: 'lock',
    title: 'Hardened cookies',
    text: 'The session cookie is __Host-prefixed, HttpOnly, Secure and SameSite=Lax. It lasts up to 30 days.',
  },
  {
    icon: 'shield',
    title: 'Origin and CSRF checks',
    text: 'A state-changing request from the browser has to come from this origin. Signed-in requests also carry a per-session CSRF token.',
  },
  {
    icon: 'clock',
    title: 'Fresh passkey for sensitive actions',
    text: 'Rotating the recovery code, adding or removing a passkey, creating a connection token and deleting the account need a passkey check from the last 10 minutes.',
  },
  {
    icon: 'refresh',
    title: 'Recovery resets everything',
    text: 'Using the recovery code replaces it and signs out every session and connection token. Removing a passkey signs out the other sessions and revokes every connection token.',
  },
]);

// ---------------------------------------------------------------------------
// Tokens, provider calls, billing
// ---------------------------------------------------------------------------

const requests = html`
<h3 id="connection-tokens">Connection tokens</h3>
<p>${inline('A connection token starts with `bok_` and lets an AI client do two things: read your usage and run a review. It cannot reach billing, passkeys, recovery or deletion. A token lasts 90 days, an account holds three, and revoking one takes effect at once.')}</p>
<h3 id="provider-calls">Provider calls</h3>
<p>Each provider has one fixed endpoint. The Worker refuses redirects, stops a streamed answer when the provider has been silent for 180 seconds, and caps the answer at 2 MB. Your API key is used for that request and is redacted from any error message.</p>
<h3 id="hosted-profiles">Hosted profiles</h3>
<p>${inline('The Worker reads the answer to a hosted profile as it streams, in memory, before it reaches you. An answer that repeats the method of the profile is stopped and the call ends with the code `output_withheld`. That includes a copy disguised with invisible characters, look-alike letters or spaced-out letters; a paraphrase, a translation or an encoded copy is beyond what a text match can catch. A file or a request that asks the model for its instructions is treated as data.')}</p>
<h3 id="input-checks">Input checks</h3>
<p>${inline(`A review takes up to ${LIMITS.files} text files and ${LIMITS.totalBytes / 1000} KB in total. Before anything is sent, the engine scans every line for API keys, access tokens, wallet keys and seed phrases, and blocks the request when it finds one. Email addresses and IP addresses are warnings you confirm. A finding names the file, the line and the kind of match, and never the matched text.`)}</p>
<h3 id="billing">Billing</h3>
<p>Payment runs on Stripe Checkout, so card details never touch our application. Webhooks are signature-checked, and paid access is recomputed from Stripe’s current state on every event, including refunds and disputes.</p>`;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const report = html`
<div class="report-box">
<p class="report-box__lead">Email ${securityLink()}.</p>
<p class="muted small">Or use ${ext('GitHub private vulnerability reporting', ADVISORY)}. Both reach the maintainers privately.</p>
</div>
<div class="prose">
<p>Include:</p>
<ul>
<li>the affected surface, and the version or the time of the request</li>
<li>a minimal reproduction</li>
<li>the impact: what an attacker reads, changes or spends</li>
<li>a proposed fix, if you have one</li>
</ul>
<p>Remove secrets and other people’s data from anything you attach.</p>
<h3 id="scope">In scope</h3>
</div>
${kv(
  [
    ['The hosted site', 'The Worker and its API routes, passkey sign-in and recovery, sessions and CSRF, connection tokens, quota and concurrency limits, billing state, the MCP endpoint, the content security policy and the static pages.'],
    ['The review engine', 'Input checks, request assembly, review parsing and packet rendering. A way to make model output or pasted text execute script, load a remote resource or leave the page is a vulnerability.'],
    ['The MCP server', inline('The `bounty-operator-mcp` package and the endpoint at `/api/mcp`.')],
    ['The CLI', inline('The `bounty-operator-kit` Python package: the sanitizer, the `ai-review` request path, file reads and writes.')],
  ],
  { className: 'scope-list' },
)}
<div class="prose">
<h3 id="testing-rules">Testing rules</h3>
<ul>
<li>Use accounts you created. Leave other accounts alone.</li>
<li>Keep request volume low. No denial-of-service testing and no automated scanning of the production site.</li>
<li>Do not test payments against the live checkout. The billing logic runs locally with billing disabled.</li>
<li>Stop at the first proof of a problem and report it.</li>
</ul>
<p>${ext('The full policy is in SECURITY.md', POLICY)}. The machine-readable contact is at <a href="/.well-known/security.txt">/.well-known/security.txt</a>.</p>
</div>`;

const source = html`
<p>${ext('The source is public', SITE.source)} under the MIT licence: the Worker, the review engine with its three core profiles, the free tools, the MCP server and the command-line kit. The gauntlet stages and the panel cross-examination run on the hosted service. The <a href="/licenses">licences page</a> lists every dependency. The <a href="/changelog">changelog</a> lists what shipped and when.</p>
<p>${inline('A Worker built from the repository runs the hosted profiles on short stand-in instructions, and its `/api/health` reads `"profiles": "community"`. On this site it reads `"profiles": "hosted"`.')}</p>`;

const body = docPage({
  head: {
    crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Security' }],
    title: 'Security at Bounty Operator',
    lede: 'Where your code and keys go during a review, what is stored, which headers are in force, and how to report a vulnerability.',
    meta: html`Last updated ${time(UPDATED)}`,
    actions: html`${button({ label: 'Report a vulnerability', href: '#report', variant: 'primary', icon: 'shield' })}${button({ label: 'Read the source', href: SITE.source, external: true, iconEnd: 'arrow-up-right' })}`,
  },
  sections: [
    { id: 'data-flow', title: 'Data flow: browser, Worker, provider', label: 'Data flow', body: flow, prose: false },
    { id: 'stored', title: 'What is stored and what is not', label: 'Stored and not stored', body: stored, prose: false },
    { id: 'headers', title: 'Headers and CSP in force', label: 'Headers and CSP', body: headers, prose: false },
    { id: 'accounts', title: 'Passkey-only accounts', label: 'Accounts', body: accounts, prose: false },
    { id: 'requests', title: 'Tokens, provider calls and billing', label: 'Tokens and requests', body: requests },
    { id: 'report', title: 'Report a vulnerability', body: report, prose: false },
    { id: 'source', title: 'Source', body: source },
  ],
  after: nextStep({
    title: 'Read what we keep, line by line',
    text: 'The privacy policy lists every stored field and its retention time.',
    actions: html`${button({ label: 'Privacy policy', href: '/privacy', variant: 'primary' })}${button({ label: 'Terms', href: '/terms' })}`,
  }),
});

export default {
  path: PATH,
  title: 'Security: data flow, storage, disclosure | Bounty Operator',
  label: 'Security',
  description:
    'The data flow from browser to Worker to your provider, what is stored, the headers and CSP in force, and how to report a vulnerability.',
  styles: DOCS_STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Security', path: PATH }])],
  lastmod: UPDATED,
  body,
};
