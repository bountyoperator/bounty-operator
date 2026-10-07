#!/usr/bin/env node
// Bounty Operator product lift: do the product's review instructions make a model better or
// worse at the benchmark's task when the model is called the way the product calls it?
//   node bench/tools/product-lift.mjs [--set scored|public|all] [--cases <glob>] [--models a,b,c]
//                                     [--arms raw,product] [--max-usd X] [--concurrency N] [--per-model N]
//                                     [--est-out auto|N] [--order cost|given] [--out-dir <dir>] [--run <name>]
//                                     [--key-file <file>] [--redo-infra] [--dry-run] [--dump <dir>]
//   node bench/tools/product-lift.mjs --report   [--out-dir <dir>] [--run <name>] [--set ...] [--models ...]
//   node bench/tools/product-lift.mjs --manifest [--out-dir <dir>]
//
// What it measures. Paydirt's profile lift (METHOD.md, "Profile lift") is measured in the omp
// agent harness at maximum reasoning effort, with the product's text appended to a tool-using
// agent's system prompt. The product does not call models that way. The web app, the hosted
// review and MCP run_review build two messages with web/public/review-core.mjs (every file
// inline, line-numbered, under an input-N label) and send them ONCE through
// web/public/providers.mjs: that module's output allowance (outputTokenLimit), its headers, no
// temperature and no reasoning setting. This tool measures the product's effect in that setting.
//
// The two arms, per model x pair x twin, one request each, no tools:
//   raw      the difficulty probe's request (tools/probe.mjs buildProbePrompt): its single-shot
//            stand-in for prompts/system.txt (the same rules, the files pasted instead of read,
//            because a single request has no read/grep/glob), then every workspace file with
//            line numbers, then the raw-arm task and the answer sheet.
//   product  the two messages the Worker prepares for the matching core profile (review.ts
//            prepare(): checkInputs, then prepareReview with that coverage; find-sol -> solidity,
//            find-ts -> general, challenge -> report), for a request with no text of its own (the
//            profile's default focus), no Context fields and Mode bounty, as the benchmark's
//            profile arm prepares it. Files go in the order the product asks for: the draft first
//            for a report review, then the sources, then the programme papers; sources by path.
//            Appended to the end of the user message: BRIDGE (one paragraph: finish the review in
//            the product's format, then end with the answer sheet, files named by path without
//            the input-N/ label) and the answer sheet, word for word as the raw arm has it.
// Both arms are sent with providers.mjs providerStream({ provider: 'openrouter', model }), the
// streaming call the web app and MCP run_review use, so the body (model, messages, max_tokens,
// stream), the headers and the timeouts are the product's own and the same in both arms. The
// only difference between the arms is the instructions. A recording wrapper around fetch keeps
// the exact request body and the raw response; it changes nothing that is sent.
//
// Scoring. Each answer is read with bench/lib/parse.mjs extractSheet and scored with
// bench/lib/score.mjs scoreInput, unchanged. A finding whose file is cited as `input-N/<path>`
// (the product's label) has that prefix removed here before scoring. The scorer's own normPath
// strips the same prefix, so this changes no outcome; each record counts how often it happened
// (input_labels_stripped). Failures make the input wrong, as in the benchmark: truncated
// (finish_reason length), refused (the product's refused flag, finish_reason content_filter or
// native finish refusal), error (the product's call threw, or the stream ended in an error or
// without a finish reason), unparseable or empty (no answer sheet). A truncated answer is
// wrong even when a sheet can be read from it; that is recorded as sheet_in_truncated.
//
// Retries. None, except for an attempt that failed with HTTP 429 or 5xx, an in-band 429 or
// 5xx, a network error, a stalled connection or a stream that closed before ANY output (no
// content, no reasoning, no output tokens): up to 2 more attempts, each recorded under
// `attempts`. An attempt that produced output is never sent again: no answer is rerolled. A
// call the provider refuses for the account (HTTP 402 no credit, 401 or 403) is no answer of
// the model's: it is kept as <case>.<arm>.unrun-*.json, the run stops, and a later invocation
// makes the call. A model the provider does not serve (404) is dropped for the invocation.
//
// Budget. Prices come from the OpenRouter models API when the run is planned and are stored
// with every call. Each attempt's cost (usage.cost as the stream reports it, else the
// generation record's total_cost, else tokens at the stored prices, else the call's whole
// reservation when output started and no cost was reported) is appended to
// <out-dir>/ledger.jsonl, and --max-usd caps the whole ledger: every invocation, the smoke test
// included. A real run is refused when recorded spend plus the estimate of the calls still to
// make exceeds --max-usd. While it runs, a call starts only while recorded spend + in-flight
// reservations (each the call's worst case: the prompt at 2.5 characters a token plus the
// whole output allowance) + its own reservation stay within --max-usd, and a model starts only
// when its calls and every queued call before them still fit at the estimate. Models run
// cheapest first, so the expensive end is what gets dropped. The key's own usage (GET /key) is
// read at the start and every 20 calls; the gates use the larger of it and the ledger.
//
// Estimate. Input: the prepared messages' characters / 3 (conservative for code and Markdown).
// Output: --est-out N (capped at the model's allowance), or `auto`: 1.25 x the 90th percentile
// of the output tokens this model and arm used in stored answers when there are at least 6,
// else 10,000 capped at the allowance.
//
// Storage. Everything goes under --out-dir (default .local/build/product-lift-<today>). It holds
// HELD cases and must never be published. Per call: the exact request body, the headers with the
// key redacted, every attempt's raw response (gzip), the answer text and a record. --report
// writes summary.json and summary.md from the records; --manifest writes MANIFEST.sha256.
//
// Node 22+ built-ins only. The OpenRouter key is read from --key-file (default
// .local/benchmark.env) and is never printed or stored. `--dry-run` needs no key and spends
// nothing.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DRAFT, FAMILIES, isSupportingDoc, loadCases, pairsOf } from '../lib/cases.mjs';
import { readPrompt } from '../lib/arms.mjs';
import { extractSheet } from '../lib/parse.mjs';
import { DEFAULT_SCORING, scoreInput } from '../lib/score.mjs';
import { envFilePath, fetchModels, generationStats, keyStatus, readKey, redact } from '../lib/openrouter.mjs';
import { median, pairedBootstrap, quantileSorted, round } from '../lib/stats.mjs';
import { buildProbePrompt } from './probe.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(BENCH, '..');
const ENGINE_DIR = path.join(REPO, 'web', 'public');
export const ENGINE_FILES = ['web/public/review-core.mjs', 'web/public/profiles.mjs', 'web/public/evidence.mjs', 'web/public/parse.mjs', 'web/public/providers.mjs'];

export const SCHEMA = 'bounty-operator.product-lift/1';
export const PROVIDER_ID = 'openrouter';
export const ARMS = Object.freeze(['raw', 'product']);
export const LIFT_DEFAULTS = Object.freeze({ maxUsd: 35, concurrency: 4, perModel: 4, retries: 2, backoffMs: [10000, 45000], estOut: 10000, estMinSamples: 6, charsPerToken: 3, reserveCharsPerToken: 2.5, keyPollEvery: 20, drainWaitMs: 120000 });

/**
 * The one paragraph appended to the product's user message, before the answer sheet. It asks
 * for the review the product asks for, then the benchmark's answer sheet, and says how the
 * sheet names files. Nothing else is added to the product's messages.
 */
