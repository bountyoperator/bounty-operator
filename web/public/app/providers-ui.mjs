/**
 * How the review runs: OpenRouter in one click, the user's own API key, or the
 * user's chat subscription (prompt out, reply back).
 *
 * Keys live in this module's variables for as long as the tab is open. They
 * are never written to storage, with one exception the user asks for: the
 * OpenRouter key from Connect is kept in sessionStorage when "Keep the key
 * for this tab session" is ticked.
 *
 * Exports
 *   initProviders()                 wire the "Run with" and "Model" rows
 *   setVia(via, { focus })          switch between 'connect', 'key' and 'export'
 *   credentials()                   -> { via, provider, model, apiKey }   the model falls back to the provider's default
 *   heldKey(providerId)             -> string   the key held in memory for a provider, for the panel
 *   holdKey(providerId, value)      hold a key typed elsewhere (a panel seat) in memory
 *   checkCredentials()              -> boolean   validates shape, marks the field and moves focus when it fails
 *   markInvalid(field, message)     field: 'key' | 'model' | 'connect'
 *   clearInvalid()
 *   resumeOpenRouter()              -> Promise<boolean>   finishes Connect after the redirect back
 *   Pure helpers (tested)
 *     newVerifier()                 -> string   43 characters, base64url
 *     challengeFor(verifier)        -> Promise<string>   S256
 *     authUrl(callback, challenge)  -> string
 *     reconcileVia(provider, via, keyProvider) -> { via, keyProvider }
 *
 * DOM this module owns: input[name="wb-via"], #wb-provider, #wb-model,
 * #wb-models, #wb-key, #wb-key-forget, #wb-connect and its children, and the
 * visibility of #wb-row-model, #wb-row-run, #wb-row-prompt, #wb-row-reply.
 */

import { PROVIDERS, outputTokenLimit, provider as findProvider, validateProviderRequest } from '../providers.mjs';
import { EXPORT_PROVIDER, readSession, removeSession, saveWorkbench, workbench, writeSession } from './state.mjs';
import { clear, el, icon, on, qs, qsa, setBusy } from './ui.mjs';
import { hostedLine, isHosted, say, view } from './workbench.mjs';

const PKCE_KEY = 'bo:openrouter:pkce';
const KEPT_KEY = 'bo:openrouter:kept';
const OPENROUTER = 'openrouter';
const AUTH_URL = 'https://openrouter.ai/auth';
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 20000;

/** Keys typed in this tab, by provider id. @type {Map<string, string>} */
const keys = new Map();
/** Model ids typed in this tab, by provider id. @type {Map<string, string>} */
const models = new Map();
/** The key OpenRouter issued through Connect. */
let connected = '';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A PKCE code verifier: 32 random bytes as base64url. */
export function newVerifier() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The S256 code challenge for a verifier.
 *
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * The OpenRouter consent page for this app.
 *
 * @param {string} callback  Where OpenRouter sends the user back, with ?code=.
 * @param {string} challenge
 */
export function authUrl(callback, challenge) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('callback_url', callback);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

/**
 * Makes the "Run with" choice agree with the stored provider.
 *
 * @param {string} provider  A provider id, or 'export'.
 * @param {string} via
 * @param {string} keyProvider
 * @returns {{ via: 'connect' | 'key' | 'export', keyProvider: string }}
 */
