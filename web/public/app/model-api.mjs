import { button, copyText, el } from './ui.mjs';

export const DEFAULT_MODELS = Object.freeze([
  { id: 'cyber-qwen-27b-awq', name: 'Qwen Cyber 27B AWQ', source: 'philbert440/Qwen3.8-27B-Uncensored-Cyber-W4A16-AWQ', revision: 'd6db3e17ccf92e0082001019bf932b34beb81764', license: 'Apache-2.0', quantization: 'AWQ W4A16', description: 'Low-refusal cyber model for code review, security analysis and agent workflows.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 262144, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 3, output_per_million: 36, minimum_request: 0.3 }, reasoning_parameter: 'chat_template_kwargs.enable_thinking' },
  { id: 'orca-cyber-zero-1.5', name: 'OrcaCyber Zero 1.5', source: 'orca/orcacyber-zero-1.5', source_url: 'https://www.orcarouter.ai/api/public/models/orca/orcacyber-zero-1.5', hosting_provider: 'OrcaRouter', revision: null, license: null, quantization: null, description: 'OrcaRouter’s flagship offensive-security and vulnerability-discovery model for exploit verification and defense.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 1000000, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 4, output_per_million: 12, minimum_request: 0.15 } },
  { id: 'orca-cyber-zero-1.0', name: 'OrcaCyber Zero 1.0', source: 'orca/orcacyber-zero-1.0', source_url: 'https://www.orcarouter.ai/api/public/models/orca/orcacyber-zero-1.0', hosting_provider: 'OrcaRouter', revision: null, license: null, quantization: null, description: 'First-generation OrcaCyber Zero security research model for code audit, log triage and PoC validation.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 1000000, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 4, output_per_million: 12, minimum_request: 0.15 } },
  { id: 'glm-5.3-flash-cyber', name: 'GLM-5.3 Flash Cybersecurity', source: 'z-ai/glm-5.3-flash-cybersecurity', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'Fast cybersecurity fine-tune of GLM-5.3 Flash for vulnerability triage, code audit and agent tool loops.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 1048576, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 2, output_per_million: 24, minimum_request: 0.1 } },
  { id: 'deepseek-v4-flash-cyber', name: 'DeepSeek V4 Flash Vision Cyber', source: 'deepseek/deepseek-v4-flash-vision-exp-cybersecurity', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'Cybersecurity-tuned DeepSeek V4 Flash for exploit-path verification, reverse engineering and code review.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 1048576, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 2, output_per_million: 6, minimum_request: 0.05 } },
  { id: 'qwen3.8-27b-cyber', name: 'Qwen 3.8 27B Cybersecurity', source: 'qwen/qwen3.8-27b-cybersecurity', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'Qwen 3.8 27B cybersecurity specialist for deep vulnerability analysis and PoC review.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 262144, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 4, output_per_million: 70, minimum_request: 0.15 } },
  { id: 'gemma-4-26b-cyber', name: 'Gemma 4 26B A4B Cybersecurity', source: 'google/gemma-4-26b-a4b-it-cybersecurity', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'High-throughput 26B-A4B MoE cybersecurity instruction model for rapid code scanning and triage.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 262144, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 2, output_per_million: 5, minimum_request: 0.05 } },
  { id: 'glm-5.3-cyber', name: 'GLM-5.3 Cybersecurity 744B', source: 'z-ai/glm-5.3-cybersecurity', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'Frontier 744B MoE cybersecurity specialist for complex multi-contract invariant and exploit reasoning.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 1048576, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 10, output_per_million: 20, minimum_request: 0.2 } },
  { id: 'glm-5.3-ablit', name: 'GLM-5.3 Low-Refusal 744B', source: 'z-ai/glm-5.3-abliterated', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'Flagship 744B low-refusal reasoning model for red-team verification and proof-of-concept stress testing.', tags: ['uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 1048576, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 10, output_per_million: 18, minimum_request: 0.2 } },
  { id: 'glm-5.3-flash-ablit', name: 'GLM-5.3 Flash Low-Refusal', source: 'z-ai/glm-5.3-flash-abliterated', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'Fast low-refusal GLM-5.3 Flash variant for iterative security analysis and agent harnesses.', tags: ['uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 1048576, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 3, output_per_million: 8, minimum_request: 0.08 } },
  { id: 'cyberstrike-offsec-35b', name: 'CyberStrike OffSec 35B', source: 'huihui-ai/Huihui-CyberStrike-OffSec-35B-abliterated', revision: '01521758ee85df1ed4edaf494c48e20704b80204', license: 'Apache-2.0', quantization: 'BF16', description: 'Low-refusal 35B-A3B MoE security and code-review model tuned for structured tool calls and clean termination.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 262144, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 2, output_per_million: 24, minimum_request: 0.15 }, reasoning_parameter: 'chat_template_kwargs.enable_thinking' },
  { id: 'qwen-coder390-27b-ablit', name: 'Qwen 3.8 27B Coder390 Low-Refusal', source: 'huihui-ai/Huihui-Qwen3.8-27B-Coder390-EfficientThink-abliterated', revision: '14c13fcf593d692a5b96f29afecca6fe2fc030e6', license: 'Apache-2.0', quantization: 'BF16', description: 'Low-refusal 27B coding and security specialist distilled on frontier SFT/RLOO traces with efficient thinking.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 262144, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 3, output_per_million: 38, minimum_request: 0.2 }, reasoning_parameter: 'chat_template_kwargs.enable_thinking' },
  { id: 'kimi-k3-cyber', name: 'Kimi K3 Cybersecurity Two-Stage', source: 'moonshotai/kimi-k3-cybersecurity-two-stage', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'Two-stage Kimi K3 cybersecurity reasoning model for long-context audit trails and exploit validation.', tags: ['cybersecurity'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 1048576, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 8, output_per_million: 12, minimum_request: 0.15 } },
  { id: 'omen-2.0-cyber', name: 'Omen 2.0 Cybersecurity', source: 'audn/omen-2.0-cybersecurity', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'Second-generation Omen security model tuned for vulnerability discovery, triage and defensive verification.', tags: ['cybersecurity', 'uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 1048576, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 8, output_per_million: 14, minimum_request: 0.1 } },
  { id: 'gemma-4-31b-ablit', name: 'Gemma 4 31B Low-Refusal', source: 'google/gemma-4-31b-it-abliterated-v2', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'Dense 31B Gemma 4 instruction model with refusal vectors removed for direct technical security analysis.', tags: ['uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 32768, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 2, output_per_million: 6, minimum_request: 0.08 } },
  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next 80B-A3B', source: 'qwen/qwen3-coder-next', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: '80B-A3B Mixture-of-Experts coding and repository-analysis model built for multi-file agent tool loops.', tags: ['general'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 262140, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 2, output_per_million: 8, minimum_request: 0.08 } },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', source: 'deepseek/deepseek-v4.1-flash', source_url: 'https://api.infron.ai/v1/models', hosting_provider: 'Infron', revision: null, license: null, quantization: null, description: 'High-speed DeepSeek V4.1 Flash reasoning and coding model for large-context security diffs.', tags: ['general'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 1000000, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 1, output_per_million: 4, minimum_request: 0.05 } },
  { id: 'deephat-v1-7b', name: 'DeepHat V1 7B', source: 'DeepHat/DeepHat-V1-7B', revision: '361a5ce60e67c815ff868a253fdfd54364dbb84f', license: 'Apache-2.0 + DeepHat use restrictions', quantization: 'BF16', description: 'A security specialist for code review and technical investigation.', tags: ['cybersecurity'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 32768, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 2, output_per_million: 18, minimum_request: 0.15 } },
  { id: 'orca-qwen-27b', name: 'Orca Qwen 3.8 27B', source: 'orcarouter/Qwen3.8-27B-Uncensored-FP8', revision: '8b4ede700a2ee547a35daa035d5e62d9be05d10d', license: 'Apache-2.0; publisher use conditions apply', quantization: 'FP8', description: 'Orca’s low-refusal Qwen model for coding and agent workflows.', tags: ['uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 262144, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 3, output_per_million: 40, minimum_request: 0.3 }, reasoning_parameter: 'chat_template_kwargs.enable_thinking' },
  { id: 'orca-nex-mini', name: 'Orca Nex N2.5 Mini', source: 'orcarouter/Nex-N2.5-mini-Uncensored-FP8', revision: 'bf828724f25dd45c7dce05c83cdf5b6b3eb5b5f8', license: 'Apache-2.0; publisher use conditions apply', quantization: 'FP8', description: 'Low-refusal Nex model with function tools and structured responses.', tags: ['uncensored'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 262144, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 3, output_per_million: 65, minimum_request: 0.2 }, reasoning_parameter: 'chat_template_kwargs.reasoning_effort' },
  { id: 'hermes-4-14b', name: 'Hermes 4 14B', source: 'NousResearch/Hermes-4-14B-FP8', revision: '36282813f06d5a9438ed08254759f56f970f32ba', license: 'Apache-2.0', quantization: 'FP8', description: 'A compact Hermes model for coding, chat and tool use.', tags: ['general'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 40960, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 2, output_per_million: 20, minimum_request: 0.15 }, reasoning_parameter: 'chat_template_kwargs.thinking' },
  { id: 'hermes-4.3-36b', name: 'Hermes 4.3 36B', source: 'NousResearch/Hermes-4.3-36B', revision: '3899db2b6c4b35f16bde3b570bb7dd2775d56161', license: 'Apache-2.0', quantization: 'BF16', description: 'The larger Hermes option for coding and agent workflows.', tags: ['general'], capabilities: ['text', 'tools', 'streaming', 'structured_output'], context_length: 32768, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 5, output_per_million: 80, minimum_request: 0.35 }, reasoning_parameter: 'chat_template_kwargs.thinking' },
  { id: 'dolphin-mistral-24b', name: 'Dolphin Mistral 24B Venice', source: 'dphn/Dolphin-Mistral-24B-Venice-Edition-FP8', revision: '26bbbeb19e545c8fe1516cb8d8db5c590184c82d', license: 'Apache-2.0', quantization: 'FP8', description: 'Low-refusal Dolphin model for chat and written analysis.', tags: ['uncensored'], capabilities: ['text', 'streaming', 'structured_output'], context_length: 131072, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 3, output_per_million: 40, minimum_request: 0.2 } },
  { id: 'foundation-sec-8b', name: 'Foundation-Sec 1.1 8B', source: 'fdtn-ai/Foundation-Sec-1.1-8B-Instruct', revision: '243b27655e01c87cc04fdb88632be7cd9e55ac1f', license: 'Apache-2.0 + Llama 3.1 Community License', quantization: 'BF16', description: 'Cisco’s security-focused model for analysis and explanations. Built with Llama.', tags: ['cybersecurity'], capabilities: ['text', 'streaming', 'structured_output'], context_length: 65536, max_output_tokens: 8192, pricing: { currency: 'usd', input_per_million: 2, output_per_million: 28, minimum_request: 0.15 } },
].map((model) => ({
  ...model,
  hosting_provider: model.hosting_provider ?? 'RunPod',
  source_url: model.source_url ?? `https://huggingface.co/${model.source.split('/').map(encodeURIComponent).join('/')}`,
  availability: 'unavailable',
})));

// The price views. No request asks for more output than a model allows (8,192
// tokens). Whether a request fits a model's context is checked per model, by
// the gateway's rule (see admits), so a small-context model says a workload is
// too long for it. An agent session is several requests, and each one costs at
// least the model's minimum. A label is a button on a 320px phone: keep it
// short (the details go in `summary`, the line above the cards).
export const WORKLOADS = Object.freeze({
  rates: { label: 'Per 1M tokens', summary: 'USD per million tokens', unit: '', requests: 0, inputTokens: 0, outputTokens: 0, messages: 0 },
  review: { label: 'One review (24K in · 4K out)', summary: 'One review: 24K tokens in, 4K out', unit: 'review', requests: 1, inputTokens: 24000, outputTokens: 4000, messages: 2 },
  agent: { label: 'Agent session (8 requests)', summary: 'Agent session: 8 requests, each 12.5K tokens in and 2K out', unit: 'session', requests: 8, inputTokens: 12500, outputTokens: 2000, messages: 6 },
});

// The gateway admits a request only when its input counted in UTF-8 bytes, a
// template reserve (1,024 bytes, 64 a message) and the output asked for fit in
// the model's context, counted in tokens (parseInference, web/src/inference.ts).
// A token of English text or code is about four bytes, so the estimate counts four.
export const BYTES_PER_TOKEN = 4;
const TEMPLATE_RESERVE = 1024;
const MESSAGE_RESERVE = 64;

/** Would the gateway admit a request of this size on this model? */
export function admits(model, { inputTokens, outputTokens, messages = 2 }) {
  const bytes = inputTokens * BYTES_PER_TOKEN + TEMPLATE_RESERVE + messages * MESSAGE_RESERVE;
  return bytes + outputTokens <= (model.context_length ?? Infinity);
}

/**
 * What a workload costs on one model, the way the gateway charges it
 * (web/src/inference.ts and web/src/api-credits.ts). A request asks for no
 * more output than the model's maximum and must pass the gateway's size rule
 * (admits); one that does not is refused, so it gets no price.
 * Before a request runs, the gateway holds credit for the model's whole
 * context plus the requested output, and refuses the request when the free
 * balance is smaller than that hold. So a balance runs requests only while it
 * still covers the hold, and a workload of several requests needs the hold
 * plus the cost of the requests before the last. Amounts are counted in
 * millionths of a dollar, as the gateway counts them: tokens times the
 * per-million rate.
 *
 * @returns {{ fits: boolean, output: number, capped: boolean, cost: number, hold: number, needed: number, runsPer20: number, runsPer2: number }}
 */
export function estimateRunCost(model, { inputTokens, outputTokens, requests = 1, messages = 2 }) {
  const { pricing } = model;
  const output = Math.min(outputTokens, model.max_output_tokens ?? 8192);
  const capped = output < outputTokens;
  const context = model.context_length ?? Infinity;
  if (!admits(model, { inputTokens, outputTokens: output, messages })) return { fits: false, output, capped, cost: NaN, hold: NaN, needed: NaN, runsPer20: 0, runsPer2: 0 };
  const minimum = Math.round(pricing.minimum_request * 1000000);
  const perRequest = Math.max(minimum, Math.ceil(inputTokens * pricing.input_per_million + output * pricing.output_per_million));
  const hold = Math.max(minimum, Math.ceil(context * pricing.input_per_million + output * pricing.output_per_million));
  const runs = (budget) => (budget < hold ? 0 : Math.floor(Math.floor((budget - hold) / perRequest + 1) / requests));
  const needed = (requests - 1) * perRequest + hold;
  return { fits: true, output, capped, cost: (perRequest * requests) / 1000000, hold: hold / 1000000, needed: needed / 1000000, runsPer20: runs(20000000), runsPer2: runs(2000000) };
}

/** Two decimals of a dollar: 0.3 -> '$0.30'. */
function dollars(amount) {
  return `$${amount.toFixed(2)}`;
}

/** An amount someone must hold, rounded up to the cent so it is never short: 2.193152 -> '$2.20'. */
export function dollarsUp(amount) {
  // Counted in millionths first, as the gateway counts, so float noise cannot add a cent.
  const cents = Math.ceil(Math.round(amount * 1000000) / 10000);
  return `$${(cents / 100).toFixed(2)}`;
}

/** The catalog rate as written: 3 -> 'US$3', 0.75 -> 'US$0.75'. */
function rateText(amount) {
  return `US$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

/** What a card calls a model's state. Until the live catalog answers, nobody knows: 'Not checked'. */
export function availabilityLabel(availability, checked = true) {
  if (!checked) return 'Not checked';
  return availability === 'available' ? 'Available' : availability === 'paused' ? 'Paused' : 'Not available yet';
}

/**
 * What a listed model's state reads as once the catalog's own switch is
 * counted. A catalog that is switched off sells nothing, whatever a model row
 * says, so an available flag never survives. A pause is not "not available
 * yet", though: a model the pause stopped keeps reading paused, which sells
 * nothing either (a card offers a review only on 'available').
 */
function liveState(model, result) {
  if (result?.enabled === true) return model.availability;
  if (result?.status === 'paused' && (model.availability === 'paused' || model.availability === 'available')) return 'paused';
  return 'unavailable';
}

/**
 * The catalog the page shows: the live catalog, which lists only what
 * production is set up to serve, followed by every other known model marked
 * not available yet. A catalog that is switched off sells nothing, whatever a
 * model row says. Available models come first, then paused ones, each group
 * in catalog order.
 */
export function mergeCatalog(result) {
  const live = (Array.isArray(result?.models) ? result.models : []).map((model) => ({ ...model, availability: liveState(model, result) }));
  const listed = new Set(live.map((model) => model.id));
  const rest = DEFAULT_MODELS.filter((model) => !listed.has(model.id)).map((model) => ({ ...model, availability: 'unavailable' }));
  const rank = (model) => (model.availability === 'available' ? 0 : model.availability === 'paused' ? 1 : 2);
  return [...live, ...rest].map((model, index) => ({ model, index })).sort((a, b) => rank(a.model) - rank(b.model) || a.index - b.index).map(({ model }) => model);
}

/** Step 1 of "How to start" while buying credit is closed but the API is open. */
export const BUYING_CLOSED_STEP = Object.freeze({ title: 'Use credit you already hold.', text: 'Buying credit is closed right now. A balance you already have still pays for requests.' });

/**
 * The block at the top of the page, from the live catalog: its heading, the
 * line under it, whether the steps and the first call show (`open`), and
 * whether step 1 can offer to buy credit (`buying`). The heading and the line
 * always tell the same state: open, paused, closed, or unknown when the live
 * check did not answer (result null).
 *
 * @param {{ enabled?: boolean, status?: string, topups_enabled?: boolean } | null} result
 * @param {object[]} models  mergeCatalog(result)
 * @returns {{ state: 'open' | 'paused' | 'closed' | 'unknown', heading: string, line: string, open: boolean, buying: boolean }}
 */
export function todayBlock(result, models = []) {
  if (!result) {
    return { state: 'unknown', heading: 'Availability not checked', line: 'The live check did not answer, so this page cannot say what can be bought or called right now. Refresh the page before adding credit.', open: false, buying: false };
  }
  const available = models.filter((model) => model.availability === 'available');
  if (result.enabled && available.length) {
    const others = models.length - available.length;
    const rest = others ? ` The other ${others} model${others === 1 ? '' : 's'} below ${others === 1 ? 'is' : 'are'} not available yet.` : '';
    const [model] = available;
    const line = available.length === 1
      ? `${model.name} (${model.id}): ${rateText(model.pricing.input_per_million)} per million input tokens, ${rateText(model.pricing.output_per_million)} per million output tokens, at least ${rateText(model.pricing.minimum_request)} a request.${rest}`
      : `${available.map((entry) => entry.name).join(', ')}. Each card below shows its price.${rest}`;
    return { state: 'open', heading: 'Available today', line, open: true, buying: result.topups_enabled === true };
  }
  if (result.status === 'paused' || models.some((entry) => entry.availability === 'paused')) {
    return { state: 'paused', heading: 'Paused right now', line: 'No request runs and no credit can be bought until it resumes. Credit you already hold is kept.', open: false, buying: false };
  }
  return { state: 'closed', heading: 'Not open right now', line: 'No model can be bought or called. Reviews on your own AI provider API key work today.', open: false, buying: false };
}

/** Puts todayBlock on the page: heading, line, steps and step 1. */
function showToday(block) {
  const start = document.getElementById('model-api-start');
  const heading = document.getElementById('start');
  const line = document.getElementById('model-api-today');
  const buy = document.getElementById('model-api-step-buy');
  if (heading) heading.textContent = block.heading;
  // The built line says the same thing while nothing has changed; it keeps its markup then.
  if (line && line.textContent.trim() !== block.line) line.textContent = block.line;
  if (start) {
    start.dataset.state = block.state;
    start.dataset.open = String(block.open);
  }
  if (buy && block.open && !block.buying) buy.replaceChildren(el('strong', { text: BUYING_CLOSED_STEP.title }), ` ${BUYING_CLOSED_STEP.text}`);
}

export function buildSnippet(model, tab = 'curl') {
  const id = model?.id ?? 'cyber-qwen-27b-awq';
  const param = model?.reasoning_parameter ?? '';
  const extra = param.endsWith('.reasoning_effort')
    ? ',\n  "reasoning_effort": "low"'
    : param.startsWith('chat_template_kwargs.')
      ? `,\n  "chat_template_kwargs": { "${param.slice('chat_template_kwargs.'.length)}": false }`
      : '';
  if (tab === 'python') {
    return `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url="https://bountyoperator.com/v1",\n    api_key=os.environ["BOUNTY_OPERATOR_API_KEY"],\n)\n\nres = client.chat.completions.create(\n    model="${id}",\n    messages=[\n        {"role": "system", "content": "Focus on concrete security bugs and proof paths."},\n        {"role": "user", "content": "Review withdraw() for re-entrancy and accounting invariants."},\n    ],\n    max_tokens=2048,\n)\nprint(res.choices[0].message.content)`;
  }
  if (tab === 'ts') {
    return `const res = await fetch("https://bountyoperator.com/v1/chat/completions", {\n  method: "POST",\n  headers: {\n    "Authorization": \`Bearer \${process.env.BOUNTY_OPERATOR_API_KEY}\`,\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({\n    model: "${id}",\n    messages: [\n      { role: "user", content: "Check this diff for broken invariants and exploit paths." }\n    ],\n    max_tokens: 2048${extra ? extra.replace(/\n  /g, '\n    ') : ''}\n  }),\n});\nconst data = await res.json();\nconsole.log(data.choices[0].message.content);`;
  }
  if (tab === 'agent') {
    return `# Settings for a tool that takes an OpenAI-compatible base URL\nbase_url = "https://bountyoperator.com/v1"\napi_key_env = "BOUNTY_OPERATOR_API_KEY"\nmodel = "${id}"\ncontext_window = ${model?.context_length ?? 262144}\nmax_output_tokens = ${model?.max_output_tokens ?? 8192}`;
  }
  return `curl https://bountyoperator.com/v1/chat/completions \\\n  -H "Authorization: Bearer $BOUNTY_OPERATOR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n  "model": "${id}",\n  "messages": [\n    { "role": "user", "content": "Trace every external call and state update in withdraw()." }\n  ],\n  "max_tokens": 2048${extra}\n}'`;
}

function familyMark(model) {
  const text = `${model.name ?? ''} ${model.source ?? ''}`;
  if (/qwen/i.test(text)) return 'Q';
  if (/deephat|deepseek/i.test(text)) return 'D';
  if (/dolphin|mistral/i.test(text)) return 'M';
  if (/orca|nex/i.test(text)) return 'O';
  if (/hermes|nous/i.test(text)) return 'H';
  if (/foundation|cisco/i.test(text)) return 'F';
  if (/cyberstrike/i.test(text)) return 'C';
  if (/glm|z-ai/i.test(text)) return 'Z';
  if (/gemma|google/i.test(text)) return 'G';
  if (/nemotron|nvidia/i.test(text)) return 'N';
  return (model.name ?? 'M').trim().charAt(0).toUpperCase();
}

function categoryPills(model) {
  const tags = model.tags ?? [];
  const pills = [];
  if (tags.includes('cybersecurity')) pills.push(el('span', { class: 'catalog-pill', dataset: { badge: 'cybersecurity' }, text: 'Cybersecurity' }));
  if (tags.includes('uncensored')) pills.push(el('span', { class: 'catalog-pill', dataset: { badge: 'low-refusal' }, text: 'Low refusal' }));
  if (!pills.length) pills.push(el('span', { class: 'catalog-pill', dataset: { badge: 'general' }, text: 'General' }));
  return pills;
}

function modelCard(model, { workload, activeId, onSelect, checked }) {
  const copied = el('span', { role: 'status', class: 'help catalog-copied' });
  const copyButton = (label, value) => button({ label, size: 'sm', variant: 'secondary', attrs: { 'aria-label': `${label} for ${model.name}` }, onClick: async () => { copied.textContent = await copyText(value) ? `${label === 'Copy model ID' ? 'Model ID' : 'Base URL'} copied.` : 'Select and copy the value above.'; } });
  const rate = (label, value, wide = false) => el('div', { class: wide ? 'catalog-rate catalog-rate--wide' : 'catalog-rate' }, el('dt', { text: label }), el('dd', null, el('strong', { text: value })));
  const hasTools = (model.capabilities ?? []).includes('tools');
  const spec = WORKLOADS[workload] ?? WORKLOADS.rates;
  const rateBoxes = spec.requests > 0
    ? (() => {
      const est = estimateRunCost(model, spec);
      if (!est.fits) return [rate(`Per ${spec.unit}`, 'Too long for this model', true)];
      // A balance too small for one whole workload runs none: say what one takes.
      const runs = (count) => (count > 0 ? `${count} ${spec.unit}${count === 1 ? '' : 's'}` : `Needs ${dollarsUp(est.needed)}`);
      return [
        rate(est.capped ? `Per ${spec.unit} (${est.output.toLocaleString()} out)` : `Per ${spec.unit}`, dollars(est.cost)),
        rate('With US$20', runs(est.runsPer20)),
        rate('With US$2', runs(est.runsPer2)),
      ];
    })()
    : [
      rate('Input', `$${model.pricing.input_per_million}`),
      rate('Output', `$${model.pricing.output_per_million}`),
      rate('Min', dollars(model.pricing.minimum_request)),
    ];
  const isSelected = activeId === model.id;
  const available = model.availability === 'available';
  const availability = availabilityLabel(model.availability, checked);
  const undisclosed = 'Not disclosed by provider';
  const source = model.source_url
    ? el('a', { href: model.source_url, text: model.source, target: '_blank', rel: 'noopener noreferrer' })
    : model.source ?? undisclosed;
  return el('section', { class: 'catalog-card', dataset: { selected: isSelected ? 'true' : 'false', availability: model.availability ?? 'unavailable' }, 'aria-label': model.name },
    el('div', { class: 'catalog-card__main' },
      el('div', { class: 'catalog-card__identity' },
        el('span', { class: 'catalog-mark', 'aria-hidden': 'true', text: familyMark(model) }),
        el('div', { class: 'catalog-card__titles' },
          el('h3', { text: model.name }),
          el('p', { class: 'catalog-card__sub' },
            el('code', { class: 'catalog-slug', text: model.id }),
            el('span', { class: 'catalog-meta', text: `${Math.round(model.context_length / 1024)}K ctx · ${model.quantization ?? undisclosed} · ${hasTools ? 'Agent tools' : 'Chat only'}` }),
          ),
        ),
      ),
      el('div', { class: 'catalog-card__badges', 'aria-label': 'Model category and availability' }, ...categoryPills(model), el('span', { class: 'catalog-pill', dataset: { availability: model.availability ?? 'unavailable' }, text: availability })),
      el('dl', { class: 'catalog-rates' }, ...rateBoxes),
    ),
    el('div', { class: 'catalog-card__bar' },
      el('details', { class: 'catalog-details' }, el('summary', { text: 'Connection & model details', 'aria-label': `Connection and model details for ${model.name}` }),
        model.description && el('p', { class: 'catalog-desc', text: model.description }),
        el('div', { class: 'catalog-connect' },
          el('div', null, el('p', { class: 'help', text: 'Model ID' }), el('code', { text: model.id }), copyButton('Copy model ID', model.id)),
          el('div', null, el('p', { class: 'help', text: 'Base URL' }), el('code', { text: 'https://bountyoperator.com/v1' }), copyButton('Copy base URL', 'https://bountyoperator.com/v1')),
        ),
        copied,
        el('p', { class: 'help', text: `${model.context_length.toLocaleString()} token context · ${model.max_output_tokens.toLocaleString()} maximum output · ${model.quantization ?? undisclosed} · ${(model.capabilities ?? []).map((value) => value.replaceAll('_', ' ')).join(' · ')}` }),
        el('p', { class: 'help' }, 'Source: ', source, ` · License: ${model.license ?? undisclosed} · `, el('a', { href: '/docs/model-api', text: 'Setup guide' })),
        el('p', { class: 'help', text: `Hosting provider: ${model.hosting_provider ?? undisclosed} · ${availability}` }),
        model.reasoning_parameter && el('p', { class: 'help' }, 'Reasoning control: ', el('code', { text: model.reasoning_parameter })),
        el('p', { class: 'help' }, 'Revision: ', el('code', { text: model.revision ?? undisclosed })),
      ),
      el('div', { class: 'catalog-filter-buttons' },
        button({
          label: isSelected ? 'In quickstart' : 'Use in quickstart',
          size: 'sm',
          variant: 'secondary',
          attrs: { 'aria-pressed': isSelected ? 'true' : 'false', 'aria-label': `Use ${model.name} in quickstart snippet` },
          onClick: () => onSelect(model.id, true),
        }),
        available ? el('a', {
          class: 'btn btn--secondary btn--sm',
          href: `/?provider=bountyoperator&model=${encodeURIComponent(model.id)}#workspace`,
          'aria-label': `Use ${model.name} in review`,
        }, el('span', { class: 'btn__label', text: 'Use in review' })) : null,
      ),
    ),
  );
}

// checked is false until the live catalog answers: the cards are shown, their state is not claimed.
function mountCatalog(modelsList, { checked = true } = {}) {
  const catalog = document.getElementById('model-api-catalog');
  const quickstart = document.getElementById('model-api-quickstart');
  if (!catalog) return;
  const list = el('div', { class: 'catalog-grid' });
  const count = el('p', { class: 'help catalog-count', role: 'status' });
  const search = el('input', { id: 'catalog-search', class: 'input', type: 'search', placeholder: 'Search by model name, ID or family' });
  let selectedFilter = '';
  let selectedWorkload = 'rates';
  // The quickstart starts on a model that can be called, when there is one.
  let activeModelId = (modelsList.find((model) => model.availability === 'available') ?? modelsList[0])?.id ?? 'cyber-qwen-27b-awq';
  let activeTab = 'curl';
  const filters = [['', 'All'], ['cybersecurity', 'Cybersecurity'], ['uncensored', 'Low refusal'], ['tools', 'Agent tools']];
  const filterButtons = filters.map(([value, label]) => button({ label: `${label} (${modelsList.filter((model) => !value || [...(model.tags ?? []), ...(model.capabilities ?? [])].includes(value)).length})`, size: 'sm', variant: 'secondary', attrs: { 'aria-pressed': value === '' ? 'true' : 'false' }, onClick: () => {
    selectedFilter = value;
    filterButtons.forEach((item, index) => item.setAttribute('aria-pressed', filters[index][0] === value ? 'true' : 'false'));
    render();
  } }));
  const holdNote = el('p', { class: 'help catalog-hold', hidden: true, text: 'Before each request runs, credit is held for a full context window of input plus the output asked for, and what is not used comes back when it ends. So a small balance starts fewer requests than its size suggests.' });
  const workloadEntries = Object.entries(WORKLOADS);
  const workloadButtons = workloadEntries.map(([key, spec]) => button({ label: spec.label, size: 'sm', variant: 'secondary', attrs: { 'aria-pressed': key === selectedWorkload ? 'true' : 'false' }, onClick: () => {
    selectedWorkload = key;
    workloadButtons.forEach((item, index) => item.setAttribute('aria-pressed', workloadEntries[index][0] === key ? 'true' : 'false'));
    render();
  } }));

  const snippetCode = el('pre', { class: 'catalog-quickstart__code' });
  const snippetModel = el('code', { class: 'catalog-slug' });
  const snippetStatus = el('span', { role: 'status', class: 'help catalog-copied' });
  const tabs = [['curl', 'curl'], ['python', 'Python'], ['ts', 'TypeScript'], ['agent', 'Tool settings']];
  const tabButtons = tabs.map(([id, label]) => button({ label, size: 'sm', variant: 'secondary', attrs: { 'aria-pressed': id === activeTab ? 'true' : 'false' }, onClick: () => {
    activeTab = id;
    tabButtons.forEach((item, index) => item.setAttribute('aria-pressed', tabs[index][0] === id ? 'true' : 'false'));
    renderQuickstart();
  } }));

  const renderQuickstart = () => {
    if (!quickstart) return;
    const chosen = modelsList.find((entry) => entry.id === activeModelId) ?? modelsList[0];
    if (!chosen) return;
    snippetModel.textContent = `${chosen.name} (${chosen.id}) · $${chosen.pricing.input_per_million}/$${chosen.pricing.output_per_million} per 1M${!checked || chosen.availability === 'available' ? '' : ` · ${availabilityLabel(chosen.availability).toLowerCase()}`}`;
    snippetCode.textContent = buildSnippet(chosen, activeTab);
    snippetStatus.textContent = '';
  };

  const selectModel = (id, scroll = false) => {
    activeModelId = id;
    render();
    renderQuickstart();
    if (scroll && quickstart) quickstart.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const render = () => {
    const query = search.value.trim().toLowerCase().replace(/\b(?:unfiltered|low[- ]refusal|abliterated)\b/g, 'uncensored');
    const filtered = modelsList.filter((model) => {
      const labels = [...(model.tags ?? []), ...(model.capabilities ?? [])];
      return (!selectedFilter || labels.includes(selectedFilter)) && [model.id, model.name, model.source, model.description, ...labels].join(' ').toLowerCase().includes(query);
    });
    count.textContent = `${filtered.length} of ${modelsList.length} models · ${WORKLOADS[selectedWorkload].summary}`;
    holdNote.hidden = selectedWorkload === 'rates';
    // Once the live catalog has answered, a heading opens each group, so where the models that can be used end is plain.
    const cards = [];
    for (const [index, model] of filtered.entries()) {
      const label = availabilityLabel(model.availability);
      if (checked && (index === 0 || availabilityLabel(filtered[index - 1].availability) !== label)) {
        const size = filtered.filter((entry) => availabilityLabel(entry.availability) === label).length;
        cards.push(el('p', { class: 'catalog-group', dataset: { availability: model.availability ?? 'unavailable' }, text: `${label} (${size})` }));
      }
      cards.push(modelCard(model, { workload: selectedWorkload, activeId: activeModelId, onSelect: selectModel, checked }));
    }
    list.replaceChildren(...(cards.length ? cards : [el('p', { class: 'catalog-empty', text: 'No models match these filters.' })]));
  };

  search.addEventListener('input', render);
  catalog.replaceChildren(
    el('div', { class: 'catalog-filters' },
      el('div', { class: 'field' }, el('label', { class: 'label', for: 'catalog-search', text: 'Find a model' }), search),
      el('div', { class: 'catalog-filter-buttons', role: 'group', 'aria-label': 'Filter models' }, ...filterButtons),
    ),
    el('div', { class: 'catalog-workload' },
      el('span', { class: 'help', text: 'Price view:' }),
      el('div', { class: 'catalog-filter-buttons', role: 'group', 'aria-label': 'Price view' }, ...workloadButtons),
    ),
    holdNote,
    count,
    list,
  );
  if (quickstart) {
    quickstart.replaceChildren(
      el('div', { class: 'catalog-quickstart__head' },
        el('div', null, el('h3', { text: 'Quickstart snippet' }), snippetModel),
        el('div', { class: 'catalog-filter-buttons', role: 'group', 'aria-label': 'Snippet language' },
          ...tabButtons,
          button({ label: 'Copy snippet', size: 'sm', variant: 'primary', onClick: async () => {
            snippetStatus.textContent = await copyText(snippetCode.textContent) ? 'Snippet copied.' : 'Select and copy the snippet below.';
          } }),
        ),
      ),
      snippetStatus,
      snippetCode,
    );
  }
  render();
  renderQuickstart();
}

export async function loadCatalog() {
  const status = document.getElementById('model-api-status');
  mountCatalog(DEFAULT_MODELS, { checked: false });
  try {
    const response = await fetch('/api/inference/catalog');
    if (!response.ok) throw new Error('Catalog unavailable');
    const result = await response.json();
    if (!Array.isArray(result.models)) throw new Error('Catalog unavailable');
    const models = mergeCatalog(result);
    mountCatalog(models);
    const available = models.filter((model) => model.availability === 'available').length;
    if (status) status.textContent = result.enabled ? `${available} of ${models.length} model${models.length === 1 ? '' : 's'} available now.${result.topups_enabled ? '' : ' Buying credit is closed right now.'}` : result.status === 'paused' ? 'Model inference is paused right now. Top-ups are closed until it resumes; existing credit is unaffected.' : 'Not open right now, so no model below can be bought or called. Reviews on your own AI provider API key work today.';
    // The top of the page follows the live catalog: its heading and line say the
    // same state, and the steps and the first call show only while they lead somewhere.
    showToday(todayBlock(result, models));
  } catch {
    if (status) status.textContent = 'Availability could not be checked. Refresh this page before adding credit.';
    showToday(todayBlock(null));
  }
}
if (typeof document !== 'undefined') loadCatalog();
