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

const WORKLOADS = Object.freeze({
  rates: { label: 'Per 1M tokens', inputTokens: 0, outputTokens: 0 },
  review: { label: 'Review run (24K in · 4K out)', inputTokens: 24000, outputTokens: 4000 },
  agent: { label: 'Agent session (100K in · 16K out)', inputTokens: 100000, outputTokens: 16000 },
});

export function estimateRunCost(pricing, inputTokens, outputTokens) {
  const metered = (inputTokens / 1000000) * pricing.input_per_million + (outputTokens / 1000000) * pricing.output_per_million;
  const cost = Math.max(pricing.minimum_request, metered);
  return { cost, runsPer20: Math.floor(20 / cost), runsPer2: Math.floor(2 / cost) };
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
    return `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="https://bountyoperator.com/v1",\n    api_key="bo_api_...",\n)\n\nres = client.chat.completions.create(\n    model="${id}",\n    messages=[\n        {"role": "system", "content": "Focus on concrete security bugs and proof paths."},\n        {"role": "user", "content": "Review withdraw() for re-entrancy and accounting invariants."},\n    ],\n    max_tokens=2048,\n)\nprint(res.choices[0].message.content)`;
  }
  if (tab === 'ts') {
    return `const res = await fetch("https://bountyoperator.com/v1/chat/completions", {\n  method: "POST",\n  headers: {\n    "Authorization": \`Bearer \${process.env.BOUNTY_OPERATOR_API_KEY}\`,\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({\n    model: "${id}",\n    messages: [\n      { role: "user", content: "Check this diff for broken invariants and exploit paths." }\n    ],\n    max_tokens: 2048${extra ? extra.replace(/\n  /g, '\n    ') : ''}\n  }),\n});\nconst data = await res.json();\nconsole.log(data.choices[0].message.content);`;
  }
  if (tab === 'agent') {
    return `# OpenAI-compatible harness settings (Codex / OpenCode / Continue)\nbase_url = "https://bountyoperator.com/v1"\napi_key_env = "BOUNTY_OPERATOR_API_KEY"\nmodel = "${id}"\ncontext_window = ${model?.context_length ?? 262144}\nmax_output_tokens = ${model?.max_output_tokens ?? 8192}`;
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

function modelCard(model, { workload, activeId, onSelect }) {
  const copied = el('span', { role: 'status', class: 'help catalog-copied' });
  const copyButton = (label, value) => button({ label, size: 'sm', variant: 'secondary', attrs: { 'aria-label': `${label} for ${model.name}` }, onClick: async () => { copied.textContent = await copyText(value) ? `${label === 'Copy model ID' ? 'Model ID' : 'Base URL'} copied.` : 'Select and copy the value above.'; } });
  const rate = (label, value) => el('div', { class: 'catalog-rate' }, el('dt', { text: label }), el('dd', null, el('strong', { text: value })));
  const hasTools = (model.capabilities ?? []).includes('tools');
  const spec = WORKLOADS[workload] ?? WORKLOADS.rates;
  const rateBoxes = spec.inputTokens > 0
    ? (() => {
      const est = estimateRunCost(model.pricing, spec.inputTokens, spec.outputTokens);
      return [
        rate('Est / run', `$${est.cost.toFixed(2)}`),
        rate('$20 credit', `${est.runsPer20} runs`),
        rate('$2 plan', `${est.runsPer2} runs`),
      ];
    })()
    : [
      rate('Input', `$${model.pricing.input_per_million}`),
      rate('Output', `$${model.pricing.output_per_million}`),
      rate('Min', `$${model.pricing.minimum_request.toFixed(2)}`),
    ];
  const isSelected = activeId === model.id;
  const available = model.availability === 'available';
  const availability = available ? 'Available' : model.availability === 'paused' ? 'Paused' : 'Unavailable';
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
      el('div', { class: 'catalog-card__badges', 'aria-label': 'Model category and availability' }, ...categoryPills(model), el('span', { class: 'catalog-pill', text: availability })),
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
        }, el('span', { class: 'btn__label', text: 'Use in review' })) : button({ label: availability, size: 'sm', variant: 'secondary', disabled: true, attrs: { 'aria-label': `${model.name} is ${availability.toLowerCase()} for review` } }),
      ),
    ),
  );
}

