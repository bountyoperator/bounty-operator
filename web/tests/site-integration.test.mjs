// Contracts between the streams: what the pages say against what the engine,
// the Worker, the app and the local MCP server do. One page group's own tests
// cannot see these, because each side belongs to a different module.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderSite } from '../../scripts/build-site.mjs';
import { CLIENT_EVENTS } from '../public/app/events.mjs';
import { GAUNTLET, PROFILES, reviewProfile } from '../public/profiles.mjs';
import { LIMITS } from '../public/review-core.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(WEB_DIR, '..');
const APP_DIR = path.join(WEB_DIR, 'public', 'app');

const site = await renderSite();
const pages = new Map([...site.outputs].filter(([file]) => file.endsWith('.html')).map(([file, markup]) => [file.replace(/\\/g, '/'), markup]));

function textOf(markup) {
  const body = markup.slice(markup.indexOf('<body'));
  return body
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];
const numberOf = (token) => (/^\d+$/.test(token) ? Number(token) : WORDS.indexOf(token.toLowerCase()));

test('the production build has no errors, and every page is in it', () => {
  assert.deepEqual(site.errors, []);
  assert.ok(pages.size >= 32, `${pages.size} pages`);
  for (const file of ['index.html', 'pricing.html', 'method.html', 'gauntlet.html', 'mcp.html', 'guide.html', 'tools/verify.html', '404.html']) {
    assert.ok(pages.has(file), file);
  }
});

test('no page states a profile count or a stage count the engine does not have', () => {
  const listed = PROFILES.filter((profile) => profile.listed).length;
  const stages = GAUNTLET.length;
  // The changelog is rendered from CHANGELOG.md at the repository root and describes earlier releases too.
  for (const [file, markup] of pages) {
    if (file === 'changelog.html') continue;
    const text = textOf(markup);
    for (const match of text.matchAll(/\b(\d+|[a-z]+) (?:review |listed |single |hosted )?profiles\b/gi)) {
      const stated = numberOf(match[1]);
      if (stated > 2) assert.equal(stated, listed, `${file}: "${match[0]}"`);
    }
    for (const match of text.matchAll(/\b(\d+|[a-z]+)[ -]stages?\b/gi)) {
      const stated = numberOf(match[1]);
      // "Stage 3 of 8" and counts of finished stages in examples are not statements about the gauntlet.
      if (stated > 2 && /gauntlet|run|dossier/i.test(text.slice(Math.max(0, match.index - 60), match.index + 60))) {
        assert.equal(stated, stages, `${file}: "${match[0]}"`);
      }
    }
  }
});

test('every deep link into the workbench names a listed profile', () => {
  let links = 0;
  for (const [file, markup] of pages) {
    for (const match of markup.matchAll(/href="\/\?(?:profile|start)=([a-z0-9-]+)#workspace"/g)) {
      links += 1;
      if (match[1] === 'example') continue;
      assert.equal(reviewProfile(match[1]).listed, true, `${file}: ${match[0]}`);
    }
  }
  assert.ok(links >= 10, `${links} deep links`);
});

test('a page that names a profile in a workbench link uses the name the workbench shows', () => {
  // The link text of a profile deep link is the profile's own name, or a call to action. A different profile's name is a mistake.
  const names = new Map(PROFILES.map((profile) => [profile.name.toLowerCase(), profile.id]));
  for (const [file, markup] of pages) {
    for (const match of markup.matchAll(/<a[^>]*href="\/\?profile=([a-z0-9-]+)#workspace"[^>]*>([\s\S]*?)<\/a>/g)) {
      const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      for (const [name, id] of names) {
        if (label.startsWith(name)) assert.equal(id, match[1], `${file}: "${label}" links to ${match[1]}`);
      }
    }
  }
  assert.equal(reviewProfile('poc').name, 'Proof review');
});

