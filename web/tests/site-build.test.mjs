// Tests for the static page generator, the HTML helpers and the token blocks.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSite, modulePreloads, outputFile, renderSite, scanTags, sitemapXml, validateMarkup } from '../../scripts/build-site.mjs';
import { attrs, codeBlock, faq, findingCard, html, inline, raw, refChip, stackTable, textOf } from '../site/components.mjs';
import { SITE, breadcrumbsLd, faqPageLd, renderPage, softwareApplicationLd } from '../site/layout.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENTS_URL = pathToFileURL(path.join(WEB_DIR, 'site', 'components.mjs')).href;
const DESCRIPTION = 'A description that is comfortably longer than the fifty character minimum.';

/** A throwaway site: pages are written as modules, the public directory starts empty. */
async function fixtureSite(pages, publicFiles = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bo-site-'));
  const siteDir = path.join(root, 'site');
  const publicDir = path.join(root, 'public');
  await mkdir(path.join(siteDir, 'pages'), { recursive: true });
  await mkdir(publicDir, { recursive: true });

  for (const [name, source] of Object.entries(pages)) {
    const file = path.join(siteDir, 'pages', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `import { html } from '${COMPONENTS_URL}';\n${source}\n`);
  }
  // Every page links to these from the shared head, header and footer.
  const shared = ['index.html', 'guide.html', 'mcp.html', 'tools.html', 'privacy.html', 'terms.html', 'theme.js', 'field.mjs', 'favicon.ico', 'icon.svg', 'apple-touch-icon.png', 'site.webmanifest', 'css/base.css'];
  for (const name of [...shared, ...Object.keys(publicFiles)]) {
    const file = path.join(publicDir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, publicFiles[name] ?? 'hand-written');
  }
  return { root, siteDir, publicDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function pageSource({ path: pagePath, title, body = '<h1>Title</h1>', extra = '' }) {
  return `export default { path: '${pagePath}', title: '${title}', description: '${DESCRIPTION}', ${extra} body: html\`${body}\` };`;
}

test('html escapes interpolated values and passes trusted markup through', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  assert.equal(html`<p>${hostile}</p>`.toString(), '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
  assert.equal(html`<p>${raw('<b>ok</b>')}</p>`.toString(), '<p><b>ok</b></p>');
  assert.equal(html`<ul>${['a', 'b'].map((item) => html`<li>${item}</li>`)}</ul>`.toString(), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(html`<p>${null}${undefined}${false}${0}</p>`.toString(), '<p>0</p>');
  assert.equal(html`<a title="${'"quoted"'}">x</a>`.toString(), '<a title="&quot;quoted&quot;">x</a>');
});

test('attrs drops empty values and refuses attributes the CSP forbids', () => {
  assert.equal(attrs({ id: 'a', hidden: true, title: null, 'data-x': false }).toString(), ' id="a" hidden');
  assert.throws(() => attrs({ style: 'color:red' }), /CSP/);
  assert.throws(() => attrs({ onclick: 'run()' }), /CSP/);
  assert.throws(() => attrs({ 'bad name': 'x' }), /Invalid attribute name/);
});

test('inline turns backtick spans into code elements and escapes the rest', () => {
  assert.equal(html`${inline('call `exit()` <now>')}`.toString(), 'call <code>exit()</code> &lt;now&gt;');
  assert.equal(textOf(html`<p>a <b>b</b> &amp; c</p>`), 'a b & c');
});

test('codeBlock numbers lines from start and marks highlighted, flagged and dimmed lines', () => {
  const markup = codeBlock({ code: 'a < b\nc\nd', start: 10, highlight: [11], flag: [12], dim: [10] }).toString();
  assert.match(markup, /<span class="code__line is-dim" data-n="10">a &lt; b\n<\/span>/);
  assert.match(markup, /<span class="code__line is-hl" data-n="11">c\n<\/span>/);
  assert.match(markup, /<span class="code__line is-flag" data-n="12">d\n<\/span>/);
  assert.doesNotMatch(markup, /data-copy/);
});

test('refChip splits the file from the line range', () => {
  const markup = refChip('input-1/src/Vault.sol:60-69').toString();
  assert.match(markup, /<span class="ref__file">input-1\/src\/Vault\.sol<\/span><span class="ref__lines">:60-69<\/span>/);
  assert.match(refChip({ label: 'input-2/a.py', start: 4, end: 4 }).toString(), /ref__lines">:4</);
});

test('findingCard renders the rows in ledger order with their states', () => {
  const markup = findingCard({
    id: 'F-7',
    title: 'Title with `code`',
    severity: 'high',
    basis: 'needs-test',
    locations: [{ label: 'input-1/a.sol', start: 3, end: 9 }],
    impact: 'Impact.',
    path: ['One.', 'Two.'],
    counterargument: { objection: 'Objection.', status: 'open', why: 'Why.' },
    gap: 'none',
    fix: 'Fix.',
    next: 'Next.',
  }).toString();

  const rails = [...markup.matchAll(/data-rail="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rails, ['impact', 'observed', 'counter', 'gap', 'fix', 'next']);
  assert.match(markup, /class="chip sev" data-sev="high"/);
  assert.match(markup, /data-status="needs-test"/);
  assert.match(markup, /data-rail="counter" data-status="open"/);
  assert.match(markup, /data-rail="gap" data-status="none"/);
  assert.match(markup, /<h3 class="finding__title" id="f-7-title">Title with <code>code<\/code><\/h3>/);
});

test('scanTags reads attributes and skips escaped text', () => {
  const tags = scanTags('<p class="a" hidden>style="x" &lt;script&gt;</p><script type="application/ld+json">{"a":"<b>"}</script><a href=/x>y</a>');
  assert.deepEqual(tags.map((tag) => tag.name), ['p', 'script', 'a']);
  assert.equal(tags[0].attributes.get('class'), 'a');
  assert.equal(tags[0].attributes.has('style'), false);
  assert.equal(tags[1].content, '{"a":"<b>"}');
  assert.equal(tags[2].attributes.get('href'), '/x');
});

test('validateMarkup rejects what the CSP and the linking rules forbid', () => {
  const resolves = (pathname) => pathname === '/guide';
  const check = (markup) => validateMarkup(`<h1>t</h1>${markup}`, resolves);

  assert.match(check('<script>run()</script>').errors.join(), /inline <script>/);
  assert.match(check('<script src="https://cdn.example/x.js"></script>').errors.join(), /external script/);
  assert.match(check('<style>p{}</style>').errors.join(), /inline <style>/);
  assert.match(check('<p style="color:red">x</p>').errors.join(), /style attribute/);
  assert.match(check('<button onclick="run()">x</button>').errors.join(), /inline event handler onclick/);
  assert.match(check('<a href="/guide.html">x</a>').errors.join(), /ends in \.html/);
  assert.match(check('<a href="guide">x</a>').errors.join(), /relative link/);
  assert.match(check('<a href="/guide/">x</a>').errors.join(), /trailing slash/);
  assert.match(check('<a href="javascript:run()">x</a>').errors.join(), /javascript: URL/);
  assert.match(check('<img src="/a.png">').errors.join(), /no alt attribute/);
  assert.match(check('<p id="a"></p><p id="a"></p>').errors.join(), /id "a" is used 2 times/);
  assert.match(check('<script type="application/ld+json">{broken</script>').errors.join(), /JSON-LD block does not parse/);
  assert.deepEqual(check('<a href="/missing#top">x</a>').unresolved, ['/missing#top']);

  const clean = check('<a href="/guide#steps">x</a><a href="https://example.com/a.html">y</a><a href="mailto:a@b.c">z</a><script type="application/ld+json">{"a":1}</script>');
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(clean.unresolved, []);
});

test('outputFile maps extensionless paths to html files', () => {
  assert.equal(outputFile('/'), 'index.html');
  assert.equal(outputFile('/guide'), 'guide.html');
  assert.equal(outputFile('/tools/report-check'), 'tools/report-check.html');
});

test('sitemapXml lists indexable pages with extensionless URLs', () => {
  const xml = sitemapXml([
    { path: '/guide', lastmod: '2026-10-02' },
    { path: '/' },
    { path: '/404', robots: 'noindex' },
    { path: '/_kit', dev: true },
    { path: '/hidden', sitemap: false },
  ]);
  assert.match(xml, /<loc>https:\/\/bountyoperator\.com\/<\/loc><\/url>/);
  assert.match(xml, /<loc>https:\/\/bountyoperator\.com\/guide<\/loc><lastmod>2026-10-02<\/lastmod>/);
  assert.doesNotMatch(xml, /404|_kit|hidden|\.html/);
});

test('renderPage emits the head contract and no markup the CSP would block', () => {
  const page = {
    path: '/tools/report-check',
    title: 'Report check | Bounty Operator',
    description: DESCRIPTION,
    nav: 'tools',
    styles: ['/css/tools.css'],
    scripts: ['/tools/report-check.mjs'],
    jsonld: [breadcrumbsLd([{ name: 'Tools', path: '/tools' }]), faqPageLd([{ q: 'Q </script>', a: html`<p>A</p>` }])],
    body: html`<h1>Report check</h1>`,
  };
  const site = { has: (pathname) => pathname === '/benchmark', pages: [page], preloadsFor: () => ['/parse.mjs'] };
  const markup = renderPage(page, site);

  assert.match(markup, /<link rel="canonical" href="https:\/\/bountyoperator\.com\/tools\/report-check">/);
  assert.match(markup, /<meta property="og:image" content="https:\/\/bountyoperator\.com\/social-v5\.png">/);
  assert.match(markup, /<meta name="twitter:card" content="summary_large_image">/);
  // The builder's handle credits the card. The product has no X account, so there is no twitter:site.
  assert.equal([...markup.matchAll(/<meta name="twitter:creator" content="@Tradi3_">/g)].length, 1);
  assert.doesNotMatch(markup, /twitter:site/);
  assert.doesNotMatch(markup, /href="https?:\/\/(?:www\.)?(?:x|twitter)\.com/, 'no visible X link');
  // One look, the black page: one colour scheme and one theme colour, the page's own.
  assert.match(markup, /<meta name="color-scheme" content="dark">/);
  assert.equal([...markup.matchAll(/<meta name="theme-color" content="#09090a">/g)].length, 1);
  assert.equal([...markup.matchAll(/<meta name="theme-color"/g)].length, 1);
  assert.doesNotMatch(markup, /data-theme-toggle|theme-toggle/);
  assert.match(markup, /<script src="\/theme\.js"><\/script>/);
  // The moving field is a module of its own, on every page, ahead of the page's scripts.
  assert.ok(markup.indexOf('src="/field.mjs"') > 0 && markup.indexOf('src="/field.mjs"') < markup.indexOf('src="/tools/report-check.mjs"'));
  assert.match(markup, /<link rel="stylesheet" href="\/css\/base\.css">\n<link rel="stylesheet" href="\/css\/tools\.css">/);
  // The page's modules load at low priority, so they do not compete with what the first paint needs.
  assert.match(markup, /<link rel="modulepreload" href="\/parse\.mjs" fetchpriority="low">/);
  assert.match(markup, /<script type="module" src="\/tools\/report-check\.mjs" fetchpriority="low"><\/script>/);
  // What the first paint needs keeps the browser's own priority: the stylesheets, the theme script and the font.
  for (const tag of markup.match(/<link rel="(?:stylesheet|preload)"[^>]*>|<script src="\/theme\.js"[^>]*>/g)) assert.doesNotMatch(tag, /fetchpriority/, tag);
  assert.equal(markup.split('fetchpriority="low"').length - 1, markup.split('rel="modulepreload"').length - 1 + markup.split('<script type="module"').length - 1, 'only the modules carry it');
  assert.match(markup, /<a href="\/tools" aria-current="page">Tools<\/a>/);
  assert.match(markup, /<a href="\/benchmark">Benchmark<\/a>/);
  // One label for a signed-out visitor on every page: the link here, the button on the home page.
  assert.match(markup, /<a class="btn btn--secondary btn--sm" href="\/#account">Sign in<\/a>/);
  assert.doesNotMatch(markup, /id="account-button"/);
  assert.match(markup, /support@bountyoperator\.com/);
  assert.match(markup, /Built by <a href="https:\/\/immunefi\.com\/profile\/Tradi3\/"/);
  assert.doesNotMatch(markup, /Q <\/script>/);

  const { errors } = validateMarkup(markup, () => true);
  assert.deepEqual(errors, []);

  const home = renderPage({ ...page, path: '/', nav: undefined }, { has: () => false, pages: [] });
  assert.match(home, /<button id="account-button" class="btn btn--secondary btn--sm" type="button">Sign in<\/button>/);
  assert.match(home, /<meta name="twitter:creator" content="@Tradi3_">/);
  assert.doesNotMatch(home, /Benchmark/);
});

test('the header and footer link the method, the pricing page and the security page once those pages exist', () => {
  const page = { path: '/guide', title: 'Guide | Bounty Operator', description: DESCRIPTION, nav: 'guide', body: html`<h1>Guide</h1>` };
  const all = { has: () => true, pages: [page] };
  const inner = renderPage(page, all);
  assert.match(inner, /<a href="\/guide" aria-current="page">Guide<\/a>/);
  // Off the home page, Pricing is the pricing page: its button starts checkout there.
  assert.match(inner, /<nav class="site-nav"[\s\S]*?<a href="\/pricing">Pricing<\/a>/);
  assert.doesNotMatch(inner, /href="\/#pricing"/);
  for (const href of ['/method', '/mcp', '/templates', '/pricing', '/security']) {
    assert.match(inner.slice(inner.indexOf('<footer')), new RegExp(`<a href="${href}">`), href);
  }

  // On the home page the pricing section is one scroll away.
  const home = renderPage({ ...page, path: '/', nav: undefined }, all);
  assert.match(home, /<nav class="site-nav"[\s\S]*?<a href="\/#pricing">Pricing<\/a>/);

  // Until the pages exist, nothing links to them.
  const bare = renderPage(page, { has: () => false, pages: [page] });
  assert.doesNotMatch(bare, /href="\/method"|href="\/pricing"|href="\/security"/);
  assert.match(bare, /<a href="\/#pricing">Pricing<\/a>/);
});

test('softwareApplicationLd carries the two fixed offers', () => {
  const offers = softwareApplicationLd().offers;
  assert.deepEqual(offers.map((offer) => [offer.name, offer.price, offer.priceCurrency]), [
    ['Free', '0', 'USD'],
    ['Operator', '10.00', 'USD'],
  ]);
  assert.equal(offers[1].priceSpecification.billingDuration, 'P1W');
});

test('faq and faqPageLd share one list of items', () => {
  const items = [{ q: 'What do you keep?', a: 'Account and `passkey` records.' }];
  assert.match(faq(items).toString(), /<summary class="accordion__summary">What do you keep\?<\/summary>/);
  assert.equal(faqPageLd(items).mainEntity[0].acceptedAnswer.text, 'Account and passkey records.');
});

test('renderSite reports duplicate paths, duplicate titles and bad descriptions', async () => {
  const site = await fixtureSite({
    'a.mjs': pageSource({ path: '/a', title: 'Same' }),
    'b.mjs': pageSource({ path: '/a', title: 'Same' }),
    'c.mjs': `export default { path: '/c.html', title: 'C', description: 'too short', body: '<h1>not html</h1>' };`,
    'helpers.mjs': 'export const shared = 1;',
  });
  try {
    const { errors } = await renderSite(site);
    const all = errors.join('\n');
    assert.match(all, /b\.mjs: path \/a is already used by a\.mjs/);
    assert.match(all, /b\.mjs: title "Same" is already used by a\.mjs/);
    assert.match(all, /c\.mjs: path must be extensionless/);
    assert.match(all, /c\.mjs: description must be 50-160 characters \(it is 9\)/);
    assert.match(all, /c\.mjs: body must be the result of the html/);
  } finally {
    await site.cleanup();
  }
});

test('buildSite writes pages, tracks them, removes only its own stale output and checks drift', async () => {
  const site = await fixtureSite({
    'index.mjs': pageSource({ path: '/', title: 'Home', body: '<h1>Home</h1><a href="/tools/verify">Verify</a>' }),
    'tools/verify.mjs': pageSource({ path: '/tools/verify', title: 'Verify', extra: "lastmod: '2026-10-02'," }),
    '_kit.mjs': pageSource({ path: '/_kit', title: 'Kit', extra: 'dev: true,' }),
  });
  const read = (name) => readFile(path.join(site.publicDir, name), 'utf8');
  try {
    const dev = await buildSite({ ...site, dev: true });
    assert.equal(dev.ok, true, dev.errors.join('\n'));
    assert.deepEqual(dev.written.sort(), ['_kit.html', 'index.html', 'sitemap.xml', 'tools/verify.html']);
    assert.match(await read('_kit.html'), /<meta name="robots" content="noindex, nofollow">/);
    assert.doesNotMatch(await read('sitemap.xml'), /_kit/);

    // A production build drops the dev page it generated earlier and leaves hand-written files alone.
    const production = await buildSite(site);
    assert.equal(production.ok, true, production.errors.join('\n'));
    assert.deepEqual(production.removed, ['_kit.html']);
    assert.equal(existsSync(path.join(site.publicDir, '_kit.html')), false);
    assert.equal(await read('guide.html'), 'hand-written');
    assert.deepEqual(JSON.parse(await readFile(path.join(site.siteDir, '.generated.json'), 'utf8')).files, ['index.html', 'sitemap.xml', 'tools/verify.html']);

    assert.equal((await buildSite({ ...site, check: true })).ok, true);
    await writeFile(path.join(site.publicDir, 'index.html'), 'edited by hand');
    const drift = await buildSite({ ...site, check: true });
    assert.equal(drift.ok, false);
    assert.deepEqual(drift.problems, ['index.html is out of date']);
    assert.equal(await read('index.html'), 'edited by hand');
  } finally {
    await site.cleanup();
  }
});

test('an unresolved internal link fails a production build and only warns in a dev build', async () => {
  const site = await fixtureSite({
    'index.mjs': pageSource({ path: '/', title: 'Home', body: '<h1>Home</h1><a href="/not-written-yet">x</a>' }),
  });
  try {
    const production = await buildSite(site);
    assert.equal(production.ok, false);
    assert.match(production.errors.join(), /"\/not-written-yet" does not resolve/);

    const dev = await buildSite({ ...site, dev: true });
    assert.equal(dev.ok, true);
    assert.match(dev.warnings.join(), /"\/not-written-yet" does not resolve/);
  } finally {
    await site.cleanup();
  }
});

test('modulePreloads follows static imports and ignores dynamic and bare ones', async () => {
  const site = await fixtureSite({}, {
    'app/main.mjs': "import { a } from './state.mjs';\nimport '../parse.mjs';\nconst lazy = () => import('./lazy.mjs');\nimport fs from 'node:fs';",
    'app/state.mjs': "export * from '/review-core.mjs';\nexport const a = 1;",
    'parse.mjs': 'export const p = 1;',
    'review-core.mjs': 'export const r = 1;',
    'app/lazy.mjs': 'export const l = 1;',
  });
  try {
    assert.deepEqual(await modulePreloads(['/app/main.mjs'], site.publicDir), ['/app/state.mjs', '/parse.mjs', '/review-core.mjs']);
  } finally {
    await site.cleanup();
  }
});

test('base.css declares one palette for the page and a complete paper palette for the slip', async () => {
  const css = (await readFile(path.join(WEB_DIR, 'public', 'css', 'base.css'), 'utf8')).replace(/\r\n/g, '\n');
  const names = (block) => [...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1]).sort();

  const page = css.match(/\n:root,\n\.theme-dark \{([\s\S]*?)\n\}/);
  const paper = css.match(/\n\.theme-light \{([\s\S]*?)\n\}/);
  assert.ok(page && paper, 'both palettes are present');
  assert.ok(names(page[1]).length > 50);
  // Whatever lies on paper finds every colour it asks for.
  assert.deepEqual(names(paper[1]), names(page[1]));
  assert.match(page[1], /color-scheme: dark;/);
  assert.match(page[1], /--bg: #09090a;/);
  // The site has one look: nothing follows the system's scheme or a stored choice.
  for (const name of ['base.css', 'home.css', 'workbench.css', 'benchmark.css', 'landing.css', 'docs.css', 'tools.css', 'templates.css', 'account.css', 'runners.css', 'kit.css']) {
    const sheet = await readFile(path.join(WEB_DIR, 'public', 'css', name), 'utf8');
    assert.doesNotMatch(sheet, /prefers-color-scheme|\[data-theme/, name);
  }
  // The theme colour in the head is the page's own.
  assert.equal(SITE.themeColor.dark, '#09090a');
});

test('stackTable writes the column name into every cell after the first and takes two modifiers', () => {
  const columns = [{ label: 'Result' }, { label: 'Meaning' }, { label: 'What to do' }];
  const rows = [['Match', 'The hashes agree.', 'Nothing.']];

  const plainTable = stackTable({ caption: 'Results', columns, rows }).toString();
  assert.match(plainTable, /^<div class="table-wrap" tabindex="0" role="region" aria-label="Results"><table class="table stack-table">/);
  assert.match(plainTable, /<th scope="row">Match<\/th><td><span class="cell-label">Meaning<\/span>The hashes agree\.<\/td><td><span class="cell-label">What to do<\/span>Nothing\.<\/td>/);

  assert.match(stackTable({ columns, rows, plain: true, className: 'tool-table' }).toString(), /<table class="table stack-table stack-table--plain tool-table">/);
  assert.match(stackTable({ columns, rows, wide: true, dense: true }).toString(), /<table class="table table--dense stack-table stack-table--wide">/);
  // A cell is escaped like any other interpolated value.
  assert.match(stackTable({ columns, rows: [['a', '<b>', 'c']] }).toString(), /<span class="cell-label">Meaning<\/span>&lt;b&gt;/);
});

test('the stack table rules live in base.css once, and the scrolling wrap contains what it scrolls', async () => {
  const cssDir = path.join(WEB_DIR, 'public', 'css');
  const read = async (name) => (await readFile(path.join(cssDir, name), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const base = await read('base.css');

  const wrap = base.match(/\n\.table-wrap \{([^}]*)\}/);
  assert.ok(wrap, '.table-wrap is defined in base.css');
  assert.match(wrap[1], /position: relative;/);
  assert.match(wrap[1], /overflow-x: auto;/);

  assert.match(base, /\n\.stack-table \.cell-label \{\s*display: none;\s*\}/);
  assert.match(base, /@media \(max-width: 43\.99em\) \{\s*\.table-wrap > \.table\.stack-table,/);
  assert.match(base, /\.stack-table--plain \.cell-label \{\s*display: none;/);
  assert.match(base, /\.table-wrap > \.table\.stack-table--wide tbody tr \{\s*display: grid;/);

  // No page stylesheet repeats the mechanism: how a stacked row lays out and when its labels show.
  for (const name of ['tools.css', 'templates.css', 'landing.css', 'docs.css', 'home.css']) {
    const css = await read(name);
    assert.doesNotMatch(css, /\.cell-label\b/, `${name}: the cell labels are styled in base.css`);
    assert.doesNotMatch(css, /\.stack-table[^{]*thead/, `${name}: the header row is hidden in base.css`);
    assert.doesNotMatch(css, /\.stack-table[^{]*\{[^}]*display: block/, `${name}: stacking is defined in base.css`);
    assert.doesNotMatch(css, /\.tool-wrap\b/, `${name}: the wrap needs no workaround`);
  }

  const { outputs } = await renderSite();
  for (const [file, markup] of outputs) {
    assert.doesNotMatch(markup, /tool-wrap/, file);
    // Every stacked table carries the labels its stylesheet shows.
    for (const table of markup.matchAll(/<table class="table[^"]*\bstack-table\b[^"]*">[\s\S]*?<\/table>/g)) {
      assert.match(table[0], /<span class="cell-label">/, file);
    }
  }
  assert.doesNotMatch(await readFile(path.join(WEB_DIR, 'public', 'tools', 'slither-focus.mjs'), 'utf8'), /tool-wrap/);
});

test('the pages DESIGN owns render without errors', async () => {
  const { errors, outputs } = await renderSite({ dev: true });
  const own = errors.filter((message) => /^(404|_kit)\.mjs/.test(message));
  assert.deepEqual(own, []);
  if (errors.length === 0) {
    assert.match(outputs.get('404.html'), /<header class="page-head page-field">\s*<h1>No page at this address\.<\/h1>/);
    assert.match(outputs.get('_kit.html'), /data-rail="observed"/);
  }
});

test('textOf leaves no tag behind when one tag is nested inside another', () => {
  const cases = [
    ['<scr<script>ipt>alert(1)</scr</script>ipt>', /alert\(1\)/],
    // Removing the inline tag would join the pieces into a whole <script> tag.
    ['<sc<b>ript>alert(2)</sc</b>ript>', /alert\(2\)/],
    ['<<script>script>alert(3)<</script>/script>', /alert\(3\)/],
    ['<a<a href="/x">>link</a</a>>', /link/],
    ['<p>Call <code>run_review</code>.</p><p>Then <strong>stop</strong>.</p>', /^Call run_review\. Then stop\.$/],
  ];
  for (const [markup, keeps] of cases) {
    const text = textOf(raw(markup));
    assert.doesNotMatch(text, /</, markup);
    assert.match(text, keeps, markup);
  }
  // An inline tag joins its text to the words around it; a tag whose name only starts like one is a word break.
  assert.equal(textOf(raw('a<b>b</b>c<article>d</article>e<a-chip>f</a-chip>g<br>h<CODE>i</CODE>j')), 'abc d e f g hij');
  // A tag that never closes takes the rest with it, so no "<" is left to open one.
  assert.equal(textOf(raw('before <script src="x" after')), 'before');
  assert.equal(textOf(raw('1 < 2 and 3 > 2')), '1 2');
  // Escaped text is not markup: it comes back as the characters the author wrote.
  assert.equal(textOf(html`${'a <script> b'}`), 'a <script> b');
  assert.equal(textOf(html`${'1 < 2 and 3 > 2'}`), '1 < 2 and 3 > 2');
});

test('the moving field draws nothing per frame, and holds still when less motion is asked for', async () => {
  const source = await readFile(path.join(WEB_DIR, 'public', 'field.mjs'), 'utf8');
  // No frame loop: the text and the shade are drawn once, and the browser moves the shade.
  assert.doesNotMatch(source, /requestAnimationFrame|setInterval/);
  assert.match(source, /for \(const host of document\.querySelectorAll\('\.page-field'\)\) field\(host\);/);
  // It follows the page's motion switch, and hears when the switch is pressed.
  assert.match(source, /document\.documentElement\.dataset\.motion === 'on'/);
  assert.match(source, /document\.addEventListener\('motionchange', sync\)/);
  assert.doesNotMatch(source, /prefers-reduced-motion/);
  assert.match(source, /root\.setAttribute\('aria-hidden', 'true'\)/);
  // It reads nothing from the page and keeps nothing in the browser.
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\(|XMLHttpRequest|cookie/);

  const css = (await readFile(path.join(WEB_DIR, 'public', 'css', 'base.css'), 'utf8')).replace(/\r\n/g, '\n');
  const start = css.indexOf('/* The moving field (/field.mjs)');
  const block = css.slice(start, css.indexOf('/* Long-form pages', start));
  assert.ok(start > 0 && block.length > 500);
  // The shade moves by a transform, and only when motion is welcome.
  assert.match(block, /\n:root\[data-motion="on"\] \.field-bg__shade \{\n  animation: field-drift \d+s linear infinite;/);
  const frames = block.slice(block.indexOf('@keyframes field-drift'), block.indexOf(':root[data-motion="on"] .field-bg__shade'));
  const moved = [...frames.matchAll(/\n\s+([a-z-]+): /g)].map((match) => match[1]);
  assert.ok(moved.length >= 5);
  assert.deepEqual([...new Set(moved)], ['transform']);
  // Nothing in the field uses a mask, a filter or a group opacity: a frame costs the compositor one picture.
  const rules = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /mask|filter:|backdrop/);
  assert.ok(rules.includes('.field-bg {'));
  assert.doesNotMatch(rules.slice(rules.indexOf('.field-bg {'), rules.indexOf('}', rules.indexOf('.field-bg {'))), /opacity/);
  // No field on paper or in forced colours.
  assert.match(block, /@media \(forced-colors: active\), print \{\n  \.field-bg \{\n    display: none;/);
});

test('a part that rises on scroll is visible wherever the browser cannot drive it', async () => {
  const css = (await readFile(path.join(WEB_DIR, 'public', 'css', 'base.css'), 'utf8')).replace(/\r\n/g, '\n');
  // The hidden starting state exists only inside the keyframes, and the keyframes are used only
  // under a scroll-driven timeline with motion welcome.
  assert.match(css, /@media screen \{\n  @supports \(animation-timeline: view\(\)\) \{\n    :root\[data-motion="on"\] \.rise \{\n      animation: rise-in linear both;\n      animation-timeline: view\(\);/);
  assert.equal(css.split('animation: rise-in ').length - 1, 1);
  assert.equal(css.split('@keyframes rise-in {').length - 1, 1);
  assert.doesNotMatch(css, /\.rise \{[^}]*opacity: 0/);
});

test('the moving field takes no class name that a page, a component or the app already uses', async () => {
  // 0.9.0 named the field's root .field, the class of the form field wrapper, and its rules
  // (absolute, hidden until built) hid the model, key and sign-in fields for 17 minutes.
  const { readdir } = await import('node:fs/promises');
  const source = await readFile(path.join(WEB_DIR, 'public', 'field.mjs'), 'utf8');
  const made = [...source.matchAll(/\.className = '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(made.sort(), ['field-bg', 'field-bg__fade', 'field-bg__shade', 'field-bg__strike', 'field-bg__text']);

  // Every class token in the built pages.
  const used = new Set();
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.html')) {
        for (const [, value] of (await readFile(file, 'utf8')).matchAll(/\sclass="([^"]*)"/g)) for (const name of value.split(/\s+/)) if (name) used.add(name);
      }
    }
  };
  await walk(path.join(WEB_DIR, 'public'));
  assert.ok(used.has('field'), 'the form field wrapper is on a page');
  assert.ok(used.has('page-field'));
  for (const name of made) assert.ok(!used.has(name), name + ' is already a class in a built page');

  // Every class the app scripts and the site's helpers write.
  const scripts = [];
  for (const dir of ['public/app', 'public/tools', 'public/benchmark', 'public/docs', 'public/templates', 'site', 'site/fragments']) {
    for (const name of await readdir(path.join(WEB_DIR, dir))) if (name.endsWith('.mjs')) scripts.push(path.join(WEB_DIR, dir, name));
  }
  for (const file of scripts) {
    const code = await readFile(file, 'utf8');
    for (const name of made) assert.ok(!new RegExp('[\'"\\s.]' + name + '[\'"\\s]').test(code), name + ' appears in ' + path.relative(WEB_DIR, file));
  }

  // In base.css each of its selectors lives in the field's own block and nowhere else,
  // and the form field wrapper keeps its one rule.
  const css = (await readFile(path.join(WEB_DIR, 'public', 'css', 'base.css'), 'utf8')).replace(/\r\n/g, '\n');
  const start = css.indexOf('/* The moving field (/field.mjs)');
  const end = css.indexOf('/* Long-form pages', start);
  const outside = css.slice(0, start) + css.slice(end);
  assert.doesNotMatch(outside, /\.field-bg/);
  assert.equal(css.split('\n.field {').length - 1, 1);
  assert.doesNotMatch(css.slice(start, end), /\.field[ \[{,]/);
  for (const name of ['home.css', 'workbench.css', 'account.css', 'tools.css', 'landing.css', 'docs.css', 'templates.css', 'benchmark.css', 'runners.css']) {
    assert.doesNotMatch(await readFile(path.join(WEB_DIR, 'public', 'css', name), 'utf8'), /\.field-bg/, name);
  }
});


test('the motion switch: on unless the system asks for less, and the visitor\'s choice wins', async () => {
  const vm = await import('node:vm');
  const source = await readFile(path.join(WEB_DIR, 'public', 'theme.js'), 'utf8');

  /** Runs theme.js in a page that asks for less motion or not, with or without a stored choice. */
  const page = ({ less, stored = null, storage = true }) => {
    const attributes = new Map();
    const store = new Map(stored ? [['bo-motion', stored]] : []);
    const listeners = new Map();
    const events = [];
    const button = { hidden: true, textContent: 'Pause motion', querySelector: () => null, closest: (selector) => (selector === '[data-motion-toggle]' ? button : null) };
    const media = { matches: less, listeners: [], addEventListener(type, handler) { this.listeners.push(handler); } };
    const document = {
      documentElement: { setAttribute: (name, value) => attributes.set(name, value), getAttribute: (name) => attributes.get(name) ?? null },
      querySelectorAll: (selector) => (selector === '[data-motion-toggle]' ? [button] : []),
      querySelector: () => null,
      addEventListener: (type, handler) => listeners.set(type, handler),
      dispatchEvent: (event) => events.push(event.type + ':' + event.detail.motion),
    };
    const localStorage = storage
      ? { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) }
      : { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    const window = { localStorage, matchMedia: () => media, addEventListener() {}, setTimeout };
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
    vm.runInNewContext(source, { window, document, navigator: {}, CustomEvent });
    return {
      motion: () => attributes.get('data-motion'),
      press: () => listeners.get('click')({ target: button }),
      ready: () => listeners.get('DOMContentLoaded')(),
      system: (value) => { media.matches = value; for (const handler of media.listeners) handler(); },
      stored: () => store.get('bo-motion') ?? null,
      button,
      events,
    };
  };

  // The attribute is set as the script runs, before anything is painted.
  assert.equal(page({ less: false }).motion(), 'on');
  assert.equal(page({ less: true }).motion(), 'off');
  // A stored choice wins over the system, both ways.
  assert.equal(page({ less: true, stored: 'on' }).motion(), 'on');
  assert.equal(page({ less: false, stored: 'off' }).motion(), 'off');
  // Anything else in the key is not a choice.
  assert.equal(page({ less: false, stored: 'yes' }).motion(), 'on');

  // A system that asks for less motion: the button offers to play, and pressing it plays and remembers.
  const quiet = page({ less: true });
  quiet.ready();
  assert.equal(quiet.button.hidden, false);
  assert.equal(quiet.button.textContent, 'Play motion');
  quiet.press();
  assert.equal(quiet.motion(), 'on');
  assert.equal(quiet.stored(), 'on');
  assert.equal(quiet.button.textContent, 'Pause motion');
  assert.deepEqual(quiet.events, ['motionchange:on']);
  // Pressing again goes back to what the system asks for, and keeps nothing.
  quiet.press();
  assert.equal(quiet.motion(), 'off');
  assert.equal(quiet.stored(), null);
  assert.deepEqual(quiet.events, ['motionchange:on', 'motionchange:off']);

  // A system with motion: Pause stops it and is remembered.
  const lively = page({ less: false });
  lively.ready();
  assert.equal(lively.button.textContent, 'Pause motion');
  lively.press();
  assert.equal(lively.motion(), 'off');
  assert.equal(lively.stored(), 'off');

  // With no choice stored the page follows a change of the system setting; with one, it does not.
  const follows = page({ less: false });
  follows.system(true);
  assert.equal(follows.motion(), 'off');
  const chosen = page({ less: false, stored: 'off' });
  chosen.system(false);
  assert.equal(chosen.motion(), 'off');

  // Storage blocked: the page still follows the system, and a press still works for this page.
  const blocked = page({ less: true, storage: false });
  assert.equal(blocked.motion(), 'off');
  blocked.press();
  assert.equal(blocked.motion(), 'on');
});

test('every animation and transition of motion in the stylesheets waits for the motion switch', async () => {
  const { readdir } = await import('node:fs/promises');
  const dir = path.join(WEB_DIR, 'public', 'css');
  // Working indicators say that something is happening; they stay, and are stilled by the rule below.
  const INDICATORS = [/spinner/, /aria-busy/, /\.progress/, /\.skeleton/, /data-status="running"/, /\.code__copy/];
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith('.css'))) {
    const css = (await readFile(path.join(dir, name), 'utf8')).replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /prefers-reduced-motion/, name + ' still asks the system directly');
    const rules = css.replace(/@keyframes [^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    for (const [, selector, body] of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(?:^|[\s;])animation(?:-name)?:\s*(?!none)/.test(body)) continue;
      const each = selector.trim();
      if (each.startsWith('@')) continue;
      if (INDICATORS.some((pattern) => pattern.test(each))) continue;
      for (const part of each.split(/,(?![^(]*\))/)) assert.match(part.trim(), /^:root\[data-motion="on"\]/, name + ': ' + part.trim() + ' animates without the switch');
    }
  }
  // With motion off every animation and transition is cut to nothing, whatever started it.
  const base = (await readFile(path.join(dir, 'base.css'), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(base, /\n:root:not\(\[data-motion="on"\]\) \*,\n:root:not\(\[data-motion="on"\]\) \*::before,\n:root:not\(\[data-motion="on"\]\) \*::after \{\n  scroll-behavior: auto !important;\n  transition-duration: 0\.01ms !important;\n  animation-duration: 0\.01ms !important;\n  animation-iteration-count: 1 !important;\n\}/);
});

test('every page carries the motion button, hidden until the script labels it', () => {
  const page = { path: '/x', title: 'X page | Bounty Operator', description: 'A description that is comfortably longer than the fifty character minimum.', body: html`<h1>X</h1>`};
  const markup = renderPage(page, { has: () => false, pages: [page], preloadsFor: () => [] });
  assert.equal([...markup.matchAll(/<button class="motion-toggle" type="button" data-motion-toggle hidden>Pause motion<\/button>/g)].length, 1);
  assert.ok(markup.indexOf('data-motion-toggle') > markup.indexOf('class="site-footer'));
});