export function reconcileVia(provider, via, keyProvider) {
  const known = (id) => PROVIDERS.some((entry) => entry.id === id);
  const fallback = known(keyProvider) ? keyProvider : PROVIDERS[0].id;
  if (provider === EXPORT_PROVIDER) return { via: 'export', keyProvider: fallback };
  if (!known(provider)) return { via: via === 'key' ? 'key' : 'connect', keyProvider: fallback };
  if (via === 'key') return { via: 'key', keyProvider: provider };
  if (provider === OPENROUTER) return { via: 'connect', keyProvider: fallback };
  return { via: 'key', keyProvider: provider };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function activeProviderId() {
  const { via, keyProvider } = view.get();
  if (via === 'export') return EXPORT_PROVIDER;
  return via === 'connect' ? OPENROUTER : keyProvider;
}

/**
 * What a hosted run sends. `model` is the provider's default when the field
 * is empty. `apiKey` is '' when none was given.
 *
 * @returns {{ via: 'connect' | 'key' | 'export', provider: string, model: string, apiKey: string }}
 */
export function credentials() {
  const { via } = view.get();
  const id = activeProviderId();
  if (id === EXPORT_PROVIDER) return { via, provider: EXPORT_PROVIDER, model: '', apiKey: '' };
  const selected = findProvider(id);
  const typed = (models.get(id) ?? '').trim();
  return {
    via,
    provider: id,
    model: typed || selected.defaultModel,
    apiKey: via === 'connect' ? connected : (keys.get(id) ?? '').trim(),
  };
}

/**
 * Puts a model id in the Model field of the provider in use, as if it had been
 * typed there. Nothing happens on the copy-paste route, which calls no model.
 *
 * @param {string} modelId
 */
export function chooseModel(modelId) {
  const id = activeProviderId();
  if (id === EXPORT_PROVIDER || typeof modelId !== 'string' || !modelId.trim()) return;
  models.set(id, modelId.trim());
  const field = qs('#wb-model');
  if (field) {
    field.value = modelId.trim();
    field.removeAttribute('aria-invalid');
  }
  paintModelHelp(id);
  commit();
}

/**
 * The key this tab holds for a provider: the one typed under "My own API key",
 * or for OpenRouter the connected one. '' when there is none. The panel uses it
 * to seat models from several providers.
 *
 * @param {string} providerId
 * @returns {string}
 */
export function heldKey(providerId) {
  const typed = (keys.get(providerId) ?? '').trim();
  if (providerId !== OPENROUTER) return typed;
  return view.get().via === 'connect' ? connected || typed : typed || connected;
}

/**
 * Holds a key for a provider in memory, as if it had been typed in the key field.
 *
 * @param {string} providerId
 * @param {string} value
 */
export function holdKey(providerId, value) {
  if (!PROVIDERS.some((entry) => entry.id === providerId)) return;
  keys.set(providerId, String(value ?? ''));
  if (view.get().via === 'key' && view.get().keyProvider === providerId) paintKey(providerId);
}

const FIELDS = Object.freeze({
  key: { control: '#wb-key', error: '#wb-key-error' },
  model: { control: '#wb-model', error: '#wb-model-error' },
  connect: { control: '#wb-or-connect', error: '#wb-or-error' },
});

/**
 * Shows an error under a field and moves focus to it.
 *
 * @param {'key' | 'model' | 'connect'} field
 * @param {string} message
 */
export function markInvalid(field, message) {
  const target = FIELDS[field];
  if (!target) return;
  const control = qs(target.control);
  const error = qs(target.error);
  if (control && field !== 'connect') control.setAttribute('aria-invalid', 'true');
  if (error) {
    clear(error).append(icon('error'), el('span', { text: message }));
    error.hidden = false;
  }
  control?.focus();
}

export function clearInvalid() {
  for (const target of Object.values(FIELDS)) {
    qs(target.control)?.removeAttribute('aria-invalid');
    const error = qs(target.error);
    if (error) {
      error.hidden = true;
      clear(error);
    }
  }
}

/**
 * Checks the provider, model and key shape before anything is sent, so a
 * missing key is asked for before a sign-in is. Marks the field that fails.
 *
 * @returns {boolean}
 */
export function checkCredentials() {
  clearInvalid();
  const request = credentials();
  if (request.via === 'export') return true;
  const selected = findProvider(request.provider);

  if (!request.apiKey) {
    if (request.via === 'connect') markInvalid('connect', 'Connect OpenRouter first, or pick "My own API key".');
    else markInvalid('key', `Paste your ${selected.keyLabel}.`);
    return false;
  }
  try {
    validateProviderRequest(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The provider settings are not valid.';
    markInvalid(/model identifier/.test(message) ? 'model' : 'key', message);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

function show(selector, visible) {
  const node = qs(selector);
  if (node) node.hidden = !visible;
}

function paintModel(id) {
  const selected = findProvider(id);
  const field = qs('#wb-model');
  const list = qs('#wb-models');
  if (field) {
    field.placeholder = selected.defaultModel;
    const value = models.get(id) ?? '';
    if (field !== document.activeElement && field.value !== value) field.value = value;
  }
  if (list) {
    clear(list).append(...selected.models.map((entry) => el('option', { value: entry.id, label: entry.note ? `${entry.label} · ${entry.note}` : entry.label })));
  }
  paintModelHelp(id);
}

/** The larger allowance matters to users paying their provider for each call. Website reviews are streamed. */
export function modelUsageNote(providerId, modelId) {
  return outputTokenLimit(providerId, modelId, { stream: true }) === 64000
    ? 'This model can use up to 64,000 output tokens, including reasoning. Your provider bills the tokens used.' : '';
}

function paintModelHelp(id) {
  const selected = findProvider(id);
  const help = qs('#wb-model-help');
  const note = modelUsageNote(id, (models.get(id) ?? '').trim() || selected.defaultModel);
  if (help) help.textContent = `Left empty, ${selected.defaultModel} is used. Any model id ${selected.label} serves works.${note ? ` ${note}` : ''}`;
}

function paintKey(id) {
  const selected = findProvider(id);
  const field = qs('#wb-key');
  const label = qs('#wb-key-label');
  const link = qs('#wb-key-link');
  if (label) label.textContent = selected.keyLabel;
  if (link) link.setAttribute('href', selected.docsUrl);
  if (field) {
    const value = keys.get(id) ?? '';
    if (field.value !== value) field.value = value;
    field.placeholder = selected.keyPrefixHint ? `${selected.keyPrefixHint}…` : '';
  }
  paintKeyHint();
}

/** A key that does not start the way this provider's keys do is usually another provider's. */
function paintKeyHint() {
  const hint = qs('#wb-key-hint');
  if (!hint) return;
  const { via, keyProvider } = view.get();
  const selected = via === 'key' ? findProvider(keyProvider) : null;
  const value = selected ? (keys.get(selected.id) ?? '').trim() : '';
  const mismatch = Boolean(selected?.keyPrefixHint) && value.length >= 8 && !value.startsWith(selected.keyPrefixHint);
  hint.hidden = !mismatch;
  hint.textContent = mismatch ? `${selected.label} keys start with ${selected.keyPrefixHint}. Check that this key belongs to ${selected.label}.` : '';
}

function paintConnect() {
  show('#wb-or-off', !connected);
  show('#wb-or-on', Boolean(connected));
  const state = qs('#wb-or-state');
  if (state) {
    state.textContent = readSession(KEPT_KEY)
      ? 'OpenRouter key kept for this tab session.'
      : 'OpenRouter key held in memory for this tab.';
  }
}

/**
 * The chat-subscription rows for the chosen profile. A core profile gets the
 * prompt buttons and the reply field. A hosted profile gets one line in their
 * place: it runs on our server, and these are the profiles that can be exported.
 */
function paintExport() {
  const profileId = workbench.get().profile;
  const exportable = !isHosted(profileId);
  show('#wb-row-reply', exportable);

  const actions = qs('#wb-copy-prompt')?.closest('.wb-actions');
  if (!actions?.parentElement) return;
  let line = qs('#wb-export-hosted');
  if (!line) {
    line = el('p', { class: 'wb-lead', id: 'wb-export-hosted' });
    actions.before(line);
  }
  // Everything else in the row is the prompt export: its lead and its buttons.
  for (const node of actions.parentElement.children) {
    if (node !== line) node.hidden = !exportable;
  }
  line.hidden = exportable;
  line.textContent = exportable ? '' : hostedLine(profileId);
}

function paint() {
  const { via, keyProvider } = view.get();
  for (const radio of qsa('input[name="wb-via"]')) radio.checked = radio.value === via;

  const hosted = via !== 'export';
  show('#wb-row-model', hosted);
  show('#wb-row-run', hosted);
  show('#wb-row-prompt', !hosted);
  show('#wb-row-reply', !hosted);
  if (!hosted) {
    paintExport();
    return;
  }

  const id = via === 'connect' ? OPENROUTER : keyProvider;
  show('#wb-provider-field', via === 'key');
  show('#wb-key-field', via === 'key');
  show('#wb-connect', via === 'connect');
  const select = qs('#wb-provider');
  if (select && select.value !== keyProvider) select.value = keyProvider;
  paintModel(id);
  if (via === 'key') paintKey(id);
  else paintConnect();
}

/** Writes the choice to the workbench store, which is what a reload restores. */
function commit() {
  const id = activeProviderId();
  workbench.set({ provider: id, model: id === EXPORT_PROVIDER ? '' : (models.get(id) ?? '').trim() });
}

/**
 * Switches how the review runs, as if the user had picked that card.
 *
 * @param {'connect' | 'key' | 'export'} via
 * @param {{ focus?: boolean }} [options]  Move focus to the first control of the choice.
 */
export function setVia(via, { focus = false } = {}) {
  if (!['connect', 'key', 'export'].includes(via)) return;
  clearInvalid();
  view.set({ via });
  commit();
  paint();
  if (focus) qs(via === 'export' ? '#wb-copy-prompt' : via === 'key' ? '#wb-key' : '#wb-or-connect')?.focus();
}

// ---------------------------------------------------------------------------
// OpenRouter Connect (OAuth PKCE, browser only)
// ---------------------------------------------------------------------------

function callbackUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

async function startConnect() {
  clearInvalid();
  const control = qs('#wb-or-connect');
  setBusy(control, true, 'Opening OpenRouter');
  try {
    const verifier = newVerifier();
    const challenge = await challengeFor(verifier);
    const keep = Boolean(qs('#wb-or-keep')?.checked);
    // The verifier has to survive the trip to openrouter.ai and back.
    if (!writeSession(PKCE_KEY, { verifier, keep, at: Date.now() })) {
      markInvalid('connect', 'This browser blocks session storage, so the connection cannot come back to this tab. Paste an OpenRouter key under "My own API key".');
      setBusy(control, false);
      return;
    }
    saveWorkbench();
    window.location.assign(authUrl(callbackUrl(), challenge));
  } catch {
    setBusy(control, false);
    markInvalid('connect', 'The connection could not be started in this browser. Paste an OpenRouter key under "My own API key".');
  }
}

function exchangeFailure(status) {
  if (status === 400 || status === 403 || status === 404 || status === 405) return 'OpenRouter did not accept the connection code. Connect again.';
  if (status === 429) return 'OpenRouter is rate limiting this address. Wait a minute and connect again.';
  return `OpenRouter did not answer (HTTP ${status}). Connect again in a minute.`;
}

/**
 * Finishes Connect when the page loads with ?code= from OpenRouter: exchanges
 * the code for the user's key, straight from this tab, and removes the code
 * from the address bar. Resolves true when a key was received.
 *
 * @returns {Promise<boolean>}
 */
export async function resumeOpenRouter() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const pending = readSession(PKCE_KEY);
  if (!code || !pending || typeof pending.verifier !== 'string') return false;

  removeSession(PKCE_KEY);
  params.delete('code');
  const query = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}#workspace`);

  view.set({ via: 'connect' });
  commit();
  paint();

  if (Date.now() - Number(pending.at) > CODE_LIFETIME_MS) {
    markInvalid('connect', 'The connection code expired. Connect again.');
    return false;
  }

  say('Finishing the OpenRouter connection.', { hold: true });
  let key = '';
  try {
    const response = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: 'S256' }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      say('');
      markInvalid('connect', exchangeFailure(response.status));
      return false;
    }
    const body = await response.json();
    key = typeof body?.key === 'string' ? body.key : '';
  } catch {
    say('');
    markInvalid('connect', 'OpenRouter could not be reached. Check the connection and connect again.');
    return false;
  }
  if (key.length < 8) {
    say('');
    markInvalid('connect', 'OpenRouter answered without a key. Connect again.');
    return false;
  }

  connected = key;
  if (pending.keep) writeSession(KEPT_KEY, key);
  paint();
  say('OpenRouter connected. Reviews are billed to your OpenRouter credits.', { tone: 'success' });
  return true;
}

