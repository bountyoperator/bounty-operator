// Model providers. Plain fetch against a fixed endpoint per provider, so the
// same module runs in the browser, the Worker, the MCP server and the benchmark.

import { boundedBody } from './review-core.mjs';

const OUTPUT_TOKENS = 16000;
// Reasoning and the final answer share one output allowance. These exact
// OpenRouter models exhausted 16k in native document checks and support at
// least 64k, so they get the larger allowance on every call. Keep their own
// reasoning defaults; give the answer room to finish.
const EXTENDED_OUTPUT_TOKENS = 64000;
const EXTENDED_OPENROUTER_MODELS = new Set([
  'google/gemini-3.8-flash',
  'qwen/qwen3.8-27b',
  'qwen/qwen3.8-max-0902',
  'tencent/hy4-preview',
  'z-ai/glm-5.3',
]);
// Exact models documented to take at least 64,000 output tokens, which get it
// whenever the answer is streamed. Claude 5.x thinks on every call and GPT-6.x
// reasons by default, and either can spend 16,000 tokens on reasoning alone
// and return an empty answer cut off at the cap. Without a stream they keep
// 16,000: an answer that long would outlast the single-answer limit anyway. A
// model id the user typed keeps 16,000, since its own ceiling is unknown.
const LONG_OUTPUT_MODELS = Object.freeze({
  openrouter: new Set([
    'openai/gpt-6.1-sol',
    'anthropic/claude-sonnet-5.5',
    'deepseek/deepseek-v4.1-flash',
    'anthropic/claude-opus-5.5',
    'openai/gpt-6-astra',
    'x-ai/grok-4.7',
    'z-ai/glm-5.3-flash',
    'openai/gpt-6-luna',
  ]),
  anthropic: new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']),
  openai: new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']),
  xai: new Set(['grok-4.7']),
});
const TIMEOUT_MS = 180000;
const CALL_LIMIT_MS = 900000;
const RESPONSE_BYTES = 2000000;
// A stream wraps every token in its own JSON event, so the wire size of a
// normal answer is many times its text. The 2 MB cap applies to the text.
const STREAM_BYTES = 32000000;
const ERROR_BYTES = 8192;
const DETAIL_CHARS = 300;

const APP_URL = 'https://bountyoperator.com';
const APP_TITLE = 'Bounty Operator';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Claude models that take `output_config.effort`. A review is intelligence-
// sensitive work, so they run at high; Opus 5.5 would otherwise run at its
// default of medium. Haiku 4.5 rejects the field, and a model id typed by the
// user is sent without it and runs at that model's own default.
const ANTHROPIC_EFFORT = 'high';
const ANTHROPIC_EFFORT_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
// OpenRouter calls carry no reasoning setting: every model runs at its own
// default effort. Asking GPT-6.1 Sol, GPT-6 Luna and Gemini 3.8 Flash for
// `high` was measured on 9 October 2026 against their default of medium, with
// bench/tools/product-lift.mjs. Sol got no more reviews right, took about 2.5
// times as long and had 2 of 30 reviews blocked under OpenAI's cyber policy
// where none of 48 was blocked at medium. Gemini spent a median of 37,000
// reasoning tokens a review and failed more calls. Do not add it back without
// a new measurement.
// Stop reasons of the Messages API that mean the answer was cut short.
const MESSAGES_CUT_OFF = ['max_tokens', 'model_context_window_exceeded'];
// Finish reasons of a chat completion that mean the same: the output cap, or
// an upstream failure after part of the answer was written. DeepSeek adds
// `insufficient_system_resource` and `aborted`, Mistral `model_length`.
const CHAT_CUT_OFF = ['length', 'error', 'insufficient_system_resource', 'aborted', 'model_length'];

