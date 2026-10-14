import { button, closingBand, html } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { ACCOUNT_SCRIPTS, ACCOUNT_STYLES, accountDialog } from '../../fragments/account-dialog.mjs';
import { DOCS_STYLES, docHead } from './_shared.mjs';

const INFRON_STACK = [
  { mark: 'Z', name: 'GLM-5.3 Flash Cybersecurity', id: 'z-ai/glm-5.3-flash-cybersecurity', badge: 'cybersecurity', badgeLabel: 'Cybersecurity', role: 'Fast security triage & tool use', input: '0.75', output: '12.50' },
  { mark: 'D', name: 'DeepSeek V4 Flash Vision Exp Cybersecurity', id: 'deepseek/deepseek-v4-flash-vision-exp-cybersecurity', badge: 'cybersecurity', badgeLabel: 'Cybersecurity', role: 'Cross-vendor fallback · multimodal security analysis', input: '0.75', output: '2.50' },
  { mark: 'Q', name: 'Qwen3.8 27B Cybersecurity', id: 'qwen/qwen3.8-27b-cybersecurity', badge: 'cybersecurity', badgeLabel: 'Cybersecurity', role: 'Deep code review & vulnerability reasoning', input: '1.25–2.00', output: '8.00–37.50' },
  { mark: 'G', name: 'Gemma 4 26B A4B IT Cybersecurity', id: 'google/gemma-4-26b-a4b-it-cybersecurity', badge: 'cybersecurity', badgeLabel: 'Cybersecurity', role: 'MoE security instruction model · high throughput', input: '0.60', output: '1.90' },
  { mark: 'Z', name: 'GLM-5.3 Low-Refusal', id: 'z-ai/glm-5.3-abliterated', badge: 'low-refusal', badgeLabel: 'Low refusal', role: 'Flagship low-refusal reasoning & proof stress-testing', input: '6.00', output: '9.00' },
  { mark: 'Z', name: 'GLM-5.3 Flash Low-Refusal', id: 'z-ai/glm-5.3-flash-abliterated', badge: 'low-refusal', badgeLabel: 'Low refusal', role: 'Fast low-refusal variant for iterative red-team drafts', input: '1.25', output: '4.00' },
  { mark: 'N', name: 'NVIDIA Nemotron 3.5 Content Safety', id: 'nvidia/nemotron-3.5-content-safety', badge: 'general', badgeLabel: 'Content safety', role: 'Safety classifier & policy-gate verification', input: '0.05', output: '0.15' },
];

