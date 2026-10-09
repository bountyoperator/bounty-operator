// /privacy — what the hosted site stores and what it does not.
//
// Every statement here matches SPEC section 5 (Worker contracts) and the text
// edits in .local/audit/w2/audit-legal-trust.md. If the Worker changes what it
// stores, counts or sets as a cookie, this page changes in the same commit.

import { html, inline, stackTable } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { DOCS_STYLES, UPDATED, docPage, facts, supportLink, time } from './_shared.mjs';

const PATH = '/privacy';

const glance = facts(
  [
    { icon: 'eye', title: 'No ad cookies. No tracking pixels.', text: 'No third-party analytics scripts either.' },
    { icon: 'file', title: 'Your files are not stored', text: 'Files, instructions, API keys and review results are never written to our database or logs.' },
    { icon: 'lock', title: 'Two cookies', text: 'Both exist to sign you in. Nothing else is set.' },
    { icon: 'download', title: 'Export or delete', text: 'Download your account data or delete the account from the account panel.' },
  ],
  { className: 'facts--glance' },
);

const files = html`
<p>File selection, the privacy check and prompt export run in your browser.</p>
<p>A hosted review sends the files you selected, your instructions, the model name and your API key through our Cloudflare Worker to the provider you select. The Worker adds the review method of the profile and holds everything in memory for that one request. Your files, your instructions and your key are never written to our database or our logs, and neither is the review that comes back.</p>
<p>${inline('The Worker reads the answer to a hosted profile as it passes through, to stop an answer that repeats the method in place of a review. It keeps nothing of what it reads.')}</p>
<p>The provider you select receives your files under its own terms and keeps them under its own retention policy.</p>
<p>Exporting the prompt of a core profile contacts no provider and sends nothing of yours to our server. You paste it into a model yourself.</p>`;

const account = html`
<p>An account is a random identifier. Sign-up asks for no password and no email address.</p>
<p>We store:</p>
<ul>
<li>your passkey public keys, with their identifiers, counters, transport hints, labels and creation times</li>
<li>a hash of your recovery code</li>
<li>hashes of your session tokens, each with a CSRF token, its expiry and the time you last signed in</li>
<li>hashes of your connection tokens, with the label you gave each one and its creation, expiry and last-use times</li>
<li>the billing references listed under Payments</li>
</ul>
<p>Passkey private keys and device biometrics stay on your device.</p>`;

// What the browser keeps, key by key, as web/public/theme.js, app/*.mjs and
// benchmark/leaderboard.mjs write it. A new key in a script means a new row here.
const code = (...names) => html`${names.map((name, index) => html`${index ? ', ' : ''}<code>${name}</code>`)}`;
export const BROWSER_STORAGE = [
  { keys: ['bo-theme'], where: 'This browser', what: 'Nothing now. An earlier version of the site kept your colour theme here; the site removes it when a page loads.' },
  { keys: ['bo:history', 'bo-history'], where: 'This browser', what: 'Review history, when you turn it on: the packet, manifest and text of each finished review, with its profile, model, verdict and time.' },
  { keys: ['bo:known'], where: 'This browser', what: 'The value 1 once you have signed in here, so the sign-in dialog offers Sign in first. Deleting the account removes it.' },
  { keys: ['bo-bench-hidden'], where: 'This browser', what: 'The leaderboard columns you hid on the benchmark page.' },
  { keys: ['bo:workbench'], where: 'This tab', what: 'The files you loaded, your focus and context, the review type, provider and model you chose, the step you are on and the last result.' },
  { keys: ['bo:workbench:view', 'bo:workbench:stash'], where: 'This tab', what: 'Whether an example is open, how the review runs, which provider’s key field is open and the privacy warnings you accepted; and your own work while an example is shown.' },
  { keys: ['bo:handoff'], where: 'This tab', what: 'A draft or files a free tool, a template page or the guide passes to the workbench. The workbench removes it when it reads it.' },
  { keys: ['bo:openrouter:kept'], where: 'This tab', what: 'Your OpenRouter key, only when you tick “Keep the key for this tab session” as you connect OpenRouter.' },
  { keys: ['bo:openrouter:pkce'], where: 'This tab', what: 'The one-time code of an OpenRouter connection while it completes.' },
  { keys: ['bo:gauntlet:run'], where: 'This tab', what: 'The answers of the Gauntlet stages that have finished, so a run picks up where it stopped. No key and no source file.' },
  { keys: ['bo:panel:seats', 'bo:panel:run'], where: 'This tab', what: 'The providers and models of your Panel seats, and the reviews the Panel has finished. No key and no source file.' },
  { keys: ['bo:return'], where: 'This tab', what: 'Where to put you back on the page after Stripe Checkout, for up to two hours.' },
];

const storageTable = stackTable({
  label: 'What your browser keeps',
  columns: [{ label: 'Name' }, { label: 'Kept in' }, { label: 'What it holds' }],
  rows: BROWSER_STORAGE.map((entry) => [code(...entry.keys), entry.where, entry.what]),
  dense: true,
});