// A provider's policy block reaches the caller in one of three ways: a stop
// reason, an error, or (Anthropic through a relay) a short notice written as
// the answer with a normal stop. `blocked` names what was identified:
//   'anthropic-cyber'      Anthropic's cyber safeguards
//   'anthropic-reasoning'  Anthropic's refusal to write out the model's own reasoning
//   'openai-cyber'         OpenAI's cyber_policy error, direct or passed on by a relay
//   'guardrail'            a guardrail set on the key or its account at OpenRouter
//   'policy'               any other block under a provider's usage policy
const POLICY_NOTICE_CHARS = 800;
// Anthropic's refusal categories that have a block id of their own. The other
// three (bio, frontier_llm, general_harms) and a null category are 'policy'.
const REFUSAL_BLOCKS = Object.freeze({ cyber: 'anthropic-cyber', reasoning_extraction: 'anthropic-reasoning' });
// How many of a guardrail's matched patterns are passed on, and how long each may be.
const GUARDRAIL_PATTERNS = 3;
const GUARDRAIL_PATTERN_CHARS = 80;
/** The notice as Anthropic's models returned it in October 2026. Anthropic documents the wording as unstable. */
export const ANTHROPIC_CYBER_NOTICE = "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.";
// Only this first sentence is matched: the rest of the notice varies.
const ANTHROPIC_CYBER_OPENING = "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy";
// A line a review opens its verdict with, in the forms the parser reads.
const VERDICT_LINE = /^[\s>#*_-]*(?:final\s+|overall\s+)?verdict[*_]{0,3}\s*[:：]/im;
const EXPLANATION_CHARS = 2000;
// OpenRouter's `metadata.error_type` values for a block reported as an error.
const POLICY_ERROR_TYPES = ['refusal', 'content_policy_violation'];

function plainSentence(text) {
  return text.replace(/’/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Classifies an answer that is a provider's policy notice and not a review.
 * The text must be short, open with Anthropic's cyber notice and carry no
 * Verdict line, so a review that quotes the notice is never taken for one.
 * The hosted run and a reply pasted back from a chat app both use it.
 *
 * @param {unknown} text
 * @returns {'anthropic-cyber' | undefined}
 */
export function policyBlock(text) {
  if (typeof text !== 'string' || text.length > POLICY_NOTICE_CHARS) return undefined;
  if (VERDICT_LINE.test(text)) return undefined;
  return plainSentence(text).startsWith(ANTHROPIC_CYBER_OPENING) ? 'anthropic-cyber' : undefined;
}

/**
 * @typedef {{ id: string, label: string, note?: string }} ProviderModel
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} label
 * @property {string} keyLabel
 * @property {string} keyPrefixHint  How this provider's keys usually start; empty when there is no fixed prefix.
 * @property {string} defaultModel
 * @property {readonly ProviderModel[]} models
 * @property {string} envVar
 * @property {string} docsUrl  Where the user creates a key.
 *
 * @typedef {{ input: number | null, output: number | null }} Usage
 * @typedef {{ messages: { role: string, content: string }[] }} PreparedMessages
 * @typedef {{ provider: string, model: string, apiKey: string, prepared: PreparedMessages, signal?: AbortSignal }} ProviderRequest
 * @typedef {{ text: string, truncated: boolean, refused: boolean, blocked?: string, model: string, usage: Usage }} ProviderResult
 * @typedef {{ type: 'delta', text: string }} StreamDelta
 * @typedef {{ type: 'done', truncated: boolean, refused: boolean, blocked?: string, model: string, usage: Usage }} StreamDone
 */

function model(id, label, note) {
  return Object.freeze(note ? { id, label, note } : { id, label });
}

function describe(entry) {
  return Object.freeze({ ...entry, models: Object.freeze(entry.models) });
}

/** @type {readonly Provider[]} */
export const PROVIDERS = Object.freeze([
  describe({
    id: 'openrouter',
    label: 'OpenRouter',
    keyLabel: 'OpenRouter API key',
    keyPrefixHint: 'sk-or-',
    // The default is the model the review method was measured to help most in
    // one request, and the one that ran all eight gauntlet stages without a
    // block (bench/tools/product-lift.mjs and the gauntlet run of 9 October
    // 2026). GPT-6.1 Sol, the default until 0.9.3, had the proof stage of the
    // gauntlet blocked under OpenAI's cyber policy on every draft tested.
    defaultModel: 'anthropic/claude-sonnet-5.5',
    models: [
      model('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 'default'),
      model('openai/gpt-6.1-sol', 'GPT-6.1 Sol'),
      model('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'value'),
      model('anthropic/claude-opus-5.5', 'Claude Opus 5.5', 'flagship'),
      model('openai/gpt-6-astra', 'GPT-6 Astra', 'flagship'),
      model('google/gemini-3.8-flash', 'Gemini 3.8 Flash', 'value'),
      model('x-ai/grok-4.7', 'Grok 4.7'),
      model('z-ai/glm-5.3-flash', 'GLM 5.3 Flash', 'value'),
      model('openai/gpt-6-luna', 'GPT-6 Luna', 'value'),
    ],
    envVar: 'OPENROUTER_API_KEY',
    docsUrl: 'https://openrouter.ai/settings/keys',
  }),
  describe({
    id: 'anthropic',
    label: 'Anthropic',
    keyLabel: 'Anthropic API key',
    keyPrefixHint: 'sk-ant-',
    defaultModel: 'claude-opus-5-5',
    models: [
      model('claude-opus-5-5', 'Claude Opus 5.5', 'default'),
      model('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'balanced'),
      model('claude-fable-5-1', 'Claude Fable 5.1', 'flagship'),
      model('claude-haiku-4-5', 'Claude Haiku 4.5', 'value'),
    ],
    envVar: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  }),
  describe({
    id: 'openai',
    label: 'OpenAI',
    keyLabel: 'OpenAI API key',
    keyPrefixHint: 'sk-',
    defaultModel: 'gpt-6.1-sol',
    models: [
      model('gpt-6.1-sol', 'GPT-6.1 Sol', 'default'),
      model('gpt-6-astra', 'GPT-6 Astra', 'flagship'),
      model('gpt-6-luna', 'GPT-6 Luna', 'value'),
    ],
    envVar: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com/api-keys',
  }),
  describe({
    id: 'gemini',
    label: 'Google Gemini',
    keyLabel: 'Gemini API key',
    keyPrefixHint: 'AIza',
    defaultModel: 'gemini-3.8-flash',
    models: [
      model('gemini-3.8-flash', 'Gemini 3.8 Flash', 'default'),
      model('gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview)', 'flagship'),
      model('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 'value'),
    ],
    envVar: 'GEMINI_API_KEY',
    docsUrl: 'https://aistudio.google.com/apikey',
  }),
  describe({
    id: 'xai',
    label: 'xAI',
    keyLabel: 'xAI API key',
    keyPrefixHint: 'xai-',
    defaultModel: 'grok-4.7',
    models: [
      model('grok-4.7', 'Grok 4.7', 'default'),
      model('grok-4.6', 'Grok 4.6'),
      model('grok-4.3', 'Grok 4.3', 'value'),
    ],
    envVar: 'XAI_API_KEY',
    docsUrl: 'https://console.x.ai',
  }),
  describe({
    id: 'deepseek',
    label: 'DeepSeek',
    keyLabel: 'DeepSeek API key',
    keyPrefixHint: 'sk-',
    defaultModel: 'deepseek-v4-pro',
    // DeepSeek serves two chat models. Its older names are aliases of these two.
    models: [
      model('deepseek-v4-pro', 'DeepSeek V4 Pro', 'default'),
      model('deepseek-flash', 'DeepSeek Flash', 'value'),
    ],
    envVar: 'DEEPSEEK_API_KEY',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  }),
  describe({
    id: 'mistral',
    label: 'Mistral',
    keyLabel: 'Mistral API key',
    keyPrefixHint: '',
    defaultModel: 'mistral-medium-latest',
    models: [
      model('mistral-medium-latest', 'Mistral Medium', 'default'),
      model('mistral-large-2512', 'Mistral Large 3'),
      model('mistral-small-latest', 'Mistral Small', 'value'),
    ],
    envVar: 'MISTRAL_API_KEY',
    docsUrl: 'https://console.mistral.ai/api-keys',
  }),
  describe({
    id: 'groq',
    label: 'Groq',
    keyLabel: 'Groq API key',
    keyPrefixHint: 'gsk_',
    defaultModel: 'openai/gpt-oss-120b',
    models: [
      model('openai/gpt-oss-120b', 'GPT-OSS 120B', 'default'),
      model('qwen/qwen3.8-27b', 'Qwen3.8 27B', 'preview'),
      model('openai/gpt-oss-20b', 'GPT-OSS 20B', 'value'),
    ],
    envVar: 'GROQ_API_KEY',
    docsUrl: 'https://console.groq.com/keys',
  }),
]);

// How each provider is called. `tokenParam` is the provider's own name for the
// output cap; Gemini's is unverified on its OpenAI-compatible endpoint, so none
// is sent. `streamUsage` marks providers documented to accept `stream_options`.
// `body` holds fields only that provider takes. OpenAI keeps the messages of a
// chat completion in the account's dashboard logs unless the request says
// `store: false`; a review carries the user's files, so it is never stored.
const WIRE = Object.freeze({
  openrouter: {
    style: 'chat',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    tokenParam: 'max_tokens',
    // App attribution: OpenRouter credits reviews to bountyoperator.com on its
    // app pages. X-OpenRouter-Title is the current name; X-Title still works.
    headers: { 'HTTP-Referer': APP_URL, 'X-OpenRouter-Title': APP_TITLE, 'X-Title': APP_TITLE },
  },
  anthropic: {
    style: 'messages',
    endpoint: 'https://api.anthropic.com/v1/messages',
    tokenParam: 'max_tokens',
  },
  openai: {
    style: 'chat',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    tokenParam: 'max_completion_tokens',
    streamUsage: true,
    body: { store: false },
  },
  gemini: {
    style: 'chat',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    tokenParam: null,
  },
  xai: {
    style: 'chat',
    endpoint: 'https://api.x.ai/v1/chat/completions',
    tokenParam: 'max_completion_tokens',
  },
  deepseek: {
    style: 'chat',
    endpoint: 'https://api.deepseek.com/chat/completions',
    tokenParam: 'max_tokens',
    streamUsage: true,
  },
  mistral: {
    style: 'chat',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    tokenParam: 'max_tokens',
  },
  groq: {
    style: 'chat',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    tokenParam: 'max_completion_tokens',
    streamUsage: true,
  },
});

/**
 * The total output allowance sent to this provider, including any reasoning.
 * `stream` says whether the answer is read as a stream, as every review on the
 * website and every streamed MCP review is.
 */
export function outputTokenLimit(providerId, modelId, { stream = false } = {}) {
  if (!WIRE[providerId]?.tokenParam) return null;
  if (providerId === 'openrouter' && EXTENDED_OPENROUTER_MODELS.has(modelId)) return EXTENDED_OUTPUT_TOKENS;
  return stream && LONG_OUTPUT_MODELS[providerId]?.has(modelId) ? EXTENDED_OUTPUT_TOKENS : OUTPUT_TOKENS;
}

/**
 * Every failure of a provider call. The message always starts with "Provider"
 * and never contains the API key.
 */
export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, kind?: string, retryAfter?: number | null, blocked?: string, detail?: string }} [details]
   */
  constructor(message, { status = 0, kind = 'provider', retryAfter = null, blocked = undefined, detail = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    /** @type {'provider'} */
    this.code = 'provider';
    /** HTTP status of the provider's answer; 0 when it never answered. */
    this.status = status;
    /** auth, policy, model, credit, rate, server, request, response, redirect, timeout or network. */
    this.kind = kind;
    /** Set with kind `policy`: a block id from the list above policyBlock. @type {string | undefined} */
    this.blocked = blocked;
    /** The provider's own words about a policy block, with keys removed; '' when it gave none. */
    this.detail = detail;
    /** Seconds the provider asked the caller to wait, when it said so. @type {number | null} */
    this.retryAfter = retryAfter;
  }
}

/**
 * @param {string} id
 * @returns {Provider}
 */
export function provider(id) {
  const found = typeof id === 'string' ? PROVIDERS.find((candidate) => candidate.id === id) : null;
  if (!found) throw new Error('Select a supported provider. Any other model can answer the exported prompt.');
  return found;
}

/**
 * Shape checks only: nothing is sent. Call this before reserving quota.
 *
 * @param {{ provider?: unknown, model?: unknown, apiKey?: unknown }} request
 * @returns {void}
 */
export function validateProviderRequest({ provider: providerId, model: modelId, apiKey } = {}) {
  const selected = provider(providerId);
  // Printable ASCII without spaces: the only text an HTTP header can carry safely.
  const isToken = (value) => /^[\x21-\x7e]+$/.test(value);

  if (typeof modelId !== 'string' || modelId.length > 200 || !isToken(modelId)) {
    throw new Error('Enter a model identifier of up to 200 characters, without spaces.');
  }
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 4096 || !isToken(apiKey)) {
    throw new Error(`Provide the ${selected.keyLabel}: one line, no spaces.`);
  }
}

function assertPrepared(prepared) {
  const messages = prepared && prepared.messages;
  const valid = Array.isArray(messages)
    && messages.length === 2
    && messages[0].role === 'system'
    && messages[1].role === 'user'
    && messages.every((message) => typeof message.content === 'string');
  if (!valid) throw new ProviderError('Provider request needs a prepared review.', { kind: 'request' });
}

function buildRequest(providerId, { model: modelId, apiKey, prepared }, { stream, fallbacks, effort }) {
  const wire = WIRE[providerId];
  const [system, user] = prepared.messages;
  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (wire.style === 'messages') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    body = {
      model: modelId,
      max_tokens: outputTokenLimit(providerId, modelId, { stream }),
      system: system.content,
      messages: [{ role: 'user', content: user.content }],
    };
    if (effort) body.output_config = { effort: ANTHROPIC_EFFORT };
    if (fallbacks) {
      headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
      body.fallbacks = 'default';
    }
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
    Object.assign(headers, wire.headers);
    body = { model: modelId, messages: prepared.messages, ...wire.body };
    if (wire.tokenParam) body[wire.tokenParam] = outputTokenLimit(providerId, modelId, { stream });
    if (stream && wire.streamUsage) body.stream_options = { include_usage: true };
  }
  if (stream) body.stream = true;

  // A redirect is never followed: see refuseRedirect. `manual` is the one mode
  // every runtime implements; Cloudflare Workers rejects `error` outright.
  return { url: wire.endpoint, init: { method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body) } };
}

/**
 * Fails the call when the provider answers with a redirect, so a prompt and an
 * API key never travel to a host other than the provider's fixed endpoint.
 * Node and Workers hand back the 3xx answer itself; a browser hands back an
 * opaque response with status 0.
 */
async function refuseRedirect(response, selected) {
  const redirected = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
  if (!redirected) return;
  await response.body?.cancel().catch(() => {});
  const status = response.status ? ` (HTTP ${response.status})` : '';
  throw new ProviderError(
    `Provider answered with a redirect${status}, which is never followed: the API key goes to ${selected.label}'s own endpoint and nowhere else. Run the review again.`,
    { status: response.status, kind: 'redirect' },
  );
}

function startTimer(callback, delay) {
  const timer = setTimeout(callback, delay);
  // In Node the pending request keeps the process alive; the timer need not.
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * One abort signal for a call: it fires when the caller aborts, when the
 * provider is silent for `idleMs`, or when the whole call outlasts
 * CALL_LIMIT_MS. `touch()` restarts the silence clock, which turns that limit
 * into an idle limit while a stream is delivering. The overall limit is never
 * restarted, so keep-alive comments cannot hold a stream open for ever.
 *
 * A call without a stream sends nothing until the whole answer is written, so
 * silence says nothing there: it gets the overall limit, and the caller's own
 * signal (the Worker's single-answer limit) ends it sooner.
 */
function createDeadline(callerSignal, idleMs = TIMEOUT_MS) {
  const controller = new AbortController();
  let expired = '';
  let idleTimer = null;

  const expire = (limit) => {
    // The first limit to fire is the cause; a second one in the same instant does not rename it.
    if (expired) return;
    expired = limit;
    controller.abort(new DOMException('The provider timed out.', 'TimeoutError'));
  };
  const forward = () => controller.abort(callerSignal.reason);
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = startTimer(() => expire('idle'), idleMs);
  };

  if (callerSignal) {
    if (callerSignal.aborted) forward();
    else callerSignal.addEventListener('abort', forward, { once: true });
  }
  arm();
  const totalTimer = startTimer(() => expire('total'), CALL_LIMIT_MS);

  return {
    signal: controller.signal,
    touch: arm,
    idleMs,
    expired: () => expired,
    callerAborted: () => Boolean(callerSignal && callerSignal.aborted),
    clear() {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      if (callerSignal) callerSignal.removeEventListener('abort', forward);
    },
  };
}

function duration(ms) {
  return ms > 300000 ? `${ms / 60000} minutes` : `${ms / 1000} seconds`;
}

function transportFailure(error, deadline) {
  if (error instanceof ProviderError) return error;
  if (deadline.callerAborted()) return error;
  if (deadline.expired() === 'idle') {
    return new ProviderError(`Provider did not answer within ${duration(deadline.idleMs)}. Run the review again or pick a faster model.`, { kind: 'timeout' });
  }
  if (deadline.expired() === 'total') {
    return new ProviderError(`Provider was still writing after ${CALL_LIMIT_MS / 60000} minutes. Run the review again or pick a faster model.`, { kind: 'timeout' });
  }
  return new ProviderError('Provider could not be reached. Check the connection and run again.', { kind: 'network' });
}

function redact(text, apiKey) {
  return text
    .split(apiKey).join('[key]')
    .replace(/(?<![A-Za-z0-9])(?:sk-|sk_|gsk_|xai-|AIza|Bearer\s+)[A-Za-z0-9_*.\-]{6,200}/g, '[key]')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_CHARS);
}

/** Validation errors as FastAPI-style servers list them: `[{ loc: ['body', 'model'], msg: '...' }]`. */
function detailText(detail) {
  if (typeof detail === 'string') return detail;
  if (!Array.isArray(detail)) return '';
  return detail
    .filter((item) => item && typeof item.msg === 'string')
    .slice(0, 3)
    .map((item) => (Array.isArray(item.loc) ? `${item.loc.join('.')}: ${item.msg}` : item.msg))
    .join('; ');
}

/** The readable part of one error object, in the shapes the providers use. */
function errorText(source) {
  if (typeof source.message === 'string') return source.message;
  // Mistral nests its validation errors one level down: { message: { detail: [...] } }.
  if (source.message && typeof source.message === 'object') return detailText(source.message.detail);
  return detailText(source.detail);
}

function messageFrom(payload) {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!first || typeof first !== 'object') return '';
  if (typeof first.error === 'string') return first.error;

  const nested = first.error && typeof first.error === 'object' ? first.error : null;
  const text = (nested && errorText(nested)) || errorText(first);
  // OpenRouter passes the upstream provider's own message along.
  const upstream = nested && typeof nested.metadata?.raw === 'string' ? nested.metadata.raw : '';
  return text && upstream ? `${text} (${upstream})` : text;
}

/** Reads at most `limit` bytes of a body and stops, without failing on a longer one. */
async function readSlice(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A body that fails mid-read still leaves whatever arrived.
  }
  await reader.cancel().catch(() => {});
  return text.slice(0, limit);
}

