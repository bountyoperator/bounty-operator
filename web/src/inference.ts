// OpenAI-compatible text/tool inference. This gateway stores usage, never content.
import { boundedBody } from '../public/review-core.mjs';
import { authenticateInference, reserveInference, settleInference } from './api-credits.ts';
import type { MeteredModel } from './api-credits.ts';
import type { Call, Env } from './env.ts';
import { ApiError, json, readJson } from './http.ts';
import { rateLimit } from './rate.ts';

export interface InferenceModel extends MeteredModel {
  name: string;
  source: string;
  revision: string;
  license: string;
  quantization: string;
  endpoint: string;
  upstreamModel: string;
}
const BODY_BYTES = 262144;
const RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_MS = 300000;
const STARTUP_MS = 180000;
const encoder = new TextEncoder();

/** Configuration comes from the operator, never from a caller's URL or headers. */
export function inferenceModels(env: Env): InferenceModel[] {
  if (!env.INFERENCE_MODELS) return [];
  try {
    const models: InferenceModel[] = JSON.parse(env.INFERENCE_MODELS);
    if (!Array.isArray(models) || models.length > 10) return [];
    if (models.some((m) => !m || !/^[a-z0-9][a-z0-9.-]{2,79}$/.test(m.id) ||
      !/^https:\/\/[a-z0-9]+\.api\.runpod\.ai$/.test(m.endpoint) ||
      !/^[a-zA-Z0-9_./-]{1,180}$/.test(m.upstreamModel) ||
      ![m.inputRate, m.outputRate, m.minimumMicro, m.context, m.maxOutput].every((n) => Number.isSafeInteger(n) && n > 0) ||
      m.inputRate > 100 || m.outputRate > 500 || m.minimumMicro > 1_000_000 || m.context > 131072 || m.maxOutput > m.context ||
      ![m.name, m.source, m.revision, m.license, m.quantization].every((s) => typeof s === 'string' && s.length <= 200))) return [];
    if (new Set(models.map((m) => m.id)).size !== models.length) return [];
    return models;
  } catch { return []; }
}

export function inferenceReady(env: Env): boolean {
  return env.INFERENCE_ENABLED === 'true' && Boolean(env.RUNPOD_API_KEY) && inferenceModels(env).length > 0;
}