export const BRIDGE = 'Write the review in the format above, starting at "# Review". After its last section, end your reply with the answer sheet below. In the answer sheet the workspace is the set of supplied files, and each file is named by its path without the input-N/ label: input-1/src/A.sol is src/A.sol.';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (line = '') => process.stdout.write(`${line}\n`);
const modelDir = (slug) => slug.replace(/[^A-Za-z0-9._-]+/g, '__');
const today = () => new Date().toISOString().slice(0, 10);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
    else { flags[a.slice(2)] = next; i++; }
  }
  return flags;
}

let engine = null;
/** The product's own modules, loaded from web/public of this checkout. */
export async function productEngine(dir = ENGINE_DIR) {
  engine ??= Promise.all([import(pathToFileURL(path.join(dir, 'review-core.mjs')).href), import(pathToFileURL(path.join(dir, 'providers.mjs')).href)])
    .then(([core, providers]) => ({ core, providers }));
  return engine;
}

/** sha256 of each product file the product arm depends on (LF-normalised, as protocol.json records engine files). */
export function engineHashes(repoRoot = REPO) {
  return Object.fromEntries(ENGINE_FILES.map((rel) => { try { return [rel, sha256(fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n?/g, '\n'))]; } catch { return [rel, null]; } }));
}

// ---------------------------------------------------------------- the two requests

/** The files of a case in the order the product takes them: the draft, the sources, then the papers. */
export function productFiles(kase) {
  const rank = (f) => (f.path === DRAFT ? 0 : isSupportingDoc(kase.family, f.path) ? 2 : 1);
  return [...kase.workspace].filter((f) => f.text !== null)
    .sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ name: f.path, content: f.text }));
}

/** The raw arm: exactly the probe's two messages. */
export function buildRawRequest(kase, benchDir = BENCH) {
  const p = buildProbePrompt(kase, benchDir);
  return { arm: 'raw', system: p.system, user: p.user };
}

/**
 * The product arm: the Worker's prepared messages for the case's core profile, the bridge and
 * the answer sheet. When the product's privacy check blocks the files, the product would send
 * nothing; the request is then `{ blocked: true }` and is never sent.
 */
export async function buildProductRequest(kase, { benchDir = BENCH, engineDir = ENGINE_DIR } = {}) {
  const { core } = await productEngine(engineDir);
  const profileId = FAMILIES[kase.family]?.profile;
  if (!profileId) throw new Error(`${kase.id}: family ${kase.family} has no core profile`);
  const files = productFiles(kase);
  const coverage = core.checkInputs(files, '', undefined);
  const privacy = { blocking: coverage.blocking, warnings: coverage.warnings, kinds: [...new Set(coverage.findings.map((f) => f.kind))] };
  let prepared;
  try {
    // review.ts prepare(): the request text is empty, so the profile's default focus is the Request
    prepared = await core.prepareReview(files, '', profileId, { acknowledgeWarnings: true, mode: 'bounty', coverage });
  } catch (error) {
    if (error?.code === 'privacy_block') return { arm: 'product', blocked: true, profile: profileId, privacy };
    throw error;
  }
  const [system, user] = prepared.messages;
  const sheet = readPrompt('answer-sheet.md', benchDir).trim();
  return {
    arm: 'product', system: system.content, user: `${user.content}\n\n${BRIDGE}\n\n${sheet}\n`,
    profile: prepared.profile.id, mode: prepared.mode, labels: prepared.manifest.map((m) => m.label), privacy,
  };
}

// ---------------------------------------------------------------- recording the product's call

const taps = new AsyncLocalStorage();

/** Keep the key out of anything stored: the Authorization header is replaced, never copied. */
function shownHeaders(headers) {
  const entries = headers instanceof Headers ? [...headers] : Object.entries(headers ?? {});
  return Object.fromEntries(entries.map(([k, v]) => [k, /^(authorization|x-api-key|api-key)$/i.test(k) ? '[REDACTED]' : String(v)]));
}

/** Read a body to the end, keeping what arrived when it fails. `cancel()` stops it. */
function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0, error = null;
  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (e) { error = String(e?.message ?? e).slice(0, 300); }
    return { text, bytes, error };
  })();
  return { done, cancel: () => reader.cancel().catch(() => {}) };
}

/**
 * A fetch that records what the product sends and receives while a tap is active, and is the
 * underlying fetch otherwise. The response handed to the product is the provider's own; the
 * record reads a clone of it.
 */
export function recordingFetch(underlying) {
  return async function fetchAndRecord(input, init = {}) {
    const tap = taps.getStore();
    if (!tap) return underlying(input, init);
    const entry = {
      url: typeof input === 'string' ? input : String(input?.url ?? input), method: init.method ?? 'GET',
      headers: shownHeaders(init.headers), body: typeof init.body === 'string' ? init.body : null,
      status: null, response_headers: null, raw: null, error: null,
    };
    tap.requests.push(entry);
    let response;
    try { response = await underlying(input, init); }
    catch (error) { entry.error = String(error?.message ?? error).slice(0, 300); throw error; }
    entry.status = response.status;
    entry.response_headers = Object.fromEntries([...response.headers].filter(([k]) => k.toLowerCase() !== 'set-cookie'));
    entry.raw = response.body ? drain(response.clone().body) : null;
    return response;
  };
}

/**
 * One call through the product's providerStream. Never throws.
 * Resolves with { text, done, error, request, raw, wall_ms, first_text_ms }.
 */
export async function productCall({ providers, model, apiKey, system, user, drainWaitMs = LIFT_DEFAULTS.drainWaitMs }) {
  const tap = { requests: [] };
  const started = Date.now();
  const parts = [];
  let done = null, error = null, firstText = null;
  await taps.run(tap, async () => {
    try {
      const events = await providers.providerStream({ provider: PROVIDER_ID, model, apiKey, prepared: { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] } });
      for await (const event of events) {
        if (event.type === 'delta') { parts.push(event.text); firstText ??= Date.now(); }
        else if (event.type === 'done') done = event;
      }
    } catch (e) { error = e; }
  });
  const wall = Date.now() - started;
  const request = tap.requests.at(-1) ?? null;
  let raw = { text: '', bytes: 0, error: null };
  if (request?.raw) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => { request.raw.cancel(); resolve(null); }, drainWaitMs); });
    raw = (await Promise.race([request.raw.done, late])) ?? (await request.raw.done);
    clearTimeout(timer);
  }
  const shown = (e) => (e ? { name: e.name ?? 'Error', kind: e.kind ?? null, status: Number.isInteger(e.status) ? e.status : null, retry_after: e.retryAfter ?? null, message: redact(String(e.message ?? e).slice(0, 500), apiKey) } : null);
  return {
    text: redact(parts.join(''), apiKey), done, error: shown(error), wall_ms: wall, first_text_ms: firstText ? firstText - started : null,
    request: request ? { url: request.url, method: request.method, headers: request.headers, body: request.body, status: request.status, response_headers: request.response_headers, error: request.error } : null,
    raw: { ...raw, text: redact(raw.text, apiKey) },
  };
}

/**
 * The facts of one raw response: an OpenRouter event stream, or a JSON body when the provider
 * answered in one piece or with an error.
 */
