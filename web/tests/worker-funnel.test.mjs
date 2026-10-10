import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_VIEW, CLIENT_EVENTS, count, countVisit, dayOf, isBot, isOwnCheck, mcpClient, pageviewEvent, refCodeBucket, referrerBucket, visitSource } from '../src/funnel.ts';
import worker from '../src/worker.ts';
import { BROWSER_AGENT, SITE_ORIGIN, createContext, createEnv, funnelCounts } from './worker-helpers.mjs';
import { CHECK_AGENT } from '../../scripts/check-agent.mjs';

const CHROME = BROWSER_AGENT;

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
    'https://www.bing.com/search?q=x': 'bing',
    'https://duckduckgo.com/': 'duckduckgo',
    'https://chatgpt.com/': 'chatgpt',
    'https://chat.openai.com/c/1': 'chatgpt',
    'https://www.perplexity.ai/search/x': 'perplexity',
    'https://claude.ai/chat/1': 'claude',
    'https://copilot.microsoft.com/': 'copilot',
    // An assistant on a Google host is named before the rule for Google search.
    'https://gemini.google.com/app': 'gemini',
    'https://immunefi.com/bug-bounty/': 'immunefi',
    'https://cantina.xyz/': 'cantina',
    'https://audits.sherlock.xyz/': 'sherlock',
    'https://discord.com/channels/1/2': 'discord',
    'https://openrouter.ai/apps': 'openrouter',
    'https://t.me/somechannel': 'telegram',
    'https://warpcast.com/': 'farcaster',
    'https://farcaster.xyz/': 'farcaster',
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
  assert(!CLIENT_EVENTS.has('register'));
  assert(!CLIENT_EVENTS.has('sub_active'));
  for (const name of CLIENT_EVENTS) {
    assert.match(name, /^[a-z][a-z_]{2,40}$/);
    assert(!name.includes(':'));
  }
});