export function publicModel(model: InferenceModel): Record<string, unknown> {
  return { id: model.id, object: 'model', created: 1791849600, owned_by: 'bountyoperator', name: model.name,
    context_length: model.context, max_output_tokens: model.maxOutput, source: model.source, revision: model.revision,
    license: model.license, quantization: model.quantization,
    pricing: { currency: 'usd', input_per_million: model.inputRate, output_per_million: model.outputRate, minimum_request: model.minimumMicro / 1_000_000 },
    capabilities: ['text', 'tools', 'streaming'] };
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function invalid(message: string): never { throw new ApiError(message, 400, 'invalid_request_error'); }

export function parseInference(body: Record<string, unknown>, model: InferenceModel): { payload: Record<string, unknown>; maxOutput: number; stream: boolean; includeUsage: boolean } {
  const supported = new Set(['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'seed', 'stop', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'n', 'store', 'chat_template_kwargs']);
  for (const key of Object.keys(body)) if (!supported.has(key)) invalid(`Unsupported parameter: ${key}.`);
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) invalid('Send 1–256 messages.');
  for (const message of body.messages) {
    if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(String(message.role))) invalid('Each message needs a supported role.');
    if (message.content !== null && typeof message.content !== 'string') {
      if (!Array.isArray(message.content) || message.content.some((part) => !object(part) || part.type !== 'text' || typeof part.text !== 'string')) invalid('This model accepts text content only.');
    }
    const allowed = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'reasoning', 'reasoning_content']);
    for (const field of Object.keys(message)) if (!allowed.has(field)) invalid(`Unsupported message field: ${field}.`);
    if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 32 || message.tool_calls.some((t) => !object(t) || t.type !== 'function' || typeof t.id !== 'string' || !object(t.function) || typeof t.function.name !== 'string' || typeof t.function.arguments !== 'string'))) invalid('Tool calls must contain function names and JSON argument strings.');
    if (message.role === 'tool' && typeof message.tool_call_id !== 'string') invalid('Tool messages need tool_call_id.');
  }
  if (body.n !== undefined && body.n !== 1) invalid('Only n=1 is supported.');
  if (body.store !== undefined && body.store !== false) invalid('Response storage is not supported.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be a boolean.');
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) invalid('Set either max_tokens or max_completion_tokens.');
  const maxOutput = body.max_completion_tokens ?? body.max_tokens ?? Math.min(4096, model.maxOutput);
  if (typeof maxOutput !== 'number' || !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > model.maxOutput) invalid(`Choose max_tokens between 1 and ${model.maxOutput}.`);
  const ranges: Record<string, [number, number]> = { temperature: [0, 2], top_p: [0.000001, 1], top_k: [-1, 100], frequency_penalty: [-2, 2], presence_penalty: [-2, 2], seed: [0, 2147483647] };
  for (const [field, [min, max]] of Object.entries(ranges)) {
    const value = body[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) invalid(`Invalid ${field}.`);
  }
  if (body.stop !== undefined && !(typeof body.stop === 'string' && body.stop.length <= 200) && !(Array.isArray(body.stop) && body.stop.length <= 4 && body.stop.every((s) => typeof s === 'string' && s.length <= 200))) invalid('stop must be a string or up to four short strings.');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 32 || body.tools.some((t) => !object(t) || t.type !== 'function' || !object(t.function) || typeof t.function.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.function.name) || (t.function.parameters !== undefined && !object(t.function.parameters))))) invalid('Send up to 32 function tools.');
  if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(String(body.tool_choice)) && !(object(body.tool_choice) && body.tool_choice.type === 'function' && object(body.tool_choice.function) && typeof body.tool_choice.function.name === 'string')) invalid('Invalid tool_choice.');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls must be a boolean.');
  if (body.response_format !== undefined && (!object(body.response_format) || !['text', 'json_object', 'json_schema'].includes(String(body.response_format.type)))) invalid('Unsupported response_format.');
  if (body.chat_template_kwargs !== undefined && (!object(body.chat_template_kwargs) || Object.keys(body.chat_template_kwargs).some((k) => k !== 'enable_thinking') || typeof body.chat_template_kwargs.enable_thinking !== 'boolean')) invalid('Only enable_thinking is accepted in chat_template_kwargs.');
  if (body.stream_options !== undefined && (!object(body.stream_options) || Object.keys(body.stream_options).some((k) => k !== 'include_usage') || typeof body.stream_options.include_usage !== 'boolean')) invalid('stream_options accepts include_usage only.');
  const payload: Record<string, unknown> = { ...body, model: model.upstreamModel, max_tokens: maxOutput };
  delete payload.max_completion_tokens;
  delete payload.store;
  if (body.stream) payload.stream_options = { include_usage: true, continuous_usage_stats: true };
  else delete payload.stream_options;
  return { payload, maxOutput, stream: body.stream === true, includeUsage: object(body.stream_options) && body.stream_options.include_usage === true };
}

export function usageCounters(value: unknown, model: MeteredModel, maxOutput: number): { input: number; output: number } | null {
  if (!object(value)) return null;
  const input = value.prompt_tokens;
  const output = value.completion_tokens;
  if (typeof input !== 'number' || typeof output !== 'number' || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || input > model.context || output < 0 || output > maxOutput) return null;
  return { input, output };
}

export function inferenceError(error: unknown): Response {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  return json({ error: { message: known ? error.message : 'The request could not be completed.', type: status === 401 ? 'authentication_error' : status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code: known ? error.code : 'internal_error' } }, status,
    { headers: known && typeof error.extra.retryAfter === 'number' ? { 'Retry-After': String(error.extra.retryAfter) } : {} });
}

