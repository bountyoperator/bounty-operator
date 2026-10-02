#!/usr/bin/env node
// Checks a running Bounty Operator site from the outside. Read-only: it makes
// GET requests, two MCP calls that need no account, and downloads the MCP
// package to hash it. It holds no secret and sends none.
//
//   node scripts/verify-live.mjs --base-url https://bountyoperator.com
//   node scripts/verify-live.mjs --base-url https://bountyoperator.com --alias https://www.bountyoperator.com
//   node scripts/verify-live.mjs --base-url http://localhost:8787 --profiles community
//
// What it checks:
//   1. /api/health: status ok, the version of web/package.json, the database
//      answers, and profiles is "hosted" (or what --profiles names).
//   2. / and /guide carry every security header and the one content security policy.
//   3. /.well-known/security.txt, /robots.txt and /sitemap.xml are served and well-formed.
//   4. Every page in the sitemap answers 200 with a <title>, and its HTML loads
//      no script from another origin and none the proxy injected.
//   5. With --alias: a GET on the alias host is redirected to the same path on the base URL.
//   6. /api/profiles lists the profiles as metadata: no instruction text for a hosted one.
//   7. /api/mcp answers initialize and tools/list.
//   8. /dl/SHA256SUMS.txt matches the tarballs served next to it.
//
// Exit code 0 when everything passes, 1 when any check fails or the arguments are wrong.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROFILES } from '../web/public/profiles.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 30000;
const PAGE_CONCURRENCY = 4;
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

// The policy and the headers the Worker sets on every response (web/src/http.ts).
// They are written out here so this script checks the site against a second
// copy; web/tests/verify-live.test.mjs holds the two copies together.
export const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.github.com https://openrouter.ai; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export const EXPECTED_HEADERS = Object.freeze({
  'content-security-policy': EXPECTED_CSP,
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
});

export const EXPECTED_HTML_CACHE = 'public, max-age=0, must-revalidate, no-transform';
export const MCP_TOOLS = Object.freeze(['list_profiles', 'prepare_review', 'build_packet', 'account', 'run_review']);

// ---------------------------------------------------------------------------
// Pure checks on a response that is already in hand
// ---------------------------------------------------------------------------

/**
 * Why the scripts of a page are not all its own. A script is the site's own
 * when it is loaded from a path on the same origin, outside the proxy's
 * /cdn-cgi/ folder. Inline JSON-LD is data, not a script that runs.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function foreignScripts(html) {
  const problems = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const address = src ? (src[1] ?? src[2] ?? src[3]) : null;
    if (address === null) {
      if (type !== 'application/ld+json') problems.push(`inline script: ${tag.slice(0, 80)}`);
    } else if (!address.startsWith('/') || address.startsWith('//')) {
      problems.push(`script from another origin: ${address.slice(0, 120)}`);
    } else if (address.startsWith('/cdn-cgi/')) {
      problems.push(`script injected by the proxy: ${address.slice(0, 120)}`);
    }
  }
  if (/cloudflareinsights\.com|\/cdn-cgi\/(?:scripts|challenge-platform|zaraz)\//i.test(html)) {
    problems.push('the page references a script the proxy injects');
  }
  return problems;
}

/** The text of the page's <title>, or '' when it has none. */
export function titleOf(html) {
  return /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
}

/** The <loc> values of a sitemap. */
export function sitemapLocations(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]);
}

/** The lines of a SHA256SUMS file as [{ hash, name }]; null when a line is not in sha256sum format. */
export function parseSums(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const entries = lines.map((line) => /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line));
  if (!entries.length || entries.some((entry) => !entry)) return null;
  return entries.map((entry) => ({ hash: entry[1], name: entry[2] }));
}

