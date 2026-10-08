// Tests for the report-template pages: the data, the generated Markdown, the
// rendered pages and the browser module that copies and hands off a draft.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateMarkup } from '../../scripts/build-site.mjs';
import { renderPage } from '../site/layout.mjs';
import { CHECKED, COMPARISON, PARTS, PLATFORMS } from '../site/pages/templates/data.mjs';
import foundryPage from '../site/pages/templates/foundry-poc.mjs';
import hubPage from '../site/pages/templates/index.mjs';
import platformPages from '../site/pages/templates/platforms.mjs';
import { renderBody, toMarkdown } from '../site/pages/templates/shared.mjs';
import { buildHandoff, placeholdersIn, remainingPlaceholders, sourceText } from '../public/templates/template.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = path.join(WEB_DIR, 'public', 'templates');
const PAGES = [hubPage, ...platformPages, foundryPage];

const read = async (name) => (await readFile(path.join(TEMPLATE_DIR, name), 'utf8')).replace(/\r\n/g, '\n');
const wordCount = (text) => text.trim().split(/\s+/).length;

test('each Markdown file on disk is what data.mjs produces', async () => {
  for (const platform of PLATFORMS) {
    assert.equal(await read(platform.file), toMarkdown(platform), `${platform.file} is stale: run node web/site/pages/templates/write-md.mjs`);
  }
});

