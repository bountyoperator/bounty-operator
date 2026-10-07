// Credential changes on an account: what removing a passkey takes with it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bearerAccount, removePasskey } from '../src/auth.ts';
import { sha256 } from '../src/crypto.ts';
import { SITE_ORIGIN, addAccount, createCall, createContext, createEnv } from './worker-helpers.mjs';

const ACCOUNT = 'account-1';
const TOKEN = `bok_${'A'.repeat(43)}`;
const now = () => Math.floor(Date.now() / 1000);

function addPasskey(db, id) {
  db.sqlite
    .prepare('INSERT INTO passkeys (id, account_id, public_key, counter, transports, created_at, label) VALUES (?, ?, ?, 0, ?, ?, ?)')
    .run(id, ACCOUNT, 'key', '[]', now(), id);
}

function addSession(db, tokenHash) {
  db.sqlite
    .prepare('INSERT INTO sessions (token_hash, account_id, csrf, expires, auth_at) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash, ACCOUNT, 'csrf', now() + 3600, now());
}

function post(path, body, headers = {}) {
  return new Request(`${SITE_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SITE_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

test('removing a passkey signs out other sessions and revokes every connection token', async () => {
  const env = createEnv();
  addAccount(env.DB, ACCOUNT);
  addPasskey(env.DB, 'owner-key');
  addPasskey(env.DB, 'intruder-key');
  addSession(env.DB, 'owner-session');
  addSession(env.DB, 'intruder-session');
  env.DB.sqlite
    .prepare('INSERT INTO api_tokens (token_hash, id, account_id, label, created_at, expires) VALUES (?, ?, ?, ?, ?, ?)')
    .run(await sha256(TOKEN), 'token-1', ACCOUNT, 'Minted by the intruder', now(), now() + 86400);

  const bearer = () => bearerAccount(createCall(post('/api/client/account', {}, { Authorization: `Bearer ${TOKEN}` }), env, createContext()));
  assert.equal(await bearer(), ACCOUNT, 'the token works before the removal');

  const session = { account_id: ACCOUNT, token_hash: 'owner-session', csrf: 'csrf', expires: now() + 3600, auth_at: now() };
  const response = await removePasskey(createCall(post('/api/passkeys/remove', { id: 'intruder-key' }), env, createContext()), session);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: true, connectionsRevoked: 1 });

  const sessions = env.DB.sqlite.prepare('SELECT token_hash FROM sessions ORDER BY token_hash').all().map((row) => row.token_hash);
  assert.deepEqual(sessions, ['owner-session'], 'only the session that removed the passkey stays');
  await assert.rejects(bearer(), (error) => error.status === 401 && error.code === 'token');
});
