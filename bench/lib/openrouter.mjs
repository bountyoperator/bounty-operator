// Paydirt <-> OpenRouter: the benchmark key (read from .local/benchmark.env, never
// logged), the public models catalogue (slug check + prices), the key's remaining limit,
// and per-generation stats (serving provider, billed cost).
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://openrouter.ai/api/v1';
const KEY_NAME = 'OPENROUTER_API_KEY';

/** <repo>/.local/benchmark.env: the benchmark key and, optionally, the pinned omp (lib/omp.mjs `resolveOmp`). */
export const envFilePath = (repoRoot) => path.join(repoRoot, '.local', 'benchmark.env');

/**
 * The values an env file gives for the named variables, and for no others: a caller never
 * holds a value it did not ask for. Lines are `NAME=value` or `export NAME=value`; the value
 * is taken to the end of the line, trimmed, with one pair of surrounding quotes removed;
 * backslashes are literal (a Windows path needs no escaping). The first non-empty value of a
 * name wins. Returns null when the file cannot be read.
 */
export function readEnvValues(file, names) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const out = {};
  const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // a byte order mark is not part of the first name
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !names.includes(m[1]) || out[m[1]] !== undefined) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) out[m[1]] = value;
  }
  return out;
}

/** Read the benchmark key from <repo>/.local/benchmark.env. The value never leaves this process except as the child env and the Authorization header. */
export function readKey(repoRoot, file = envFilePath(repoRoot)) {
  const values = readEnvValues(file, [KEY_NAME]);
  if (values === null) throw new Error(`Benchmark key file not found: ${file} (expected a line ${KEY_NAME}=...)`);
  if (!values[KEY_NAME]) throw new Error(`${KEY_NAME} is not set in ${file}`);
  return values[KEY_NAME];
}

/** Replace every occurrence of the key in a string (defence in depth before anything is stored or printed). */
export function redact(text, key) {
  if (typeof text !== 'string' || !key) return text;
  return text.split(key).join('[REDACTED]');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A connect timeout or a reset is retried; an HTTP answer of any status is returned to the caller. */
async function getJson(url, { key, timeoutMs = 30000, tries = 4, waitMs = 2000 } = {}) {
  let failure;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await sleep(waitMs * attempt);
    try {
      const res = await fetch(url, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      let json = null;
      try { json = JSON.parse(body); } catch { /* non-JSON error page */ }
      return { status: res.status, ok: res.ok, json };
    } catch (error) { failure = error; }
  }
  throw failure;
}

const perMillion = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
};

/** The catalogue entry reduced to what the benchmark records for a model. */
export function modelInfo(entry) {
  const p = entry?.pricing ?? {};
  return {
    slug: entry.id,
    canonical_slug: entry.canonical_slug ?? null,
    name: String(entry.name ?? entry.id).replace(/^[^:]{1,40}:\s+/, ''),
    vendor: String(entry.id).split('/')[0],
    open_weight: typeof entry.hugging_face_id === 'string' && entry.hugging_face_id.trim() !== '',
    hugging_face_id: entry.hugging_face_id || null,
    context_length: entry.context_length ?? null,
    knowledge_cutoff: entry.knowledge_cutoff ?? null,
    supported_efforts: entry.reasoning?.supported_efforts ?? null,
    supports_tools: Array.isArray(entry.supported_parameters) ? entry.supported_parameters.includes('tools') : null,
    // USD per million tokens
    price: { in: perMillion(p.prompt), out: perMillion(p.completion), cache_read: perMillion(p.input_cache_read), cache_write: perMillion(p.input_cache_write) },
  };
}

/** Fetch the public catalogue. Returns Map(slug -> modelInfo). */
export async function fetchModels() {
  const { ok, status, json } = await getJson(`${API}/models`, { timeoutMs: 60000 });
  if (!ok || !Array.isArray(json?.data)) throw new Error(`OpenRouter models API returned HTTP ${status}`);
  return new Map(json.data.filter((e) => typeof e?.id === 'string').map((e) => [e.id, modelInfo(e)]));
}

/** { limit, limit_remaining, usage } for the benchmark key (USD). */
export async function keyStatus(key, { tries = 2 } = {}) {
  const { ok, status, json } = await getJson(`${API}/key`, { key, tries });
  if (!ok || !json?.data) throw new Error(`OpenRouter key API returned HTTP ${status}`);
  const d = json.data;
  return { limit: d.limit ?? null, limit_remaining: d.limit_remaining ?? null, usage: d.usage ?? null };
}

/**
 * Stats for one generation id (the `responseId` on an assistant message): who served it
 * and what was billed. The record appears a moment after the response, so 404 is retried.
 * Returns null when it cannot be read; the run is still valid without it.
 */
export async function generationStats(key, id, { tries = 4, waitMs = 1500 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const { ok, status, json } = await getJson(`${API}/generation?id=${encodeURIComponent(id)}`, { key, timeoutMs: 15000, tries: 1 });
      if (ok && json?.data) {
        const d = json.data;
        return {
          id, provider: d.provider_name ?? null, total_cost: typeof d.total_cost === 'number' ? d.total_cost : null,
          model: d.model ?? null, finish_reason: d.finish_reason ?? null, native_finish_reason: d.native_finish_reason ?? null,
          cache_source: d.response_cache_source_id ?? null,
        };
      }
      if (status !== 404 && status !== 429 && status < 500) return null;
    } catch { /* network: retry */ }
    await sleep(waitMs);
  }
  return null;
}

/**
 * Cost in USD from token counts and catalogue prices (USD per million). Used only when
 * omp reports no cost. `usage.input` excludes cached tokens, `usage.output` includes
 * reasoning tokens (both as omp reports them).
 */
export function costFromTokens(usage, price) {
  if (!usage || !price || price.in === null || price.out === null) return null;
  const cacheRead = price.cache_read ?? price.in;
  const cacheWrite = price.cache_write ?? price.in;
  const usd = (usage.input * price.in + usage.cacheRead * cacheRead + usage.cacheWrite * cacheWrite + usage.output * price.out) / 1e6;
  return Math.round(usd * 1e9) / 1e9;
}