/** The provider's message from an error body, and the parsed body when it is whole JSON. */
async function errorDetail(response, apiKey) {
  const text = await readSlice(response, ERROR_BYTES);
  let detail = '';
  let payload = null;
  try {
    payload = JSON.parse(text);
    detail = messageFrom(payload);
  } catch {
    const cut = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.){1,400})/);
    detail = cut ? cut[1] : '';
  }
  return { detail: redact(detail, apiKey), payload };
}

function errorObject(payload) {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!first || typeof first !== 'object') return null;
  return first.error && typeof first.error === 'object' ? first.error : first;
}

/**
 * The policy block an error reports, or '' for any other error.
 *   - OpenAI: the error code `cyber_policy`, at any status.
 *   - OpenRouter: the upstream provider's code in `metadata.provider_code`;
 *     `metadata.error_type` "refusal" or "content_policy_violation"; a 403 that
 *     carries moderation metadata (`reasons`, `flagged_input`); or a 403 that
 *     lists the `patterns` a guardrail matched.
 * A 401 or 403 with none of these is a rejected key and stays one.
 * `status` is the HTTP status; an error inside a 200 body carries its own in `code`.
 */
function policySignal(payload, status = 0) {
  const error = errorObject(payload);
  if (!error) return '';
  if (error.code === 'cyber_policy') return 'openai-cyber';

  const metadata = error.metadata && typeof error.metadata === 'object' ? error.metadata : {};
  // A relay passes the upstream code along. The code is OpenAI's; when the
  // relay names another provider beside it, the block is not called OpenAI's.
  if (metadata.provider_code === 'cyber_policy') {
    const named = typeof metadata.provider_name === 'string' ? metadata.provider_name : '';
    return !named || /openai|azure/i.test(named) ? 'openai-cyber' : 'policy';
  }
  const forbidden = (status || Number(error.code)) === 403;
  // The request was stopped before any provider saw it.
  if (forbidden && guardrailPatterns(payload).length > 0) return 'guardrail';
  const moderated = (Array.isArray(metadata.reasons) && metadata.reasons.length > 0)
    || (typeof metadata.flagged_input === 'string' && metadata.flagged_input !== '');
  if (!POLICY_ERROR_TYPES.includes(metadata.error_type) && !(forbidden && moderated)) return '';

  // A relay passes the upstream provider's own words along.
  const upstream = [error.message, metadata.raw].filter((part) => typeof part === 'string').join(' ');
  return plainSentence(upstream).includes(ANTHROPIC_CYBER_OPENING) ? 'anthropic-cyber' : 'policy';
}