export async function inferenceEndpoint(call: Call): Promise<Response> {
  try {
    const key = await authenticateInference(call);
    await rateLimit(call.env.DB, `inference:${key.account_id}`, 60, 60);
    if (call.url.pathname === '/v1/models' && ['GET', 'HEAD'].includes(call.request.method)) {
      return json({ object: 'list', data: inferenceReady(call.env) ? inferenceModels(call.env).map(publicModel) : [] });
    }
    if (call.url.pathname === '/v1/usage' && ['GET', 'HEAD'].includes(call.request.method)) {
      const wallet = await call.env.DB.prepare('SELECT balance_micro, reserved_micro FROM api_wallets WHERE account_id = ?').bind(key.account_id).first();
      return json({ currency: 'usd', unit: 'microdollar', wallet: wallet ?? { balance_micro: 0, reserved_micro: 0 }, key: { budget_micro: key.budget_micro, spent_micro: key.spent_micro, reserved_micro: key.reserved_micro } });
    }
    if (call.url.pathname !== '/v1/chat/completions') throw new ApiError('Endpoint not found.', 404, 'not_found');
    if (call.request.method !== 'POST') throw new ApiError('Use POST for chat completions.', 405, 'method_not_allowed');
    if (!inferenceReady(call.env)) throw new ApiError('Model inference is not available right now.', 503, 'model_unavailable', { retryAfter: 60 });
    const body = await readJson(call.request, BODY_BYTES);
    const model = inferenceModels(call.env).find((m) => m.id === body.model);
    if (!model) throw new ApiError('Choose a model returned by /v1/models.', 404, 'model_not_found');
    const parsed = parseInference(body, model);
    const idempotency = call.request.headers.get('idempotency-key');
    if (idempotency && !/^[\x21-\x7e]{1,128}$/.test(idempotency)) invalid('Idempotency-Key must contain 1–128 printable characters.');
    // Repeated failures with no metered output must not provide unlimited free GPU work.
    const failures = await call.env.DB.prepare("SELECT COUNT(*) AS n FROM inference_requests WHERE account_id = ? AND status IN ('failed', 'cancelled') AND charge_micro = 0 AND created_at > ?").bind(key.account_id, Math.floor(Date.now() / 1000) - 600).first<{ n: number }>();
    if ((failures?.n ?? 0) >= 5) throw new ApiError('Too many interrupted requests. Try again in ten minutes.', 429, 'failure_limit', { retryAfter: 600 });
    const id = await reserveInference(call.env, key, model, parsed.maxOutput, idempotency);
    return await generate(call, model, parsed, id);
  } catch (error) {
    if (!(error instanceof ApiError)) console.error('Inference failed', { name: error instanceof Error ? error.name : 'unknown' });
    return inferenceError(error);
  }
}