test('a link that opens the review form is labelled by where it goes', () => {
  // One label for one destination (web/site/COMPONENTS.md, Button). A plain link to the form reads
  // "Start a free review". One that opens it on Challenge a draft report reads "Review my report",
  // as the footer of every page does, unless it takes along what the visitor pasted or stands in a
  // list of stages. The home page and /benchmark print controls of their own.
  const PLAIN = ['Start a free review', 'Copy a prompt'];
  const REPORT = ['Review my report', 'Challenge this draft', 'Run the full challenge on your model', 'Run this stage: Report'];
  let links = 0;
  for (const [file, markup] of pages) {
    if (file === 'index.html' || file === 'benchmark.html') continue;
    const main = markup.slice(markup.indexOf('<main'), markup.indexOf('</main>'));
    for (const match of main.matchAll(/<a[^>]*href="(\/#workspace|\/\?profile=report#workspace)"[^>]*>([\s\S]*?)<\/a>/g)) {
      links += 1;
      const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ :/g, ':').trim();
      assert.ok((match[1] === '/#workspace' ? PLAIN : REPORT).includes(label), `${file}: "${label}" links to ${match[1]}`);
    }
    // No link or button names the form by the name it has in the code.
    for (const match of main.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      assert.doesNotMatch(match[2].replace(/<[^>]+>/g, ' '), /workbench/i, file);
    }
  }
  assert.ok(links >= 20, `${links} links`);
  // The footer's own two: the button and the name of the place.
  const footer = pages.get('guide.html').slice(pages.get('guide.html').indexOf('<footer'));
  assert.match(footer, /href="\/\?profile=report#workspace"[^>]*>\s*<span class="btn__label">Review my report<\/span>/);
  assert.match(footer, /href="\/#workspace"[^>]*>Review a report<\/a>/);
});

test('every control that starts an account action sits on a page that loads the account script', () => {
  const handled = ['open', 'signin', 'checkout', 'billing'];
  let controls = 0;
  for (const [file, markup] of pages) {
    const actions = [...markup.matchAll(/data-account-action="([^"]*)"/g)].map((match) => match[1]);
    controls += actions.length;
    for (const action of actions) assert.ok(handled.includes(action), `${file}: ${action}`);
    if (actions.length) assert.match(markup, /<script type="module" src="\/app\/account\.mjs" fetchpriority="low"><\/script>/, file);
  }
  assert.ok(controls >= 2, 'the home page and the pricing page each carry a checkout button');
});

test('the pricing page starts checkout in place and shows the note a cancelled checkout comes back to', async () => {
  const pricing = pages.get('pricing.html');
  assert.match(pricing, /<button[^>]*id="upgrade"[^>]*data-account-action="checkout"|<button[^>]*data-account-action="checkout"[^>]*id="upgrade"/);
  assert.match(pricing, /data-checkout-note/);
  assert.match(pricing, /<link rel="stylesheet" href="\/css\/account\.css">/);
  for (const id of ['account-dialog', 'portal-dialog', 'reauth-dialog']) assert.match(pricing, new RegExp(`<dialog[^>]*id="${id}"`), id);
  // The Worker sends a cancelled checkout back to this page.
  const billing = await readFile(path.join(WEB_DIR, 'src', 'billing.ts'), 'utf8');
  assert.match(billing, /cancel_url: `\$\{origin\}\/pricing\?checkout=cancelled`/);
  // Off the home page, "Get Operator" goes to the pricing page, never to a section that needs a second click.
  for (const [file, markup] of pages) {
    if (file === 'index.html') continue;
    assert.doesNotMatch(markup, /href="\/#pricing"/, file);
  }
});

test('the limits a page states are the engine limits, with the line total', () => {
  const lines = LIMITS.totalLines.toLocaleString('en-US');
  assert.equal(lines, '20,000');
  for (const file of ['index.html', 'terms.html', 'mcp.html', 'your-model-your-key.html', 'challenge-report.html']) {
    const text = textOf(pages.get(file));
    if (/\b120 KB\b/.test(text)) assert.ok(text.includes(`${lines} lines`), `${file} states the per-file limit and leaves the line total out`);
  }
  assert.match(pages.get('index.html'), new RegExp(`id="wb-drop-limits">[^<]*${lines} lines`));
});

