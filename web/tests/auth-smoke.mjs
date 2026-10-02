// Account smoke check against a local `wrangler dev`. It uses a software
// passkey, opens no browser, contacts no model provider and creates no payment.
//
//   node tests/auth-smoke.mjs http://localhost:8799

import assert from 'node:assert/strict';

import { createBrowser, createPasskey } from './worker-helpers.mjs';

const origin = process.argv[2] || 'http://localhost:8787';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) {
  throw new Error('Run this against a local development server only.');
}

const browser = createBrowser(origin);

// Signed out.
const signedOut = await browser.call('/api/account');
assert.equal(signedOut.signedIn, false);
assert.equal(signedOut.usage, null);
assert.deepEqual(signedOut.price, { usd: 10, interval: 'week' });
await browser.call('/api/portal', undefined, { status: 401, code: 'signin' });

// Registration signs the user in and shows the recovery code once.
const { passkey, recoveryCode } = await browser.register();
assert.match(recoveryCode, /^[A-Za-z0-9_-]{43}$/);

const account = await browser.call('/api/account');
assert.equal(account.signedIn, true);
assert.equal(account.hasSubscription, false);
assert.deepEqual(
  { plan: account.usage.plan, remaining: account.usage.remainingToday, running: account.usage.running, concurrency: account.usage.concurrency },
  { plan: 'free', remaining: 1, running: 0, concurrency: 1 },
);

// A state-changing request needs the page's origin and the session's CSRF token.
await browser.call('/api/auth/logout', {}, { status: 403, code: 'csrf', headers: { 'X-CSRF-Token': 'invalid' } });
await browser.call('/api/auth/logout', {}, { status: 403, code: 'origin', headers: { Origin: 'https://unrelated.invalid' } });
await browser.call('/api/auth/logout', {});
assert.equal((await browser.call('/api/account')).signedIn, false);

// Sign in with the passkey. A challenge works once.
const options = await browser.call('/api/auth/login/options', {});
const assertion = passkey.signIn(options);
assert.equal((await browser.call('/api/auth/login/verify', assertion)).signedIn, true);
await browser.call('/api/auth/login/verify', assertion, { status: 400, code: 'challenge_expired' });

// A passkey the server has never seen is refused.
await browser.call('/api/auth/logout', {});
const stranger = createBrowser(origin);
const strangerOptions = await stranger.call('/api/auth/login/options', {});
await stranger.call('/api/auth/login/verify', createPasskey(origin).signIn(strangerOptions), { status: 400, code: 'passkey' });

// Recovery replaces the code, and the old one stops working.
const recovered = await browser.call('/api/auth/recover', { code: recoveryCode });
assert.equal(recovered.signedIn, true);
assert.notEqual(recovered.recoveryCode, recoveryCode);
await browser.call('/api/auth/recover', { code: recoveryCode }, { status: 400, code: 'recovery' });
await browser.call('/api/auth/recover', { code: 'not-a-code' }, { status: 400, code: 'recovery' });

// The session opened by recovery is fresh, so the account can be deleted at once.
assert.deepEqual(await browser.call('/api/account/delete', {}), { deleted: true });
assert.equal((await browser.call('/api/account')).signedIn, false);

console.log('Passed: registration, sign-in, single-use challenges, CSRF and origin checks, recovery rotation, deletion.');
