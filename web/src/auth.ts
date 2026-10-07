// Passkey accounts: registration, sign-in, recovery, sessions and the bearer
// tokens AI clients use. No password and no email address is involved.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import { base64url, fromBase64url, isToken, randomToken, sha256 } from './crypto.ts';
import { seconds } from './env.ts';
import type { Call, Env } from './env.ts';
import { count } from './funnel.ts';
import { ApiError, json, readJson } from './http.ts';
import { assertBelowLimit, clientKey, rateLimit } from './rate.ts';

const SESSION_SECONDS = 30 * 86400;
const CHALLENGE_SECONDS = 300;
const CONNECTION_SECONDS = 90 * 86400;
const MAX_CONNECTIONS = 3;
/** How recent a passkey check must be before a change to the account's credentials. */
export const RECENT_AUTH_SECONDS = 600;

const REGISTER_OPTIONS_PER_HOUR = 30;
const REGISTRATIONS_PER_DAY = 10;
const RECOVERIES_PER_HOUR = 10;
const CLIENT_REQUESTS_PER_10_MIN = 60;

const WEBAUTHN_BODY_BYTES = 30000;
const SMALL_BODY_BYTES = 2000;

export interface Session {
  account_id: string;
  csrf: string;
  token_hash: string;
  auth_at: number;
}

interface Challenge {
  flow: string;
  account_id: string;
  challenge: string;
}

interface StoredPasskey {
  id: string;
  account_id: string;
  public_key: string;
  counter: number;
  transports: string;
}

function isSecureOrigin(env: Env): boolean {
  return env.SITE_ORIGIN.startsWith('https:');
}

// The __Host- prefix binds the cookie to this exact host over HTTPS. Local
// development runs on http://localhost, where browsers reject the prefix.
function cookieName(env: Env, kind: 'session' | 'challenge'): string {
  return `${isSecureOrigin(env) ? '__Host-' : ''}bounty-${kind}`;
}

