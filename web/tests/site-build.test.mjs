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
import { breadcrumbsLd, faqPageLd, renderPage, softwareApplicationLd } from '../site/layout.mjs';

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
  const shared = ['index.html', 'guide.html', 'mcp.html', 'tools.html', 'privacy.html', 'terms.html', 'theme.js', 'favicon.ico', 'icon.svg', 'apple-touch-icon.png', 'site.webmanifest', 'css/base.css'];
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
  assert.match(markup, /<meta property="og:image" content="https:\/\/bountyoperator\.com\/social-v4\.png">/);
  assert.match(markup, /<meta name="twitter:card" content="summary_large_image">/);
  // The builder's handle credits the card. The product has no X account, so there is no twitter:site.
  assert.equal([...markup.matchAll(/<meta name="twitter:creator" content="@Tradi3_">/g)].length, 1);
  assert.doesNotMatch(markup, /twitter:site/);
  assert.doesNotMatch(markup, /href="https?:\/\/(?:www\.)?(?:x|twitter)\.com/, 'no visible X link');
  assert.match(markup, /<meta name="color-scheme" content="dark light">/);
  assert.equal([...markup.matchAll(/<meta name="theme-color"/g)].length, 2);
  assert.match(markup, /<script src="\/theme\.js"><\/script>/);
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
  assert.match(markup, /Built by <a href="https:\/\/audits\.sherlock\.xyz\/watson\/Tradi3"/);
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

test('the two dark token blocks in base.css are identical', async () => {
  const css = await readFile(path.join(WEB_DIR, 'public', 'css', 'base.css'), 'utf8');
  const declarations = (block) => block.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('--') || line.startsWith('color-scheme'));

  const fromMedia = css.match(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const fromAttribute = css.match(/:root\[data-theme="dark"\],\n\.theme-dark \{([\s\S]*?)\n\}/);
  assert.ok(fromMedia && fromAttribute, 'both dark blocks are present');
  assert.ok(declarations(fromMedia[1]).length > 30);
  assert.deepEqual(declarations(fromAttribute[1]), declarations(fromMedia[1]));
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
    assert.match(outputs.get('404.html'), /<h1 class="finding__title" id="not-found-title">No page at this address\.<\/h1>/);
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
