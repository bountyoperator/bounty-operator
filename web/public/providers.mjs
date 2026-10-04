// Model providers. Plain fetch against a fixed endpoint per provider, so the
// same module runs in the browser, the Worker, the MCP server and the benchmark.

import { boundedBody } from './review-core.mjs';

const OUTPUT_TOKENS = 16000;
// Reasoning and the final answer share OpenRouter's output allowance. These
// exact models exhausted 16k in native document checks and support at least 64k.
// Keep their own reasoning defaults; give the answer room to finish.
const EXTENDED_OUTPUT_TOKENS = 64000;
const EXTENDED_OPENROUTER_MODELS = new Set([
  'google/gemini-3.8-flash',
  'qwen/qwen3.8-27b',
  'qwen/qwen3.8-max-0902',
  'tencent/hy4-preview',
  'z-ai/glm-5.3',
]);
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
// Stop reasons of the Messages API that mean the answer was cut short.
const MESSAGES_CUT_OFF = ['max_tokens', 'model_context_window_exceeded'];
// Finish reasons of a chat completion that mean the same: the output cap, or
// an upstream failure after part of the answer was written.
const CHAT_CUT_OFF = ['length', 'error'];

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
 * @typedef {{ text: string, truncated: boolean, refused: boolean, model: string, usage: Usage }} ProviderResult
 * @typedef {{ type: 'delta', text: string }} StreamDelta
 * @typedef {{ type: 'done', truncated: boolean, refused: boolean, model: string, usage: Usage }} StreamDone
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
    defaultModel: 'openai/gpt-6.1-sol',
    models: [
      model('openai/gpt-6.1-sol', 'GPT-6.1 Sol', 'default'),
      model('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'),
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
    headers: { 'HTTP-Referer': APP_URL, 'X-Title': APP_TITLE },
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

/** The total output allowance sent to this provider, including any reasoning. */
export function outputTokenLimit(providerId, modelId) {
  if (!WIRE[providerId]?.tokenParam) return null;
  return providerId === 'openrouter' && EXTENDED_OPENROUTER_MODELS.has(modelId)
    ? EXTENDED_OUTPUT_TOKENS : OUTPUT_TOKENS;
}

/**
 * Every failure of a provider call. The message always starts with "Provider"
 * and never contains the API key.
 */
export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, kind?: string, retryAfter?: number | null }} [details]
   */
  constructor(message, { status = 0, kind = 'provider', retryAfter = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    /** @type {'provider'} */
    this.code = 'provider';
    /** HTTP status of the provider's answer; 0 when it never answered. */
    this.status = status;
    /** auth, model, credit, rate, server, request, response, redirect, timeout or network. */
    this.kind = kind;
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
      max_tokens: outputTokenLimit(providerId, modelId),
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
    if (wire.tokenParam) body[wire.tokenParam] = outputTokenLimit(providerId, modelId);
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
 * provider is silent for TIMEOUT_MS, or when the whole call outlasts
 * CALL_LIMIT_MS. `touch()` restarts the silence clock, which turns that limit
 * into an idle limit while a stream is delivering. The overall limit is never
 * restarted, so keep-alive comments cannot hold a stream open for ever.
 */
function createDeadline(callerSignal) {
  const controller = new AbortController();
  let expired = '';
  let idleTimer = null;

  const expire = (limit) => {
    expired = limit;
    controller.abort(new DOMException('The provider timed out.', 'TimeoutError'));
  };
  const forward = () => controller.abort(callerSignal.reason);
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = startTimer(() => expire('idle'), TIMEOUT_MS);
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
    expired: () => expired,
    callerAborted: () => Boolean(callerSignal && callerSignal.aborted),
    clear() {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      if (callerSignal) callerSignal.removeEventListener('abort', forward);
    },
  };
}

function transportFailure(error, deadline) {
  if (error instanceof ProviderError) return error;
  if (deadline.callerAborted()) return error;
  if (deadline.expired() === 'idle') {
    return new ProviderError(`Provider did not answer within ${TIMEOUT_MS / 1000} seconds. Run the review again or pick a faster model.`, { kind: 'timeout' });
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

async function errorDetail(response, apiKey) {
  const text = await readSlice(response, ERROR_BYTES);
  let detail = '';
  try {
    detail = messageFrom(JSON.parse(text));
  } catch {
    const cut = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.){1,400})/);
    detail = cut ? cut[1] : '';
  }
  return redact(detail, apiKey);
}

