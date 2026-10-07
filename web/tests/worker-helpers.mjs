// Shared fixtures for the Worker tests: a D1 stand-in on node:sqlite with the
// real migrations applied, the env and ctx a handler receives, and a software
// passkey plus a cookie-keeping client for the smoke scripts.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { isoCBOR } from '@simplewebauthn/server/helpers';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

/** An in-memory database with every migration applied, behind the D1 calls the Worker uses. */
export function createDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'));
  }

  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    async first() {
      return sqlite.prepare(sql).get(...params) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...params) };
    },
    async run() {
      const result = sqlite.prepare(sql).run(...params);
      return { meta: { changes: Number(result.changes) } };
    },
  });

  return {
    sqlite,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
  };
}

export function addAccount(db, id = 'account-1') {
  db.sqlite.prepare('INSERT INTO accounts (id, created_at, recovery_hash) VALUES (?, ?, ?)').run(id, 1, `recovery-${id}`);
  return id;
}

export function addSubscription(db, { id = 'sub_1', account = 'account-1', status = 'active', paidUntil = 0 } = {}) {
  db.sqlite
    .prepare('INSERT INTO subscriptions (id, account_id, status, paid_until, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, account, status, paidUntil, 1);
}

/** An ExecutionContext that remembers what was handed to waitUntil. */
export function createContext() {
  const pending = [];
  return {
    waitUntil: (promise) => pending.push(promise),
    passThroughOnException() {},
    /** Resolves once everything queued so far has settled, including work queued meanwhile. */
    async settled() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
}

export const SITE_ORIGIN = 'https://bountyoperator.com';

export function createEnv(overrides = {}) {
  return {
    DB: createDatabase(),
    SITE_ORIGIN,
    AI_REVIEW_ENABLED: 'true',
    BILLING_MODE: 'disabled',
    STRIPE_PRICE_ID: 'price_test',
    // Production sets this secret; /api/health reports a public origin without it.
    IP_HASH_KEY: 'test-ip-hash-key',
    ...overrides,
  };
}

/** The `{ request, env, ctx, url }` a route handler receives. */
export function createCall(request, env = createEnv(), ctx = createContext()) {
  return { request, env, ctx, url: new URL(request.url) };
}

export function funnelCounts(db) {
  const rows = db.sqlite.prepare('SELECT event, n FROM funnel_daily ORDER BY event').all();
  return Object.fromEntries(rows.map((row) => [row.event, row.n]));
}

// ---------------------------------------------------------------------------
// For the smoke scripts, which talk to a local `wrangler dev`
// ---------------------------------------------------------------------------

const b64url = (value) => Buffer.from(value).toString('base64url');
const sha256Bytes = (value) => createHash('sha256').update(value).digest();

/** A software passkey: answers WebAuthn registration and sign-in options the way a platform authenticator does. */
export function createPasskey(origin) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const rawId = randomBytes(32);
  const id = b64url(rawId);
  const rpIdHash = sha256Bytes(new URL(origin).hostname);
  let signCount = 0;

  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  return {
    id,

    /** The body for /api/auth/register/verify or /api/auth/add/verify. */
    register(options) {
      const coseKey = isoCBOR.encode(
        new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x, 'base64url')],
          [-3, Buffer.from(jwk.y, 'base64url')],
        ]),
      );
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(rawId.length);
      // Flags 0x45: user present, user verified, attested credential data included.
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLength, rawId, coseKey]);
      const attestationObject = isoCBOR.encode(
        new Map([
          ['fmt', 'none'],
          ['authData', authData],
          ['attStmt', new Map()],
        ]),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64url(clientData('webauthn.create', options.challenge)),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
      };
    },

    /** The body for /api/auth/login/verify. */
    signIn(options) {
      signCount += 1;
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(signCount);
      // Flags 0x05: user present, user verified.
      const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x05]), counter]);
      const clientDataJSON = clientData('webauthn.get', options.challenge);
      const signature = sign('sha256', Buffer.concat([authenticatorData, sha256Bytes(clientDataJSON)]), privateKey);
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(signature),
        },
      };
    },
  };
}

/** A browser stand-in for one user: keeps cookies and the CSRF token between calls. */
export function createBrowser(origin) {
  const cookies = new Map();
  let csrf = '';

  return {
    cookies,

    /**
     * GET when `body` is undefined, POST otherwise. Asserts the status, and the
     * error code when `code` is given. Returns the parsed JSON body, or null.
     */
    async call(path, body, { status = 200, code, headers = {} } = {}) {
      const isPost = body !== undefined;
      const response = await fetch(origin + path, {
        method: isPost ? 'POST' : 'GET',
        headers: {
          Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          ...(isPost ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}),
          ...headers,
        },
        ...(isPost ? { body: JSON.stringify(body) } : {}),
      });

      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [name, value] = pair.split('=');
        if (value) cookies.set(name, value);
        else cookies.delete(name);
      }

      const text = await response.text();
      const result = text ? JSON.parse(text) : null;
      assert.equal(response.status, status, `${path}: ${result?.error ?? text}`);
      if (code) assert.equal(result?.code, code, path);
      if (result?.csrf) csrf = result.csrf;
      return result;
    },

    /** Creates an account with a new passkey. Returns `{ passkey, recoveryCode }`. */
    async register() {
      const passkey = createPasskey(origin);
      const options = await this.call('/api/auth/register/options', {});
      const result = await this.call('/api/auth/register/verify', passkey.register(options));
      return { passkey, recoveryCode: result.recoveryCode };
    },

    /** Signs in, or confirms the passkey for the session already open. */
    async signIn(passkey) {
      const options = await this.call('/api/auth/login/options', {});
      return this.call('/api/auth/login/verify', passkey.signIn(options));
    },
  };
}
