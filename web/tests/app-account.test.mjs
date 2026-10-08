// The account panel's modules under node: the passkey ceremonies against
// stand-in WebAuthn and Worker answers, the checkout round trip, the view
// models of the account sheet, and the copy rules. The DOM side is checked in
// a real browser against `wrangler dev`; see the report of the account stream.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { REASONS, capabilityMessage, headerControl, inAppBrowser, onAccountChange, reasonText, requireSignIn } from '../public/app/account.mjs';
import { ApiError, currentAccount, refreshAccount } from '../public/app/api.mjs';
import {
  OPERATOR_ACTIVE,
  PLAN_ROWS,
  PRICE_LINE,
  billingMessage,
  confirmCheckout,
  goToBillingPortal,
  goToCheckout,
  planLabel,
  readCheckoutReturn,
  rememberPlace,
  takePlace,
} from '../public/app/billing-ui.mjs';
import {
  PASSKEY_PROVIDERS,
  addPasskey,
  creationOptions,
  credentialToJson,
  isCancelled,
  passkeyFailure,
  passkeySupport,
  registerPasskey,
  requestOptions,
  signInWithPasskey,
  toBase64Url,
  toBytes,
} from '../public/app/passkey.mjs';
import { MCP_ENDPOINT, MCP_PACKAGE, TABS, TOKEN_VAR, connectionCommands, reviewRows, usageSummary } from '../public/app/portal.mjs';
import { ACCOUNT_SCRIPTS, ACCOUNT_STYLES, accountDialog } from '../site/fragments/account-dialog.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

const USAGE_FREE = { plan: 'free', usedToday: 0, remainingToday: 1, running: 0, concurrency: 1, resetsAt: '2026-10-03T00:00:00.000Z', paidUntil: null };
const USAGE_PAID = { plan: 'weekly', usedToday: 3, remainingToday: null, running: 2, concurrency: 4, resetsAt: '2026-10-03T00:00:00.000Z', paidUntil: '2026-10-08T12:00:00.000Z' };
const SIGNED_OUT = { signedIn: false, usage: null, billing: 'live', hasSubscription: false, limits: {}, price: { usd: 10, interval: 'week' }, version: '0.7.0' };
const SIGNED_IN = { ...SIGNED_OUT, signedIn: true, csrf: 'csrf-1', usage: USAGE_FREE };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Replaces fetch. `routes` maps "METHOD /path" to a function returning a Response. Returns the calls made. */
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ path, method, headers: init.headers ?? {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`Unexpected fetch: ${method} ${path}`);
    return handler();
  };
  return calls;
}

/** Puts a WebAuthn stand-in on globalThis: navigator.credentials and PublicKeyCredential. */
function mockWebAuthn({ create, get, platform = true, statics = {} } = {}) {
  Object.defineProperty(globalThis, 'navigator', { value: { credentials: { create, get } }, configurable: true, writable: true });
  globalThis.PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => platform,
    ...statics,
  });
}

function domError(name) {
  return new DOMException(`${name} from the stand-in authenticator`, name);
}

const bytes = (...values) => Uint8Array.from(values);

/** What an authenticator returns from create(), with no toJSON: the fields are read by hand. */
function attestation() {
  return {
    id: 'Y3JlZC0x',
    rawId: bytes(99, 114, 101, 100, 45, 49).buffer,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
    response: {
      clientDataJSON: bytes(1, 2, 3).buffer,
      attestationObject: bytes(4, 5, 6).buffer,
      getTransports: () => ['internal'],
    },
  };
}

function assertion() {
  return {
    id: 'Y3JlZC0x',
    rawId: bytes(99, 114, 101, 100, 45, 49).buffer,
    type: 'public-key',
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: bytes(1, 2, 3).buffer,
      authenticatorData: bytes(7, 8).buffer,
      signature: bytes(9, 10, 11).buffer,
      userHandle: bytes(12).buffer,
    },
  };
}

