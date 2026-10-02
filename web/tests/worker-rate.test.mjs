import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../src/http.ts';
import { assertBelowLimit, edgeLimit, ipBucket, ipHashSecret, rateKey, rateLimit } from '../src/rate.ts';
import { createDatabase } from './worker-helpers.mjs';

const ENV = { SITE_ORIGIN: 'https://bountyoperator.com', IP_HASH_KEY: 'test-secret' };

test('ipBucket keeps a whole IPv4 address', () => {
  assert.equal(ipBucket('203.0.113.7'), 'v4:203.0.113.7');
  assert.equal(ipBucket(' 203.0.113.7 '), 'v4:203.0.113.7');
  assert.notEqual(ipBucket('203.0.113.7'), ipBucket('203.0.113.8'));
});

test('ipBucket reduces an IPv6 address to its /64', () => {
  assert.equal(ipBucket('2001:db8:1:2:3:4:5:6'), 'v6:2001:db8:1:2');
  assert.equal(ipBucket('2001:db8:1:2::1'), 'v6:2001:db8:1:2');
  assert.equal(ipBucket('2001:DB8:1:2:ffff:ffff:ffff:ffff'), 'v6:2001:db8:1:2');
  assert.equal(ipBucket('2001:0db8:0001:0002::'), 'v6:2001:db8:1:2');
  assert.equal(ipBucket('[2001:db8:1:2::9]'), 'v6:2001:db8:1:2');
  assert.equal(ipBucket('fe80::1%eth0'), 'v6:fe80:0:0:0');
  assert.equal(ipBucket('::1'), 'v6:0:0:0:0');
  assert.notEqual(ipBucket('2001:db8:1:2::1'), ipBucket('2001:db8:1:3::1'), 'the next /64 is another subscriber');
});

test('ipBucket reads an IPv4-mapped IPv6 address as IPv4', () => {
  assert.equal(ipBucket('::ffff:203.0.113.7'), 'v4:203.0.113.7');
  assert.equal(ipBucket('::ffff:cb00:7107'), 'v4:203.0.113.7');
  assert.equal(ipBucket('0:0:0:0:0:ffff:203.0.113.7'), 'v4:203.0.113.7');
});

test('ipBucket puts everything that is not an address in one bucket', () => {
  for (const value of [null, undefined, '', 'localhost', '1.2.3', '1.2.3.999', '1:2:3', '1::2::3', 'g::1', '1:2:3:4:5:6:7:8:9', ':1:2:3:4:5:6:7']) {
    assert.equal(ipBucket(value), 'unknown', String(value));
  }
});

test('rateKey is a keyed hash: stable, secret-dependent, and never the address', async () => {
  const key = await rateKey(ENV, '203.0.113.7');
  assert.match(key, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(key, await rateKey(ENV, '203.0.113.7'));
  assert.notEqual(key, await rateKey(ENV, '203.0.113.8'));
  assert.notEqual(key, await rateKey({ ...ENV, IP_HASH_KEY: 'another-secret' }, '203.0.113.7'));
  assert(!key.includes('203'));
});

test('rateKey gives every address in one IPv6 /64 the same key', async () => {
  const first = await rateKey(ENV, '2001:db8:1:2::1');
  assert.equal(first, await rateKey(ENV, '2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
  assert.notEqual(first, await rateKey(ENV, '2001:db8:1:3::1'));
});

test('without IP_HASH_KEY the secret is derived from the origin, so local development works', async () => {
  const local = { SITE_ORIGIN: 'http://localhost:8799' };
  assert.equal(ipHashSecret(ENV), 'test-secret');
  assert.match(ipHashSecret(local), /localhost:8799$/);
  assert.notEqual(ipHashSecret(local), ipHashSecret({ SITE_ORIGIN: 'http://localhost:8787' }));
  assert.match(await rateKey(local, '127.0.0.1'), /^[A-Za-z0-9_-]{22}$/);
});

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

test('rateLimit allows max hits per window and says when to retry', async () => {
  const db = createDatabase();
  const now = 1000;

  for (let hit = 1; hit <= 3; hit += 1) await rateLimit(db, 'auth:key', 3, 600, now + hit);

  const error = await rejection(rateLimit(db, 'auth:key', 3, 600, now + 100));
  assert(error instanceof ApiError);
  assert.equal(error.status, 429);
  assert.equal(error.code, 'rate_limited');
  assert.equal(error.extra.retryAfter, 501, 'seconds left in the window that the first hit opened');

  await rateLimit(db, 'auth:other', 3, 600, now + 100);
  await rateLimit(db, 'auth:key', 3, 600, now + 601);
  assert.equal(db.sqlite.prepare("SELECT hits FROM rate_limits WHERE id = 'auth:key'").get().hits, 1, 'a new window starts at one');
});

test('assertBelowLimit checks a counter without adding to it', async () => {
  const db = createDatabase();
  await assertBelowLimit(db, 'register:key', 2, 1000);

  await rateLimit(db, 'register:key', 2, 86400, 1000);
  await assertBelowLimit(db, 'register:key', 2, 1001);
  await rateLimit(db, 'register:key', 2, 86400, 1002);

  const error = await rejection(assertBelowLimit(db, 'register:key', 2, 1003));
  assert.equal(error?.code, 'rate_limited');
  assert.equal(db.sqlite.prepare("SELECT hits FROM rate_limits WHERE id = 'register:key'").get().hits, 2);

  await assertBelowLimit(db, 'register:key', 2, 1000 + 86400);
});

test('edgeLimit passes without the binding and refuses when the binding says so', async () => {
  await edgeLimit({}, 'key');

  const seen = [];
  const limiter = (success) => ({
    API_LIMITER: {
      async limit(options) {
        seen.push(options.key);
        return { success };
      },
    },
  });
  await edgeLimit(limiter(true), 'key-a');
  const error = await rejection(edgeLimit(limiter(false), 'key-b'));
  assert.equal(error?.status, 429);
  assert.equal(error.extra.retryAfter, 60);
  assert.deepEqual(seen, ['key-a', 'key-b']);
});
