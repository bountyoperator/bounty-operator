// Tests for the home page (web/site/pages/index.mjs), the rendered example it
// shares with the social card (web/site/social), and the hooks other streams
// rely on.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanTags, validateMarkup } from '../../scripts/build-site.mjs';
import { renderPage } from '../site/layout.mjs';
import home from '../site/pages/index.mjs';
import { IMMUNEFI } from '../site/pages/method/_shared.mjs';
import { CARD, cardDocument } from '../site/social/card.mjs';
import { reportSlip } from '../site/social/example.mjs';
import { EXAMPLES } from '../public/example.mjs';
import { PROFILES } from '../public/profiles.mjs';
import { PROVIDERS } from '../public/providers.mjs';
import { checkRefs, parseReview } from '../public/parse.mjs';
import { manifestFor } from '../public/review-core.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const site = { pages: [home], has: () => true, preloadsFor: () => [] };
const markup = renderPage(home, site);
const tags = scanTags(markup);
// The workbench and the dialogs are fragments owned by the app; their copy is tested there.
const main = markup.slice(markup.indexOf('<main'), markup.indexOf('</main>'));
const own = main.replace(/<section[^>]*\sid="workspace"[\s\S]*?<\/section>/, ' ');

function textOf(source) {
  return source
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const find = (name, test) => tags.filter((tag) => tag.name === name && (!test || test(tag.attributes)));

test('the home page passes the generator checks and has one h1', () => {
  const { errors, warnings } = validateMarkup(markup, () => true);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(home.path, '/');
  assert.equal(find('h1').length, 1);
});



test('the proof strip links the three leaderboards and the method', async () => {
  // Each link is parsed and compared whole: origin and path, not a substring of the href.
  const links = find('a').map((tag) => new URL(tag.attributes.get('href'), 'https://bountyoperator.com'));
  const linksTo = (origin, pathname) => links.some((url) => url.origin === origin && url.pathname === pathname && url.search === '' && url.hash === '');
  for (const board of ['audit-comp-firelight-1', 'audit-comp-quantus', 'audit-competition-ens']) {
    assert.ok(linksTo('https://immunefi.com', `/audit-competition/${board}/leaderboard/`), `no link to the ${board} leaderboard`);
  }
  assert.ok(linksTo('https://bountyoperator.com', '/method'));
  const text = textOf(own);
  assert.match(text, /Built by\s+Tradi3/);
  // One wording for the ENS result on every short proof line.
  assert.match(text, /17 valid Critical submissions in Immunefi’s ENS competition, the most of 186 researchers/);
  assert.doesNotMatch(text, /including duplicates|Critical-rated|listed researchers/);
  assert.match(text, /2nd of 133/);
  // The same count wherever the result is stated: 133 is the board's last rank (two more rows are disqualified).
  for (const file of ['public/guide.html', 'public/method.html', 'public/gauntlet.html', 'public/llms.txt', '../README.md', '../docs/public-results.md']) {
    const stated = await readFile(path.join(WEB_DIR, file), 'utf8');
    assert.match(stated, /2nd of 133/, file);
    assert.doesNotMatch(stated, /2nd of 135/, file);
    // The all-time rank moves from day to day: wherever it is printed, the profile it was read
    // from is linked and the day it was read stands beside the number.
    assert.ok(stated.includes(IMMUNEFI.profile), `${file}: the Immunefi profile is linked`);
    const mentions = [...stated.matchAll(new RegExp(`\\b${IMMUNEFI.rank}\\b`, 'g'))];
    assert.ok(mentions.length >= 1, `${file}: the all-time rank is stated`);
    for (const mention of mentions) {
      assert.ok(stated.slice(mention.index, mention.index + 160).includes(IMMUNEFI.readOn), `${file}: the rank is given with the day it was read`);
    }
  }
  assert.match(text, /8th of 65/);
  assert.ok(linksTo('https://immunefi.com', '/profile/Tradi3/'), 'no link to the Immunefi profile');
  assert.match(text, new RegExp(`${IMMUNEFI.badge} on Immunefi\\s*: ${IMMUNEFI.rank} on its all-time leaderboard on ${IMMUNEFI.readOn}\\.`));
});

test('pricing states the two plans and the monthly included API credit', () => {
  const pricing = main.slice(main.indexOf('id="pricing"'), main.indexOf('id="faq"'));
  const text = textOf(pricing);
  assert.match(text, /US\$0/);
  assert.match(text, /US\$10 per month/);
  assert.match(text, /Unlimited reviews, 4 at once/);
  assert.match(text, /1 review a day/);
  assert.match(text, /Start a free review/);
  assert.match(text, /Get Operator/);
  assert.match(text, /US\$2 in Bounty Operator API credit per paid month/);
  assert.doesNotMatch(text, /trial|discount|per week|\/wk\b|coupon/i);
  const amounts = [...textOf(own).matchAll(/US\$\d+/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(amounts)].sort(), ['US$0', 'US$10', 'US$2']);
});

test('every provider the engine supports is named', () => {
  const text = textOf(own);
  for (const provider of PROVIDERS) assert.ok(text.includes(provider.label), provider.label);
});

test('structured data: organization, the two offers, and an FAQ that matches the visible text', () => {
  const types = home.jsonld.map((entry) => entry['@type']);
  assert.deepEqual(types, ['WebSite', 'Organization', 'SoftwareApplication', 'FAQPage']);
  // The name a search engine prints for the site, with the spellings that mean the same site.
  assert.deepEqual([home.jsonld[0].name, home.jsonld[0].alternateName, home.jsonld[0].url], ['Bounty Operator', ['BountyOperator', 'bountyoperator.com'], 'https://bountyoperator.com/']);
  assert.deepEqual(home.jsonld[2].creator, {
    '@type': 'Person',
    name: 'Tradi3',
    url: 'https://immunefi.com/profile/Tradi3/',
    sameAs: ['https://audits.sherlock.xyz/watson/Tradi3', 'https://x.com/Tradi3_'],
  });
  const offers = home.jsonld[2].offers.map((offer) => [offer.name, offer.price]);
  assert.deepEqual(offers, [['Free', '0'], ['Operator', '10.00']]);

  const faq = home.jsonld[3].mainEntity;
  assert.equal(faq.length, 5);
  // A link that follows the last sentence of an answer is not part of the answer a search engine quotes.
  for (const entry of faq) assert.doesNotMatch(entry.acceptedAnswer.text, /(?:Pricing|Model options|Privacy details|Refund terms)$/, entry.name);
  assert.equal(faq[0].name, 'I already pay for my model. Why pay for this?');
  const visible = textOf(main.slice(main.indexOf('id="faq"')));
  for (const entry of faq) {
    assert.ok(visible.includes(entry.name), entry.name);
    assert.ok(visible.includes(entry.acceptedAnswer.text), `answer to "${entry.name}"`);
  }
});

test('the copy carries no hedges, no third-party method names and no personal name', () => {
  // The source excerpt in the hero is code from the example's contract, not copy.
  const text = textOf(own.replace(/<pre[\s\S]*?<\/pre>/g, ' '));
  const banned = [
    /\bmay\b/i, /\bmight\b/i, /can help/i, /not a guarantee/i, /\bcannot\b/i, /this is not an audit/i, /\bsimply\b/i, /\bpowerful\b/i,
    /!/,
  ];
  for (const pattern of banned) assert.doesNotMatch(text, pattern);
  // Names that must stay out are read from lists git ignores (./private-lists.mjs): a pattern here would publish the name it guards.
  assertNoBannedNames(text, 'the home page', { page: '/' });
  // One em dash is allowed: the one in the <title>. None in the body copy.
  assert.doesNotMatch(text, /—/);
});

test('no markup the CSP would block, and no .html links', () => {
  assert.equal(tags.filter((tag) => tag.attributes.has('style')).length, 0);
  assert.equal(find('style').length, 0);
  for (const tag of find('a')) assert.doesNotMatch(tag.attributes.get('href') ?? '', /\.html(?:$|[?#])/);
});

for (const example of EXAMPLES) {
  test(`the ${example.id} slip shows the saved verdict, draft and cited source`, async () => {
    const slip = String(reportSlip({ exampleId: example.id, still: true }));
    const manifest = await manifestFor(example.files);
    const parsed = parseReview(example.review, { labels: manifest.map((entry) => entry.label) });
    assert.equal(parsed.ok, true);
    assert.deepEqual(checkRefs(parsed, manifest), []);
    const finding = parsed.findings[0];
    const draft = example.files.find((file) => /draft/i.test(file.name)).content;
    const title = /^#\s+(.+)$/m.exec(draft)[1].trim();
    const claimed = /^Severity:\s*(\w+)/im.exec(draft)[1].toLowerCase();
    assert.ok(textOf(slip).includes(title));
    assert.ok(textOf(slip).includes(parsed.headline));
    assert.ok(textOf(slip).includes(example.model));
    assert.match(slip, new RegExp(`class="slip__supported"><span class="chip sev sev--stamp" data-sev="${finding.severity}"`));
    assert.match(slip, new RegExp(`data-verdict="${parsed.verdict}"`));
    assert.match(slip, /data-status="example"/);
    assert.match(slip, /home-shot--still/);
    assert.match(textOf(slip), /Saved example\..+is an invented protocol\./);
    if (claimed === finding.severity) {
      assert.doesNotMatch(slip, /<s\b|slip__claimed/);
    } else {
      assert.match(slip, new RegExp(`<s class="slip__claimed"><span class="chip sev" data-sev="${claimed}"`));
    }

    const location = finding.locations[0];
    const file = example.files[manifest.findIndex((entry) => entry.label === location.label)];
    const lines = file.content.split('\n');
    const shown = [...slip.matchAll(/<span class="code__line[^"]*" data-n="(\d+)">([\s\S]*?)<\/span>/g)];
    assert.ok(shown.length > 0);
    for (const [, number, code] of shown) {
      assert.ok(Number(number) >= location.start && Number(number) <= location.end);
      assert.equal(textOf(code), textOf(lines[Number(number) - 1]));
    }
  });
}

test('unnamed slips stay Tessera, named Halyard shows Critical unchanged, and unknown IDs fail closed', () => {
  assert.equal(String(reportSlip()), String(reportSlip({ exampleId: 'critical-to-medium' })));
  const halyard = String(reportSlip({ exampleId: 'confirmed-critical', still: true }));
  assert.match(textOf(halyard), /Halyard Treasury/);
  assert.equal([...halyard.matchAll(/data-sev="critical"/g)].length, 2);
  assert.match(halyard, /data-verdict="submit"/);
  assert.ok(textOf(halyard).includes('if (isOwner[signer]) approvals++;'));
  assert.throws(() => reportSlip({ exampleId: 'missing-example' }), /unknown example/);
});

test('legacy verdict assets remain available without masking live verdict text', async () => {
  const { VERDICT_STAMPS, SEVERITY_STAMPS } = await import('../../scripts/build-stamps.mjs');
  const { VERDICT_LABELS } = await import('../public/app/dossier.mjs');
  const css = await readFile(path.join(WEB_DIR, 'public', 'css', 'base.css'), 'utf8');
  // The stamps say what the app prints, so the impression and the words in the markup agree.
  assert.deepEqual(Object.fromEntries(VERDICT_STAMPS), { ...VERDICT_LABELS });
  for (const [id] of VERDICT_STAMPS) {
    const file = `verdict-${id}.webp`;
    const bytes = await readFile(path.join(WEB_DIR, 'public', 'stamps', file));
    assert.equal(bytes.toString('latin1', 8, 12), 'WEBP', file);
    assert.ok(!css.includes(`url("../stamps/${file}")`), `live verdicts do not depend on ${file}`);
  }
  for (const [id] of SEVERITY_STAMPS) {
    const file = `sev-${id}.webp`;
    const bytes = await readFile(path.join(WEB_DIR, 'public', 'stamps', file));
    assert.equal(bytes.toString('latin1', 8, 12), 'WEBP', file);
    assert.ok(!css.includes(`url("../stamps/${file}")`), `live severity text does not depend on ${file}`);
  }
  assert.match(await readFile(path.join(WEB_DIR, 'public', 'stamps', 'strike.svg'), 'utf8'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  // No repeated noise tile stands in for ink.
  assert.doesNotMatch(css, /feTurbulence|--ink-grain/);
});

test('the stamps are pressed with real ink from the two CC0 scans, and no noise function', async () => {
  const scripts = path.join(WEB_DIR, '..', 'scripts');
  const sources = await readFile(path.join(scripts, 'ink', 'SOURCES.md'), 'utf8');
  for (const [file, sha1] of [
    ['Rubber_stamp_imprints_Czechia_GDR_1984.jpg', '29d54e0b6117ee1caafe54e4b6f5dc423abfc48d'],
    ['Rubber_stamps_state_retail_stores_Czechia_1984.jpg', '78630cf9c2c707aa6fcba0da4dd5d2676037246a'],
  ]) {
    assert.ok(sources.includes(`https://commons.wikimedia.org/wiki/File:${file}`), file);
    assert.ok(sources.includes(sha1), `${file} SHA-1`);
  }
  assert.match(sources, /CC0 1\.0/);
  // The extractor checks the scans against the same hashes before it reads them.
  const extractor = await readFile(path.join(scripts, 'extract-ink.py'), 'utf8');
  assert.ok(extractor.includes('29d54e0b6117ee1caafe54e4b6f5dc423abfc48d') && extractor.includes('78630cf9c2c707aa6fcba0da4dd5d2676037246a'));
  // The derived ink the builder reads: a 32 x 12 grid of 16px patches and twelve 192 x 64 pressure rows.
  const png = async (file) => {
    const bytes = await readFile(path.join(scripts, 'ink', file));
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };
  assert.deepEqual(await png('patches.png'), { width: 32 * 16, height: 12 * 16 });
  assert.deepEqual(await png('pressure.png'), { width: 192, height: 12 * 64 });
  // Every texture comes from that ink: the builder has no noise of its own.
  const builder = await readFile(path.join(scripts, 'build-stamps.mjs'), 'utf8');
  assert.doesNotMatch(builder, /makeNoise|fbm\(|feTurbulence|Math\.sin\(.*seed/);
  assert.match(builder, /patches\.png/);
  assert.match(builder, /pressure\.png/);
});


test('the social card is a 1200 x 630 document using the shared Spec identity', async () => {
  assert.deepEqual(CARD, { width: 1200, height: 630 });
  const card = cardDocument();
  assert.match(card, /<html lang="en">/);
  assert.match(card, /brand\/spec-960\.webp/);
  assert.match(textOf(card), /Spec\. A bug with standards\./);
  assert.match(textOf(card), /bountyoperator\.com/);
  assert.doesNotMatch(card, /\sstyle="/);

  const png = await readFile(path.join(WEB_DIR, 'public', 'social-spec-v2.png'));
  assert.equal(png.readUInt32BE(16), CARD.width);
  assert.equal(png.readUInt32BE(20), CARD.height);
});

test('the three results are figures that link to their public leaderboards', () => {
  const start = main.indexOf('<ul class="home-stats">');
  assert.ok(start > 0, 'the figures are on the page');
  const list = main.slice(start, main.indexOf('</ul>', start));
  const items = [...list.matchAll(/<a class="home-stats__item" href="([^"]+)" target="_blank" rel="noopener noreferrer"><span class="home-stats__n">([^<]+)<\/span> <span class="home-stats__t">([^<]+)<\/span><\/a>/g)]
    .map((match) => [new URL(match[1]).origin, new URL(match[1]).pathname, match[2]]);
  assert.deepEqual(items, [
    ['https://immunefi.com', '/audit-competition/audit-competition-ens/leaderboard/', '17'],
    ['https://immunefi.com', '/audit-competition/audit-comp-firelight-1/leaderboard/', '2nd'],
    ['https://immunefi.com', '/audit-competition/audit-comp-quantus/leaderboard/', '8th'],
  ]);
});

test('each place on the benchmark strip carries a bar as long as its score', () => {
  const start = markup.indexOf('class="bench-teaser__list"');
  if (start < 0) return; // no published release: no strip
  const list = markup.slice(start, markup.indexOf('</ol>', start));
  const rows = [...list.matchAll(/<span class="bench-teaser__score num">([\d.]+)<span[\s\S]*?<svg class="bench-teaser__bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect x="([\d.]+)" width="([\d.]+)" height="4"\/><\/svg>/g)];
  assert.ok(rows.length >= 3);
  assert.equal(rows.length, list.split('<li class="bench-teaser__row">').length - 1, 'every row has its bar');
  for (const [, score, x, width] of rows) {
    // The bar is as long as the score printed beside it, to that figure's own rounding.
    assert.ok(Math.abs(Number(x) - Number(score)) <= 0.05, score + ' and ' + x);
    assert.ok(Math.abs(Number(x) + Number(width) - 100) < 0.011, x + ' + ' + width);
  }
});

test('every motion the home page adds runs only while the page\'s motion is on', async () => {
  const css = (await readFile(path.join(WEB_DIR, 'public', 'css', 'home.css'), 'utf8')).replace(/\r\n/g, '\n');
  // No rule of the page starts an animation without it.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes [\s\S]*?\n\}\n/g, '');
  let animated = 0;
  for (const [, selector] of rules.matchAll(/\n([^{}\n][^{}]*?) \{[^{}]*\n\s+animation:/g)) {
    animated += 1;
    assert.match(selector.trim(), /^:root\[data-motion="on"\] /, selector);
  }
  assert.equal(animated, 1, 'only the review strike remains animated');
  assert.doesNotMatch(css, /prefers-reduced-motion/);
  // The supporting figures remain legible in forced colours.
  assert.match(css, /@media \(forced-colors: active\) \{\n  \.home-stats__n \{\n    background: none;\n    color: CanvasText;/);
});