const REGISTER_OPTIONS = {
  challenge: 'AQIDBA',
  rp: { name: 'Bounty Operator', id: 'localhost' },
  user: { id: 'dXNlci0x', name: 'Operator 1234', displayName: 'Bounty Operator account' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  excludeCredentials: [{ id: 'Y3JlZC0x', type: 'public-key', transports: ['internal'] }],
};
const LOGIN_OPTIONS = { challenge: 'AQIDBA', rpId: 'localhost', userVerification: 'required' };

/** A sessionStorage and a location for the checkout round trip. */
function mockPage({ pathname = '/', hash = '', search = '' } = {}) {
  const store = new Map();
  const assigned = [];
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.location = { pathname, hash, search, assign: (url) => assigned.push(url) };
  globalThis.scrollY = 640;
  return { store, assigned };
}

beforeEach(async () => {
  // Every test starts signed out, whatever the one before left in api.mjs's cache.
  mockFetch({ 'GET /api/account': () => json(SIGNED_OUT) });
  await refreshAccount();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete globalThis.navigator;
  delete globalThis.PublicKeyCredential;
  delete globalThis.sessionStorage;
  delete globalThis.location;
  delete globalThis.scrollY;
});

// ---------------------------------------------------------------------------
// passkey.mjs
// ---------------------------------------------------------------------------

describe('base64url', () => {
  test('bytes survive the round trip at every padding length', () => {
    for (let length = 0; length <= 9; length += 1) {
      const source = Uint8Array.from({ length }, (_, index) => (index * 37 + 251) % 256);
      const text = toBase64Url(source);
      assert.doesNotMatch(text, /[+/=]/);
      assert.deepEqual([...toBytes(text)], [...source]);
    }
  });

  test('the URL alphabet and padded input are both read', () => {
    assert.deepEqual([...toBytes('-_8')], [251, 255]);
    assert.deepEqual([...toBytes('-_8=')], [251, 255]);
    assert.equal(toBase64Url(bytes(251, 255).buffer), '-_8');
  });

  test('a view over part of a buffer encodes only its own bytes', () => {
    const whole = bytes(1, 2, 3, 4, 5, 6);
    assert.equal(toBase64Url(whole.subarray(2, 4)), toBase64Url(bytes(3, 4)));
  });
});

describe('WebAuthn options', () => {
  test('registration options are converted by hand when the browser has no parser', () => {
    const options = creationOptions(REGISTER_OPTIONS);
    assert.deepEqual([...options.challenge], [1, 2, 3, 4]);
    assert.equal(new TextDecoder().decode(options.user.id), 'user-1');
    assert.equal(options.user.name, 'Operator 1234');
    assert.equal(new TextDecoder().decode(options.excludeCredentials[0].id), 'cred-1');
    assert.deepEqual(options.excludeCredentials[0].transports, ['internal']);
    assert.deepEqual(options.authenticatorSelection, REGISTER_OPTIONS.authenticatorSelection);
    // The Worker's object is not changed.
    assert.equal(REGISTER_OPTIONS.challenge, 'AQIDBA');
  });

  test('the browser parser is used when present, and its failure falls back', () => {
    mockWebAuthn({ statics: { parseCreationOptionsFromJSON: (value) => ({ parsed: true, rp: value.rp }) } });
    assert.equal(creationOptions(REGISTER_OPTIONS).parsed, true);

    mockWebAuthn({
      statics: {
        parseCreationOptionsFromJSON: () => {
          throw new TypeError('unknown member');
        },
      },
    });
    assert.deepEqual([...creationOptions(REGISTER_OPTIONS).challenge], [1, 2, 3, 4]);
  });

  test('sign-in options stay discoverable unless ids are given', () => {
    const open = requestOptions(LOGIN_OPTIONS);
    assert.deepEqual([...open.challenge], [1, 2, 3, 4]);
    assert.equal(open.allowCredentials, undefined);
    assert.equal(requestOptions(LOGIN_OPTIONS, []).allowCredentials, undefined);

    const limited = requestOptions(LOGIN_OPTIONS, ['Y3JlZC0x', 'Y3JlZC0y']);
    assert.equal(limited.allowCredentials.length, 2);
    assert.equal(limited.allowCredentials[0].type, 'public-key');
    assert.equal(new TextDecoder().decode(limited.allowCredentials[1].id), 'cred-2');
    assert.equal(LOGIN_OPTIONS.allowCredentials, undefined);
  });
});

describe('credentialToJson', () => {
  test('a credential with a working toJSON is passed through', () => {
    const body = { id: 'abc', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 'AQID' } };
    assert.equal(credentialToJson({ toJSON: () => body }), body);
  });

  test('a missing, throwing or empty toJSON is replaced by reading the fields', () => {
    const expected = {
      id: 'Y3JlZC0x',
      rawId: 'Y3JlZC0x',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: { credProps: { rk: true } },
      response: { clientDataJSON: 'AQID', attestationObject: 'BAUG', transports: ['internal'] },
    };
    assert.deepEqual(credentialToJson(attestation()), expected);
    assert.deepEqual(credentialToJson({ ...attestation(), toJSON: () => ({}) }), expected);
    assert.deepEqual(
      credentialToJson({
        ...attestation(),
        toJSON: () => {
          throw new Error('extension bug');
        },
      }),
      expected,
    );
  });

  test('an assertion carries the signature and the user handle', () => {
    assert.deepEqual(credentialToJson(assertion()).response, { clientDataJSON: 'AQID', authenticatorData: 'Bwg', signature: 'CQoL', userHandle: 'DA' });
  });

  test('no credential is a closed prompt', () => {
    assert.throws(() => credentialToJson(null), (error) => error instanceof ApiError && error.code === 'passkey_cancelled');
  });
});

describe('passkeyFailure', () => {
  test('each browser error gets a code and a sentence', () => {
    const cases = [
      ['NotAllowedError', 'register', 'passkey_cancelled'],
      ['AbortError', 'login', 'aborted'],
      ['InvalidStateError', 'add', 'passkey_exists'],
      ['InvalidStateError', 'register', 'passkey_exists'],
      ['InvalidStateError', 'login', 'passkey_failed'],
      ['NotSupportedError', 'register', 'passkey_unsupported'],
      ['ConstraintError', 'register', 'passkey_unsupported'],
      ['SecurityError', 'login', 'passkey_unsupported'],
      ['UnknownError', 'login', 'passkey_failed'],
    ];
    for (const [name, flow, code] of cases) {
      const failure = passkeyFailure(domError(name), flow);
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.code, code, `${name} during ${flow}`);
      assert.match(failure.message, /^[A-Z].*\.$/, 'a sentence');
      assert.doesNotMatch(failure.message, /stand-in authenticator/, 'the browser text is not shown');
    }
  });

  test('an ApiError passes through, and only a closed prompt counts as cancelled', () => {
    const refused = new ApiError('Passkey could not be verified.', { code: 'passkey', status: 400 });
    assert.equal(passkeyFailure(refused, 'login'), refused);
    assert.equal(isCancelled(refused), false);
    assert.equal(isCancelled(passkeyFailure(domError('NotAllowedError'), 'login')), true);
    assert.equal(isCancelled(new Error('other')), false);
  });
});

