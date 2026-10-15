// OpenAI-compatible text/tool inference. This gateway stores usage, never content.
import { boundedBody } from '../public/review-core.mjs';
import { MICRO_USD, TOPUP_USD, authenticateInference, reserveInference, settleInference } from './api-credits.ts';
import type { MeteredModel } from './api-credits.ts';
import type { Call, Env } from './env.ts';
import { ApiError, json, readJson } from './http.ts';
import { rateLimit } from './rate.ts';
import { markSupplierDispatched, supplierAvailability, supplierBudgetRefillable } from './supplier-costs.ts';

export interface InferenceModel extends MeteredModel {
  name: string;
  source: string;
  revision: string | null;
  license: string | null;
  quantization: string | null;
  endpoint: string;
  upstreamModel: string;
  description?: string;
  tags?: string[];
  capabilities?: string[];
  reasoningParameter?: 'enable_thinking' | 'thinking' | 'reasoning_effort';
  enabled?: boolean;
}
const CAPABILITIES = ['text', 'tools', 'streaming', 'reasoning', 'structured_output'];
const BODY_BYTES = 8 * 1024 * 1024;
const RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_MS = 300000;
const STARTUP_MS = 600000;
const encoder = new TextEncoder();

// Managed alias metadata was checked against the providers' public catalogs
// on 2026-10-14. Aliases do not prove a weight revision, license or a fixed
// quantization. Kimi 8/12, Omen 8/14 and Qwen Cyber 4/70 USD per million use
// the maximum published supplier rates (4.5/4.5, 4.5/7 and 2/37.5) plus room
// for Infron's 5% funding fee. Fixed payment fees and tax are separate costs.
// Supplier-cost rules have their own expiring quotes; these are retail prices.
const CATALOG_DEFAULTS: Readonly<Record<string, Omit<InferenceModel, 'endpoint'>>> = {
  'cyber-qwen-27b-awq': { id: 'cyber-qwen-27b-awq', name: 'Qwen Cyber 27B AWQ', source: 'philbert440/Qwen3.8-27B-Uncensored-Cyber-W4A16-AWQ', revision: 'd6db3e17ccf92e0082001019bf932b34beb81764', license: 'Apache-2.0', quantization: 'AWQ W4A16', description: 'Low-refusal cyber model for code review, security analysis and agent workflows.', tags: ['cybersecurity', 'uncensored'], context: 262144, maxOutput: 8192, inputRate: 3, outputRate: 36, minimumMicro: 300000, upstreamModel: 'cyber-qwen-27b-awq', reasoningParameter: 'enable_thinking' },
  'orca-cyber-zero-1.5': { id: 'orca-cyber-zero-1.5', name: 'OrcaCyber Zero 1.5', source: 'orca/orcacyber-zero-1.5', revision: null, license: null, quantization: null, description: 'OrcaRouter’s flagship offensive-security and vulnerability-discovery model for exploit verification and defense.', tags: ['cybersecurity', 'uncensored'], context: 1000000, maxOutput: 8192, inputRate: 4, outputRate: 12, minimumMicro: 150000, upstreamModel: 'orca/orcacyber-zero-1.5' },
  'orca-cyber-zero-1.0': { id: 'orca-cyber-zero-1.0', name: 'OrcaCyber Zero 1.0', source: 'orca/orcacyber-zero-1.0', revision: null, license: null, quantization: null, description: 'First-generation OrcaCyber Zero security research model for code audit, log triage and PoC validation.', tags: ['cybersecurity', 'uncensored'], context: 1000000, maxOutput: 8192, inputRate: 4, outputRate: 12, minimumMicro: 150000, upstreamModel: 'orca/orcacyber-zero-1.0' },
  'glm-5.3-flash-cyber': { id: 'glm-5.3-flash-cyber', name: 'GLM-5.3 Flash Cybersecurity', source: 'z-ai/glm-5.3-flash-cybersecurity', revision: null, license: null, quantization: null, description: 'Fast cybersecurity fine-tune of GLM-5.3 Flash for vulnerability triage, code audit and agent tool loops.', tags: ['cybersecurity', 'uncensored'], context: 1048576, maxOutput: 8192, inputRate: 2, outputRate: 24, minimumMicro: 100000, upstreamModel: 'z-ai/glm-5.3-flash-cybersecurity' },
  'deepseek-v4-flash-cyber': { id: 'deepseek-v4-flash-cyber', name: 'DeepSeek V4 Flash Vision Cyber', source: 'deepseek/deepseek-v4-flash-vision-exp-cybersecurity', revision: null, license: null, quantization: null, description: 'Cybersecurity-tuned DeepSeek V4 Flash for exploit-path verification, reverse engineering and code review.', tags: ['cybersecurity', 'uncensored'], context: 1048576, maxOutput: 8192, inputRate: 2, outputRate: 6, minimumMicro: 50000, upstreamModel: 'deepseek/deepseek-v4-flash-vision-exp-cybersecurity' },
  'qwen3.8-27b-cyber': { id: 'qwen3.8-27b-cyber', name: 'Qwen 3.8 27B Cybersecurity', source: 'qwen/qwen3.8-27b-cybersecurity', revision: null, license: null, quantization: null, description: 'Provider-hosted Qwen 3.8 27B cybersecurity specialist for deep vulnerability analysis and PoC review.', tags: ['cybersecurity', 'uncensored'], context: 262144, maxOutput: 8192, inputRate: 4, outputRate: 70, minimumMicro: 150000, upstreamModel: 'qwen/qwen3.8-27b-cybersecurity' },
  'gemma-4-26b-cyber': { id: 'gemma-4-26b-cyber', name: 'Gemma 4 26B A4B Cybersecurity', source: 'google/gemma-4-26b-a4b-it-cybersecurity', revision: null, license: null, quantization: null, description: 'High-throughput 26B-A4B MoE cybersecurity instruction model for rapid code scanning and triage.', tags: ['cybersecurity', 'uncensored'], context: 262144, maxOutput: 8192, inputRate: 2, outputRate: 5, minimumMicro: 50000, upstreamModel: 'google/gemma-4-26b-a4b-it-cybersecurity' },
  'glm-5.3-cyber': { id: 'glm-5.3-cyber', name: 'GLM-5.3 Cybersecurity 744B', source: 'z-ai/glm-5.3-cybersecurity', revision: null, license: null, quantization: null, description: 'Frontier 744B MoE cybersecurity specialist for complex multi-contract invariant and exploit reasoning.', tags: ['cybersecurity', 'uncensored'], context: 1048576, maxOutput: 8192, inputRate: 10, outputRate: 20, minimumMicro: 200000, upstreamModel: 'z-ai/glm-5.3-cybersecurity' },
  'glm-5.3-ablit': { id: 'glm-5.3-ablit', name: 'GLM-5.3 Low-Refusal 744B', source: 'z-ai/glm-5.3-abliterated', revision: null, license: null, quantization: null, description: 'Flagship 744B low-refusal reasoning model for red-team verification and proof-of-concept stress testing.', tags: ['uncensored'], context: 1048576, maxOutput: 8192, inputRate: 10, outputRate: 18, minimumMicro: 200000, upstreamModel: 'z-ai/glm-5.3-abliterated' },
  'glm-5.3-flash-ablit': { id: 'glm-5.3-flash-ablit', name: 'GLM-5.3 Flash Low-Refusal', source: 'z-ai/glm-5.3-flash-abliterated', revision: null, license: null, quantization: null, description: 'Fast low-refusal GLM-5.3 Flash variant for iterative security analysis and agent harnesses.', tags: ['uncensored'], context: 1048576, maxOutput: 8192, inputRate: 3, outputRate: 8, minimumMicro: 80000, upstreamModel: 'z-ai/glm-5.3-flash-abliterated' },
  'cyberstrike-offsec-35b': { id: 'cyberstrike-offsec-35b', name: 'CyberStrike OffSec 35B', source: 'huihui-ai/Huihui-CyberStrike-OffSec-35B-abliterated', revision: '01521758ee85df1ed4edaf494c48e20704b80204', license: 'Apache-2.0', quantization: 'BF16', description: 'Low-refusal 35B-A3B MoE security and code-review model tuned for structured tool calls and clean termination.', tags: ['cybersecurity', 'uncensored'], context: 262144, maxOutput: 8192, inputRate: 2, outputRate: 24, minimumMicro: 150000, upstreamModel: 'cyberstrike-offsec-35b', reasoningParameter: 'enable_thinking' },
  'qwen-coder390-27b-ablit': { id: 'qwen-coder390-27b-ablit', name: 'Qwen 3.8 27B Coder390 Low-Refusal', source: 'huihui-ai/Huihui-Qwen3.8-27B-Coder390-EfficientThink-abliterated', revision: '14c13fcf593d692a5b96f29afecca6fe2fc030e6', license: 'Apache-2.0', quantization: 'BF16', description: 'Low-refusal 27B coding and security specialist distilled on frontier SFT/RLOO traces with efficient thinking.', tags: ['cybersecurity', 'uncensored'], context: 262144, maxOutput: 8192, inputRate: 3, outputRate: 38, minimumMicro: 200000, upstreamModel: 'qwen-coder390-27b-ablit', reasoningParameter: 'enable_thinking' },
  'kimi-k3-cyber': { id: 'kimi-k3-cyber', name: 'Kimi K3 Cybersecurity Two-Stage', source: 'moonshotai/kimi-k3-cybersecurity-two-stage', revision: null, license: null, quantization: null, description: 'Two-stage Kimi K3 cybersecurity reasoning model for long-context audit trails and exploit validation.', tags: ['cybersecurity'], context: 1048576, maxOutput: 8192, inputRate: 8, outputRate: 12, minimumMicro: 150000, upstreamModel: 'moonshotai/kimi-k3-cybersecurity-two-stage' },
  'omen-2.0-cyber': { id: 'omen-2.0-cyber', name: 'Omen 2.0 Cybersecurity', source: 'audn/omen-2.0-cybersecurity', revision: null, license: null, quantization: null, description: 'Second-generation Omen security model tuned for vulnerability discovery, triage and defensive verification.', tags: ['cybersecurity', 'uncensored'], context: 1048576, maxOutput: 8192, inputRate: 8, outputRate: 14, minimumMicro: 100000, upstreamModel: 'audn/omen-2.0-cybersecurity' },
  'gemma-4-31b-ablit': { id: 'gemma-4-31b-ablit', name: 'Gemma 4 31B Low-Refusal', source: 'google/gemma-4-31b-it-abliterated-v2', revision: null, license: null, quantization: null, description: 'Dense 31B Gemma 4 instruction model with refusal vectors removed for direct technical security analysis.', tags: ['uncensored'], context: 32768, maxOutput: 8192, inputRate: 2, outputRate: 6, minimumMicro: 80000, upstreamModel: 'google/gemma-4-31b-it-abliterated-v2' },
  'qwen3-coder-next': { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next 80B-A3B', source: 'qwen/qwen3-coder-next', revision: null, license: null, quantization: null, description: '80B-A3B Mixture-of-Experts coding and repository-analysis model built for multi-file agent tool loops.', tags: ['general'], context: 262140, maxOutput: 8192, inputRate: 2, outputRate: 8, minimumMicro: 80000, upstreamModel: 'qwen/qwen3-coder-next' },
  'deepseek-v4.1-flash': { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', source: 'deepseek/deepseek-v4.1-flash', revision: null, license: null, quantization: null, description: 'High-speed DeepSeek V4.1 Flash reasoning and coding model for large-context security diffs.', tags: ['general'], context: 1000000, maxOutput: 8192, inputRate: 1, outputRate: 4, minimumMicro: 50000, upstreamModel: 'deepseek/deepseek-v4.1-flash' },
  'deephat-v1-7b': { id: 'deephat-v1-7b', name: 'DeepHat V1 7B', source: 'DeepHat/DeepHat-V1-7B', revision: '361a5ce60e67c815ff868a253fdfd54364dbb84f', license: 'Apache-2.0 + DeepHat use restrictions', quantization: 'BF16', description: 'A security specialist for code review and technical investigation.', tags: ['cybersecurity'], context: 32768, maxOutput: 8192, inputRate: 2, outputRate: 18, minimumMicro: 150000, upstreamModel: 'deephat-v1-7b' },
  'orca-qwen-27b': { id: 'orca-qwen-27b', name: 'Orca Qwen 3.8 27B', source: 'orcarouter/Qwen3.8-27B-Uncensored-FP8', revision: '8b4ede700a2ee547a35daa035d5e62d9be05d10d', license: 'Apache-2.0; publisher use conditions apply', quantization: 'FP8', description: 'Orca’s low-refusal Qwen model for coding and agent workflows.', tags: ['uncensored'], context: 262144, maxOutput: 8192, inputRate: 3, outputRate: 40, minimumMicro: 300000, upstreamModel: 'orca-qwen-27b', reasoningParameter: 'enable_thinking' },
  'orca-nex-mini': { id: 'orca-nex-mini', name: 'Orca Nex N2.5 Mini', source: 'orcarouter/Nex-N2.5-mini-Uncensored-FP8', revision: 'bf828724f25dd45c7dce05c83cdf5b6b3eb5b5f8', license: 'Apache-2.0; publisher use conditions apply', quantization: 'FP8', description: 'Low-refusal Nex model with function tools and structured responses.', tags: ['uncensored'], context: 262144, maxOutput: 8192, inputRate: 3, outputRate: 65, minimumMicro: 200000, upstreamModel: 'orca-nex-mini', reasoningParameter: 'reasoning_effort' },
  'hermes-4-14b': { id: 'hermes-4-14b', name: 'Hermes 4 14B', source: 'NousResearch/Hermes-4-14B-FP8', revision: '36282813f06d5a9438ed08254759f56f970f32ba', license: 'Apache-2.0', quantization: 'FP8', description: 'A compact Hermes model for coding, chat and tool use.', tags: ['general'], context: 40960, maxOutput: 8192, inputRate: 2, outputRate: 20, minimumMicro: 150000, upstreamModel: 'hermes-4-14b', reasoningParameter: 'thinking' },
  'hermes-4.3-36b': { id: 'hermes-4.3-36b', name: 'Hermes 4.3 36B', source: 'NousResearch/Hermes-4.3-36B', revision: '3899db2b6c4b35f16bde3b570bb7dd2775d56161', license: 'Apache-2.0', quantization: 'BF16', description: 'The larger Hermes option for coding and agent workflows.', tags: ['general'], context: 32768, maxOutput: 8192, inputRate: 5, outputRate: 80, minimumMicro: 350000, upstreamModel: 'hermes-4.3-36b', reasoningParameter: 'thinking' },
  'dolphin-mistral-24b': { id: 'dolphin-mistral-24b', name: 'Dolphin Mistral 24B Venice', source: 'dphn/Dolphin-Mistral-24B-Venice-Edition-FP8', revision: '26bbbeb19e545c8fe1516cb8d8db5c590184c82d', license: 'Apache-2.0', quantization: 'FP8', description: 'Low-refusal Dolphin model for chat and written analysis.', tags: ['uncensored'], capabilities: ['text', 'streaming', 'structured_output'], context: 131072, maxOutput: 8192, inputRate: 3, outputRate: 40, minimumMicro: 200000, upstreamModel: 'dolphin-mistral-24b' },
  'foundation-sec-8b': { id: 'foundation-sec-8b', name: 'Foundation-Sec 1.1 8B', source: 'fdtn-ai/Foundation-Sec-1.1-8B-Instruct', revision: '243b27655e01c87cc04fdb88632be7cd9e55ac1f', license: 'Apache-2.0 + Llama 3.1 Community License', quantization: 'BF16', description: 'Cisco’s security-focused model for analysis and explanations. Built with Llama.', tags: ['cybersecurity'], capabilities: ['text', 'streaming', 'structured_output'], context: 65536, maxOutput: 8192, inputRate: 2, outputRate: 28, minimumMicro: 150000, upstreamModel: 'foundation-sec-8b' },
};

function isRunpod(endpoint: string): boolean {
  return /^https:\/\/[a-z0-9]+\.api\.runpod\.ai$/.test(endpoint);
}

function backendKey(endpoint: string, env: Env): string | undefined {
  if (endpoint === 'https://api.infron.ai') return env.INFRON_API_KEY;
  if (endpoint === 'https://api.orcarouter.ai') return env.ORCAROUTER_API_KEY;
  return env.RUNPOD_API_KEY;
}

/** Configuration comes from the operator, never from a caller's URL or headers. */
export function inferenceModels(env: Env): InferenceModel[] {
  if (!env.INFERENCE_MODELS) return [];
  try {
    const raw: Partial<InferenceModel>[] = JSON.parse(env.INFERENCE_MODELS);
    if (!Array.isArray(raw) || raw.length > 64) return [];
    const models: InferenceModel[] = raw.map((m) => {
      if (!m || typeof m !== 'object') return m as InferenceModel;
      const base = typeof m.id === 'string' && Object.hasOwn(CATALOG_DEFAULTS, m.id) ? CATALOG_DEFAULTS[m.id] : undefined;
      const merged = { ...base, ...m };
      return { ...merged, upstreamModel: merged.upstreamModel ?? merged.id, maxOutput: merged.maxOutput ?? 8192 } as InferenceModel;
    });
    if (models.some((m) => !m || !/^[a-z0-9][a-z0-9.-]{2,79}$/.test(m.id) ||
      !/^https:\/\/(?:[a-z0-9]+\.api\.runpod\.ai|api\.infron\.ai|api\.orcarouter\.ai)$/.test(m.endpoint) ||
      !/^[a-zA-Z0-9_./-]{1,180}$/.test(m.upstreamModel) ||
      ![m.inputRate, m.outputRate, m.minimumMicro, m.context, m.maxOutput].every((n) => Number.isSafeInteger(n) && n > 0) ||
      m.inputRate > 100 || m.outputRate > 500 || m.minimumMicro > 1_000_000 || m.context > 1048576 || m.maxOutput > m.context ||
      ![m.name, m.source].every((s) => typeof s === 'string' && s.length <= 200) ||
      ![m.revision, m.license, m.quantization].every((s) => s === null || (typeof s === 'string' && s.length <= 200)) ||
      (m.enabled !== undefined && typeof m.enabled !== 'boolean') ||
      (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 500)) ||
      (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.length > 8 || m.tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9-]{1,40}$/.test(tag)))) ||
      (m.capabilities !== undefined && (!Array.isArray(m.capabilities) || !m.capabilities.includes('text') || m.capabilities.length > CAPABILITIES.length || new Set(m.capabilities).size !== m.capabilities.length || m.capabilities.some((capability) => !CAPABILITIES.includes(capability)))) ||
      (m.reasoningParameter !== undefined && !['enable_thinking', 'thinking', 'reasoning_effort'].includes(m.reasoningParameter)))) return [];
    if (new Set(models.map((m) => m.id)).size !== models.length) return [];
    return models;
  } catch { return []; }
}

