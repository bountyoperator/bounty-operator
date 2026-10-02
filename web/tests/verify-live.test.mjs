// scripts/verify-live.mjs, run against the Worker's own fetch handler with the
// files of web/public behind it. No network: the script's fetch is replaced by
// a function that hands each request to the Worker in this process.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONTENT_SECURITY_POLICY, HTML_CACHE, SECURITY_HEADERS } from '../src/http.ts';
import { PROFILE_SOURCE } from '../src/operator-profiles.generated.mjs';
import worker from '../src/worker.ts';
import {
  EXPECTED_CSP, EXPECTED_HEADERS, EXPECTED_HTML_CACHE, MCP_TOOLS, foreignScripts, headerProblems, parseSums, profilesProblems, sitemapLocations, titleOf, verifyLive,
} from '../../scripts/verify-live.mjs';
import { SITE_ORIGIN, createContext, createEnv } from './worker-helpers.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const SCRIPT = path.join(WEB_DIR, '..', 'scripts', 'verify-live.mjs');
const VERSION = JSON.parse(readFileSync(path.join(WEB_DIR, 'package.json'), 'utf8')).version;
const EDITION = PROFILE_SOURCE === 'private' ? 'hosted' : 'community';
const ALIAS = 'https://alias.example';

const TYPES = { html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml', mjs: 'text/javascript', css: 'text/css', json: 'application/json' };

/** The assets binding: a file of web/public by its path, a page without its extension, or the 404 page. */
function assets() {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      for (const candidate of [relative, `${relative}.html`]) {
        const file = path.join(PUBLIC_DIR, candidate);
        if (file.startsWith(PUBLIC_DIR) && existsSync(file) && statSync(file).isFile()) {
          const type = TYPES[candidate.split('.').pop()];
          return new Response(readFileSync(file), { headers: type ? { 'Content-Type': type } : {} });
        }
      }
      return new Response(readFileSync(path.join(PUBLIC_DIR, '404.html')), { status: 404, headers: { 'Content-Type': TYPES.html } });
    },
  };
}

/** A fetch that reaches the Worker in this process. `change(url, response)` may replace an answer. */
function siteFetch(change = null) {
  const env = createEnv({ ASSETS: assets() });
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push(`${init.method ?? 'GET'} ${url}`);
    const ctx = createContext();
    const { signal, redirect, ...rest } = init;
    const response = await worker.fetch(new Request(url, rest), env, ctx);
    await ctx.settled();
    return change ? ((await change(new URL(url), response)) ?? response) : response;
  };
  return { fetch, seen };
}

const failed = (results) => results.filter((result) => !result.ok).map((result) => result.name);

test('the script expects the headers the Worker sets, and the tools the endpoint lists', async () => {
  assert.equal(EXPECTED_CSP, CONTENT_SECURITY_POLICY);
  assert.deepEqual(EXPECTED_HEADERS, Object.fromEntries(Object.entries(SECURITY_HEADERS).map(([name, value]) => [name.toLowerCase(), value])));
  assert.equal(EXPECTED_HTML_CACHE, HTML_CACHE);

  const { handleMcpMessage } = await import('../src/mcp.ts');
  const listed = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {});
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), [...MCP_TOOLS]);
});

test('the site as this checkout builds it passes every check', async () => {
  const { fetch, seen } = siteFetch();
  const results = await verifyLive({ baseUrl: SITE_ORIGIN, alias: ALIAS, profiles: EDITION, version: VERSION, fetch });
  assert.deepEqual(results.filter((result) => !result.ok), []);
  assert.deepEqual(
    results.map((result) => result.name.replace(/^\d+ sitemap pages/, 'N sitemap pages')),
    [
      '/api/health',
      'security headers on /',
      'security headers on /guide',
      '/.well-known/security.txt',
      '/robots.txt',
      '/sitemap.xml',
      'N sitemap pages: 200, a <title>, no foreign script',
      `redirect from ${ALIAS}`,
      '/api/profiles carries no instruction text',
      'MCP initialize',
      'MCP tools/list',
      '/dl/SHA256SUMS.txt matches the served tarball',
    ],
  );

  // Read-only: GET everywhere, and the two MCP calls that need no account.
  assert.deepEqual([...new Set(seen.filter((entry) => !entry.startsWith('GET ')))], [`POST ${SITE_ORIGIN}/api/mcp`]);
  const pages = sitemapLocations(readFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), 'utf8'));
  assert.ok(pages.length >= 30);
  for (const page of pages) assert.ok(seen.includes(`GET ${page}`), page);
  assert.ok(seen.includes(`GET ${SITE_ORIGIN}/dl/bounty-operator-mcp.tgz`));
});