export function readStream(raw) {
  const f = { events: 0, bad: 0, comments: 0, done_marker: false, ids: [], provider: null, model: null, finish: null, native_finish: null, usage: null, error: null, content_chars: 0, reasoning_chars: 0, reasoning_details: 0, refusal: false };
  const take = (j) => {
    f.events++;
    if (typeof j.id === 'string' && !f.ids.includes(j.id)) f.ids.push(j.id);
    if (typeof j.provider === 'string') f.provider ??= j.provider;
    if (typeof j.model === 'string') f.model ??= j.model;
    if (j.usage && typeof j.usage === 'object') f.usage = j.usage;
    const err = j.error ?? j.choices?.[0]?.error ?? null;
    if (err) f.error ??= { code: err.code ?? null, message: String(err.message ?? err).slice(0, 500), raw: typeof err.metadata?.raw === 'string' ? err.metadata.raw.slice(0, 300) : null };
    const c = j.choices?.[0];
    if (!c) return;
    const d = c.delta ?? c.message ?? {};
    if (typeof d.content === 'string') f.content_chars += d.content.length;
    if (typeof d.reasoning === 'string') f.reasoning_chars += d.reasoning.length;
    if (Array.isArray(d.reasoning_details)) f.reasoning_details += d.reasoning_details.length;
    if (typeof d.refusal === 'string' && d.refusal) f.refusal = true;
    if (c.finish_reason) f.finish = c.finish_reason;
    if (c.native_finish_reason) f.native_finish = c.native_finish_reason;
  };
  const text = String(raw ?? '');
  if (/^\s*\{/.test(text)) {
    try { take(JSON.parse(text)); return f; } catch { /* not one JSON body: read it as a stream */ }
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(':')) { f.comments++; continue; }
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { f.done_marker = true; continue; }
    if (!data) continue;
    let j;
    try { j = JSON.parse(data); } catch { f.bad++; continue; }
    if (j && typeof j === 'object') take(j);
  }
  return f;
}

const outputStarted = (res, s) => res.text.length > 0 || s.content_chars > 0 || s.reasoning_chars > 0 || s.reasoning_details > 0 || Number(s.usage?.completion_tokens) > 0;
const infraCode = (code) => { const n = Number(code); return Number.isInteger(n) && (n === 408 || n === 429 || n >= 500); };

/**
 * What one attempt came to: { failure, retryable, before_output, reason }.
 * failure: null (an answer to score), 'truncated', 'refused' or 'error'.
 */
export function classify(res, s) {
  const started = outputStarted(res, s);
  if (res.error) {
    const e = res.error;
    if (s.finish === 'length') return { failure: 'truncated', retryable: false, before_output: !started, reason: 'output allowance used before any answer text' };
    if (s.finish === 'content_filter' || s.native_finish === 'refusal' || s.refusal) return { failure: 'refused', retryable: false, before_output: !started, reason: e.message };
    // the stream ended normally and held no answer text: an empty answer, not a provider fault
    if (/did not return a text review/i.test(e.message) && s.finish && s.finish !== 'error') return { failure: 'empty', retryable: false, before_output: !started, reason: e.message };
    const infra = (e.status !== null && (e.status === 429 || e.status >= 500)) || ['rate', 'server', 'network', 'timeout'].includes(e.kind)
      || (e.kind === 'response' && (infraCode(s.error?.code) || /closed the stream before/i.test(e.message)));
    return { failure: 'error', retryable: infra && !started, before_output: !started, reason: e.message };
  }
  if (res.done?.refused || s.finish === 'content_filter' || s.native_finish === 'refusal' || s.refusal) return { failure: 'refused', retryable: false, before_output: !started, reason: 'refused' };
  if (s.finish === 'length') return { failure: 'truncated', retryable: false, before_output: false, reason: 'finish_reason length' };
  if (res.done?.truncated || !res.done) return { failure: 'error', retryable: false, before_output: !started, reason: s.finish === 'error' ? `stream ended in an error${s.error ? `: ${s.error.message}` : ''}` : 'stream ended without a finish reason' };
  return { failure: null, retryable: false, before_output: false, reason: null };
}

// ---------------------------------------------------------------- scoring