export function inferenceReady(env: Env): boolean {
  return env.INFERENCE_ENABLED === 'true' && inferenceModels(env).some((m) => m.enabled !== false && Boolean(backendKey(m.endpoint, env)));
}
// The hosting account pauses every endpoint when its balance runs out: a
// worker answers /health with 402 and nothing can start. That state is read
// from the hosting API once a minute, so the catalog, the account panel and
// top-ups say "paused" instead of selling credit nothing can spend, and a
// request fails at once instead of after a reservation and a probe.
const HOSTING_CHECK_MS = 60000;
const HOSTING_API = 'https://api.runpod.io/graphql';
const PAUSED_MESSAGE = 'Model inference is paused right now. No charge was made. Try again later.';
let hosting = { at: 0, key: '', paused: false };

function noteHosting(env: Env, paused: boolean): void {
  hosting = { at: Date.now(), key: env.RUNPOD_API_KEY ?? '', paused };
}

/** Forgets the last hosting state, so the next question asks the hosting API again. */
export function clearHostingState(): void {
  hosting = { at: 0, key: '', paused: false };
}

/** True when the hosting account reports that it can start no worker. Unknown reads as not paused: the worker probe decides. */
export async function inferencePaused(env: Env): Promise<boolean> {
  if (!env.RUNPOD_API_KEY) return false;
  if (hosting.key === env.RUNPOD_API_KEY && Date.now() - hosting.at < HOSTING_CHECK_MS) return hosting.paused;
  let paused = false;
  try {
    const response = await fetch(HOSTING_API, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ myself { underBalance } }' }),
    });
    const result = response.status === 200 ? await response.json() as { data?: { myself?: { underBalance?: unknown } } } : null;
    if (!result) await response.body?.cancel();
    paused = result?.data?.myself?.underBalance === true;
  } catch { paused = false; }
  noteHosting(env, paused);
  return paused;
}

