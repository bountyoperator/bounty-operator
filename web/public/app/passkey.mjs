/**
 * Passkey ceremonies: create an account, sign in, confirm a signed-in user,
 * add a passkey. Each one asks the Worker for options, runs the browser's
 * WebAuthn prompt, and sends the answer back.
 *
 * Imports ./api.mjs only. Touches no DOM, so it loads under node; the browser
 * objects (navigator.credentials, PublicKeyCredential) are read when a function
 * is called.
 *
 * Exports
 *   passkeySupport()                    -> Promise<{ webauthn, platform }>
 *   PASSKEY_PROVIDERS                   the sentence fragment naming what works
 *   registerPasskey()                   -> Promise<{ signedIn, csrf, recoveryCode }>
 *   signInWithPasskey({ allow }?)       -> Promise<{ signedIn, csrf }>
 *   addPasskey()                        -> Promise<{ signedIn, csrf, added }>
 *   isCancelled(error)                  -> boolean   the user closed the prompt
 *
 *   toBytes(base64url)                  -> Uint8Array
 *   toBase64Url(buffer)                 -> string
 *   creationOptions(json)               -> PublicKeyCredentialCreationOptions
 *   requestOptions(json, allow?)        -> PublicKeyCredentialRequestOptions
 *   credentialToJson(credential)        -> the body the Worker verifies
 *   passkeyFailure(error, flow)         -> ApiError
 *
 * Errors
 *   Every failure is an ApiError. Codes this module adds to the Worker's:
 *     passkey_cancelled     the prompt was closed, refused or timed out
 *     passkey_exists        this authenticator already holds a passkey for the account
 *     passkey_unsupported   no WebAuthn here, or no authenticator that can verify the user
 *     passkey_failed        anything else the browser threw
 *
 * Signing in while already signed in to the same account does not open a new
 * session: the Worker moves the session's passkey-check time. That is the
 * "Confirm it's you" step. `allow` limits the prompt to the account's own
 * passkeys, so the confirmation cannot switch accounts.
 */

import { ApiError, request } from './api.mjs';

/** What a visitor can use. One list, so every message names the same things. */
export const PASSKEY_PROVIDERS = 'Windows Hello, Touch ID, iCloud Keychain, Google Password Manager, 1Password, Bitwarden or a security key';

const ROUTES = {
  register: { options: '/api/auth/register/options', verify: '/api/auth/register/verify' },
  login: { options: '/api/auth/login/options', verify: '/api/auth/login/verify' },
  add: { options: '/api/auth/add/options', verify: '/api/auth/add/verify' },
};

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

/**
 * @param {string} value  base64url, with or without padding
 * @returns {Uint8Array}
 */