/** The patterns a guardrail says it matched, as short strings. Empty for any other error. */
function guardrailPatterns(payload) {
  const patterns = errorObject(payload)?.metadata?.patterns;
  if (!Array.isArray(patterns)) return [];
  return patterns
    .filter((pattern) => typeof pattern === 'string' && pattern.trim() !== '')
    .slice(0, GUARDRAIL_PATTERNS)
    .map((pattern) => pattern.trim().slice(0, GUARDRAIL_PATTERN_CHARS));
}

/** The provider's words for a guardrail block, followed by what it matched. */
function guardrailDetail(payload, detail, apiKey) {
  const matched = guardrailPatterns(payload).map((pattern) => `"${redact(pattern, apiKey)}"`).join(', ');
  return [detail, matched ? `Matched: ${matched}.` : ''].filter(Boolean).join(' ');
}

// A block that names no policy of its own is "its usage policy": a relay can
// pass on an upstream provider's block, so the endpoint's name could be wrong.
function policyFailure(blocked, { status = 0, detail = '' } = {}) {
  if (blocked === 'guardrail') {
    // The guardrail belongs to the key or its account, so the key is where to look.
    return new ProviderError(
      `Provider stopped this request at a guardrail set on the key or its account${status ? ` (HTTP ${status})` : ''}, so no model saw it and no review was written.`,
      { status, kind: 'policy', blocked, detail },
    );
  }
  const policy = {
    'openai-cyber': "OpenAI's cyber usage policy",
    'anthropic-cyber': "Anthropic's Usage Policy on cyber content",
  }[blocked] || 'its usage policy';
  // The provider's error code and the HTTP status, in one pair of brackets.
  const marks = [blocked === 'openai-cyber' ? 'cyber_policy' : '', status ? `HTTP ${status}` : ''].filter(Boolean);
  const where = marks.length ? ` (${marks.join(', ')})` : '';
  return new ProviderError(
    `Provider blocked this request under ${policy}${where}, so no review was written; the API key is not the cause.`,
    { status, kind: 'policy', blocked, detail },
  );
}