export async function inferenceStatus(env: Env): Promise<'unavailable' | 'paused' | 'available'> {
  if (!inferenceReady(env)) return 'unavailable';
  const configured = inferenceModels(env).filter((model) => model.enabled !== false && Boolean(backendKey(model.endpoint, env)));
  const [supplier, faults] = await Promise.all([supplierAvailability(env, configured), usageFaultModels(env)]);
  const models = configured.filter((model) => supplier[model.id]?.available && !faults.has(model.id));
  if (!models.length) return 'unavailable';
  const hasDirectGateway = models.some((m) => m.enabled !== false && !isRunpod(m.endpoint) && Boolean(backendKey(m.endpoint, env)));
  if (hasDirectGateway) return 'available';
  return (await inferencePaused(env)) ? 'paused' : 'available';
}

/** Manual top-ups follow inference availability, with one exception. When the
 * only thing keeping every model unavailable is supplier allowance that the
 * payment itself refills (see supplierBudgetRefillable), closing top-ups would
 * leave nothing to refill it, so they stay open. Every other reason keeps them
 * closed: inference off, no cost rule, the operator's pause, a provider never
 * funded, automatic funding off, a usage fault or a hosting pause. */
export async function manualTopupsOpen(env: Env, status?: Awaited<ReturnType<typeof inferenceStatus>>): Promise<boolean> {
  const state = status ?? await inferenceStatus(env);
  if (state === 'available') return true;
  if (state !== 'unavailable' || !inferenceReady(env)) return false;
  const configured = inferenceModels(env).filter((model) => model.enabled !== false && Boolean(backendKey(model.endpoint, env)));
  const [refillable, faults] = await Promise.all([supplierBudgetRefillable(env, configured, TOPUP_USD[0] * MICRO_USD), usageFaultModels(env)]);
  const models = configured.filter((model) => refillable.has(model.id) && !faults.has(model.id));
  if (!models.length) return false;
  if (models.some((model) => !isRunpod(model.endpoint))) return true;
  return !(await inferencePaused(env));
}