describe('passkeySupport', () => {
  test('no WebAuthn objects: nothing is available', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
    assert.deepEqual(await passkeySupport(), { webauthn: false, platform: false });
  });

  test('a platform authenticator, none, and a browser that throws when asked', async () => {
    mockWebAuthn({ create() {}, get() {}, platform: true });
    assert.deepEqual(await passkeySupport(), { webauthn: true, platform: true });

    mockWebAuthn({ create() {}, get() {}, platform: false });
    assert.deepEqual(await passkeySupport(), { webauthn: true, platform: false });

    mockWebAuthn({
      create() {},
      get() {},
      statics: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => {
          throw new Error('blocked by policy');
        },
      },
    });
    assert.deepEqual(await passkeySupport(), { webauthn: true, platform: false });
  });

  test('the list of what works names all seven', () => {
    for (const name of ['Windows Hello', 'Touch ID', 'iCloud Keychain', 'Google Password Manager', '1Password', 'Bitwarden', 'security key']) {
      assert.ok(PASSKEY_PROVIDERS.includes(name), name);
    }
  });
});

describe('ceremonies', () => {
  test('registration: options, the prompt, verify, and the account becomes signed in', async () => {
    let asked;
    mockWebAuthn({
      create: async (request) => {
        asked = request;
        return attestation();
      },
    });
    let signedIn = false;
    const calls = mockFetch({
      'GET /api/account': () => json(signedIn ? SIGNED_IN : SIGNED_OUT),
      'POST /api/auth/register/options': () => json(REGISTER_OPTIONS),
      'POST /api/auth/register/verify': () => {
        signedIn = true;
        return json({ signedIn: true, csrf: 'csrf-1', recoveryCode: 'R'.repeat(43) });
      },
    });

    const created = await registerPasskey();
    assert.equal(created.recoveryCode, 'R'.repeat(43));
    assert.deepEqual([...asked.publicKey.challenge], [1, 2, 3, 4]);

    const verify = calls.find((call) => call.path === '/api/auth/register/verify');
    assert.equal(verify.body.id, 'Y3JlZC0x');
    assert.equal(verify.body.response.attestationObject, 'BAUG');
    assert.deepEqual(calls.find((call) => call.path === '/api/auth/register/options').body, {});

    // api.mjs reloads the account by itself; nobody calls refreshAccount().
    assert.equal(currentAccount().signedIn, true);
    assert.equal(currentAccount().csrf, 'csrf-1');
    assert.equal(await requireSignIn({ reason: 'review' }), true);
  });

  test('a closed prompt sends nothing to verify and is reported as cancelled', async () => {
    mockWebAuthn({
      get: async () => {
        throw domError('NotAllowedError');
      },
    });
    const calls = mockFetch({ 'GET /api/account': () => json(SIGNED_OUT), 'POST /api/auth/login/options': () => json(LOGIN_OPTIONS) });
    await assert.rejects(signInWithPasskey(), (error) => isCancelled(error) && error.code === 'passkey_cancelled');
    assert.equal(calls.some((call) => call.path === '/api/auth/login/verify'), false);
  });

  test('sign-in limited to the account passkeys, as the confirmation uses it', async () => {
    let asked;
    mockWebAuthn({
      get: async (request) => {
        asked = request;
        return assertion();
      },
    });
    const calls = mockFetch({
      'GET /api/account': () => json(SIGNED_IN),
      'POST /api/auth/login/options': () => json(LOGIN_OPTIONS),
      'POST /api/auth/login/verify': () => json({ signedIn: true, csrf: 'csrf-1' }),
    });
    const answer = await signInWithPasskey({ allow: ['Y3JlZC0x'] });
    assert.equal(answer.csrf, 'csrf-1');
    assert.equal(asked.publicKey.allowCredentials.length, 1);
    assert.equal(calls.find((call) => call.path === '/api/auth/login/verify').body.response.signature, 'CQoL');
  });

  test('adding a passkey the authenticator already holds', async () => {
    mockWebAuthn({
      create: async () => {
        throw domError('InvalidStateError');
      },
    });
    mockFetch({ 'GET /api/account': () => json(SIGNED_IN), 'POST /api/auth/add/options': () => json(REGISTER_OPTIONS) });
    await refreshAccount();
    await assert.rejects(addPasskey(), (error) => error.code === 'passkey_exists');
  });

  test('the Worker asking for a recent passkey check comes through as reauth', async () => {
    mockWebAuthn({ create: async () => attestation() });
    mockFetch({
      'GET /api/account': () => json(SIGNED_IN),
      'POST /api/auth/add/options': () => json({ error: 'Confirm with your passkey to continue.', code: 'reauth' }, 401),
    });
    await refreshAccount();
    await assert.rejects(addPasskey(), (error) => error.code === 'reauth' && error.status === 401);
  });

  test('without WebAuthn nothing is requested and the message names what works', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
    const calls = mockFetch({});
    await assert.rejects(registerPasskey(), (error) => error.code === 'passkey_unsupported' && error.message.includes('1Password'));
    await assert.rejects(signInWithPasskey(), (error) => error.code === 'passkey_unsupported');
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// billing-ui.mjs
// ---------------------------------------------------------------------------

describe('the plan', () => {
  test('the price is fixed and the rows are SPEC section 2', () => {
    assert.equal(PRICE_LINE, 'US$10 a week');
    assert.equal(OPERATOR_ACTIVE, 'Operator is active. Unlimited reviews, gauntlet and panel are unlocked.');
    const row = (feature) => PLAN_ROWS.find((entry) => entry.feature === feature);
    assert.deepEqual([row('Reviews on your API key').free, row('Reviews on your API key').operator], ['1 a day (resets 00:00 UTC)', 'Unlimited']);
    assert.deepEqual([row('Gauntlet').free, row('Gauntlet').operator], ['Example', 'Included']);
    assert.deepEqual([row('Panel review').free, row('Panel review').operator], ['Example', 'Included']);
    assert.deepEqual([row('Reviews at once').free, row('Reviews at once').operator], ['1', '4']);
    assert.match(row('Gauntlet').detail, /Eight stages/);
    for (const entry of PLAN_ROWS.filter((item) => !['Reviews on your API key', 'Gauntlet', 'Panel review', 'Reviews at once'].includes(item.feature))) {
      assert.deepEqual([entry.free, entry.operator], ['Included', 'Included'], entry.feature);
    }
  });

  test('the plan in one word', () => {
    assert.equal(planLabel({ signedIn: false }), 'Signed out');
    assert.equal(planLabel({ signedIn: true, usage: USAGE_FREE }), 'Free');
    assert.equal(planLabel({ signedIn: true, usage: USAGE_PAID }), 'Operator');
    assert.equal(planLabel({ signedIn: true, usage: { ...USAGE_FREE, plan: 'past_due' } }), 'Past due');
  });
});

describe('the return from Stripe', () => {
  test('the query string is read strictly', () => {
    assert.deepEqual(readCheckoutReturn('?checkout=complete&session_id=cs_live_a1B2c3'), { state: 'complete', sessionId: 'cs_live_a1B2c3' });
    assert.deepEqual(readCheckoutReturn('?checkout=complete&session_id=cs_test_a1B2c3'), { state: 'complete', sessionId: '' });
    assert.deepEqual(readCheckoutReturn('?checkout=complete&session_id=cs_live_<script>'), { state: 'complete', sessionId: '' });
    assert.deepEqual(readCheckoutReturn('?checkout=complete'), { state: 'complete', sessionId: '' });
    assert.deepEqual(readCheckoutReturn('?ref=x&checkout=cancelled'), { state: 'cancelled', sessionId: '' });
    assert.equal(readCheckoutReturn('?checkout=yes'), null);
    assert.equal(readCheckoutReturn(''), null);
  });

  test('reconcile is asked until the plan is Operator, at most five times', async () => {
    const sent = [];
    const waits = [];
    const answers = [USAGE_FREE, USAGE_FREE, USAGE_PAID];
    const result = await confirmCheckout({
      sessionId: 'cs_live_abc',
      send: async (path, options) => {
        sent.push([path, options.body]);
        return { usage: answers[sent.length - 1] };
      },
      wait: async (ms) => waits.push(ms),
    });
    assert.deepEqual(result, { active: true, attempts: 3, error: null });
    assert.deepEqual(sent[0], ['/api/billing/reconcile', { sessionId: 'cs_live_abc' }]);
    assert.deepEqual(waits, [2000, 2000]);

    let asked = 0;
    const pending = await confirmCheckout({
      sessionId: 'cs_live_abc',
      send: async () => {
        asked += 1;
        return { usage: USAGE_FREE };
      },
      wait: async () => {},
    });
    assert.deepEqual(pending, { active: false, attempts: 5, error: null });
    assert.equal(asked, 5);
  });

  test('a Stripe hiccup is retried; a decision is not', async () => {
    let asked = 0;
    const busy = await confirmCheckout({
      sessionId: 'cs_live_abc',
      send: async () => {
        asked += 1;
        if (asked < 3) throw new ApiError('The payment provider did not answer.', { code: 'billing_unavailable', status: 503 });
        return { usage: USAGE_PAID };
      },
      wait: async () => {},
    });
    assert.deepEqual([busy.active, busy.attempts, asked], [true, 3, 3]);

    for (const code of ['signin', 'forbidden', 'bad_request', 'rate_limited']) {
      let calls = 0;
      const stopped = await confirmCheckout({
        sessionId: 'cs_live_abc',
        send: async () => {
          calls += 1;
          throw new ApiError('No.', { code, status: 400 });
        },
        wait: async () => {},
      });
      assert.deepEqual([stopped.active, stopped.attempts, stopped.error.code, calls], [false, 1, code, 1], code);
    }
  });

  test('without a session id the account is reloaded instead', async () => {
    let reloads = 0;
    const result = await confirmCheckout({
      send: async () => {
        throw new Error('reconcile must not be called without a session id');
      },
      reload: async () => {
        reloads += 1;
        return { signedIn: true, usage: reloads === 2 ? USAGE_PAID : USAGE_FREE };
      },
      wait: async () => {},
    });
    assert.deepEqual([result.active, result.attempts], [true, 2]);
  });
});

describe('leaving for Stripe', () => {
  test('checkout stores the place, then goes to the URL the Worker returned', async () => {
    const page = mockPage({ pathname: '/', hash: '#workspace' });
    const calls = mockFetch({
      'GET /api/account': () => json(SIGNED_IN),
      'POST /api/billing/checkout': () => json({ url: 'https://checkout.stripe.com/c/pay/cs_live_abc' }),
    });
    await refreshAccount();
    await goToCheckout();

    assert.deepEqual(page.assigned, ['https://checkout.stripe.com/c/pay/cs_live_abc']);
    assert.equal(calls.at(-1).headers['X-CSRF-Token'], 'csrf-1');
    const place = takePlace();
    assert.deepEqual([place.path, place.hash, place.y], ['/', '#workspace', 640]);
    assert.equal(takePlace(), null, 'the place is read once');
  });

  test('the customer portal goes the same way', async () => {
    const page = mockPage();
    mockFetch({ 'GET /api/account': () => json(SIGNED_IN), 'POST /api/billing/portal': () => json({ url: 'https://billing.stripe.com/p/session/abc' }) });
    await refreshAccount();
    await goToBillingPortal();
    assert.deepEqual(page.assigned, ['https://billing.stripe.com/p/session/abc']);
  });

  test('an answer that is not an https URL goes nowhere', async () => {
    for (const url of ['javascript:alert(1)', 'http://checkout.stripe.com/x', '/relative', '', undefined]) {
      const page = mockPage();
      mockFetch({ 'GET /api/account': () => json(SIGNED_IN), 'POST /api/billing/checkout': () => json({ url }) });
      await refreshAccount();
      await assert.rejects(goToCheckout(), (error) => error.code === 'bad_response', String(url));
      assert.deepEqual(page.assigned, []);
      assert.equal(takePlace(), null);
    }
  });

  test('a billing refusal keeps its code and nothing is stored', async () => {
    const page = mockPage();
    mockFetch({
      'GET /api/account': () => json(SIGNED_IN),
      'POST /api/billing/checkout': () => json({ error: 'This account already has a subscription. Open Manage subscription.', code: 'billing_exists' }, 409),
    });
    await refreshAccount();
    await assert.rejects(goToCheckout(), (error) => error.code === 'billing_exists' && error.status === 409);
    assert.deepEqual(page.assigned, []);
    assert.equal(takePlace(), null);
  });

  test('a stored place is checked before it is used', () => {
    const page = mockPage({ pathname: '/pricing', hash: '#plans' });
    assert.deepEqual(Object.keys(rememberPlace()).sort(), ['at', 'hash', 'path', 'y']);
    assert.equal(takePlace().path, '/pricing');

    const stale = { path: '/', hash: '', y: 0, at: Date.now() - 3 * 3600 * 1000 };
    for (const bad of [stale, { path: 'https://elsewhere.example/', hash: '', y: 0, at: Date.now() }, { path: '/', hash: '#"><img>', y: 0, at: Date.now() }, 'text', null]) {
      page.store.set('bo:return', JSON.stringify(bad));
      assert.equal(takePlace(), null, JSON.stringify(bad));
    }
    page.store.set('bo:return', '{not json');
    assert.equal(takePlace(), null);
  });
});

describe('billingMessage', () => {
  const error = (code, data = {}) => new ApiError(`Worker text for ${code}.`, { code, status: 409, data });

  test('each code gets its message and one action', () => {
    assert.equal(billingMessage(error('billing_exists')).action, 'manage');
    assert.match(billingMessage(error('billing_exists')).title, /already has a subscription/);
    assert.equal(billingMessage(error('billing_none')).action, 'checkout');
    assert.equal(billingMessage(error('signin')).action, 'signin');
    assert.deepEqual([billingMessage(error('billing_unavailable')).title, billingMessage(error('billing_unavailable')).action], ['Worker text for billing_unavailable.', null]);
    assert.equal(billingMessage(error('billing_busy')).tone, 'warn');
    assert.equal(billingMessage(error('internal')).tone, 'error');
  });

  test('a rate limit says how long to wait', () => {
    assert.match(billingMessage(error('rate_limited', { retryAfter: 240 })).body, /Try again in 4 min\./);
    assert.match(billingMessage(error('rate_limited')).body, /Try again in a minute\./);
  });
});

// ---------------------------------------------------------------------------
// portal.mjs
// ---------------------------------------------------------------------------

describe('usageSummary', () => {
  const now = Date.parse('2026-10-02T17:48:00.000Z');

  test('free, with the review left', () => {
    const summary = usageSummary(USAGE_FREE, now);
    assert.equal(summary.plan, 'free');
    assert.deepEqual(summary.today, { value: '0 of 1', note: '1 left. Resets in 6 h 12 min.', meter: { value: 0, max: 1 } });
    assert.deepEqual(summary.running, { value: '0 of 1', note: 'Nothing running.', meter: { value: 0, max: 1 } });
    assert.equal(summary.period, null);
  });

  test('free, used: the countdown to the next one', () => {
    const summary = usageSummary({ ...USAGE_FREE, usedToday: 1, remainingToday: 0, running: 1 }, now);
    assert.deepEqual(summary.today, { value: '1 of 1', note: 'Used. Next free review in 6 h 12 min.', meter: { value: 1, max: 1 } });
    assert.equal(summary.running.note, 'One review is running.');
  });

  test('more reviews than the free allowance, after Operator ended the same day', () => {
    const summary = usageSummary({ ...USAGE_FREE, usedToday: 5, remainingToday: 0 }, now);
    assert.equal(summary.today.value, '1 of 1');
    assert.deepEqual(summary.today.meter, { value: 1, max: 1 });
  });

  test('Operator: no cap, four slots, the paid date', () => {
    const summary = usageSummary(USAGE_PAID, now);
    assert.equal(summary.plan, 'operator');
    assert.deepEqual(summary.today, { value: '3', note: 'No daily cap.', meter: null });
    assert.deepEqual(summary.running, { value: '2 of 4', note: '2 reviews are running.', meter: { value: 2, max: 4 } });
    assert.match(summary.period.value, /2026/);
  });

  test('a failed payment, and no usage at all', () => {
    assert.equal(usageSummary({ ...USAGE_FREE, plan: 'past_due' }, now).plan, 'past_due');
    const empty = usageSummary(null, now);
    assert.deepEqual([empty.plan, empty.today.value, empty.running.value, empty.period], ['free', '0 of 1', '0 of 1', null]);
  });
});

describe('reviewRows and connectionCommands', () => {
  test('rows name the profile, the channel and the status', () => {
    const rows = reviewRows({
      profiles: [{ id: 'solidity', name: 'Solidity review' }],
      reviews: [
        { id: 'r1', created_at: 1790950000, status: 'completed', profile: 'solidity', channel: 'web' },
        { id: 'r2', created_at: 1790940000, status: 'failed', profile: 'retired-profile', channel: 'mcp' },
        { id: 'r3', created_at: 1790930000, status: 'running', profile: 'solidity', channel: 'web' },
      ],
    });
    assert.deepEqual(rows.map((row) => [row.profile, row.channel, row.status, row.statusLabel]), [
      ['Solidity review', 'Workbench', 'done', 'Completed'],
      ['retired-profile', 'AI client', 'failed', 'Failed'],
      ['Solidity review', 'Workbench', 'running', 'Running'],
    ]);
    assert.match(rows[0].when, /2026/);
    assert.deepEqual(reviewRows(null), []);
  });

  test('every client gets the token, and the remote ones the endpoint', () => {
    const token = `bok_${'a'.repeat(43)}`;
    const commands = connectionCommands(token);
    assert.deepEqual(commands.map((command) => command.id), ['claude-code', 'codex', 'cursor', 'local']);
    assert.equal(MCP_ENDPOINT, 'https://bountyoperator.com/api/mcp');
    for (const command of commands) {
      assert.ok(command.code.includes(token), command.id);
      assert.ok(command.note.length > 20, command.id);
    }

    const [claude, codex, cursor, local] = commands;
    assert.equal(
      claude.code,
      `claude mcp add --transport http bounty-operator ${MCP_ENDPOINT} --header "Authorization: Bearer ${token}" --header "X-Provider-Key: $OPENROUTER_API_KEY"`,
    );
    assert.equal(codex.code, `export ${TOKEN_VAR}=${token} && codex mcp add bounty-operator --url ${MCP_ENDPOINT} --bearer-token-env-var ${TOKEN_VAR}`);
    // `codex mcp add` takes neither the provider header nor a timeout, and Codex
    // ends a call at 60 seconds by default: the note names both lines.
    assert.ok(codex.note.includes('env_http_headers = { "X-Provider-Key" = "OPENROUTER_API_KEY" }'), codex.note);
    assert.ok(codex.note.includes('tool_timeout_sec = 1200'), codex.note);
    for (const line of [claude, codex, local]) assert.doesNotMatch(line.code, /\n/, `${line.id} is one line`);

    const config = JSON.parse(cursor.code);
    assert.deepEqual(config.mcpServers['bounty-operator'], { url: MCP_ENDPOINT, headers: { Authorization: `Bearer ${token}`, 'X-Provider-Key': '${env:OPENROUTER_API_KEY}' } });
    assert.ok(local.code.includes(`npx -y ${MCP_PACKAGE}`) && local.code.includes(`--env ${TOKEN_VAR}=${token}`));
  });

  test('the sheet has the five sections', () => {
    assert.deepEqual(TABS.map((tab) => tab.id), ['overview', 'reviews', 'connections', 'security', 'billing']);
  });
});

// ---------------------------------------------------------------------------
// account.mjs
// ---------------------------------------------------------------------------

describe('account.mjs', () => {
  test('the reason is the first line of the dialog', () => {
    assert.equal(reasonText('review'), 'Create a free account to run this review. One passkey prompt, no email.');
    assert.equal(reasonText('operator'), 'Operator is US$10 a week. Account first, then Stripe.');
    assert.equal(reasonText('review', true), 'Sign in to run this review. One passkey prompt.');
    assert.equal(reasonText('  Sign in to keep this packet.  '), 'Sign in to keep this packet.');
    assert.equal(reasonText(undefined), REASONS.account.create);
    assert.equal(reasonText('', true), REASONS.account.signin);
    // A key from Object.prototype is a sentence, not a reason.
    assert.equal(reasonText('constructor'), 'constructor');
  });

  test('the header control follows the plan', () => {
    assert.deepEqual(headerControl({ signedIn: false }), { label: 'Sign in', chip: '', tone: 'neutral', name: 'Sign in' });
    assert.deepEqual([headerControl({ signedIn: true, usage: USAGE_FREE }).label, headerControl({ signedIn: true, usage: USAGE_FREE }).chip], ['Account', 'Free']);
    assert.deepEqual([headerControl({ signedIn: true, usage: USAGE_PAID }).chip, headerControl({ signedIn: true, usage: USAGE_PAID }).tone], ['Operator', 'operator']);
    const pastDue = headerControl({ signedIn: true, usage: { ...USAGE_FREE, plan: 'past_due' } });
    assert.deepEqual([pastDue.chip, pastDue.tone, pastDue.name], ['Past due', 'danger', 'Account, payment failed']);
  });

  test('requireSignIn answers at once for a signed-in user, and false where no dialog can open', async () => {
    assert.equal(await requireSignIn({ reason: 'review' }), false, 'signed out, under node there is no document');
    mockFetch({ 'GET /api/account': () => json(SIGNED_IN) });
    await refreshAccount();
    assert.equal(await requireSignIn({ reason: 'review' }), true);
  });

  test('onAccountChange hears a change and stops when unsubscribed', async () => {
    const heard = [];
    const off = onAccountChange((account, previous) => heard.push([previous.signedIn, account.signedIn]));
    mockFetch({ 'GET /api/account': () => json(SIGNED_IN) });
    await refreshAccount();
    off();
    mockFetch({ 'GET /api/account': () => json(SIGNED_OUT) });
    await refreshAccount();
    assert.deepEqual(heard, [[false, true]]);

    const immediate = [];
    onAccountChange((account) => immediate.push(account.signedIn), { immediate: true })();
    assert.deepEqual(immediate, [false]);
  });
});

// ---------------------------------------------------------------------------
// The fragment, the stylesheet and the copy
// ---------------------------------------------------------------------------

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const MODULES = ['account.mjs', 'portal.mjs', 'billing-ui.mjs', 'passkey.mjs'];
const sources = Object.fromEntries(MODULES.map((name) => [name, read(`../public/app/${name}`)]));
const css = read('../public/css/account.css');

// ---------------------------------------------------------------------------
// Passkeys inside an in-app browser
// ---------------------------------------------------------------------------

// User agents in the form each app and browser sends. The app tokens are what
// the detection keys on; the version numbers are examples.
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const ANDROID_WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240705.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36';
const IN_APP_AGENTS = [
  ['X', `${IOS} Mobile/15E148 Twitter for iPhone/10.50`],
  ['X', `${IOS.replace('iPhone; CPU iPhone OS', 'iPad; CPU OS')} Mobile/15E148 Twitter for iPad/10.50`],
  ['X', `${ANDROID_WEBVIEW} TwitterAndroid`],
  ['Facebook', `${IOS} Mobile/21F90 [FBAN/FBIOS;FBAV/471.0.0.36.103;FBBV/617042697;FBDV/iPhone15,3;FBMD/iPhone;FBSN/iOS;FBSV/17.5.1;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;FBRV/619531393]`],
  ['Facebook', `${ANDROID_WEBVIEW} [FB_IAB/FB4A;FBAV/470.0.0.37.109;]`],
  ['Facebook', `${IOS} Mobile/21F90 [FBAN/MessengerForiOS;FBAV/465.0.0.38.105;FBBV/612458113;FBDV/iPhone15,3;FBMD/iPhone;FBSN/iOS;FBSV/17.5.1;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/5]`],
  ['Instagram', `${IOS} Mobile/15E148 Instagram 337.0.2.24.86 (iPhone15,3; iOS 17_5_1; en_US; en; scale=3.00; 1290x2796; 614840153)`],
  ['Instagram', `${ANDROID_WEBVIEW} Instagram 338.0.0.47.90 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 8; shiba; shiba; en_US; 618537213)`],
  ['LinkedIn', `${IOS} Mobile/15E148 [LinkedInApp]/9.29.8436`],
  ['LinkedIn', `${ANDROID_WEBVIEW} [LinkedInApp]`],
  ['TikTok', `${IOS} Mobile/15E148 musical_ly_35.3.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US isDarkMode/1 WKWebView/1 RevealType/Dialog BytedanceWebview/d8a21c6`],
  ['TikTok', `${ANDROID_WEBVIEW} trill_2023503040 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/trill app_version/35.3.4 ByteLocale/en ByteFullLocale/en Region/MY AppId/1180 BytedanceWebview/d8a21c6`],
  ['TikTok', `${IOS} Mobile/15E148 TikTok 35.3.0 rv:353024 (iPhone; iOS 17.5.1; en_US) Cronet`],
];
const BROWSER_AGENTS = [
  // Safari on iPhone, iPad and Mac.
  `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`,
  'Mozilla/5.0 (iPad; CPU OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  // Chrome on Android, iPhone, Windows and Mac.
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  `${IOS} CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1`,
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  // Other browsers a visitor may have.
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  `${IOS} FxiOS/127.0 Mobile/15E148 Safari/605.1.15`,
  // The crawlers that build link previews are not in-app browsers.
  'Twitterbot/1.0',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
];

describe('passkeys inside an in-app browser', () => {
  test('each app that opens links in its own browser is recognised', () => {
    for (const [app, agent] of IN_APP_AGENTS) assert.equal(inAppBrowser(agent), app, agent);
  });

  test('Safari, Chrome, other browsers and preview crawlers are never taken for one', () => {
    for (const agent of BROWSER_AGENTS) assert.equal(inAppBrowser(agent), '', agent);
    for (const value of [undefined, null, '', 42, {}]) assert.equal(inAppBrowser(value), '');
  });

  test('without WebAuthn the dialog says so in one sentence and sends the visitor to Safari or Chrome, with the link to copy', () => {
    const none = { webauthn: false, platform: false };
    assert.deepEqual(capabilityMessage(none, BROWSER_AGENTS[0]), {
      tone: 'warn',
      title: 'This browser cannot use passkeys.',
      body: 'Open this page in Safari or Chrome to create your account or sign in.',
      copyLink: true,
    });
    for (const [app, agent] of IN_APP_AGENTS) {
      assert.deepEqual(capabilityMessage(none, agent), {
        tone: 'warn',
        title: `${app}'s in-app browser cannot use passkeys.`,
        body: 'Open this page in Safari or Chrome to create your account or sign in.',
        copyLink: true,
      });
    }
  });

  test('inside an in-app browser the hint shows before anything fails, and blocks nothing', () => {
    for (const capability of [{ webauthn: true, platform: true }, { webauthn: true, platform: false }]) {
      for (const [app, agent] of IN_APP_AGENTS) {
        assert.deepEqual(capabilityMessage(capability, agent), {
          tone: 'info',
          title: `You are in ${app}'s in-app browser.`,
          body: 'If no passkey prompt appears, open this page in Safari or Chrome.',
          copyLink: true,
        });
      }
    }
  });

  test('a browser where passkeys work gets no notice, and one with no provider keeps its own', () => {
    for (const agent of BROWSER_AGENTS) assert.equal(capabilityMessage({ webauthn: true, platform: true }, agent), null);
    const noProvider = capabilityMessage({ webauthn: true, platform: false }, BROWSER_AGENTS[3]);
    assert.deepEqual([noProvider.tone, noProvider.title, noProvider.copyLink], ['info', 'No passkey provider is set up on this device.', false]);
    assert.equal(capabilityMessage({ webauthn: true, platform: true }, undefined), null);
  });
});

describe('fragment', () => {
  const markup = String(accountDialog());

  test('three dialog shells with the ids the script adopts', () => {
    for (const id of ['account-dialog', 'portal-dialog', 'reauth-dialog']) {
      assert.match(markup, new RegExp(`<dialog class="dialog [^"]*" id="${id}" aria-labelledby="${id}-title" closedby="any">`), id);
      assert.match(markup, new RegExp(`id="${id}-title"`), id);
    }
    assert.equal(markup.match(/<dialog /g).length, 3);
    assert.equal(markup.match(/data-close-dialog/g).length, 3);
  });

  test('no inline style, script or handler', () => {
    assert.doesNotMatch(markup, /<script|<style|\sstyle=|\son[a-z]+=/i);
  });

  test('the page lists the stylesheet and the script', () => {
    assert.deepEqual(ACCOUNT_STYLES, ['/css/account.css']);
    assert.deepEqual(ACCOUNT_SCRIPTS, ['/app/account.mjs']);
  });
});

describe('source rules', () => {
  test('no markup is parsed from strings', () => {
    const banned = new RegExp([['inner', 'HTML'], ['outer', 'HTML'], ['insertAdjacent', 'HTML'], ['document.', 'write']].map((parts) => parts.join('').replace('.', '\\.')).join('|'));
    for (const [name, source] of Object.entries(sources)) assert.doesNotMatch(source, banned, name);
  });

  test('no other brand, no personal or third-party method name', () => {
    for (const [name, source] of Object.entries({ ...sources, 'account.css': css })) {
      // Names that must stay out are read from lists git ignores (./private-lists.mjs): a pattern here would publish the name it guards.
      assert.doesNotMatch(source, /krut/i, name);
      assertNoBannedNames(source, name);
    }
  });

  test('the price is only ever US$10 a week', () => {
    for (const [name, source] of Object.entries(sources)) {
      for (const [amount] of source.matchAll(/US\$\d+/g)) assert.equal(amount, 'US$10', name);
      assert.doesNotMatch(source, /\b(free trial|trial period|discount|coupon|% off)\b/i, name);
    }
  });

  test('copy states what happens: no hedging, no filler, no exclamation', () => {
    const hedges = /\b(not a guarantee|can help|we cannot|may not|might|simply|powerful|seamless|just a moment|oops|whoops|please)\b/i;
    for (const [name, source] of Object.entries(sources)) {
      // String literals only: the words a user can read.
      const strings = [...source.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`|"((?:[^"\\\n]|\\.)*)"/g)].map((match) => match[1] ?? match[2] ?? match[3]);
      for (const text of strings.filter((value) => /\s/.test(value) && /^[A-Z]/.test(value))) {
        assert.doesNotMatch(text, hedges, `${name}: ${text}`);
        assert.doesNotMatch(text, /!(?!=)/, `${name}: ${text}`);
        assert.doesNotMatch(text, /\?$/, `${name}: ${text}`);
      }
    }
  });

  test('the support address is on the product domain', () => {
    assert.match(sources['portal.mjs'], /support@bountyoperator\.com/);
  });

  test('the ids the account module documents exist in the code', () => {
    const header = sources['account.mjs'].slice(0, sources['account.mjs'].indexOf('*/'));
    const documented = [...header.matchAll(/#([a-z][a-z0-9-]+)/g)].map((match) => match[1]).filter((id) => !['account', 'pricing'].includes(id));
    assert.ok(documented.length >= 18, `${documented.length} ids documented`);
    // The code below the header comment, the other modules and the fragment.
    const code = [sources['account.mjs'].slice(header.length), sources['portal.mjs'], sources['billing-ui.mjs'], String(accountDialog())].join('\n');
    for (const id of documented) assert.ok(code.includes(id), id);
  });
});

describe('account.css', () => {
  test('colours and sizes come from tokens', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i, 'no hex colour');
    assert.doesNotMatch(rules, /\b(rgb|hsl)a?\(/i, 'no literal colour');
    assert.doesNotMatch(rules, /!important/);
    for (const [declaration, size] of rules.matchAll(/font(?:-size)?:[^;]*?(\d*\.?\d+)(px|rem)\b/g)) {
      assert.ok(Number(size) * (declaration.endsWith('px') ? 1 : 16) >= 12, declaration);
    }
    assert.doesNotMatch(rules, /font-size:\s*\d/, 'font sizes use the --fs tokens');
  });

  test('every class the modules use is styled here or in base.css', () => {
    const base = read('../public/css/base.css');
    const known = new Set([...`${css}\n${base}`.matchAll(/\.(-?[a-z_][\w-]*)/gi)].map((match) => match[1]));
    const used = new Set();
    for (const source of Object.values(sources)) {
      for (const [, list] of source.matchAll(/class(?:Name)?:\s*'([^']+)'/g)) for (const name of list.split(/\s+/)) used.add(name);
      for (const [, list] of source.matchAll(/class(?:Name)?:\s*\['([^']+)'/g)) for (const name of list.split(/\s+/)) used.add(name);
    }
    // Hooks with no rule of their own: two that base.css leaves to the notice, three wrappers.
    const unstyled = new Set(['notice__content', 'notice--info', 'portal-section__head', 'secret__head', 'connection-form']);
    const missing = [...used].filter((name) => name && !known.has(name) && !unstyled.has(name));
    assert.deepEqual(missing, []);
  });
});
