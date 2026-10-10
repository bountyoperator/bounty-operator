// One frame for every page: how it opens, and how it closes.
//
// A page family that keeps its own copy of the page head drifts from the
// others the first time one copy changes: the heading starts at a different
// height, the buttons are a different size, the last block is a different
// colour. The head and the closing band are built and styled in one place,
// and these tests hold every page to them.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderSite } from '../../scripts/build-site.mjs';
import { closingBand } from '../site/components.mjs';

const CSS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'css');
const HOME = 'index.html';

/** Every generated page, as [file, markup]. */
async function pages() {
  const { errors, outputs } = await renderSite();
  assert.deepEqual(errors, []);
  return [...outputs].filter(([file]) => file.endsWith('.html'));
}

/** The stylesheets, comments removed, as { name: text }. */
async function sheets() {
  const names = (await readdir(CSS_DIR)).filter((name) => name.endsWith('.css'));
  const texts = await Promise.all(names.map((name) => readFile(path.join(CSS_DIR, name), 'utf8')));
  return Object.fromEntries(names.map((name, index) => [name, texts[index].replace(/\/\*[\s\S]*?\*\//g, '')]));
}

/** Every style rule of a sheet, inside a media block or not: [{ selectors, declarations }]. */
function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    // A statement before the first rule (@charset) is not part of its selector.
    .map(([, prelude, body]) => ({ prelude: prelude.split(';').at(-1).trim(), body }))
    .filter(({ prelude }) => prelude && !prelude.startsWith('@'))
    .map(({ prelude, body }) => ({
      selectors: prelude.split(',').map((selector) => selector.trim()),
      declarations: body.split(';').map((line) => line.trim()).filter(Boolean).map((line) => line.slice(0, line.indexOf(':')).trim()),
    }));
}

/** The class lists of every button in a piece of markup. */
function buttons(markup) {
  return [...markup.matchAll(/<(?:a|button)\b[^>]*\bclass="(btn(?: [^"]*)?)"/g)].map((match) => match[1].split(/\s+/));
}

test('every page opens on the shared head, and the home page on its own', async () => {
  for (const [file, markup] of await pages()) {
    assert.equal((markup.match(/<h1\b/g) ?? []).length, 1, `${file}: one h1`);
    const fields = [...markup.matchAll(/<(\w+) class="([^"]*\bpage-field\b[^"]*)">/g)];
    assert.equal(fields.length, 1, `${file}: one page head on the field`);
    const [open, , classes] = fields[0];
    if (file === HOME) {
      assert.equal(classes, 'home-top page-field', file);
      continue;
    }
    assert.match(classes, /^page-head page-field\b/, `${file}: the head is the shared one`);

    // Nothing stands between the head and its h1 but the trail and, on a head
    // with a second column, the two boxes that make the columns.
    const from = fields[0].index + open.length;
    const lead = markup.slice(from, markup.indexOf('<h1', from));
    assert.match(
      lead,
      /^\s*(?:<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>.*?<\/ol><\/nav>\s*)?(?:<div class="lp-hero__grid">\s*<div class="page-head__text [^"]*">\s*)?$/s,
      `${file}: the trail, then the h1`,
    );
    assert.match(markup.slice(from), /^[\s\S]*?<h1>[\s\S]*?<\/h1>/, `${file}: the h1 carries no class of its own`);
  }
});

test('the actions of a page head are one row of large boxes on every page', async () => {
  let rows = 0;
  for (const [file, markup] of await pages()) {
    if (file === HOME) continue;
    const from = markup.search(/class="page-head page-field/);
    const head = markup.slice(from, markup.indexOf('</h1>', from));
    assert.doesNotMatch(head, /class="btn\b/, `${file}: no action above the h1`);
    for (const row of markup.matchAll(/<div class="cluster page-head__actions">([\s\S]*?)<\/div>/g)) {
      rows += 1;
      const boxes = buttons(row[1]);
      assert.ok(boxes.length > 0, `${file}: the action row holds a button`);
      for (const box of boxes) assert.ok(box.includes('btn--lg'), `${file}: ${box.join('.')} is the large box`);
    }
    assert.doesNotMatch(markup, /(?:docs-head|tpl-hero|lp-hero)__actions|tpl-actions"/, `${file}: the old action rows are gone`);
  }
  assert.ok(rows >= 15, `${rows} action rows found`);
});

test('a page that ends on a call to action ends on the shared closing band', async () => {
  const withBand = [];
  for (const [file, markup] of await pages()) {
    assert.doesNotMatch(markup, /\b(?:cta-band|docs-next|tool-next|tpl-cta)\b/, `${file}: the old bands are gone`);
    const bands = [...markup.matchAll(/<section class="closing-band" aria-labelledby="next-step">([\s\S]*?)<\/section>/g)];
    assert.equal((markup.match(/\bclosing-band"/g) ?? []).length, bands.length, `${file}: every band is the builder's`);
    assert.ok(bands.length <= 1, `${file}: one closing band at most`);
    if (bands.length === 0) continue;
    withBand.push(file);
    const [, inside] = bands[0];
    assert.match(inside, /^\s*<div class="closing-band__text"><h2 class="closing-band__title" id="next-step">[^<]+<\/h2>/, file);
    const boxes = buttons(inside);
    assert.ok(boxes.length >= 1 && boxes.length <= 3, `${file}: one to three actions`);
    assert.ok(boxes[0].includes('btn--primary'), `${file}: the first action is the solid one`);
    for (const box of boxes) assert.ok(box.includes('btn--lg'), `${file}: ${box.join('.')} is the large box`);
    for (const box of boxes.slice(1)) assert.ok(box.includes('btn--secondary'), `${file}: the other actions are outlined`);
    assert.doesNotMatch(inside, /\bon-stock\b/, `${file}: the band is not printed on vermilion`);
  }
  // Every tool page and every landing page with a review to start closes on one.
  for (const file of ['tools.html', 'tools/report-check.html', 'tools/verify.html', 'gauntlet.html', 'compare.html', 'guide.html', 'mcp.html', 'templates.html']) {
    assert.ok(withBand.includes(file), `${file} ends on the closing band`);
  }
});

test('closingBand builds its own boxes: the first solid, all of them large', () => {
  const band = closingBand({
    title: 'Now your own draft',
    text: 'Run a review.',
    actions: [{ label: 'Review my report', href: '/#workspace' }, { label: 'Report guide', href: '/guide', variant: 'primary', size: 'sm' }],
    note: 'Free: 1 review a day.',
  }).toString();
  const [first, second] = buttons(band);
  assert.deepEqual(first, ['btn', 'btn--primary', 'btn--lg']);
  assert.deepEqual(second, ['btn', 'btn--secondary', 'btn--lg']);
  assert.match(band, /<a class="btn btn--primary btn--lg" href="\/#workspace">.*icon--arrow-right/);
  assert.match(band, /<p class="closing-band__lede">Run a review\.<\/p>/);
  assert.match(band, /<p class="fine">Free: 1 review a day\.<\/p>/);
  assert.throws(() => closingBand({ title: 'No actions' }), /at least one action/);
  assert.throws(() => closingBand({ actions: [{ label: 'Go', href: '/' }] }), /a title/);
});

test('the head and the closing band are styled in base.css and nowhere else', async () => {
  const all = await sheets();
  const base = all['base.css'];
  assert.match(base, /\n\.page-head,\n\.page-head__text \{[^}]*gap: var\(--sp-16\);/);
  assert.match(base, /\n\.page-head \{\s*padding-block: var\(--sp-32\) var\(--sp-48\);\s*\}/);
  assert.match(base, /\n\.page-head h1 \{\s*max-width: 12\.29em;\s*\}/);
  assert.match(base, /\n\.closing-band \{[^}]*background: var\(--surface-2\);/);

  for (const [name, css] of Object.entries(all)) {
    // The copies each page family used to keep.
    assert.doesNotMatch(css, /\.(?:docs-head|tpl-hero|cta-band|docs-next|tool-next|tpl-cta)(?:_|\b)|\.tpl-actions(?![\w-])/, `${name}: an old head or band is styled`);
    if (name === 'base.css') continue;

    for (const { selectors, declarations } of rules(css)) {
      for (const selector of selectors) {
        const where = `${name}: ${selector}`;
        assert.doesNotMatch(selector, /\.page-head\b/, `${where} restates the page head`);
        assert.doesNotMatch(selector, /\.closing-band__/, `${where} restyles the closing band`);
        // A page may say how far below its body the band stands, and nothing else.
        if (/\.closing-band\b/.test(selector)) assert.deepEqual(declarations, ['margin-top'], where);
        // A family class on the head may say how far below it the page goes on, and nothing else.
        if (/\.(?:lp-hero|tool-head)$/.test(selector)) assert.deepEqual(declarations, ['margin-bottom'], where);
        // Nothing reaches into the head to move its parts.
        assert.doesNotMatch(selector, /\.(?:lp-hero|tool-head)\s+(?:h1|\.lede|\.breadcrumbs)\b|\.lp-hero__text\s*>\s*(?:\*|h1|\.lede)/, `${where} moves a part of the head`);
      }
    }
  }
});

test('one head rule sets where the heading starts, at both widths', async () => {
  const { 'base.css': base } = await sheets();
  // The only places a page head gets its top and bottom room.
  const padded = rules(base).filter(({ selectors, declarations }) => selectors.some((selector) => /^\.page-head$/.test(selector)) && declarations.some((name) => name.startsWith('padding')));
  assert.equal(padded.length, 2, 'the rule, and its one step up at 48em');
  assert.match(base, /@media \(min-width: 48em\) \{\s*\.page-head \{\s*padding-top: var\(--sp-48\);\s*\}\s*\}/);
});

// The one page of the visit the site does not draw: Stripe's. It takes two colours from us,
// and they were left on the palette of an earlier design once already.
test('the payment page is printed in the paper palette of the site', async () => {
  const { 'base.css': base } = await sheets();
  const billing = await readFile(path.resolve(CSS_DIR, '..', '..', 'src', 'billing.ts'), 'utf8');
  const colours = /branding_settings: \{ display_name: 'Bounty Operator', background_color: '(#[0-9a-f]{6})', button_color: '(#[0-9a-f]{6})' \}/.exec(billing);
  assert.ok(colours, 'the Checkout session sets its two colours');
  const paper = /\n\.theme-light \{([^}]*)\}/.exec(base)[1];
  const token = (name) => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(paper)?.[1];
  assert.equal(colours[1], token('bg'), 'the ground is the paper');
  assert.equal(colours[2], token('accent-solid'), 'the box is the solid action on paper');
});
