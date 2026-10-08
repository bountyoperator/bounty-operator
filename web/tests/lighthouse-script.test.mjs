// scripts/lighthouse.mjs: what it asks for and how it reads a Lighthouse
// result. No network and no browser: the engine is replaced by a function,
// and the API by a stub.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CATEGORIES, ENDPOINT, LIGHTHOUSE, MAIN_PATHS, failureLine, localArguments, lowestScore, npxCommand, parseArguments, requestUrl, runLighthouse, scoreLine, sitemapPaths, summarise,
} from '../../scripts/lighthouse.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITEMAP = readFileSync(path.join(WEB_DIR, 'public', 'sitemap.xml'), 'utf8');
const SCRIPT = readFileSync(path.join(WEB_DIR, '..', 'scripts', 'lighthouse.mjs'), 'utf8');

// A Lighthouse result cut down to the fields the script reads.
const RESULT = {
  lighthouseVersion: '13.5.0',
  categories: {
    performance: {
      score: 0.874,
      auditRefs: [
        { id: 'largest-contentful-paint', weight: 25, group: 'metrics' },
        { id: 'render-blocking-insight', weight: 0, group: 'insights' },
        { id: 'unused-javascript', weight: 0, group: 'diagnostics' },
        { id: 'first-meaningful-paint', weight: 0, group: 'hidden' },
      ],
    },
    accessibility: { score: 1, auditRefs: [{ id: 'color-contrast', weight: 7 }, { id: 'target-size', weight: 7 }] },
    'best-practices': { score: 0.96, auditRefs: [{ id: 'target-size', weight: 1 }, { id: 'errors-in-console', weight: 1 }] },
    seo: { score: null, auditRefs: [{ id: 'structured-data', weight: 0 }] },
  },
  audits: {
    'largest-contentful-paint': { title: 'Largest Contentful Paint', score: 0.6, scoreDisplayMode: 'numeric', displayValue: '3.1\u00a0s' },
    'cumulative-layout-shift': { title: 'Cumulative Layout Shift', score: 1, scoreDisplayMode: 'numeric', displayValue: '0' },
    'render-blocking-insight': { title: 'Render blocking requests', score: 0.5, scoreDisplayMode: 'metricSavings', displayValue: 'Est savings of 150\u00a0ms' },
    'unused-javascript': { title: 'Reduce unused JavaScript', score: 1, scoreDisplayMode: 'metricSavings' },
    'first-meaningful-paint': { title: 'First Meaningful Paint', score: 0.2, scoreDisplayMode: 'numeric' },
    'color-contrast': { title: 'Background and foreground colors have a sufficient contrast ratio', score: 1, scoreDisplayMode: 'binary' },
    'target-size': { title: 'Touch targets do not have sufficient size or spacing', score: 0, scoreDisplayMode: 'binary' },
    'errors-in-console': { title: 'Browser errors were logged to the console', score: 0, scoreDisplayMode: 'informative' },
    'structured-data': { title: 'Structured data is valid', score: null, scoreDisplayMode: 'manual' },
  },
};

test('the arguments: paths, one form factor, a floor, a file, another origin, the API', () => {
  assert.deepEqual(parseArguments([]), { paths: [], all: false, strategies: ['mobile', 'desktop'], min: null, json: '', baseUrl: 'https://bountyoperator.com', engine: 'local' });
  const options = parseArguments(['/', '/pricing', '--mobile', '--min', '90', '--json', 'out.json', '--base-url', 'http://localhost:8787/any/path', '--psi']);
  assert.deepEqual(options, { paths: ['/', '/pricing'], all: false, strategies: ['mobile'], min: 90, json: 'out.json', baseUrl: 'http://localhost:8787', engine: 'psi' });
  assert.deepEqual(parseArguments(['--desktop', '--all']).strategies, ['desktop']);
  assert.equal(parseArguments(['/?ref=x']).paths[0], '/?ref=x');
  assert.equal(parseArguments(['--base-url', 'http://[::1]:8787']).baseUrl, 'http://[::1]:8787');
  assert.equal(parseArguments(['--base-url', 'https://staging.example.org']).baseUrl, 'https://staging.example.org');

  const bad = [
    ['pricing'], ['--min'], ['--min', '101'], ['--min', '9.5'], ['--all', '/'], ['--unknown'],
    ['--base-url', 'ftp://example.com'], ['--base-url', 'not a url'], ['--base-url'],
    // A flag where a value belongs is a forgotten value.
    ['--json', '--psi'], ['--base-url', '--all'], ['--min', '--mobile'],
  ];
  for (const argv of bad) assert.throws(() => parseArguments(argv), undefined, argv.join(' '));
});