// The step at which OpenRouter's routing ran out of hosts, as `metadata.failed_routing_step`
// names it, and what the account had ruled out there. Read from its own answers on 10 October 2026.
const ROUTING_STOPS = Object.freeze({
  'Filter by Guardrails': Object.freeze({ allowed: "that the account's guardrails and privacy settings allow", change: 'change them in' }),
  'Filter by Data Policy': Object.freeze({ allowed: "that the account's data policy allows", change: 'change the policy in' }),
  'Filter by Allowed Providers': Object.freeze({ allowed: 'among those the account or the key allows', change: 'allow one of its hosts in' }),
});
// The reason a host of a free model is ruled out when the account does not let its requests be trained on.
const TRAINS_ON_REQUESTS = 'free-model-training-violation-by-account';
const UPSTREAM_SHARED_POOL = 'upstream_provider_shared_pool';

/**
 * Why a relay's routing left no host for a model that exists, or null for any
 * other error. OpenRouter answers 404 for this and 400 for a model it does not
 * know, so its 404 is never a wrong identifier.
 */
function routingStop(payload) {
  const metadata = errorObject(payload)?.metadata;
  const step = metadata && typeof metadata === 'object' ? metadata.failed_routing_step : undefined;
  if (typeof step !== 'string' || step === '') return null;
  const reasons = Array.isArray(metadata.ineligibility_reasons) ? metadata.ineligibility_reasons : [];
  return { step, trains: reasons.some((entry) => entry && entry.reason === TRAINS_ON_REQUESTS) };
}

function routingFailure(stop, { status, label, said }) {
  if (stop.trains) {
    // Changing the setting is not offered: a host that trains on requests is no place for an unreported finding.
    return new ProviderError(
      `Provider has no host for this model that the account's privacy settings allow (HTTP ${status}). The hosts of this free model may train on what they are sent, and the settings of the ${label} account rule that out. Pick a model that is not free.`,
      { status, kind: 'routing' },
    );
  }
  if (Object.hasOwn(ROUTING_STOPS, stop.step)) {
    const { allowed, change } = ROUTING_STOPS[stop.step];
    return new ProviderError(`Provider has no host for this model ${allowed} (HTTP ${status}). Pick another model, or ${change} the ${label} account's settings.`, { status, kind: 'routing' });
  }
  return new ProviderError(`Provider found no host it may use for this model (HTTP ${status}): the settings of the ${label} account or the key ruled every one out. Pick another model.${said}`, { status, kind: 'routing' });
}

/** A host's name as a relay passes it along, or '' when it is not plainly a name. A key never comes back in it. */
function hostName(value, apiKey) {
  const name = typeof value === 'string' ? redact(value, apiKey) : '';
  return /^[A-Za-z0-9][A-Za-z0-9 .&-]{0,39}$/.test(name) ? name : '';
}

/** OpenAI answers 429 both for requests sent too fast and for an account that is out of credit. This is the second. */
function quotaSpent(payload) {
  const error = errorObject(payload);
  if (!error) return false;
  if (error.code === 'insufficient_quota' || error.type === 'insufficient_quota') return true;
  return typeof error.message === 'string' && error.message.startsWith('You exceeded your current quota');
}

