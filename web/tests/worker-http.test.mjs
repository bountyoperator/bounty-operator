import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_CACHE,
  ASSET_CACHE,
  ApiError,
  CODE_CACHE,
  CONTENT_SECURITY_POLICY,
  HTML_CACHE,
  SECURITY_HEADERS,
  cachePolicy,
  aliasRedirect,
  canonicalRedirect,
  errorResponse,
  finalize,
  internalError,
  json,
  readJson,
} from '../src/http.ts';

const SITE = 'https://bountyoperator.com';

test('GET and HEAD on any other host or scheme go to the same path on the site origin', () => {
  const redirect = (method, url) => canonicalRedirect(method, new URL(url), SITE);

  assert.equal(redirect('GET', 'https://www.bountyoperator.com/guide'), `${SITE}/guide`);
  assert.equal(redirect('GET', 'https://alias.example/tools/verify?x=1&y=2'), `${SITE}/tools/verify?x=1&y=2`);
  assert.equal(redirect('HEAD', 'https://bounty-operator-kit.example.workers.dev/'), `${SITE}/`);
  assert.equal(redirect('GET', 'http://bountyoperator.com/pricing'), `${SITE}/pricing`);
  assert.equal(redirect('GET', 'https://www.bountyoperator.com/api/health'), `${SITE}/api/health`);
  assert.equal(redirect('GET', 'https://bountyoperator.com:8443/'), `${SITE}/`);
});

test('the site origin itself is not redirected', () => {
  assert.equal(canonicalRedirect('GET', new URL(`${SITE}/guide`), SITE), null);
  assert.equal(canonicalRedirect('HEAD', new URL(`${SITE}/`), SITE), null);
  assert.equal(canonicalRedirect('GET', new URL('http://localhost:8799/x'), 'http://localhost:8799'), null);
});

test('a POST is never redirected, so the Stripe webhook works on a legacy host', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    assert.equal(canonicalRedirect(method, new URL('https://alias.example/api/stripe/webhook'), SITE), null, method);
  }
});

test('the top-level security.txt and favicon.png move to the files that exist', () => {
  assert.equal(aliasRedirect('GET', new URL(`${SITE}/security.txt`)), `${SITE}/.well-known/security.txt`);
  assert.equal(aliasRedirect('HEAD', new URL(`${SITE}/favicon.png`)), `${SITE}/icon-192.png`);
  assert.equal(aliasRedirect('POST', new URL(`${SITE}/security.txt`)), null);
  assert.equal(aliasRedirect('GET', new URL(`${SITE}/.well-known/security.txt`)), null);
  assert.equal(aliasRedirect('GET', new URL(`${SITE}/security.txt.bak`)), null);
  assert.equal(aliasRedirect('GET', new URL(`${SITE}/constructor`)), null, 'no inherited keys');
});

test('a hostile path cannot turn the redirect into an open redirect', () => {
  const location = canonicalRedirect('GET', new URL('https://www.bountyoperator.com//evil.example/x'), SITE);
  assert.equal(new URL(location).origin, SITE);
});

test('cachePolicy: API responses are never stored', () => {
  assert.equal(cachePolicy({ kind: 'api', pathname: '/api/account', contentType: 'application/json' }), API_CACHE);
  assert.equal(API_CACHE, 'no-store');
});

test('cachePolicy: pages revalidate and forbid transformation', () => {
  assert.equal(HTML_CACHE, 'public, max-age=0, must-revalidate, no-transform');
  assert.equal(cachePolicy({ kind: 'static', pathname: '/guide', contentType: 'text/html; charset=utf-8' }), HTML_CACHE);
  assert.equal(cachePolicy({ kind: 'static', pathname: '/', contentType: 'text/html' }), HTML_CACHE);
  // A 304 has no Content-Type; a page path has no extension.
  assert.equal(cachePolicy({ kind: 'static', pathname: '/tools/verify', contentType: null }), HTML_CACHE);
  assert.equal(cachePolicy({ kind: 'static', pathname: '/index.html', contentType: null }), HTML_CACHE);
});

test('cachePolicy: modules and stylesheets revalidate, other assets are cached for an hour', () => {
  assert.equal(cachePolicy({ kind: 'static', pathname: '/review-core.mjs', contentType: 'text/javascript' }), CODE_CACHE);
  assert.equal(cachePolicy({ kind: 'static', pathname: '/theme.js', contentType: null }), CODE_CACHE);
  assert.equal(cachePolicy({ kind: 'static', pathname: '/css/base.css', contentType: 'text/css; charset=utf-8' }), CODE_CACHE);

  assert.equal(ASSET_CACHE, 'public, max-age=3600, stale-while-revalidate=86400');
  assert.equal(cachePolicy({ kind: 'static', pathname: '/social-v2.png', contentType: 'image/png' }), ASSET_CACHE);
  assert.equal(cachePolicy({ kind: 'static', pathname: '/icon.svg', contentType: null }), ASSET_CACHE);
  assert.equal(cachePolicy({ kind: 'static', pathname: '/llms.txt', contentType: 'text/plain' }), ASSET_CACHE);
});