function disconnect() {
  connected = '';
  removeSession(KEPT_KEY);
  paint();
  say('Disconnected. The key is gone from this tab. Delete it at openrouter.ai/settings/keys to end it everywhere.', { hold: true });
  qs('#wb-or-connect')?.focus();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Wires the provider rows of the Run step. Call after initWorkbench(). */
export function initProviders() {
  const select = qs('#wb-provider');
  if (!qs('#wb-via') || !select) return;

  clear(select).append(...PROVIDERS.map((entry) => el('option', { value: entry.id, text: entry.label })));

  const kept = readSession(KEPT_KEY);
  if (typeof kept === 'string' && kept.length >= 8) {
    connected = kept;
    const keep = qs('#wb-or-keep');
    if (keep) keep.checked = true;
  }

  // The stored provider and model win over the stored "Run with" choice.
  const state = workbench.get();
  const start = reconcileVia(state.provider, view.get().via, view.get().keyProvider);
  view.set(start);
  if (state.provider !== EXPORT_PROVIDER && state.model) models.set(activeProviderId(), state.model);

  on(qs('#wb-via'), 'change', 'input[name="wb-via"]', (event, radio) => setVia(radio.value));
  on(select, 'change', () => {
    clearInvalid();
    view.set({ keyProvider: select.value });
    commit();
    paint();
  });
  on(qs('#wb-model'), 'input', (event) => {
    event.target.removeAttribute('aria-invalid');
    models.set(activeProviderId(), event.target.value);
    paintModelHelp(activeProviderId());
    commit();
  });
  on(qs('#wb-key'), 'input', (event) => {
    event.target.removeAttribute('aria-invalid');
    const error = qs('#wb-key-error');
    if (error) error.hidden = true;
    keys.set(activeProviderId(), event.target.value);
    paintKeyHint();
  });
  on(qs('#wb-key-forget'), 'click', () => {
    const id = activeProviderId();
    const had = Boolean(keys.get(id));
    keys.delete(id);
    clearInvalid();
    paint();
    say(had ? 'Key forgotten.' : 'No key is held for this provider.');
    qs('#wb-key')?.focus();
  });
  on(qs('#wb-or-connect'), 'click', startConnect);
  on(qs('#wb-or-disconnect'), 'click', disconnect);

  // The chat-subscription rows depend on the profile: a hosted one has no prompt to export.
  workbench.select((current) => current.profile, () => {
    if (view.get().via === 'export') paintExport();
  });

  // A provider set from outside (a restored tab, a handoff) moves the controls with it.
  workbench.select((current) => current.provider, (provider) => {
    if (provider === activeProviderId()) return;
    view.set(reconcileVia(provider, view.get().via, view.get().keyProvider));
    paint();
  });

  commit();
  paint();
}