const body = html`<article class="docs wrap model-api-page">
${docHead({
  crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Model API' }],
  title: 'Cybersecurity model API.',
  lede: 'Cybersecurity fine-tunes and lower-refusal variants through one OpenAI-compatible API. One key. Prepaid credit.',
  actions: html`${button({ label: 'Get an API key', href: '/#account/api', variant: 'primary', size: 'lg' })}${button({ label: 'Browse models', href: '#models', variant: 'secondary', size: 'lg' })}${button({ label: 'Setup guide', href: '/docs/model-api', variant: 'secondary', size: 'lg' })}`,
})}
<ul class="api-highlights" aria-label="API features"><li>OpenAI-compatible <code>/v1</code></li><li>Prepaid credit or US$2/mo on Operator</li><li>Per-key spending caps</li><li>No prompt or response storage in our application</li></ul>
<p class="help">Requests also pass to the selected hosting provider, whose data policies apply. Read the <a href="/privacy#model-api">provider and data handling details</a>.</p>
<div class="api-content">
<section class="docs-section" aria-labelledby="models">
<div class="catalog-heading"><h2 id="models">Hosted security catalog</h2><p class="help">USD per 1M tokens · minimum per request · switch workload view to estimate run cost</p></div>
<p class="help catalog-status" role="status" id="model-api-status">Checking model availability…</p>
<div id="model-api-catalog"></div>
<div id="model-api-quickstart" class="catalog-quickstart" aria-label="Interactive quickstart"></div>
<noscript><p>Enable JavaScript to filter models, estimate workload costs and copy model snippets. Full reference: <a href="/docs/model-api">/docs/model-api</a>.</p></noscript>
<p class="help catalog-footnote">The first request after idle can take several minutes while the model starts. <a href="/docs/model-api#cost">What to expect</a></p>
</section>
<section class="docs-section" aria-labelledby="infron-stack">
<div class="catalog-heading"><h2 id="infron-stack">Infron cybersecurity stack (BYO key)</h2><p class="help">Infron’s own USD rates per 1M tokens with your Infron key · separate from the prepaid catalog above</p></div>
<p class="lede catalog-section-lede">Already have an <a href="https://infron.ai/dashboard/apiKeys" target="_blank" rel="noopener noreferrer">Infron API key</a>? All seven models in Infron’s cybersecurity stack are wired directly into Bounty Operator. Open any model in the review workbench with one click, or pass <code>--provider infron</code> in the CLI and MCP server.</p>
<div class="catalog-grid">
${INFRON_STACK.map((m) => html`<section class="catalog-card" aria-label="${m.name}">
<div class="catalog-card__main">
<div class="catalog-card__identity">
<span class="catalog-mark" aria-hidden="true">${m.mark}</span>
<div class="catalog-card__titles">
<h3>${m.name}</h3>
<p class="catalog-card__sub"><code class="catalog-slug">${m.id}</code><span class="catalog-meta">${m.role}</span></p>
</div>
</div>
<div class="catalog-card__badges" aria-label="Model category"><span class="catalog-pill" data-badge="${m.badge}">${m.badgeLabel}</span></div>
<div class="catalog-rates catalog-rates--byok">
<dl class="catalog-rates__pair">
<div class="catalog-rate"><dt>Input</dt><dd><strong>$${m.input}</strong></dd></div>
<div class="catalog-rate"><dt>Output</dt><dd><strong>$${m.output}</strong></dd></div>
</dl>
${button({ label: 'Use in review', href: `/?provider=infron&model=${encodeURIComponent(m.id)}#workspace`, variant: 'secondary', size: 'sm' })}
</div>
</div>
</section>`)}
</div>
<p class="help catalog-footnote">Infron rates checked 14 October 2026. Rates vary by the upstream provider used; ranges show the listed routes. Platform fees are separate. Check <a href="https://api.infron.ai/v1/models" target="_blank" rel="noopener noreferrer">Infron’s current model rates</a> and <a href="https://infron.ai/docs/overview/pricing-and-fee-structure" target="_blank" rel="noopener noreferrer">fees</a> before using your own key.</p>
</section>
<section class="docs-section" aria-labelledby="pricing">
<div class="api-start">
<div><h2 id="pricing">One balance.<br>Every model.</h2><p class="lede">Add US$20, US$50 or US$100.<br>No subscription required. Auto top-ups are off by default.</p>${button({ label: 'Get an API key', href: '/#account/api', variant: 'primary', size: 'lg' })}</div>
<div class="prose"><h3>Pay for what you use</h3><p>Each request costs the token price or the model’s minimum charge, whichever is higher. Requests with no confirmed usage are not charged.</p><p>Credit does not expire. The US$10 monthly Operator plan also includes US$2 in API credit per paid month.</p><p><a href="/docs/model-api#cost">How billing works</a> · <a href="/terms#api-credit">Credit and refund terms</a> · <a href="/privacy#model-api">Data handling</a></p></div>
</div>
<p class="fine catalog-footnote">For authorized security work. Models can make mistakes; check their answers. <a href="/docs/model-api#scope">Model licenses and use</a></p>
</section>
</div>
${closingBand({
  title: 'Ready to connect your agent or run a review?',
  text: 'Create a prepaid Model API key for /v1/chat/completions, or start a free review with your own provider key.',
  actions: [
    { label: 'Get an API key', href: '/#account/api' },
    { label: 'Start a free review', href: '/#workspace' },
    { label: 'Setup guide', href: '/docs/model-api' },
  ],
  note: 'Our application does not store prompts or responses. The hosting provider’s data policies also apply.',
})}
</article>`;

export default {
  path: '/model-api', title: 'Cyber model API with prepaid credit | Bounty Operator', label: 'Model API', nav: 'model-api',
  description: 'Use cyber models in your own agents and chat tools. Browse live prices, add prepaid credit and set spending limits for each API key.',
  styles: [...DOCS_STYLES, ...ACCOUNT_STYLES, '/css/catalog.css'], scripts: [...ACCOUNT_SCRIPTS, '/app/model-api.mjs'], overlays: accountDialog(),
  jsonld: [breadcrumbsLd([{ name: 'Model API', path: '/model-api' }])], lastmod: '2026-10-14', body,
};