function setCookie(env: Env, kind: 'session' | 'challenge', value: string, maxAge: number): string {
  const secure = isSecureOrigin(env) ? '; Secure' : '';
  return `${cookieName(env, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readCookie(request: Request, name: string): string {
  const prefix = `${name}=`;
  const cookies = request.headers.get('cookie')?.split(';') ?? [];
  const found = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

function relyingPartyId(env: Env): string {
  return new URL(env.SITE_ORIGIN).hostname;
}

function passkeyError(): ApiError {
  return new ApiError('Passkey could not be verified.', 400, 'passkey');
}

function parseTransports(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function currentSession(env: Env, request: Request): Promise<Session | null> {
  const value = readCookie(request, cookieName(env, 'session'));
  if (!isToken(value)) return null;
  return env.DB.prepare('SELECT account_id, csrf, token_hash, auth_at FROM sessions WHERE token_hash = ? AND expires > ?')
    .bind(await sha256(value), seconds())
    .first<Session>();
}

/** The signed-in session. With `csrf`, the request must also carry the session's CSRF token. */
export async function requireSession(env: Env, request: Request, { csrf = true } = {}): Promise<Session> {
  const session = await currentSession(env, request);
  if (!session) throw new ApiError('Sign in to continue.', 401, 'signin');
  if (csrf && request.headers.get('x-csrf-token') !== session.csrf) {
    throw new ApiError('Refresh the page and try again.', 403, 'csrf');
  }
  return session;
}

/**
 * A stolen session cookie must not be enough to replace the account's
 * credentials, so those routes need a passkey check from the last ten minutes.
 */
export function requireRecentAuth(session: Session, now = seconds()): void {
  if (session.auth_at < now - RECENT_AUTH_SECONDS) {
    throw new ApiError('Confirm with your passkey to continue.', 401, 'reauth');
  }
}

async function issueSession(env: Env, accountId: string): Promise<{ csrf: string; cookie: string }> {
  const value = randomToken();
  const csrf = randomToken();
  const now = seconds();
  await env.DB.prepare('INSERT INTO sessions (token_hash, account_id, csrf, expires, auth_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(value), accountId, csrf, now + SESSION_SECONDS, now)
    .run();
  return { csrf, cookie: setCookie(env, 'session', value, SESSION_SECONDS) };
}

export function clearSessionCookie(env: Env): string {
  return setCookie(env, 'session', '', 0);
}

// ---------------------------------------------------------------------------
// Challenges: stored server-side, bound to a flow, used once
// ---------------------------------------------------------------------------

async function issueChallenge(env: Env, flow: string, accountId: string, challenge: string): Promise<string> {
  const value = randomToken();
  await env.DB.prepare('INSERT INTO challenges (token_hash, flow, account_id, challenge, expires) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(value), flow, accountId, challenge, seconds() + CHALLENGE_SECONDS)
    .run();
  return setCookie(env, 'challenge', value, CHALLENGE_SECONDS);
}

async function consumeChallenge(env: Env, request: Request, flow: string): Promise<Challenge> {
  const expired = new ApiError('The passkey request expired. Start again.', 400, 'challenge_expired');
  const value = readCookie(request, cookieName(env, 'challenge'));
  if (!isToken(value)) throw expired;

  // DELETE … RETURNING reads and removes the challenge in one step, so it cannot be replayed.
  const row = await env.DB.prepare('DELETE FROM challenges WHERE token_hash = ? AND expires > ? RETURNING flow, account_id, challenge')
    .bind(await sha256(value), seconds())
    .first<Challenge>();
  if (!row || row.flow !== flow) throw expired;
  return row;
}

function clearChallengeCookie(env: Env): string {
  return setCookie(env, 'challenge', '', 0);
}

// ---------------------------------------------------------------------------
// Registration and adding a passkey
// ---------------------------------------------------------------------------

async function registrationOptions(env: Env, accountId: string, flow: 'register' | 'add'): Promise<Response> {
  const existing =
    flow === 'add'
      ? (await env.DB.prepare('SELECT id, transports FROM passkeys WHERE account_id = ?').bind(accountId).all<StoredPasskey>()).results
      : [];

  const options = await generateRegistrationOptions({
    rpName: 'Bounty Operator',
    rpID: relyingPartyId(env),
    userName: `Operator ${accountId.slice(0, 8)}`,
    userID: Uint8Array.from(new TextEncoder().encode(accountId)),
    userDisplayName: 'Bounty Operator account',
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: existing.map((passkey) => ({ id: passkey.id, transports: parseTransports(passkey.transports) })),
  });
  return json(options, 200, { cookies: [await issueChallenge(env, flow, accountId, options.challenge)] });
}

async function verifiedCredential(env: Env, body: Record<string, unknown>, challenge: Challenge) {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: env.SITE_ORIGIN,
      expectedRPID: relyingPartyId(env),
      requireUserVerification: true,
    });
  } catch {
    throw passkeyError();
  }
  if (!verification.verified || !verification.registrationInfo) throw passkeyError();
  return verification.registrationInfo.credential;
}

function insertPasskey(env: Env, accountId: string, credential: Awaited<ReturnType<typeof verifiedCredential>>): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO passkeys (id, account_id, public_key, counter, transports, created_at, label) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    credential.id,
    accountId,
    base64url(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports ?? []),
    seconds(),
    'Passkey',
  );
}

export async function registerOptions({ env, request }: Call): Promise<Response> {
  const key = await clientKey(env, request);
  // Asking for options costs the visitor nothing they can lose: a cancelled
  // passkey prompt must not use up a sign-up. Accounts are counted on success.
  await rateLimit(env.DB, `regopt:${key}`, REGISTER_OPTIONS_PER_HOUR, 3600);
  await assertBelowLimit(env.DB, `register:${key}`, REGISTRATIONS_PER_DAY);
  return registrationOptions(env, crypto.randomUUID(), 'register');
}

export async function registerVerify({ env, ctx, request }: Call): Promise<Response> {
  const challenge = await consumeChallenge(env, request, 'register');
  const body = await readJson(request, WEBAUTHN_BODY_BYTES);
  const credential = await verifiedCredential(env, body, challenge);

  await rateLimit(env.DB, `register:${await clientKey(env, request)}`, REGISTRATIONS_PER_DAY, 86400);

  const recoveryCode = randomToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO accounts (id, created_at, recovery_hash) VALUES (?, ?, ?)').bind(
      challenge.account_id,
      seconds(),
      await sha256(recoveryCode),
    ),
    insertPasskey(env, challenge.account_id, credential),
  ]);

  const issued = await issueSession(env, challenge.account_id);
  count(env, ctx, 'register');
  return json({ signedIn: true, csrf: issued.csrf, recoveryCode }, 200, { cookies: [issued.cookie, clearChallengeCookie(env)] });
}

export async function addPasskeyOptions({ env }: Call, session: Session): Promise<Response> {
  return registrationOptions(env, session.account_id, 'add');
}

export async function addPasskeyVerify({ env, request }: Call, session: Session): Promise<Response> {
  const challenge = await consumeChallenge(env, request, 'add');
  if (challenge.account_id !== session.account_id) throw new ApiError('Account does not match.', 403, 'forbidden');

  const body = await readJson(request, WEBAUTHN_BODY_BYTES);
  const credential = await verifiedCredential(env, body, challenge);
  await insertPasskey(env, session.account_id, credential).run();
  return json({ signedIn: true, csrf: session.csrf, added: true }, 200, { cookies: [clearChallengeCookie(env)] });
}

// ---------------------------------------------------------------------------
// Sign-in and recovery
// ---------------------------------------------------------------------------

export async function loginOptions({ env }: Call): Promise<Response> {
  const options = await generateAuthenticationOptions({ rpID: relyingPartyId(env), userVerification: 'required' });
  return json(options, 200, { cookies: [await issueChallenge(env, 'login', '', options.challenge)] });
}

export async function loginVerify({ env, ctx, request }: Call): Promise<Response> {
  const challenge = await consumeChallenge(env, request, 'login');
  const body = await readJson(request, WEBAUTHN_BODY_BYTES);
  if (typeof body.id !== 'string' || body.id.length > 1500) throw passkeyError();

  const passkey = await env.DB.prepare('SELECT id, account_id, public_key, counter, transports FROM passkeys WHERE id = ?')
    .bind(body.id)
    .first<StoredPasskey>();
  if (!passkey) throw passkeyError();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: env.SITE_ORIGIN,
      expectedRPID: relyingPartyId(env),
      requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: fromBase64url(passkey.public_key),
        counter: passkey.counter,
        transports: parseTransports(passkey.transports),
      },
    });
  } catch {
    throw passkeyError();
  }
  if (!verification.verified) throw passkeyError();

  await env.DB.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').bind(verification.authenticationInfo.newCounter, passkey.id).run();
  count(env, ctx, 'login');

  // A signed-in user confirming with their passkey keeps the session they
  // have; only its passkey-check time moves.
  const existing = await currentSession(env, request);
  if (existing && existing.account_id === passkey.account_id) {
    await env.DB.prepare('UPDATE sessions SET auth_at = ? WHERE token_hash = ?').bind(seconds(), existing.token_hash).run();
    return json({ signedIn: true, csrf: existing.csrf }, 200, { cookies: [clearChallengeCookie(env)] });
  }

  const issued = await issueSession(env, passkey.account_id);
  return json({ signedIn: true, csrf: issued.csrf }, 200, { cookies: [issued.cookie, clearChallengeCookie(env)] });
}

export async function recover({ env, request }: Call): Promise<Response> {
  await rateLimit(env.DB, `recover:${await clientKey(env, request)}`, RECOVERIES_PER_HOUR, 3600);

  const invalid = new ApiError('Recovery code could not be verified.', 400, 'recovery');
  const body = await readJson(request, SMALL_BODY_BYTES);
  if (!isToken(body.code)) throw invalid;

  // One UPDATE checks the old code and installs the new one: a code works once.
  const nextCode = randomToken();
  const account = await env.DB.prepare('UPDATE accounts SET recovery_hash = ? WHERE recovery_hash = ? RETURNING id')
    .bind(await sha256(nextCode), await sha256(body.code))
    .first<{ id: string }>();
  if (!account) throw invalid;

  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(account.id),
    env.DB.prepare('DELETE FROM api_tokens WHERE account_id = ?').bind(account.id),
  ]);
  const issued = await issueSession(env, account.id);
  return json({ signedIn: true, csrf: issued.csrf, recoveryCode: nextCode }, 200, { cookies: [issued.cookie] });
}

export async function logout({ env }: Call, session: Session): Promise<Response> {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.token_hash).run();
  return json({ signedIn: false }, 200, { cookies: [clearSessionCookie(env)] });
}

export async function logoutEverywhere({ env }: Call, session: Session): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(session.account_id),
    env.DB.prepare('DELETE FROM api_tokens WHERE account_id = ?').bind(session.account_id),
  ]);
  return json({ signedIn: false }, 200, { cookies: [clearSessionCookie(env)] });
}

export async function rotateRecovery({ env }: Call, session: Session): Promise<Response> {
  const recoveryCode = randomToken();
  await env.DB.prepare('UPDATE accounts SET recovery_hash = ? WHERE id = ?').bind(await sha256(recoveryCode), session.account_id).run();
  return json({ recoveryCode });
}

export async function removePasskey({ env, request }: Call, session: Session): Promise<Response> {
  const body = await readJson(request, SMALL_BODY_BYTES);
  if (typeof body.id !== 'string' || body.id.length > 1500) throw new ApiError('Choose a passkey.', 400, 'bad_request');

  // The count sits inside the DELETE, so two requests cannot remove the last two passkeys.
  const removed = await env.DB.prepare(
    `DELETE FROM passkeys
     WHERE id = ?1 AND account_id = ?2 AND (SELECT COUNT(*) FROM passkeys WHERE account_id = ?2) > 1
     RETURNING id`,
  )
    .bind(body.id, session.account_id)
    .first();
  if (!removed) throw new ApiError('Keep at least one passkey. Add another before removing this one.', 400, 'last_passkey');

  // Whoever held the removed passkey may still hold a session it opened, or a
  // connection token it created. A token does not record which passkey made
  // it, so every token goes, as on recovery and on signing out everywhere.
  const [, tokens] = await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?').bind(session.account_id, session.token_hash),
    env.DB.prepare('DELETE FROM api_tokens WHERE account_id = ?').bind(session.account_id),
  ]);
  return json({ removed: true, connectionsRevoked: tokens.meta.changes });
}

// ---------------------------------------------------------------------------
// Connections: bearer tokens for AI clients
// ---------------------------------------------------------------------------

export async function createConnection({ env, request }: Call, session: Session): Promise<Response> {
  const body = await readJson(request, SMALL_BODY_BYTES);
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label || label.length > 60 || /[\x00-\x1f\x7f]/.test(label)) {
    throw new ApiError('Name this connection using 1 to 60 characters.', 400, 'bad_request');
  }

  const token = `bok_${randomToken()}`;
  const id = crypto.randomUUID();
  const now = seconds();
  const expires = now + CONNECTION_SECONDS;

  // The limit is part of the INSERT, so parallel requests cannot exceed it.
  const inserted = await env.DB.prepare(
    `INSERT INTO api_tokens (token_hash, id, account_id, label, created_at, expires)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE (SELECT COUNT(*) FROM api_tokens WHERE account_id = ?3 AND expires > ?5) < ${MAX_CONNECTIONS}
     RETURNING id`,
  )
    .bind(await sha256(token), id, session.account_id, label, now, expires)
    .first();
  if (!inserted) {
    throw new ApiError('An account holds three AI connections. Revoke one first.', 400, 'connection_limit');
  }
  return json({ id, token, expires });
}

export async function revokeConnection({ env, request }: Call, session: Session): Promise<Response> {
  const body = await readJson(request, SMALL_BODY_BYTES);
  if (typeof body.id !== 'string' || body.id.length > 80) throw new ApiError('Choose a connection.', 400, 'bad_request');
  await env.DB.prepare('DELETE FROM api_tokens WHERE id = ? AND account_id = ?').bind(body.id, session.account_id).run();
  return json({ revoked: true });
}

/**
 * The account behind a `Bearer bok_…` token. A token reads usage and runs
 * reviews; it never reaches billing, passkeys, recovery or deletion.
 */
export async function bearerAccount({ env, ctx, request }: Call): Promise<string> {
  const origin = request.headers.get('origin');
  if (origin && origin !== env.SITE_ORIGIN) throw new ApiError('Request origin is not allowed.', 403, 'origin');

  const value = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!/^bok_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new ApiError('Send your connection token as "Authorization: Bearer bok_…". Create one in your account panel.', 401, 'token');
  }

  const digest = await sha256(value);
  const now = seconds();
  const row = await env.DB.prepare('SELECT account_id, last_used FROM api_tokens WHERE token_hash = ? AND expires > ?')
    .bind(digest, now)
    .first<{ account_id: string; last_used: number }>();
  if (!row) {
    throw new ApiError('This connection token has expired or was revoked. Create a new one in your account panel.', 401, 'token');
  }

  await rateLimit(env.DB, `client:${digest}`, CLIENT_REQUESTS_PER_10_MIN, 600);
  if (row.last_used < now - 60) {
    ctx.waitUntil(
      env.DB.prepare('UPDATE api_tokens SET last_used = ? WHERE token_hash = ?')
        .bind(now, digest)
        .run()
        .catch(() => {}),
    );
  }
  return row.account_id;
}