/** What is wrong with the headers of a page, against the one policy. */
export function headerProblems(headers) {
  const problems = [];
  for (const [name, expected] of Object.entries(EXPECTED_HEADERS)) {
    const actual = headers.get(name);
    if (actual === null) problems.push(`${name} is missing`);
    else if (actual !== expected) problems.push(`${name} is "${actual}"`);
  }
  const cache = headers.get('cache-control');
  if (cache !== EXPECTED_HTML_CACHE) problems.push(`cache-control is "${cache}"`);
  if (!(headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) problems.push(`content-type is "${headers.get('content-type')}"`);
  return problems;
}

/** What is wrong with the body of GET /api/profiles. */
export function profilesProblems(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return ['the answer is not JSON'];
  }
  const listed = Array.isArray(body?.profiles) ? body.profiles : null;
  if (!listed) return ['the answer has no profiles list'];

  const problems = [];
  const expected = PROFILES.filter((profile) => profile.listed);
  if (listed.map((profile) => profile.id).join() !== expected.map((profile) => profile.id).join()) {
    problems.push(`the listed ids are ${listed.map((profile) => profile.id).join(', ')}`);
  }
  for (const profile of listed) {
    const known = expected.find((entry) => entry.id === profile.id);
    if (known && profile.hosted !== known.hosted) problems.push(`${profile.id}: hosted is ${profile.hosted}`);
    for (const key of ['instructions', 'extraFormat', 'method', 'prompt', 'system']) {
      if (Object.hasOwn(profile, key)) problems.push(`${profile.id} carries "${key}"`);
    }
  }
  if (!listed.some((profile) => profile.hosted === true)) problems.push('no profile is marked hosted');
  // A method opens with its profile line and the engine's format with "# Review".
  if (/Profile: |# Review\b|\\n## /.test(text)) problems.push('the answer holds instruction text');
  return problems;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const options = { baseUrl: '', alias: '', profiles: 'hosted' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1] ?? '';
    if (argument === '--base-url') options.baseUrl = value;
    else if (argument === '--alias') options.alias = value;
    else if (argument === '--profiles') options.profiles = value;
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  for (const [name, address] of [['--base-url', options.baseUrl], ['--alias', options.alias]]) {
    if (name === '--alias' && !address) continue;
    let url;
    try {
      url = new URL(address);
    } catch {
      throw new Error(`${name} needs an address, such as https://bountyoperator.com.`);
    }
    if (!/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`${name} takes an origin with no path, such as https://bountyoperator.com.`);
    }
  }
  if (!['hosted', 'community'].includes(options.profiles)) throw new Error('--profiles is hosted or community.');
  return { baseUrl: new URL(options.baseUrl).origin, alias: options.alias ? new URL(options.alias).origin : '', profiles: options.profiles };
}

/**
 * Runs every check and returns one entry per check: { name, ok, detail }.
 *
 * @param {{ baseUrl: string, alias?: string, profiles?: 'hosted' | 'community', version: string, fetch?: typeof fetch }} options
 */