test('without --alias the redirect is not checked', async () => {
  const results = await verifyLive({ baseUrl: SITE_ORIGIN, profiles: EDITION, version: VERSION, fetch: siteFetch().fetch });
  assert.deepEqual(failed(results), []);
  assert.ok(!results.some((result) => result.name.startsWith('redirect')));
});

test('each thing that can be wrong on a live site fails its own check', async () => {
  const run = async (change, options = {}) => failed(await verifyLive({ baseUrl: SITE_ORIGIN, alias: ALIAS, profiles: EDITION, version: VERSION, fetch: siteFetch(change).fetch, ...options }));
  const withBody = async (response, edit) => new Response(edit(await response.text()), { status: response.status, headers: response.headers });
  const withHeaders = (response, edit) => {
    const headers = new Headers(response.headers);
    edit(headers);
    return new Response(response.body, { status: response.status, headers });
  };

  // The version, the database, the edition.
  assert.deepEqual(await run(null, { version: '9.9.9' }), ['/api/health', 'MCP initialize', '/dl/SHA256SUMS.txt matches the served tarball']);
  assert.deepEqual(await run(null, { profiles: EDITION === 'hosted' ? 'community' : 'hosted' }), ['/api/health']);
  assert.deepEqual(await run((url, response) => (url.pathname === '/api/health' ? withBody(response, (text) => text.replace('"db":"ok"', '"db":"error"')) : null)), ['/api/health']);

  // A header dropped or changed on one page.
  // The home page is also a sitemap page, so the missing policy is reported there too.
  const noPolicy = await run((url, response) => (url.pathname === '/' ? withHeaders(response, (headers) => headers.delete('Content-Security-Policy')) : null));
  assert.deepEqual(noPolicy.map((name) => name.replace(/^\d+/, 'N')), ['security headers on /', 'N sitemap pages: 200, a <title>, no foreign script']);
  assert.deepEqual(await run((url, response) => (url.pathname === '/guide' ? withHeaders(response, (headers) => headers.set('Cache-Control', 'public, max-age=3600')) : null)), ['security headers on /guide']);

  // A script the proxy injected, on one page of the sitemap.
  const beacon = '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script></body>';
  const injected = await run((url, response) => (url.pathname === '/pricing' ? withBody(response, (html) => html.replace('</body>', beacon)) : null));
  assert.deepEqual(injected.map((name) => name.replace(/^\d+/, 'N')), ['N sitemap pages: 200, a <title>, no foreign script']);

  // A page that is gone, and a page with no title.
  const gone = await run((url) => (url.pathname === '/method' ? new Response('gone', { status: 404, headers: { 'Content-Type': 'text/html' } }) : null));
  assert.equal(gone.length, 1);
  assert.match(gone[0], /sitemap pages/);

  // The well-known files.
  assert.deepEqual(await run((url, response) => (url.pathname === '/.well-known/security.txt' ? withBody(response, (text) => text.replace(/^Expires: .*$/m, 'Expires: 2020-01-01T00:00:00Z')) : null)), ['/.well-known/security.txt']);
  assert.deepEqual(await run((url, response) => (url.pathname === '/robots.txt' ? withBody(response, () => 'User-agent: *\nDisallow: /\n') : null)), ['/robots.txt']);

  // The alias host answering the page itself.
  assert.deepEqual(await run((url) => (url.origin === ALIAS ? new Response('<title>x</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }) : null)), [`redirect from ${ALIAS}`]);

  // A method in the profile list.
  const leaking = (text) => text.replace('"hosted":true', '"hosted":true,"instructions":"Profile: scope."');
  assert.deepEqual(await run((url, response) => (url.pathname === '/api/profiles' ? withBody(response, leaking) : null)), ['/api/profiles carries no instruction text']);

  // A tarball that is not the one the checksum file lists.
  assert.deepEqual(
    await run((url, response) => (url.pathname === '/dl/bounty-operator-mcp.tgz' ? new Response('not the package', { status: 200, headers: response.headers }) : null)),
    ['/dl/SHA256SUMS.txt matches the served tarball'],
  );

  // An endpoint that does not answer at all.
  assert.deepEqual(
    await run((url) => {
      if (url.pathname === '/api/mcp') throw new Error('connection refused');
      return null;
    }),
    ['MCP initialize', 'MCP tools/list'],
  );
});

test('the page checks read markup the way a browser loads it', () => {
  assert.deepEqual(foreignScripts('<script type="module" src="/app/main.mjs"></script><script src="/theme.js"></script><script type="application/ld+json">{"@type":"WebSite"}</script>'), []);
  assert.equal(foreignScripts('<script src="https://cdn.example/x.js"></script>').length, 1);
  assert.equal(foreignScripts('<script src="//cdn.example/x.js"></script>').length, 1);
  assert.equal(foreignScripts('<script>alert(1)</script>').length, 1);
  assert.equal(foreignScripts("<script src='/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js'></script>").length, 2);
  assert.equal(foreignScripts('<SCRIPT SRC=http://x.example/a.js></SCRIPT>').length, 1);

  assert.equal(titleOf('<head><title> Guide | Bounty Operator </title></head>'), 'Guide | Bounty Operator');
  assert.equal(titleOf('<head></head>'), '');
  assert.deepEqual(sitemapLocations('<urlset><url><loc>https://a.example/</loc></url><url><loc> https://a.example/guide </loc></url></urlset>'), ['https://a.example/', 'https://a.example/guide']);

  const hash = 'a'.repeat(64);
  assert.deepEqual(parseSums(`${hash}  bounty-operator-mcp.tgz\n${hash} *bounty-operator-mcp-0.7.0.tgz\n`), [
    { hash, name: 'bounty-operator-mcp.tgz' },
    { hash, name: 'bounty-operator-mcp-0.7.0.tgz' },
  ]);
  assert.equal(parseSums(`${hash}  ../../etc/passwd\n`), null);
  assert.equal(parseSums(''), null);

  assert.deepEqual(headerProblems(new Headers({ ...SECURITY_HEADERS, 'Cache-Control': HTML_CACHE, 'Content-Type': 'text/html; charset=utf-8' })), []);
  assert.equal(headerProblems(new Headers({ 'Content-Type': 'text/html' })).length, Object.keys(SECURITY_HEADERS).length + 1);

  assert.deepEqual(profilesProblems('not json'), ['the answer is not JSON']);
  assert.deepEqual(profilesProblems('{}'), ['the answer has no profiles list']);
});

test('the command exits 1 on bad arguments and names the mistake', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  const none = run();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /--base-url needs an address/);

  const withPath = run('--base-url', 'https://bountyoperator.com/guide');
  assert.equal(withPath.status, 1);
  assert.match(withPath.stderr, /takes an origin with no path/);

  assert.equal(run('--base-url', 'https://bountyoperator.com', '--profiles', 'other').status, 1);
  assert.equal(run('--base-url', 'https://bountyoperator.com', '--publish').status, 1);

  // An address nothing listens on: every check fails and the exit code says so.
  const dead = run('--base-url', 'http://127.0.0.1:9');
  assert.equal(dead.status, 1);
  assert.match(dead.stdout, /FAIL {2}\/api\/health: no answer/);
  assert.match(dead.stdout, /checks failed\./);
});

test('the script holds no secret, no production id and no write', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /process\.env|Authorization|X-Provider-Key|bok_|sk-|price_|account_id/);
  // One POST: the MCP endpoint, for initialize and tools/list.
  assert.equal([...source.matchAll(/method: 'POST'/g)].length, 1);
  assert.doesNotMatch(source, /writeFile|appendFile|rmSync|unlink/);

  const manifest = JSON.parse(readFileSync(path.join(WEB_DIR, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['verify:live'], 'node ../scripts/verify-live.mjs');
});
