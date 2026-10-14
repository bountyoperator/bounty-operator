import { button, html } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { ACCOUNT_SCRIPTS, ACCOUNT_STYLES, accountDialog } from '../../fragments/account-dialog.mjs';
import { DOCS_STYLES, docHead } from './_shared.mjs';

const body = html`<article class="docs wrap model-api-page">
${docHead({
  crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Model API' }],
  title: 'Cybersecurity models. Now live.',
  lede: 'Cybersecurity fine-tunes and lower-refusal variants through one OpenAI-compatible API. One key. Prepaid credit.',
  actions: html`${button({ label: 'Get an API key', href: '/#account/api', variant: 'primary', size: 'lg' })}${button({ label: 'Browse models', href: '#models', variant: 'secondary', size: 'lg' })}<a class="api-guide-link" href="/docs/model-api">Setup guide</a>`,
})}
<ul class="api-highlights" aria-label="API features"><li>OpenAI-compatible</li><li>Prepaid credit or monthly plan</li><li>Spending limits per key</li></ul>
<div class="api-content">
<section class="docs-section" aria-labelledby="models">
<div class="catalog-heading"><h2 id="models">Choose a model</h2><p class="help">USD per 1M tokens · minimum per request</p></div>
<p class="help catalog-status" role="status" id="model-api-status">Checking model availability…</p>
<div id="model-api-catalog"></div>
<noscript><p>Enable JavaScript to see current models, prices and availability.</p></noscript>
<p class="help catalog-footnote">The first request after idle can take several minutes while the model starts. <a href="/docs/model-api#cost">What to expect</a></p>
</section>
<section class="docs-section" aria-labelledby="pricing">
<div class="api-start">
<div><h2 id="pricing">One balance.<br>Every model.</h2><p class="lede">Add US$20, US$50 or US$100.<br>No subscription required. Auto top-ups are off by default.</p>${button({ label: 'Get an API key', href: '/#account/api', variant: 'primary', size: 'lg' })}</div>
<div class="prose"><h3>Pay for what you use</h3><p>Each request costs the token price or the model’s minimum charge, whichever is higher. Requests with no confirmed usage are not charged.</p><p>Credit does not expire. The US$10 monthly Operator plan also includes US$2 in API credit per paid month.</p><p><a href="/docs/model-api#cost">How billing works</a> · <a href="/terms#api-credit">Credit and refund terms</a></p></div>
</div>
</section>
<section class="docs-section" aria-labelledby="start">
<div class="api-footer"><div><h2 id="start">Bring your own tools</h2><p>Connect an app that supports OpenAI-compatible Chat Completions.</p><a href="/docs/model-api">Read the setup guide</a></div><div><h3>No saved conversations</h3><p>We do not save prompts or responses in our application database.</p><a href="/privacy#model-api">Data handling</a></div></div>
<p class="fine catalog-footnote">For authorized security work. Models can make mistakes; check their answers. <a href="/docs/model-api#scope">Model licenses and use</a></p>
</section>
</div>
</article>`;

export default {
  path: '/model-api', title: 'Cyber model API with prepaid credit | Bounty Operator', label: 'Model API', nav: 'model-api',
  description: 'Use cyber models in your own agents and chat tools. Browse live prices, add prepaid credit and set spending limits for each API key.',
  styles: [...DOCS_STYLES, ...ACCOUNT_STYLES, '/css/catalog.css'], scripts: [...ACCOUNT_SCRIPTS, '/app/model-api.mjs'], overlays: accountDialog(),
  jsonld: [breadcrumbsLd([{ name: 'Model API', path: '/model-api' }])], lastmod: '2026-10-14', body,
};
