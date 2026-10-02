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
import { STAGES, VERDICTS } from '../site/pages/method/_shared.mjs';
import { CARD, cardDocument } from '../site/social/card.mjs';
import { EXAMPLE } from '../site/social/example.mjs';
import { EXAMPLES } from '../public/example.mjs';
import { GAUNTLET } from '../public/profiles.mjs';
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
const byId = (id) => tags.find((tag) => tag.attributes.get('id') === id);

test('the home page passes the generator checks and has one h1', () => {
  const { errors, warnings } = validateMarkup(markup, () => true);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(home.path, '/');
  assert.equal(home.title, 'Bounty Operator — find the hole in your bug bounty report before the triager does');
  assert.match(textOf(main), /Find the hole in your report before the triager does\./);
});

test('the hooks other streams rely on are present exactly once', () => {
  const demo = tags.filter((tag) => tag.attributes.has('data-demo'));
  assert.equal(demo.length, 1, '[data-demo]');
  assert.equal(demo[0].attributes.get('href'), '#workspace');
  assert.ok(demo[0].attributes.has('data-example'), 'the demo control also carries the workbench attribute');

  assert.equal(byId('workspace')?.name, 'section');
  assert.equal(byId('pricing')?.name, 'section');

  const upgrade = byId('upgrade');
  assert.equal(upgrade?.name, 'button');
  assert.ok(upgrade.attributes.has('data-upgrade'));
  assert.equal(upgrade.attributes.get('data-account-action'), 'checkout');
  assert.equal(tags.filter((tag) => tag.attributes.has('data-upgrade')).length, 1);
  assert.equal(tags.filter((tag) => tag.attributes.has('data-checkout-note')).length, 1);

  assert.ok(find('a', (attributes) => attributes.get('href') === '/?profile=report#workspace').length >= 1);
  assert.ok(find('script', (attributes) => attributes.get('src') === '/app/main.mjs').length === 1, 'the page loads /app/main.mjs');
  assert.ok(find('link', (attributes) => attributes.get('href') === '/css/home.css').length === 1);
});

