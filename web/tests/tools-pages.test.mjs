// Tests for the free-tool pages: the page modules render under the site's
// rules, the embedded dataset matches its source, and the browser modules keep
// the promise the pages make ("Your content never leaves the browser."): the
// one request a tool page makes after loading is a counter that carries an
// event name from a fixed list and nothing else.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { modulePreloads, outputFile, validateMarkup } from '../../scripts/build-site.mjs';
import { textOf } from '../site/components.mjs';
import { renderPage } from '../site/layout.mjs';
import hub from '../site/pages/tools/index.mjs';
import reportCheck from '../site/pages/tools/report-check.mjs';
import verify from '../site/pages/tools/verify.mjs';
import secretCheck from '../site/pages/tools/secret-check.mjs';
import acceptanceRates, { DATASET, ROWS, SMALL_SAMPLE } from '../site/pages/tools/acceptance-rates.mjs';
import slitherFocus from '../site/pages/tools/slither-focus.mjs';
import { COUNTER_LINE, LOCAL_LINE, TOOLS } from '../site/pages/tools/_shared.mjs';
import { PING_EVENTS, ping } from '../public/tools/ping.mjs';
import { CHECKS } from '../public/tools/report-check-core.mjs';
import { DEFAULT_CHECKS } from '../public/tools/slither-focus-core.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const REPO_DIR = path.resolve(WEB_DIR, '..');

const PAGES = [hub, reportCheck, verify, secretCheck, acceptanceRates, slitherFocus];
const TOOL_PAGES = PAGES.slice(1);
const paths = new Set(PAGES.map((page) => page.path));

const isFile = (file) => existsSync(file) && statSync(file).isFile();
const resolves = (pathname) => paths.has(pathname) || pathname === '/' || isFile(path.join(PUBLIC_DIR, pathname)) || isFile(path.join(PUBLIC_DIR, `${pathname}.html`));
const site = { pages: PAGES, has: resolves, preloadsFor: () => [] };
const render = (page) => renderPage(page, site);
const mainOf = (markup) => markup.slice(markup.indexOf('<main'), markup.indexOf('</main>'));
const visibleText = (markup) => textOf(mainOf(markup).replace(/<script[\s\S]*?<\/script>/g, ''));