function mountCatalog(modelsList) {
  const catalog = document.getElementById('model-api-catalog');
  const quickstart = document.getElementById('model-api-quickstart');
  if (!catalog) return;
  const list = el('div', { class: 'catalog-grid' });
  const count = el('p', { class: 'help catalog-count', role: 'status' });
  const search = el('input', { id: 'catalog-search', class: 'input', type: 'search', placeholder: 'Search by model name, ID or family' });
  let selectedFilter = '';
  let selectedWorkload = 'rates';
  let activeModelId = modelsList[0]?.id ?? 'cyber-qwen-27b-awq';
  let activeTab = 'curl';
  const filters = [['', 'All'], ['cybersecurity', 'Cybersecurity'], ['uncensored', 'Low refusal'], ['tools', 'Agent tools']];
  const filterButtons = filters.map(([value, label]) => button({ label: `${label} (${modelsList.filter((model) => !value || [...(model.tags ?? []), ...(model.capabilities ?? [])].includes(value)).length})`, size: 'sm', variant: 'secondary', attrs: { 'aria-pressed': value === '' ? 'true' : 'false' }, onClick: () => {
    selectedFilter = value;
    filterButtons.forEach((item, index) => item.setAttribute('aria-pressed', filters[index][0] === value ? 'true' : 'false'));
    render();
  } }));
  const workloadEntries = Object.entries(WORKLOADS);
  const workloadButtons = workloadEntries.map(([key, spec]) => button({ label: spec.label, size: 'sm', variant: 'secondary', attrs: { 'aria-pressed': key === selectedWorkload ? 'true' : 'false' }, onClick: () => {
    selectedWorkload = key;
    workloadButtons.forEach((item, index) => item.setAttribute('aria-pressed', workloadEntries[index][0] === key ? 'true' : 'false'));
    render();
  } }));

  const snippetCode = el('pre', { class: 'catalog-quickstart__code' });
  const snippetModel = el('code', { class: 'catalog-slug' });
  const snippetStatus = el('span', { role: 'status', class: 'help catalog-copied' });
  const tabs = [['curl', 'curl'], ['python', 'Python'], ['ts', 'TypeScript'], ['agent', 'Agent config']];
  const tabButtons = tabs.map(([id, label]) => button({ label, size: 'sm', variant: 'secondary', attrs: { 'aria-pressed': id === activeTab ? 'true' : 'false' }, onClick: () => {
    activeTab = id;
    tabButtons.forEach((item, index) => item.setAttribute('aria-pressed', tabs[index][0] === id ? 'true' : 'false'));
    renderQuickstart();
  } }));

  const renderQuickstart = () => {
    if (!quickstart) return;
    const chosen = modelsList.find((entry) => entry.id === activeModelId) ?? modelsList[0];
    if (!chosen) return;
    snippetModel.textContent = `${chosen.name} (${chosen.id}) · $${chosen.pricing.input_per_million}/$${chosen.pricing.output_per_million} per 1M`;
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
    count.textContent = `${filtered.length} of ${modelsList.length} models · ${WORKLOADS[selectedWorkload].label}`;
    list.replaceChildren(...(filtered.length ? filtered.map((model) => modelCard(model, { workload: selectedWorkload, activeId: activeModelId, onSelect: selectModel })) : [el('p', { class: 'catalog-empty', text: 'No models match these filters.' })]));
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
  mountCatalog(DEFAULT_MODELS);
  try {
    const response = await fetch('/api/inference/catalog');
    if (!response.ok) throw new Error('Catalog unavailable');
    const result = await response.json();
    if (!Array.isArray(result.models)) throw new Error('Catalog unavailable');
    const models = result.models.map((model) => ({ ...model, availability: result.enabled === true ? model.availability : 'unavailable' }));
    mountCatalog(models);
    const available = models.filter((model) => model.availability === 'available').length;
    if (status) status.textContent = result.enabled ? `${available} of ${models.length} model${models.length === 1 ? '' : 's'} available.${result.topups_enabled ? '' : ' Customer top-ups are currently closed.'}` : result.status === 'paused' ? 'Model inference is paused right now. Top-ups are closed until it resumes; existing credit is unaffected.' : 'Not open for purchases yet, so no model below can be used today. Reviews with your own model key work now. Check back here: this line changes when the API opens.';
  } catch {
    if (status) status.textContent = 'Availability could not be checked. Refresh this page before adding credit.';
  }
}
if (typeof document !== 'undefined') loadCatalog();
