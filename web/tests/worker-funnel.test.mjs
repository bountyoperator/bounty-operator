import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_VIEW, CLIENT_EVENTS, count, countVisit, dayOf, isBot, isOwnCheck, mcpClient, pageviewEvent, refCodeBucket, referrerBucket, visitSource } from '../src/funnel.ts';
import worker from '../src/worker.ts';
import { BROWSER_AGENT, SITE_ORIGIN, createBrowser, createContext, createEnv, createPasskey, funnelCounts } from './worker-helpers.mjs';
import { CHECK_AGENT } from '../../scripts/check-agent.mjs';

const CHROME = BROWSER_AGENT;
// The name the account audit gives itself as it signs up and signs in on the live site.
const AUDIT_AGENT = 'BountyOperator-AccountAudit/1.0';

test('referrerBucket names the sources on the list', () => {
  const cases = {
    'https://x.com/someone/status/1': 'x',
    'https://t.co/abc': 'x',
    'https://twitter.com/': 'x',
    'https://mobile.twitter.com/': 'x',
    'https://github.com/example/repository': 'github',
    'https://news.ycombinator.com/item?id=1': 'hackernews',
    'https://www.reddit.com/r/ethdev/': 'reddit',
    'https://old.reddit.com/': 'reddit',
    'https://www.google.com/': 'google',
    'https://www.google.co.uk/': 'google',
    'https://google.com.au/search': 'google',
    'https://www.google.co.id/': 'google',
    'https://google.com/': 'google',
    // Search Console and Google's other sites are not someone searching.
    'https://search.google.com/search-console/performance': 'search-console',
    'https://docs.google.com/document/d/1/edit': 'google-apps',
    'https://mail.google.com/mail/u/0/': 'google-apps',
    'https://groups.google.com/g/some-list': 'google-apps',
    'https://news.google.co.uk/': 'google-apps',
    'https://www.bing.com/search?q=x': 'bing',
    'https://duckduckgo.com/': 'duckduckgo',
    'https://chatgpt.com/': 'chatgpt',
    'https://chat.openai.com/c/1': 'chatgpt',
    'https://www.perplexity.ai/search/x': 'perplexity',
    'https://claude.ai/chat/1': 'claude',
    'https://copilot.microsoft.com/': 'copilot',
    // An assistant on a Google host is named before the rules for the other Google hosts.
    'https://gemini.google.com/app': 'gemini',
    'https://immunefi.com/bug-bounty/': 'immunefi',
    'https://cantina.xyz/': 'cantina',
    'https://audits.sherlock.xyz/': 'sherlock',
    'https://discord.com/channels/1/2': 'discord',
    'https://openrouter.ai/apps': 'openrouter',
    'https://t.me/somechannel': 'telegram',
    'https://warpcast.com/': 'farcaster',
    'https://farcaster.xyz/': 'farcaster',
    'https://glama.ai/mcp/connectors/io.github.bountyoperator/bounty-operator': 'glama',
    'https://mcpnav.net/server/bounty-operator/': 'mcpnav',
    'https://mcpservers.org/servers/bounty-operator': 'mcpservers',
    'https://mcpmarket.com/server/bounty-operator': 'mcpmarket',
    'https://skillsmp.com/skills/bounty-operator': 'skillsmp',
    'https://www.skillsdirectory.com/skills/bounty-operator': 'skillsdirectory',
    'https://getdisclosed.com/p/issue-1': 'disclosed',
  };
  for (const [referer, bucket] of Object.entries(cases)) {
    assert.equal(referrerBucket(referer, SITE_ORIGIN), bucket, referer);
  }
});