export async function verifyLive({ baseUrl, alias = '', profiles = 'hosted', version, fetch: fetchImpl = globalThis.fetch }) {
  const results = [];
  const record = (name, problems) => {
    const list = Array.isArray(problems) ? problems : problems ? [problems] : [];
    results.push({ name, ok: list.length === 0, detail: list.join('; ') });
  };

  const get = (url, init = {}) => fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  /** Runs one check; a thrown error (no answer, a timeout) is that check's failure. */
  const check = async (name, run) => {
    try {
      record(name, await run());
    } catch (error) {
      record(name, `no answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 1. Health
  await check('/api/health', async () => {
    const response = await get(`${baseUrl}/api/health`);
    if (response.status !== 200) return `HTTP ${response.status}`;
    const health = await response.json();
    const problems = [];
    if (health.status !== 'ok') problems.push(`status is "${health.status}"`);
    if (health.version !== version) problems.push(`version is "${health.version}", web/package.json says "${version}"`);
    if (health.db !== 'ok') problems.push(`db is "${health.db}"`);
    if (health.profiles !== profiles) problems.push(`profiles is "${health.profiles}", expected "${profiles}"`);
    return problems;
  });

  // 2. Headers on the two pages most visitors load first
  for (const path of ['/', '/guide']) {
    await check(`security headers on ${path}`, async () => {
      const response = await get(`${baseUrl}${path}`);
      await response.arrayBuffer();
      if (response.status !== 200) return `HTTP ${response.status}`;
      return headerProblems(response.headers);
    });
  }

  // 3. The well-known files
  await check('/.well-known/security.txt', async () => {
    const response = await get(`${baseUrl}/.well-known/security.txt`);
    if (response.status !== 200) return `HTTP ${response.status}`;
    const text = await response.text();
    const problems = [];
    if (!/^Contact: mailto:security@/m.test(text)) problems.push('no Contact line with the security address');
    const expires = /^Expires: (\S+)$/m.exec(text)?.[1];
    if (!expires || !(Date.parse(expires) > Date.now())) problems.push(`Expires is "${expires ?? 'missing'}"`);
    if (!/^Canonical: https:\/\/\S+\/\.well-known\/security\.txt$/m.test(text)) problems.push('no Canonical line');
    return problems;
  });

  await check('/robots.txt', async () => {
    const response = await get(`${baseUrl}/robots.txt`);
    if (response.status !== 200) return `HTTP ${response.status}`;
    const text = await response.text();
    const problems = [];
    if (!/^User-agent: \*$/m.test(text)) problems.push('no User-agent line');
    if (!/^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m.test(text)) problems.push('no Sitemap line');
    return problems;
  });

  let pages = [];
  await check('/sitemap.xml', async () => {
    const response = await get(`${baseUrl}/sitemap.xml`);
    if (response.status !== 200) return `HTTP ${response.status}`;
    const locations = sitemapLocations(await response.text());
    const problems = [];
    if (locations.length < 10) problems.push(`${locations.length} pages listed`);
    const origins = new Set(locations.map((location) => new URL(location).origin));
    if (origins.size > 1) problems.push(`pages on ${origins.size} origins`);
    // A site on its own domain lists itself. A development server lists the production origin.
    const local = /^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(baseUrl).hostname);
    if (!local && origins.size === 1 && !origins.has(baseUrl)) problems.push(`pages are listed on ${[...origins][0]}`);
    pages = locations.map((location) => new URL(location).pathname);
    return problems;
  });

  // 4. Every page of the sitemap
  const pageProblems = [];
  const queue = [...pages];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      try {
        const response = await get(`${baseUrl}${path}`);
        const html = await response.text();
        if (response.status !== 200) pageProblems.push(`${path}: HTTP ${response.status}`);
        else {
          if (!titleOf(html)) pageProblems.push(`${path}: no <title>`);
          for (const problem of foreignScripts(html)) pageProblems.push(`${path}: ${problem}`);
          if (response.headers.get('content-security-policy') !== EXPECTED_CSP) pageProblems.push(`${path}: the content security policy differs`);
        }
      } catch (error) {
        pageProblems.push(`${path}: no answer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, worker));
  record(`${pages.length} sitemap pages: 200, a <title>, no foreign script`, pages.length ? pageProblems.sort() : 'the sitemap listed no page');

  // 5. The canonical host
  if (alias) {
    await check(`redirect from ${alias}`, async () => {
      const response = await get(`${alias}/guide?from=verify`);
      await response.arrayBuffer();
      const location = response.headers.get('location');
      const problems = [];
      if (response.status !== 301) problems.push(`HTTP ${response.status}`);
      if (location !== `${baseUrl}/guide?from=verify`) problems.push(`Location is "${location}"`);
      return problems;
    });
  }

  // 6. Profiles as metadata
  await check('/api/profiles carries no instruction text', async () => {
    const response = await get(`${baseUrl}/api/profiles`);
    if (response.status !== 200) return `HTTP ${response.status}`;
    return profilesProblems(await response.text());
  });

  // 7. MCP
  const rpc = async (id, method, params) => {
    const response = await get(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
    });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).result;
  };
  await check('MCP initialize', async () => {
    const result = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-live', version } });
    const problems = [];
    if (result?.protocolVersion !== '2025-06-18') problems.push(`protocolVersion is "${result?.protocolVersion}"`);
    if (result?.serverInfo?.name !== 'bounty-operator') problems.push(`server name is "${result?.serverInfo?.name}"`);
    if (result?.serverInfo?.version !== version) problems.push(`server version is "${result?.serverInfo?.version}"`);
    return problems;
  });
  await check('MCP tools/list', async () => {
    const result = await rpc(2, 'tools/list');
    const names = (result?.tools ?? []).map((tool) => tool.name);
    return names.join() === MCP_TOOLS.join() ? [] : `tools are ${names.join(', ') || 'missing'}`;
  });

  // 8. The download
  await check('/dl/SHA256SUMS.txt matches the served tarball', async () => {
    const response = await get(`${baseUrl}/dl/SHA256SUMS.txt`);
    if (response.status !== 200) return `HTTP ${response.status}`;
    const sums = parseSums(await response.text());
    if (!sums) return 'the file is not in sha256sum format';
    const problems = [];
    if (!sums.some((entry) => entry.name === 'bounty-operator-mcp.tgz')) problems.push('bounty-operator-mcp.tgz is not listed');
    if (!sums.some((entry) => entry.name === `bounty-operator-mcp-${version}.tgz`)) problems.push(`bounty-operator-mcp-${version}.tgz is not listed`);
    for (const { hash, name } of sums) {
      const file = await get(`${baseUrl}/dl/${name}`);
      if (file.status !== 200) {
        problems.push(`${name}: HTTP ${file.status}`);
        continue;
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length > MAX_DOWNLOAD_BYTES) problems.push(`${name}: ${bytes.length} bytes`);
      else if (createHash('sha256').update(bytes).digest('hex') !== hash) problems.push(`${name}: the served file does not match its listed hash`);
    }
    return problems;
  });

  return results;
}

async function main(argv) {
  const options = parseArguments(argv);
  const { version } = JSON.parse(await readFile(join(ROOT, 'web', 'package.json'), 'utf8'));
  console.log(`Verifying ${options.baseUrl} against version ${version}.`);

  const results = await verifyLive({ ...options, version });
  for (const result of results) console.log(result.ok ? `ok    ${result.name}` : `FAIL  ${result.name}: ${result.detail}`);

  const failed = results.filter((result) => !result.ok).length;
  console.log(failed ? `\n${failed} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
