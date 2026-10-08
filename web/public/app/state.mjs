/**
 * Workbench state: one observable store, what of it survives a reload, and the
 * handoff other pages leave for the workbench.
 *
 * Imports the engine for its limits and ids. Touches no DOM.
 *
 * Exports
 *   STEPS                         ['files', 'review', 'results']
 *   MODES                         ['bounty', 'own-code']
 *   EXPORT_PROVIDER               'export'  the UI-only "export the prompt" choice
 *   STORAGE_KEYS                  { workbench: 'bo:workbench', handoff: 'bo:handoff' }
 *
 *   initialState(overrides?)      -> WorkbenchState   a fresh default state
 *   createStore(initial)          -> Store            `initial` is an object or a function returning one
 *   workbench                     Store<WorkbenchState>   the one the workbench modules share
 *   shallowEqual(a, b)            -> boolean          for select() over arrays and plain objects
 *
 *   readSession(key)              -> any | null       JSON from sessionStorage; never throws
 *   writeSession(key, value)      -> boolean          refuses keys, tokens and other credentials
 *   removeSession(key)            -> void
 *
 *   snapshot(state)               -> object           the part of the state that is stored
 *   saveWorkbench(state?)         -> boolean
 *   loadWorkbench()               -> Partial<WorkbenchState> | null   validated
 *   persistWorkbench(store?, { delay }?) -> stop()    saves after each change, debounced
 *
 *   parseHandoff(raw)             -> Handoff | null   validate a handoff (JSON text or object)
 *   takeHandoff()                 -> Handoff | null   read sessionStorage["bo:handoff"] once and remove it
 *
 * Store
 *   store.get()                           the current state, frozen at the top level
 *   store.set(patch)                      shallow merge; `patch` is an object or (state) => object.
 *                                         Listeners run only when a value changed (Object.is).
 *   store.subscribe(fn, { immediate }?)   fn(state, previous) -> unsubscribe()
 *   store.select(pick, fn, { immediate, equal }?)
 *                                         fn(value, previousValue) when pick(state) changes -> unsubscribe()
 *   store.reset(overrides?)               back to the initial state
 *
 *   Replace arrays and objects; never mutate them in place:
 *     workbench.set((state) => ({ files: [...state.files, file] }));
 *     workbench.select((state) => state.busy, (busy) => setBusy(runButton, busy));
 *
 * What is stored, and what never is
 *   snapshot() keeps files, focus, context, profile, mode, provider, model,
 *   step and result. `busy` is not stored. API keys, GitHub tokens, connection
 *   tokens, recovery codes and CSRF tokens are never part of the state, and
 *   writeSession() refuses any object that has a property named like one.
 *   Keep them in a module variable and clear them after use.
 *
 * Handoff
 *   Other pages write sessionStorage["bo:handoff"] =
 *   JSON { files: [{ name, content }], profile, focus, context } and open
 *   /#workspace. On load the workbench does:
 *
 *     const handoff = takeHandoff();
 *     if (handoff) workbench.set({ ...initialState(), files: handoff.files, profile: handoff.profile,
 *                                  focus: handoff.focus, context: handoff.context });
 *     else { const saved = loadWorkbench(); if (saved) workbench.set(saved); }
 *
 *   A file the engine would refuse (name, size, count, not text) is left out
 *   and listed in `handoff.skipped` as { name, reason }.
 *
 * @typedef {{ name: string, content: string }} InputFile
 *
 * @typedef {object} WorkbenchResult   what `result` holds once a review exists
 * @property {string} review
 * @property {{ label: string, bytes: number, sha256: string, lines: number }[]} manifest
 * @property {{ id: string, name: string }} [profile]
 * @property {'bounty' | 'own-code'} [mode]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {boolean} [truncated]
 * @property {boolean} [refused]
 * @property {'anthropic-cyber' | 'openai-cyber' | 'policy'} [blocked]  the provider blocked the review under its usage policy; see ./blocked.mjs
 * @property {{ input: number | null, output: number | null }} [usage]
 * @property {'ai' | 'pasted' | 'example' | 'panel' | 'gauntlet'} [source]
 * @property {string} [timestamp]      ISO 8601
 * @property {object[]} [stages]       gauntlet and panel runs
 *
 * @typedef {object} WorkbenchState
 * @property {InputFile[]} files
 * @property {string} focus            the request text; empty uses the profile's default
 * @property {Record<string, string>} context   target, scope, version, proof, prior, notes, rules, and any further text field
 * @property {string} profile          profile id
 * @property {'bounty' | 'own-code'} mode
 * @property {string} provider         a provider id, or 'export'
 * @property {string} model            empty uses the provider's default
 * @property {'files' | 'review' | 'results'} step
 * @property {WorkbenchResult | null} result
 * @property {boolean} busy
 *
 * @typedef {object} Handoff
 * @property {InputFile[]} files
 * @property {string} profile          a listed profile id; 'general' when the handoff named none
 * @property {string} focus
 * @property {Record<string, string>} context   complete, with defaults filled in
 * @property {{ name: string, reason: string }[]} skipped
 *
 * @template T
 * @typedef {object} Store
 * @property {() => Readonly<T>} get
 * @property {(patch: Partial<T> | ((state: Readonly<T>) => Partial<T> | null | undefined)) => Readonly<T>} set
 * @property {(listener: (state: Readonly<T>, previous: Readonly<T>) => void, options?: { immediate?: boolean }) => () => void} subscribe
 * @property {<V>(pick: (state: Readonly<T>) => V, listener: (value: V, previous: V) => void, options?: { immediate?: boolean, equal?: (a: V, b: V) => boolean }) => () => void} select
 * @property {(overrides?: Partial<T>) => Readonly<T>} reset
 */