const cookies = html`
<p>Two necessary cookies: a session cookie (up to 30 days) and a five-minute sign-in cookie.</p>
<ul>
<li>${inline('`__Host-bounty-session` keeps you signed in. It lasts up to 30 days.')}</li>
<li>${inline('`__Host-bounty-challenge` ties a passkey prompt to the request that started it. It lasts five minutes.')}</li>
</ul>
<p>${inline('Both are `HttpOnly`, `Secure` and `SameSite=Lax`.')}</p>
<p>The site’s scripts keep the following in your browser. None of it is a cookie, and our server never reads it. “This tab” is the tab’s session storage: closing the tab removes it. “This browser” is local storage, or the history database, and stays until you clear it.</p>
${storageTable}
<p>History is optional and is saved only in this browser. It never includes source files, API keys or GitHub tokens, it is never sent to our server, and one button clears it. A GitHub token you type for an import is held in the tab’s memory and is not stored.</p>`;

const usage = html`
<p>For each hosted review we store the account identifier, the status (running, completed or failed), the review profile, the channel (web or MCP) and the timestamps. These rows enforce the daily allowance and the concurrency limit. They are deleted after seven days.</p>
<p>Abuse limits use a keyed hash of your IP address that expires within a day. Expired sessions, sign-in challenges and rate-limit rows are deleted daily.</p>
<p>The Worker keeps no invocation logs. When a request fails, its own log line holds the request path and an error name, and for a failed billing call Stripe’s error type and code. No log line holds an IP address, a request body, file contents, an API key or a Stripe payload.</p>
<p>Cloudflare, which hosts the site, processes each request’s IP address to deliver it.</p>`;

const counters = html`
<p>Page views and named actions are counted in aggregate. We do the counting ourselves and keep one number per day for each of these:</p>
<ul>
<li>page views per path</li>
<li>the referring site, from a fixed list</li>
<li>sign-ups and sign-ins</li>
<li>completed reviews per profile, and failed reviews</li>
<li>daily-limit hits, checkouts started and subscriptions activated</li>
<li>named actions a page reports from a fixed list: an example loaded, a prompt exported, a packet saved, a free tool run, a template copied, an MCP command copied</li>
</ul>
<p>A page reports an action by its name and sends nothing with it. On a free tool, a template page and the MCP page that counter is the only request your action causes: what you paste or drop there never leaves the browser.</p>
<p>A counter holds a date, a name and a total. It holds no account identifier, no IP address and no cookie value. Counters older than 400 days are deleted.</p>`;

const thirdParties = html`
<p>Cloudflare, which hosts the site, processes each request’s IP address and other request metadata to deliver it, under its own policies.</p>
<p>${inline('A GitHub import goes from your browser straight to `api.github.com`, with the link you chose and your read-only token if you supply one. The token is held in tab memory. The imported files reach our server only when you run a hosted review.')}</p>
<p>${inline('Connecting OpenRouter happens between your browser and `openrouter.ai`.')}</p>
<p>${inline('The MCP server handles the file contents your agent passes to a tool. `list_profiles`, `prepare_review` and `build_packet` keep none of it. `run_review` is a hosted review and is recorded like one. Your agent’s own model provider receives tool results under its own terms.')}</p>
<p>Connection tokens are shown once and stored as hashes. They expire after 90 days and you can revoke one in the account panel. Recovering an account, or signing out everywhere, revokes all of them.</p>`;

const payments = html`
<p>Stripe collects your email, card and billing details at checkout. Card details never reach our application. We send Stripe your account identifier.</p>
<p>Our database keeps the Stripe customer and subscription IDs, the subscription status, the paid-until time, your receipt email, and webhook event IDs for 30 days. Stripe keeps its own financial records.</p>`;

const deletion = html`
<p>Download your account data or delete your account from the account panel. Cancel an active subscription first.</p>
<p>Deleting removes the account, its passkeys, sessions, connection tokens, usage rows and billing references from our database. It cannot be undone.</p>
<p>Questions: ${supportLink()}.</p>`;

const changes = html`<p>We update this page when what we process changes. The date at the top is the current version. The <a href="/security">security page</a> shows how the stored data is protected.</p>`;

const body = docPage({
  head: {
    crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Privacy' }],
    title: 'Privacy policy',
    lede: 'Built by Tradi3. Operated by Vaytric, which is responsible for the data described here. This page covers the hosted site at bountyoperator.com. The open-source command-line kit runs on your own machine.',
    meta: html`Last updated ${time(UPDATED)}`,
  },
  before: glance,
  sections: [
    { id: 'files', title: 'Your files and your API key', label: 'Files and API key', body: files },
    { id: 'account', title: 'Account records', body: account },
    { id: 'cookies', title: 'Cookies and browser storage', body: cookies },
    { id: 'usage', title: 'Usage records and abuse limits', label: 'Usage and abuse limits', body: usage },
    { id: 'counters', title: 'Page and funnel counters', body: counters },
    { id: 'third-parties', title: 'Cloudflare, GitHub, OpenRouter and MCP', label: 'Other services', body: thirdParties },
    { id: 'payments', title: 'Payments', body: payments },
    { id: 'deletion', title: 'Export and deletion', body: deletion },
    { id: 'changes', title: 'Changes', body: changes },
  ],
});

export default {
  path: PATH,
  title: 'Privacy policy | Bounty Operator',
  label: 'Privacy',
  description:
    'What Bounty Operator stores and never stores, the two cookies, what your browser keeps, what Stripe sees, and how to export or delete your account.',
  styles: DOCS_STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Privacy', path: PATH }])],
  lastmod: UPDATED,
  body,
};