export function publicModel(model: InferenceModel, env?: Env, supplierAvailable = false): Record<string, unknown> {
  const runpod = isRunpod(model.endpoint);
  const available = Boolean(env && env.INFERENCE_ENABLED === 'true' && model.enabled !== false && backendKey(model.endpoint, env) && supplierAvailable);
  const paused = available && runpod && hosting.key === env?.RUNPOD_API_KEY && Date.now() - hosting.at < HOSTING_CHECK_MS && hosting.paused;
  const sourceUrl = runpod ? `https://huggingface.co/${model.source.split('/').map(encodeURIComponent).join('/')}`
    : model.endpoint === 'https://api.infron.ai' ? 'https://api.infron.ai/v1/models'
      : `https://www.orcarouter.ai/api/public/models/${model.upstreamModel.split('/').map(encodeURIComponent).join('/')}`;
  return { id: model.id, object: 'model', created: 1791849600, owned_by: 'bountyoperator', name: model.name,
    context_length: model.context, max_output_tokens: model.maxOutput, source: model.source, revision: model.revision,
    license: model.license, quantization: model.quantization,
    source_url: sourceUrl, hosting_provider: runpod ? 'RunPod' : model.endpoint === 'https://api.infron.ai' ? 'Infron' : 'OrcaRouter',
    availability: paused ? 'paused' : available ? 'available' : 'unavailable',
    admission_policy: 'conservative_utf8_bytes_with_template_reserve',
    pricing: { currency: 'usd', input_per_million: model.inputRate, output_per_million: model.outputRate, minimum_request: model.minimumMicro / 1_000_000 },
    description: model.description ?? '', tags: model.tags ?? [],
    capabilities: model.capabilities ?? ['text', 'tools', 'streaming', 'structured_output'],
    ...(model.reasoningParameter ? { reasoning_parameter: `chat_template_kwargs.${model.reasoningParameter}` } : {}) };
}