test('an address or a path that could mean something to a shell is refused, and no shell is started at all', () => {
  for (const path of ['/a b', '/a&calc', '/a|b', '/a;b', '/a`b`', '/$(x)', '/a"b', "/a'b", '/a>b', '/a^b', '/a%20b', '/a?b=1&c=2', '/a\\b']) {
    assert.throws(() => parseArguments([path]), /Not a path this script measures/, path);
  }
  // A host name may hold these by the URL standard; none is a plain host name.
  for (const origin of ['http://x&calc', 'http://a;b', "http://a'b", 'http://a$(id)', 'http://a`id`', 'http://a"b', 'http://a(b)', 'http://a!b', 'http://%26calc']) {
    assert.throws(() => parseArguments(['--base-url', origin]), undefined, origin);
  }
  // Every page of the site passes the same check, and a sitemap that lists anything else stops the run.
  for (const path of sitemapPaths(SITEMAP)) assert.doesNotThrow(() => parseArguments([path]), path);
  assert.throws(() => sitemapPaths('<loc>https://example.org/a&calc</loc>'), /does not measure/);
  // The fence that matters: the child process is started from an array, never through a shell.
  assert.doesNotMatch(SCRIPT, /shell:\s*(?:true|process)/);
  assert.doesNotMatch(SCRIPT, /\bexec(?:Sync)?\(|spawnSync\(/);
});

test('npx is started without a shell: this Node runs npm’s own script, and Windows without it is refused', () => {
  const home = path.dirname(process.execPath);
  // The layout of a Windows install: node.exe with node_modules beside it.
  const beside = path.join(home, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  assert.deepEqual(npxCommand({ execPath: process.execPath, platform: 'win32', exists: (file) => file === beside }), { command: process.execPath, prefix: [beside] });
  // The layout of a Unix install: bin/node with lib/node_modules one level up.
  const above = path.join(home, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  assert.deepEqual(npxCommand({ execPath: process.execPath, platform: 'linux', exists: (file) => file === above }), { command: process.execPath, prefix: [above] });

  // Without the script: `npx` itself where that is a program, and a refusal where it is a command file.
  assert.deepEqual(npxCommand({ execPath: process.execPath, platform: 'linux', exists: () => false }), { command: 'npx', prefix: [] });
  assert.throws(() => npxCommand({ execPath: process.execPath, platform: 'win32', exists: () => false }), /not beside this Node/);
});

test('the main pages are pages of the site, and the sitemap gives paths for any origin', () => {
  const paths = sitemapPaths(SITEMAP);
  assert.ok(paths.length >= 30);
  assert.ok(paths.includes('/') && paths.every((entry) => entry.startsWith('/')));
  for (const entry of MAIN_PATHS) assert.ok(paths.includes(entry), `${entry} is in the sitemap`);
  assert.deepEqual(sitemapPaths('<loc>https://example.org/a</loc><loc>https://example.org/b/c</loc>'), ['/a', '/b/c']);
});

test('the API request names the page, the form factor and the four categories; the key is optional', () => {
  const url = requestUrl('https://bountyoperator.com/pricing', 'mobile');
  assert.equal(`${url.origin}${url.pathname}`, ENDPOINT);
  assert.equal(url.searchParams.get('url'), 'https://bountyoperator.com/pricing');
  assert.equal(url.searchParams.get('strategy'), 'MOBILE');
  assert.deepEqual(url.searchParams.getAll('category'), ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']);
  assert.equal(url.searchParams.has('key'), false);
  assert.equal(requestUrl('https://bountyoperator.com/', 'desktop', 'k-123').searchParams.get('key'), 'k-123');
  assert.equal(requestUrl('https://bountyoperator.com/', 'desktop').searchParams.get('strategy'), 'DESKTOP');
});

test('the local run is one pinned release, headless, the same four categories, with the desktop preset only for a desktop', () => {
  assert.match(LIGHTHOUSE, /^lighthouse@\d+\.\d+\.\d+$/, 'an exact version, not a range');
  const phone = localArguments('https://bountyoperator.com/', 'mobile');
  assert.deepEqual(phone.slice(0, 3), ['--yes', LIGHTHOUSE, 'https://bountyoperator.com/']);
  assert.ok(phone.includes('--output=json') && phone.includes('--output-path=stdout') && phone.includes('--quiet'));
  assert.ok(phone.includes(`--only-categories=${CATEGORIES.map((category) => category.id).join(',')}`));
  assert.ok(phone.includes('--chrome-flags=--headless=new'));
  assert.ok(!phone.includes('--preset=desktop'));
  assert.ok(localArguments('https://bountyoperator.com/', 'desktop').includes('--preset=desktop'));
});

test('a result is read as scores out of 100, the lab metrics, and the audits that did not pass', () => {
  const summary = summarise(RESULT);
  assert.equal(summary.version, '13.5.0');
  assert.deepEqual(summary.scores, { performance: 87, accessibility: 100, 'best-practices': 96, seo: null });
  assert.deepEqual(summary.metrics, { LCP: '3.1 s', CLS: '0' });
  assert.equal(summary.error, '');
  assert.deepEqual(summary.failed, [
    // Failed in two categories, listed once.
    { id: 'target-size', title: 'Touch targets do not have sufficient size or spacing', score: 0, value: '', categories: ['Accessibility', 'Best practices'] },
    { id: 'render-blocking-insight', title: 'Render blocking requests', score: 0.5, value: 'Est savings of 150\u00a0ms', categories: ['Performance'] },
  ]);
  // Left out: a metric (it has its own line), a hidden audit, an informative one, a manual one, and every pass.
  const ids = summary.failed.map((audit) => audit.id);
  for (const id of ['largest-contentful-paint', 'first-meaningful-paint', 'errors-in-console', 'structured-data', 'unused-javascript', 'color-contrast']) assert.ok(!ids.includes(id), id);
  assert.equal(scoreLine(summary.scores), 'Performance 87 · Accessibility 100 · Best practices 96 · SEO n/a');
});

test('a result with no score is not a measurement, and the error Lighthouse names is the one reported', () => {
  for (const empty of [undefined, null, {}, { categories: {} }, { categories: { performance: { score: null } } }]) {
    assert.deepEqual(summarise(empty), { version: '', scores: { performance: null, accessibility: null, 'best-practices': null, seo: null }, metrics: {}, failed: [], error: 'Lighthouse returned no scores.' });
  }
  assert.equal(summarise({ runtimeError: { code: 'NO_FCP', message: 'The page did not paint any content.' } }).error, 'The page did not paint any content.');
  // One score is enough to be a measurement.
  assert.equal(summarise({ categories: { seo: { score: 1 } } }).error, '');
});

test('when Lighthouse fails, the line that says why is picked out of its error output', () => {
  const stderr = 'Runtime error encountered: No Chrome installations found.\n    at Launcher.launch (file:///x/chrome-launcher.js:1:1)\n    at async main (file:///x/cli.js:2:2)\n';
  assert.equal(failureLine(stderr), 'Runtime error encountered: No Chrome installations found.');
  assert.equal(failureLine('npm error code E404\nnpm error 404 Not Found\n'), 'npm error 404 Not Found');
  assert.equal(failureLine('LighthouseError: PROTOCOL_TIMEOUT\n  at x\n'), 'LighthouseError: PROTOCOL_TIMEOUT');
  assert.equal(failureLine(''), '');
});

test('every page is measured on every form factor, a failure is kept beside the results, and the lowest score is found', async () => {
  const asked = [];
  const seen = [];
  const results = await runLighthouse({
    baseUrl: 'https://bountyoperator.com',
    paths: ['/', '/pricing'],
    strategies: ['mobile', 'desktop'],
    measure: async (pageUrl, strategy) => {
      asked.push(`${pageUrl} ${strategy}`);
      if (pageUrl.endsWith('/pricing') && strategy === 'desktop') throw new Error('Lighthouse wrote no result (exit 1).');
      if (pageUrl.endsWith('/pricing')) return summarise({ runtimeError: { message: 'The page did not paint any content.' } });
      return summarise(RESULT);
    },
    onResult: (entry) => seen.push(`${entry.path} ${entry.strategy} ${entry.ok}`),
  });
  assert.deepEqual(asked, ['https://bountyoperator.com/ mobile', 'https://bountyoperator.com/ desktop', 'https://bountyoperator.com/pricing mobile', 'https://bountyoperator.com/pricing desktop']);
  assert.deepEqual(seen, ['/ mobile true', '/ desktop true', '/pricing mobile false', '/pricing desktop false']);
  assert.deepEqual(results.filter((entry) => !entry.ok).map((entry) => entry.detail), ['The page did not paint any content.', 'Lighthouse wrote no result (exit 1).']);
  assert.equal(results[0].scores.performance, 87);
  assert.equal(lowestScore(results), 87);
  assert.equal(lowestScore(results.filter((entry) => !entry.ok)), null);
});

test('through the API: the key goes in the request and never into what is printed or written', async () => {
  const KEY = 'AIzaSyTESTKEY0123456789';
  const requests = [];
  const waits = [];
  const answers = [
    // Busy once, then a result.
    () => new Response('{"error":{"code":503,"message":"Backend error"}}', { status: 503 }),
    () => Response.json({ lighthouseResult: RESULT }),
    // Google echoing the key back in an error.
    () => new Response(`{"error":{"code":400,"message":"API key not valid: ${KEY}"}}`, { status: 400 }),
    // A spent daily quota is not asked again.
    () => new Response('{"error":{"code":429,"message":"Quota exceeded for quota metric \'Queries\' and limit \'Queries per day\'"}}', { status: 429 }),
    // The network failing with the address in the message, three times.
    () => { throw new Error(`fetch failed for ${requestUrl('https://bountyoperator.com/guide', 'mobile', KEY)}`); },
    () => { throw new Error(`fetch failed for key=${KEY}`); },
    () => { throw new Error(`fetch failed for key=${KEY}`); },
  ];
  const results = await runLighthouse({
    baseUrl: 'https://bountyoperator.com',
    paths: ['/', '/pricing', '/benchmark', '/guide'],
    strategies: ['mobile'],
    engine: 'psi',
    key: KEY,
    fetchImpl: async (url) => {
      requests.push(url);
      return answers[requests.length - 1]();
    },
    wait: async (ms) => { waits.push(ms); },
  });

  assert.equal(requests.length, 7);
  for (const url of requests) assert.equal(url.searchParams.get('key'), KEY, 'every request carries the key');
  assert.deepEqual(results.map((entry) => entry.ok), [true, false, false, false]);
  assert.equal(results[0].scores.performance, 87, 'the result after one busy answer');
  assert.match(results[1].detail, /^HTTP 400: .*API key not valid: \[key\]/);
  assert.match(results[2].detail, /^HTTP 429: .*Queries per day/);
  assert.match(results[3].detail, /^fetch failed for key=\[key\]$/);
  // One wait after the busy answer, none after the 400 or the spent quota, one after each network failure.
  assert.deepEqual(waits, [15000, 5000, 10000, 15000]);
  assert.ok(!JSON.stringify(results).includes(KEY), 'the key is in no result, so in no printed line and no --json file');
});
