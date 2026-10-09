// The depth at which the method is described in public, and what the pages say
// about where a profile runs.
//
// The twelve checks and the eight stages are explained by what they ask and
// why reports die on them. How a check or a stage is executed is the hosted
// product: no page carries a procedure, a fail-condition list or the order in
// which verdicts win. These tests hold the pages to that.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { renderSite } from '../../scripts/build-site.mjs';
import { GAUNTLET, PROFILES, reviewProfile } from '../public/profiles.mjs';
import { SITE } from '../site/layout.mjs';
import { CHECKS, CHECKS_RUN_LINE, RECORD_CLAIM, STAGES, VERDICTS } from '../site/pages/method/_shared.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(WEB_DIR, '..');
const PRIVATE_MODULE = path.join(WEB_DIR, 'private', 'operator-profiles.mjs');

const site = await renderSite();
const pages = new Map([...site.outputs].filter(([file]) => file.endsWith('.html')).map(([file, markup]) => [file.replace(/\\/g, '/'), markup]));

/** Visible text of a page body: no scripts, tags removed, entities decoded. */
function textOf(markup) {
  const body = markup.slice(markup.indexOf('<body'));
  return body
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    // A link at the end of a sentence leaves a space before the full stop.
    .replace(/ ([.,;:])/g, '$1');
}

/** The first match of a pattern with a little context, or null. A whole page makes a useless failure message. */
function found(body, pattern) {
  const match = pattern.exec(body);
  return match ? body.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40) : null;
}

const text = (file) => textOf(pages.get(file));
const count = (haystack, needle) => haystack.split(needle).length - 1;
const sentences = (value) => (value.match(/[.?](?=\s|$)/g) ?? []).length;

const VERDICT_IDS = new Set(VERDICTS.map((verdict) => verdict.id));