import { reviewProfile } from '../profiles.mjs';
import { PROVIDERS } from '../providers.mjs';
import { LIMITS, textBytes, validName } from '../review-core.mjs';

export const STEPS = Object.freeze(['files', 'review', 'results']);
export const MODES = Object.freeze(['bounty', 'own-code']);
export const EXPORT_PROVIDER = 'export';
export const STORAGE_KEYS = Object.freeze({ workbench: 'bo:workbench', handoff: 'bo:handoff' });

const PROOFS = ['none', 'local', 'deployment'];
const PRIORS = ['unchecked', 'searched', 'overlap', 'distinct'];
const CLONE_DEPTHS = ['full', 'shallow'];
const CONTEXT_FIELD = /^[a-z][A-Za-z0-9]{0,31}$/;
const CONTEXT_FIELD_CHARS = 16000;
const CONTEXT_FIELDS_MAX = 32;
const OBJECT_MEMBERS = new Set(['constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const MODEL_ID = /^[\x21-\x7e]{1,200}$/;
// How provider keys and this site's own tokens start. A model id never does.
const KEY_SHAPED = /^(?:sk-|sk_|bok_|gsk_|xai-|AIza|ghp_|gho_|github_pat_|Bearer\s)/;
const SNAPSHOT_VERSION = 1;
const HANDOFF_CHARS = 2000000;
const RESULT_CHARS = 4000000;

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

function emptyContext() {
  return { target: '', scope: '', version: '', proof: 'none', prior: 'unchecked', notes: '', rules: '' };
}

/**
 * A fresh default state. Every call returns new arrays and objects.
 *
 * @param {Partial<WorkbenchState>} [overrides]
 * @returns {WorkbenchState}
 */
export function initialState(overrides = {}) {
  return {
    files: [],
    focus: '',
    context: emptyContext(),
    profile: 'general',
    mode: 'bounty',
    provider: PROVIDERS[0].id,
    model: '',
    step: 'files',
    result: null,
    busy: false,
    ...overrides,
  };
}

/**
 * True when two arrays, or two plain objects, hold the same values (Object.is)
 * under the same keys. Anything else is compared with Object.is.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]));
}

function report(error) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
  else console.error(error);
}

/**
 * A tiny observable store. See "Store" at the top of this file.
 *
 * @template {Record<string, unknown>} T
 * @param {T | (() => T)} initial  A function is called for a fresh state on creation and on every reset.
 * @returns {Store<T>}
 */
export function createStore(initial) {
  const fresh = () => Object.freeze({ ...(typeof initial === 'function' ? initial() : initial) });
  let state = fresh();
  let delivered = state;
  let notifying = false;
  const listeners = new Set();

  // A set() made by a listener is delivered after the current round, so every
  // listener sees the states in the order they happened.
  function flush() {
    if (notifying) return;
    notifying = true;
    try {
      for (let rounds = 0; delivered !== state; rounds += 1) {
        if (rounds > 100) throw new Error('A store listener keeps changing the state it listens to.');
        const previous = delivered;
        const current = state;
        delivered = current;
        for (const listener of [...listeners]) {
          try {
            listener(current, previous);
          } catch (error) {
            report(error);
          }
        }
      }
    } finally {
      notifying = false;
    }
  }

  function replace(next) {
    state = Object.freeze(next);
    flush();
    return state;
  }

  function get() {
    return state;
  }

  function set(patch) {
    const change = typeof patch === 'function' ? patch(state) : patch;
    if (!change || typeof change !== 'object') return state;
    const changed = Object.keys(change).some((key) => !Object.is(state[key], change[key]));
    return changed ? replace({ ...state, ...change }) : state;
  }

  function subscribe(listener, { immediate = false } = {}) {
    listeners.add(listener);
    if (immediate) listener(state, state);
    return () => listeners.delete(listener);
  }

  function select(pick, listener, { immediate = false, equal = Object.is } = {}) {
    let value = pick(state);
    if (immediate) listener(value, value);
    return subscribe((current) => {
      const next = pick(current);
      if (equal(next, value)) return;
      const previous = value;
      value = next;
      listener(next, previous);
    });
  }

  function reset(overrides = {}) {
    return replace({ ...fresh(), ...overrides });
  }

  return { get, set, subscribe, select, reset };
}

/** The store the workbench modules share. @type {Store<WorkbenchState>} */
export const workbench = createStore(initialState);

// ---------------------------------------------------------------------------
// sessionStorage
// ---------------------------------------------------------------------------

function sessionStore() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // Reading the property throws when storage is blocked.
    return null;
  }
}

