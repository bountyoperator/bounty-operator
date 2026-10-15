import { button, closingBand, codeBlock, html } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { ACCOUNT_SCRIPTS, ACCOUNT_STYLES, accountDialog } from '../../fragments/account-dialog.mjs';
import { DEFAULT_MODELS, buildSnippet, mergeCatalog, todayBlock } from '../../../public/app/model-api.mjs';
import { DOCS_STYLES, docHead } from './_shared.mjs';

// The models production sells today (0.9.16: the seven that passed a live test
// request on 15 October 2026). The page is built with them named at the top; on
// load, /app/model-api.mjs rewrites that line and the steps from the live
// catalog, so a pause, a closure or a newly opened model shows without a rebuild.
const SELLING = ['cyber-qwen-27b-awq', 'deephat-v1-7b', 'foundation-sec-8b', 'hermes-4-14b', 'orca-nex-mini', 'orca-qwen-27b', 'hermes-4.3-36b'];
const OPEN_MODEL = DEFAULT_MODELS.find((model) => model.id === 'cyber-qwen-27b-awq');
// The heading and line the script writes for that catalog, so the built page and the script agree.
const OPEN_CATALOG = { enabled: true, status: 'available', topups_enabled: true, models: DEFAULT_MODELS.filter((model) => SELLING.includes(model.id)).map((model) => ({ ...model, availability: 'available' })) };
const OPEN_TODAY = todayBlock(OPEN_CATALOG, mergeCatalog(OPEN_CATALOG));
const OPEN_HEADING = OPEN_TODAY.heading;

// data-open says whether the steps and the first call lead anywhere, data-state which state the
// heading and line tell (open, paused, closed, unknown): the script sets all three from the live catalog.
const today = html`<section class="api-today" id="model-api-start" data-open="true" data-state="open" aria-labelledby="start">
<div class="api-today__text">
<h2 id="start">${OPEN_HEADING}</h2>
<p class="api-today__line" id="model-api-today">${OPEN_TODAY.line}</p>
<div class="api-today__start">
<h3 class="api-today__how">How to start</h3>
<ol class="steps api-steps">
<li id="model-api-step-buy"><strong>Buy credit.</strong> Sign in with a passkey (no email needed), open Account, then Model API, and add US$20, US$50 or US$100.</li>
<li><strong>Create a key.</strong> Name it and give it a spending limit. The key starts with <code>bo_api_</code> and is shown once, so save it in your environment as <code>BOUNTY_OPERATOR_API_KEY</code>: the call below reads it from there.</li>
<li><strong>Call it.</strong> Send a chat request to <code>https://bountyoperator.com/v1/chat/completions</code> with your key and the model ID, from your own code or any tool that uses the OpenAI chat API.</li>
</ol>
<p class="help">After an idle spell the first request waits up to 10 minutes while the model starts. You are not charged for the wait.</p>
</div>
</div>
${codeBlock({ code: buildSnippet(OPEN_MODEL, 'curl'), name: 'Your first call', numbers: false, wrap: true, copy: true, label: 'Your first call: curl', className: 'api-today__code' })}
</section>`;

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
  lede: 'Call a security-tuned model from your own code or agent through an OpenAI-compatible API, and pay for it with prepaid credit.',
  actions: html`${button({ label: 'Get an API key', href: '/#account/api', variant: 'primary', size: 'lg' })}${button({ label: 'See all models', href: '#models', variant: 'secondary', size: 'lg' })}${button({ label: 'Setup guide', href: '/docs/model-api', variant: 'secondary', size: 'lg' })}`,
})}
${today}
<ul class="api-highlights" aria-label="API features"><li>Works with tools that use the OpenAI chat API</li><li>Prepaid credit, no subscription</li><li>A spending limit on every key</li><li>We don’t store your prompts or answers</li></ul>
<p class="help">Requests also pass to the selected hosting provider, whose data policies apply. Read the <a href="/privacy#model-api">provider and data handling details</a>.</p>
<div class="api-content">
<section class="docs-section" aria-labelledby="models">
<div class="catalog-heading"><h2 id="models">All models and prices</h2><p class="help">USD per million tokens. Every request costs at least the model’s minimum. Switch the price view to estimate a review or an agent session.</p></div>
<p class="help catalog-status" role="status" id="model-api-status">Checking model availability…</p>
<div id="model-api-catalog"></div>
<div id="model-api-quickstart" class="catalog-quickstart" aria-label="Interactive quickstart"></div>
<noscript><p>Enable JavaScript to filter models, estimate workload costs and copy model snippets. Full reference: <a href="/docs/model-api">/docs/model-api</a>.</p></noscript>
<p class="help catalog-footnote">When a model has been idle, its first request waits up to 10 minutes while a GPU starts and loads it. Requests after that answer in seconds while it stays warm. You are not charged for the wait. <a href="/docs/model-api#cost">What to expect</a></p>
</section>
<section class="docs-section" aria-labelledby="infron-stack">
<div class="catalog-heading"><h2 id="infron-stack">Use Infron’s models with your own Infron key</h2><p class="help">Infron’s own USD rates per million tokens, billed by Infron. Separate from the prepaid catalog above.</p></div>
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
  text: 'Buy credit, create a key and call the Model API from your own code or agent. Or start a free review on your own AI provider API key.',
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
  description: 'Call a security-tuned model from your own code or agent through an OpenAI-compatible API. Prepaid credit and a spending limit on every key.',
  styles: [...DOCS_STYLES, ...ACCOUNT_STYLES, '/css/catalog.css'], scripts: [...ACCOUNT_SCRIPTS, '/app/model-api.mjs'], overlays: accountDialog(),
  jsonld: [breadcrumbsLd([{ name: 'Model API', path: '/model-api' }])], lastmod: '2026-10-15', body,
};
