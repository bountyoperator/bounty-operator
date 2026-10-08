// Paydirt run records: the resume key, the on-disk layout of one run, harness validity
// checks, failure classification, and the bridge from a stored run to the scorer.
import crypto from 'node:crypto';
import { extractSheet, parseEvents } from './parse.mjs';
import { canonical, protocolHash } from './protocol.mjs';

export { canonical, protocolHash };
export const RUN_SCHEMA = 'paydirt.run/1';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Resume key = sha256(hash of the run's arm, model, case input hash, arm, repeat). A stored
 * run with this key is never run again. `armSha` is the hash the arm runs under
 * (lib/protocol.mjs): the core hash for the raw arm, the profile's own hash for a profile arm.
 * So a raw-arm key does not move when a product profile text is frozen again, and a
 * profile-arm key moves only with the text of its own profile.
 */
export function resumeKey({ armSha, model, inputHash, arm, rep }) {
  if (typeof armSha !== 'string' || !armSha) throw new Error(`resumeKey: no hash for the ${arm} arm`);
  return sha256(['paydirt.key/1', armSha, model, inputHash, arm, String(rep)].join('\n'));
}

/**
 * Is this stored run one that counts under the given hashes ({ arms: { <arm>: hash } })?
 * It is when it was stored under the hash its arm runs under now. A run stored before the
 * hashes were split carries no `arm_sha256` and never counts.
 */
export function countsUnder(meta, hashes) {
  const want = hashes?.arms?.[meta?.arm];
  return typeof want === 'string' && want !== '' && meta.arm_sha256 === want;
}

export const modelDir = (slug) => String(slug).replace(/[^A-Za-z0-9._-]+/g, '__');
export const runName = (caseId, arm, rep) => `${caseId}.${arm}.${rep}`;

/**
 * Did omp do what the protocol says? Checked on every run from the dumped requests and
 * the event stream. A failed check means the harness is broken, never that the model is wrong.
 */
export function harnessChecks({ ev, requests, expected }) {
  const wantTools = [...expected.tools].sort().join(',');
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const checks = {
    requests: requests.count > 0,
    tools: requests.count > 0 && requests.toolsets.length === 1 && requests.toolsets[0] === wantTools,
    model: requests.count > 0 && requests.models.every((m) => m === expected.model) && ev.models.every((m) => m === expected.model) && ev.providers.every((p) => p === expected.provider),
    system: requests.count > 0 && requests.system.includes(expected.system.trim()),
    nonce: requests.count > 0 && requests.system.includes(`run-nonce: ${expected.nonce}`),
    cwd: ev.cwd === null || norm(ev.cwd) === norm(expected.cwd),
    no_sampling: requests.summaries.every((s) => s.temperature === null),
    // the provider-routing policy of protocol.json must be on every request, exactly as written
    routing: !expected.routing || (requests.count > 0 && requests.summaries.every((s) => canonical(s.provider) === canonical(expected.routing))),
  };
  checks.ok = Object.values(checks).every(Boolean);
  return checks;
}

// ---------------------------------------------------------------- provider policy blocks
//
// A run is 'blocked' when the provider or its safety layer declined the request and no model
// judgment exists. Three signals, and nothing else, make a run blocked:
//   1. the text notice: the final answer, trimmed, is at most NOTICE_MAX_CHARS long, starts with
//      CYBER_NOTICE_PREFIX and holds no answer sheet, on a normal stop (policyNotice);
//   2. the stop reason: 'refusal' or 'content_filter' (BLOCK_STOP_REASONS);
//   3. a policy error envelope: a cyber_policy or content_policy_violation code, error_type
//      refusal, the notice's own wording, or a 403 with moderation wording (classifyError).
// A blocked run is final, is never retried, never halts the model and never counts toward the
// streak of provider errors that halts one. Its detail is '<vendor>-<category>', for example
// 'anthropic-cyber' or 'openai-cyber_policy'. It is not a wrong answer: lib/score.mjs counts it
// in a field of its own and leaves it out of every accuracy denominator.
// General refusal prose ("I can't help with that") is not matched: an answer can quote it and
// there is no bounded form to anchor on.

export const BLOCKED = 'blocked';
/** The opening sentence of Anthropic's cyber-safeguard notice. A prefix: Anthropic calls the rest of the text "not stable". */
export const CYBER_NOTICE_PREFIX = "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";
export const NOTICE_MAX_CHARS = 800;
export const BLOCK_STOP_REASONS = Object.freeze(['refusal', 'content_filter']);

/**
 * Is this answer text a provider's block notice and nothing more? Returns the block's detail
 * ('anthropic-cyber') or null. An answer that quotes the notice further down, or runs past
 * NOTICE_MAX_CHARS, or carries an answer sheet, is the model's own answer.
 */
export function policyNotice(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > NOTICE_MAX_CHARS || !t.startsWith(CYBER_NOTICE_PREFIX)) return null;
  return extractSheet(t).ok ? null : 'anthropic-cyber';
}