async function httpFailure(response, selected, request) {
  const { status } = response;
  const detail = await errorDetail(response, request.apiKey);
  const said = detail ? ` ${selected.label} said: ${detail}` : '';
  const retryHeader = Number(response.headers.get('retry-after'));
  const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : null;

  if (status === 401 || status === 403) {
    return new ProviderError(`Provider rejected the API key (HTTP ${status}). Check that the key belongs to ${selected.label} and is still active.${said}`, { status, kind: 'auth' });
  }
  if (status === 404) {
    // A key pasted into the model field must not come back in the message.
    const named = redact(request.model, request.apiKey);
    return new ProviderError(`Provider does not have the model "${named}" (HTTP 404). Check the model identifier.${said}`, { status, kind: 'model' });
  }
  if (status === 402) {
    return new ProviderError(`Provider account has no credit (HTTP 402). Add credit at ${selected.label}, then run again.${said}`, { status, kind: 'credit' });
  }
  if (status === 429) {
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
  const deadline = createDeadline(request.signal);

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

function inBandError(payload, apiKey) {
  const detail = redact(messageFrom(payload), apiKey);
  return new ProviderError(`Provider returned an error${detail ? `: ${detail}` : '.'}`, { kind: 'response' });
}

function readChatCompletion(data, request) {
  if (data && data.error) throw inBandError(data, request.apiKey);
  const choice = data?.choices?.[0];
  if (!choice) throw new ProviderError('Provider did not return a text review.', { kind: 'response' });
  // OpenRouter reports an upstream failure inside the choice, with HTTP 200.
  if (choice.error) throw inBandError(choice, request.apiKey);

  const refusal = typeof choice.message?.refusal === 'string' ? choice.message.refusal : '';
  return {
    text: textOf(choice.message?.content) || refusal,
    truncated: CHAT_CUT_OFF.includes(choice.finish_reason),
    refused: Boolean(refusal) || choice.finish_reason === 'content_filter',
    model: typeof data.model === 'string' ? data.model : request.model,
    usage: chatUsage(data.usage),
  };
}

function readMessage(data, request) {
  if (data && data.type === 'error') throw inBandError(data, request.apiKey);
  if (!data || !Array.isArray(data.content)) {
    throw new ProviderError('Provider did not return a text review.', { kind: 'response' });
  }
  return {
    text: textOf(data.content),
    truncated: MESSAGES_CUT_OFF.includes(data.stop_reason),
    refused: data.stop_reason === 'refusal',
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
  return result;
}

/**
 * Sends a prepared review and returns the whole answer.
 * `truncated` is true when the model hit the output cap; `refused` when the
 * model or the provider's filter declined.
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

  for await (const { data } of events) {
    if (data === '[DONE]') {
      state.finished = true;
      break;
    }
    const chunk = parseEventData(data);
    if (!chunk) continue;
    if (chunk.error) throw inBandError(chunk, request.apiKey);

    if (typeof chunk.model === 'string') state.model = chunk.model;
    const usage = chunk.usage || chunk.x_groq?.usage;
    if (usage) state.usage = chatUsage(usage);

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.error) throw inBandError(choice, request.apiKey);
    const text = textOf(choice.delta?.content);
    if (text) yield { type: 'delta', text };
    if (typeof choice.delta?.refusal === 'string' && choice.delta.refusal) {
      state.refused = true;
      yield { type: 'delta', text: choice.delta.refusal };
    }
    if (choice.finish_reason) {
      state.finished = true;
      if (CHAT_CUT_OFF.includes(choice.finish_reason)) state.truncated = true;
      if (choice.finish_reason === 'content_filter') state.refused = true;
    }
  }

  // A stream that ends without a finish reason was cut off in transit.
  if (!state.finished) state.truncated = true;
  return state;
}

async function* messagesStream(events, request) {
  const state = { truncated: false, refused: false, finished: false, model: request.model, usage: messagesUsage(null) };
  let input = null;

  for await (const { data } of events) {
    const event = parseEventData(data);
    if (!event) continue;

    if (event.type === 'error') throw inBandError(event, request.apiKey);
    if (event.type === 'message_start') {
      if (typeof event.message?.model === 'string') state.model = event.message.model;
      state.usage = messagesUsage(event.message?.usage);
      input = state.usage.input;
    } else if (event.type === 'content_block_start') {
      // A fallback block marks the point where another model took over.
      const block = event.content_block;
      if (block?.type === 'fallback' && typeof block.to?.model === 'string') state.model = block.to.model;
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) yield { type: 'delta', text: event.delta.text };
    } else if (event.type === 'message_delta') {
      if (MESSAGES_CUT_OFF.includes(event.delta?.stop_reason)) state.truncated = true;
      if (event.delta?.stop_reason === 'refusal') state.refused = true;
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
    let step = await deltas.next();
    while (!step.done) {
      characters += step.value.text.length;
      if (characters > RESPONSE_BYTES) {
        throw new ProviderError('Provider response exceeded the 2 MB limit.', { kind: 'response' });
      }
      yield step.value;
      step = await deltas.next();
    }

    const { truncated, refused, finished, model: answeredBy, usage } = step.value;
    if (characters === 0 && !refused) {
      // Only a stream that reported its own end can blame the output limit.
      const hitLimit = truncated ? 'limit' : '';
      throw emptyAnswer(finished ? hitLimit : 'closed');
    }
    yield { type: 'done', truncated, refused, model: answeredBy, usage };
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
 * `{ type: 'done', truncated, refused, model, usage }`. An error the provider
 * sends mid-stream is thrown from the iterator.
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