export function toBytes(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * @param {ArrayBuffer | ArrayBufferView} buffer
 * @returns {string} base64url without padding
 */
export function toBase64Url(buffer) {
  const bytes = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Options and answers
// ---------------------------------------------------------------------------

function nativeParser(name) {
  const api = globalThis.PublicKeyCredential;
  return api && typeof api[name] === 'function' ? api[name].bind(api) : null;
}

function descriptors(list) {
  return Array.isArray(list) ? list.map((entry) => ({ ...entry, id: toBytes(entry.id) })) : undefined;
}

/**
 * The Worker's registration options, ready for navigator.credentials.create().
 *
 * @param {Record<string, any>} json
 * @returns {PublicKeyCredentialCreationOptions}
 */
export function creationOptions(json) {
  const parse = nativeParser('parseCreationOptionsFromJSON');
  if (parse) {
    try {
      return parse(json);
    } catch {
      // A browser that knows the method but not a field in the options: convert by hand.
    }
  }
  const options = { ...json, challenge: toBytes(json.challenge), user: { ...json.user, id: toBytes(json.user.id) } };
  const excluded = descriptors(json.excludeCredentials);
  if (excluded) options.excludeCredentials = excluded;
  return options;
}

/**
 * The Worker's sign-in options, ready for navigator.credentials.get().
 *
 * @param {Record<string, any>} json
 * @param {string[]} [allow]  Credential ids (base64url) the prompt is limited to.
 * @returns {PublicKeyCredentialRequestOptions}
 */
export function requestOptions(json, allow) {
  const limited = Array.isArray(allow) && allow.length > 0;
  const source = limited ? { ...json, allowCredentials: allow.map((id) => ({ id, type: 'public-key' })) } : json;

  const parse = nativeParser('parseRequestOptionsFromJSON');
  if (parse) {
    try {
      return parse(source);
    } catch {
      // As above.
    }
  }
  const options = { ...source, challenge: toBytes(source.challenge) };
  const allowed = descriptors(source.allowCredentials);
  if (allowed) options.allowCredentials = allowed;
  return options;
}

function manualJson(credential) {
  const response = credential.response;
  const body = { clientDataJSON: toBase64Url(response.clientDataJSON) };

  if (response.attestationObject) {
    body.attestationObject = toBase64Url(response.attestationObject);
    body.transports = typeof response.getTransports === 'function' ? response.getTransports() : [];
  }
  if (response.authenticatorData && response.signature) {
    body.authenticatorData = toBase64Url(response.authenticatorData);
    body.signature = toBase64Url(response.signature);
    if (response.userHandle && response.userHandle.byteLength > 0) body.userHandle = toBase64Url(response.userHandle);
  }

  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: typeof credential.getClientExtensionResults === 'function' ? credential.getClientExtensionResults() : {},
    response: body,
  };
}

/**
 * The JSON form of what the authenticator returned. Password-manager
 * extensions replace navigator.credentials and some return an object whose
 * toJSON is missing or throws; the fields are then read one by one.
 *
 * @param {PublicKeyCredential | null} credential
 * @returns {Record<string, unknown>}
 */
export function credentialToJson(credential) {
  if (!credential) throw new ApiError('The passkey prompt was closed. Nothing changed.', { code: 'passkey_cancelled' });
  if (typeof credential.toJSON === 'function') {
    try {
      const json = credential.toJSON();
      if (json && typeof json === 'object' && typeof json.id === 'string' && json.response) return json;
    } catch {
      // Read the fields by hand.
    }
  }
  return manualJson(credential);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const UNSUPPORTED = `This browser cannot use passkeys. Open the site in a current Chrome, Edge, Safari or Firefox. Passkeys come from ${PASSKEY_PROVIDERS}.`;

/**
 * Turns what the browser threw during a ceremony into an ApiError.
 *
 * @param {unknown} error
 * @param {'register' | 'login' | 'add'} flow
 * @returns {ApiError}
 */
export function passkeyFailure(error, flow) {
  if (error instanceof ApiError) return error;
  const name = error && typeof error === 'object' ? error.name : '';

  if (name === 'NotAllowedError') {
    return new ApiError('The passkey prompt was closed or timed out. Nothing changed.', { code: 'passkey_cancelled' });
  }
  if (name === 'AbortError') return new ApiError('Stopped.', { code: 'aborted' });
  if (name === 'InvalidStateError' && flow !== 'login') {
    return new ApiError('This device already holds a passkey for this account. Use another device or passkey provider.', { code: 'passkey_exists' });
  }
  if (name === 'NotSupportedError' || name === 'ConstraintError') {
    return new ApiError(`This device cannot verify you with a PIN, fingerprint or face. Use ${PASSKEY_PROVIDERS} with a PIN.`, {
      code: 'passkey_unsupported',
    });
  }
  if (name === 'SecurityError') {
    return new ApiError('Passkeys work on https://bountyoperator.com only. Open the site there and try again.', { code: 'passkey_unsupported' });
  }
  return new ApiError('The passkey request did not finish. Try again.', { code: 'passkey_failed' });
}

/**
 * True when the user closed the prompt: say so quietly, it is not a failure.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isCancelled(error) {
  return error instanceof ApiError && (error.code === 'passkey_cancelled' || error.code === 'aborted');
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/**
 * What this browser can do.
 *   webauthn   navigator.credentials and PublicKeyCredential exist
 *   platform   the device itself can verify the user (Windows Hello, Touch ID, a phone's screen lock)
 *
 * With `webauthn` and no `platform`, a password manager or a security key
 * still works, so the buttons stay enabled and the dialog names what to use.
 *
 * @returns {Promise<{ webauthn: boolean, platform: boolean }>}
 */
export async function passkeySupport() {
  const api = globalThis.PublicKeyCredential;
  const credentials = globalThis.navigator?.credentials;
  if (!api || !credentials || typeof credentials.create !== 'function' || typeof credentials.get !== 'function') {
    return { webauthn: false, platform: false };
  }
  let platform = false;
  try {
    platform = typeof api.isUserVerifyingPlatformAuthenticatorAvailable === 'function' && (await api.isUserVerifyingPlatformAuthenticatorAvailable()) === true;
  } catch {
    platform = false;
  }
  return { webauthn: true, platform };
}

function credentialStore() {
  const credentials = globalThis.navigator?.credentials;
  if (!globalThis.PublicKeyCredential || !credentials) throw new ApiError(UNSUPPORTED, { code: 'passkey_unsupported' });
  return credentials;
}

// ---------------------------------------------------------------------------
// Ceremonies
// ---------------------------------------------------------------------------

async function create(flow) {
  const credentials = credentialStore();
  const options = await request(ROUTES[flow].options, { body: {} });
  let credential;
  try {
    credential = await credentials.create({ publicKey: creationOptions(options) });
  } catch (error) {
    throw passkeyFailure(error, flow);
  }
  return request(ROUTES[flow].verify, { body: credentialToJson(credential) });
}

/**
 * Creates an account: one passkey prompt, no email. The answer carries the
 * recovery code, which the Worker shows this once.
 *
 * @returns {Promise<{ signedIn: true, csrf: string, recoveryCode: string }>}
 */
export function registerPasskey() {
  return create('register');
}

/**
 * Adds a passkey to the signed-in account. The Worker asks for a recent
 * passkey check first: wrap the call in withReauth().
 *
 * @returns {Promise<{ signedIn: true, csrf: string, added: true }>}
 */
export function addPasskey() {
  return create('add');
}

/**
 * Signs in with a passkey the browser offers. For a user who is already
 * signed in to the same account it confirms them and keeps the session.
 *
 * @param {{ allow?: string[] }} [options]  Limit the prompt to these credential ids.
 * @returns {Promise<{ signedIn: true, csrf: string }>}
 */
export async function signInWithPasskey({ allow } = {}) {
  const credentials = credentialStore();
  const options = await request(ROUTES.login.options, { body: {} });
  let credential;
  try {
    credential = await credentials.get({ publicKey: requestOptions(options, allow) });
  } catch (error) {
    throw passkeyFailure(error, 'login');
  }
  return request(ROUTES.login.verify, { body: credentialToJson(credential) });
}