test('the sections come in the order the brief sets', () => {
  const order = ['id="hero-title"', 'class="home-proof"', 'id="how"', 'id="workspace"', 'id="gauntlet"', 'id="what-you-get"', 'id="your-model"', 'id="free-tools"', 'id="pricing"', 'id="faq"'];
  const positions = order.map((needle) => markup.indexOf(needle));
  assert.ok(positions.every((position) => position > 0), `missing: ${order.filter((_, index) => positions[index] < 0).join(', ')}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('the proof strip links the two leaderboards and the method', () => {
  const hrefs = find('a').map((tag) => tag.attributes.get('href'));
  assert.ok(hrefs.includes('https://immunefi.com/audit-competition/audit-comp-firelight-1/leaderboard/'));
  assert.ok(hrefs.includes('https://immunefi.com/audit-competition/audit-comp-quantus/leaderboard/'));
  assert.ok(hrefs.includes('/method'));
  const text = textOf(own);
  assert.match(text, /Built by\s+Tradi3/);
  assert.match(text, /2nd of 133/);
  assert.match(text, /8th of 65/);
  assert.match(text, /Twelve checks from 105 real case files/);
});

test('the gauntlet shows the eight stages in engine order and the five verdicts', () => {
  assert.deepEqual(STAGES.map((stage) => stage.id), [...GAUNTLET]);
  const names = [...main.matchAll(/class="home-pipe__name">([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(names, STAGES.map((stage) => stage.name));
  const shown = [...main.matchAll(/<dt><span class="chip verdict" data-verdict="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(shown, VERDICTS.map((verdict) => verdict.id));
});

test('pricing states the two fixed plans and nothing else', () => {
  const pricing = main.slice(main.indexOf('id="pricing"'), main.indexOf('id="faq"'));
  const text = textOf(pricing);
  assert.match(text, /US\$0/);
  assert.match(text, /US\$10 per week/);
  assert.match(text, /Unlimited hosted reviews/);
  assert.match(text, /Run today’s free review/);
  assert.match(text, /Get Operator/);
  assert.doesNotMatch(text, /trial|discount|per month|\/mo\b|coupon/i);
  const amounts = [...textOf(own).matchAll(/US\$\d+/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(amounts)].sort(), ['US$0', 'US$10']);
});

test('every provider the engine supports is named', () => {
  const text = textOf(own);
  for (const provider of PROVIDERS) assert.ok(text.includes(provider.label), provider.label);
});

test('structured data: organization, the two offers, and an FAQ that matches the visible text', () => {
  const types = home.jsonld.map((entry) => entry['@type']);
  assert.deepEqual(types, ['Organization', 'SoftwareApplication', 'FAQPage']);
  const offers = home.jsonld[1].offers.map((offer) => [offer.name, offer.price]);
  assert.deepEqual(offers, [['Free', '0'], ['Operator', '10.00']]);

  const faq = home.jsonld[2].mainEntity;
  assert.equal(faq.length, 6);
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

test('the hero shows the bundled example the workbench opens, as the parser reads it', async () => {
  // "Run the example" loads EXAMPLES[0]. The card is that review: same verdict, same finding, same file.
  const source = EXAMPLES[0];
  assert.equal(EXAMPLE.id, source.id);
  const manifest = await manifestFor(source.files);
  const parsed = parseReview(source.review, { labels: manifest.map((entry) => entry.label) });
  assert.equal(parsed.ok, true);
  assert.deepEqual(checkRefs(parsed, manifest), []);
  assert.equal(EXAMPLE.verdict, parsed.verdict);
  assert.equal(EXAMPLE.verdict, 'rewrite-then-submit');
  assert.equal(EXAMPLE.headline, parsed.headline);
  assert.ok(EXAMPLE.headline.length <= 140, 'the headline fits the format limit');
  assert.equal(EXAMPLE.finding.title, parsed.findings[0].title);
  assert.equal(EXAMPLE.supported, parsed.findings[0].severity);
  assert.equal(EXAMPLE.supported, 'medium');
  assert.equal(EXAMPLE.claimed, 'critical');
  assert.equal(EXAMPLE.model, source.model);

  // The file bar shows the product's own manifest entry for that file.
  const entry = manifest.find((candidate) => candidate.label === EXAMPLE.file);
  assert.ok(entry, EXAMPLE.file);
  assert.equal(EXAMPLE.sha256, entry.sha256);
  assert.equal(EXAMPLE.lines, `${entry.lines} lines`);

  // The excerpt is lines of the supplied file from the start of the cited range, with the file's
  // indentation taken off the left. The marked lines are in it.
  const location = EXAMPLE.finding.locations[0];
  const file = source.files[manifest.indexOf(entry)];
  const lines = file.content.split('\n');
  const shown = EXAMPLE.source.split('\n');
  assert.equal(EXAMPLE.sourceStart, location.start);
  assert.equal(shown.length, EXAMPLE.sourceEnd - EXAMPLE.sourceStart + 1);
  assert.ok(EXAMPLE.sourceEnd <= location.end);
  shown.forEach((line, index) => assert.equal(line.trim(), lines[EXAMPLE.sourceStart - 1 + index].trim()));
  assert.ok(shown.some((line) => line && !/^\s/.test(line)), 'the excerpt starts at the left edge');
  for (const line of EXAMPLE.highlight) assert.ok(line >= location.start && line <= EXAMPLE.sourceEnd, `line ${line}`);
  assert.match(lines[location.start - 1], /function stake\(/);
  assert.ok(markup.includes(`data-n="${location.start}"`));
});

test('the hero shows the example on an always-dark surface, labelled as an example', () => {
  const hero = main.slice(0, main.indexOf('id="how"'));
  assert.match(hero, /<figure class="home-shot theme-dark"/);
  assert.match(hero, /data-status="example"/);
  assert.match(textOf(hero), /Example review, as the model wrote it\. Tessera Staking is an invented protocol\./);
  assert.match(textOf(hero), /TesseraStaking\.sol/);
  assert.match(hero, /class="chip sev" data-sev="critical"/);
  assert.match(hero, /class="chip sev" data-sev="medium"/);
  assert.match(hero, /data-verdict="rewrite-then-submit"/);
});

test('the social card is a 1200 x 630 document drawn from the same example', async () => {
  assert.deepEqual(CARD, { width: 1200, height: 630 });
  const card = cardDocument();
  assert.match(card, /<html lang="en" data-theme="dark">/);
  assert.match(card, /Find the hole in your report before the triager does\./);
  assert.match(card, /class="home-shot theme-dark"/);
  assert.match(textOf(card), /Built by Tradi3\s+2nd of 133, Firelight\s+8th of 65, Quantus/);
  assert.match(textOf(card), /Operator: US\$10 a week/);
  assert.doesNotMatch(card, /\sstyle="/);

  const png = await readFile(path.join(WEB_DIR, 'public', 'social-v2.png'));
  assert.equal(png.readUInt32BE(16), CARD.width);
  assert.equal(png.readUInt32BE(20), CARD.height);
});