test('the MCP package and its checksum list revalidate, and the package has a media type', () => {
  // Both files change in one deploy: a cached copy of one beside a fresh copy of the other fails the check.
  assert.equal(cachePolicy({ kind: 'static', pathname: '/dl/bounty-operator-mcp.tgz', contentType: null }), CODE_CACHE);
  assert.equal(cachePolicy({ kind: 'static', pathname: '/dl/SHA256SUMS.txt', contentType: 'text/plain; charset=utf-8' }), CODE_CACHE);

  const tarball = finalize(new Response('x'), 'static', '/dl/bounty-operator-mcp.tgz');
  // A Response built from a string carries text/plain: only a missing type is filled in.
  assert.equal(tarball.headers.get('Cache-Control'), CODE_CACHE);
  const bare = new Response(new Uint8Array([31, 139]));
  assert.equal(bare.headers.get('content-type'), null);
  assert.equal(finalize(bare, 'static', '/dl/bounty-operator-mcp.tgz').headers.get('Content-Type'), 'application/gzip');
  assert.equal(finalize(new Response(new Uint8Array([1])), 'static', '/icon-192.png').headers.get('Content-Type'), null);
});

test('the content security policy is the one in the spec', () => {
  assert.equal(
    CONTENT_SECURITY_POLICY,
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.github.com https://openrouter.ai; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  assert(!CONTENT_SECURITY_POLICY.includes('unsafe'));
});

test('finalize sets every security header on every kind of response', () => {
  const responses = [
    finalize(json({ ok: true }), 'api', '/api/account'),
    finalize(new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }), 'static', '/guide'),
    finalize(new Response(null, { status: 301, headers: { Location: `${SITE}/` } }), 'redirect', '/'),
    finalize(new Response(null, { status: 304 }), 'static', '/social-v2.png'),
  ];
  for (const response of responses) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(response.headers.get(name), value, name);
    }
  }
  assert.equal(responses[0].headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
  assert.equal(responses[0].headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(responses[0].headers.get('Cache-Control'), 'no-store');
  assert.equal(responses[1].headers.get('Cache-Control'), HTML_CACHE);
  assert.equal(responses[2].headers.get('Location'), `${SITE}/`);
  assert.equal(responses[3].headers.get('Cache-Control'), ASSET_CACHE);
});

test('finalize overrides whatever the asset layer sent and never caches an error as an asset', () => {
  const upstream = new Response('body', {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000', 'Content-Security-Policy': "default-src *" },
  });
  const ok = finalize(upstream, 'static', '/social-v2.png');
  assert.equal(ok.headers.get('Cache-Control'), ASSET_CACHE);
  assert.equal(ok.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);

  const missing = finalize(new Response('<!doctype html>', { status: 404, headers: { 'Content-Type': 'text/html' } }), 'static', '/missing.png');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Cache-Control'), HTML_CACHE);
});

test('finalize keeps cookies and the body', async () => {
  const response = finalize(json({ a: 1 }, 200, { cookies: ['one=1; Path=/', 'two=2; Path=/'] }), 'api', '/api/x');
  assert.deepEqual(response.headers.getSetCookie(), ['one=1; Path=/', 'two=2; Path=/']);
  assert.deepEqual(await response.json(), { a: 1 });
});

test('errorResponse sends the message, the code and the extra fields', async () => {
  const response = errorResponse(new ApiError("Today's free review is used.", 429, 'daily_used', { resetsAt: '2026-10-03T00:00:00.000Z' }));
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    resetsAt: '2026-10-03T00:00:00.000Z',
    error: "Today's free review is used.",
    code: 'daily_used',
  });
});

test('errorResponse sets Retry-After and Allow where they apply', () => {
  const limited = errorResponse(new ApiError('Too many requests.', 429, 'rate_limited', { retryAfter: 42 }));
  assert.equal(limited.headers.get('Retry-After'), '42');

  const method = errorResponse(new ApiError('Method not allowed.', 405, 'method_not_allowed', { allow: 'POST' }));
  assert.equal(method.headers.get('Allow'), 'POST');
});

test('an extra field cannot overwrite the message or the code', async () => {
  const response = errorResponse(new ApiError('Real message.', 400, 'real_code', { error: 'spoofed', code: 'spoofed' }));
  assert.deepEqual(await response.json(), { error: 'Real message.', code: 'real_code' });
});

test('the internal error names the support address and nothing about the failure', () => {
  const error = internalError();
  assert.equal(error.status, 500);
  assert.equal(error.code, 'internal');
  assert.match(error.message, /support@bountyoperator\.com/);
});

function post(body, headers = { 'Content-Type': 'application/json' }) {
  return new Request(`${SITE}/api/x`, { method: 'POST', headers, body });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

test('readJson returns a JSON object', async () => {
  assert.deepEqual(await readJson(post('{"a":1}'), 100), { a: 1 });
  assert.deepEqual(await readJson(post('{"a":1}', { 'Content-Type': 'application/json; charset=utf-8' }), 100), { a: 1 });
});

test('readJson refuses other content types unless the route allows them', async () => {
  const error = await rejection(readJson(post('{"a":1}', { 'Content-Type': 'text/plain' }), 100));
  assert.equal(error.status, 415);
  assert.deepEqual(await readJson(post('{"event":"x"}', { 'Content-Type': 'text/plain' }), 100, true), { event: 'x' });
});

test('readJson refuses oversized bodies, declared or not', async () => {
  const big = JSON.stringify({ a: 'x'.repeat(500) });
  assert.equal((await rejection(readJson(post(big), 100))).code, 'too_large');

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(big));
      controller.close();
    },
  });
  const undeclared = new Request(`${SITE}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' });
  assert.equal((await rejection(readJson(undeclared, 100))).status, 413);
});

test('readJson refuses anything that is not a JSON object', async () => {
  for (const body of ['', 'not json', '[1,2]', '"text"', 'null', '42']) {
    const error = await rejection(readJson(post(body), 100));
    assert.equal(error?.status, 400, body);
    assert.equal(error.code, 'bad_request');
  }
});
