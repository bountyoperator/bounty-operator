// The browser app's foundation modules, run under node: the parts that need no
// real DOM. fetch, sessionStorage and a few DOM calls are replaced by small
// stand-ins; the Worker's own event list is read from src/funnel.ts.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { CLIENT_EVENTS, EVENTS, isClientEvent } from '../public/app/events.mjs';
import {
  EXPORT_PROVIDER,
  MODES,
  STEPS,
  STORAGE_KEYS,
  createStore,
  initialState,
  loadWorkbench,
  parseHandoff,
  persistWorkbench,
  readSession,
  removeSession,
  saveWorkbench,
  shallowEqual,
  snapshot,
  takeHandoff,
  workbench,
  writeSession,
} from '../public/app/state.mjs';
import {
  button,
  el,
  formatBytes,
  formatCountdown,
  formatDate,
  formatElapsed,
  isBusy,
  notice,
  on,
  setBusy,
  timeUntil,
  toDate,
} from '../public/app/ui.mjs';
import { PROFILES } from '../public/profiles.mjs';
import { PROVIDERS } from '../public/providers.mjs';
import { LIMITS } from '../public/review-core.mjs';
import { CLIENT_EVENTS as WORKER_EVENTS } from '../src/funnel.ts';

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
let moduleCount = 0;

/** A fresh copy of api.mjs, so each test starts with an empty account cache. */
function loadApi() {
  moduleCount += 1;
  return import(`../public/app/api.mjs?copy=${moduleCount}`);
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

const ACCOUNT = {
  signedIn: true,
  csrf: 'csrf-1',
  usage: { plan: 'free', usedToday: 0, remainingToday: 1, running: 0, concurrency: 1, resetsAt: '2026-10-03T00:00:00.000Z', paidUntil: null },
  billing: 'live',
  hasSubscription: false,
  limits: { files: 50, fileBytes: 120000, totalBytes: 240000, promptChars: 16000 },
  price: { usd: 10, interval: 'week' },
  version: '0.7.0',
};

const SIGNED_OUT = { ...ACCOUNT, signedIn: false, csrf: undefined, usage: null };

/**
 * Replaces fetch. `routes` maps "METHOD /path" to a function returning a
 * Response (or throwing). Returns the list of calls made.
 */
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ path, method, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (init.signal?.aborted) throw abortError();
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`Unexpected fetch: ${method} ${path}`);
    return handler({ path, init, calls });
  };
  return calls;
}

const encoder = new TextEncoder();

/** A response body that delivers `chunks` one by one and fails when the request is aborted. */
function streamBody(chunks, { signal, hold = false } = {}) {
  return new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(abortError()), { once: true });
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      if (!hold) controller.close();
    },
  });
}

function sseResponse(chunks, options) {
  return new Response(streamBody(chunks, options), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Splits bytes into pieces of `size`, so events and multi-byte characters are cut mid-way. */
function slices(text, size) {
  const bytes = encoder.encode(text);
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += size) parts.push(bytes.slice(offset, offset + size));
  return parts;
}

const DONE = {
  review: '# Review\nVerdict: prove-first\nSeverity ≥ high — “quoted” 漢字 🚩\n',
  manifest: [{ label: 'input-1/src/Vault.sol', bytes: 18, sha256: 'ab'.repeat(32), lines: 1 }],
  profile: { id: 'solidity', name: 'Solidity review' },
  mode: 'bounty',
  model: 'stand-in-model',
  truncated: false,
  refused: false,
  usage: { input: 120, output: 48 },
};

const REVIEW_BODY = {
  files: [{ name: 'src/Vault.sol', content: 'contract Vault {}\n' }],
  prompt: '',
  profile: 'solidity',
  provider: 'openai',
  model: 'stand-in-model',
  apiKey: 'sk-stand-in-0000000000',
};

function reviewStreamText() {
  const pieces = ['# Review\n', 'Verdict: prove-first\n', 'Severity ≥ high — “quoted” 漢字 🚩\n'];
  return [': keep-alive\n\n', ...pieces.map((text) => sse('delta', { text })), ': keep-alive\n\n', sse('done', DONE)].join('');
}

class FakeStorage {
  constructor({ quota = Infinity } = {}) {
    this.items = new Map();
    this.quota = quota;
  }

  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }

  setItem(key, value) {
    if (String(value).length > this.quota) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    this.items.set(key, String(value));
  }

  removeItem(key) {
    this.items.delete(key);
  }
}

function useStorage(storage) {
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true, writable: true });
  return storage;
}

function blockStorage() {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new DOMException('Storage is blocked', 'SecurityError');
    },
  });
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.listeners = [];
    this.className = '';
    this.textContent = '';
    this.parentElement = null;
    this.style = { values: {}, setProperty: (name, value) => { this.style.values[name] = value; } };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeElement) node.parentElement = this;
      this.children.push(node);
    }
  }

  addEventListener(type, handler, options) {
    this.listeners.push({ type, handler, options });
  }

  removeEventListener(type, handler, options) {
    this.listeners = this.listeners.filter((entry) => !(entry.type === type && entry.handler === handler && entry.options === options));
  }

  /** Runs the listeners the way a browser does at the target: capturing ones first. */
  dispatch(type, event = {}) {
    const fired = { type, target: this, defaultPrevented: false, stopped: false, ...event };
    fired.preventDefault = () => { fired.defaultPrevented = true; };
    fired.stopImmediatePropagation = () => { fired.stopped = true; };
    const ordered = [...this.listeners.filter((entry) => entry.options === true), ...this.listeners.filter((entry) => entry.options !== true)];
    for (const entry of ordered) {
      if (entry.type !== type || fired.stopped) continue;
      entry.handler(fired);
    }
    return fired;
  }

  matchesClass(name) {
    return this.className.split(/\s+/).includes(name);
  }

  // Only what the helpers under test ask for: a class selector or a [data-x] selector.
  matches(selector) {
    if (selector.startsWith('.')) return this.matchesClass(selector.slice(1));
    const attribute = /^\[([\w-]+)\]$/.exec(selector);
    return attribute ? this.hasAttribute(attribute[1]) : false;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }

  contains(other) {
    for (let node = other; node; node = node.parentElement) if (node === this) return true;
    return false;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}

function useDocument() {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
  delete globalThis.sessionStorage;
  delete globalThis.document;
  workbench.reset();
});

// ---------------------------------------------------------------------------
// events.mjs
// ---------------------------------------------------------------------------

describe('events', () => {
  test('the client list is the Worker list, name for name', () => {
    assert.deepEqual([...CLIENT_EVENTS].sort(), [...WORKER_EVENTS].sort());
    assert.equal(new Set(CLIENT_EVENTS).size, CLIENT_EVENTS.length);
  });

  test('every constant is spelled like its key', () => {
    for (const [key, value] of Object.entries(EVENTS)) assert.equal(value, key.toLowerCase());
    assert.ok(Object.isFrozen(EVENTS) && Object.isFrozen(CLIENT_EVENTS));
  });

  test('isClientEvent accepts only listed names', () => {
    assert.equal(isClientEvent(EVENTS.PROMPT_EXPORTED), true);
    assert.equal(isClientEvent('pv:/'), false);
    assert.equal(isClientEvent('register'), false);
    assert.equal(isClientEvent(undefined), false);
    assert.equal(isClientEvent({ toString: () => 'example_loaded' }), false);
  });
});

// ---------------------------------------------------------------------------
// api.mjs: errors
// ---------------------------------------------------------------------------

