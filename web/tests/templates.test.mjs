// Tests for the report-template pages: the data, the generated Markdown, the
// rendered pages and the browser module that copies and hands off a draft.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateMarkup } from '../../scripts/build-site.mjs';
import { renderPage } from '../site/layout.mjs';
import { CHECKED, COMPARISON, GITHUB, PARTS, PLATFORMS, TEMPLATES } from '../site/pages/templates/data.mjs';
import foundryPage from '../site/pages/templates/foundry-poc.mjs';
import hubPage from '../site/pages/templates/index.mjs';
import platformPages from '../site/pages/templates/platforms.mjs';
import { checkedOf, renderBody, toMarkdown } from '../site/pages/templates/shared.mjs';
import { buildHandoff, copiedNote, handoffTarget, placeholdersIn, remainingPlaceholders, sourceText } from '../public/templates/template.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = path.join(WEB_DIR, 'public', 'templates');
const PAGES = [hubPage, ...platformPages, foundryPage];

const read = async (name) => (await readFile(path.join(TEMPLATE_DIR, name), 'utf8')).replace(/\r\n/g, '\n');
const wordCount = (text) => text.trim().split(/\s+/).length;

test('each Markdown file on disk is what data.mjs produces', async () => {
  for (const platform of TEMPLATES) {
    assert.equal(await read(platform.file), toMarkdown(platform), `${platform.file} is stale: run node web/site/pages/templates/write-md.mjs`);
  }
});