test('every template carries the eight parts, in a form a platform accepts', () => {
  assert.equal(PARTS.length, 8);
  for (const platform of PLATFORMS) {
    const ids = platform.sections.map((section) => section.id);
    assert.equal(new Set(ids).size, ids.length, `${platform.id}: section ids are unique`);
    assert.equal(ids[0], 'title', `${platform.id}: the title rule comes first`);
    for (const required of ['poc', 'limits', 'known']) {
      // HackerOne names its proof section "Supporting Material".
      const present = ids.includes(required) || (required === 'poc' && ids.includes('material'));
      assert.ok(present, `${platform.id}: missing the ${required} section`);
    }
    assert.deepEqual(
      platform.sections.filter((section) => section.origin === 'added').map((section) => section.id),
      ['limits', 'known'],
      `${platform.id}: only the two added sections are marked as added`,
    );

    const markdown = toMarkdown(platform);
    assert.match(markdown, /^> .+ report template from https:\/\/bountyoperator\.com\/templates\//);
    assert.match(markdown, /\n# \{/, `${platform.id}: the title line is a level-one heading`);
    assert.ok(markdown.endsWith('\n') && !markdown.endsWith('\n\n'));
    // A nested brace would break the placeholder convention; a bare tag would vanish on GitHub.
    assert.doesNotMatch(markdown, /\{[^{}\n]*\{/, `${platform.id}: nested placeholder`);
    assert.doesNotMatch(markdown, /<[a-z][^>]*>/i, `${platform.id}: raw HTML in the Markdown`);
    // Fences are balanced.
    assert.equal((markdown.match(/^```/gm) ?? []).length % 2, 0, `${platform.id}: unbalanced code fence`);
  }
});

test('every closure reason names a source, and quotes stay short', () => {
  for (const platform of PLATFORMS) {
    const ids = new Set(platform.sources.map((source) => source.id));
    assert.equal(ids.size, platform.sources.length, `${platform.id}: source ids are unique`);
    for (const source of platform.sources) assert.match(source.href, /^https:\/\//, `${platform.id}: ${source.id}`);

    assert.ok(platform.closed.length >= 6, `${platform.id}: lists what gets a report closed`);
    let quotes = 0;
    for (const item of platform.closed) {
      assert.ok(item.sources.length > 0, `${platform.id}: "${item.title}" has no source`);
      for (const id of item.sources) assert.ok(ids.has(id), `${platform.id}: unknown source "${id}"`);
      if (item.quote) {
        quotes += 1;
        assert.ok(ids.has(item.quote.source));
        assert.ok(wordCount(item.quote.text) < 15, `${platform.id}: quote is too long`);
      }
    }
    assert.ok(quotes <= 1, `${platform.id}: one short quote per page`);
  }
  for (const row of COMPARISON) assert.equal(row.cells.length, PLATFORMS.length, `comparison row "${row.question}"`);
});

test('copy follows the voice rules', () => {
  const copy = JSON.stringify({ PLATFORMS, PARTS, COMPARISON });
  // Lower-case only for "may": "May" is also a month in the source dates.
  for (const banned of [/\bmay\b/, /\bsimply\b/i, /\bpowerful\b/i, /can help/i, /not a guarantee/i, /!(?!=)/, /code4rena/i]) {
    assert.ok(!banned.test(copy), `banned in template copy: ${banned}`);
  }
  assertNoBannedNames(copy, 'template copy');
  assert.match(CHECKED.iso, /^\d{4}-\d{2}-\d{2}$/);
});

test('the pages render without anything the CSP would block', () => {
  assert.equal(PAGES.length, 6);
  const paths = new Set();
  for (const page of PAGES) {
    assert.ok(page.description.length >= 50 && page.description.length <= 160, `${page.path}: description length ${page.description.length}`);
    paths.add(page.path);

    const markup = renderPage(page);
    const { errors, warnings } = validateMarkup(markup, () => true);
    assert.deepEqual(errors, [], page.path);
    assert.deepEqual(warnings, [], page.path);
    assert.equal((markup.match(/<h1[ >]/g) ?? []).length, 1, `${page.path}: one h1`);
    assert.match(markup, /"@type":"BreadcrumbList"/, `${page.path}: breadcrumbs JSON-LD`);
    assert.match(markup, /checked 2 Oct 2026/i, `${page.path}: sources are date-stamped`);
  }
  assert.deepEqual([...paths].sort(), ['/templates', '/templates/cantina', '/templates/foundry-poc', '/templates/hackerone', '/templates/immunefi', '/templates/sherlock']);

  for (const page of platformPages) {
    const markup = renderPage(page);
    assert.match(markup, /data-template-copy/, `${page.path}: copy button`);
    assert.match(markup, /href="\/templates\/[a-z]+\.md" download="/, `${page.path}: download link`);
    assert.match(markup, /href="\/tools\/report-check"/, `${page.path}: report check link`);
    assert.match(markup, /href="\/\?profile=report#workspace"/, `${page.path}: workbench link`);
    assert.match(markup, /data-handoff-profile="report"/);
  }
});

test('the Foundry scaffold on the page is the file that downloads', async () => {
  const scaffold = await read('ImpactPoC.t.sol');
  const markup = renderPage(foundryPage);
  assert.match(markup, /href="\/templates\/ImpactPoC\.t\.sol" download="ImpactPoC\.t\.sol"/);
  assert.match(markup, /data-handoff-profile="poc"/);
  assert.match(markup, /data-handoff-markers="todo"/);

  // The parts the page promises are in the file.
  for (const needle of ['vm.createSelectFork(vm.envString("RPC_URL"), FORK_BLOCK)', 'makeAddr("attacker")', 'function _impactObject()', 'function test_impact()', 'function test_control()', 'deployCodeTo(', 'assertGe(loss, EXPECTED_LOSS']) {
    assert.ok(scaffold.includes(needle), `scaffold is missing ${needle}`);
  }
  // No prank on a privileged role, no storage write on the target, no mocked call.
  assert.doesNotMatch(scaffold, /vm\.(store|mockCall)\(/);
  // The final statement of test_impact is the impact assertion.
  const impact = scaffold.slice(scaffold.indexOf('function test_impact()'), scaffold.indexOf('/// Control'));
  assert.match(impact.trimEnd(), /assertGe\(loss, EXPECTED_LOSS, "[^"]+"\);\n {4}\}$/);
});

test('renderBody turns the Markdown subset into markup with placeholders marked', () => {
  const markup = renderBody('Intro {slot} and `code {inner}`.\n\n- one\n- two\n\n1. first\n2. second\n\n```text\n<raw> {kept}\n```').join('');
  assert.match(markup, /<p>Intro <span class="slot">slot<\/span> and <code>code <span class="slot">inner<\/span><\/code>\.<\/p>/);
  assert.match(markup, /<ul class="tpl__list"><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(markup, /<ol class="steps tpl__steps"><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(markup, /&lt;raw&gt; \{kept\}/);
});

test('placeholder tracking only counts what the template put there', () => {
  const template = toMarkdown(PLATFORMS[0]);
  const placeholders = placeholdersIn(template);
  assert.ok(placeholders.length > 20);
  assert.equal(new Set(placeholders).size, placeholders.length);

  assert.deepEqual(remainingPlaceholders(template, placeholders), placeholders);
  // Solidity braces in a filled draft are not placeholders.
  const filled = '# Reentrancy in `withdraw` lets anyone drain the vault\n\n```solidity\nfunction f() public { x = 1; }\ncall{value: 1 ether}("");\n```';
  assert.deepEqual(remainingPlaceholders(filled, placeholders), []);
  assert.deepEqual(remainingPlaceholders(`${filled}\n{actor}`, placeholders), ['{actor}']);
});

test('the handoff matches the workbench contract', () => {
  const handoff = buildHandoff({ name: 'immunefi-report-draft.md', content: '# Draft', profile: 'report', focus: 'Check it.', note: 'From the template.' });
  assert.deepEqual(handoff, {
    files: [{ name: 'immunefi-report-draft.md', content: '# Draft' }],
    profile: 'report',
    focus: 'Check it.',
    context: { notes: 'From the template.' },
  });
  assert.equal(sourceText({ textContent: 'a\nb\n' }), 'a\nb');
  assert.equal(sourceText(null), '');
});

test('the Sherlock pages cite each rule at its current address and say which rules are the earlier contest rules', () => {
  const sherlock = PLATFORMS.find((platform) => platform.id === 'sherlock');
  // docs.sherlock.xyz/audits/... now redirects: every cited page is linked where it lives today.
  for (const page of PAGES) assert.doesNotMatch(renderPage(page), /docs\.sherlock\.xyz\/audits\//, page.path);
  const moved = sherlock.sources.filter((source) => source.href.includes('/audit-contests-deprecated-replaced-by-audit-engine/'));
  assert.deepEqual(moved.map((source) => source.id), ['criteria', 'judging', 'discussion', 'points', 'payout']);
  for (const source of moved) {
    assert.match(source.dated, /^Earlier contest rules/, source.id);
    assert.equal(source.checked, '9 Oct 2026', source.id);
  }
  const engine = sherlock.sources.find((source) => source.id === 'audit-engine');
  assert.equal(engine.href, 'https://docs.sherlock.xyz/audit-engine/for-participants');

  const markup = renderPage(platformPages.find((page) => page.path === '/templates/sherlock'));
  const sources = markup.slice(markup.indexOf('<h2 id="sources">'));
  assert.match(sources, /Sherlock now files its audit contest pages as deprecated, replaced by Audit Engine\./);
  assert.equal((sources.match(/Earlier contest rules/g) ?? []).length, 5);
  assert.match(sources, /Earlier contest rules · Version 1\.12, 24 Jun 2025 · checked 9 Oct 2026/);
  // A source read on the page's own date keeps that date.
  assert.match(sources, /Updated 18 Mar 2026 · checked 2 Oct 2026/);
});