test('the twelve checks are a name, one question, two sentences on why reports die, and a verdict', () => {
  assert.equal(CHECKS.length, 12);
  assert.deepEqual(CHECKS.map((check) => check.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(new Set(CHECKS.map((check) => check.name)).size, 12);

  for (const check of CHECKS) {
    assert.deepEqual(Object.keys(check).sort(), ['asks', 'leads', 'n', 'name', 'why'], `${check.name}: nothing beyond the public depth`);
    assert.ok(check.asks.endsWith('?') && count(check.asks, '?') === 1, `${check.name}: one question`);
    assert.equal(sentences(check.why), 2, `${check.name}: why reports die on it is two sentences`);
    assert.ok(check.leads.length >= 1 && check.leads.length <= 2, check.name);
    for (const lead of check.leads) {
      if (typeof lead === 'string') assert.ok(VERDICT_IDS.has(lead), `${check.name}: ${lead}`);
      else assert.ok(lead.label, check.name);
    }
  }
});

test('/method shows each check at that depth and says where the executable version runs', () => {
  const markup = pages.get('method.html');
  const body = text('method.html');

  for (const check of CHECKS) {
    const card = markup.slice(markup.indexOf(`id="check-${check.n}"`), markup.indexOf(`id="check-${check.n + 1}"`) === -1 ? markup.indexOf('checks__run') : markup.indexOf(`id="check-${check.n + 1}"`));
    const cardText = textOf(`<body>${card}`);
    assert.ok(cardText.includes(check.name), check.name);
    assert.ok(cardText.includes(check.asks), `${check.name}: the question`);
    assert.ok(cardText.includes(check.why), `${check.name}: why reports die on it`);
    assert.deepEqual([...card.matchAll(/class="rail__label">([^<]+)</g)].map((match) => match[1]), ['Asks', 'Why it kills', 'Leads to'], check.name);
    for (const lead of check.leads) {
      if (typeof lead === 'string') assert.ok(card.includes(`data-verdict="${lead}"`), `${check.name}: ${lead}`);
      else assert.ok(cardText.includes(lead.label), check.name);
    }
  }

  assert.equal(count(body, CHECKS_RUN_LINE), 1, 'one line under the checks');
  assert.match(markup, /class="checks__run">[\s\S]*?href="\/gauntlet"/);
  assert.ok(body.includes('What makes a report land'));
  // One wording for the record on every page that carries it.
  assert.equal(RECORD_CLAIM, 'Twelve checks from 105 real case files across five platforms, the paid ones and the closed ones.');
  for (const file of ['method.html', 'guide.html', 'templates.html']) assert.ok(text(file).includes(RECORD_CLAIM), file);
  assert.ok(text('tools/report-check.html').includes('105 real case files across five platforms, the paid ones and the closed ones.'));
  // The earlier wording is on no page. The changelog is history and may quote it.
  for (const [file, markup] of pages) {
    if (file === 'changelog.html') continue;
    assert.equal(found(textOf(markup), /distilled from|The wins and the closures/), null, file);
  }
});

test('no page carries a procedure for a check, a fail-condition list or the order in which verdicts win', () => {
  const procedure = /what clears (?:it|each)|run (?:it|them|each one) by hand|written to run by hand|test to run by hand/i;
  const precedence = /first (?:rule|verdict|condition) that (?:applies|fits|matches)|in this order: drop|drop, hold-duplicate, prove-first, rewrite-then-submit, submit|the first that fits/i;
  for (const [file, markup] of pages) {
    const body = textOf(markup);
    assert.equal(found(body, procedure), null, file);
    assert.equal(found(body, precedence), null, file);
    // The rows a check card used to carry.
    for (const label of ['Run it', 'Clears it', 'Fails when', 'Forces']) {
      assert.ok(!markup.includes(`class="rail__label">${label}<`), `${file}: ${label}`);
    }
  }
});

test('the guide lists the twelve checks by question and verdict, and points to the gauntlet', () => {
  const body = text('guide.html');
  for (const check of CHECKS) {
    assert.ok(body.includes(check.name), check.name);
    assert.ok(body.includes(check.asks), `${check.name}: the question`);
  }
  assert.equal(count(body, CHECKS_RUN_LINE), 1);
  assert.match(pages.get('guide.html'), /<a href="\/method">method page<\/a> says why reports die on each one/);
});

test('each gauntlet stage is a name, a question and the names of what it outputs', () => {
  assert.deepEqual(STAGES.map((stage) => stage.id), [...GAUNTLET]);
  assert.deepEqual(STAGES.map((stage) => stage.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const stage of STAGES) {
    assert.deepEqual(Object.keys(stage).sort(), ['checks', 'decides', 'id', 'n', 'name', 'outputs'], stage.name);
    assert.ok(stage.outputs.length >= 2 && stage.outputs.every((output) => output.length <= 48), `${stage.name}: outputs are names`);
    for (const number of stage.checks) assert.ok(CHECKS.some((check) => check.n === number), `${stage.name}: check ${number}`);
  }
  for (const file of ['method.html', 'gauntlet.html']) {
    const body = text(file);
    for (const stage of STAGES) {
      assert.ok(body.includes(stage.decides), `${file}: ${stage.name}`);
      for (const output of stage.outputs) assert.ok(body.includes(output), `${file}: ${stage.name}: ${output}`);
    }
  }
});

test('a landing page offers prompt export for a core profile and a hosted review for a hosted one', () => {
  const landings = ['solidity-review.html', 'challenge-report.html', 'code-security-review.html', 'triager-simulation.html', 'prior-art-check.html'];
  let core = 0;
  let hosted = 0;
  for (const file of landings) {
    const markup = pages.get(file);
    const profileId = /class="btn btn--primary btn--lg" href="\/\?profile=([a-z-]+)#workspace"/.exec(markup)?.[1];
    assert.ok(profileId, `${file}: the call to action names a profile`);
    const body = textOf(markup);
    if (reviewProfile(profileId).hosted) {
      hosted += 1;
      assert.equal(found(body, /export the prompt|copy the prompt/i), null, `${file}: a hosted profile has no prompt to copy`);
      assert.match(body, /It counts as a review: 1 a day on Free, unlimited on Operator\./, file);
      assert.match(markup, />What it answers</, `${file}: says what it answers, not what it checks`);
    } else {
      core += 1;
      assert.match(body, /copy the prompt into ChatGPT or Claude and paste the answer back/i, file);
    }
  }
  assert.equal(core, 3);
  assert.equal(hosted, 2);
  assert.deepEqual(PROFILES.filter((profile) => profile.listed && !profile.hosted).map((profile) => profile.id), ['general', 'solidity', 'report']);
});

test('the pages that state what is open source name the three core profiles and the hosted part', () => {
  const line = /The gauntlet stages and the panel cross-examination run on the hosted service\./;
  for (const file of ['licenses.html', 'security.html', 'terms.html']) {
    const body = text(file);
    assert.match(body, line, file);
    assert.match(body, /three core profiles/, file);
  }
  for (const [file, markup] of pages) {
    assert.equal(found(textOf(markup), /published on the method page|review engine, the MCP server and the command-line kit (?:are|is) (?:released|in one public)/), null, file);
  }
});

test('every page links the public repository under its new home', async () => {
  assert.equal(SITE.source, 'https://github.com/bountyoperator/bounty-operator');
  let links = 0;
  for (const [file, markup] of pages) {
    assert.doesNotMatch(markup, /krutftw\/bounty-operator-kit/, file);
    links += count(markup, 'href="https://github.com/bountyoperator/bounty-operator');
  }
  assert.ok(links >= pages.size, 'the footer of every page links the source');

  for (const name of ['llms.txt', '.well-known/security.txt']) {
    const body = await readFile(path.join(WEB_DIR, 'public', name), 'utf8');
    assert.doesNotMatch(body, /krutftw\/bounty-operator-kit/, name);
    assert.match(body, /github\.com\/bountyoperator\/bounty-operator/, name);
  }
  // The researcher's portfolio keeps its own address.
  const readme = await readFile(path.join(REPO_DIR, 'README.md'), 'utf8');
  assert.match(readme, /https:\/\/github\.com\/krutftw\/audit-portfolio/);
  assert.doesNotMatch(readme, /krutftw\/bounty-operator-kit/);
});

test('/compare cites a dated source for every fact about another product and scores nothing', () => {
  const markup = pages.get('compare.html');
  const body = text('compare.html');

  const cited = new Set([...markup.matchAll(/href="#source-(\d+)"/g)].map((match) => Number(match[1])));
  const listed = [...markup.matchAll(/id="source-(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(listed, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...cited].sort((a, b) => a - b), listed, 'every source is cited and every citation has a source');
  const sources = markup.slice(markup.indexOf('<ol class="sources">'), markup.indexOf('</ol>', markup.indexOf('<ol class="sources">')));
  const checkedOn = (day) => count(sources, `checked ${day} October 2026`);
  assert.equal(checkedOn(2) + checkedOn(3) + checkedOn(7) + checkedOn(9), listed.length, 'every source carries its check date');
  // Read again on 9 October: Immunefi Studio's page and two posts, and the hosted bounty tool's README and prices.
  assert.equal(checkedOn(9), 5);
  // A statement about access that can change carries its own date, from the post that made it.
  assert.ok(body.includes('Immunefi described Studio as invite-only on 30 September 2026.'));
  assert.doesNotMatch(body, /is in invite-only beta/);

  // The seven overlapping tools are rows named by what they do. Their names and authors stay in the source list.
  const start = markup.indexOf('compare-tools');
  const tools = markup.slice(start, markup.indexOf('</table>', start));
  assert.equal(count(tools, '<tr>') - 1, 7);
  for (const row of ['A free hunting kit with a go/no-go gate', 'A hosted bounty tool with a lifetime price', 'A known-issue register', 'A false-positive filter', 'A local go or no-go check on one finished report', 'A platform’s report-writing plugin', 'A bountiability check with exploit simulation']) {
    assert.ok(tools.includes(row), row);
  }
  assert.doesNotMatch(tools, /Agentic|BountyForge|bountyforge|K\.I\.T|The-Judge|awarexone|Gabson|J4X|heavyw8t|should-i-submit|mdpsec|YesWeHack|yeswehack|claude-kit|Azimuth|TestMachine|testmachine/);
  for (const number of [8, 9, 10, 11, 12, 14, 15, 16]) assert.ok(tools.includes(`href="#source-${number}"`), `source ${number}`);

  assert.equal(found(body, /\b(?:better|best|worse|faster|slower|superior|inferior|beats|outperforms?|more accurate|accuracy)\b/i), null, 'no comparative claim');
  assert.equal(found(body, /\b\d+(?:\.\d+)? ?\/ ?(?:5|10|100)\b|\bout of (?:five|ten|5|10)\b|[★☆]/), null, 'no rating');
  assertNoBannedNames(body, '/compare', { page: '/compare' });
});

test('the method data and the pages hold no eight-word run of the hosted method', { skip: existsSync(PRIVATE_MODULE) ? false : 'the private profile module is not in this checkout' }, async () => {
  const { OPERATOR_PROFILES } = await import(pathToFileURL(PRIVATE_MODULE).href);
  const words = (value) => (String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const RUN = 8;

  const shingles = new Map();
  for (const [id, method] of Object.entries(OPERATOR_PROFILES)) {
    for (const part of [method.instructions, method.extraFormat]) {
      const list = words(part);
      for (let index = 0; index + RUN <= list.length; index += 1) shingles.set(list.slice(index, index + RUN).join(' '), id);
    }
  }
  assert.ok(shingles.size > 1000, 'the private module carries the method');

  const hits = [];
  const scan = (name, value) => {
    const list = words(value);
    for (let index = 0; index + RUN <= list.length; index += 1) {
      const profile = shingles.get(list.slice(index, index + RUN).join(' '));
      // The message names the place and the profile, never the words.
      if (profile) hits.push(`${name}: word ${index} (${profile})`);
    }
  };
  for (const [file, markup] of site.outputs) scan(file, markup);
  for (const name of ['llms.txt', 'tools/report-check-core.mjs', 'templates/template.mjs']) scan(name, await readFile(path.join(WEB_DIR, 'public', name), 'utf8'));
  for (const name of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'mcp/README.md', 'docs/website.md', 'docs/workflow.md', 'docs/ai-agent-flow.md', 'docs/agent-pack.md']) {
    scan(name, await readFile(path.join(REPO_DIR, name), 'utf8'));
  }
  assert.deepEqual(hits.slice(0, 10), []);
});

test('/invalid-report-costs cites a dated source for every platform rule and ranks nothing', () => {
  const markup = pages.get('invalid-report-costs.html');
  const body = text('invalid-report-costs.html');

  const cited = new Set([...markup.matchAll(/href="#source-(\d+)"/g)].map((match) => Number(match[1])));
  const listed = [...markup.matchAll(/id="source-(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(listed, Array.from({ length: listed.length }, (_, index) => index + 1));
  assert.ok(listed.length >= 10);
  assert.deepEqual([...cited].sort((a, b) => a - b), listed, 'every source is cited and every citation has a source');
  const sources = markup.slice(markup.indexOf('<ol class="sources">'), markup.indexOf('</ol>', markup.indexOf('<ol class="sources">')));
  assert.equal(count(sources, 'checked 7 October 2026') + count(sources, 'checked 9 October 2026'), listed.length, 'every source carries its check date');
  // Bugcrowd's three sources were read again after its rules changed on 8 October 2026.
  assert.equal(count(sources, 'checked 9 October 2026'), 3);
  for (const line of sources.split('</li>').filter((item) => item.includes('Bugcrowd'))) assert.match(line, /checked 9 October 2026/);

  // One row per platform, each with at least one source in its row.
  const start = markup.indexOf('compare-tools');
  const table = markup.slice(start, markup.indexOf('</table>', start));
  const rows = table.split('<tr>').slice(2);
  assert.deepEqual(rows.map((row) => row.replace(/<[^>]+>/g, ' ').trim().split(/\s+/)[0]), ['HackerOne', 'Bugcrowd', 'Intigriti', 'YesWeHack', 'Immunefi', 'Cantina', 'Sherlock']);
  for (const row of rows.slice(0, 6)) assert.match(row, /href="#source-\d+"/);

  // The figures as the platforms state them.
  for (const figure of ['−5 reputation', 'Spam: −10 reputation', 'below 50% is limited to 6 submissions a week, for at least 7 days', '10 submissions in 90 days', 'A report closed N/A counts as a rejection', '30-day suspension', '1 below 20%', 'three times the price in all', 'four times in all', 'immediate and permanent ban', 'the deposit is slashed', 'at least 20% and you have 2 valid findings']) {
    assert.ok(body.includes(figure), figure);
  }

  assert.equal(found(body, /\b(?:better|best|worse|worst|harsher|strictest|safest|fairest|beats|outperforms?)\b/i), null, 'no ranking of platforms');
  assert.equal(found(body, /\b\d+(?:\.\d+)? ?\/ ?(?:5|10|100)\b|\bout of (?:five|ten|5|10)\b|[★☆]/), null, 'no rating');
  assertNoBannedNames(body, '/invalid-report-costs', { page: '/invalid-report-costs' });

  // Reachable: the report check, /compare and llms.txt link to it.
  for (const file of ['tools/report-check.html', 'compare.html']) assert.match(pages.get(file), /href="\/invalid-report-costs"/, file);
});