test('every template carries the eight parts, in a form a platform accepts', () => {
  assert.equal(PARTS.length, 8);
  for (const platform of TEMPLATES) {
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
    // The note sends a filled draft back to the page's own check, tagged so a return from the file is counted.
    assert.ok(markdown.includes(`\n> Before you submit, paste the filled draft at https://bountyoperator.com${platform.path}?ref=template#check for a free check.\n`), `${platform.id}: the note points back to the check`);
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
  for (const platform of TEMPLATES) {
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
  const copy = JSON.stringify({ TEMPLATES, PARTS, COMPARISON });
  // Lower-case only for "may": "May" is also a month in the source dates.
  for (const banned of [/\bmay\b/, /\bsimply\b/i, /\bpowerful\b/i, /can help/i, /not a guarantee/i, /!(?!=)/, /code4rena/i]) {
    assert.ok(!banned.test(copy), `banned in template copy: ${banned}`);
  }
  assertNoBannedNames(copy, 'template copy');
  assert.match(CHECKED.iso, /^\d{4}-\d{2}-\d{2}$/);
});

test('the pages render without anything the CSP would block', () => {
  assert.equal(PAGES.length, 7);
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
    const template = TEMPLATES.find((entry) => entry.path === page.path);
    const date = template ? checkedOf(template).label : CHECKED.label;
    assert.ok(markup.includes(`checked ${date}`), `${page.path}: sources are date-stamped`);
  }
  assert.deepEqual([...paths].sort(), [
    '/templates',
    '/templates/cantina',
    '/templates/foundry-poc',
    '/templates/github-private-vulnerability-report',
    '/templates/hackerone',
    '/templates/immunefi',
    '/templates/sherlock',
  ]);

  for (const page of platformPages) {
    const markup = renderPage(page);
    assert.match(markup, /data-template-copy/, `${page.path}: copy button`);
    assert.match(markup, /href="\/templates\/[a-z-]+\.md" download="/, `${page.path}: download link`);
    assert.match(markup, /href="\/tools\/report-check"/, `${page.path}: report check link`);
    assert.match(markup, /href="\/\?profile=report#workspace"/, `${page.path}: workbench link`);
    assert.match(markup, /data-handoff-profile="report"/);
  }
});

test('every template page hands the visitor to a review near the top, after a copy, and at the end', () => {
  for (const page of [...platformPages, foundryPage]) {
    const markup = renderPage(page);
    const from = markup.indexOf('<header class="page-head');
    const head = markup.slice(from, markup.indexOf('</header>', from));
    // Under the two actions of the head: what the review does, and a way down to the page's check.
    const actions = head.indexOf('page-head__actions');
    const handoff = head.indexOf('notice notice--info tpl-handoff');
    assert.ok(actions > 0 && handoff > actions, `${page.path}: the hand-off sits under the actions`);
    assert.match(head.slice(handoff), /<a class="btn btn--secondary" href="#check"><span class="btn__label">(?:Challenge my draft|Review this proof)<\/span><\/a>/, `${page.path}: the hand-off button`);
    assert.match(markup, /<h2 id="check">/, `${page.path}: the button has somewhere to go`);
    // After a copy the status line says where the filled draft goes, until the next copy.
    assert.match(head, /data-template-status data-template-copied="Copied\. Once it is filled in[^"]+"/, `${page.path}: the next step after a copy`);
  }

  for (const page of platformPages) {
    const markup = renderPage(page);
    const head = markup.slice(markup.indexOf('<header class="page-head'), markup.indexOf('</header>', markup.indexOf('<header class="page-head')));
    assert.match(head, /Free in ChatGPT or Claude with no account, or once a day on your own AI key with a free account\./, `${page.path}: the head says what is free`);
    // The second hand-off sends the same draft to Triager simulation, and says it needs an account.
    const check = markup.slice(markup.indexOf('<h2 id="check">'), markup.indexOf('<h2 id="sources">'));
    assert.match(check, /<a class="btn btn--secondary" href="\/\?profile=triage#workspace" data-handoff-go data-handoff-profile="triage" data-handoff-focus="[^"]+"><span class="btn__label">Run the Triager simulation<\/span><\/a>/, `${page.path}: the Triager simulation hand-off`);
    assert.match(check, /It needs a free account: one passkey prompt, no email, no card\./, `${page.path}: the account it needs`);
    assert.equal((check.match(/data-handoff-go/g) ?? []).length, 2, `${page.path}: two hand-offs of one draft`);
    // The page ends on the shared closing band, which leads back to the check.
    const band = markup.slice(markup.indexOf('<section class="closing-band"'));
    assert.match(band, /<a class="btn btn--primary btn--lg" href="#check"><span class="btn__label">Challenge my draft<\/span><\/a>/, `${page.path}: the closing band`);
  }
});

test('a hand-off button sends its own profile and focus, and falls back to the panel', () => {
  const panel = { dataset: { handoffProfile: 'report', handoffFocus: 'Check the draft.' } };
  assert.deepEqual(handoffTarget({ dataset: {} }, panel), { profile: 'report', focus: 'Check the draft.' });
  assert.deepEqual(handoffTarget({ dataset: { handoffProfile: 'triage', handoffFocus: 'Act as the triager.' } }, panel), { profile: 'triage', focus: 'Act as the triager.' });
  assert.deepEqual(handoffTarget(null, panel), { profile: 'report', focus: 'Check the draft.' });
  assert.equal(copiedNote({ dataset: { templateCopied: 'Copied. Paste it below.' } }), 'Copied. Paste it below.');
  assert.equal(copiedNote({ dataset: { templateCopied: '' } }), 'Copied to the clipboard.');
  assert.equal(copiedNote(null), 'Copied to the clipboard.');
});

test('the Immunefi page names the per-report fee, with sources read on 15 Oct 2026', () => {
  const immunefi = PLATFORMS.find((platform) => platform.id === 'immunefi');
  const fee = immunefi.closed.find((item) => /fee on every report/i.test(item.title));
  assert.ok(fee, 'the fee item');
  assert.deepEqual(fee.sources, ['comp-ens', 'comp-firelight', 'comp-quantus', 'lombard']);
  for (const id of fee.sources) assert.equal(immunefi.sources.find((source) => source.id === id).checked, '15 Oct 2026', id);
  // The rules page itself still lists no fee: the item says where the fee is set.
  const penalties = immunefi.closed.find((item) => item.title === 'Penalties');
  assert.match(penalties.body, /^The rules page publishes no fee\. Audit competitions, and some bug bounties, now charge one per report, shown at submission\./);
  assert.match(immunefi.title, /^Immunefi bug report template \(bug bounties and audit competitions\)/);
  assert.match(immunefi.description, /per-report fee/);
  assert.match(COMPARISON.find((row) => row.question === 'Fee or penalty').cells[0], /^A fee per report/);
  // CHECKED is shared by all four platforms and stays: the fee pages carry their own date.
  assert.equal(CHECKED.label, '2 Oct 2026');
  const markup = renderPage(platformPages.find((page) => page.path === '/templates/immunefi'));
  const sources = markup.slice(markup.indexOf('<h2 id="sources">'));
  assert.equal((sources.match(/checked 15 Oct 2026/g) ?? []).length, 5);
});

test('the GitHub private vulnerability report page: the 1 Oct 2026 form, sourced and dated', async () => {
  assert.equal(GITHUB.path, '/templates/github-private-vulnerability-report');
  assert.ok(!PLATFORMS.includes(GITHUB), 'GitHub is no column of the platform comparison');
  assert.equal(GITHUB.checked.label, '15 Oct 2026');
  // The four boxes the default form requires, then the CWE and the AI-assistance box.
  assert.deepEqual(GITHUB.sections.slice(1, 7).map((section) => section.heading), ['Summary', 'Details', 'Proof of concept', 'Impact', 'Weakness and severity', 'AI assistance']);
  assert.match(GITHUB.sections.find((section) => section.id === 'poc').rule, /at least 150 characters/);
  for (const source of GITHUB.sources) assert.equal(source.checked, undefined, `${source.id} takes the page's own date`);
  const changelog = GITHUB.sources.filter((source) => source.href.startsWith('https://github.blog/changelog/2026-10-01-'));
  assert.equal(changelog.length, 2);
  for (const source of changelog) assert.equal(source.dated, 'GitHub Changelog, 1 Oct 2026');

  const page = platformPages.find((entry) => entry.path === GITHUB.path);
  const markup = renderPage(page);
  const sources = markup.slice(markup.indexOf('<h2 id="sources">'));
  assert.equal((sources.match(/checked 15 Oct 2026/g) ?? []).length, GITHUB.sources.length);
  assert.match(markup, /<p class="meta">Rules checked 15 Oct 2026 · 6 sources<\/p>/);
  assert.match(markup, /href="\/templates\/github-private-vulnerability-report\.md" download="github-private-vulnerability-report-template\.md"/);
  assert.match(markup, /the way a maintainer would/);
  assert.equal(page.lastmod, '2026-10-15');

  // Listed on the hub and in the sitemap.
  assert.match(renderPage(hubPage), /<a href="\/templates\/github-private-vulnerability-report">GitHub<\/a>/);
  const sitemap = await readFile(path.join(WEB_DIR, 'public', 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/bountyoperator\.com\/templates\/github-private-vulnerability-report<\/loc><lastmod>2026-10-15<\/lastmod>/);
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