const SECRET_NAMES = new Set([
  'key', 'apikey', 'providerkey', 'privatekey', 'secret', 'clientsecret', 'token', 'accesstoken', 'githubtoken',
  'connectiontoken', 'sessiontoken', 'csrf', 'csrftoken', 'password', 'passphrase', 'authorization', 'bearer',
  'recovery', 'recoverycode', 'mnemonic', 'seedphrase',
]);

function isSecretName(name) {
  return SECRET_NAMES.has(String(name).toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/** The path of the first property named like a credential, or '' when there is none. */
function secretPath(value, path = '', depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return '';
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (!Array.isArray(value) && isSecretName(key)) return here;
    const found = secretPath(child, here, depth + 1);
    if (found) return found;
  }
  return '';
}

/**
 * The JSON value stored under `key` in sessionStorage, or null when there is
 * none, it does not parse, or storage is blocked.
 *
 * @param {string} key
 * @returns {any}
 */
export function readSession(key) {
  try {
    const raw = sessionStore()?.getItem(key);
    return raw === null || raw === undefined ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Stores `value` as JSON under `key` in sessionStorage. Returns false when
 * storage is blocked or full, and when `value` has a property named like a
 * credential (apiKey, token, secret, password, csrf, recoveryCode, …): those
 * stay in memory.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
export function writeSession(key, value) {
  const secret = secretPath(value);
  if (secret) {
    console.error(`writeSession("${key}") refused: "${secret}" is named like a credential. Keys and tokens stay in memory.`);
    return false;
  }
  try {
    const store = sessionStore();
    if (!store) return false;
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} key
 * @returns {void}
 */
export function removeSession(key) {
  try {
    sessionStore()?.removeItem(key);
  } catch {
    // Storage is blocked: there is nothing to remove.
  }
}

// ---------------------------------------------------------------------------
// Validation shared by the stored state and the handoff
// ---------------------------------------------------------------------------

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function kilobytes(bytes) {
  return `${Math.round(bytes / 1000)} KB`;
}

/** Keeps the files the engine accepts; lists the rest with the reason. */
function cleanFiles(value) {
  const files = [];
  const skipped = [];
  if (!Array.isArray(value)) return { files, skipped };

  let total = 0;
  value.forEach((entry, index) => {
    const name = isRecord(entry) && typeof entry.name === 'string' && validName(entry.name) ? entry.name : '';
    const shown = name || `file ${index + 1}`;
    if (!name) {
      skipped.push({ name: shown, reason: 'The file name is not supported.' });
      return;
    }
    let bytes;
    try {
      bytes = textBytes(entry.content);
    } catch {
      skipped.push({ name: shown, reason: 'The file is not UTF-8 text.' });
      return;
    }
    if (bytes > LIMITS.fileBytes) {
      skipped.push({ name: shown, reason: `Over the ${kilobytes(LIMITS.fileBytes)} file limit.` });
    } else if (files.length >= LIMITS.files) {
      skipped.push({ name: shown, reason: `Over the ${LIMITS.files}-file limit.` });
    } else if (total + bytes > LIMITS.totalBytes) {
      skipped.push({ name: shown, reason: `Over the ${kilobytes(LIMITS.totalBytes)} total limit.` });
    } else {
      total += bytes;
      files.push({ name, content: entry.content });
    }
  });
  return { files, skipped };
}

/** A complete Context: known options checked, text fields kept, everything else dropped. */
function cleanContext(value) {
  const context = emptyContext();
  if (!isRecord(value)) return context;

  let kept = 0;
  for (const [field, text] of Object.entries(value)) {
    if (typeof text !== 'string' || !CONTEXT_FIELD.test(field) || OBJECT_MEMBERS.has(field) || isSecretName(field)) continue;
    if (field === 'proof') {
      if (PROOFS.includes(text)) context.proof = text;
    } else if (field === 'prior') {
      if (PRIORS.includes(text)) context.prior = text;
    } else if (field === 'cloneDepth') {
      if (CLONE_DEPTHS.includes(text)) context.cloneDepth = text;
    } else if (kept < CONTEXT_FIELDS_MAX) {
      kept += 1;
      context[field] = text.slice(0, CONTEXT_FIELD_CHARS);
    }
  }
  return context;
}

/** The id of a profile the workbench lists, or 'general'. */
function cleanProfile(value) {
  try {
    const profile = reviewProfile(typeof value === 'string' && value ? value : 'general');
    return profile.listed ? profile.id : 'general';
  } catch {
    return 'general';
  }
}

function cleanFocus(value) {
  return typeof value === 'string' ? value.slice(0, LIMITS.promptChars) : '';
}

function cleanProvider(value) {
  if (value === EXPORT_PROVIDER) return EXPORT_PROVIDER;
  return PROVIDERS.some((provider) => provider.id === value) ? value : PROVIDERS[0].id;
}

function cleanModel(value) {
  return typeof value === 'string' && MODEL_ID.test(value) && !KEY_SHAPED.test(value) ? value : '';
}

function cleanResult(value) {
  if (!isRecord(value) || typeof value.review !== 'string' || value.review.length > RESULT_CHARS) return null;
  if (value.manifest !== undefined && !Array.isArray(value.manifest)) return null;
  return secretPath(value) ? null : value;
}

// ---------------------------------------------------------------------------
// The stored workbench
// ---------------------------------------------------------------------------

/**
 * The part of a state that is stored: files, focus, context, profile, mode,
 * provider, model, step and result. Nothing else is copied, so a key or token
 * placed on the state by mistake does not reach storage.
 *
 * @param {WorkbenchState} state
 * @returns {object}
 */
export function snapshot(state) {
  const { files } = cleanFiles(state.files);
  const result = cleanResult(state.result);
  return {
    v: SNAPSHOT_VERSION,
    files,
    focus: cleanFocus(state.focus),
    context: cleanContext(state.context),
    profile: cleanProfile(state.profile),
    mode: MODES.includes(state.mode) ? state.mode : MODES[0],
    provider: cleanProvider(state.provider),
    model: cleanModel(state.model),
    step: STEPS.includes(state.step) && (state.step !== 'results' || result) ? state.step : STEPS[0],
    result,
  };
}

/**
 * Stores the workbench for this tab. When storage is short of room the result
 * is left out, then the files.
 *
 * @param {WorkbenchState} [state]  Defaults to the shared store's state.
 * @returns {boolean} Whether anything was stored.
 */
export function saveWorkbench(state = workbench.get()) {
  const full = snapshot(state);
  if (writeSession(STORAGE_KEYS.workbench, full)) return true;
  const withoutResult = { ...full, result: null, step: full.step === 'results' ? STEPS[0] : full.step };
  if (writeSession(STORAGE_KEYS.workbench, withoutResult)) return true;
  return writeSession(STORAGE_KEYS.workbench, { ...withoutResult, files: [] });
}

/**
 * The stored workbench, checked field by field, ready for `workbench.set()`.
 * Null when nothing usable is stored. `busy` is never part of it.
 *
 * @returns {Partial<WorkbenchState> | null}
 */
export function loadWorkbench() {
  const stored = readSession(STORAGE_KEYS.workbench);
  if (!isRecord(stored) || stored.v !== SNAPSHOT_VERSION) return null;
  const { v, ...state } = snapshot({ ...initialState(), ...stored });
  return state;
}

const STORED_FIELDS = ['files', 'focus', 'context', 'profile', 'mode', 'provider', 'model', 'step', 'result'];

/**
 * Saves the store after each change to a stored field, at most once per
 * `delay` milliseconds, and once more when the page is hidden.
 *
 * @param {Store<WorkbenchState>} [store]
 * @param {{ delay?: number }} [options]
 * @returns {() => void} stop
 */
export function persistWorkbench(store = workbench, { delay = 400 } = {}) {
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = null;
    saveWorkbench(store.get());
  };
  const flush = () => {
    if (timer !== null) save();
  };
  const unsubscribe = store.subscribe((state, previous) => {
    if (STORED_FIELDS.every((field) => Object.is(state[field], previous[field]))) return;
    if (timer === null) timer = setTimeout(save, delay);
  });

  const page = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
  page?.addEventListener('pagehide', flush);
  return () => {
    unsubscribe();
    flush();
    page?.removeEventListener('pagehide', flush);
  };
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

/**
 * Validates a handoff. `raw` is the JSON text from storage, or the object
 * itself. Returns null when it is not a JSON object.
 *
 * The result is safe to put in the store: files the engine would refuse are
 * moved to `skipped`, an unknown or unlisted profile becomes 'general', the
 * focus is cut to the instruction limit, and the context is complete.
 *
 * @param {unknown} raw
 * @returns {Handoff | null}
 */
export function parseHandoff(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.length > HANDOFF_CHARS) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;

  const { files, skipped } = cleanFiles(value.files);
  return {
    files,
    profile: cleanProfile(value.profile),
    focus: cleanFocus(value.focus),
    context: cleanContext(value.context),
    skipped,
  };
}

/**
 * Reads the handoff another page left in sessionStorage["bo:handoff"] and
 * removes it, so a reload does not apply it twice. Null when there is none.
 *
 * @returns {Handoff | null}
 */
export function takeHandoff() {
  let raw = null;
  try {
    raw = sessionStore()?.getItem(STORAGE_KEYS.handoff) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  removeSession(STORAGE_KEYS.handoff);
  return parseHandoff(raw);
}