const POLICY_ENVELOPE = [
  [/\bcyber_policy\b/i, 'cyber_policy', 'openai'],
  [/violative cyber content|blocked under Anthropic's Usage Policy/i, 'cyber', 'anthropic'],
  [/content_policy_violation/i, 'content_policy_violation', null],
  [/["']?error_type["']?\s*[:=]\s*["']?refusal\b/i, 'refusal', null],
];
const MODERATION_403 = /moderation|flagged|guardrail|usage policy|content filter/i;
const vendorOfModel = (model) => { const s = String(model ?? ''); return s.includes('/') ? s.split('/')[0].toLowerCase() : null; };
/** '<vendor>-<category>': the model's vendor when its slug names one, else the vendor the signal itself belongs to, else 'provider'. */
const blockDetail = (category, model, fallback = null) => `${vendorOfModel(model) ?? fallback ?? 'provider'}-${category}`;

/**
 * Sort a provider/transport error into: infra (retry), budget, auth, unavailable (stop),
 * blocked (a policy block: final, not the model's answer), or error (the model's own failure).
 * A blocked result also carries `category` and, where the signal names one, `vendor`.
 */
export function classifyError(status, message) {
  const text = String(message ?? '');
  let code = Number(status);
  if (!Number.isInteger(code) || code < 100) { const m = /\b(?:HTTP|status(?: code)?|code|error)\s*[:=]?\s*([45]\d\d)\b/i.exec(text); code = m ? Number(m[1]) : 0; }
  if (code === 402 || /insufficient credits?|payment required|requires more credits|can only afford|negative balance/i.test(text)) return { kind: 'budget', retry: false, halt: 'all' };
  if (code === 401 || /invalid api key|no auth credentials|unauthorized|user not found|missing authentication/i.test(text)) return { kind: 'auth', retry: false, halt: 'all' };
  if (code === 404 || /no endpoints found|model not found|not a valid model|no allowed providers|unknown model|does not exist/i.test(text)) return { kind: 'unavailable', retry: false, halt: 'model' };
  // An account-level gate (an attestation, a region, a terms acceptance) says nothing about the model.
  if (code === 403 && /requires you to (?:complete|accept|confirm)|age confirmation|confirm at https?:\/\/|not available in your (?:region|country)|accept the terms/i.test(text)) return { kind: 'unavailable', retry: false, halt: 'model' };
  // A policy block is checked before the infrastructure pattern: OpenRouter wraps a refusal as
  // "Provider returned error" from an "upstream" provider, and filed as infra it would be retried on every run.
  for (const [pattern, category, vendor] of POLICY_ENVELOPE) if (pattern.test(text)) return { kind: BLOCKED, retry: false, halt: null, category, vendor };
  if (code === 403 && MODERATION_403.test(text)) return { kind: BLOCKED, retry: false, halt: null, category: 'moderation', vendor: null };
  if ([408, 409, 425, 429].includes(code) || code >= 500 || /rate.?limit|overloaded|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|network|fetch failed|terminated|connection|stream (?:ended|closed|error)|stream stalled|stalled while waiting|upstream|provider returned error|temporarily|try again/i.test(text)) return { kind: 'infra', retry: true, halt: null };
  return { kind: 'error', retry: false, halt: null };
}

/**
 * Classify one finished omp process.
 *   res     what runOmp resolved with
 *   ev      parseEvents(events.jsonl)
 *   checks  harnessChecks(...)
 *   stderr  tail of stderr.txt
 * Returns { status, failure, detail, final, retry, halt }.
 *   final=true  the run has a verdict and is never re-rolled (ok, the model's own failure, or a provider policy block)
 *   final=false infrastructure failure: retried now if retry=true, and again on the next invocation
 */
export function classifyRun({ res, ev, checks, stderr = '' }) {
  const ok = { status: 'ok', failure: null, detail: null, final: true, retry: false, halt: null };
  const model = (failure, detail) => ({ status: 'failed', failure, detail, final: true, retry: false, halt: null });
  const infra = (detail, retry = true, halt = null) => ({ status: 'failed', failure: 'infra', detail, final: false, retry, halt });
  if (res.spawnError) return infra(`could not start omp: ${res.spawnError}`, false, 'all');
  if (checks.requests && !checks.ok) {
    const failed = Object.entries(checks).filter(([k, v]) => k !== 'ok' && !v).map(([k]) => k);
    // a wrong model id concerns that model only; anything else means the harness itself is broken
    return infra(`harness check failed: ${failed.join(', ')}`, false, failed.length === 1 && failed[0] === 'model' ? 'model' : 'all');
  }
  const final = ev.final;
  if (res.timedOut) return res.sawModelOutput ? model('timeout', 'hard wall-clock limit reached') : infra('hard wall-clock limit reached before any model output');
  if (!final) {
    const c = classifyError(null, stderr);
    const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400);
    if (c.kind === 'error') return infra(`no model response (exit ${res.exitCode}): ${tail || 'no output'}`);
    if (c.kind === BLOCKED) return model(BLOCKED, blockDetail(c.category, ev.models?.[0], c.vendor));
    return infra(`${c.kind}: ${tail}`, c.retry, c.halt);
  }
  switch (final.stopReason) {
    case 'stop': {
      // the provider's block notice in place of an answer: checked first, so a block that reports no usage is not retried as a cached response
      const notice = policyNotice(final.text ?? ev.finalText);
      if (notice) return model(BLOCKED, notice);
      if (ev.usage.input + ev.usage.output + ev.usage.cacheRead === 0) return infra('zero token usage (response served from a cache)');
      // the host handed the model's tool call back as reasoning text: no call was made and no answer exists
      if (final.strayToolCall) return infra('the provider returned a tool call as reasoning text (no tool call, no answer)');
      return ok;
    }
    case 'refusal':
    case 'content_filter': return model(BLOCKED, blockDetail(final.stopReason, final.model ?? ev.models?.[0]));
    case 'length': return model('truncated', 'the model hit its output limit');
    case 'toolUse': return model('timeout', 'the session ended between turns (omp --max-time)');
    case 'aborted': return res.sawModelOutput ? model('timeout', 'the session was aborted') : infra('aborted before any model output');
    case 'error': {
      const c = classifyError(final.errorStatus, final.errorMessage);
      const detail = `${final.errorStatus ?? ''} ${final.errorMessage ?? ''}`.trim().slice(0, 400);
      if (c.kind === 'error') return model('error', detail);
      if (c.kind === BLOCKED) return model(BLOCKED, blockDetail(c.category, final.model ?? ev.models?.[0], c.vendor));
      return infra(`${c.kind}: ${detail}`, c.retry, c.halt);
    }
    default: return model('error', `unexpected stop reason "${final.stopReason}"`);
  }
}