test('the MCP page describes both servers: five tools remote, six local', async () => {
  const { handleMcpMessage } = await import('../src/mcp.ts');
  const remote = (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {})).body.result.tools;
  const localSource = await readFile(path.join(REPO_DIR, 'mcp', 'src', 'tools.mjs'), 'utf8');
  const local = [...localSource.matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((match) => match[1]);
  assert.deepEqual(local.filter((name) => !remote.some((tool) => tool.name === name)), ['run_gauntlet_plan']);
  assert.equal(local.length, remote.length + 1);

  const mcp = textOf(pages.get('mcp.html'));
  for (const name of local) assert.ok(mcp.includes(name), name);
  assert.match(mcp, /The remote endpoint exposes five tools\./);
  assert.match(mcp, /The local server adds a sixth, run_gauntlet_plan , and reads files by path\./);
  assert.doesNotMatch(mcp, /same five tools|its five tools/);
  assert.match(mcp, /BOUNTY_OPERATOR_MODEL/);
  assert.match(mcp, /BOUNTY_OPERATOR_ROOT/);
  assert.match(pages.get('mcp.html'), /href="\/dl\/SHA256SUMS\.txt"/);

  // The remote endpoint describes every Context field the engine reads.
  const { CONTEXT_FIELDS } = await import('../public/evidence.mjs');
  const prepare = remote.find((tool) => tool.name === 'prepare_review');
  assert.deepEqual(Object.keys(prepare.inputSchema.properties.context.properties), CONTEXT_FIELDS.map((field) => field.key));
  assert.match(prepare.inputSchema.properties.files.description, /20,000 lines/);

  const llms = await readFile(path.join(WEB_DIR, 'public', 'llms.txt'), 'utf8');
  assert.match(llms, /run_gauntlet_plan/);
  assert.match(llms, /20,000 lines/);
});

test('the MCP download and its checksum list are one build', async () => {
  const { createHash } = await import('node:crypto');
  const dir = path.join(WEB_DIR, 'public', 'dl');
  const sums = await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.tgz'))) {
    const digest = createHash('sha256').update(await readFile(path.join(dir, name))).digest('hex');
    assert.ok(sums.includes(`${digest}  ${name}`), name);
  }
});

test('every event the app counts is one the Worker accepts', async () => {
  const { CLIENT_EVENTS: accepted } = await import('../src/funnel.ts');
  assert.deepEqual([...CLIENT_EVENTS].sort(), [...accepted].sort());
  const keys = new Set(CLIENT_EVENTS.map((name) => name.toUpperCase()));
  let used = 0;
  for (const file of (await readdir(APP_DIR)).filter((name) => name.endsWith('.mjs'))) {
    const source = await readFile(path.join(APP_DIR, file), 'utf8');
    for (const match of source.matchAll(/\btrack\(EVENTS\.([A-Z_]+)\)/g)) {
      used += 1;
      assert.ok(keys.has(match[1]), `${file}: EVENTS.${match[1]}`);
    }
  }
  assert.ok(used >= 10, `${used} track() calls`);
});

test('no leftover of the earlier release is deployed', async () => {
  const publicFiles = await readdir(path.join(WEB_DIR, 'public'));
  for (const name of ['app.mjs', 'style.css', '_headers', 'vendor', 'social.png', '_kit.html', 'ai-setup.md']) {
    assert.ok(!publicFiles.includes(name), name);
  }
  // No deployed file is named after a third party's method.
  for (const name of publicFiles) assertNoBannedNames(name, `web/public/${name}`);
  assert.ok(!publicFiles.some((name) => name.endsWith('.zip')));
});

test('button labels in the app carry no dash and one price', async () => {
  const prices = new Set();
  for (const file of (await readdir(APP_DIR)).filter((name) => name.endsWith('.mjs'))) {
    const source = await readFile(path.join(APP_DIR, file), 'utf8');
    assert.doesNotMatch(source, /label: [`'"][^`'"\n]*—/, file);
    for (const match of source.matchAll(/US\$\d+(?:\/| a | per )\w+/g)) prices.add(match[0]);
  }
  assert.deepEqual([...prices].sort(), ['US$10 a week']);
});