/** Retain every requested model in the catalog, with honest per-model state. */
export async function inferenceCatalog(env: Env): Promise<Record<string, unknown>[]> {
  const models = inferenceModels(env);
  const [supplier, faults] = await Promise.all([supplierAvailability(env, models), usageFaultModels(env)]);
  // Discovery checks account funding through the management API, never /health
  // (which can start a paid worker). Do this even when a direct gateway is up.
  if (env.INFERENCE_ENABLED === 'true' && models.some((model) => model.enabled !== false && isRunpod(model.endpoint) && backendKey(model.endpoint, env) && supplier[model.id]?.available && !faults.has(model.id))) await inferencePaused(env);
  return models.map((model) => publicModel(model, env, supplier[model.id]?.available === true && !faults.has(model.id)));
}

async function usageFaultModels(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare("SELECT DISTINCT model FROM inference_requests WHERE failure_code = 'usage_limit_exceeded' AND finished_at > ?")
    .bind(Math.floor(Date.now() / 1000) - 600).all<{ model: string }>();
  return new Set(rows.results.map((row) => row.model));
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function invalid(message: string): never { throw new ApiError(message, 400, 'invalid_request_error'); }

export function parseInference(body: Record<string, unknown>, model: InferenceModel): { payload: Record<string, unknown>; maxOutput: number; stream: boolean; includeUsage: boolean } {
  if (model.capabilities) {
    if (!model.capabilities.includes('tools') && ((Array.isArray(body.tools) && body.tools.length > 0) || (body.tool_choice !== undefined && body.tool_choice !== 'none'))) invalid('This model does not support function tools. Choose a model with the tools capability.');
    if (!model.capabilities.includes('streaming') && body.stream === true) invalid('This model does not support streaming.');
    if (!model.capabilities.includes('structured_output') && body.response_format !== undefined && (!object(body.response_format) || body.response_format.type !== 'text')) invalid('This model does not support structured output.');
  }
  const supported = new Set(['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'seed', 'stop', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'n', 'store', 'chat_template_kwargs', 'reasoning_effort']);
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
  if (body.reasoning_effort !== undefined && (typeof body.reasoning_effort !== 'string' || !['none', 'low', 'medium', 'high', 'max'].includes(body.reasoning_effort))) invalid('Invalid reasoning_effort.');
  if (body.chat_template_kwargs !== undefined) {
    if (!object(body.chat_template_kwargs)) invalid('chat_template_kwargs must be an object.');
    for (const [name, value] of Object.entries(body.chat_template_kwargs)) {
      if (['enable_thinking', 'thinking', 'clear_thinking'].includes(name)) {
        if (typeof value !== 'boolean') invalid(`${name} must be a boolean.`);
      } else if (name === 'reasoning_effort') {
        if (typeof value !== 'string' || !['none', 'low', 'medium', 'high', 'max'].includes(value)) invalid('Invalid reasoning_effort.');
      } else invalid(`Unsupported chat template parameter: ${name}.`);
    }
  }
  if (body.stream_options !== undefined && (!object(body.stream_options) || Object.keys(body.stream_options).some((k) => k !== 'include_usage') || typeof body.stream_options.include_usage !== 'boolean')) invalid('stream_options accepts include_usage only.');
  const payload: Record<string, unknown> = { ...body, model: model.upstreamModel, max_tokens: maxOutput };
  // These hybrid models default to direct answers. Keep the template and parser
  // in agreement, while allowing the caller to explicitly enable reasoning.
  if (model.reasoningParameter) {
    const supplied = object(body.chat_template_kwargs) ? body.chat_template_kwargs : {};
    const defaults = model.reasoningParameter === 'reasoning_effort'
      ? { reasoning_effort: supplied.reasoning_effort ?? body.reasoning_effort ?? 'none', enable_thinking: (supplied.reasoning_effort ?? body.reasoning_effort ?? 'none') !== 'none' }
      : { [model.reasoningParameter]: false };
    payload.chat_template_kwargs = { ...defaults, ...supplied };
  }
  delete payload.max_completion_tokens;
  delete payload.store;
  if (body.stream) payload.stream_options = isRunpod(model.endpoint) ? { include_usage: true, continuous_usage_stats: true } : { include_usage: true };
  else delete payload.stream_options;
  // An alias does not identify a tokenizer. Count UTF-8 bytes rather than
  // guessing a characters/token ratio, including tools and response schemas.
  // Reserve template overhead per message/tool plus the requested completion.
  // The provider still enforces its actual token window; this is a conservative
  // admission bound, not a claim that a byte is an actual model token.
  const inputBytes = encoder.encode(JSON.stringify({ messages: payload.messages, tools: payload.tools, tool_choice: payload.tool_choice, response_format: payload.response_format })).byteLength;
  const templateReserve = 1024 + body.messages.length * 64 + (Array.isArray(body.tools) ? body.tools.length * 256 : 0);
  if (inputBytes + templateReserve + maxOutput > model.context) throw new ApiError(`Input is too large for this model's conservative context budget. Shorten the messages, tools or response schema, or request fewer output tokens. The provider window is ${model.context} tokens.`, 400, 'context_length_exceeded');
  return { payload, maxOutput, stream: body.stream === true, includeUsage: object(body.stream_options) && body.stream_options.include_usage === true };
}

export function usageCounters(value: unknown, model: MeteredModel): { input: number; output: number } | null {
  if (!object(value)) return null;
  const input = value.prompt_tokens;
  const output = value.completion_tokens;
  // A provider exceeding our declared window is an operational fault, not a
  // reason to erase confirmed billable usage. Settlement caps the charge at
  // the existing reservation and records the original counters.
  if (typeof input !== 'number' || typeof output !== 'number' || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0 || !Number.isSafeInteger(input * model.inputRate + output * model.outputRate)) return null;
  return { input, output };
}

function usageFailure(tokens: { input: number; output: number }, model: MeteredModel, maxOutput: number): string | null {
  return tokens.input + tokens.output > model.context || tokens.output > maxOutput ? 'usage_limit_exceeded' : null;
}

function hasTerminalChoice(choices: unknown): boolean {
  return Array.isArray(choices) && choices.length === 1 && object(choices[0]) && typeof choices[0].finish_reason === 'string' &&
    ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(choices[0].finish_reason);
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
      return json({ object: 'list', data: (await inferenceCatalog(call.env)).filter((model) => model.availability === 'available') });
    }
    if (call.url.pathname.startsWith('/v1/models/') && ['GET', 'HEAD'].includes(call.request.method)) {
      const id = call.url.pathname.slice('/v1/models/'.length);
      const model = (await inferenceCatalog(call.env)).find((entry) => entry.id === id && entry.availability === 'available');
      if (!model) throw new ApiError('Choose a model returned by /v1/models.', 404, 'model_not_found');
      return json(model);
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
    if (model.enabled === false || !backendKey(model.endpoint, call.env)) throw new ApiError('This model is not available right now. No charge was made.', 503, 'model_unavailable', { retryAfter: 60 });
    if (isRunpod(model.endpoint) && hosting.key === call.env.RUNPOD_API_KEY && Date.now() - hosting.at < HOSTING_CHECK_MS && hosting.paused) throw new ApiError(PAUSED_MESSAGE, 503, 'inference_paused', { retryAfter: 300 });
    const parsed = parseInference(body, model);
    const usageFault = await call.env.DB.prepare("SELECT 1 AS found FROM inference_requests WHERE model = ? AND failure_code = 'usage_limit_exceeded' AND finished_at > ? LIMIT 1").bind(model.id, Math.floor(Date.now() / 1000) - 600).first();
    if (usageFault) throw new ApiError('This model is temporarily unavailable while its usage limits are checked. No charge was made.', 503, 'model_usage_unavailable', { retryAfter: 600 });
    const idempotency = call.request.headers.get('idempotency-key');
    if (idempotency && !/^[\x21-\x7e]{1,128}$/.test(idempotency)) invalid('Idempotency-Key must contain 1–128 printable characters.');
    // Repeated failures with no metered output must not provide unlimited free GPU work.
    // A paused hosting account is not the caller's doing and never counts.
    const failures = await call.env.DB.prepare("SELECT COUNT(*) AS n FROM inference_requests WHERE account_id = ? AND status IN ('failed', 'cancelled') AND charge_micro = 0 AND (failure_code IS NULL OR failure_code != 'hosting_paused') AND created_at > ?").bind(key.account_id, Math.floor(Date.now() / 1000) - 600).first<{ n: number }>();
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
    if (controller.signal.aborted) throw new ApiError('The model request was interrupted. No charge was made.', 503, 'model_unavailable');
    // Starting a worker can itself incur supplier cost. Mark the durable
    // supplier reservation before either a health probe or generation call.
    await markSupplierDispatched(call.env, id);
    // Warm only a Runpod health endpoint. A generation is submitted exactly once,
    // after readiness, so retrying a cold start cannot duplicate paid work.
    if (isRunpod(model.endpoint)) await readyWorker(model, call.env, controller.signal);
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), REQUEST_MS);
    const upstream = await fetch(`${model.endpoint}/v1/chat/completions`, {
      // Workers implements manual/follow, not the browser's error mode.
      // Reject every redirect below without sending credentials to its target.
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${backendKey(model.endpoint, call.env)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.payload),
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      if (upstream.status === 400 || upstream.status === 422) throw new ApiError('The model could not accept this request. Check message structure, context length and tool parameters.', 400, 'model_request_rejected');
      throw new ApiError('The model is starting or temporarily unavailable. Try again shortly.', 503, 'model_unavailable', { retryAfter: 30 });
    }
    if (!parsed.stream) {
      const result = JSON.parse(await boundedBody(upstream, RESPONSE_BYTES));
      tokens = usageCounters(result.usage, model);
      if (!tokens || !Array.isArray(result.choices) || result.choices.length !== 1) throw new ApiError('The model returned an incomplete response. Only confirmed usage is charged.', 502, 'invalid_model_response');
      await settleInference(call.env, id, 'completed', tokens, usageFailure(tokens, model, parsed.maxOutput), hasTerminalChoice(result.choices));
      clean();
      return json({ id, object: 'chat.completion', created: result.created, model: model.id, choices: result.choices, usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output, total_tokens: tokens.input + tokens.output } }, 200, { headers: { 'X-Request-ID': id } });
    }
    const reader = upstream.body.getReader();
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const writeChunk = async (chunk: Uint8Array): Promise<void> => {
      if (controller.signal.aborted) throw new Error('Stream cancelled');
      let stop: () => void = () => {};
      const interrupted = new Promise<never>((_resolve, reject) => {
        stop = () => {
          // A blocked downstream write must not outlive the lease with known
          // usage trapped in the pump. Reject independently of stream teardown.
          reject(new Error('Stream cancelled'));
          void writer.abort(new Error('Stream cancelled')).catch(() => {});
        };
        controller.signal.addEventListener('abort', stop, { once: true });
      });
      try { await Promise.race([writer.write(chunk), interrupted]); }
      finally { controller.signal.removeEventListener('abort', stop); }
    };
    const pump = async () => {
      let buffer = '';
      let bytes = 0;
      let done = false;
      let finalUsage = false;
      let terminalChoice = false;
      const pending: Uint8Array[] = [];
      const forward = async (event: Uint8Array) => {
        // Gate output on confirmed usage. Gateways that report usage only at
        // the end remain SSE-compatible, but their content is held until then.
        if (!tokens) { pending.push(event); return; }
        for (const queued of pending.splice(0)) await writeChunk(queued);
        await writeChunk(event);
      };
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
              const next = usageCounters(chunk.usage, model);
              if (!next || (tokens && (next.input !== tokens.input || next.output < tokens.output))) throw new Error('Invalid model usage');
              tokens = next;
              if (!chunk.choices.length) finalUsage = true;
            }
            if (!chunk.choices.length) continue;
            // A usage event preceding more output is not the terminal meter.
            finalUsage = false;
            terminalChoice = hasTerminalChoice(chunk.choices);
            await forward(encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: chunk.created, model: model.id, choices: chunk.choices })}\n\n`));
          }
        }
        if (!done || !tokens || !finalUsage) throw new Error('Incomplete model stream');
        // Settle before flushing final-only provider output so a downstream
        // disconnect cannot erase confirmed usage or leave a wallet hold open.
        await settleInference(call.env, id, 'completed', tokens, usageFailure(tokens, model, parsed.maxOutput), terminalChoice);
        for (const queued of pending.splice(0)) await writeChunk(queued);
        if (parsed.includeUsage) await writeChunk(encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: model.id, choices: [], usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output, total_tokens: tokens.input + tokens.output } })}\n\n`));
        await writeChunk(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      } catch {
        const aborted = controller.signal.aborted;
        controller.abort();
        await settleInference(call.env, id, 'cancelled', tokens, tokens ? usageFailure(tokens, model, parsed.maxOutput) ?? 'stream_interrupted' : 'unmetered_stream');
        if (aborted) void writer.abort(new Error('Stream cancelled')).catch(() => {});
        else try { await writer.write(encoder.encode(`data: ${JSON.stringify({ error: { message: 'The stream was interrupted. Only confirmed usage is charged.', type: 'server_error', code: 'stream_interrupted' } })}\n\n`)); await writer.close(); } catch { /* The caller disconnected. */ }
      } finally { clean(); await reader.cancel().catch(() => {}); }
    };
    call.ctx.waitUntil(pump());
    return new Response(stream.readable, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-ID': id } });
  } catch (error) {
    console.error('Inference upstream stopped', { name: error instanceof Error ? error.name : 'unknown', aborted: controller.signal.aborted });
    controller.abort();
    clean();
    await settleInference(call.env, id, 'failed', tokens, tokens ? usageFailure(tokens, model, parsed.maxOutput) ?? 'model_failed' : error instanceof ApiError && error.code === 'inference_paused' ? 'hosting_paused' : controller.signal.aborted ? 'upstream_failed' : 'model_failed');
    if (error instanceof ApiError) throw error;
    throw new ApiError(tokens ? 'The model request was interrupted. Only confirmed usage is charged.' : 'The model request was interrupted. No charge was made.', 503, 'model_unavailable', { retryAfter: 30 });
  }
}

async function readyWorker(model: InferenceModel, env: Env, signal: AbortSignal): Promise<void> {
  // Use the full startup allowance. A fixed count of three 60-second probes
  // stopped slower models after about three minutes, before the deadline.
  while (!signal.aborted) {
    let status = 0;
    try {
      const response = await fetch(`${model.endpoint}/health`, {
        headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` }, redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      });
      await response.body?.cancel();
      status = response.status;
    } catch { if (signal.aborted) break; }
    if (status === 200) { noteHosting(env, false); return; }
    // The hosting account has run out: no worker will start until it is replenished.
    if (status === 402) { noteHosting(env, true); throw new ApiError(PAUSED_MESSAGE, 503, 'inference_paused', { retryAfter: 300 }); }
    // Wrong credentials or a changed URL cannot be repaired by warming.
    if (status > 0 && status < 500 && status !== 429 && status !== 408) break;
    if (!signal.aborted) await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(delay); signal.removeEventListener('abort', finish); resolve(); };
      const delay = setTimeout(finish, 15000);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  throw new ApiError('The model is still starting or temporarily unavailable. No charge was made. Try again shortly.', 503, 'model_unavailable', { retryAfter: 30 });
}