describe('ApiError mapping', () => {
  test('a coded Worker body becomes code, status, message and data', async () => {
    const { ApiError, toApiError } = await loadApi();
    const error = toApiError(429, {
      error: "Today's free review is used. The next one opens at 00:00 UTC. Operator has no daily limit.",
      code: 'daily_used',
      resetsAt: '2026-10-03T00:00:00.000Z',
      upgradeUrl: 'https://bountyoperator.com/pricing',
    });
    assert.ok(error instanceof ApiError && error instanceof Error);
    assert.equal(error.name, 'ApiError');
    assert.equal(error.code, 'daily_used');
    assert.equal(error.status, 429);
    assert.match(error.message, /^Today's free review is used\./);
    assert.deepEqual(error.data, { resetsAt: '2026-10-03T00:00:00.000Z', upgradeUrl: 'https://bountyoperator.com/pricing' });
  });

  test('privacy findings and provider details travel in data', async () => {
    const { toApiError } = await loadApi();
    const findings = [{ source: 'input-1', name: 'deploy.sh', line: 3, kind: 'aws-access-key', severity: 'block' }];
    assert.deepEqual(toApiError(422, { error: 'Privacy check found sensitive material.', code: 'privacy_block', findings }).data, { findings });

    const provider = toApiError(502, { error: 'Provider rejected the API key (401).', code: 'provider', kind: 'auth', retryAfter: 12 });
    assert.equal(provider.code, 'provider');
    assert.deepEqual(provider.data, { kind: 'auth', retryAfter: 12 });
  });

  test('an answer with no JSON error gets a code and message from its status', async () => {
    const { toApiError } = await loadApi();
    const cases = [
      [429, null, 'rate_limited'],
      [413, undefined, 'too_large'],
      [503, '<html>upstream</html>', 'unavailable'],
      [520, [], 'unavailable'],
      [404, {}, 'bad_response'],
      [0, null, 'bad_response'],
    ];
    for (const [status, body, code] of cases) {
      const error = toApiError(status, body);
      assert.equal(error.code, code, String(status));
      assert.equal(error.status, status);
      assert.ok(error.message.length > 10);
      assert.deepEqual(error.data, {});
    }
    assert.match(toApiError(503, null).message, /HTTP 503/);
  });

  test('the Retry-After header fills retryAfter only when the body has none', async () => {
    const { toApiError } = await loadApi();
    assert.equal(toApiError(429, null, { retryAfter: '30' }).data.retryAfter, 30);
    assert.equal(toApiError(429, { code: 'rate_limited', error: 'Slow down.', retryAfter: 7 }, { retryAfter: '30' }).data.retryAfter, 7);
    assert.equal(toApiError(429, null, { retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' }).data.retryAfter, undefined);
    assert.equal(toApiError(429, null, { retryAfter: null }).data.retryAfter, undefined);
  });

  test('a body with a non-text error or code falls back without throwing', async () => {
    const { toApiError } = await loadApi();
    const error = toApiError(400, { error: { nested: true }, code: 42, detail: 'kept' });
    assert.equal(error.code, 'bad_response');
    assert.equal(error.message, 'The request failed (HTTP 400).');
    assert.deepEqual(error.data, { detail: 'kept' });
  });
});

// ---------------------------------------------------------------------------
// api.mjs: account cache and request()
// ---------------------------------------------------------------------------

describe('account cache', () => {
  test('concurrent first calls share one request, later calls use the cache', async () => {
    const api = await loadApi();
    const calls = mockFetch({ 'GET /api/account': () => jsonResponse(ACCOUNT) });

    assert.equal(api.currentAccount().loaded, false);
    assert.equal(api.planOf(), 'anon');
    const [first, second] = await Promise.all([api.account(), api.account()]);
    assert.equal(first, second);
    assert.equal(first.loaded, true);
    assert.equal(first.csrf, 'csrf-1');
    assert.equal(api.planOf(), 'free');
    await api.account();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.equal(calls[0].init.headers['X-CSRF-Token'], undefined);
    assert.ok(Object.isFrozen(api.currentAccount()));
  });

  test('subscribers hear changes only, and unsubscribe works', async () => {
    const api = await loadApi();
    let body = ACCOUNT;
    mockFetch({ 'GET /api/account': () => jsonResponse(body) });

    const heard = [];
    const off = api.subscribeAccount((account, previous) => heard.push([planLabel(api, account), planLabel(api, previous)]), { immediate: true });
    assert.deepEqual(heard, [['anon', 'anon']]);

    await api.refreshAccount();
    await api.refreshAccount();
    assert.deepEqual(heard.slice(1), [['free', 'anon']]);

    body = { ...ACCOUNT, usage: { ...ACCOUNT.usage, plan: 'weekly', remainingToday: null, concurrency: 4 }, hasSubscription: true };
    await api.refreshAccount();
    assert.deepEqual(heard.at(-1), ['operator', 'free']);

    off();
    body = { ...ACCOUNT, usage: { ...ACCOUNT.usage, plan: 'past_due' } };
    await api.refreshAccount();
    assert.equal(heard.length, 3);
    assert.equal(api.planOf(), 'past_due');
  });

  test('a failed load rejects with a network error and is tried again next time', async () => {
    const api = await loadApi();
    let fail = true;
    const calls = mockFetch({
      'GET /api/account': () => {
        if (fail) throw new TypeError('fetch failed');
        return jsonResponse(SIGNED_OUT);
      },
    });
    await assert.rejects(api.account(), (error) => error instanceof api.ApiError && error.code === 'network' && error.status === 0);
    fail = false;
    assert.equal((await api.account()).loaded, true);
    assert.equal(calls.length, 2);
  });

  test('a signed-out answer never keeps a token or usage', async () => {
    const api = await loadApi();
    mockFetch({ 'GET /api/account': () => jsonResponse({ ...ACCOUNT, signedIn: false }) });
    const account = await api.account();
    assert.equal(account.csrf, '');
    assert.equal(account.usage, null);
    assert.equal(account.hasSubscription, false);
    assert.equal(account.billing, 'live');
  });
});

function planLabel(api, account) {
  return api.planOf(account);
}

describe('request', () => {
  test('GET sends cookies and no CSRF token; POST sends both and a JSON body', async () => {
    const api = await loadApi();
    const calls = mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'GET /api/portal': () => jsonResponse({ passkeys: [] }),
      'POST /api/connections/revoke': () => jsonResponse({ revoked: true }),
      'POST /api/auth/logout-all': () => jsonResponse({ ok: true }),
    });

    assert.deepEqual(await api.request('/api/portal'), { passkeys: [] });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.headers['X-CSRF-Token'], undefined);

    // The first change loads the account for its CSRF token.
    assert.deepEqual(await api.request('/api/connections/revoke', { body: { id: 'c1' } }), { revoked: true });
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['GET /api/portal', 'GET /api/account', 'POST /api/connections/revoke']);
    const post = calls[2];
    assert.equal(post.init.credentials, 'same-origin');
    assert.equal(post.init.headers['X-CSRF-Token'], 'csrf-1');
    assert.equal(post.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(post.body, { id: 'c1' });

    // A POST with no body still carries a JSON object.
    await api.request('/api/auth/logout-all', { method: 'POST' });
    assert.deepEqual(calls.at(-1).body, {});
  });

  test('an error answer throws an ApiError with the Worker code', async () => {
    const api = await loadApi();
    mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'POST /api/billing/checkout': () => jsonResponse({ error: 'A subscription already exists.', code: 'billing_exists' }, 409),
      'POST /api/auth/recover': () => jsonResponse({ error: 'Too many requests.', code: 'rate_limited', retryAfter: 600 }, 429, { 'retry-after': '600' }),
      'GET /api/health': () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
      'GET /api/profiles': () => new Response('not json', { status: 200 }),
    });

    await assert.rejects(api.request('/api/billing/checkout', { body: {} }), (error) => {
      assert.ok(error instanceof api.ApiError);
      assert.deepEqual([error.code, error.status, error.message], ['billing_exists', 409, 'A subscription already exists.']);
      return true;
    });
    await assert.rejects(api.request('/api/auth/recover', { body: { code: 'x' } }), (error) => error.code === 'rate_limited' && error.data.retryAfter === 600);
    await assert.rejects(api.request('/api/health'), (error) => error.code === 'unavailable' && error.status === 502);
    await assert.rejects(api.request('/api/profiles'), (error) => error.code === 'bad_response' && error.status === 0);
  });

  test('204 resolves with null', async () => {
    const api = await loadApi();
    mockFetch({ 'GET /api/account': () => jsonResponse(ACCOUNT), 'POST /api/event': () => new Response(null, { status: 204 }) });
    assert.equal(await api.request('/api/event', { body: { event: 'example_loaded' } }), null);
  });

  test('network failure and abort are coded', async () => {
    const api = await loadApi();
    mockFetch({
      'GET /api/portal': () => {
        throw new TypeError('Failed to fetch');
      },
      'GET /api/health': () => jsonResponse({ status: 'ok' }),
    });
    await assert.rejects(api.request('/api/portal'), (error) => error instanceof api.ApiError && error.code === 'network');

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(api.request('/api/health', { signal: controller.signal }), (error) => error.code === 'aborted');
  });

  test('a csrf refusal reloads the account and sends the call once more', async () => {
    const api = await loadApi();
    let token = 'csrf-1';
    const calls = mockFetch({
      'GET /api/account': () => jsonResponse({ ...ACCOUNT, csrf: token }),
      'POST /api/auth/logout': ({ init }) =>
        init.headers['X-CSRF-Token'] === token
          ? jsonResponse({ signedIn: false })
          : jsonResponse({ error: 'Refresh the page and try again.', code: 'csrf' }, 403),
    });
    await api.account();
    token = 'csrf-2';

    assert.deepEqual(await api.request('/api/auth/logout', { body: {} }), { signedIn: false });
    const posts = calls.filter((call) => call.method === 'POST');
    assert.deepEqual(posts.map((call) => call.init.headers['X-CSRF-Token']), ['csrf-1', 'csrf-2']);
  });

  test('a second csrf refusal is thrown, not retried forever', async () => {
    const api = await loadApi();
    const calls = mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'POST /api/auth/logout': () => jsonResponse({ error: 'Refresh the page and try again.', code: 'csrf' }, 403),
    });
    await assert.rejects(api.request('/api/auth/logout', { body: {} }), (error) => error.code === 'csrf' && error.status === 403);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
  });

  test('a signin answer marks the cached account signed out and tells subscribers', async () => {
    const api = await loadApi();
    let expired = false;
    const calls = mockFetch({
      'GET /api/account': () => jsonResponse(expired ? SIGNED_OUT : ACCOUNT),
      'GET /api/portal': () => {
        expired = true;
        return jsonResponse({ error: 'Sign in to continue.', code: 'signin' }, 401);
      },
    });
    await api.account();
    const heard = [];
    api.subscribeAccount((account) => heard.push(account.signedIn));

    await assert.rejects(api.request('/api/portal'), (error) => error.code === 'signin' && error.status === 401);
    assert.deepEqual(heard, [false]);
    assert.equal(api.currentAccount().csrf, '');
    assert.equal(api.currentAccount().billing, 'live');

    // The cache is then checked against the Worker once, and subscribers are not told twice.
    assert.equal((await api.account()).signedIn, false);
    assert.equal(calls.filter((call) => call.path === '/api/account').length, 2);
    assert.deepEqual(heard, [false]);
  });

  test('a sign-in answer puts the new token to use at once and reloads the account', async () => {
    const api = await loadApi();
    let signedIn = false;
    const calls = mockFetch({
      'GET /api/account': () => jsonResponse(signedIn ? { ...ACCOUNT, csrf: 'csrf-new' } : SIGNED_OUT),
      'POST /api/auth/login/verify': () => {
        signedIn = true;
        return jsonResponse({ signedIn: true, csrf: 'csrf-new' });
      },
      'POST /api/connections/revoke': () => jsonResponse({ revoked: true }),
    });
    await api.account();
    const heard = [];
    api.subscribeAccount((account) => heard.push([account.signedIn, account.usage?.plan ?? null]));

    await api.request('/api/auth/login/verify', { body: { id: 'credential' } });
    assert.equal(api.currentAccount().csrf, 'csrf-new');
    // Subscribers hear one complete account, not a signed-in one without usage.
    const account = await api.account();
    assert.equal(account.usage.plan, 'free');
    assert.deepEqual(heard, [[true, 'free']]);

    await api.request('/api/connections/revoke', { body: { id: 'c1' } });
    assert.equal(calls.at(-1).init.headers['X-CSRF-Token'], 'csrf-new');
  });

  test('deleting the account signs the cache out', async () => {
    const api = await loadApi();
    let deleted = false;
    mockFetch({
      'GET /api/account': () => jsonResponse(deleted ? SIGNED_OUT : ACCOUNT),
      'POST /api/account/delete': () => {
        deleted = true;
        return jsonResponse({ deleted: true });
      },
    });
    await api.account();
    await api.request('/api/account/delete', { body: {} });
    assert.equal(api.currentAccount().signedIn, false);
    assert.equal((await api.account()).signedIn, false);
  });

  test('only /api/ paths are accepted', async () => {
    const api = await loadApi();
    const calls = mockFetch({});
    await assert.rejects(api.request('https://example.org/api/account'), TypeError);
    await assert.rejects(api.request('//example.org/api/account'), TypeError);
    await assert.rejects(api.request('/guide'), TypeError);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// api.mjs: SSE parser
// ---------------------------------------------------------------------------

describe('createSseParser', () => {
  async function parseAll(text, size) {
    const { createSseParser } = await loadApi();
    const events = [];
    const parser = createSseParser((event) => events.push(event));
    const decoder = new TextDecoder();
    for (const part of slices(text, size)) parser.feed(decoder.decode(part, { stream: true }));
    parser.feed(decoder.decode());
    parser.end();
    return events;
  }

  test('the same events come out however the bytes are split', async () => {
    const text = reviewStreamText();
    const whole = await parseAll(text, text.length * 4);
    assert.deepEqual(whole.map((event) => event.event), ['delta', 'delta', 'delta', 'done']);
    assert.equal(whole.slice(0, 3).map((event) => JSON.parse(event.data).text).join(''), DONE.review);
    assert.deepEqual(JSON.parse(whole[3].data), DONE);

    const total = encoder.encode(text).length;
    for (let size = 1; size <= total; size += 1) {
      assert.deepEqual(await parseAll(text, size), whole, `chunk size ${size}`);
    }
  });

  test('CRLF, lone CR and a CR split from its LF all end a line once', async () => {
    const { createSseParser } = await loadApi();
    const events = [];
    const parser = createSseParser((event) => events.push(event));
    parser.feed('event: delta\r');
    parser.feed('\ndata: {"text":"a"}\r\n\r');
    parser.feed('\nevent: delta\rdata: {"text":"b"}\r\r');
    parser.feed('data: last\n\n');
    assert.deepEqual(events, [
      { event: 'delta', data: '{"text":"a"}' },
      { event: 'delta', data: '{"text":"b"}' },
      { event: 'message', data: 'last' },
    ]);
  });

  test('comments, unknown fields and a leading byte-order mark are skipped; data lines join', async () => {
    const { createSseParser } = await loadApi();
    const events = [];
    const parser = createSseParser((event) => events.push(event));
    parser.feed('﻿: keep-alive\n\nid: 7\nretry: 100\nevent: note\ndata: one\ndata:two\ndata\n\n');
    parser.feed(': keep-alive\n\n\n\n');
    parser.feed('event: empty\n\n');
    assert.deepEqual(events, [{ event: 'note', data: 'one\ntwo\n' }]);
  });

  test('only one space after the colon is dropped, and colons in the value stay', async () => {
    const { createSseParser } = await loadApi();
    const events = [];
    const parser = createSseParser((event) => events.push(event));
    parser.feed('data:  two spaces: kept\n\n');
    assert.deepEqual(events, [{ event: 'message', data: ' two spaces: kept' }]);
  });

  test('end() delivers an event whose closing blank line never arrived', async () => {
    const { createSseParser } = await loadApi();
    const events = [];
    const parser = createSseParser((event) => events.push(event));
    parser.feed('event: done\ndata: {"review":"x"}');
    assert.deepEqual(events, []);
    parser.end();
    assert.deepEqual(events, [{ event: 'done', data: '{"review":"x"}' }]);
    parser.end();
    assert.equal(events.length, 1);
  });
});

// ---------------------------------------------------------------------------
// api.mjs: streamReview()
// ---------------------------------------------------------------------------

describe('streamReview', () => {
  test('deltas arrive in order, then done, across every chunking of the stream', async () => {
    const text = reviewStreamText();
    for (const size of [1, 2, 3, 5, 7, 16, 64, 100000]) {
      const api = await loadApi();
      const calls = mockFetch({
        'GET /api/account': () => jsonResponse(ACCOUNT),
        'POST /api/review': ({ init }) => sseResponse(slices(text, size), { signal: init.signal }),
      });

      const deltas = [];
      const finished = [];
      const result = await api.streamReview(REVIEW_BODY, { onDelta: (piece) => deltas.push(piece), onDone: (value) => finished.push(value) });

      assert.equal(deltas.join(''), DONE.review, `chunk size ${size}`);
      assert.deepEqual(result, DONE);
      assert.deepEqual(finished, [DONE]);

      const post = calls.find((call) => call.method === 'POST');
      assert.deepEqual(post.body, { ...REVIEW_BODY, stream: true });
      assert.equal(post.init.headers['X-CSRF-Token'], 'csrf-1');
      assert.equal(post.init.credentials, 'same-origin');
      assert.match(post.init.headers.Accept, /text\/event-stream/);
    }
  });

  test('the caller body is not changed and the key is not kept on it by the module', async () => {
    const api = await loadApi();
    mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'POST /api/review': ({ init }) => sseResponse([sse('done', DONE)], { signal: init.signal }),
    });
    const body = { ...REVIEW_BODY };
    await api.streamReview(body);
    assert.deepEqual(body, REVIEW_BODY);
    assert.equal('stream' in body, false);
  });

  test('the account is reloaded after a review, because usage changed', async () => {
    const api = await loadApi();
    let used = 0;
    mockFetch({
      'GET /api/account': () => jsonResponse({ ...ACCOUNT, usage: { ...ACCOUNT.usage, usedToday: used, remainingToday: 1 - used } }),
      'POST /api/review': ({ init }) => {
        used = 1;
        return sseResponse([sse('done', DONE)], { signal: init.signal });
      },
    });
    await api.streamReview(REVIEW_BODY);
    assert.equal((await api.account()).usage.remainingToday, 0);
  });

  test('an error event rejects with its code and keeps the text that arrived', async () => {
    const api = await loadApi();
    mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'POST /api/review': ({ init }) =>
        sseResponse(
          [sse('delta', { text: '# Review\n' }), sse('error', { error: 'Provider stopped answering after 180 seconds.', code: 'provider', kind: 'timeout' }), sse('done', DONE)],
          { signal: init.signal },
        ),
    });
    const finished = [];
    await assert.rejects(api.streamReview(REVIEW_BODY, { onDone: (value) => finished.push(value) }), (error) => {
      assert.ok(error instanceof api.ApiError);
      assert.equal(error.code, 'provider');
      assert.equal(error.status, 0);
      assert.equal(error.message, 'Provider stopped answering after 180 seconds.');
      assert.deepEqual(error.data, { kind: 'timeout', partial: '# Review\n' });
      return true;
    });
    assert.deepEqual(finished, []);
  });

  test('with onError the promise resolves null and exactly one callback ends the call', async () => {
    const api = await loadApi();
    mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'POST /api/review': () =>
        jsonResponse({ error: "Today's free review is used.", code: 'daily_used', resetsAt: '2026-10-03T00:00:00.000Z', upgradeUrl: 'https://bountyoperator.com/pricing' }, 429),
    });
    const ended = [];
    const result = await api.streamReview(REVIEW_BODY, {
      onDelta: () => ended.push('delta'),
      onDone: () => ended.push('done'),
      onError: (error) => ended.push(`${error.code}:${error.status}:${error.data.resetsAt}`),
    });
    assert.equal(result, null);
    assert.deepEqual(ended, ['daily_used:429:2026-10-03T00:00:00.000Z']);
  });

  test('errors the Worker finds before the first token arrive as JSON and keep their fields', async () => {
    const findings = [{ source: 'input-1', name: 'notes.md', line: 2, kind: 'email-address', severity: 'warn' }];
    const answers = [
      [{ error: 'Privacy check found possibly sensitive material.', code: 'privacy_warn', findings }, 422],
      [{ error: 'This account is running as many reviews as its plan allows.', code: 'review_running' }, 409],
      [{ error: 'Provider rejected the API key (401).', code: 'provider', kind: 'auth' }, 502],
      [{ error: 'Enter a model identifier of up to 200 characters, without spaces.', code: 'bad_model' }, 400],
    ];
    for (const [body, status] of answers) {
      const api = await loadApi();
      mockFetch({ 'GET /api/account': () => jsonResponse(ACCOUNT), 'POST /api/review': () => jsonResponse(body, status) });
      await assert.rejects(api.streamReview(REVIEW_BODY), (error) => {
        assert.equal(error.code, body.code);
        assert.equal(error.status, status);
        assert.equal(error.message, body.error);
        if (body.findings) assert.deepEqual(error.data.findings, findings);
        return true;
      });
    }
  });

  test('a JSON answer in place of a stream is delivered as one delta and done', async () => {
    const api = await loadApi();
    mockFetch({ 'GET /api/account': () => jsonResponse(ACCOUNT), 'POST /api/review': () => jsonResponse(DONE) });
    const deltas = [];
    const result = await api.streamReview(REVIEW_BODY, { onDelta: (piece) => deltas.push(piece) });
    assert.deepEqual(deltas, [DONE.review]);
    assert.deepEqual(result, DONE);
  });

  test('a stream that closes without a result is stream_ended, with the partial text', async () => {
    const api = await loadApi();
    mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'POST /api/review': ({ init }) =>
        sseResponse([sse('delta', { text: 'half a ' }), sse('delta', { text: 'review' }), 'event: done\ndata: {"review":"half a rev'], { signal: init.signal }),
    });
    await assert.rejects(api.streamReview(REVIEW_BODY), (error) => error.code === 'stream_ended' && error.data.partial === 'half a review');
  });

  test('aborting stops the stream with code aborted and the partial text', async () => {
    const api = await loadApi();
    mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'POST /api/review': ({ init }) => sseResponse([sse('delta', { text: 'first part' })], { signal: init.signal, hold: true }),
    });
    const controller = new AbortController();
    const failures = [];
    const result = await api.streamReview(REVIEW_BODY, {
      onDelta: () => controller.abort(),
      onError: (error) => failures.push(error),
      signal: controller.signal,
    });
    assert.equal(result, null);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'aborted');
    assert.equal(failures[0].data.partial, 'first part');
  });

  test('an already aborted signal sends nothing', async () => {
    const api = await loadApi();
    const calls = mockFetch({ 'GET /api/account': () => jsonResponse(ACCOUNT) });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(api.streamReview(REVIEW_BODY, { signal: controller.signal }), (error) => error.code === 'aborted');
    assert.equal(calls.some((call) => call.method === 'POST'), false);
  });

  test('a stream that goes silent after its first bytes times out', async () => {
    const api = await loadApi();
    mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'POST /api/review': ({ init }) => sseResponse([': keep-alive\n\n', sse('delta', { text: 'started' })], { signal: init.signal, hold: true }),
    });
    await assert.rejects(api.streamReview(REVIEW_BODY, {}, { idleMs: 30 }), (error) => {
      assert.equal(error.code, 'timeout');
      assert.equal(error.data.partial, 'started');
      assert.match(error.message, /went silent/);
      return true;
    });
  });

  test('a request that never answers times out on the first-byte limit', async () => {
    const api = await loadApi();
    mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'POST /api/review': ({ init }) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(abortError()), { once: true });
        }),
    });
    await assert.rejects(api.streamReview(REVIEW_BODY, {}, { firstByteMs: 30 }), (error) => error.code === 'timeout' && /did not start answering/.test(error.message));
  });

  test('a signed-out visitor is refused before the files and the key are sent', async () => {
    const api = await loadApi();
    const calls = mockFetch({ 'GET /api/account': () => jsonResponse(SIGNED_OUT) });
    await assert.rejects(api.streamReview(REVIEW_BODY), (error) => error.code === 'signin' && error.status === 401);
    assert.equal(calls.some((call) => call.method === 'POST'), false);
    assert.equal(JSON.stringify(calls).includes(REVIEW_BODY.apiKey), false);
  });

  test('a csrf refusal is retried once with the new token', async () => {
    const api = await loadApi();
    let token = 'csrf-1';
    const calls = mockFetch({
      'GET /api/account': () => jsonResponse({ ...ACCOUNT, csrf: token }),
      'POST /api/review': ({ init }) =>
        init.headers['X-CSRF-Token'] === token
          ? sseResponse([sse('done', DONE)], { signal: init.signal })
          : jsonResponse({ error: 'Refresh the page and try again.', code: 'csrf' }, 403),
    });
    await api.account();
    token = 'csrf-2';
    assert.deepEqual(await api.streamReview(REVIEW_BODY), DONE);
    assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => call.init.headers['X-CSRF-Token']), ['csrf-1', 'csrf-2']);
  });

  test('a callback that throws does not lose the review', async () => {
    const api = await loadApi();
    const reported = [];
    console.error = (error) => reported.push(error);
    const realReport = globalThis.reportError;
    globalThis.reportError = (error) => reported.push(error);
    try {
      mockFetch({
        'GET /api/account': () => jsonResponse(ACCOUNT),
        'POST /api/review': ({ init }) => sseResponse(slices(reviewStreamText(), 9), { signal: init.signal }),
      });
      const result = await api.streamReview(REVIEW_BODY, {
        onDelta: () => {
          throw new Error('render bug');
        },
      });
      assert.deepEqual(result, DONE);
      assert.equal(reported.length, 3);
    } finally {
      if (realReport === undefined) delete globalThis.reportError;
      else globalThis.reportError = realReport;
    }
  });

  test('network failure is coded network', async () => {
    const api = await loadApi();
    mockFetch({
      'GET /api/account': () => jsonResponse(ACCOUNT),
      'POST /api/review': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await assert.rejects(api.streamReview(REVIEW_BODY), (error) => error.code === 'network' && error.data.partial === undefined);
  });
});