async function generate(call: Call, model: InferenceModel, parsed: ReturnType<typeof parseInference>, id: string): Promise<Response> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), STARTUP_MS);
  const abort = () => controller.abort();
  call.request.signal.addEventListener('abort', abort, { once: true });
  if (call.request.signal.aborted) controller.abort();
  const clean = () => { clearTimeout(timer); call.request.signal.removeEventListener('abort', abort); };
  let tokens: { input: number; output: number } | null = null;
  try {
    // Warm only the health endpoint. A generation is submitted exactly once,
    // after readiness, so retrying a cold start cannot duplicate paid work.
    await readyWorker(model, call.env, controller.signal);
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), REQUEST_MS);
    const upstream = await fetch(`${model.endpoint}/v1/chat/completions`, {
      // Workers implements manual/follow, not the browser's error mode.
      // Reject every redirect below without sending credentials to its target.
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${call.env.RUNPOD_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.payload),
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      if (upstream.status === 400 || upstream.status === 422) throw new ApiError('The model could not accept this request. Check message structure, context length and tool parameters.', 400, 'model_request_rejected');
      throw new ApiError('The model is starting or temporarily unavailable. Try again shortly.', 503, 'model_unavailable', { retryAfter: 30 });
    }
    if (!parsed.stream) {
      const result = JSON.parse(await boundedBody(upstream, RESPONSE_BYTES));
      tokens = usageCounters(result.usage, model, parsed.maxOutput);
      if (!tokens || !Array.isArray(result.choices) || result.choices.length !== 1) throw new ApiError('The model returned an incomplete response. No charge was made.', 502, 'invalid_model_response');
      await settleInference(call.env, id, 'completed', tokens);
      clean();
      return json({ id, object: 'chat.completion', created: result.created, model: model.id, choices: result.choices, usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output, total_tokens: tokens.input + tokens.output } }, 200, { headers: { 'X-Request-ID': id } });
    }
    const reader = upstream.body.getReader();
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const pump = async () => {
      let buffer = '';
      let bytes = 0;
      let done = false;
      let finalUsage = false;
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
      try {
        while (!done) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > RESPONSE_BYTES) throw new Error('Response size limit');
          buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, '\n');
          if (buffer.length > 1024 * 1024) throw new Error('Event size limit');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            if (data === '[DONE]') { done = true; break; }
            const chunk = JSON.parse(data);
            if (chunk.error || !Array.isArray(chunk.choices)) throw new Error('Invalid model event');
            if (chunk.usage != null) {
              const next = usageCounters(chunk.usage, model, parsed.maxOutput);
              if (!next || (tokens && (next.input !== tokens.input || next.output < tokens.output))) throw new Error('Invalid model usage');
              tokens = next;
              if (!chunk.choices.length) finalUsage = true;
            }
            if (!chunk.choices.length) continue;
            await writer.write(encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: chunk.created, model: model.id, choices: chunk.choices })}\n\n`));
          }
        }
        if (!done || !tokens || !finalUsage) throw new Error('Incomplete model stream');
        await settleInference(call.env, id, 'completed', tokens);
        if (parsed.includeUsage) await writer.write(encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: model.id, choices: [], usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output, total_tokens: tokens.input + tokens.output } })}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      } catch {
        controller.abort();
        await settleInference(call.env, id, 'cancelled', tokens, tokens ? 'stream_interrupted' : 'unmetered_stream');
        try { await writer.write(encoder.encode(`data: ${JSON.stringify({ error: { message: 'The stream was interrupted. Only confirmed usage is charged.', type: 'server_error', code: 'stream_interrupted' } })}\n\n`)); await writer.close(); } catch { /* The caller disconnected. */ }
      } finally { clean(); await reader.cancel().catch(() => {}); }
    };
    call.ctx.waitUntil(pump());
    return new Response(stream.readable, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-ID': id } });
  } catch (error) {
    console.error('Inference upstream stopped', { name: error instanceof Error ? error.name : 'unknown', aborted: controller.signal.aborted });
    controller.abort();
    clean();
    await settleInference(call.env, id, 'failed', null, controller.signal.aborted ? 'upstream_failed' : 'model_failed');
    if (error instanceof ApiError) throw error;
    throw new ApiError('The model request was interrupted. No charge was made.', 503, 'model_unavailable', { retryAfter: 30 });
  }
}

async function readyWorker(model: InferenceModel, env: Env, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    try {
      const response = await fetch(`${model.endpoint}/health`, {
        headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` }, redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      });
      await response.body?.cancel();
      if (response.status === 200) return;
      // Wrong credentials or a changed URL cannot be repaired by warming.
      if (response.status < 500 && response.status !== 429 && response.status !== 408) break;
    } catch { if (signal.aborted) break; }
    if (attempt < 2 && !signal.aborted) await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(delay); signal.removeEventListener('abort', finish); resolve(); };
      const delay = setTimeout(finish, 5000);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  throw new ApiError('The model is still starting or temporarily unavailable. No charge was made. Try again shortly.', 503, 'model_unavailable', { retryAfter: 30 });
}
