import { button, codeBlock, html, table } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { ACCOUNT_SCRIPTS, ACCOUNT_STYLES, accountDialog } from '../../fragments/account-dialog.mjs';
import { DOCS_STYLES, docPage } from './_shared.mjs';

const python = `from openai import OpenAI
import os

client = OpenAI(
    api_key=os.environ["BOUNTY_OPERATOR_API_KEY"],
    base_url="https://bountyoperator.com/v1",
    timeout=600.0,
)

for chunk in client.chat.completions.create(
    model="cyber-qwen-27b-awq",
    messages=[{"role": "user", "content": "Review this authorized test case..."}],
    max_tokens=2048,
    stream=True,
    stream_options={"include_usage": True},
):
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="")
    if chunk.usage:
        print("\\nUsage:", chunk.usage)`;
const endpoints = table({ label: 'Model API endpoints', columns: [{ label: 'Method' }, { label: 'Path' }, { label: 'Returns' }], rows: [
  ['GET', '/v1/models', 'Available models, limits and rates'],
  ['POST', '/v1/chat/completions', 'A response or an SSE stream; supports function tools'],
  ['GET', '/v1/usage', 'Your available wallet and this key’s spending limit'],
] });
const body = docPage({
  head: { crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Model API' }], title: 'Cyber models. Your tools. One API.', lede: 'Use a hosted security model from your scripts and coding tools. Prepaid credit, individual key limits, and an OpenAI-compatible chat endpoint.', actions: html`${button({ label: 'Open API account', href: '/#account/api', variant: 'primary', size: 'lg' })}${button({ label: 'Read the quickstart', href: '#quickstart', variant: 'secondary', size: 'lg' })}` },
  before: html`<div class="notice notice--info" role="status" id="model-api-status"><p>Checking model availability…</p></div><div id="model-api-catalog"></div>`,
  sections: [
    { id: 'start', title: 'Start with credit, not a subscription', body: html`<ol><li>Sign in with a passkey and open <strong>Model API</strong> in your account.</li><li>Add US$20, US$50 or US$100 when top-ups are open.</li><li>Create a key with a lifetime spending limit and an expiry. Copy it once.</li><li>Set your tool’s base URL to <code>https://bountyoperator.com/v1</code> and use the model ID shown above.</li></ol><p>API credit and the Operator review subscription are separate purchases. No API subscription or automatic top-up is required.</p>` },
    { id: 'quickstart', title: 'Python quickstart', body: html`<p>Use the OpenAI Python client. Keep your key in an environment variable, outside source control.</p>${codeBlock({ name: 'Terminal', code: 'python -m pip install openai', numbers: false, copy: true })}${codeBlock({ name: 'Python', code: python, numbers: false, copy: true })}<p>Clients must support the Chat Completions API. Anthropic’s Messages API, OpenAI Responses, images, audio and embeddings are not supported by this endpoint.</p>` },
    { id: 'reference', title: 'Endpoints and parameters', body: html`${endpoints}<p>Authenticate with <code>Authorization: Bearer YOUR_KEY</code>. Chat requests accept text messages, <code>tools</code>, <code>tool_choice</code>, <code>parallel_tool_calls</code>, <code>response_format</code>, <code>temperature</code>, <code>top_p</code>, <code>top_k</code>, penalties, <code>seed</code> and <code>stop</code>. Set either <code>max_tokens</code> or <code>max_completion_tokens</code>. Only one completion per request is supported.</p><p>For this Qwen model, <code>extra_body={"chat_template_kwargs": {"enable_thinking": False}}</code> disables thinking in the Python client. Reasoning tokens count as output tokens.</p><p>Requests are limited to 256 messages, 32 tools and 256 KiB of JSON. Each account can run two requests at once. The pilot serves four requests at once across accounts. When capacity is full, a 429 response includes a retry delay.</p><p>Set <code>stream_options.include_usage</code> to receive token counts at the end of a stream. An interrupted stream may end with a coded error. Use the request ID to find its charge in your account.</p><p>An optional <code>Idempotency-Key</code> prevents the same key from starting twice for 30 days. A repeat returns 409; responses are not stored for replay. Use a new value only when you intend to start a new generation.</p>` },
    { id: 'cost', title: 'How requests are charged', body: html`<p>The live catalog above and <code>/v1/models</code> show the current input rate, output rate and minimum request charge. The charge is the greater of the token cost or that minimum whenever usage has been confirmed, including an interrupted request. A request with no confirmed usage is not charged.</p><p>Before generation, enough credit is reserved for the model’s full input context and your requested output limit. The final charge uses the model’s token counters. The unused reservation is released when the request ends. Keep enough available credit for the reservation as well as the expected charge.</p><p>Keys stop spending at their lifetime limit. A refund or chargeback removes the corresponding credit and may suspend further requests until the balance is settled. Unused credit does not expire; see the <a href="/terms#api-credit">API credit terms</a> for refunds.</p><p>The first request after idle can take longer while the worker starts. A timeout is not a completed answer. The gateway allows up to three minutes for startup and five minutes for generation. Set a ten-minute client timeout and respect retry headers.</p>` },
    { id: 'privacy', title: 'Your content passes through', body: html`<p>Requests pass through Cloudflare to our vLLM deployment on Runpod. Prompt and response logging is disabled. We do not save prompts or responses in our application database. Cross-request prefix caching is disabled.</p><p>We retain API key hashes, limits, token counts and billing records. Recent request metadata is deleted after 30 days. Infrastructure providers process traffic under their own policies. Read the <a href="/privacy#model-api">full data handling details</a>.</p>` },
    { id: 'scope', title: 'For authorized security work', body: html`<p>The available model is a community fine-tune; its source, exact revision, quantization and license are shown in the catalog. Passing our compatibility checks is not a security benchmark or a promise that its findings are correct. Check scope, evidence and conclusions yourself.</p><p>Use the service only on code, data and systems you are authorized to assess. The API generates text and tool calls; your client controls whether a tool executes.</p>` },
  ],
});
export default { path: '/model-api', title: 'Cyber model API with prepaid credit | Bounty Operator', label: 'Model API', nav: 'model-api', description: 'Hosted cyber models over an OpenAI-compatible API, with prepaid credit, per-key limits, function tools and streaming.', styles: [...DOCS_STYLES, ...ACCOUNT_STYLES], scripts: [...ACCOUNT_SCRIPTS, '/app/model-api.mjs'], overlays: accountDialog(), jsonld: [breadcrumbsLd([{ name: 'Model API', path: '/model-api' }])], lastmod: '2026-10-13', body };