/** `input-3/src/A.sol` -> `src/A.sol`; anything else unchanged. */
export function stripInputLabel(file) {
  return String(file ?? '').replace(/^(\s*[`'"]?)(?:\.\/)*input-\d+\//i, '$1');
}

/** Score one answer text with the harness scorer. Returns { outcome, stripped, sheet_ok }. */
export function scoreAnswer(kase, text, { failure = null, scoring = DEFAULT_SCORING } = {}) {
  const draft = kase.workspace.find((f) => f.path === DRAFT)?.text ?? null;
  let sheet = null, stripped = 0;
  if (!failure) {
    sheet = extractSheet(text);
    if (sheet.ok) {
      const findings = sheet.sheet.findings.map((f) => { const file = stripInputLabel(f.file); if (file !== f.file) stripped++; return { ...f, file }; });
      sheet = { ...sheet, sheet: { ...sheet.sheet, findings } };
    }
  }
  const outcome = scoreInput(kase, kase.truth, { failure, sheet, draft, facts: {} }, scoring);
  return { outcome, stripped, sheet_ok: sheet ? sheet.ok : null, sheet_source: sheet?.ok ? sheet.source : null, sheet_repaired: sheet?.ok ? sheet.repaired : null };
}

// ---------------------------------------------------------------- planning and cost

export function readLedger(outDir) {
  let text = '';
  try { text = fs.readFileSync(path.join(outDir, 'ledger.jsonl'), 'utf8'); } catch { return { usd: 0, attempts: 0 }; }
  let usd = 0, attempts = 0;
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { const j = JSON.parse(line); usd += Number(j.usd) || 0; attempts++; } catch { /* a torn line */ } }
  return { usd, attempts };
}

const recordPath = (runDir, model, caseId, arm) => path.join(runDir, 'calls', modelDir(model), `${caseId}.${arm}.json`);

/** Every current record under <run>/calls. */
export function readRecords(runDir) {
  const records = [];
  const root = path.join(runDir, 'calls');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return records; }
  for (const d of dirs) for (const name of fs.readdirSync(path.join(root, d.name))) {
    // <case>.<arm>.json; the request body, superseded records and raw responses have more parts
    if (!/^[A-Za-z0-9_-]+\.(raw|product)\.json$/.test(name)) continue;
    try { const r = JSON.parse(fs.readFileSync(path.join(root, d.name, name), 'utf8')); if (r?.schema === SCHEMA) records.push(r); } catch { /* skip */ }
  }
  return records;
}

/** Output tokens to expect for one call of `model` on `arm`. */
export function estimateOut({ model, arm, allowance, estOut, records }) {
  if (estOut !== 'auto') return Math.min(allowance, Number(estOut));
  const seen = records.filter((r) => r.model === model && r.arm === arm && r.failure !== 'error' && Number.isFinite(r.tokens?.out)).map((r) => r.tokens.out).sort((a, b) => a - b);
  if (seen.length >= LIFT_DEFAULTS.estMinSamples) return Math.min(allowance, Math.ceil(1.25 * quantileSorted(seen, 0.9)));
  return Math.min(allowance, LIFT_DEFAULTS.estOut);
}

/** The jobs of a run, cheapest model first; inside a model pair by pair, both arms of an input next to each other. */
export async function planJobs({ cases, pairs, models, arms, prices, allowances, estOut, records, order = 'cost', benchDir = BENCH, engineDir = ENGINE_DIR }) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const inputs = [];
  for (const p of pairs) {
    const variants = FAMILIES[p.family].variants.filter((v) => p.cases[v]);
    for (const v of variants) inputs.push(byId.get(p.cases[v]));
  }
  const built = new Map();
  for (const kase of inputs) built.set(kase.id, { raw: buildRawRequest(kase, benchDir), product: await buildProductRequest(kase, { benchDir, engineDir }) });
  const jobs = [];
  for (const model of models) {
    const price = prices.get(model), allowance = allowances.get(model);
    inputs.forEach((kase, i) => {
      const pairOrder = i % 2 === 0 ? ['raw', 'product'] : ['product', 'raw'];
      for (const arm of pairOrder.filter((a) => arms.includes(a))) {
        const request = built.get(kase.id)[arm];
        const chars = request.blocked ? 0 : request.system.length + request.user.length;
        const inTokens = Math.ceil(chars / LIFT_DEFAULTS.charsPerToken);
        const outTokens = estimateOut({ model, arm, allowance, estOut, records });
        jobs.push({
          model, arm, kase, request, chars, allowance, price,
          messages_sha256: request.blocked ? null : sha256(`${request.system}\0${request.user}`),
          est_usd: request.blocked ? 0 : (inTokens * price.in + outTokens * price.out) / 1e6,
          reserve_usd: request.blocked ? 0 : (Math.ceil(chars / LIFT_DEFAULTS.reserveCharsPerToken) * price.in + allowance * price.out) / 1e6,
          est_in: inTokens, est_out: outTokens,
        });
      }
    });
  }
  if (order === 'cost') {
    const perCall = new Map(models.map((m) => { const own = jobs.filter((j) => j.model === m); return [m, own.reduce((s, j) => s + j.est_usd, 0) / Math.max(1, own.length)]; }));
    const rank = [...models].sort((a, b) => perCall.get(a) - perCall.get(b) || (a < b ? -1 : 1));
    jobs.sort((a, b) => rank.indexOf(a.model) - rank.indexOf(b.model));
  }
  return { jobs, inputs, built };
}

/** Per model: calls, the estimate, the worst case; in run order with the running total. */
export function estimateTable(jobs, spent = 0) {
  const rows = [];
  for (const j of jobs) {
    let r = rows.find((x) => x.model === j.model);
    if (!r) rows.push(r = { model: j.model, calls: 0, est_usd: 0, worst_usd: 0, est_out: new Set(), allowance: j.allowance, price: j.price });
    r.calls++; r.est_usd += j.est_usd; r.worst_usd += j.reserve_usd; r.est_out.add(j.est_out);
  }
  let total = spent;
  for (const r of rows) { total += r.est_usd; r.cumulative = total; r.est_out = [...r.est_out].sort((a, b) => a - b); }
  return rows;
}

// ---------------------------------------------------------------- running

function writeGz(file, text) { fs.writeFileSync(file, zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 })); }

/** What an attempt cost and where the figure came from. */
async function attemptCost({ s, started, price, reserve, key, genStats }) {
  const u = s.usage;
  if (typeof u?.cost === 'number') return { usd: u.cost, source: 'reported' };
  if (started && key && s.ids[0]) {
    const g = await genStats(key, s.ids[0]).catch(() => null);
    if (typeof g?.total_cost === 'number') return { usd: g.total_cost, source: 'generation', provider: g.provider ?? null };
  }
  if (u && (Number(u.prompt_tokens) > 0 || Number(u.completion_tokens) > 0) && price) return { usd: ((Number(u.prompt_tokens) || 0) * price.in + (Number(u.completion_tokens) || 0) * price.out) / 1e6, source: 'computed' };
  if (!started) return { usd: 0, source: 'none' };
  return { usd: reserve, source: 'reserved' };
}

/** Why a twin is wrong (or 'ok'), in the words of the report. */
export function twinReason(rec) {
  if (!rec) return 'not run';
  if (rec.failure) return rec.failure;
  if (rec.correct) return 'ok';
  if (rec.family === 'challenge') {
    if (rec.variant === 'accurate') return `false rejection of an accurate draft (verdict ${rec.verdict})`;
    return rec.verdict === 'overclaimed' || rec.verdict === 'unsupported' ? `overclaim not caught (verdict ${rec.verdict}, no false statement quoted)` : `overclaim not caught (verdict ${rec.verdict})`;
  }
  return rec.variant === 'fixed' ? 'bite on the fixed twin' : 'miss';
}

/**
 * Run every job that is not stored yet, within the budget.
 *   call(args)  -> productCall-shaped result (injectable for tests)
 * Returns { records, spent_now, stopped, dropped, not_run }.
 */
export async function liftAll({ jobs, runDir, outDir, runName, key, providers, maxUsd, concurrency, perModel, retries = LIFT_DEFAULTS.retries, backoffMs = LIFT_DEFAULTS.backoffMs, scoring, redoInfra = false, log = () => {}, call = null, genStats = generationStats, keyUsage = null, now = () => new Date().toISOString() }) {
  const doCall = call ?? ((args) => productCall({ providers, apiKey: key, ...args }));
  const ledgerFile = path.join(outDir, 'ledger.jsonl');
  fs.mkdirSync(outDir, { recursive: true });
  const before = readLedger(outDir).usd;
  let spentNow = 0, reserved = 0, stopped = null, launched = 0, finished = 0;
  let keyBase = null, keyDelta = 0;
  if (keyUsage) { try { keyBase = (await keyUsage()).usage; } catch { keyBase = null; } }
  const effective = () => Math.max(before + spentNow, before + keyDelta);
  const records = [];
  const queue = [];
  for (const job of jobs) {
    const file = recordPath(runDir, job.model, job.kase.id, job.arm);
    let kept = null;
    try { kept = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not stored */ }
    if (kept && kept.messages_sha256 === job.messages_sha256 && kept.model === job.model) {
      const redo = redoInfra && kept.failure === 'error' && kept.before_output === true;
      if (!redo) { records.push({ ...kept, stored: true }); continue; }
      fs.renameSync(file, file.replace(/\.json$/, `.superseded-${Date.now()}.json`));
    }
    queue.push({ ...job, file });
  }
  const started = new Set(), dropped = new Map(), running = new Set(), active = new Map();

  const runOne = async (job) => {
    const dir = path.dirname(job.file);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(job.file, '.json');
    const kase = job.kase;
    const common = {
      schema: SCHEMA, run: runName, arm: job.arm, model: job.model, case: kase.id, pair: kase.pair, family: kase.family, variant: kase.variant,
      profile: job.arm === 'product' ? job.request.profile : null, input_hash: kase.inputHash, messages_sha256: job.messages_sha256,
      chars: job.chars, allowance: job.allowance, price: job.price, reserve_usd: job.reserve_usd,
    };
    if (job.request.blocked) {
      const rec = { ...common, status: 'failed', failure: 'blocked', truncated: false, refused: false, provider_error: false, unparseable: false, correct: false, attempts: [], retries: 0, usd: 0, privacy: job.request.privacy, stored_at: now() };
      fs.writeFileSync(job.file, `${JSON.stringify(rec, null, 2)}\n`);
      return rec;
    }
    const attempts = [];
    let res = null, s = null, verdict = null, wallAll = 0;
    for (let n = 1; ; n++) {
      const at = now();
      res = await doCall({ model: job.model, system: job.request.system, user: job.request.user });
      s = readStream(res.raw?.text ?? '');
      verdict = classify(res, s);
      const started2 = outputStarted(res, s);
      const cost = await attemptCost({ s, started: started2, price: job.price, reserve: job.reserve_usd, key, genStats });
      spentNow += cost.usd;
      wallAll += res.wall_ms;
      const rawFile = `${base}.a${n}.response.${/^\s*\{/.test(res.raw?.text ?? '') ? 'json' : 'sse'}.gz`;
      writeGz(path.join(dir, rawFile), res.raw?.text ?? '');
      if (n === 1 && res.request?.body) fs.writeFileSync(path.join(dir, `${base}.request-body.json`), res.request.body);
      const attempt = {
        n, started_at: at, wall_s: round(res.wall_ms / 1000, 1), first_text_s: res.first_text_ms === null ? null : round(res.first_text_ms / 1000, 1),
        http_status: res.request?.status ?? null, request_body_sha256: res.request?.body ? sha256(res.request.body) : null, transport_error: res.request?.error ?? null,
        error: res.error, stream: { finish: s.finish, native_finish: s.native_finish, events: s.events, comments: s.comments, done_marker: s.done_marker, error: s.error, content_chars: s.content_chars, reasoning_chars: s.reasoning_chars, reasoning_details: s.reasoning_details, refusal: s.refusal, ids: s.ids, provider: s.provider, model: s.model },
        raw_stream_error: res.raw?.error ?? null, raw_bytes: res.raw?.bytes ?? 0, raw_file: rawFile,
        usage: s.usage ?? null, product_usage: res.done?.usage ?? null, usd: cost.usd, usd_source: cost.source,
        failure: verdict.failure, retryable: verdict.retryable, before_output: verdict.before_output, reason: verdict.reason,
      };
      attempts.push(attempt);
      fs.appendFileSync(ledgerFile, `${JSON.stringify({ at, run: runName, model: job.model, case: kase.id, arm: job.arm, attempt: n, usd: cost.usd, usd_source: cost.source, failure: verdict.failure })}\n`);
      if (!verdict.retryable || n > retries) break;
      const wait = Math.min(120000, res.error?.retry_after ? res.error.retry_after * 1000 : backoffMs[Math.min(n - 1, backoffMs.length - 1)]);
      log(`  retry ${job.model} ${kase.id} ${job.arm} in ${Math.round(wait / 1000)}s (${verdict.reason})`);
      await sleep(wait);
    }
    const last = attempts.at(-1);
    const scored = scoreAnswer(kase, res.text, { failure: verdict.failure, scoring });
    const sheetInTruncated = verdict.failure === 'truncated' ? extractSheet(res.text).ok : null;
    const o = scored.outcome;
    const answerFile = `${base}.answer.md`;
    fs.writeFileSync(path.join(dir, answerFile), res.text ?? '');
    const u = last.usage ?? {};
    const rec = {
      ...common,
      request: res.request ? { url: res.request.url, method: res.request.method, headers: res.request.headers, body_file: `${base}.request-body.json`, body_sha256: res.request.body ? sha256(res.request.body) : null } : null,
      status: o.status, failure: o.failure, correct: o.correct === true,
      truncated: o.failure === 'truncated', refused: o.failure === 'refused', provider_error: o.failure === 'error', unparseable: o.failure === 'unparseable' || o.failure === 'empty',
      before_output: verdict.failure === 'error' ? verdict.before_output : null, reason: verdict.reason,
      finish: last.stream.finish, native_finish: last.stream.native_finish, provider: last.stream.provider, model_served: last.stream.model ?? res.done?.model ?? null,
      hits: (o.hits ?? []).length, hit_detail: o.hits ?? [], primary_all: o.primary_all ?? null, bite: o.bite ?? null, decoy_bites: o.decoy_bites ?? 0, unmatched: o.unmatched ?? 0,
      verdict: o.verdict ?? null, quote_hit: o.quote_hit ?? null, max_severity: o.max_severity ?? null, findings_read: o.findings_read ?? 0,
      input_labels_stripped: scored.stripped, sheet_source: scored.sheet_source, sheet_repaired: scored.sheet_repaired, sheet_in_truncated: sheetInTruncated,
      tokens: { in: Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : res.done?.usage?.input ?? null, out: Number.isFinite(u.completion_tokens) ? u.completion_tokens : res.done?.usage?.output ?? null, reasoning: u.completion_tokens_details?.reasoning_tokens ?? null, cached: u.prompt_tokens_details?.cached_tokens ?? null },
      usd: attempts.reduce((sum, a) => sum + a.usd, 0), usd_source: [...new Set(attempts.map((a) => a.usd_source))].join(','),
      wall_s: round(wallAll / 1000, 1), wall_s_last: last.wall_s, retries: attempts.length - 1, attempts,
      answer_file: answerFile, answer_chars: (res.text ?? '').length, stored_at: now(),
    };
    // The provider refused the account (no credit, a bad key): no model answered, so the call
    // is kept as not run (unrun-*.json, never read as a record) and a later invocation makes it.
    if (['credit', 'auth'].includes(last.error?.kind)) {
      rec.unrun = true;
      fs.writeFileSync(job.file.replace(/\.json$/, `.unrun-${Date.now()}.json`), `${JSON.stringify(rec, null, 2)}\n`);
      return rec;
    }
    fs.writeFileSync(job.file, `${JSON.stringify(rec, null, 2)}\n`);
    return rec;
  };

  const pollKey = async () => {
    if (!keyUsage || keyBase === null) return;
    try { const k = await keyUsage(); if (typeof k.usage === 'number') keyDelta = Math.max(keyDelta, k.usage - keyBase); } catch { /* keep the last reading */ }
  };

  while (queue.length || running.size) {
    while (queue.length && running.size < concurrency && !stopped) {
      const at = queue.findIndex((j) => !dropped.has(j.model) && (active.get(j.model) ?? 0) < perModel);
      if (at < 0) break;
      const job = queue[at];
      if (!started.has(job.model)) {
        // a model starts only when its calls, and every queued call before them, still fit
        const ahead = queue.filter((j, i) => !dropped.has(j.model) && (i <= at || j.model === job.model));
        const need = ahead.reduce((sum, j) => sum + j.est_usd, 0);
        if (effective() + reserved + need > maxUsd) {
          dropped.set(job.model, `estimate $${need.toFixed(2)} for the calls up to and including this model does not fit: recorded $${effective().toFixed(2)} + in flight $${reserved.toFixed(2)} of $${maxUsd}`);
          log(`DROPPED ${job.model}: ${dropped.get(job.model)}`);
          continue;
        }
        started.add(job.model);
      }
      if (effective() + reserved + job.reserve_usd > maxUsd) { stopped = `--max-usd ${maxUsd} would be exceeded (recorded $${effective().toFixed(4)}, in flight $${reserved.toFixed(4)}, next call up to $${job.reserve_usd.toFixed(4)})`; break; }
      queue.splice(at, 1);
      reserved += job.reserve_usd;
      active.set(job.model, (active.get(job.model) ?? 0) + 1);
      launched++;
      const p = runOne(job).then((rec) => {
        records.push(rec);
        finished++;
        // an account-level refusal ends the run; a model the provider does not have ends that model
        const e = rec.attempts?.at(-1)?.error;
        if (e && (e.kind === 'credit' || e.kind === 'auth')) stopped ??= `the provider refused the account (${e.kind}, HTTP ${e.status}): ${e.message}`;
        if (e && e.kind === 'model' && !dropped.has(rec.model)) dropped.set(rec.model, `the provider does not serve it: ${e.message}`);
        log(`${rec.model.padEnd(30)} ${rec.case.padEnd(10)} ${rec.arm.padEnd(7)} ${rec.failure ?? (rec.correct ? 'right' : 'wrong')}${rec.retries ? ` (retries ${rec.retries})` : ''}  out ${rec.tokens?.out ?? '-'}  $${(rec.usd ?? 0).toFixed(4)}  ${rec.wall_s ?? '-'}s  [${finished}/${launched}, recorded $${(before + spentNow).toFixed(3)}]`);
        if (keyUsage && finished % LIFT_DEFAULTS.keyPollEvery === 0) return pollKey();
        return null;
      }, (error) => { log(`ERROR ${job.model} ${job.kase.id} ${job.arm}: ${error?.stack ?? error}`); })
        .finally(() => { reserved -= job.reserve_usd; active.set(job.model, active.get(job.model) - 1); running.delete(p); });
      running.add(p);
    }
    if (!running.size) break;
    await Promise.race(running);
  }
  await pollKey();
  const notRun = queue.length + records.filter((r) => r.unrun).length;
  return { records, spent_before: before, spent_now: spentNow, key_delta: keyBase === null ? null : keyDelta, stopped, dropped: Object.fromEntries(dropped), not_run: notRun, not_run_jobs: queue.map((j) => `${j.model} ${j.kase.id} ${j.arm}`) };
}

// ---------------------------------------------------------------- the summary

const pct = (num, den) => (den ? round((100 * num) / den, 1) : null);

/**
 * Per model, from the stored records: pairs right per arm (overall and per family), failures
 * by kind, the lift on the pairs where neither arm failed, every pair that flipped with the
 * reason on each twin, token medians and spend.
 */
export function summarise({ records, pairs, models, scoringSeed = 'product-lift-v1' }) {
  const fams = [...new Set(pairs.map((p) => p.family))].sort();
  const result = { pairs: pairs.length, by_family_pairs: Object.fromEntries(fams.map((f) => [f, pairs.filter((p) => p.family === f).length])), models: [] };
  for (const model of models) {
    const mine = records.filter((r) => r.model === model);
    if (!mine.length) continue;
    const get = (caseId, arm) => mine.find((r) => r.case === caseId && r.arm === arm) ?? null;
    const twins = (p) => FAMILIES[p.family].variants.filter((v) => p.cases[v]).map((v) => p.cases[v]);
    const row = { model, calls: {}, missing: {}, correct: {}, by_family: {}, failures: {}, failed_calls: {}, failure_rate: {}, tokens: {}, usd: {}, retries: 0, input_labels_stripped: 0, sheet_in_truncated: 0 };
    const pairRight = {}, pairFailed = {};
    for (const arm of ARMS) {
      const recs = pairs.flatMap((p) => twins(p).map((c) => get(c, arm)));
      const present = recs.filter(Boolean);
      row.calls[arm] = present.length;
      row.missing[arm] = recs.length - present.length;
      pairRight[arm] = new Map(pairs.map((p) => [p.pair, twins(p).every((c) => get(c, arm)?.correct === true)]));
      pairFailed[arm] = new Map(pairs.map((p) => [p.pair, twins(p).some((c) => { const r = get(c, arm); return !r || !!r.failure; })]));
      row.correct[arm] = [...pairRight[arm].values()].filter(Boolean).length;
      for (const f of fams) (row.by_family[f] ??= {})[arm] = pairs.filter((p) => p.family === f && pairRight[arm].get(p.pair)).length;
      const kinds = {};
      for (const r of present) if (r.failure) kinds[r.failure] = (kinds[r.failure] ?? 0) + 1;
      row.failures[arm] = kinds;
      row.failed_calls[arm] = present.filter((r) => r.failure).length + (recs.length - present.length);
      row.failure_rate[arm] = recs.length ? round(row.failed_calls[arm] / recs.length, 4) : null;
      const outs = present.map((r) => r.tokens?.out).filter(Number.isFinite);
      const reas = present.map((r) => r.tokens?.reasoning).filter(Number.isFinite);
      const ins = present.map((r) => r.tokens?.in).filter(Number.isFinite);
      row.tokens[arm] = { median_out: outs.length ? median(outs) : null, max_out: outs.length ? Math.max(...outs) : null, median_reasoning: reas.length ? median(reas) : null, median_in: ins.length ? median(ins) : null };
      row.usd[arm] = round(present.reduce((s, r) => s + (r.usd ?? 0), 0), 6);
      row.retries += present.reduce((s, r) => s + (r.retries ?? 0), 0);
      if (arm === 'product') row.input_labels_stripped = present.reduce((s, r) => s + (r.input_labels_stripped ?? 0), 0);
      row.sheet_in_truncated += present.filter((r) => r.sheet_in_truncated === true).length;
    }
    row.usd.total = round(row.usd.raw + row.usd.product, 6);
    row.delta = row.correct.product - row.correct.raw;
    const a = pairs.map((p) => (pairRight.product.get(p.pair) ? 1 : 0)), b = pairs.map((p) => (pairRight.raw.get(p.pair) ? 1 : 0));
    const all = pairedBootstrap(a, b, { seed: `${scoringSeed}|${model}|all` });
    row.lift_all = { delta_pairs: row.delta, delta_pct: all.delta === null ? null : round(100 * all.delta, 2), ci95_pct: all.ci ? [round(100 * all.ci[0], 2), round(100 * all.ci[1], 2)] : null };
    const answered = pairs.filter((p) => !pairFailed.raw.get(p.pair) && !pairFailed.product.get(p.pair));
    const ar = answered.filter((p) => pairRight.raw.get(p.pair)).length, ap = answered.filter((p) => pairRight.product.get(p.pair)).length;
    const aa = answered.map((p) => (pairRight.product.get(p.pair) ? 1 : 0)), ab = answered.map((p) => (pairRight.raw.get(p.pair) ? 1 : 0));
    const ans = pairedBootstrap(aa, ab, { seed: `${scoringSeed}|${model}|answered` });
    row.answered = { pairs: answered.length, raw: ar, product: ap, lift_pairs: ap - ar, lift_pct: ans.delta === null ? null : round(100 * ans.delta, 2), ci95_pct: ans.ci ? [round(100 * ans.ci[0], 2), round(100 * ans.ci[1], 2)] : null, ids: answered.map((p) => p.pair) };
    row.flips = [];
    for (const p of pairs) {
      const r = pairRight.raw.get(p.pair), q = pairRight.product.get(p.pair);
      if (r === q) continue;
      const detail = (arm) => Object.fromEntries(twins(p).map((c) => { const rec = get(c, arm); return [rec?.variant ?? c, twinReason(rec)]; }));
      row.flips.push({ pair: p.pair, family: p.family, direction: q ? 'gain' : 'loss', answered: answered.includes(p), raw: detail('raw'), product: detail('product') });
    }
    row.gains = row.flips.filter((f) => f.direction === 'gain').length;
    row.losses = row.flips.filter((f) => f.direction === 'loss').length;
    row.flags = {
      worse_on_answered: answered.length > 0 && ap < ar,
      failure_rate_rises: row.failed_calls.product > row.failed_calls.raw,
      incomplete: row.missing.raw + row.missing.product > 0,
    };
    result.models.push(row);
  }
  result.usd_total = round(result.models.reduce((s, m) => s + m.usd.total, 0), 6);
  return result;
}

const fmtKinds = (k) => { const e = Object.entries(k ?? {}).sort(); return e.length ? e.map(([n, v]) => `${n} ${v}`).join(', ') : 'none'; };

/** The summary as Markdown tables. */
export function renderSummary(summary) {
  const L = [];
  const fams = Object.keys(summary.by_family_pairs);
  L.push(`| Model | Raw right (/${summary.pairs}) | Product right (/${summary.pairs}) | Change | ${fams.map((f) => `${f} raw / product (/${summary.by_family_pairs[f]})`).join(' | ')} | Pairs neither arm failed | Raw / product on those | Lift on those | Flags |`);
  L.push(`|---|---|---|---|${fams.map(() => '---').join('|')}|---|---|---|---|`);
  for (const m of summary.models) {
    const flags = [m.flags.worse_on_answered ? '**product worse on answered pairs**' : null, m.flags.failure_rate_rises ? '**failure rate rises with product**' : null, m.flags.incomplete ? `incomplete (${m.missing.raw + m.missing.product} calls missing)` : null].filter(Boolean).join('; ') || '-';
    L.push(`| \`${m.model}\` | ${m.correct.raw} | ${m.correct.product} | ${m.delta > 0 ? '+' : ''}${m.delta} | ${fams.map((f) => `${m.by_family[f].raw} / ${m.by_family[f].product}`).join(' | ')} | ${m.answered.pairs} | ${m.answered.raw} / ${m.answered.product} | ${m.answered.lift_pairs > 0 ? '+' : ''}${m.answered.lift_pairs} | ${flags} |`);
  }
  L.push('');
  L.push('| Model | Arm | Failed calls (/36) | By kind | Median output tokens | Max output tokens | Median reasoning tokens | Median input tokens | Spend |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const m of summary.models) for (const arm of ARMS) {
    const t = m.tokens[arm];
    L.push(`| \`${m.model}\` | ${arm} | ${m.failed_calls[arm]} | ${fmtKinds(m.failures[arm])}${m.missing[arm] ? `, not run ${m.missing[arm]}` : ''} | ${t.median_out ?? '-'} | ${t.max_out ?? '-'} | ${t.median_reasoning ?? '-'} | ${t.median_in ?? '-'} | $${m.usd[arm].toFixed(4)} |`);
  }
  L.push('');
  L.push('| Model | Lift, all 18 pairs (95% paired bootstrap) | Lift, pairs neither arm failed (95% paired bootstrap) | Pairs gained / lost | Retries | Product answers citing input-N/ |');
  L.push('|---|---|---|---|---|---|');
  for (const m of summary.models) {
    const ci = (c) => (c ? `[${c[0]}, ${c[1]}]` : '-');
    L.push(`| \`${m.model}\` | ${m.lift_all.delta_pct} pts ${ci(m.lift_all.ci95_pct)} | ${m.answered.lift_pct ?? '-'} pts ${ci(m.answered.ci95_pct)} on ${m.answered.pairs} | ${m.gains} / ${m.losses} | ${m.retries} | ${m.input_labels_stripped} findings |`);
  }
  L.push('');
  for (const m of summary.models) {
    L.push(`**\`${m.model}\`**: ${m.flips.length ? `${m.flips.length} pair${m.flips.length === 1 ? '' : 's'} flipped` : 'no pair flipped'}.`);
    for (const f of m.flips) {
      const side = (d) => Object.entries(d).map(([v, why]) => `${v}: ${why}`).join('; ');
      L.push(`- ${f.pair} (${f.family}) ${f.direction === 'gain' ? 'gained' : 'lost'} with the product${f.answered ? '' : ' (a failure on at least one side)'}. Raw: ${side(f.raw)}. Product: ${side(f.product)}.`);
    }
    L.push('');
  }
  L.push(`Total spend on these records: $${summary.usd_total.toFixed(4)}.`);
  return L.join('\n');
}

/** MANIFEST.sha256 over every file under `dir`. */
export function writeManifest(dir) {
  const files = [];
  const walk = (abs, rel) => { for (const e of fs.readdirSync(abs, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(abs, e.name), r); else if (r !== 'MANIFEST.sha256') files.push(r); } };
  walk(dir, '');
  files.sort();
  const lines = files.map((r) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, ...r.split('/')))).digest('hex')}  ${r}`);
  fs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), `${lines.join('\n')}\n`);
  return files.length;
}

// ---------------------------------------------------------------- main

function selectPairs(protocol, flags, cases) {
  const set = String(flags.set ?? 'scored');
  const wanted = set === 'all' ? null : new Set(set.split(',').flatMap((s) => protocol.sets?.[s.trim()] ?? (() => { throw new Error(`unknown set: ${s}`); })()));
  return pairsOf(cases).filter((p) => (!wanted || wanted.has(p.pair)) && FAMILIES[p.family] && FAMILIES[p.family].variants.every((v) => p.cases[v]));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const protocol = JSON.parse(fs.readFileSync(path.join(BENCH, 'protocol.json'), 'utf8'));
  const outDir = path.resolve(String(flags['out-dir'] ?? path.join(REPO, '.local', 'build', `product-lift-${today()}`)));
  const runName = String(flags.run ?? 'main');
  if (!/^[A-Za-z0-9._-]+$/.test(runName)) throw new Error('--run must be a plain name');
  const runDir = path.join(outDir, runName);

  if (flags.manifest) { const n = writeManifest(outDir); out(`wrote ${path.join(outDir, 'MANIFEST.sha256')} (${n} files)`); return 0; }

  const roots = flags['cases-root'] ? String(flags['cases-root']).split(',').map((p) => path.resolve(p.trim())) : [path.join(BENCH, 'cases'), path.join(BENCH, 'private', 'cases')];
  const all = loadCases(roots, { glob: flags.cases ?? null }).filter((c) => c.case && c.truth && FAMILIES[c.family]);
  const pairs = selectPairs(protocol, flags, all);
  const cases = all.filter((c) => pairs.some((p) => p.pair === c.pair));
  if (!pairs.length) throw new Error('No complete pair selected.');
  const scoring = protocol.scoring;

  const { providers } = await productEngine();
  const offered = providers.PROVIDERS.find((p) => p.id === PROVIDER_ID).models.map((m) => m.id);
  const models = flags.models ? String(flags.models).split(',').map((s) => s.trim()).filter(Boolean) : offered;
  for (const m of models) if (!offered.includes(m)) out(`NOTE  ${m} is not one of the product's OpenRouter models`);

  if (flags.report) {
    const records = readRecords(runDir);
    const found = [...new Set(records.map((r) => r.model))];
    const summary = summarise({ records, pairs, models: (flags.models ? models : offered).filter((m) => found.includes(m)) });
    summary.run = runName; summary.generated_at = new Date().toISOString(); summary.ledger_usd = round(readLedger(outDir).usd, 6);
    fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    const md = renderSummary(summary);
    fs.writeFileSync(path.join(runDir, 'summary.md'), `${md}\n`);
    out(md);
    out('');
    out(`ledger total (every invocation in ${outDir}): $${summary.ledger_usd.toFixed(4)}`);
    return 0;
  }

  const arms = String(flags.arms ?? 'raw,product').split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm: ${a}`);
  const maxUsd = Number(flags['max-usd'] ?? LIFT_DEFAULTS.maxUsd);
  const concurrency = Math.max(1, Number(flags.concurrency ?? LIFT_DEFAULTS.concurrency));
  const perModel = Math.max(1, Number(flags['per-model'] ?? Math.min(concurrency, LIFT_DEFAULTS.perModel)));
  const estOut = flags['est-out'] === undefined || flags['est-out'] === 'auto' ? 'auto' : Number(flags['est-out']);
  if (!(maxUsd > 0)) throw new Error('--max-usd must be a positive number');
  if (estOut !== 'auto' && !(estOut > 0)) throw new Error('--est-out must be auto or a positive number');

  // every model must exist today; prices are taken now and stored with every call
  const catalogue = await fetchModels();
  for (const m of models.filter((x) => !catalogue.has(x))) out(`DROPPED  ${m}: not in the OpenRouter models API today`);
  const live = models.filter((m) => catalogue.has(m));
  if (!live.length) throw new Error('No model is available.');
  const prices = new Map(live.map((m) => [m, catalogue.get(m).price]));
  const allowances = new Map(live.map((m) => [m, providers.outputTokenLimit(PROVIDER_ID, m)]));
  const records = readRecords(runDir);
  const { jobs, inputs, built } = await planJobs({ cases, pairs, models: live, arms, prices, allowances, estOut, records, order: String(flags.order ?? 'cost') });
  const ledger = readLedger(outDir);
  const stored = new Set(records.map((r) => `${r.model}|${r.case}|${r.arm}|${r.messages_sha256}`));
  const todo = jobs.filter((j) => !stored.has(`${j.model}|${j.kase.id}|${j.arm}|${j.messages_sha256}`));
  const table = estimateTable(todo, ledger.usd);
  const estimate = table.length ? table.at(-1).cumulative - ledger.usd : 0;

  out(`Bounty Operator product lift: ${pairs.length} pairs (${inputs.length} inputs) x ${live.length} models x ${arms.length} arms = ${jobs.length} calls; ${jobs.length - todo.length} stored, ${todo.length} to make`);
  out(`  out-dir ${outDir} (run "${runName}"): HELD CASES, never publish this folder`);
  out(`  product: providers.mjs providerStream, provider ${PROVIDER_ID}; engine ${Object.entries(engineHashes()).map(([f, h]) => `${path.basename(f)} ${h ? h.slice(0, 12) : 'missing'}`).join(', ')}`);
  for (const kase of inputs) {
    const p = built.get(kase.id).product;
    if (p.blocked) out(`  BLOCKED ${kase.id}: the product's privacy check refuses these files (${p.privacy.kinds.join(', ')}); its product arm is recorded as blocked and never sent`);
    else if (p.privacy.warnings) out(`  note    ${kase.id}: the product's privacy check warns (${p.privacy.kinds.join(', ')}); sent as acknowledged, as a user confirming the warning would`);
  }
  const charsBy = (arm) => jobs.filter((j) => j.arm === arm && !j.request.blocked).map((j) => j.chars);
  for (const arm of arms) { const c = charsBy(arm); if (c.length) out(`  ${arm.padEnd(7)} prompt ${Math.min(...c)} to ${Math.max(...c)} characters (about ${Math.round(Math.min(...c) / 3)} to ${Math.round(Math.max(...c) / 3)} tokens at 3 characters a token)`); }
  out(`  recorded spend in the ledger before this run: $${ledger.usd.toFixed(4)} (${ledger.attempts} attempts); cap --max-usd ${maxUsd}`);
  out(`  ${'model'.padEnd(32)} ${'$/M in'.padStart(7)} ${'$/M out'.padStart(8)} ${'allow'.padStart(6)} ${'est out'.padStart(8)} ${'calls'.padStart(5)} ${'estimate'.padStart(9)} ${'worst'.padStart(8)} ${'running'.padStart(9)}`);
  for (const r of table) out(`  ${r.model.padEnd(32)} ${String(r.price.in).padStart(7)} ${String(r.price.out).padStart(8)} ${String(r.allowance).padStart(6)} ${r.est_out.join('/').padStart(8)} ${String(r.calls).padStart(5)} ${`$${r.est_usd.toFixed(2)}`.padStart(9)} ${`$${r.worst_usd.toFixed(2)}`.padStart(8)} ${`$${r.cumulative.toFixed(2)}`.padStart(9)}`);
  out(`  estimate for the calls to make: $${estimate.toFixed(2)} (output: ${estOut === 'auto' ? `auto, ${LIFT_DEFAULTS.estOut} tokens a call until a model and arm have ${LIFT_DEFAULTS.estMinSamples} stored answers` : `${estOut} tokens a call`}); recorded + estimate $${(ledger.usd + estimate).toFixed(2)}`);
  const fits = ledger.usd + estimate <= maxUsd;
  if (!fits) {
    const keep = table.filter((r) => r.cumulative <= maxUsd).map((r) => r.model);
    const drop = table.map((r) => r.model).filter((m) => !keep.includes(m));
    out(`  OVER THE CAP: drop from the most expensive end: ${drop.join(', ')} (keeps ${keep.length ? keep.join(', ') : 'none'})`);
  }
  if (flags.dump) {
    const dumpDir = path.resolve(String(flags.dump));
    fs.mkdirSync(dumpDir, { recursive: true });
    for (const kase of inputs) for (const arm of arms) {
      const r = built.get(kase.id)[arm];
      if (r.blocked) continue;
      fs.writeFileSync(path.join(dumpDir, `${kase.id}.${arm}.system.txt`), r.system);
      fs.writeFileSync(path.join(dumpDir, `${kase.id}.${arm}.user.txt`), r.user);
    }
    out(`  wrote the messages of ${inputs.length * arms.length} requests to ${dumpDir}`);
  }
  if (flags['dry-run']) { out('dry run: nothing was sent.'); return 0; }
  if (!fits) { out(`REFUSED: recorded spend + estimate ($${(ledger.usd + estimate).toFixed(2)}) exceeds --max-usd ${maxUsd}. Drop models, or lower the estimate with evidence.`); return 2; }

  const keyFile = path.resolve(String(flags['key-file'] ?? envFilePath(REPO)));
  const key = readKey(REPO, keyFile);
  fs.mkdirSync(runDir, { recursive: true });
  const planFile = path.join(runDir, `plan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  let keyAtStart = null;
  try { keyAtStart = await keyStatus(key); } catch { /* recorded as unknown */ }
  fs.writeFileSync(planFile, `${JSON.stringify({
    schema: `${SCHEMA}/plan`, run: runName, planned_at: new Date().toISOString(), max_usd: maxUsd, concurrency, per_model: perModel, est_out: estOut, retries: LIFT_DEFAULTS.retries,
    engine: engineHashes(), bridge: BRIDGE, answer_sheet_sha256: sha256(readPrompt('answer-sheet.md').trim()), provider: PROVIDER_ID, stream: true,
    key_usage_at_start: keyAtStart?.usage ?? null, key_limit_remaining_at_start: keyAtStart?.limit_remaining ?? null, ledger_usd_at_start: ledger.usd,
    models: live.map((m) => ({ model: m, price: prices.get(m), allowance: allowances.get(m) })),
    calls: todo.map((j) => ({ model: j.model, case: j.kase.id, arm: j.arm, messages_sha256: j.messages_sha256, chars: j.chars, est_usd: round(j.est_usd, 6), reserve_usd: round(j.reserve_usd, 6) })),
  }, null, 2)}\n`);
  out(`  key usage at start: ${keyAtStart?.usage ?? 'unknown'}; remaining limit ${keyAtStart?.limit_remaining ?? 'none set'}; plan written to ${path.relative(outDir, planFile)}`);

  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(original);
  let result;
  try {
    result = await liftAll({ jobs, runDir, outDir, runName, key, providers, maxUsd, concurrency, perModel, scoring, redoInfra: flags['redo-infra'] === true, log: (l) => out(`  ${l}`), keyUsage: () => keyStatus(key) });
  } finally { globalThis.fetch = original; }
  out('');
  const unrun = result.records.filter((r) => r.unrun).length;
  out(`done: ${result.records.filter((r) => !r.stored && !r.unrun).length} calls made, ${result.records.filter((r) => r.stored).length} were stored already${unrun ? `, ${unrun} refused for the account and kept as not run` : ''}; spent this invocation $${result.spent_now.toFixed(4)} (ledger now $${(result.spent_before + result.spent_now).toFixed(4)}; key usage moved $${result.key_delta === null ? 'unknown' : result.key_delta.toFixed(4)})`);
  for (const [m, why] of Object.entries(result.dropped)) out(`DROPPED ${m}: ${why}`);
  if (result.stopped) out(`STOPPED: ${result.stopped}; ${result.not_run} calls not made`);
  return result.stopped || Object.keys(result.dropped).length ? 3 : 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().then((code) => { process.exitCode = code ?? 0; }, (error) => { process.stderr.write(`error: ${error.message}\n`); process.exitCode = 1; });
