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
import { assertNoBannedNames } from './private-lists.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const EXPECTED_PATHS = ['/changelog', '/guide', '/licenses', '/mcp', '/privacy', '/security', '/terms'];

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

test('the docs group builds its seven pages', () => {
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
  assert.match(terms, /US\$10 every week/);
  assert.match(terms, /Price changes are posted here 14 days ahead and never apply to a week already paid\./);
  assert.match(terms, /If you paid and got no access, or the service was down for a material part of your week, we fix it or refund that charge\./);
});

test('the privacy policy states the cookie count, the keyed IP hash and the counters', () => {
  const privacy = textOf(rendered.get('/privacy'));
  assert.match(privacy, /Two necessary cookies: a session cookie \(up to 30 days\) and a five-minute sign-in cookie\./);
  assert.match(privacy, /Abuse limits use a keyed hash of your IP address that expires within a day\./);
  assert.match(privacy, /no account identifier, no IP address/);
  assert.match(privacy, /No ad cookies\. No tracking pixels\./);
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

test('the security page prints the content security policy from the specification', () => {
  const security = textOf(rendered.get('/security'));
  assert.ok(
    security.includes(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.github.com https://raw.githubusercontent.com https://openrouter.ai; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ),
  );
  assert.match(security, /security@bountyoperator\.com/);
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
  assert.match(privacy, /named actions a page reports from a fixed list: an example loaded, a prompt exported, a packet saved, a free tool run, a template copied, an MCP command copied/);
  assert.match(privacy, /A page reports an action by its name and sends nothing with it\./);
  assert.match(privacy, /what you paste or drop there never leaves the browser\./);
  assert.match(privacy, /Last updated 7 October 2026/);
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