async function httpFailure(response, selected, request) {
  const { status } = response;
  const { detail, payload } = await errorDetail(response, request.apiKey);
  const blocked = policySignal(payload, status);
  if (blocked) return policyFailure(blocked, { status, detail: blocked === 'guardrail' ? guardrailDetail(payload, detail, request.apiKey) : detail });
  const said = detail ? ` ${selected.label} said: ${detail}` : '';
  const retryHeader = Number(response.headers.get('retry-after'));
  const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : null;

  if (status === 401 || status === 403) {
    return new ProviderError(`Provider rejected the API key (HTTP ${status}). Check that the key belongs to ${selected.label} and is still active.${said}`, { status, kind: 'auth' });
  }
  if (status === 404) {
    // The model is known and the account's own settings leave no host for it.
    const stop = routingStop(payload);
    if (stop) return routingFailure(stop, { status, label: selected.label, said });
    // A key pasted into the model field must not come back in the message.
    const named = redact(request.model, request.apiKey);
    return new ProviderError(`Provider does not have the model "${named}" (HTTP 404). Check the model identifier.${said}`, { status, kind: 'model' });
  }
  if (status === 402) {
    // OpenRouter says which of its credit limits refused the request.
    const metadata = errorObject(payload)?.metadata;
    const source = metadata && typeof metadata === 'object' ? metadata.limit_source : undefined;
    if (source === 'openrouter_in_flight_budget') {
      // A hold on requests still running or just finished. It clears by itself.
      const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : ' Run it again in a minute.';
      return new ProviderError(`Provider is holding credit for requests that are running or have just finished, so this one did not fit (HTTP 402). The OpenRouter account still has credit.${wait}`, { status, kind: 'rate', retryAfter });
    }
    if (source === 'openrouter_key_limit') {
      return new ProviderError('Provider key has used up its own credit limit (HTTP 402). Raise the limit on the key at OpenRouter or use another key, then run again.', { status, kind: 'credit' });
    }
    if (source === 'openrouter_credits') {
      return new ProviderError(
        metadata.reason === 'weight_exceeds_budget'
          ? 'Provider holds less credit for the account at one time than this request needs (HTTP 402), so running it again will not help. Add credit at OpenRouter, or send fewer files.'
          : "Provider account's credit does not cover this request (HTTP 402). Add credit at OpenRouter, then run again.",
        { status, kind: 'credit' },
      );
    }
    return new ProviderError(`Provider account has no credit (HTTP 402). Add credit at ${selected.label}, then run again.${said}`, { status, kind: 'credit' });
  }
  if (status === 429) {
    const metadata = errorObject(payload)?.metadata;
    if (metadata && typeof metadata === 'object' && metadata.limit_source === UPSTREAM_SHARED_POOL) {
      // The model's host is limiting the allowance all of the relay's users draw on. Nothing about this key changes it.
      const host = hostName(metadata.provider_name, request.apiKey);
      const next = retryAfter ? ` Retry after ${retryAfter} seconds.` : ' Run it again shortly, or pick another model.';
      return new ProviderError(
        `Provider's host for this model${host ? `, ${host},` : ''} is rate limiting the allowance that every ${selected.label} user shares (HTTP 429). The key and its credit are not the cause.${next}`,
        { status, kind: 'rate', retryAfter },
      );
    }
    if (quotaSpent(payload)) {
      return new ProviderError(`Provider account is out of credit or at its spending limit (HTTP 429). Add credit or raise the limit at ${selected.label}, then run again.`, { status, kind: 'credit' });
    }
    const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : '';
    return new ProviderError(`Provider rate limit reached, or the account has no credit (HTTP 429).${wait}${said}`, { status, kind: 'rate', retryAfter });
  }
  if (status >= 500) {
    return new ProviderError(`Provider had a server error (HTTP ${status}). Run the review again in a minute.${said}`, { status, kind: 'server' });
  }
  return new ProviderError(`Provider rejected the request (HTTP ${status})${detail ? `: ${detail}` : '.'}`, { status, kind: 'request' });
}

// Optional fields of a Messages request, with the wording a 400 uses to reject each.
const OPTIONAL_FIELDS = Object.freeze([
  { name: 'fallbacks', pattern: /fallback/i },
  { name: 'effort', pattern: /output_config|effort/i },
]);

async function send(providerId, request, { stream }) {
  const selected = provider(providerId);
  const deadline = createDeadline(request.signal, stream ? TIMEOUT_MS : CALL_LIMIT_MS);

  const attempt = async (options) => {
    const { url, init } = buildRequest(providerId, request, options);
    const response = await fetch(url, { ...init, signal: deadline.signal });
    deadline.touch();
    await refuseRedirect(response, selected);
    return response;
  };

  try {
    const messagesApi = WIRE[providerId].style === 'messages';
    const options = { stream, fallbacks: messagesApi, effort: messagesApi && ANTHROPIC_EFFORT_MODELS.has(request.model) };
    let response = await attempt(options);
    // Some Claude models do not take the fallback option, and a model can stop
    // taking the effort option. A 400 that names one of them is retried without
    // it, once per option; nothing was generated by the rejected call.
    while (response.status === 400 && messagesApi) {
      const failure = await httpFailure(response, selected, request);
      const rejected = OPTIONAL_FIELDS.find(({ name, pattern }) => options[name] && pattern.test(failure.message));
      if (!rejected) throw failure;
      options[rejected.name] = false;
      response = await attempt(options);
    }
    if (!response.ok) throw await httpFailure(response, selected, request);
    return { response, deadline };
  } catch (error) {
    deadline.clear();
    throw transportFailure(error, deadline);
  }
}

