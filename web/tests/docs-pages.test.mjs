// Tests for the guide, MCP, legal and trust pages (web/site/pages/docs) and the
// static files that ship with them.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPages, scanTags, validateMarkup } from '../../scripts/build-site.mjs';
import { renderPage } from '../site/layout.mjs';
import { parseChangelog } from '../site/pages/docs/changelog.mjs';
import { SUPPORT_LINKS } from '../site/pages/docs/support.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
/** A link as it stands in Markdown, YAML or plain text: up to the first space, bracket or quote. */
const LINK = /https?:\/\/[^\s)\]>"']+/g;
const EXPECTED_PATHS = ['/changelog', '/docs/model-api', '/docs/model-selection', '/guide', '/licenses', '/mcp', '/model-api', '/privacy', '/security', '/support', '/terms'];

const site = { pages: [], has: () => true, preloadsFor: () => [] };
const pages = (await loadPages(path.join(WEB_DIR, 'site', 'pages'))).filter((page) => page.source.startsWith('docs/'));
const rendered = new Map(pages.map((page) => [page.path, renderPage(page, site)]));

/** Visible text of a rendered page: tags and code blocks removed, entities decoded. */
function textOf(markup) {
  return markup
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

test('the docs group builds its expected pages', () => {
  assert.deepEqual([...rendered.keys()].sort(), EXPECTED_PATHS);
});

test('every docs page passes the generator checks and has one h1', () => {
  for (const [pagePath, markup] of rendered) {
    const { errors, warnings } = validateMarkup(markup, () => true);
    assert.deepEqual(errors, [], pagePath);
    assert.deepEqual(warnings, [], pagePath);
    assert.equal(scanTags(markup).filter((tag) => tag.name === 'h1').length, 1, pagePath);
  }
});

test('every docs page has a description of 50 to 160 characters and a breadcrumb list', () => {
  for (const page of pages) {
    assert.ok(page.description.length >= 50 && page.description.length <= 160, `${page.path}: ${page.description.length}`);
    assert.ok(page.jsonld.some((entry) => entry['@type'] === 'BreadcrumbList'), page.path);
  }
});

test('the sentence that a review is not an audit appears once, in the terms', () => {
  for (const [pagePath, markup] of rendered) {
    const count = textOf(markup).split('not an audit').length - 1;
    assert.equal(count, pagePath === '/terms' ? 1 : 0, pagePath);
  }
});

// The names that must stay out are read from lists git ignores
// (./private-lists.mjs): a pattern here would publish the name it guards.
// The operating entity is one of them, allowed on /terms and /privacy only.
test('no docs page names another product domain or a third-party method', () => {
  for (const [pagePath, markup] of rendered) {
    assertNoBannedNames(textOf(markup), pagePath, { page: pagePath });
  }
});

test('legal pages name the builder, the operator and the support address', () => {
  for (const pagePath of ['/privacy', '/terms']) {
    const text = textOf(rendered.get(pagePath));
    assert.match(text, /Built by Tradi3/, pagePath);
    assert.match(text, /support@bountyoperator\.com/, pagePath);
  }
  // Both pages name one operator, and it is not the builder.
  const operators = ['/privacy', '/terms'].map((pagePath) => /operated by (\p{Lu}[\p{L}\p{N}]+)/iu.exec(textOf(rendered.get(pagePath)))?.[1]);
  assert.ok(operators[0], 'the privacy page names its operator');
  assert.equal(operators[0], operators[1]);
  assert.notEqual(operators[0], 'Tradi3');
  const terms = textOf(rendered.get('/terms'));
  assert.match(terms, /New Operator subscriptions cost US\$10 every month/);
  assert.match(terms, /Price changes are posted here 14 days ahead and never apply to a period already paid\./);
  assert.match(terms, /If you paid and got no access, or the service was down for a material part of your paid period, we fix it or refund that charge\./);
  assert.match(terms, /Existing weekly subscriptions keep their US\$10 weekly price and billing interval shown in the Stripe portal/);
  assert.match(terms, /They are not automatically moved to the monthly plan and do not receive the monthly plan’s API credit\./);
  assert.match(terms, /Each verified paid US\$10 monthly Operator invoice also adds US\$2 in API credit\./);
  assert.match(terms, /Unpaid invoices and grace periods add no credit\./);
  assert.match(terms, /Included credit rolls over without expiring, and cancelling a subscription does not remove credit from a paid month\./);
  assert.match(terms, /Included Operator credit has no separate cash refund/);
  assert.match(terms, /Auto top-ups are off by default\./);
  assert.match(terms, /a calendar-month cap of US\$20, US\$50, US\$100, US\$200 or US\$500/);
  assert.match(terms, /limits automatic top-ups only/);
  assert.match(terms, /a payment already processing may still complete/);
});

test('the privacy policy states the cookie count, the keyed IP hash and the counters', () => {
  const privacy = textOf(rendered.get('/privacy'));
  assert.match(privacy, /Two necessary cookies: a session cookie \(up to 30 days\) and a five-minute sign-in cookie\./);
  assert.match(privacy, /Abuse limits use a keyed hash of your IP address that expires within a day\./);
  assert.match(privacy, /no account identifier, no IP address/);
  assert.match(privacy, /No ad cookies\. No tracking pixels\./);
  assert.match(privacy, /If you opt in to auto top-ups, Stripe saves your payment method\./);
  assert.match(privacy, /the time and version of your consent, and payment attempts and outcomes/);
  assert.match(privacy, /Full card details stay with Stripe; we retain the method type and masked details/);
});

test('the privacy policy lists every key the site scripts keep in the browser', async () => {
  const { BROWSER_STORAGE } = await import('../site/pages/docs/privacy.mjs');
  const listed = new Set(BROWSER_STORAGE.flatMap((entry) => entry.keys));
  // Every storage key a shipped script names: bo:… and bo-… string constants
  // passed to localStorage, sessionStorage or indexedDB.
  const { readdir } = await import('node:fs/promises');
  const scripts = ['theme.js'];
  for (const dir of ['app', 'benchmark', 'docs', 'templates', 'tools']) {
    for (const name of await readdir(path.join(PUBLIC_DIR, dir))) if (name.endsWith('.mjs')) scripts.push(`${dir}/${name}`);
  }
  const used = new Set();
  for (const file of scripts) {
    const source = await readFile(path.join(PUBLIC_DIR, file), 'utf8');
    if (!/localStorage|sessionStorage|indexedDB|readSession|writeSession|sessionStore/.test(source)) continue;
    for (const [, key] of source.matchAll(/['"](bo[:-][a-z][a-z:-]*)['"]/g)) used.add(key);
  }
  assert.ok(used.size >= 10, `found ${[...used].join(', ')}`);
  for (const key of used) assert.ok(listed.has(key), `/privacy does not list ${key}`);
  for (const key of listed) assert.ok(used.has(key), `/privacy lists ${key}, which no script uses`);

  const privacy = textOf(rendered.get('/privacy'));
  for (const key of listed) assert.ok(privacy.includes(key), key);
  assert.match(privacy, /The Worker keeps no invocation logs\./);
  assert.match(privacy, /No log line holds an IP address, a request body, file contents, an API key or a Stripe payload\./);
  assert.match(privacy, /Cloudflare, which hosts the site, processes each request’s IP address to deliver it\./);
});

test('the MCP page prints the two install commands exactly', () => {
  const mcp = textOf(rendered.get('/mcp'));
  assert.ok(mcp.includes('claude mcp add --transport http bounty-operator https://bountyoperator.com/api/mcp'));
  assert.ok(mcp.includes('npx -y https://bountyoperator.com/dl/bounty-operator-mcp.tgz'));
  assert.ok(mcp.includes('codex mcp add bounty-operator --url https://bountyoperator.com/api/mcp'));
  assert.doesNotMatch(rendered.get('/mcp'), /\.zip/);
  for (const tool of ['list_profiles', 'prepare_review', 'build_packet', 'account', 'run_review']) {
    assert.ok(mcp.includes(tool), tool);
  }
});

test('the MCP page names the tools and prompts the endpoint registers', async () => {
  const { handleMcpMessage } = await import('../src/mcp.ts');
  const list = async (method, key) => (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method }, {})).body.result[key].map((entry) => entry.name);
  const tools = await list('tools/list', 'tools');
  const prompts = await list('prompts/list', 'prompts');
  assert.equal(tools.length, 5);
  assert.equal(prompts.length, 3);

  const mcp = textOf(rendered.get('/mcp'));
  for (const name of tools) assert.ok(mcp.includes(name), name);
  for (const name of prompts) assert.ok(mcp.includes(`/mcp__bounty-operator__${name} `), name);
  assert.equal(mcp.split('/mcp__bounty-operator__').length - 1, prompts.length);
});

test('the security page prints the headers the Worker sets', async () => {
  const { SECURITY_HEADERS } = await import('../src/http.ts');
  const security = textOf(rendered.get('/security'));
  const names = Object.keys(SECURITY_HEADERS);
  assert.equal(names.length, 7);
  for (const name of names) assert.ok(security.includes(`${name}: ${SECURITY_HEADERS[name]}`), name);
});

test('the legal pages state the lifetimes the Worker enforces', async () => {
  const { RECENT_AUTH_SECONDS } = await import('../src/auth.ts');
  assert.equal(RECENT_AUTH_SECONDS, 600);
  assert.match(textOf(rendered.get('/security')), /a passkey check from the last 10 minutes/);
  const auth = await readFile(path.join(WEB_DIR, 'src', 'auth.ts'), 'utf8');
  for (const constant of ['SESSION_SECONDS = 30 * 86400', 'CHALLENGE_SECONDS = 300', 'CONNECTION_SECONDS = 90 * 86400', 'MAX_CONNECTIONS = 3']) {
    assert.ok(auth.includes(constant), constant);
  }
  const worker = await readFile(path.join(WEB_DIR, 'src', 'worker.ts'), 'utf8');
  for (const purge of ["DELETE FROM reviews WHERE created_at < ?').bind(now - 7 * day)", "DELETE FROM stripe_events WHERE created_at < ?').bind(now - 30 * day)", 'now - 400 * day']) {
    assert.ok(worker.includes(purge), purge);
  }
  const privacy = textOf(rendered.get('/privacy'));
  for (const sentence of [
    'It lasts up to 30 days.',
    'It lasts five minutes.',
    'They are deleted after seven days.',
    'webhook event IDs for 30 days',
    'They expire after 90 days',
    'Counters older than 400 days are deleted.',
  ]) {
    assert.ok(privacy.includes(sentence), sentence);
  }
  assert.ok(textOf(rendered.get('/mcp')).includes('A token lasts 90 days. An account holds three at a time.'));
});

// Only the first account ever made a connection token. /mcp now says what a
// free account adds and leads to one: the home page opens the dialog for
// /#account/connections (app/account.mjs) and lands on Connections.
test('the MCP page says what a free account adds and leads to an account and a token', async () => {
  const markup = rendered.get('/mcp');
  const { PROFILES } = await import('../public/profiles.mjs');
  const { ACCOUNT_LINKS } = await import('../public/app/account.mjs');
  const { TOKEN_SIGNUP } = await import('../site/pages/docs/mcp.mjs');
  const listed = PROFILES.filter((profile) => profile.listed).length;
  assert.equal(listed, 11);
  assert.match(markup, /<h1>Bug report review in your coding agent<\/h1>/);
  assert.ok(
    textOf(markup).includes(
      `Your agent checks a bug report against the code before you submit. Code, Solidity and draft-report reviews run on your agent’s own model with no account. A free account adds run_review for all ${listed} review types, one a day on your own key.`,
    ),
  );
  assert.equal(TOKEN_SIGNUP, '/#account/connections');
  assert.ok(Object.hasOwn(ACCOUNT_LINKS, '#account/connections'));
  const button = '<a class="btn btn--secondary btn--sm" href="/#account/connections"><span class="icon icon--key" aria-hidden="true"></span><span class="btn__label">Create a free account and token</span></a>';
  // One in the token section, and one in each client's "Add your account token".
  const token = markup.slice(markup.indexOf('id="create-token"'));
  assert.ok(token.slice(0, token.indexOf('</ol>')).includes(button), 'the token section');
  const install = markup.slice(markup.indexOf('<section class="install"'), markup.indexOf('</section>', markup.indexOf('<section class="install"')));
  assert.equal(install.split(button).length - 1, 3, 'one per client');
  assert.match(markup, /<li>Create a free account at <a href="\/#account\/connections">bountyoperator\.com<\/a> with a passkey, or sign in with yours\. The account panel opens on Connections\.<\/li>/);
});

test('the security page prints the content security policy from the specification', () => {
  const security = textOf(rendered.get('/security'));
  assert.ok(
    security.includes(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.github.com https://raw.githubusercontent.com https://openrouter.ai; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ),
  );
  assert.match(security, /security@bountyoperator\.com/);
});

/** The text of the first-call code block in a slice of /model-api markup. */
function buildSnippetText(markup) {
  return textOf(markup.slice(markup.indexOf('api-today__code')));
}

// The Model API sells seven models since 0.9.16. A first-time visitor reads what
// can be used today and how to start before the catalog of everything else.
test('the Model API page says at the top what can be used today and how to start, before the full catalog', async () => {
  const markup = rendered.get('/model-api');
  const top = markup.slice(markup.indexOf('<h1'), markup.indexOf('id="models"'));
  const text = textOf(top);
  const { DEFAULT_MODELS, mergeCatalog, todayBlock } = await import('../public/app/model-api.mjs');

  // Available today, the price, then the three steps in order, then the first call.
  const order = ['Available today', 'Qwen Cyber 27B AWQ, DeepHat V1 7B, Orca Qwen 3.8 27B, Orca Nex N2.5 Mini, Hermes 4 14B, Hermes 4.3 36B, Foundation-Sec 1.1 8B. Each card below shows its price. The other 17 models below are not available yet.', 'How to start', 'Buy credit.', 'Create a key.', 'Call it.', 'Your first call'];
  const positions = order.map((needle) => text.indexOf(needle));
  assert.ok(positions.every((position) => position >= 0), `missing: ${order.filter((_, index) => positions[index] < 0).join(', ')}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(text, /add US\$20, US\$50 or US\$100\./);
  assert.match(text, /The key starts with bo_api_ and is shown once/);
  assert.match(text, /"model": "cyber-qwen-27b-awq"/);
  assert.match(top, /<section class="api-today" id="model-api-start" data-open="true" data-state="open" aria-labelledby="start">/);
  // Step 1 has an id: while buying credit is closed, the script swaps it for the credit already held.
  assert.match(top, /<li id="model-api-step-buy"><strong>Buy credit\.<\/strong>/);
  // The first call reads the key from BOUNTY_OPERATOR_API_KEY, and step 2 says to put it there.
  assert.match(buildSnippetText(top), /\$BOUNTY_OPERATOR_API_KEY/);
  assert.match(text, /shown once, so save it in your environment as BOUNTY_OPERATOR_API_KEY : the call below reads it from there\./);
  // "No subscription" is said once above the catalog, in the highlights, not three times.
  const aboveCatalog = textOf(markup.slice(markup.indexOf('<h1'), markup.indexOf('id="models"')));
  assert.equal(aboveCatalog.match(/subscription/gi)?.length, 1, aboveCatalog);
  assert.match(aboveCatalog, /Prepaid credit, no subscription/);

  // The built heading and line are the ones the script writes for today's catalog, so on load the script
  // leaves them, markup and all. Paused, closed and unchecked states rewrite both (app-core tests).
  const selling = ['cyber-qwen-27b-awq', 'deephat-v1-7b', 'foundation-sec-8b', 'hermes-4-14b', 'orca-nex-mini', 'orca-qwen-27b', 'hermes-4.3-36b'];
  const open = { enabled: true, topups_enabled: true, models: DEFAULT_MODELS.filter((model) => selling.includes(model.id)).map((model) => ({ ...model, availability: 'available' })) };
  const block = todayBlock(open, mergeCatalog(open));
  // The line for several models is plain text, so it is compared as built, with no markup to strip.
  const built = /<p class="api-today__line" id="model-api-today">([\s\S]*?)<\/p>/.exec(markup)[1];
  assert.equal(built, block.line);
  assert.equal(/<h2 id="start">([^<]*)<\/h2>/.exec(markup)[1], block.heading);

  // The whole catalog follows, and the page speaks of your own AI provider API key, never a "model key".
  assert.ok(markup.indexOf('id="model-api-catalog"') > markup.indexOf('id="model-api-start"'));
  assert.match(textOf(markup), /All models and prices/);
  assert.doesNotMatch(textOf(markup), /model key|Hosted security catalog|BYO key/);
});

// /security once said Model API keys are never stored, while /privacy said
// their hashes and prefixes are. What the code keeps decides both pages.
test('the security page, the privacy page and the code agree on what is kept of a Model API key, request and card', async () => {
  const security = textOf(rendered.get('/security'));
  const privacy = textOf(rendered.get('/privacy'));
  const credits = await readFile(path.join(WEB_DIR, 'src', 'api-credits.ts'), 'utf8');
  const worker = await readFile(path.join(WEB_DIR, 'src', 'worker.ts'), 'utf8');
  const autoTopup = await readFile(path.join(WEB_DIR, 'src', 'api-autotopup.ts'), 'utf8');

  // A key is kept as its SHA-256 and its first 15 characters, and is shown once.
  assert.ok(credits.includes('await sha256(token), token.slice(0, 15), label'));
  assert.match(security, /Bounty Operator API keys: a SHA-256 hash, the visible prefix, the label, the spending limit/);
  assert.match(security, /We keep its hash and its first 15 characters/);
  assert.match(security, /A Bounty Operator API key itself: it is shown once, when you create it/);
  assert.match(privacy, /We store hashes of API keys, their visible prefixes and labels/);
  // What is never stored is the visitor's own provider key, on both pages.
  assert.doesNotMatch(security, /Model API keys and GitHub tokens/);
  assert.match(security, /Never stored .*Your own AI provider API keys \(OpenRouter, Anthropic, OpenAI and the rest\) and GitHub tokens/);
  assert.match(privacy, /Files, instructions, your own AI provider API keys and review results are never written to our database or logs\./);

  // Request rows go after 30 days; the ledger stays.
  assert.ok(worker.includes("DELETE FROM inference_requests WHERE status != 'running' AND created_at < ?\").bind(now - 30 * day)"));
  assert.match(security, /Per Model API request: model, key, time, status, token counts, credit held and the charge, for 30 days/);
  assert.match(privacy, /Request metadata is deleted after 30 days\./);
  assert.match(security, /The prepaid credit ledger and Stripe payment references, kept for accounting/);

  // A saved payment method is kept as its type and masked details, never the full card.
  assert.match(autoTopup, /type: method\.type, brand: method\.card\?\.brand \?\? null,/);
  assert.match(autoTopup, /exp_month: method\.card\?\.exp_month \?\? null, exp_year: method\.card\?\.exp_year \?\? null/);
  assert.match(security, /its type and masked details \(for a card, the brand, the last four digits and the expiry month and year\)/);
  // A key's life is one of the four the code accepts.
  assert.ok(credits.includes('if (![7, 30, 90, 365].includes(Number(days)))'));
  assert.match(security, /A key lasts 7, 30, 90 or 365 days/);
  assert.match(privacy, /we retain the method type and masked details/);
  assert.match(security, /Full card details/);
  assert.doesNotMatch(rendered.get('/security'), /<li>Card details<\/li>/);

  // The Model API is in scope, and its testing rule is in SECURITY.md too.
  assert.match(security, /The Model API The `?\/v1`? endpoints, Bounty Operator API keys and their limits/);
  const policy = await readFile(path.join(WEB_DIR, '..', 'SECURITY.md'), 'utf8');
  assert.match(policy, /\*\*The Model API\*\* at `\/v1`/);
  for (const text of [security, policy.replace(/\s+/g, ' ')]) assert.match(text, /Test the Model API with your own key and your own credit, a few small requests at a time\./);
  assert.match(rendered.get('/security'), /Last updated <time datetime="2026-10-15">15 October 2026<\/time>/);
});

test('parseChangelog reads releases, group labels, wrapped items and drops comments', () => {
  const releases = parseChangelog(
    [
      '# Changelog',
      '',
      '## 1.2.0 — 2026-10-02',
      '',
      '<!-- a note for maintainers',
      'spanning two lines -->',
      '',
      'Reviews',
      '',
      '- First item that wraps',
      '  onto a second line.',
      '- Second item with `code`.',
      '',
      'A paragraph that ends with a full stop.',
      '',
      '## 1.1.0 — 2026-07-09',
      '',
      '- Only item.',
      '',
    ].join('\r\n'),
  );

  assert.deepEqual(
    releases.map((release) => [release.version, release.date]),
    [
      ['1.2.0', '2026-10-02'],
      ['1.1.0', '2026-07-09'],
    ],
  );
  assert.deepEqual(releases[0].blocks, [
    { type: 'group', text: 'Reviews' },
    { type: 'list', items: ['First item that wraps onto a second line.', 'Second item with `code`.'] },
    { type: 'paragraph', text: 'A paragraph that ends with a full stop.' },
  ]);
  assert.deepEqual(releases[1].blocks, [{ type: 'list', items: ['Only item.'] }]);
});

test('the changelog page lists every release in CHANGELOG.md', async () => {
  const source = await readFile(path.join(WEB_DIR, '..', 'CHANGELOG.md'), 'utf8');
  const versions = parseChangelog(source).map((release) => release.version);
  assert.ok(versions.length > 0);
  const markup = rendered.get('/changelog');
  for (const version of versions) {
    assert.ok(markup.includes(`id="v${version.replace(/[^0-9a-z]+/gi, '-')}"`), version);
  }
  // A maintainer note in CHANGELOG.md never reaches the page. (The layout's design
  // contract comment sits before <main> on every page.)
  assert.doesNotMatch(markup.slice(markup.indexOf('<main')), /<!--/);
});

test('security.txt has the required fields and has not expired', async () => {
  const text = await readFile(path.join(PUBLIC_DIR, '.well-known', 'security.txt'), 'utf8');
  const fields = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const [, name, value] = /^([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (!fields.has(name)) fields.set(name, value);
  }
  assert.equal(fields.get('Contact'), 'mailto:security@bountyoperator.com');
  assert.equal(fields.get('Canonical'), 'https://bountyoperator.com/.well-known/security.txt');
  assert.equal(fields.get('Policy'), 'https://bountyoperator.com/security');
  const expires = Date.parse(fields.get('Expires'));
  assert.ok(expires > Date.now(), 'security.txt has expired: set a new Expires date');
});

test('llms.txt links only to canonical, extensionless pages on the site', async () => {
  const text = await readFile(path.join(PUBLIC_DIR, 'llms.txt'), 'utf8');
  assert.match(text, /^# Bounty Operator\n/);
  const links = [...text.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length >= EXPECTED_PATHS.length);
  for (const link of links) {
    const url = new URL(link);
    assert.equal(url.origin, 'https://bountyoperator.com', link);
    assert.doesNotMatch(url.pathname, /\.html$|.\/$/, link);
  }
  for (const pagePath of EXPECTED_PATHS) {
    assert.ok(links.includes(`https://bountyoperator.com${pagePath}`), pagePath);
  }
});

test('the privacy policy says page views and named actions are counted in aggregate', () => {
  const privacy = textOf(rendered.get('/privacy'));
  assert.match(privacy, /Page views and named actions are counted in aggregate\./);
  assert.match(privacy, /named actions a page reports from a fixed list: an example loaded, a prompt exported, a reply pasted, a packet saved, a repository imported, the sign-in opened, the upgrade button pressed, a gauntlet or a panel started and finished, a free tool run, a template copied, an MCP command copied, a template draft passed to the review, a Create a free account button pressed/);
  assert.match(privacy, /A page reports an action by its name and sends nothing with it, and it reports that it was seen the same way\./);
  assert.match(privacy, /what you paste or drop there never leaves the browser\./);
  assert.match(privacy, /Last updated 15 October 2026/);
});

test('the privacy policy names every counter the Worker keeps', async () => {
  const privacy = textOf(rendered.get('/privacy'));
  const { CLIENT_EVENTS } = await import('../src/funnel.ts');
  // Each named action the browser may report has its words in the list.
  const words = {
    example_loaded: 'an example loaded', prompt_exported: 'a prompt exported', reply_pasted: 'a reply pasted', packet_saved: 'a packet saved',
    repo_imported: 'a repository imported', signin_opened: 'the sign-in opened', upgrade_clicked: 'the upgrade button pressed',
    gauntlet_started: 'a gauntlet or a panel started and finished', gauntlet_finished: 'a gauntlet or a panel started and finished',
    panel_started: 'a gauntlet or a panel started and finished', panel_finished: 'a gauntlet or a panel started and finished',
    tool_report_check: 'a free tool run', tool_secret_check: 'a free tool run', tool_slither_focus: 'a free tool run', tool_verify: 'a free tool run',
    tool_acceptance_rates: 'a free tool run', template_copied: 'a template copied', mcp_command_copied: 'an MCP command copied',
    template_handoff: 'a template draft passed to the review', signup_prompt_clicked: 'a Create a free account button pressed',
    page_seen: 'pages seen: each page reports once that it has loaded and is on screen, unless the browser says automation is driving it',
  };
  assert.deepEqual(Object.keys(words).sort(), [...CLIENT_EVENTS].sort(), 'a new named action needs its words on /privacy');
  for (const phrase of new Set(Object.values(words))) assert.ok(privacy.includes(phrase), phrase);

  assert.match(privacy, /page views per path, and each day’s total of the views a browser asked for as a page, which the request’s own headers say/);
  // Each referrer bucket the Worker can write has its words: the directories by domain, and Google split three ways.
  assert.match(privacy, /the MCP and skills directories glama\.ai, mcpnav\.net, mcpservers\.org, mcpmarket\.com, skillsmp\.com and skillsdirectory\.com, the Disclosed newsletter,/);
  assert.match(privacy, /Google Search, Google Search Console and Google’s other sites each count apart\./);
  const { referrerBucket } = await import('../src/funnel.ts');
  for (const host of ['glama.ai', 'mcpnav.net', 'mcpservers.org', 'mcpmarket.com', 'skillsmp.com', 'skillsdirectory.com']) {
    assert.ok(privacy.includes(host), host);
    assert.notEqual(referrerBucket(`https://${host}/`, 'https://bountyoperator.com'), 'other', host);
  }
  // What our own checks send is not counted, and the page says which counters leave it out.
  assert.match(privacy, /Our own automated checks name themselves in each request\. Their page views, named actions, MCP sessions and tool calls, sign-ups, sign-ins and checkouts are not counted\./);
  assert.match(privacy, /completed reviews per profile, failed reviews per kind of failure, and answers withheld per profile/);
  assert.match(privacy, /on the MCP endpoint: sessions opened, tool calls per tool, and calls turned away at the limit\. A session is counted under the kind of agent that opened it, from a fixed list: Claude, Codex, Cursor, or “other”\. A registry or a monitor is counted apart/);
  assert.match(privacy, /A counter holds a date, a name and a total\. It holds no account identifier, no IP address and no cookie value\./);
});

test('the MCP page counts a copied install command by name, and says which profiles each tool takes', async () => {
  const markup = rendered.get('/mcp');
  assert.match(markup, /<script type="module" src="\/docs\/copy-ping\.mjs" fetchpriority="low"><\/script>/);
  assert.match(markup, /<section class="install"/, 'the block the counter listens on');

  const source = await readFile(path.join(PUBLIC_DIR, 'docs', 'copy-ping.mjs'), 'utf8');
  assert.match(source, /import \{ ping \} from '\.\.\/tools\/ping\.mjs';/);
  assert.match(source, /querySelector\('\.install'\)/);
  assert.deepEqual([...source.matchAll(/\bping\(([^)]*)\)/g)].map((match) => match[1]), ["'mcp_command_copied'"]);
  assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|sendBeacon|textContent|innerText|\.value\b|clipboard/, 'it reads nothing from the page');

  const mcp = textOf(markup);
  assert.match(mcp, /Code security review, Solidity review and Challenge a draft report are the three core profiles\./);
  assert.match(mcp, /Every other profile runs on the hosted service through run_review/);
  assert.match(mcp, /prepare_review , for the three core profiles/);
  assert.match(mcp, /The gauntlet prompt, which runs its hosted stages with run_review/);
  // What the page says is what the endpoint does: prepare_review answers for a core profile and refuses a hosted one.
  const { handleMcpMessage } = await import('../src/mcp.ts');
  const prepare = async (profile) =>
    (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prepare_review', arguments: { profile, files: [{ name: 'draft.md', content: '# Draft\n\nA finding.\n' }] } } }, {})).body.result;
  for (const profile of ['general', 'solidity', 'report']) {
    const result = await prepare(profile);
    assert.equal(result.isError, false, profile);
    assert.ok(result.structuredContent.instructions.length > 100, `${profile}: the request carries the method`);
  }
  for (const profile of ['scope', 'provenance', 'prior-art', 'poc', 'severity', 'triage', 'report-edit', 'scanner', 'verdict', 'panel']) {
    const result = await prepare(profile);
    assert.equal(result.isError, true, profile);
    assert.equal(JSON.parse(result.content[0].text).code, 'hosted_profile', profile);
  }
});

test('the 0.7.0 changelog entry describes what ships', async () => {
  const source = await readFile(path.join(WEB_DIR, '..', 'CHANGELOG.md'), 'utf8');
  const latest = parseChangelog(source).find((entry) => entry.version === '0.7.0');
  assert.equal(latest.version, '0.7.0');
  assert.deepEqual(
    latest.blocks.filter((block) => block.type === 'group').map((block) => block.text),
    ['Skills and Claude Code plugin', 'Paydirt benchmark', 'Reviews', 'Operator', 'Workbench', 'Account', 'Free tools and templates', 'MCP', 'Fixes', 'Site', 'CLI'],
  );
  const entry = source.slice(source.indexOf('## 0.7.0'), source.indexOf('## 0.6.0')).replace(/\s+/g, ' ');
  for (const fact of [
    'Five skills:',
    '/benchmark',
    'Retried runs retain their earlier evidence in a private archive.',
    'counted run\'s latest stored invocation',
    'Report check treats explicit "prior art not checked" statements and empty headings as missing evidence.',
    'Eleven review profiles.',
    'eight stages (scope, provenance, prior art, proof, severity, triager, report, verdict)',
    'Panel review: two to four models',
    'Eight providers on your own key',
    'OpenRouter connects in one click',
    'render as finding cards under the verdict',
    'Paste-back for chat subscriptions',
    'a repository, a folder, a pull request or a commit',
    'Local history, off by default',
    'Rebuilt account panel',
    'Five free tools that run in the browser',
    'Five templates',
    'claude mcp add --transport http bounty-operator https://bountyoperator.com/api/mcp',
    'npx -y https://bountyoperator.com/dl/bounty-operator-mcp.tgz',
    'Hosted reviews now work on the production runtime.',
    'A weekly renewal no longer drops paid access',
    'The sign-up limit counts accounts created, not attempts.',
    '20,000 lines',
  ]) {
    assert.ok(entry.includes(fact), fact);
  }
  // What an earlier draft of the entry said and the release does not do.
  for (const stale of [/Nine review profiles/, /five-stage/i, /npx -y bounty-operator-mcp\b/, /PoC review/, /agent pack builder/i, /Draft\./]) {
    assert.doesNotMatch(entry, stale);
  }
  assert.doesNotMatch(source, /<!--/);
  assert.doesNotMatch(source, /krutftw/i);
  assertNoBannedNames(source, 'CHANGELOG.md');
});

test('the licences page lists the runtime packages of the Worker and of the MCP server, and says so when there are none', async () => {
  const production = async (lockfile) => {
    const lock = JSON.parse(await readFile(path.join(WEB_DIR, '..', lockfile), 'utf8'));
    return Object.entries(lock.packages).filter(([location, entry]) => location && !entry.dev && !entry.devOptional).length;
  };
  const licences = textOf(rendered.get('/licenses'));
  const page = pages.find((entry) => entry.path === '/licenses');

  const worker = await production('web/package-lock.json');
  assert.ok(worker > 0);
  assert.ok(licences.includes(`which bring in ${worker} packages in all`));

  // The MCP server is written without runtime dependencies. The page says that in words, never as an empty list.
  const mcp = await production('mcp/package-lock.json');
  if (mcp === 0) {
    assert.match(licences, /The MCP server has no runtime dependencies\./);
    assert.match(licences, /MCP server: no dependencies/);
    assert.match(licences, /The Worker uses the open-source packages listed here\. The MCP server has no dependencies\./);
    assert.doesNotMatch(page.description, /MCP server depend/);
  } else {
    assert.ok(licences.includes(`${mcp} packages in all once their own dependencies are counted`));
  }
  assert.doesNotMatch(licences, /depends on\s*,|\b0 packages\b/);
});

test('the docs scripts build no markup from strings and the stylesheet defines no colours', async () => {
  for (const name of ['docs/tabs.mjs', 'docs/handoff.mjs', 'docs/copy-ping.mjs']) {
    const source = await readFile(path.join(PUBLIC_DIR, name), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/, name);
  }
  const css = (await readFile(path.join(PUBLIC_DIR, 'css', 'docs.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
});

test('the MCP page shows how to add Immunefi Studio’s own MCP server next to this one', () => {
  const mcp = textOf(rendered.get('/mcp'));
  assert.ok(mcp.includes('claude mcp add --transport http immunefi-studio https://studio.immunefi.com/api/mcp --header "Authorization: Bearer $IMMUNEFI_STUDIO_TOKEN"'));
  assert.ok(mcp.includes('[mcp_servers.immunefi-studio] url = "https://studio.immunefi.com/api/mcp" bearer_token_env_var = "IMMUNEFI_STUDIO_TOKEN"'));
  assert.ok(mcp.includes('"Authorization": "Bearer ${env:IMMUNEFI_STUDIO_TOKEN}"'));
  assert.match(mcp, /Your agent sends it to Immunefi; Bounty Operator never receives it\./);
  assert.match(mcp, /The gauntlet writes a case to your Studio workspace only when you say yes\./);
  assert.match(rendered.get('/mcp'), /href="https:\/\/studio\.immunefi\.com\/agents"/);
});

test('the guide says what to do when the model refuses, at #model-refuses, with the same text in its structured data', () => {
  const markup = rendered.get('/guide');
  const start = markup.indexOf('<h2 class="docs-section__title" id="model-refuses">When the model refuses</h2>');
  assert.ok(start > 0, 'the section and its anchor');
  assert.match(markup, /<li><a href="#model-refuses">When the model refuses<\/a><\/li>/, 'listed under On this page');
  const section = markup.slice(start, markup.indexOf('</section>', start));
  // A link joins its words to the sentence around it, as it does on the page.
  const text = textOf(section.replace(new RegExp('</?a(?=[ >])[^>]*>', 'g'), ''));

  // What works today comes before any programme.
  const order = ['Run it again on another model or provider.', 'Cyber Verification Program', 'Trusted Access for Cyber', 'An approval reduces blocks. It does not remove them.'];
  const positions = order.map((needle) => text.indexOf(needle));
  assert.ok(positions.every((position) => position > 0), `missing: ${order.filter((_, index) => positions[index] < 0).join(', ')}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);

  for (const sentence of [
    'Bounty Operator tells you when a provider blocked a review. A blocked review is never counted.',
    'Bug bounty hunters apply as individuals for Defense Access, on a paid plan, at portal.anthropic.com/programs.',
    'Anthropic aims to answer within seven business days.',
    'The programme has its own rules for API keys: read them before you use a granted key in any tool.',
    'On OpenAI, Trusted Access for Cyber grants Daybreak access. Individuals request it at chatgpt.com/cyber.',
  ]) {
    assert.ok(text.includes(sentence), sentence);
  }
  // Said once each.
  assert.equal(text.split('never counted').length - 1, 1);
  assert.equal(text.split('reduces blocks').length - 1, 1);

  // Only the links read at their primary source, each opening in a new tab.
  const links = [...section.matchAll(/<a href="([^"]+)"([^>]*)>/g)];
  assert.deepEqual(links.map((match) => match[1]), [
    'https://support.claude.com/en/articles/14604842-cyber-verification-program',
    'https://portal.anthropic.com/programs',
    'https://support.claude.com/en/articles/17202708-cyber-verification-program-security-requirements',
    'https://chatgpt.com/cyber',
  ]);
  for (const match of links) assert.match(match[2], /target="_blank" rel="noopener noreferrer"/, match[1]);

  // No promise the programmes do not make, and no other provider's programme.
  for (const pattern of [/guarantee/i, /unlock/i, /Red Team/i, /Daybreak (?:Blue|Red)/, /Fairwind/i, /\bmay\b/i, /\bmight\b/i, /—/]) {
    assert.doesNotMatch(text, pattern, String(pattern));
  }

  const blocks = scanTags(markup).filter((tag) => tag.name === 'script' && tag.attributes.get('type') === 'application/ld+json').map((tag) => JSON.parse(tag.content));
  const faq = blocks.find((block) => block['@type'] === 'FAQPage');
  assert.equal(faq.mainEntity.length, 1);
  assert.equal(faq.mainEntity[0].name, 'When the model refuses');
  assert.ok(text.includes(faq.mainEntity[0].acceptedAnswer.text), 'the answer in the structured data is the visible text');
  const article = blocks.find((block) => block['@type'] === 'TechArticle');
  assert.equal(article.dateModified, '2026-10-09');
});

test('the help page sends each kind of request to its place, and says first what stays out of public', async () => {
  const markup = rendered.get('/support');
  const main = markup.slice(markup.indexOf('<main'), markup.indexOf('</main>'));
  const text = textOf(main);
  const FORUM = 'https://github.com/bountyoperator/bounty-operator/discussions';
  const SOURCE = 'https://github.com/bountyoperator/bounty-operator';
  // The forum's categories by the names they have on GitHub: a renamed category breaks a link here first.
  assert.deepEqual({ ...SUPPORT_LINKS }, {
    forum: FORUM,
    ask: `${FORUM}/categories/q-a`,
    ideas: `${FORUM}/categories/ideas`,
    wins: `${FORUM}/categories/wins`,
    announcements: `${FORUM}/categories/announcements`,
    bug: `${SOURCE}/issues/new?template=bug.yml`,
    advisory: `${SOURCE}/security/advisories/new`,
  });
  for (const href of Object.values(SUPPORT_LINKS)) assert.ok(main.includes(`href="${href}"`), href);
  // Account and payment questions are private: email, never the forum.
  assert.ok(main.includes('href="mailto:support@bountyoperator.com"'));
  assert.ok(main.includes('href="mailto:security@bountyoperator.com"'));
  // What must stay out of public is said before the first link into the forum.
  assert.ok(main.indexOf('The forum and the bug tracker are public') < main.indexOf(SUPPORT_LINKS.ask));
  assert.match(text, /Never post an unreported finding, a report draft, an API key, a connection token or a recovery code\./);
  assert.match(text, /We keep no files, prompts or results, so nobody here can look your review up\./);
  // The form the page links exists in the repository, and the chooser offers the same places.
  const repo = path.resolve(WEB_DIR, '..');
  await readFile(path.join(repo, '.github', 'ISSUE_TEMPLATE', 'bug.yml'), 'utf8');
  const chooser = await readFile(path.join(repo, '.github', 'ISSUE_TEMPLATE', 'config.yml'), 'utf8');
  // Links are pulled out of each file and compared whole, never by substring.
  const linksIn = (source) => new Set(source.match(LINK) ?? []);
  for (const href of [SUPPORT_LINKS.ask, SUPPORT_LINKS.ideas, SUPPORT_LINKS.advisory, 'https://bountyoperator.com/support#account']) assert.ok(linksIn(chooser).has(href), `issue chooser: ${href}`);
  assert.ok(main.includes('id="account"'), 'the chooser links #account');
  // The README and llms.txt point at the same places.
  const readme = await readFile(path.join(repo, 'README.md'), 'utf8');
  for (const href of [SUPPORT_LINKS.ask, SUPPORT_LINKS.ideas, SUPPORT_LINKS.bug, 'https://bountyoperator.com/support#account']) assert.ok(linksIn(readme).has(href), `README: ${href}`);
  const llms = await readFile(path.join(PUBLIC_DIR, 'llms.txt'), 'utf8');
  assert.ok(llms.includes('- [Help and feedback]('), 'llms.txt names the help page');
  for (const href of ['https://bountyoperator.com/support', SUPPORT_LINKS.forum]) assert.ok(linksIn(llms).has(href), `llms.txt: ${href}`);
});

test('every docs page links the help page from its footer', () => {
  for (const [pagePath, markup] of rendered) {
    assert.ok(markup.slice(markup.indexOf('<footer')).includes('href="/support"'), pagePath);
  }
});