test('referrerBucket files unknown sites under other and ignores the site itself', () => {
  assert.equal(referrerBucket('https://example.org/post', SITE_ORIGIN), 'other');
  assert.equal(referrerBucket('https://notx.com/', SITE_ORIGIN), 'other', 'a suffix match needs a dot before it');
  assert.equal(referrerBucket('https://evilgithub.com/', SITE_ORIGIN), 'other');
  assert.equal(referrerBucket('https://google.evil.example/', SITE_ORIGIN), 'other');
  assert.equal(referrerBucket('https://evilgoogle.com/', SITE_ORIGIN), 'other');
  assert.equal(referrerBucket('https://search.google.com.evil.example/', SITE_ORIGIN), 'other');
  assert.equal(referrerBucket('https://notglama.ai/', SITE_ORIGIN), 'other');

  assert.equal(referrerBucket('https://bountyoperator.com/guide', SITE_ORIGIN), null);
  assert.equal(referrerBucket('https://www.bountyoperator.com/', SITE_ORIGIN), null);
  assert.equal(referrerBucket('', SITE_ORIGIN), null);
  assert.equal(referrerBucket(null, SITE_ORIGIN), null);
  assert.equal(referrerBucket('not a url', SITE_ORIGIN), null);
  assert.equal(referrerBucket('android-app://com.twitter.android', SITE_ORIGIN), null);
});

test('refCodeBucket accepts only codes on the list', () => {
  assert.equal(refCodeBucket('x'), 'x');
  assert.equal(refCodeBucket('Twitter'), 'x');
  assert.equal(refCodeBucket('hn'), 'hackernews');
  assert.equal(refCodeBucket('gh'), 'github');
  assert.equal(refCodeBucket('launch'), 'launch');
  assert.equal(refCodeBucket('mcp'), 'mcp');
  assert.equal(refCodeBucket('template'), 'template', 'the note in a downloaded template');
  assert.equal(refCodeBucket('newsletter'), 'newsletter');

  assert.equal(refCodeBucket('made-up-code'), null, 'a visitor cannot mint new counter rows');
  assert.equal(refCodeBucket('constructor'), null);
  assert.equal(refCodeBucket('__proto__'), null);
  assert.equal(refCodeBucket(''), null);
  assert.equal(refCodeBucket(null), null);
});

test('visitSource prefers the ?ref= code over the Referer header', () => {
  const url = (search) => new URL(`${SITE_ORIGIN}/guide${search}`);
  assert.equal(visitSource(url('?ref=hn'), 'https://x.com/', SITE_ORIGIN), 'hackernews');
  assert.equal(visitSource(url('?ref=unknown'), 'https://x.com/', SITE_ORIGIN), 'x');
  assert.equal(visitSource(url(''), 'https://github.com/', SITE_ORIGIN), 'github');
  assert.equal(visitSource(url(''), null, SITE_ORIGIN), null);
});

test('isBot filters crawlers, tools and empty agents', () => {
  assert.equal(isBot(CHROME), false);
  assert.equal(isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), false);
  for (const agent of ['', null, 'curl/8.9.0', 'Googlebot/2.1 (+http://www.google.com/bot.html)', 'Twitterbot/1.0', 'python-requests/2.32', 'Slackbot-LinkExpanding 1.0', 'node']) {
    assert.equal(isBot(agent), true, String(agent));
  }
});

test('a release check names itself and is never counted as a visitor', () => {
  assert.match(CHECK_AGENT, /^bounty-operator-check\/\d+$/);
  assert.equal(isOwnCheck(CHECK_AGENT), true);
  assert.equal(isBot(CHECK_AGENT), true);
  for (const agent of [CHROME, 'node', '', null, undefined, `Mozilla/5.0 ${CHECK_AGENT}`]) assert.equal(isOwnCheck(agent), false, String(agent));
  // The account audit, which signs up on the live site, is one of ours too.
  assert.equal(isOwnCheck(AUDIT_AGENT), true);
  assert.equal(isBot(AUDIT_AGENT), true);
  assert.equal(isOwnCheck(`Mozilla/5.0 ${AUDIT_AGENT}`), false);
});