describe('tool pages', () => {
  test('six pages at the expected paths, in footer order', () => {
    assert.deepEqual(PAGES.map((page) => page.path), ['/tools', '/tools/report-check', '/tools/verify', '/tools/secret-check', '/tools/acceptance-rates', '/tools/slither-focus']);
    assert.deepEqual(TOOLS.map((entry) => entry.path), TOOL_PAGES.map((page) => page.path));
    assert.deepEqual(TOOL_PAGES.map((page) => page.order), [1, 2, 3, 4, 5]);
    assert.equal(new Set(PAGES.map((page) => page.title)).size, PAGES.length);
    assert.equal(outputFile(reportCheck.path), 'tools/report-check.html');
  });

  for (const page of PAGES) {
    test(`${page.path} renders within the site rules`, () => {
      const markup = render(page);
      const { errors, warnings, unresolved } = validateMarkup(markup, resolves);
      assert.deepEqual(errors, []);
      assert.deepEqual(warnings, []);
      assert.deepEqual(unresolved, [], 'every internal link resolves');

      assert.ok(page.description.length >= 50 && page.description.length <= 160, `description is ${page.description.length} characters`);
      assert.equal(page.nav, 'tools');
      assert.deepEqual(page.styles, ['/css/tools.css']);
      assert.match(page.lastmod, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal([...markup.matchAll(/<h1[\s>]/g)].length, 1);
      assert.match(markup, new RegExp(`<link rel="canonical" href="https://bountyoperator\\.com${page.path}">`));
      assert.equal(LOCAL_LINE, 'Your content never leaves the browser.');
      assert.ok(markup.includes(LOCAL_LINE), 'states that the content never leaves the browser');
      assert.doesNotMatch(visibleText(markup), /nothing is uploaded|nothing leaves/i, 'the old line is gone');
      assert.equal(page.jsonld[0]['@type'], 'BreadcrumbList');
      for (const script of page.scripts ?? []) assert.ok(isFile(path.join(PUBLIC_DIR, script)), `${script} exists`);
      // A page always ends in an action that leads to the workbench.
      assert.match(mainOf(markup), /class="btn btn--primary" href="\/(?:\?profile=[a-z-]+)?#workspace"/);
    });
  }

  test('the copy follows the voice rules', () => {
    for (const page of PAGES) {
      const text = `${visibleText(render(page))} ${page.title} ${page.description}`;
      const hedge = text.match(/\b(?:simply|powerful|not a guarantee|can help|we cannot|this is not an audit|may|might|seamless\w*|leverag\w*)\b/i);
      assert.equal(hedge, null, `${page.path}: "${hedge?.[0]}"`);
      assert.ok(!text.includes('!'), `${page.path}: no exclamation marks`);
      assertNoBannedNames(text, page.path, { page: page.path });
      // Fixed pricing: no price other than the two plans may appear in tool copy.
      assert.doesNotMatch(text, /\$\s?\d|free trial|discount/i, page.path);
    }
  });

  test('FAQ structured data repeats questions that are visible on the page', () => {
    for (const page of TOOL_PAGES) {
      const faq = page.jsonld.find((entry) => entry['@type'] === 'FAQPage');
      if (!faq) continue;
      const text = visibleText(render(page));
      for (const item of faq.mainEntity) {
        assert.ok(text.includes(item.name), `${page.path}: ${item.name}`);
        assert.ok(text.includes(item.acceptedAnswer.text.slice(0, 60)), `${page.path}: answer to ${item.name}`);
      }
    }
  });

  test('the hub lists every tool with its outcome', () => {
    const markup = mainOf(render(hub));
    for (const entry of TOOLS) {
      assert.ok(markup.includes(`href="${entry.path}"`), entry.path);
      assert.ok(textOf(markup).includes(textOf(entry.outcome)), entry.name);
    }
    const list = hub.jsonld.find((entry) => entry['@type'] === 'ItemList');
    assert.equal(list.itemListElement.length, TOOLS.length);
  });

  test('report check: the page table is built from the checks the browser runs', () => {
    const text = visibleText(render(reportCheck));
    for (const check of CHECKS) {
      assert.ok(text.includes(check.label), check.label);
      assert.ok(text.includes(check.fix), check.id);
    }
    assert.match(text, /of 17 checks pass/);
    const markup = render(reportCheck);
    assert.equal([...markup.matchAll(/<li class="check" data-status="pending">/g)].length, CHECKS.length);
    assert.match(markup, /id="check-handoff"[^>]*|href="\/\?profile=report#workspace" id="check-handoff"/);
  });

  test('slither focus: the detector table lists the curated set', () => {
    const markup = mainOf(render(slitherFocus));
    for (const check of DEFAULT_CHECKS) assert.ok(markup.includes(`<code>${check}</code>`), check);
    assert.match(markup, /href="\/\?profile=scanner#workspace"/);
  });
});

describe('acceptance rates', () => {
  const source = JSON.parse(readFileSync(path.join(REPO_DIR, 'bounty_operator_kit', 'data', 'vulnerability_acceptance_rates.json'), 'utf8'));
  const markup = mainOf(render(acceptanceRates));

  test('the embedded data matches the dataset file, without the duplicated count', () => {
    for (const key of ['source', 'license', 'upstream', 'methodology_url', 'last_updated', 'contests_included', 'total_findings', 'total_accepted', 'note']) {
      assert.deepEqual(DATASET[key], source[key], key);
    }
    assert.deepEqual(Object.keys(DATASET.patterns), Object.keys(source.patterns));
    for (const [tag, stats] of Object.entries(source.patterns)) {
      const { duplicated, ...kept } = stats;
      assert.equal(typeof duplicated, 'number');
      assert.deepEqual(DATASET.patterns[tag], kept, tag);
    }
  });

  test('every row shows its rate, n and accepted count, and has an anchor and a copy button', () => {
    assert.equal(ROWS.length, 12);
    for (const row of ROWS) {
      const stats = source.patterns[row.tag];
      const cells = markup.match(new RegExp(`<tr id="${row.tag}"[^>]*>([\\s\\S]*?)</tr>`));
      assert.ok(cells, row.tag);
      const text = textOf(cells[1]);
      assert.ok(text.includes(`${Math.round(stats.acceptance_rate * 100)}%`), `${row.tag} rate`);
      assert.match(cells[1], new RegExp(`<td class="num">${stats.total}</td>`), `${row.tag} n`);
      assert.match(cells[1], new RegExp(`<td class="num">${stats.accepted}</td>`), `${row.tag} accepted`);
      assert.match(cells[1], new RegExp(`href="#${row.tag}"`));
      assert.match(cells[1], new RegExp(`data-copy-row="${row.tag}"`));
      assert.equal(/Small sample/.test(text), stats.total < SMALL_SAMPLE, `${row.tag} small-sample mark`);
    }
  });

  test('rows start sorted by rate and samples under 20 are marked', () => {
    assert.deepEqual(ROWS.slice(0, 3).map((row) => row.tag), ['reentrancy', 'overflow', 'trusted-actor']);
    assert.equal(ROWS.at(-1).tag, 'liquidation');
    assert.deepEqual(ROWS.filter((row) => row.small).map((row) => row.tag).sort(), ['flash-loan', 'liquidation']);
    assert.match(markup, /aria-sort="descending" data-sort-key="rate"/);
  });

  test('nothing sums the rows, charts them or shows the duplicated count', () => {
    const text = textOf(markup);
    const summed = Object.values(source.patterns).reduce((total, stats) => total + stats.total, 0);
    assert.notEqual(summed, source.total_findings, 'the tags overlap');
    assert.ok(!text.includes(String(summed)) && !text.includes(summed.toLocaleString('en-US')));
    assert.doesNotMatch(markup, /duplicat/i);
    assert.doesNotMatch(markup, /<(?:svg|canvas|progress|meter)[\s>]/);
  });

  test('one methodology line carries the source, the upstream link and the licence', () => {
    const line = markup.match(/<p class="tool-table__foot" id="method">([\s\S]*?)<\/p>/);
    assert.ok(line);
    assert.ok(line[1].includes(`href="${source.upstream}"`));
    assert.ok(line[1].includes(`href="${source.methodology_url}"`));
    const text = textOf(line[1]);
    assert.match(text, /Sherlock/);
    assert.match(text, /licence CC0/);
    assert.match(text, /rows overlap/);
    const dataset = acceptanceRates.jsonld.find((entry) => entry['@type'] === 'Dataset');
    assert.equal(dataset.isBasedOn, source.upstream);
    assert.equal(dataset.license, 'https://creativecommons.org/publicdomain/zero/1.0/');
  });
});

describe('tool browser modules', () => {
  const toolsDir = path.join(PUBLIC_DIR, 'tools');
  const modules = readdirSync(toolsDir).filter((name) => name.endsWith('.mjs'));
  const read = (name) => readFileSync(path.join(toolsDir, name), 'utf8');

  const NETWORK = /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\.src\s*=/;

  test('no markup injection, and no network call outside the name-only counter', () => {
    assert.ok(modules.length >= 11);
    assert.ok(modules.includes('ping.mjs'));
    for (const name of modules) {
      const source = read(name);
      assert.doesNotMatch(source, /\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, name);
      if (name !== 'ping.mjs') assert.doesNotMatch(source, NETWORK, name);
    }
  });

  test('the counter module makes one kind of request: the event name to /api/event', () => {
    const source = read('ping.mjs');
    assert.equal([...source.matchAll(/\bfetch\(/g)].length, 1);
    assert.match(source, /const EVENT_PATH = '\/api\/event';/);
    assert.match(source, /fetch\(EVENT_PATH, \{/);
    assert.match(source, /body: JSON\.stringify\(\{ event \}\),/);
    assert.match(source, /credentials: 'omit',/);
    assert.doesNotMatch(source, /XMLHttpRequest|sendBeacon|WebSocket|EventSource|document\.|location|localStorage|sessionStorage|navigator\./);
    // It reads nothing back: the promise is only given a catch.
    assert.doesNotMatch(source, /\.then\(|await /);
  });

  test('every name the counter may send is one the Worker accepts, and each tool sends its own', async () => {
    const { CLIENT_EVENTS } = await import('../src/funnel.ts');
    for (const name of PING_EVENTS) assert.ok(CLIENT_EVENTS.has(name), name);
    assert.deepEqual([...PING_EVENTS], ['tool_report_check', 'tool_secret_check', 'tool_slither_focus', 'tool_verify', 'tool_acceptance_rates', 'template_copied', 'mcp_command_copied']);

    // A page script calls ping with a string literal from the list, never with a value it computed.
    const expected = {
      'report-check.mjs': 'tool_report_check',
      'secret-check.mjs': 'tool_secret_check',
      'slither-focus.mjs': 'tool_slither_focus',
      'verify.mjs': 'tool_verify',
      'acceptance-rates.mjs': 'tool_acceptance_rates',
    };
    for (const name of modules.filter((file) => file !== 'ping.mjs')) {
      const calls = [...read(name).matchAll(/\bping\(([^)]*)\)/g)].map((match) => match[1]);
      // A tool reports its own name and no other, from every place it reports.
      assert.deepEqual([...new Set(calls)], expected[name] ? [`'${expected[name]}'`] : [], name);
    }
    // Acceptance rates takes no input: its first sort or copy is what counts as a use.
    assert.equal([...read('acceptance-rates.mjs').matchAll(/\bping\('tool_acceptance_rates'\)/g)].length, 2);
    const others = {
      'templates/template.mjs': "'template_copied'",
      'docs/copy-ping.mjs': "'mcp_command_copied'",
    };
    for (const [file, literal] of Object.entries(others)) {
      const source = readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
      const calls = [...source.matchAll(/\bping\(([^)]*)\)/g)].map((match) => match[1]);
      assert.ok(calls.length >= 1, file);
      for (const call of calls) assert.equal(call, literal, file);
      assert.doesNotMatch(source, NETWORK, `${file} makes no request of its own`);
    }
  });

  test('ping sends the name and nothing else, once per page load, and drops any other value', () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      calls.push({ url, init });
      return Promise.reject(new Error('offline'));
    };
    try {
      assert.equal(ping('tool_verify'), true);
      assert.equal(ping('tool_verify'), false, 'a second call in the same page load sends nothing');
      assert.equal(ping('made_up_event'), false);
      assert.equal(ping('tool_verify\n0x5e1d'), false);
      assert.equal(ping({ event: 'tool_verify', draft: 'text' }), false);
      assert.equal(ping(undefined), false);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls.length, 1);
    const [{ url, init }] = calls;
    assert.equal(url, '/api/event');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.keepalive, true);
    assert.equal(init.body, '{"event":"tool_verify"}');
    assert.deepEqual(Object.keys(init).sort(), ['body', 'cache', 'credentials', 'headers', 'keepalive', 'method']);
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
  });

  test('the Worker counts the request the counter builds, once per name, and only from the site', async () => {
    const { default: worker } = await import('../src/worker.ts');
    const { SITE_ORIGIN, createContext, createEnv, funnelCounts } = await import('./worker-helpers.mjs');
    // A fresh copy of the module: the one imported above has already sent a name.
    const fresh = await import('../public/tools/ping.mjs?worker-contract');

    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    try {
      for (const name of fresh.PING_EVENTS) assert.equal(fresh.ping(name), true, name);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls.length, PING_EVENTS.length);

    const env = createEnv();
    const ctx = createContext();
    // The browser adds Origin to a same-origin POST; the page script cannot set or drop it.
    const send = ({ url, init }, origin) =>
      worker.fetch(new Request(`${SITE_ORIGIN}${url}`, { ...init, headers: { ...init.headers, ...(origin ? { Origin: origin } : {}) } }), env, ctx);

    for (const call of calls) {
      const response = await send(call, SITE_ORIGIN);
      assert.equal(response.status, 204, call.init.body);
      assert.equal(await response.text(), '');
    }
    await ctx.settled();
    assert.deepEqual(funnelCounts(env.DB), Object.fromEntries([...PING_EVENTS].sort().map((name) => [name, 1])));

    assert.equal((await send(calls[0], 'https://example.com')).status, 403);
    assert.equal((await send(calls[0])).status, 403);
    await ctx.settled();
    assert.equal(funnelCounts(env.DB)[PING_EVENTS[0]], 1, 'a request from anywhere else is not counted');
  });

  test('each tool page says once what it does send', () => {
    for (const page of TOOL_PAGES) {
      const text = visibleText(render(page));
      const count = text.split(COUNTER_LINE).length - 1;
      assert.equal(count, 1, page.path);
    }
  });

  test('engine functions are imported, not copied', () => {
    assert.match(read('report-check-core.mjs'), /import \{[^}]*splitLines[^}]*\} from '\.\.\/review-core\.mjs'/);
    assert.match(read('report-check-core.mjs'), /import \{ scanFile \} from '\.\/secret-check-core\.mjs'/);
    assert.match(read('report-evidence-core.mjs'), /import \{[^}]*manifestFor[^}]*splitLines[^}]*\} from '\.\.\/review-core\.mjs'/);
    assert.match(read('secret-check-core.mjs'), /import \{[^}]*checkInputs[^}]*\} from '\.\.\/review-core\.mjs'/);
    assert.match(read('verify-core.mjs'), /import \{ manifestFor \} from '\.\.\/review-core\.mjs'/);
    for (const name of modules) {
      assert.doesNotMatch(read(name), /crypto\.subtle|SECRET_PATTERNS|BEGIN \[A-Z \]/, `${name} re-implements nothing from the engine`);
    }
  });

  test('page scripts preload the modules they import', async () => {
    const reportCheckPreloads = await modulePreloads(['/tools/report-check.mjs'], PUBLIC_DIR);
    assert.deepEqual(reportCheckPreloads.slice(0, 5), ['/tools/report-check-core.mjs', '/tools/dom.mjs', '/tools/ping.mjs', '/tools/report-evidence-core.mjs', '/review-core.mjs']);
    assert.deepEqual(await modulePreloads(['/tools/acceptance-rates.mjs'], PUBLIC_DIR), ['/tools/dom.mjs', '/tools/ping.mjs']);
    assert.deepEqual(await modulePreloads(['/tools/slither-focus.mjs'], PUBLIC_DIR), ['/tools/slither-focus-core.mjs', '/tools/dom.mjs', '/tools/ping.mjs']);
  });

  test('tools.css uses tokens only', () => {
    const css = readFileSync(path.join(PUBLIC_DIR, 'css', 'tools.css'), 'utf8');
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'no hex colour outside the token blocks');
    assert.doesNotMatch(css, /\b(?:rgb|hsl)a?\(/);
    assert.doesNotMatch(css, /font-size:\s*(?:\d|\.)/, 'font sizes are tokens');
    // Every rule is scoped to a class: no bare element selectors.
    for (const [, selector] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
      if (selector.trim().startsWith('@')) continue;
      for (const part of selector.split(',')) {
        assert.match(part.trim(), /^\./, `selector "${part.trim()}" starts with a class`);
      }
    }
  });
});