// ---------------------------------------------------------------------------
// api.mjs: withReauth() and track()
// ---------------------------------------------------------------------------

describe('withReauth', () => {
  const reauth = (api) => new api.ApiError('Confirm with your passkey to continue.', { code: 'reauth', status: 401 });

  test('a reauth error runs the handler and the call once more', async () => {
    const api = await loadApi();
    const order = [];
    api.setReauthHandler(async (error) => {
      order.push(`handler:${error.code}`);
    });
    let attempts = 0;
    const result = await api.withReauth(async () => {
      attempts += 1;
      order.push(`call:${attempts}`);
      if (attempts === 1) throw reauth(api);
      return { recoveryCode: 'shown-once' };
    });
    assert.deepEqual(result, { recoveryCode: 'shown-once' });
    assert.deepEqual(order, ['call:1', 'handler:reauth', 'call:2']);
  });

  test('a second reauth error is thrown: one retry only', async () => {
    const api = await loadApi();
    let prompts = 0;
    api.setReauthHandler(() => {
      prompts += 1;
    });
    let attempts = 0;
    await assert.rejects(
      api.withReauth(async () => {
        attempts += 1;
        throw reauth(api);
      }),
      (error) => error.code === 'reauth',
    );
    assert.deepEqual([attempts, prompts], [2, 1]);
  });

  test('other errors, and reauth with no handler, pass through untouched', async () => {
    const api = await loadApi();
    const original = reauth(api);
    await assert.rejects(api.withReauth(async () => { throw original; }), (error) => error === original);

    let prompts = 0;
    const unregister = api.setReauthHandler(() => {
      prompts += 1;
    });
    const other = new api.ApiError('Keep at least one passkey.', { code: 'last_passkey', status: 400 });
    await assert.rejects(api.withReauth(async () => { throw other; }), (error) => error === other);
    assert.equal(prompts, 0);

    unregister();
    await assert.rejects(api.withReauth(async () => { throw original; }), (error) => error === original);
    assert.equal(prompts, 0);
  });

  test('a cancelled check throws the reauth error and does not retry', async () => {
    const api = await loadApi();
    api.setReauthHandler(async () => false);
    let attempts = 0;
    await assert.rejects(
      api.withReauth(async () => {
        attempts += 1;
        throw reauth(api);
      }),
      (error) => error.code === 'reauth',
    );
    assert.equal(attempts, 1);

    const cancelled = new DOMException('The operation was cancelled.', 'NotAllowedError');
    api.setReauthHandler(async () => {
      throw cancelled;
    });
    await assert.rejects(api.withReauth(async () => { throw reauth(api); }), (error) => error === cancelled);
  });

  test('calls that need the check at the same time share one prompt', async () => {
    const api = await loadApi();
    let prompts = 0;
    let confirm;
    api.setReauthHandler(() => {
      prompts += 1;
      return new Promise((resolve) => {
        confirm = resolve;
      });
    });
    const attempts = { a: 0, b: 0 };
    const call = (name) =>
      api.withReauth(async () => {
        attempts[name] += 1;
        if (attempts[name] === 1) throw reauth(api);
        return name;
      });
    const both = Promise.all([call('a'), call('b')]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    confirm();
    assert.deepEqual(await both, ['a', 'b']);
    assert.equal(prompts, 1);

    // A later reauth is a new prompt.
    attempts.a = 0;
    const later = call('a');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(prompts, 2);
    confirm();
    assert.equal(await later, 'a');
    assert.equal(attempts.a, 2);
  });
});

describe('track', () => {
  test('a listed event is posted once, without cookies, and survives navigation', async () => {
    const api = await loadApi();
    const calls = mockFetch({ 'POST /api/event': () => new Response(null, { status: 204 }) });
    assert.equal(api.track(EVENTS.PACKET_SAVED), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { event: 'packet_saved' });
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.keepalive, true);
    assert.equal(calls[0].init.headers['X-CSRF-Token'], undefined);
    assert.ok(calls[0].init.body.length < 200, 'the Worker reads at most 200 bytes');
  });

  test('every listed event fits the body limit of the Worker', () => {
    for (const event of CLIENT_EVENTS) assert.ok(JSON.stringify({ event }).length < 200);
  });

  test('an unlisted name is dropped, and a failed post is silent', async () => {
    const api = await loadApi();
    const calls = mockFetch({
      'POST /api/event': () => {
        throw new TypeError('offline');
      },
    });
    assert.equal(api.track('pv:/'), false);
    assert.equal(api.track(''), false);
    assert.equal(api.track(undefined), false);
    assert.equal(calls.length, 0);

    assert.equal(api.track(EVENTS.EXAMPLE_LOADED), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// state.mjs: store
// ---------------------------------------------------------------------------

describe('store', () => {
  test('the default workbench state has the ten documented fields', () => {
    const state = workbench.get();
    assert.deepEqual(Object.keys(state), ['files', 'focus', 'context', 'profile', 'mode', 'provider', 'model', 'step', 'result', 'busy']);
    assert.deepEqual(state.files, []);
    assert.deepEqual(state.context, { target: '', scope: '', version: '', proof: 'none', prior: 'unchecked', notes: '', rules: '' });
    assert.equal(state.profile, 'general');
    assert.equal(state.mode, 'bounty');
    assert.equal(state.provider, PROVIDERS[0].id);
    assert.equal(state.step, 'files');
    assert.equal(state.result, null);
    assert.equal(state.busy, false);
    assert.deepEqual(STEPS, ['files', 'review', 'results']);
    assert.deepEqual(MODES, ['bounty', 'own-code']);
    assert.notEqual(initialState().files, initialState().files);
    assert.equal(initialState({ profile: 'report' }).profile, 'report');
  });

  test('set merges, freezes, and tells subscribers only when a value changed', () => {
    const store = createStore({ count: 0, label: 'a' });
    const heard = [];
    const off = store.subscribe((state, previous) => heard.push([state.count, previous.count]));

    assert.equal(store.set({ count: 0 }), store.get());
    assert.deepEqual(heard, []);
    store.set({ count: 1 });
    store.set((state) => ({ count: state.count + 1 }));
    store.set(() => null);
    store.set(undefined);
    assert.deepEqual(heard, [[1, 0], [2, 1]]);
    assert.deepEqual(store.get(), { count: 2, label: 'a' });
    assert.ok(Object.isFrozen(store.get()));
    assert.throws(() => {
      'use strict';
      store.get().count = 9;
    }, TypeError);

    off();
    store.set({ count: 3 });
    assert.equal(heard.length, 2);
  });

  test('immediate subscribers are called once with the current state', () => {
    const store = createStore({ step: 'files' });
    const heard = [];
    store.subscribe((state, previous) => heard.push([state.step, previous.step]), { immediate: true });
    assert.deepEqual(heard, [['files', 'files']]);
  });

  test('select fires when the picked value changes, with the previous value', () => {
    const store = createStore({ busy: false, provider: 'openrouter', model: '' });
    const busy = [];
    const pair = [];
    store.select((state) => state.busy, (value, previous) => busy.push([value, previous]), { immediate: true });
    store.select((state) => [state.provider, state.model], (value) => pair.push(value), { equal: shallowEqual });

    store.set({ model: 'x' });
    store.set({ busy: true });
    store.set({ busy: true, provider: 'openrouter' });
    store.set({ busy: false, provider: 'openai' });
    assert.deepEqual(busy, [[false, false], [true, false], [false, true]]);
    assert.deepEqual(pair, [['openrouter', 'x'], ['openai', 'x']]);
  });

  test('a set made inside a listener is delivered in order to every listener', () => {
    const store = createStore({ step: 'files', busy: false });
    const first = [];
    const second = [];
    store.subscribe((state) => {
      first.push(`${state.step}:${state.busy}`);
      if (state.step === 'review' && !state.busy) store.set({ busy: true });
    });
    store.subscribe((state, previous) => second.push(`${previous.step}:${previous.busy}>${state.step}:${state.busy}`));

    store.set({ step: 'review' });
    assert.deepEqual(first, ['review:false', 'review:true']);
    assert.deepEqual(second, ['files:false>review:false', 'review:false>review:true']);
  });

  test('a listener that throws is reported and the others still run', () => {
    const reported = [];
    console.error = (error) => reported.push(error);
    const realReport = globalThis.reportError;
    globalThis.reportError = (error) => reported.push(error);
    try {
      const store = createStore({ n: 0 });
      const heard = [];
      store.subscribe(() => {
        throw new Error('listener bug');
      });
      store.subscribe((state) => heard.push(state.n));
      store.set({ n: 1 });
      assert.deepEqual(heard, [1]);
      assert.equal(reported.length, 1);
    } finally {
      if (realReport === undefined) delete globalThis.reportError;
      else globalThis.reportError = realReport;
    }
  });

  test('a listener that never settles is stopped', () => {
    const reported = [];
    console.error = (error) => reported.push(error);
    const store = createStore({ n: 0 });
    store.subscribe((state) => store.set({ n: state.n + 1 }));
    assert.throws(() => store.set({ n: 1 }), /keeps changing the state/);
  });

  test('reset returns to a fresh initial state and notifies', () => {
    const store = createStore(() => ({ files: [], step: 'files' }));
    const before = store.get().files;
    store.set({ files: [{ name: 'a', content: 'b' }], step: 'review' });
    const heard = [];
    store.subscribe((state) => heard.push(state.step));
    store.reset({ step: 'results' });
    assert.deepEqual(store.get(), { files: [], step: 'results' });
    assert.notEqual(store.get().files, before);
    assert.deepEqual(heard, ['results']);
  });

  test('shallowEqual compares one level', () => {
    assert.equal(shallowEqual([1, 'a'], [1, 'a']), true);
    assert.equal(shallowEqual({ a: 1 }, { a: 1 }), true);
    assert.equal(shallowEqual({ a: 1 }, { a: 1, b: undefined }), false);
    assert.equal(shallowEqual([1], { 0: 1 }), false);
    assert.equal(shallowEqual({ a: {} }, { a: {} }), false);
    assert.equal(shallowEqual(null, null), true);
    assert.equal(shallowEqual(null, {}), false);
    assert.equal(shallowEqual(NaN, NaN), true);
  });
});

// ---------------------------------------------------------------------------
// state.mjs: sessionStorage
// ---------------------------------------------------------------------------

describe('session storage', () => {
  test('values round-trip as JSON, and a missing or broken value reads as null', () => {
    const storage = useStorage(new FakeStorage());
    assert.equal(readSession('bo:tab'), null);
    assert.equal(writeSession('bo:tab', { view: 'raw', open: [1, 2] }), true);
    assert.deepEqual(readSession('bo:tab'), { view: 'raw', open: [1, 2] });
    storage.setItem('bo:broken', '{not json');
    assert.equal(readSession('bo:broken'), null);
    removeSession('bo:tab');
    assert.equal(readSession('bo:tab'), null);
  });

  test('anything named like a credential is refused, at any depth', () => {
    const storage = useStorage(new FakeStorage());
    const complaints = [];
    console.error = (message) => complaints.push(message);

    const refused = [
      { apiKey: 'sk-live' },
      { api_key: 'sk-live' },
      { 'API-Key': 'sk-live' },
      { settings: { provider: 'openai', key: 'sk-live' } },
      { github: { token: 'ghp_x' } },
      { githubToken: 'ghp_x' },
      { runs: [{ model: 'x', providerKey: 'sk-live' }] },
      { csrf: 'abc' },
      { recoveryCode: 'abc' },
      { password: 'abc' },
      { Authorization: 'Bearer bok_x' },
      { secret: 'abc' },
    ];
    for (const value of refused) assert.equal(writeSession('bo:test', value), false, JSON.stringify(value));
    assert.equal(storage.items.size, 0);
    assert.equal(complaints.length, refused.length);
    assert.match(complaints[3], /settings\.key/);
    assert.equal(complaints.join('\n').includes('sk-live'), false, 'the refusal never prints the value');

    // Names that only contain such a word are data, not credentials.
    assert.equal(writeSession('bo:test', { files: [{ name: 'src/Token.sol', content: 'token key secret' }], keyLabel: 'x', tokens: 3 }), true);
  });

  test('blocked or missing storage never throws', () => {
    assert.equal(readSession('bo:tab'), null);
    assert.equal(writeSession('bo:tab', { a: 1 }), false);
    assert.doesNotThrow(() => removeSession('bo:tab'));
    assert.equal(takeHandoff(), null);
    assert.equal(loadWorkbench(), null);

    blockStorage();
    assert.equal(readSession('bo:tab'), null);
    assert.equal(writeSession('bo:tab', { a: 1 }), false);
    assert.doesNotThrow(() => removeSession('bo:tab'));
    assert.equal(takeHandoff(), null);
    assert.equal(saveWorkbench(), false);
  });
});

describe('stored workbench', () => {
  const RESULT = { ...DONE, provider: 'openai', source: 'ai', timestamp: '2026-10-02T10:00:00.000Z' };

  test('a state survives a save and a load; busy does not', () => {
    const storage = useStorage(new FakeStorage());
    workbench.set({
      files: [{ name: 'src/Vault.sol', content: 'contract Vault {}\n' }],
      focus: 'Check the withdraw path.',
      context: { ...workbench.get().context, target: 'Vault', proof: 'local', impactRow: 'Direct theft of user funds' },
      profile: 'solidity',
      mode: 'own-code',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      step: 'results',
      result: RESULT,
      busy: true,
    });
    assert.equal(saveWorkbench(), true);
    assert.deepEqual([...storage.items.keys()], [STORAGE_KEYS.workbench]);

    const loaded = loadWorkbench();
    assert.equal('busy' in loaded, false);
    assert.equal('v' in loaded, false);
    const { busy, ...expected } = workbench.get();
    assert.deepEqual(loaded, expected);

    workbench.reset();
    workbench.set(loaded);
    assert.equal(workbench.get().busy, false);
    assert.equal(workbench.get().context.impactRow, 'Direct theft of user funds');
  });

  test('a key or token on the state never reaches storage', () => {
    const storage = useStorage(new FakeStorage());
    console.error = () => {};
    const state = {
      ...initialState(),
      apiKey: 'sk-live-0000000000000000',
      githubToken: 'ghp_0000000000000000',
      files: [{ name: 'a.sol', content: 'x', apiKey: 'sk-live-0000000000000000' }],
      context: { ...initialState().context, notes: 'n', token: 'bok_secret', apiKey: 'sk-live-0000000000000000' },
      model: 'sk-live-0000000000000000',
    };
    const stored = snapshot(state);
    assert.equal(JSON.stringify(stored).includes('sk-live'), false);
    assert.equal(JSON.stringify(stored).includes('ghp_'), false);
    assert.equal(JSON.stringify(stored).includes('bok_'), false);
    assert.equal(stored.model, '');
    assert.equal(stored.context.notes, 'n');

    assert.equal(saveWorkbench(state), true);
    assert.equal(storage.getItem(STORAGE_KEYS.workbench).includes('sk-live'), false);

    // A result that carries a credential-named field is dropped whole.
    assert.equal(snapshot({ ...initialState(), step: 'results', result: { review: 'r', manifest: [], apiKey: 'sk-live' } }).result, null);
  });

  test('stored values are checked again on load', () => {
    const storage = useStorage(new FakeStorage());
    storage.setItem(STORAGE_KEYS.workbench, JSON.stringify({
      v: 1,
      files: [{ name: '../etc/passwd', content: 'x' }, { name: 'ok.md', content: 'fine' }, 'nope'],
      focus: 42,
      context: { target: 'T', proof: 'made-up', prior: 'overlap', notes: ['x'], __proto__: { polluted: true }, constructor: 'c' },
      profile: 'verdict',
      mode: 'attack',
      provider: 'nobody',
      model: 'has spaces',
      step: 'results',
      result: { review: 12 },
      busy: true,
      extra: 'ignored',
    }));
    assert.deepEqual(loadWorkbench(), {
      files: [{ name: 'ok.md', content: 'fine' }],
      focus: '',
      context: { target: 'T', scope: '', version: '', proof: 'none', prior: 'overlap', notes: '', rules: '' },
      profile: 'general',
      mode: 'bounty',
      provider: PROVIDERS[0].id,
      model: '',
      step: 'files',
      result: null,
    });
    assert.equal({}.polluted, undefined);

    storage.setItem(STORAGE_KEYS.workbench, JSON.stringify({ v: 99, files: [] }));
    assert.equal(loadWorkbench(), null);
    storage.setItem(STORAGE_KEYS.workbench, '[]');
    assert.equal(loadWorkbench(), null);
  });

  test('the export choice and the legacy profile id are kept', () => {
    useStorage(new FakeStorage());
    saveWorkbench({ ...initialState(), provider: EXPORT_PROVIDER, profile: 'v06-solidity' });
    const loaded = loadWorkbench();
    assert.equal(loaded.provider, 'export');
    assert.equal(loaded.profile, 'solidity');
  });

  test('when storage is short of room the result goes first, then the files', () => {
    const state = {
      ...initialState(),
      files: [{ name: 'a.sol', content: 'x'.repeat(3000) }],
      step: 'results',
      result: { ...RESULT, review: 'r'.repeat(8000) },
    };

    useStorage(new FakeStorage({ quota: 6000 }));
    assert.equal(saveWorkbench(state), true);
    let loaded = loadWorkbench();
    assert.equal(loaded.result, null);
    assert.equal(loaded.step, 'files');
    assert.equal(loaded.files.length, 1);

    useStorage(new FakeStorage({ quota: 1000 }));
    assert.equal(saveWorkbench(state), true);
    loaded = loadWorkbench();
    assert.deepEqual(loaded.files, []);

    useStorage(new FakeStorage({ quota: 10 }));
    assert.equal(saveWorkbench(state), false);
  });

  test('persistWorkbench saves after a change to a stored field, once per delay', async () => {
    const storage = useStorage(new FakeStorage());
    let writes = 0;
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      writes += 1;
      setItem(key, value);
    };
    const store = createStore(initialState);
    const stop = persistWorkbench(store, { delay: 15 });

    store.set({ busy: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(writes, 0, 'busy is not stored, so it does not trigger a save');

    store.set({ focus: 'one' });
    store.set({ focus: 'two' });
    store.set({ profile: 'report' });
    assert.equal(writes, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(writes, 1);
    assert.equal(loadWorkbench().focus, 'two');
    assert.equal(loadWorkbench().profile, 'report');

    // stop() writes what is still pending and stops listening.
    store.set({ focus: 'three' });
    stop();
    assert.equal(writes, 2);
    assert.equal(loadWorkbench().focus, 'three');
    store.set({ focus: 'four' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(writes, 2);
  });
});

// ---------------------------------------------------------------------------
// state.mjs: handoff
// ---------------------------------------------------------------------------

describe('handoff', () => {
  const VALID = {
    files: [
      { name: 'src/HarborVault.sol', content: 'contract HarborVault {}\n' },
      { name: 'draft-report.md', content: '# Draft\n' },
    ],
    profile: 'report',
    focus: 'Check every claim in draft-report.md against src/HarborVault.sol.',
    context: { target: 'HarborVault', scope: 'src/HarborVault.sol', version: '', proof: 'none', prior: 'unchecked', notes: 'Invented contract.' },
  };

  test('a valid handoff comes back complete', () => {
    const handoff = parseHandoff(JSON.stringify(VALID));
    assert.deepEqual(Object.keys(handoff), ['files', 'profile', 'focus', 'context', 'skipped']);
    assert.deepEqual(handoff.files, VALID.files);
    assert.equal(handoff.profile, 'report');
    assert.equal(handoff.focus, VALID.focus);
    assert.deepEqual(handoff.context, { ...VALID.context, rules: '' });
    assert.deepEqual(handoff.skipped, []);
    assert.deepEqual(parseHandoff(VALID), handoff, 'an object is accepted as well as JSON text');
  });

  test('the payloads the tools and templates write are accepted', () => {
    // tools/report-check and tools/slither-focus: an empty context.
    const tool = parseHandoff(JSON.stringify({ files: [{ name: 'slither-focus.md', content: '# Queue\n' }], profile: 'scanner', focus: 'Triage these.', context: {} }));
    assert.equal(tool.profile, 'scanner');
    assert.deepEqual(tool.context, { target: '', scope: '', version: '', proof: 'none', prior: 'unchecked', notes: '', rules: '' });

    // templates: only a note.
    const template = parseHandoff(JSON.stringify({ files: [{ name: 'draft.md', content: 'x' }], profile: 'report', focus: 'f', context: { notes: 'From the Immunefi template.' } }));
    assert.equal(template.context.notes, 'From the Immunefi template.');
    assert.equal(template.context.proof, 'none');

    // Every listed profile is accepted by id.
    for (const profile of PROFILES.filter((entry) => entry.listed)) {
      assert.equal(parseHandoff({ files: [], profile: profile.id, focus: '', context: {} }).profile, profile.id);
    }
  });

  test('anything that is not a JSON object is no handoff', () => {
    for (const raw of ['', 'not json', '[]', '"text"', '42', 'null', 'true', null, undefined, 42, [], `{"files":${'['.repeat(10)}`]) {
      assert.equal(parseHandoff(raw), null, String(raw));
    }
    assert.equal(parseHandoff(`{"focus":"${'a'.repeat(2000001)}"}`), null, 'text over 2 MB is not parsed');
  });

  test('files the engine would refuse are skipped with a reason', () => {
    const big = 'x'.repeat(LIMITS.fileBytes + 1);
    const handoff = parseHandoff({
      files: [
        { name: 'ok.sol', content: 'contract A {}' },
        { name: '../secrets.env', content: 'x' },
        { name: '/abs/path.sol', content: 'x' },
        { name: 'a\\b.sol', content: 'x' },
        { name: '', content: 'x' },
        { name: 'no-content.sol' },
        { name: 'binary.bin', content: 'a\0b' },
        { name: 'number.sol', content: 42 },
        { name: 'big.log', content: big },
        null,
        'text',
        { name: 'also-ok.md', content: '' },
      ],
      profile: 'poc',
      focus: 'f',
      context: {},
    });
    assert.deepEqual(handoff.files.map((file) => file.name), ['ok.sol', 'also-ok.md']);
    assert.deepEqual(handoff.skipped, [
      { name: 'file 2', reason: 'The file name is not supported.' },
      { name: 'file 3', reason: 'The file name is not supported.' },
      { name: 'file 4', reason: 'The file name is not supported.' },
      { name: 'file 5', reason: 'The file name is not supported.' },
      { name: 'no-content.sol', reason: 'The file is not UTF-8 text.' },
      { name: 'binary.bin', reason: 'The file is not UTF-8 text.' },
      { name: 'number.sol', reason: 'The file is not UTF-8 text.' },
      { name: 'big.log', reason: 'Over the 120 KB file limit.' },
      { name: 'file 10', reason: 'The file name is not supported.' },
      { name: 'file 11', reason: 'The file name is not supported.' },
    ]);
  });

  test('the file count and the total size are held to the engine limits', () => {
    const many = Array.from({ length: LIMITS.files + 3 }, (_, index) => ({ name: `f${index}.txt`, content: 'x' }));
    const counted = parseHandoff({ files: many });
    assert.equal(counted.files.length, LIMITS.files);
    assert.equal(counted.skipped.length, 3);
    assert.equal(counted.skipped[0].reason, `Over the ${LIMITS.files}-file limit.`);

    const chunk = 'y'.repeat(100000);
    const heavy = parseHandoff({ files: [{ name: 'a.txt', content: chunk }, { name: 'b.txt', content: chunk }, { name: 'c.txt', content: chunk }, { name: 'd.txt', content: 'small' }] });
    assert.deepEqual(heavy.files.map((file) => file.name), ['a.txt', 'b.txt', 'd.txt']);
    assert.deepEqual(heavy.skipped, [{ name: 'c.txt', reason: 'Over the 240 KB total limit.' }]);

    // Size is counted in UTF-8 bytes, not characters.
    const wide = '漢'.repeat(Math.floor(LIMITS.fileBytes / 3) + 1);
    assert.equal(parseHandoff({ files: [{ name: 'wide.md', content: wide }] }).skipped[0].reason, 'Over the 120 KB file limit.');
  });

  test('extra fields on a file are not carried over', () => {
    const handoff = parseHandoff({ files: [{ name: 'a.sol', content: 'x', apiKey: 'sk-live', size: 1 }] });
    assert.deepEqual(handoff.files, [{ name: 'a.sol', content: 'x' }]);
  });

  test('an unknown, unlisted or missing profile becomes general; the legacy id resolves', () => {
    assert.equal(parseHandoff({ profile: 'nope' }).profile, 'general');
    assert.equal(parseHandoff({ profile: 'verdict' }).profile, 'general');
    assert.equal(parseHandoff({ profile: 'panel' }).profile, 'general');
    assert.equal(parseHandoff({ profile: 7 }).profile, 'general');
    assert.equal(parseHandoff({}).profile, 'general');
    assert.equal(parseHandoff({ profile: 'v06-solidity' }).profile, 'solidity');
  });

  test('focus is text, cut at the instruction limit', () => {
    assert.equal(parseHandoff({ focus: ['x'] }).focus, '');
    assert.equal(parseHandoff({ focus: 'f'.repeat(LIMITS.promptChars + 50) }).focus.length, LIMITS.promptChars);
  });

  test('context keeps text fields and known options, and drops the rest', () => {
    const handoff = parseHandoff({
      context: {
        target: 'Vault',
        proof: 'deployment',
        prior: 'guess',
        cloneDepth: 'shallow',
        impactRow: 'Direct theft',
        notes: 5,
        rules: 'r'.repeat(20000),
        'bad key': 'x',
        Upper: 'x',
        token: 'bok_secret',
        apiKey: 'sk-live',
        constructor: 'x',
        toString: 'x',
        nested: { a: 1 },
      },
    });
    assert.deepEqual(Object.keys(handoff.context).sort(), ['cloneDepth', 'impactRow', 'notes', 'prior', 'proof', 'rules', 'scope', 'target', 'version']);
    assert.equal(handoff.context.proof, 'deployment');
    assert.equal(handoff.context.prior, 'unchecked');
    assert.equal(handoff.context.cloneDepth, 'shallow');
    assert.equal(handoff.context.notes, '');
    assert.equal(handoff.context.rules.length, 16000);

    assert.deepEqual(parseHandoff({ context: 'text' }).context, parseHandoff({}).context);
    assert.deepEqual(parseHandoff({ context: ['a'] }).context, parseHandoff({}).context);

    const polluted = parseHandoff('{"context":{"__proto__":{"polluted":true},"target":"T"}}');
    assert.equal(polluted.context.target, 'T');
    assert.equal({}.polluted, undefined);
    assert.equal(polluted.context.polluted, undefined);
  });

  test('takeHandoff reads the key once and removes it, valid or not', () => {
    const storage = useStorage(new FakeStorage());
    assert.equal(takeHandoff(), null);

    storage.setItem(STORAGE_KEYS.handoff, JSON.stringify(VALID));
    const handoff = takeHandoff();
    assert.equal(handoff.files.length, 2);
    assert.equal(storage.getItem(STORAGE_KEYS.handoff), null);
    assert.equal(takeHandoff(), null);

    storage.setItem(STORAGE_KEYS.handoff, '{broken');
    assert.equal(takeHandoff(), null);
    assert.equal(storage.getItem(STORAGE_KEYS.handoff), null);
    assert.equal(STORAGE_KEYS.handoff, 'bo:handoff');
  });

  test('a handoff goes into the store as documented', () => {
    const storage = useStorage(new FakeStorage());
    storage.setItem(STORAGE_KEYS.handoff, JSON.stringify(VALID));
    workbench.set({ step: 'results', result: { review: 'old', manifest: [] }, files: [{ name: 'old.sol', content: 'x' }] });

    const handoff = takeHandoff();
    workbench.set({ ...initialState(), files: handoff.files, profile: handoff.profile, focus: handoff.focus, context: handoff.context });
    const state = workbench.get();
    assert.deepEqual(state.files, VALID.files);
    assert.equal(state.profile, 'report');
    assert.equal(state.step, 'files');
    assert.equal(state.result, null);
  });
});

// ---------------------------------------------------------------------------
// ui.mjs: formatting
// ---------------------------------------------------------------------------

describe('formatting', () => {
  test('formatBytes uses the decimal units the limits are stated in', () => {
    const cases = [
      [0, '0 B'], [1, '1 B'], [999, '999 B'], [1000, '1.0 KB'], [1234, '1.2 KB'], [99949, '99.9 KB'], [99950, '100 KB'],
      [120000, '120 KB'], [240000, '240 KB'], [999499, '999 KB'], [999500, '1.0 MB'], [1500000, '1.5 MB'], [16000000, '16.0 MB'], [250000000, '250 MB'],
      [-5, '0 B'], [NaN, '0 B'], [undefined, '0 B'],
    ];
    for (const [bytes, text] of cases) assert.equal(formatBytes(bytes), text, String(bytes));
  });

  test('toDate reads epoch seconds, epoch milliseconds, ISO text and dates', () => {
    const iso = '2026-10-02T14:05:00.000Z';
    const ms = Date.parse(iso);
    assert.equal(toDate(ms / 1000).toISOString(), iso);
    assert.equal(toDate(ms).toISOString(), iso);
    assert.equal(toDate(iso).toISOString(), iso);
    assert.equal(toDate(new Date(ms)).toISOString(), iso);
    assert.equal(toDate(0).toISOString(), '1970-01-01T00:00:00.000Z');
    for (const value of [null, undefined, '', '   ', 'soon', NaN, Infinity, {}, new Date('x')]) assert.equal(toDate(value), null);
  });

  test('formatDate writes a medium date, with the time on request', () => {
    const options = { utc: true, locale: 'en-GB' };
    assert.equal(formatDate('2026-10-02T14:05:00.000Z', options), '2 Oct 2026');
    assert.equal(formatDate('2026-10-02T14:05:00.000Z', { ...options, time: true }), '2 Oct 2026, 14:05');
    assert.equal(formatDate(1790949900, { ...options, time: true }), '2 Oct 2026, 14:05');
    assert.equal(formatDate(null), '');
    assert.equal(formatDate('never'), '');
    assert.ok(formatDate(1790949900).length > 5, 'the default locale and zone format without options');
  });

  test('formatElapsed counts up like a clock', () => {
    const cases = [[0, '0:00'], [999, '0:00'], [7000, '0:07'], [61000, '1:01'], [754000, '12:34'], [3723000, '1:02:03'], [-50, '0:00'], [NaN, '0:00']];
    for (const [ms, text] of cases) assert.equal(formatElapsed(ms), text, String(ms));
  });

  test('formatCountdown says how long in words', () => {
    const minute = 60000;
    const cases = [
      [0, 'now'], [-1, 'now'], [1, 'under a minute'], [59999, 'under a minute'], [minute, '1 min'], [12 * minute, '12 min'],
      [60 * minute, '1 h'], [185 * minute, '3 h 5 min'], [24 * 60 * minute, '1 d'], [52 * 60 * minute, '2 d 4 h'], [NaN, 'now'],
    ];
    for (const [ms, text] of cases) assert.equal(formatCountdown(ms), text, String(ms));
  });

  test('timeUntil is never negative', () => {
    const now = Date.parse('2026-10-02T21:00:00.000Z');
    assert.equal(timeUntil('2026-10-03T00:00:00.000Z', now), 3 * 3600000);
    assert.equal(formatCountdown(timeUntil('2026-10-03T00:00:00.000Z', now)), '3 h');
    assert.equal(timeUntil('2026-10-01T00:00:00.000Z', now), 0);
    assert.equal(timeUntil('never', now), 0);
  });
});

// ---------------------------------------------------------------------------
// ui.mjs: el(), on(), setBusy() against a stand-in document
// ---------------------------------------------------------------------------

describe('el', () => {
  test('props become classes, text, data, attributes and listeners', () => {
    useDocument();
    const clicks = [];
    const node = el(
      'button',
      {
        class: ['btn', false, 'btn--primary', null, ['btn--sm']],
        text: 'Run <b>review</b>',
        dataset: { step: 'review', skip: null, flag: true, count: 3 },
        type: 'button',
        hidden: false,
        disabled: true,
        'aria-label': 'Run',
        title: undefined,
        onClick: (event) => clicks.push(event.type),
        style: { '--i': 3 },
      },
    );
    assert.equal(node.tagName, 'BUTTON');
    assert.equal(node.className, 'btn btn--primary btn--sm');
    assert.equal(node.textContent, 'Run <b>review</b>');
    assert.deepEqual(node.dataset, { step: 'review', flag: '', count: '3' });
    assert.deepEqual([...node.attributes], [['type', 'button'], ['disabled', ''], ['aria-label', 'Run']]);
    assert.deepEqual(node.style.values, { '--i': '3' });
    node.dispatch('click');
    assert.deepEqual(clicks, ['click']);
  });

  test('children are appended as nodes and text; arrays flatten; empty values are skipped', () => {
    useDocument();
    const child = el('span', { text: 'a' });
    const node = el('p', null, 'x', 7, [child, ['y', null]], false, undefined, null, 0, '');
    assert.deepEqual(node.children, ['x', '7', child, 'y', '0', '']);
    assert.equal(child.parentElement, node);
  });

  test('props may be left out: the second argument is then a child', () => {
    useDocument();
    assert.deepEqual(el('p', 'Review running.').children, ['Review running.']);
    assert.deepEqual(el('p', 7, ' files').children, ['7', ' files']);
    const item = el('li', 'a');
    assert.deepEqual(el('ul', [item, el('li', 'b')]).children.map((child) => child.children[0]), ['a', 'b']);
    assert.deepEqual(el('div', item, 'tail').children, [item, 'tail']);
    assert.deepEqual(el('div').children, []);
    assert.deepEqual(el('div', undefined, 'x').children, ['x']);
    assert.deepEqual(el('div', null, 'x').children, ['x']);
    // Text that looks like markup stays text.
    assert.deepEqual(el('p', '<img src=x onerror=alert(1)>').children, ['<img src=x onerror=alert(1)>']);
  });

  test('value is set as a property after the children exist', () => {
    useDocument();
    const select = el('select', { value: 'b', id: 'provider' }, el('option', { value: 'a' }), el('option', { value: 'b', selected: true }));
    assert.equal(select.value, 'b');
    assert.equal(select.getAttribute('value'), null);
    assert.equal(select.children[1].selected, true);
    const box = el('input', { type: 'checkbox', checked: true });
    assert.equal(box.checked, true);
    assert.equal(el('label', { htmlFor: 'api-key' }).getAttribute('for'), 'api-key');
    assert.equal(el('label', { for: 'api-key' }).getAttribute('for'), 'api-key');
  });

  test('markup props, inline handlers and style strings are refused', () => {
    useDocument();
    for (const name of ['innerHTML', 'outerHTML', 'html', 'srcdoc']) {
      assert.throws(() => el('div', { [name]: '<img src=x onerror=alert(1)>' }), TypeError, name);
    }
    assert.throws(() => el('button', { onclick: 'alert(1)' }), /inline handlers/);
    assert.throws(() => el('div', { style: 'color:red' }), /style as an object/);
  });

  test('a URL with a scheme other than http, https or mailto is dropped', () => {
    useDocument();
    const dropped = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://x/1'];
    for (const href of dropped) assert.equal(el('a', { href }).getAttribute('href'), null, JSON.stringify(href));

    const kept = ['/guide', '#workspace', '?checkout=cancelled', 'https://immunefi.com/x', 'http://localhost:8787/', 'mailto:support@bountyoperator.com', 'tools/verify', './a:b'];
    for (const href of kept) assert.equal(el('a', { href }).getAttribute('href'), href, href);

    assert.equal(el('img', { src: 'data:image/png;base64,AAAA', alt: '' }).getAttribute('src'), 'data:image/png;base64,AAAA');
    assert.equal(el('img', { src: 'data:image/svg+xml,<svg onload=alert(1)>', alt: '' }).getAttribute('src'), null);
    assert.equal(el('form', { action: 'javascript:alert(1)' }).getAttribute('action'), null);
  });

  test('a link that opens a new tab gets rel=noopener', () => {
    useDocument();
    assert.equal(el('a', { href: 'https://example.org', target: '_blank' }).getAttribute('rel'), 'noopener noreferrer');
    assert.equal(el('a', { href: 'https://example.org', target: '_blank', rel: 'noopener' }).getAttribute('rel'), 'noopener');
    assert.equal(el('a', { href: '/guide' }).getAttribute('rel'), null);
  });

  test('button() and notice() emit the component markup', () => {
    useDocument();
    const run = button({ label: 'Run review', variant: 'primary', size: 'lg', iconEnd: 'arrow-right', id: 'run' });
    assert.equal(run.className, 'btn btn--primary btn--lg');
    assert.equal(run.getAttribute('type'), 'button');
    assert.deepEqual(run.children.map((child) => child.className), ['btn__label', 'icon icon--arrow-right']);
    assert.equal(run.children[0].textContent, 'Run review');
    assert.equal(run.children[1].getAttribute('aria-hidden'), 'true');

    const copy = button({ label: 'Copy reference', icon: 'copy', iconOnly: true });
    assert.equal(copy.className, 'btn btn--secondary btn--icon');
    assert.deepEqual(copy.children.map((child) => child.className), ['icon icon--copy', 'visually-hidden']);
    assert.throws(() => button({}), /needs a label/);

    const error = notice('error', 'OpenRouter rejected this key (401).', 'Paste a current key and run the review again.');
    assert.equal(error.className, 'notice notice--error');
    assert.equal(error.getAttribute('role'), 'alert');
    assert.equal(error.children[0].className, 'icon icon--error');
    assert.equal(error.children[1].children[0].textContent, 'OpenRouter rejected this key (401).');
    assert.equal(error.children[1].children[1].children[0].textContent, 'Paste a current key and run the review again.');
    assert.equal(notice('info', 'Saved.').getAttribute('role'), null);
    assert.equal(notice('made-up', 'x').className, 'notice notice--info');
  });
});

describe('on', () => {
  test('adds listeners for each type and removes them all', () => {
    const target = new FakeElement('form');
    const heard = [];
    const off = on(target, 'input  change', (event) => heard.push(event.type));
    target.dispatch('input');
    target.dispatch('change');
    off();
    target.dispatch('input');
    assert.deepEqual(heard, ['input', 'change']);
    assert.equal(target.listeners.length, 0);
    assert.throws(() => on(target, 'click', '[data-x]'), /handler function/);
  });

  test('a delegated listener receives the matching descendant', () => {
    const list = new FakeElement('ul');
    const item = new FakeElement('li');
    const remove = new FakeElement('button');
    remove.setAttribute('data-remove', '2');
    const label = new FakeElement('span');
    const other = new FakeElement('span');
    list.append(item);
    item.append(remove, other);
    remove.append(label);

    const heard = [];
    const off = on(list, 'click', '[data-remove]', (event, match) => heard.push(match.getAttribute('data-remove')));
    list.dispatch('click', { target: label });
    list.dispatch('click', { target: remove });
    list.dispatch('click', { target: other });
    // A text node has no closest(); its parent element is used.
    list.dispatch('click', { target: { parentElement: label } });
    assert.deepEqual(heard, ['2', '2', '2']);

    // A match outside the listening element does not count.
    const outside = new FakeElement('button');
    outside.setAttribute('data-remove', '9');
    list.dispatch('click', { target: outside });
    assert.equal(heard.length, 3);
    off();
    assert.equal(list.listeners.length, 0);
  });
});

describe('setBusy', () => {
  function makeButton() {
    useDocument();
    return button({ label: 'Run review', variant: 'primary' });
  }

  test('running marks the button, swaps the label and swallows clicks', () => {
    const node = makeButton();
    const clicks = [];
    node.addEventListener('click', () => clicks.push('click'));

    setBusy(node, true, 'Running');
    assert.equal(isBusy(node), true);
    assert.equal(node.getAttribute('aria-busy'), 'true');
    assert.equal(node.getAttribute('aria-disabled'), 'true');
    assert.equal(node.getAttribute('disabled'), null, 'the button keeps focus: it is not disabled');
    assert.equal(node.querySelector('.btn__label').textContent, 'Running');
    const blocked = node.dispatch('click');
    assert.deepEqual(clicks, []);
    assert.equal(blocked.defaultPrevented, true);

    setBusy(node, true, 'Still running');
    assert.equal(node.querySelector('.btn__label').textContent, 'Still running');

    setBusy(node, false);
    assert.equal(isBusy(node), false);
    assert.equal(node.getAttribute('aria-busy'), null);
    assert.equal(node.getAttribute('aria-disabled'), null);
    assert.equal(node.querySelector('.btn__label').textContent, 'Run review');
    node.dispatch('click');
    assert.deepEqual(clicks, ['click']);
  });

  test('an aria-disabled state from before is put back, and repeats are harmless', () => {
    const node = makeButton();
    node.setAttribute('aria-disabled', 'true');
    setBusy(node, false);
    assert.equal(node.getAttribute('aria-disabled'), 'true');
    setBusy(node, true);
    setBusy(node, false);
    setBusy(node, false);
    assert.equal(node.getAttribute('aria-disabled'), 'true');
    assert.equal(node.querySelector('.btn__label').textContent, 'Run review');
    assert.doesNotThrow(() => setBusy(null, true));
    assert.equal(isBusy(null), false);
  });
});