test('mcpClient puts a session in one of a fixed few buckets', () => {
  assert.equal(mcpClient(CHECK_AGENT), null, 'a release check is not counted at all');
  for (const agent of ['mcpregistry-bot/0.1', 'UptimeRobot/2.0', 'SomeScanner/1.0', 'registry-probe']) assert.equal(mcpClient(agent), 'crawler', agent);
  assert.equal(mcpClient('claude-code/2.1.296 (cli)'), 'claude');
  assert.equal(mcpClient('Claude-User'), 'claude');
  // Agents built on Node or Python are agents here, though the page counter calls them tools.
  for (const agent of ['node', 'python-httpx/0.28.1', 'Go-http-client/2.0', '', null, undefined]) assert.equal(mcpClient(agent), 'other', String(agent));
});

test('a headless browser driving the page is not counted as someone using it', async () => {
  const send = async (agent) => {
    const env = createEnv();
    const ctx = createContext();
    const request = new Request(`${SITE_ORIGIN}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE_ORIGIN, 'CF-Connecting-IP': '203.0.113.7', ...(agent ? { 'User-Agent': agent } : {}) },
      body: JSON.stringify({ event: 'example_loaded' }),
    });
    const response = await worker.fetch(request, env, ctx);
    await ctx.settled();
    return { status: response.status, counts: funnelCounts(env.DB) };
  };

  assert.deepEqual(await send(CHROME), { status: 204, counts: { example_loaded: 1 } });
  const headless = CHROME.replace('Chrome/', 'HeadlessChrome/');
  for (const agent of [headless, CHECK_AGENT, 'node', null]) {
    assert.deepEqual(await send(agent), { status: 204, counts: {} }, String(agent));
  }
});

test('pageviewEvent normalises the path', () => {
  assert.equal(pageviewEvent('/'), 'pv:/');
  assert.equal(pageviewEvent('/guide'), 'pv:/guide');
  assert.equal(pageviewEvent('/tools/report-check/'), 'pv:/tools/report-check');
  assert.equal(pageviewEvent(`/${'a'.repeat(100)}`), null);
});

function htmlResponse(status = 200, type = 'text/html; charset=utf-8') {
  return new Response(status === 304 ? null : '<!doctype html>', { status, headers: { 'Content-Type': type } });
}

function visit(path, headers = {}, method = 'GET') {
  return new Request(`${SITE_ORIGIN}${path}`, { method, headers: { 'User-Agent': CHROME, ...headers } });
}

async function countedFor(request, response = htmlResponse()) {
  const env = createEnv();
  const ctx = createContext();
  countVisit(env, ctx, request, new URL(request.url), response);
  await ctx.settled();
  return funnelCounts(env.DB);
}

test('countVisit records a page view and its source', async () => {
  assert.deepEqual(await countedFor(visit('/guide', { Referer: 'https://x.com/a/status/1', 'Sec-Fetch-Dest': 'document' })), {
    'pv:/guide': 1,
    'ref:x': 1,
  });
  assert.deepEqual(await countedFor(visit('/?ref=hn')), { 'pv:/': 1, 'ref:hackernews': 1 });
  assert.deepEqual(await countedFor(visit('/pricing', { Referer: `${SITE_ORIGIN}/` })), { 'pv:/pricing': 1 });
  assert.deepEqual(await countedFor(visit('/guide'), htmlResponse(304)), { 'pv:/guide': 1 }, 'a revalidated page is a visit too');
});

test('countVisit skips everything that is not a person loading a page', async () => {
  assert.deepEqual(await countedFor(visit('/guide', { 'User-Agent': 'Googlebot/2.1' })), {});
  assert.deepEqual(await countedFor(visit('/missing'), htmlResponse(404)), {});
  assert.deepEqual(await countedFor(visit('/style.css'), htmlResponse(200, 'text/css')), {});
  assert.deepEqual(await countedFor(visit('/guide', { 'Sec-Fetch-Dest': 'iframe' })), {});
  assert.deepEqual(await countedFor(visit('/guide', { 'Sec-Purpose': 'prefetch' })), {});
  assert.deepEqual(await countedFor(visit('/guide', {}, 'HEAD')), {});
});

test('a page a browser navigated to is counted in a total of its own', async () => {
  const navigation = { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' };
  assert.equal(BROWSER_VIEW, 'browser_view');
  assert.deepEqual(await countedFor(visit('/guide', navigation)), { browser_view: 1, 'pv:/guide': 1 });
  assert.deepEqual(await countedFor(visit('/?ref=x', navigation)), { browser_view: 1, 'pv:/': 1, 'ref:x': 1 });
  assert.deepEqual(await countedFor(visit('/guide', navigation), htmlResponse(304)), { browser_view: 1, 'pv:/guide': 1 });

  // A script that gives itself a browser's name sends neither header, or only one: a page view, and no more.
  assert.deepEqual(await countedFor(visit('/guide')), { 'pv:/guide': 1 });
  assert.deepEqual(await countedFor(visit('/guide', { 'Sec-Fetch-Dest': 'document' })), { 'pv:/guide': 1 });
  assert.deepEqual(await countedFor(visit('/guide', { 'Sec-Fetch-Mode': 'navigate' })), { 'pv:/guide': 1 });
  assert.deepEqual(await countedFor(visit('/guide', { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'cors' })), { 'pv:/guide': 1 });

  // What is not a page view at all is not a browser's either.
  assert.deepEqual(await countedFor(visit('/guide', { ...navigation, 'User-Agent': 'Googlebot/2.1' })), {});
  assert.deepEqual(await countedFor(visit('/guide', { ...navigation, 'User-Agent': CHECK_AGENT })), {});
  assert.deepEqual(await countedFor(visit('/guide', { ...navigation, 'Sec-Purpose': 'prefetch' })), {});
  assert.deepEqual(await countedFor(visit('/missing', navigation), htmlResponse(404)), {});
});

test('count adds up per day and never rejects', async () => {
  const env = createEnv();
  const ctx = createContext();
  count(env, ctx, 'register');
  count(env, ctx, 'register', 'login');
  count(env, ctx);
  await ctx.settled();
  assert.deepEqual(funnelCounts(env.DB), { login: 1, register: 2 });
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(DISTINCT day) AS days FROM funnel_daily').get().days, 1);

  const broken = { DB: { prepare: () => ({ bind: () => ({}) }), batch: () => Promise.reject(new Error('down')) } };
  count(broken, ctx, 'register');
  await ctx.settled();
});

test('dayOf is the UTC date', () => {
  assert.equal(dayOf(1790899200), '2026-10-02');
  assert.equal(dayOf(1790899199), '2026-10-01');
});

test('client events are a fixed list that cannot collide with server counters', () => {
  assert(CLIENT_EVENTS.has('prompt_exported'));
  // The page_seen counter of /theme.js, and the names the templates and the sign-up prompts send.
  for (const name of ['page_seen', 'template_handoff', 'signup_prompt_clicked']) assert(CLIENT_EVENTS.has(name), name);
  assert(!CLIENT_EVENTS.has('register'));
  assert(!CLIENT_EVENTS.has('sub_active'));
  for (const name of CLIENT_EVENTS) {
    assert.match(name, /^[a-z][a-z_]{2,40}$/);
    assert(!name.includes(':'));
  }
});

test('page_seen is counted from a browser, and not from a headless one or one of our checks', async () => {
  const send = async (agent) => {
    const env = createEnv();
    const ctx = createContext();
    // The request /theme.js builds, with what the browser adds to it.
    const request = new Request(`${SITE_ORIGIN}/api/event`, {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Origin: SITE_ORIGIN, 'CF-Connecting-IP': '203.0.113.8', ...(agent ? { 'User-Agent': agent } : {}) },
      body: JSON.stringify({ event: 'page_seen' }),
    });
    const response = await worker.fetch(request, env, ctx);
    await ctx.settled();
    return { status: response.status, counts: funnelCounts(env.DB) };
  };
  assert.deepEqual(await send(CHROME), { status: 204, counts: { page_seen: 1 } });
  for (const agent of [CHROME.replace('Chrome/', 'HeadlessChrome/'), CHECK_AGENT, AUDIT_AGENT, null]) {
    assert.deepEqual(await send(agent), { status: 204, counts: {} }, String(agent));
  }
});

/**
 * Sends every fetch a test makes to the Worker, and Stripe's to `stripe`, so
 * the cookie-keeping client of the smoke scripts runs against an env in memory.
 */
function routeFetch(t, stripe = () => assert.fail('No Stripe request was expected')) {
  const target = { env: createEnv(), ctx: createContext() };
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin === SITE_ORIGIN) return worker.fetch(new Request(input, init), target.env, target.ctx);
    if (url.host === 'api.stripe.com') return stripe(url, init);
    return assert.fail(`Unexpected request to ${url.origin}`);
  });
  return target;
}

/** Signs up and back in with a software passkey, under `agent`. Returns the signed-in client. */
async function signUpAndIn(agent) {
  const browser = createBrowser(SITE_ORIGIN);
  const passkey = createPasskey(SITE_ORIGIN);
  const headers = { 'User-Agent': agent };
  await browser.call('/api/auth/register/verify', passkey.register(await browser.call('/api/auth/register/options', {}, { headers })), { headers });
  await browser.call('/api/auth/logout', {}, { headers });
  await browser.call('/api/auth/login/verify', passkey.signIn(await browser.call('/api/auth/login/options', {}, { headers })), { headers });
  return { browser, headers };
}

test('sign-ups and sign-ins are counted, and those of our own checks are not', async (t) => {
  const target = routeFetch(t);
  for (const [agent, expected] of [[CHROME, { login: 1, register: 1 }], [AUDIT_AGENT, {}], [CHECK_AGENT, {}]]) {
    target.env = createEnv();
    target.ctx = createContext();
    await signUpAndIn(agent);
    await target.ctx.settled();
    assert.deepEqual(funnelCounts(target.env.DB), expected, agent);
    // The account is made either way: the check changes the count, nothing else.
    assert.equal(target.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1, agent);
  }
});

test('a checkout started is counted, and one our own check starts is not', async (t) => {
  const created = [];
  const stripe = async (url, init) => {
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    if (route === 'GET /v1/prices/price_monthly') {
      return Response.json({ id: 'price_monthly', object: 'price', active: true, livemode: true, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month', interval_count: 1 } });
    }
    if (route === 'POST /v1/customers') return Response.json({ id: 'cus_fixture', object: 'customer' });
    if (route === 'GET /v1/subscriptions' || route === 'GET /v1/checkout/sessions') return Response.json({ object: 'list', data: [], has_more: false, url: url.pathname });
    if (route === 'POST /v1/checkout/sessions') {
      created.push(String(init.body));
      return Response.json({ id: 'cs_live_fixture', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_live_fixture' });
    }
    return assert.fail(`Unexpected Stripe request: ${route}`);
  };
  const target = routeFetch(t, stripe);
  const billing = { BILLING_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_PRICE_ID: 'price_monthly' };
  for (const [agent, expected] of [[CHROME, 1], [CHECK_AGENT, undefined]]) {
    target.env = createEnv(billing);
    target.ctx = createContext();
    const { browser, headers } = await signUpAndIn(agent);
    const checkout = await browser.call('/api/billing/checkout', {}, { headers });
    assert.equal(checkout.url, 'https://checkout.stripe.com/c/pay/cs_live_fixture', agent);
    await target.ctx.settled();
    assert.equal(funnelCounts(target.env.DB).checkout_created, expected, agent);
  }
  // Both checkouts asked Stripe for the same thing: the account and the expiry aside, the requests are identical.
  const same = (body) => body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ACCOUNT').replace(/expires_at=\d+/, 'expires_at=T');
  assert.equal(created.length, 2);
  assert.equal(same(created[1]), same(created[0]));
});