/** The per-run facts copied into every outcome record. */
export function runFacts(meta) {
  const u = meta.usage ?? {};
  const currentCost = typeof meta.usd_all_attempts === 'number' ? meta.usd_all_attempts : meta.usd;
  const priorCost = typeof meta.usd_prior_attempts === 'number' ? meta.usd_prior_attempts : 0;
  return {
    usd: typeof currentCost === 'number' ? Math.round((currentCost + priorCost) * 1e9) / 1e9 : null,
    wall_s: typeof meta.wall_s === 'number' ? meta.wall_s : null,
    tokens_in: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
    tokens_out: u.output ?? 0,
    tokens_reasoning: u.reasoning ?? 0,
    turns: meta.turns ?? null,
    effort: meta.effort ?? null,
    providers: Array.isArray(meta.providers) ? meta.providers : [],
    stop: meta.stop_reason ?? null,
  };
}

/**
 * Stored run -> the `run` argument of scoreInput. The answer sheet is always re-read from
 * the stored event stream, so scoring is a pure function of the raw output.
 */
export function toScoreRun({ meta, eventsText, draft = null }) {
  const facts = runFacts(meta);
  if (meta.failure && meta.failure !== 'unparseable' && meta.failure !== 'empty') return { failure: meta.failure, sheet: null, draft, facts };
  const ev = parseEvents(eventsText);
  return { failure: null, sheet: extractSheet(ev.finalText), draft, facts };
}
