import { button, html } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { ACCOUNT_SCRIPTS, ACCOUNT_STYLES, accountDialog } from '../../fragments/account-dialog.mjs';
import { DOCS_STYLES, docHead, facts } from './_shared.mjs';

const body = html`<article class="docs wrap">
${docHead({
  crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Model API' }],
  title: 'Cyber models. In your tools.',
  lede: 'Choose a model for your security work. Connect it to your agent or chat app. Pay from one prepaid balance.',
  actions: html`${button({ label: 'Get an API key', href: '/#account/api', variant: 'primary', size: 'lg' })}${button({ label: 'Setup guide', href: '/docs/model-api', variant: 'secondary', size: 'lg' })}`,
})}
<div class="docs-lead">
${facts([
  { title: 'Keep your workflow', text: 'Works with tools that support an OpenAI-compatible Chat Completions API.' },
  { title: 'Control your spending', text: 'No API subscription. Set a spending limit and expiry for each key.' },
  { title: 'No saved conversations', text: 'We do not save prompts or responses in our application database.' },
])}
<section class="docs-section" aria-labelledby="models">
<h2 class="docs-section__title" id="models">Choose a model</h2>
<div class="notice notice--info" role="status" id="model-api-status"><p>Checking model availability…</p></div>
<div id="model-api-catalog"></div>
<noscript><p>Enable JavaScript to see current models, prices and availability.</p></noscript>
<p class="help">The first request after idle can take several minutes while the model starts.</p>
</section>
<section class="docs-section" aria-labelledby="pricing">
<h2 class="docs-section__title" id="pricing">Add credit when you need it</h2>
<div class="prose">
<p>Top up US$20, US$50 or US$100 when top-ups are open. Credit does not expire. No automatic top-ups.</p>
<p>Each model shows its input price, output price and minimum request charge. You pay the token cost or the minimum, whichever is higher. Requests with no confirmed usage are not charged.</p>
<p>API credit is separate from the Operator review subscription. <a href="/docs/model-api#cost">How billing works</a> · <a href="/terms#api-credit">Credit and refund terms</a></p>
</div>
</section>
<section class="docs-section" aria-labelledby="start">
<h2 class="docs-section__title" id="start">Connect your tools</h2>
<div class="prose">
<ol><li>Open your account, add credit and create an API key.</li><li>Choose a model from the catalog.</li><li>Follow the <a href="/docs/model-api">setup guide</a> to connect your agent or chat app.</li></ol>
<p>${button({ label: 'Get an API key', href: '/#account/api', variant: 'primary', size: 'lg' })}</p>
<p class="fine">For authorized security work. Models can make mistakes; check their answers. <a href="/privacy#model-api">Data handling</a> · <a href="/docs/model-api#scope">Model licenses and use</a></p>
</div>
</section>
</div>
</article>`;

export default {
  path: '/model-api', title: 'Cyber model API with prepaid credit | Bounty Operator', label: 'Model API', nav: 'model-api',
  description: 'Use cyber models in your own agents and chat tools. Browse live prices, add prepaid credit and set spending limits for each API key.',
  styles: [...DOCS_STYLES, ...ACCOUNT_STYLES, '/css/catalog.css'], scripts: [...ACCOUNT_SCRIPTS, '/app/model-api.mjs'], overlays: accountDialog(),
  jsonld: [breadcrumbsLd([{ name: 'Model API', path: '/model-api' }])], lastmod: '2026-10-13', body,
};
