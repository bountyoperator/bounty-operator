import { button, html, stackTable } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { provider } from '../../../public/providers.mjs';
import { loadPublished } from '../benchmark/_data.mjs';
import { DOCS_STYLES, docPage, ext, time } from './_shared.mjs';

const PATH = '/docs/model-selection';
const UPDATED = '2026-10-21';
const published = loadPublished();
const benchmarkDate = published?.results.generated_at?.slice(0, 10);
const novita = provider('novita');
const nebius = provider('nebius');

const workflows = stackTable({
  label: 'Choose the capabilities your workflow needs',
  columns: [{ label: 'Your workflow' }, { label: 'What to check' }],
  rows: [
    ['Review source files', 'Enough input space for your code, instructions and conversation, with room left for the answer.'],
    ['Check a draft finding', 'Include the relevant code, evidence and scope. Compare whether the answer supports its claims, not just whether it agrees.'],
    ['Run an agent with tools', html`Choose the <strong>tools</strong> capability and a client that supports OpenAI-compatible Chat Completions. Your client executes tools; the Model API supplies text and tool calls.`],
  ],
});

const body = docPage({
  head: {
    crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Model API', href: '/model-api' }, { label: 'Choose a model' }],
    title: 'Choose a model for your workflow',
    lede: 'Check capabilities, cost and data handling before connecting. You choose the model used for each request.',
    meta: html`Updated ${time(UPDATED)}`,
    actions: html`${button({ label: 'Compare models', href: '/model-api', variant: 'primary', size: 'lg' })}${button({ label: 'Connect your tool', href: '/docs/model-api', variant: 'secondary', size: 'lg' })}`,
  },
  sections: [
    { id: 'workflow', title: 'Start with the task', body: html`${workflows}<p>Check streaming and structured-output support separately. A model’s name or “low refusal” label does not establish tool compatibility or finding quality. Use the exact model ID from the <a href="/model-api#models">catalog</a>.</p>` },
    { id: 'free', title: 'Start without buying model credit', body: html`
<p>Three different routes—not an unlimited free hosted API:</p>
${stackTable({
  label: 'Free routes and their requirements',
  columns: [{ label: 'Route' }, { label: 'What you need' }, { label: 'Limit to understand' }],
  rows: [
    [html`<a href="/?profile=report&amp;via=export#workspace">Use your AI chat</a>`, 'Copy the prepared prompt into your chat and paste its answer back. No Bounty Operator account or API key.', 'The three core review types. Your chat provider’s costs and limits still apply.'],
    [html`<a href="/mcp#install">Use your coding agent</a>`, 'Connect the free MCP tools. Your agent’s own model reviews the files and builds the packet.', 'The three core review types. No Bounty Operator account; your agent’s model costs still apply. OpenCode setup covers v1 and v2.'],
    [html`<a href="/?provider=openrouter#workspace">Choose a free OpenRouter model</a>`, 'Your OpenRouter account/key and a free Bounty Operator account for the hosted review. Open Find a free OpenRouter model on the Run step.', 'One hosted review per UTC day on Bounty Operator Free. OpenRouter’s separate rate and capacity limits apply.'],
  ],
})}
<p>The picker reads OpenRouter’s current catalog when you ask. It only lists zero-priced text models with a documented output allowance large enough for a review. It does not change the selected model until you choose one, and it never switches to a paid model automatically. A listing is not a benchmark result or a promise of capacity.</p>
<p>As checked on 20 October 2026, ${ext('OpenRouter documents', 'https://openrouter.ai/docs/api_reference/limits#rate-limits')} 20 free-model requests per minute and 50 per day below its purchased-credit threshold, or 1,000 per day after at least 10 credits purchased. These are provider account limits, not a shared allowance supplied by Bounty Operator.</p>
<p><strong>Free does not mean confidential.</strong> Check ${ext('OpenRouter provider logging', 'https://openrouter.ai/docs/guides/privacy/provider-logging')} and the actual model host’s terms before sending a private report. ${ext('OpenCode’s free models and privacy exceptions', 'https://opencode.ai/v2/docs/console/models/#privacy')} vary by model; some collect data to improve the model, and NVIDIA trial endpoints prohibit confidential or personal data. Start with public or invented examples unless the program permits the selected data handling.</p>
<p>These are independent services, not claimed partnerships. Bounty Operator’s own <a href="/model-api">hosted Model API</a> remains a separate prepaid product.</p>` },
    { id: 'novita', title: 'Use your own Novita AI key', body: html`
<p>Novita is an optional provider for hosted reviews, not a free-model route or Bounty Operator’s default. It serves models under your own Novita account and bills their usage separately from Bounty Operator.</p>
<ol>
<li><a href="${novita.affiliateUrl}" target="_blank" rel="sponsored noopener noreferrer">Create a Novita account (affiliate link)</a>, or sign in to your existing account. <strong>Disclosure:</strong> we may earn a commission if you sign up and pay for Novita through this link. Commission does not determine our defaults or benchmark rankings.</li>
<li>Check Novita’s current model pricing, account limits and available credit before running a review. Do not assume signup includes free inference. Review its data-handling terms before sending a private report.</li>
<li>${ext('Create or manage your Novita API key', novita.docsUrl)}. Existing account holders can go directly here; the key-management link is not an affiliate link.</li>
<li><a href="/?provider=novita#workspace">Select Novita AI</a>, choose your files and review type, and paste the key on the Run step under My own API key. Choose an exact model ID supported by Novita, or leave Model empty to use <code>${novita.defaultModel}</code>. Then run the review when you are ready.</li>
</ol>
<p>A Bounty Operator account is still required for hosted reviews. Free covers one hosted review per UTC day; Operator’s review allowance does not include Novita usage. Bounty Operator API credit cannot pay Novita charges. Selecting Novita does not start a request, buy credit or create a paid fallback.</p>
<p>Your files and key pass through Bounty Operator to Novita only when you run a hosted review. The optional signup link sends referral parameters to Novita, not your files or key; Novita may track the visit under its own policies. We add no affiliate scripts or pixels. See <a href="/privacy#affiliate-links">affiliate-link privacy</a> and ${ext('Novita’s API quickstart', 'https://docs.novita.ai/guides/quickstart')}.</p>` },
    { id: 'nebius', title: 'Use your own Nebius Token Factory key', body: html`
<p>Nebius Token Factory is an optional provider for hosted reviews, not a free-model route or Bounty Operator’s default. It serves open models under your own Nebius account and bills their usage separately from Bounty Operator. We receive no commission from Nebius.</p>
<ol>
<li>${ext('Sign in to Nebius Token Factory', 'https://tokenfactory.nebius.com/')}, or create an account. Before it issues an API key, Nebius asks for billing details, including a card it verifies with a $0 authorization. Its setup also offers zero data retention; turn it on before sending a private report. Check its current model pricing and your available credit before running a review.</li>
<li>${ext('Create a Nebius API key', nebius.docsUrl)}.</li>
<li><a href="/?provider=nebius#workspace">Select Nebius Token Factory</a>, choose your files and review type, and paste the key on the Run step under My own API key. Choose an exact model ID from Nebius’s catalog, or leave Model empty to use <code>${nebius.defaultModel}</code>. Then run the review when you are ready.</li>
</ol>
<p>A Bounty Operator account is still required for hosted reviews. Free covers one hosted review per UTC day; Operator’s review allowance does not include Nebius usage. Bounty Operator API credit cannot pay Nebius charges. Selecting Nebius does not start a request, buy credit or create a paid fallback.</p>
<p>Your files and key pass through Bounty Operator to Nebius only when you run a hosted review. Each request asks Nebius not to store the answer (<code>store: false</code>). Nebius processes the content under its own terms and your account’s retention setting. See ${ext('Nebius’s quickstart', 'https://docs.tokenfactory.nebius.com/quickstart')}.</p>` },
    { id: 'budget', title: 'Compare cost and readiness', body: html`<p>Check the model’s current availability before starting. In the catalog, switch workload view to compare estimated token costs, including the minimum request charge. An agent can make several requests for one task, so set an output limit and a spending cap on its API key.</p><p>Estimates are not quotes for a completed investigation. Credit is reserved before a request, and the unused portion is released after settlement. A self-hosted model may take several minutes to start after idle. Allow for that startup time when choosing a model for interactive work. See <a href="/docs/model-api#cost">charging and timeout details</a>.</p>` },
    { id: 'data', title: 'Choose where your content goes', body: html`<p>Read the hosting provider and source details on the model card. Our self-hosted RunPod deployments disable prompt and response logging and cross-request prefix caching. Managed models use Infron or OrcaRouter, including any downstream providers, under their own terms and retention policies. They do not come with a zero-retention guarantee.</p><p>Send only material you are authorized to share with the selected providers. Review the <a href="/privacy#model-api">data handling details</a> before connecting confidential work.</p>` },
    { id: 'evidence', title: 'Read the evidence in context', body: html`${published ? html`<p>Our <a href="/benchmark">Paydirt benchmark</a>${benchmarkDate ? html`, published ${time(benchmarkDate)},` : ''} measures small-file Solidity and TypeScript review and checking draft reports. Compare its errors, costs and <a href="/benchmark/method">evaluation method</a> alongside its scores. It does not measure whole-repository audits or live web and cloud assessments.</p>` : html`<p>We have no published Paydirt results to link here yet. Treat catalog capabilities as compatibility information, not a quality ranking.</p>`}<p>${ext('Wiz Cyber Model Arena', 'https://www.wiz.io/cyber-model-arena')} is an external reference for broader tasks. Its results evaluate a model together with its agent harness. They do not score our hosted variants: a base model’s result does not transfer to a fine-tune, quantized version or different harness. If the exact setup has no matching evaluation, its performance is unmeasured here.</p><p>Start with a small authorized task whose outcome you can check. Keep the model, harness and settings recorded so comparisons mean something.</p>` },
  ],
});

export default {
  path: PATH,
  title: 'Choose a security model | Bounty Operator',
  label: 'Choose a model',
  nav: 'model-api',
  description: 'Choose a model by workflow, tool support, cost, availability and data handling. Understand what Bounty Operator and external benchmarks measure.',
  styles: DOCS_STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Model API', path: '/model-api' }, { name: 'Choose a model', path: PATH }])],
  lastmod: UPDATED,
  body,
};