function tokenCount(value) {
  return Number.isFinite(value) ? value : null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function chatUsage(usage) {
  return { input: tokenCount(usage?.prompt_tokens), output: tokenCount(usage?.completion_tokens) };
}

function messagesUsage(usage) {
  const parts = [usage?.input_tokens, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens];
  const counted = parts.filter(Number.isFinite);
  return {
    input: counted.length ? counted.reduce((sum, value) => sum + value, 0) : null,
    output: tokenCount(usage?.output_tokens),
  };
}

function inBandError(payload, request) {
  const detail = redact(messageFrom(payload), request.apiKey);
  const blocked = policySignal(payload);
  if (blocked) return policyFailure(blocked, { detail: blocked === 'guardrail' ? guardrailDetail(payload, detail, request.apiKey) : detail });
  return new ProviderError(`Provider returned an error${detail ? `: ${detail}` : '.'}`, { kind: 'response' });
}

function readChatCompletion(data, request) {
  if (data && data.error) throw inBandError(data, request);
  const choice = data?.choices?.[0];
  if (!choice) throw new ProviderError('Provider did not return a text review.', { kind: 'response' });
  // OpenRouter reports an upstream failure inside the choice, with HTTP 200.
  if (choice.error) throw inBandError(choice, request);

  const refusal = typeof choice.message?.refusal === 'string' ? choice.message.refusal : '';
  const filtered = filteredChoice(choice);
  return {
    text: textOf(choice.message?.content) || refusal,
    truncated: CHAT_CUT_OFF.includes(choice.finish_reason),
    refused: Boolean(refusal) || filtered,
    ...(filtered ? { blocked: 'policy' } : {}),
    model: typeof data.model === 'string' ? data.model : request.model,
    usage: chatUsage(data.usage),
  };
}

/**
 * True when the provider's own filter ended the choice: `content_filter`, or
 * OpenRouter's `native_finish_reason` "refusal", the upstream provider's raw
 * reason. A `refusal` message with a normal stop is the model's own answer.
 */
function filteredChoice(choice) {
  return choice.finish_reason === 'content_filter' || choice.native_finish_reason === 'refusal';
}

/**
 * What a Messages API refusal says: the block it names, and Anthropic's
 * explanation, shown when the refusal carries no text of its own.
 */
function messagesRefusal(details) {
  const explanation = typeof details?.explanation === 'string' ? details.explanation.trim().slice(0, EXPLANATION_CHARS) : '';
  const category = details?.category;
  return { blocked: typeof category === 'string' && Object.hasOwn(REFUSAL_BLOCKS, category) ? REFUSAL_BLOCKS[category] : 'policy', explanation };
}

function readMessage(data, request) {
  if (data && data.type === 'error') throw inBandError(data, request);
  if (!data || !Array.isArray(data.content)) {
    throw new ProviderError('Provider did not return a text review.', { kind: 'response' });
  }
  const refusal = data.stop_reason === 'refusal' ? messagesRefusal(data.stop_details) : null;
  return {
    text: textOf(data.content) || (refusal ? refusal.explanation : ''),
    truncated: MESSAGES_CUT_OFF.includes(data.stop_reason),
    refused: Boolean(refusal),
    ...(refusal ? { blocked: refusal.blocked } : {}),
    model: typeof data.model === 'string' ? data.model : request.model,
    usage: messagesUsage(data.usage),
  };
}

/** The error for an answer with no text. `cause` is 'limit', 'closed' or '' when neither is known. */
function emptyAnswer(cause) {
  const messages = {
    limit: 'Provider returned no review text before the answer was cut short. No completed review was received.',
    closed: 'Provider closed the stream before sending any review text. Run the review again.',
  };
  return new ProviderError(messages[cause] || 'Provider did not return a text review.', { kind: 'response' });
}

async function readJsonBody(response) {
  let text;
  try {
    text = await boundedBody(response, RESPONSE_BYTES);
  } catch (error) {
    if (/size limit/.test(error.message)) {
      throw new ProviderError('Provider response exceeded the 2 MB limit.', { kind: 'response' });
    }
    // The body arrived whole and is not UTF-8 text: that is not a network failure.
    if (error instanceof TypeError && /encod|decod/i.test(error.message)) {
      throw new ProviderError('Provider returned a response that is not valid UTF-8 text.', { kind: 'response' });
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('Provider returned a response that is not valid JSON.', { kind: 'response' });
  }
}

function readCompletion(providerId, data, request) {
  const read = WIRE[providerId].style === 'messages' ? readMessage : readChatCompletion;
  const result = read(data, request);
  if (!result.refused && !result.text.trim()) throw emptyAnswer(result.truncated ? 'limit' : '');
  // The notice names its source, so it outranks a general `policy` mark.
  const blocked = policyBlock(result.text);
  return blocked ? { ...result, refused: true, blocked } : result;
}

/**
 * Sends a prepared review and returns the whole answer.
 * `truncated` is true when the model hit the output cap; `refused` when the
 * model or the provider's filter declined; `blocked` names a policy block
 * the provider reported. A block the provider sends as an error is thrown as
 * a ProviderError of kind `policy`.
 *
 * @param {ProviderRequest} request
 * @returns {Promise<ProviderResult>}
 */
export async function providerReview({ provider: providerId, model: modelId, apiKey, prepared, signal }) {
  validateProviderRequest({ provider: providerId, model: modelId, apiKey });
  assertPrepared(prepared);
  const request = { model: modelId, apiKey, prepared, signal };

  const { response, deadline } = await send(providerId, request, { stream: false });
  try {
    return readCompletion(providerId, await readJsonBody(response), request);
  } catch (error) {
    throw transportFailure(error, deadline);
  } finally {
    deadline.clear();
  }
}

/** Assembles server-sent events from lines. Comment lines (": ...") are ignored. */
function createEventParser() {
  let event = '';
  let data = [];

  return {
    /** Takes one line and returns the event it completes, or null. */
    push(line) {
      if (line === '') {
        const complete = data.length ? { event, data: data.join('\n') } : null;
        event = '';
        data = [];
        return complete;
      }
      if (line.startsWith(':')) return null;

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      return null;
    },
  };
}

/** Yields `{ event, data }` for each server-sent event in the response body. */
async function* serverSentEvents(response, deadline) {
  // A response without a body is a stream that sent nothing.
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createEventParser();
  let buffer = '';
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      deadline.touch();
      received += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      if (received > STREAM_BYTES || buffer.length > RESPONSE_BYTES) {
        throw new ProviderError('Provider stream exceeded the size limit.', { kind: 'response' });
      }

      // A trailing "\r" may be half of "\r\n", so it stays in the buffer.
      const lines = buffer.split(/\r\n|\n|\r(?!\n|$)/);
      buffer = lines.pop();
      for (const line of lines) {
        const complete = parser.push(line);
        if (complete) yield complete;
      }
    }

    // Some servers close without the final blank line.
    for (const line of [buffer.replace(/\r$/, ''), '']) {
      const complete = parser.push(line);
      if (complete) yield complete;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseEventData(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function* chatStream(events, request) {
  const state = { truncated: false, refused: false, finished: false, model: request.model, usage: chatUsage(null) };
  // Once text has been delivered, an upstream failure cuts the answer short
  // instead of discarding it: the caller's key has paid for that text.
  // OpenRouter sends such a failure as a chunk with a top-level `error` and
  // `finish_reason: "error"`.
  // A policy block sent the same way ends the answer as refused: the text is
  // kept for the user to read and is not a review.
  let wrote = false;
  const failed = (payload) => {
    const error = inBandError(payload, request);
    if (!wrote) throw error;
    if (error.kind === 'policy') {
      state.refused = true;
      state.blocked = error.blocked;
    } else {
      state.truncated = true;
    }
    state.finished = true;
  };

  for await (const { data } of events) {
    if (data === '[DONE]') {
      state.finished = true;
      break;
    }
    const chunk = parseEventData(data);
    if (!chunk) continue;
    if (chunk.error) {
      failed(chunk);
      break;
    }

    if (typeof chunk.model === 'string') state.model = chunk.model;
    const usage = chunk.usage || chunk.x_groq?.usage;
    if (usage) state.usage = chatUsage(usage);

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.error) {
      failed(choice);
      break;
    }
    const text = textOf(choice.delta?.content);
    if (text) {
      wrote = true;
      yield { type: 'delta', text };
    }
    if (typeof choice.delta?.refusal === 'string' && choice.delta.refusal) {
      state.refused = true;
      yield { type: 'delta', text: choice.delta.refusal };
    }
    if (choice.finish_reason) {
      state.finished = true;
      if (CHAT_CUT_OFF.includes(choice.finish_reason)) state.truncated = true;
    }
    if (filteredChoice(choice)) {
      state.finished = true;
      state.refused = true;
      state.blocked ??= 'policy';
    }
  }

  // A stream that ends without a finish reason was cut off in transit.
  if (!state.finished) state.truncated = true;
  return state;
}

async function* messagesStream(events, request) {
  const state = { truncated: false, refused: false, finished: false, model: request.model, usage: messagesUsage(null) };
  let input = null;
  // As in chatStream: an error after delivered text cuts the answer short.
  let wrote = false;

  for await (const { data } of events) {
    const event = parseEventData(data);
    if (!event) continue;

    if (event.type === 'error') {
      if (!wrote) throw inBandError(event, request);
      state.truncated = true;
      state.finished = true;
      break;
    }
    if (event.type === 'message_start') {
      if (typeof event.message?.model === 'string') state.model = event.message.model;
      state.usage = messagesUsage(event.message?.usage);
      input = state.usage.input;
    } else if (event.type === 'content_block_start') {
      // A fallback block marks the point where another model took over.
      const block = event.content_block;
      if (block?.type === 'fallback' && typeof block.to?.model === 'string') state.model = block.to.model;
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        wrote = true;
        yield { type: 'delta', text: event.delta.text };
      }
    } else if (event.type === 'message_delta') {
      if (MESSAGES_CUT_OFF.includes(event.delta?.stop_reason)) state.truncated = true;
      if (event.delta?.stop_reason === 'refusal') {
        // Where the stream carries stop_details is not documented: read both places.
        const refusal = messagesRefusal(event.delta.stop_details ?? event.stop_details);
        state.refused = true;
        state.blocked = refusal.blocked;
        if (!wrote && refusal.explanation) {
          wrote = true;
          yield { type: 'delta', text: refusal.explanation };
        }
      }
      const output = tokenCount(event.usage?.output_tokens);
      if (output !== null) state.usage = { input, output };
    } else if (event.type === 'message_stop') {
      state.finished = true;
      break;
    }
  }

  if (!state.finished) state.truncated = true;
  return state;
}

async function* streamEvents(providerId, response, deadline, request) {
  const read = WIRE[providerId].style === 'messages' ? messagesStream : chatStream;
  let deltas = null;

  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      // The provider ignored `stream` and answered in one piece.
      const { text, ...summary } = readCompletion(providerId, await readJsonBody(response), request);
      if (text) yield { type: 'delta', text };
      yield { type: 'done', ...summary };
      return;
    }

    deltas = read(serverSentEvents(response, deadline), request);
    let characters = 0;
    let shortText = '';
    let step = await deltas.next();
    while (!step.done) {
      characters += step.value.text.length;
      if (characters > RESPONSE_BYTES) {
        throw new ProviderError('Provider response exceeded the 2 MB limit.', { kind: 'response' });
      }
      shortText = characters <= POLICY_NOTICE_CHARS ? shortText + step.value.text : '';
      yield step.value;
      step = await deltas.next();
    }

    const { truncated, refused, finished, model: answeredBy, usage } = step.value;
    const blocked = policyBlock(shortText) || step.value.blocked;
    if (characters === 0 && !refused) {
      // Only a stream that reported its own end can blame the output limit.
      const hitLimit = truncated ? 'limit' : '';
      throw emptyAnswer(finished ? hitLimit : 'closed');
    }
    yield { type: 'done', truncated, refused: refused || Boolean(blocked), ...(blocked ? { blocked } : {}), model: answeredBy, usage };
  } catch (error) {
    throw transportFailure(error, deadline);
  } finally {
    // Closing the inner generator cancels the body when the consumer stops early.
    if (deltas) await deltas.return().catch(() => {});
    deadline.clear();
  }
}

/**
 * Sends a prepared review and streams the answer.
 *
 * Resolves once the provider has accepted the request, so key, model and
 * rate-limit errors reject here, before any event. The iterable then yields
 * `{ type: 'delta', text }` and ends with one
 * `{ type: 'done', truncated, refused, blocked?, model, usage }`. An error the
 * provider sends mid-stream is thrown from the iterator when no text has
 * arrived yet; after text it ends the stream as truncated, so the text already
 * paid for is kept. A policy block after text ends it as refused and blocked.
 *
 * @param {ProviderRequest} request
 * @returns {Promise<AsyncGenerator<StreamDelta | StreamDone, void, void>>}
 */
export async function providerStream({ provider: providerId, model: modelId, apiKey, prepared, signal }) {
  validateProviderRequest({ provider: providerId, model: modelId, apiKey });
  assertPrepared(prepared);
  const request = { model: modelId, apiKey, prepared, signal };

  const { response, deadline } = await send(providerId, request, { stream: true });
  return streamEvents(providerId, response, deadline, request);
}
