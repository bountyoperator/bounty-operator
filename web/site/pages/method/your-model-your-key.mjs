// /your-model-your-key: where the code goes, who holds the key, what is stored.
//
// Provider facts are read from web/public/providers.mjs at build time, so the
// table cannot drift from the engine. Server facts follow SPEC section 5 and
// the privacy page.

import { button, card, faq, html, icon, inline, kv, link, sectionHeading, stackTable, statusChip } from '../../components.mjs';
import { breadcrumbsLd, faqPageLd } from '../../layout.mjs';
import { WHY_PAY } from '../../plans.mjs';
import { PROVIDERS } from '../../../public/providers.mjs';
import { LIMITS_LINE } from './_landing.mjs';
import { CLAUDE_CREDITS_FAQ, STYLES, ctaBand, pageHero, relatedLinks, tickList, workbenchLink } from './_shared.mjs';

const PATH = '/your-model-your-key';

const PROVIDER_NAMES = PROVIDERS.map((provider) => provider.label);
const PROVIDER_SENTENCE = `${PROVIDER_NAMES.slice(0, -1).join(', ')} or ${PROVIDER_NAMES.at(-1)}`;

// ---------------------------------------------------------------------------
// The data path
// ---------------------------------------------------------------------------

// A hosted review, stop by stop. The middle stop follows web/src/review.ts:
// the Worker adds the method of the profile (for a hosted profile it exists
// only there), calls the provider with the user's key and stores nothing.
const FLOW = [
  {
    icon: 'file',
    name: 'Your browser',
    where: 'On your device',
    does: [
      'Reads the files you choose.',
      'Runs the privacy check on every file and on your instructions.',
      'Shows the request before it leaves the tab.',
      'Hashes each file with SHA-256 and builds the review packet you download.',
    ],
  },
  {
    icon: 'shield',
    name: 'bountyoperator.com',
    where: 'In memory, for one request',
    does: [
      'Receives your files, your request and your API key.',
      'Checks your allowance and runs the privacy check again.',
      'Adds the review method of the profile you picked and sends the request, with your key, to one fixed endpoint of the provider you chose.',
      'Streams the review back. Writes none of it to the database or to logs.',
    ],
  },
  {
    icon: 'key',
    name: 'Your provider',
    where: 'Under your key and its terms',
    does: ['Receives your files, your request and our review instructions.', 'Runs the model you picked.', 'Bills the usage to your account.'],
  },
];

const flow = html`
<ol class="flow" aria-label="Path of a hosted review">${FLOW.map(
  (node) => html`
  <li class="flow__node">
    <div class="flow__head">${icon(node.icon)}<h3 class="flow__name">${node.name}</h3></div>
    <p class="meta">${node.where}</p>
    <ul class="flow__does">${node.does.map((item) => html`<li>${item}</li>`)}</ul>
  </li>`,
)}</ol>`;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const providerTable = stackTable({
  caption: `Providers a hosted review runs on (${PROVIDERS.length})`,
  columns: [{ label: 'Provider' }, { label: 'Default model', mono: true }, { label: 'Also suggested', mono: true }, { label: 'Key starts with', mono: true }, { label: 'Create a key' }],
  rows: PROVIDERS.map((provider) => [
    provider.label,
    provider.defaultModel,
    html`<span class="model-list">${provider.models
      .filter((model) => model.id !== provider.defaultModel)
      .map((model) => html`<span>${model.id}</span>`)}</span>`,
    provider.keyPrefixHint || html`<span class="muted">No fixed prefix</span>`,
    link({ label: new URL(provider.docsUrl).hostname, href: provider.docsUrl, external: true }),
  ]),
  className: 'providers',
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const FAQ_ITEMS = [
  {
    q: 'Can I use my ChatGPT or Claude subscription?',
    a: 'Yes, for 3 review types: Code security review, Solidity review and Challenge a draft report. Copy the prompt into your chat, then paste the answer back. You get the same findings and download as with an API key. The other review types need an API key, which providers bill separately from a chat subscription. Claude Max and Team plans include a monthly API credit: see the next answer.',
  },
  CLAUDE_CREDITS_FAQ,
  {
    q: 'Does Bounty Operator see my API key?',
    a: 'The key passes through our server in memory for the one request it belongs to and goes to your provider’s endpoint. It is not written to the database or to logs.',
  },
  {
    q: 'What does your server add to my request?',
    a: 'The review instructions: the output format every review shares, and the method of the profile you picked. The three core profiles carry their method in the open, so their preview is the whole prompt. Every other profile is hosted: the preview shows the request that leaves your tab, with your focus, your context and the files, and the server adds the method before it goes to your provider.',
  },
  {
    q: 'Who bills the model usage, and what does the US$10 pay for?',
    a: WHY_PAY,
  },
  {
    q: 'What does the provider keep?',
    a: 'The provider processes the request under its own terms and retention settings. Read them for the key you use, and run a review only on material you are allowed to share with that provider.',
  },
  {
    q: 'Which key does Panel review use?',
    a: 'One OpenRouter key covers a whole panel: it reaches models from several labs, so two to four different models review the same files. A panel model on another provider takes that provider’s own key.',
  },
];

const body = html`
${pageHero({
  trail: [{ label: 'Bounty Operator', href: '/' }, { label: 'Your model, your key' }],
  title: 'Your model, your key: where your code goes',
  lede: `A review runs on the model you choose, under your own API key: ${PROVIDER_SENTENCE}. Your files and your key pass through our server in memory. It adds the review method and sends the request to that provider. Bounty Operator stores no code, no prompts, no keys and no results.`,
  actions: html`${button({ label: 'Start a free review', href: workbenchLink(), variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${button({ label: 'See the providers', href: '#providers', size: 'lg' })}`,
  note: 'No API key? Code security, Solidity and draft-report reviews also work in ChatGPT or Claude, with no daily limit.',
  aside: html`
    <div class="glance">
      <p class="meta">At a glance</p>
      ${kv([
        ['Key', 'Yours. Used for the one request it belongs to.'],
        ['Files', 'Sent through our server to the provider you choose. Not stored by Bounty Operator.'],
        ['Method', 'Added on our server. Open source for the three core profiles.'],
        ['Providers', `${PROVIDERS.length}, each called at one fixed endpoint`],
        ['Chat plan', 'Copy the prompt into ChatGPT or Claude, paste the answer back (3 review types)'],
        ['Coding agent', 'Claude Code, Codex or Cursor over MCP'],
        ['Record', 'A packet with a SHA-256 manifest of every file'],
      ])}
    </div>`,
})}

<section class="section section--tight wrap" aria-labelledby="path">
  ${sectionHeading({
    title: 'Where your code goes',
    id: 'path',
    lede: 'A hosted review has three stops.',
  })}
  ${flow}
  <p class="fine flow__note">A GitHub import goes from your browser straight to api.github.com at a pinned commit. The repository is never uploaded to our server.</p>
</section>

<section class="section wrap" aria-labelledby="ways">
  ${sectionHeading({
    title: 'Three ways to run a review',
    id: 'ways',
    lede: 'All three give the same output format and the same packet.',
  })}
  <div class="grid grid--3">
    ${card({
      title: 'Your API key',
      meta: icon('key'),
      body: html`<div class="stack stack--12">
        <p>Paste a key from one of eight providers and run the review on this site. It goes through our server to your provider, and the answer streams into finding cards.</p>
        ${tickList(['All 11 review types, the Gauntlet and Panel review', 'Free: 1 review a day, any review type', 'Operator: unlimited, 4 at once', 'The key is used for that request only'])}
      </div>`,
      foot: html`<a class="link" href="${workbenchLink()}">Start a free review</a>`,
    })}
    ${card({
      title: 'Your ChatGPT or Claude chat',
      meta: icon('copy'),
      body: html`<div class="stack stack--12">
        <p>For 3 review types you get the full prompt as one document. Paste it into your chat app or a local model, then paste the answer back.</p>
        ${tickList(['Code security review, Solidity review, challenge a draft report', 'No API key, no account and no daily limit', 'Your files stay in your browser until you paste the prompt', 'The pasted answer gives you the same findings and download'])}
      </div>`,
      foot: html`<a class="link" href="${workbenchLink()}">Copy a prompt</a>`,
    })}
    ${card({
      title: 'MCP, your coding agent',
      meta: icon('terminal'),
      body: html`<div class="stack stack--12">
        <p>${inline('Connect an agent to the MCP server. `prepare_review` builds the request of a core profile for the agent’s own model. `run_review` runs any profile as a hosted review, and is the one way to run a hosted profile from an agent.')}</p>
        ${tickList([
          '`list_profiles`, `prepare_review` and `build_packet` need no account',
          '`run_review` needs a connection token from your account',
          'Your provider key travels in the `X-Provider-Key` header, never as a tool argument',
        ])}
      </div>`,
      foot: html`<a class="link" href="/mcp">MCP setup</a>`,
    })}
  </div>
</section>

<section class="section wrap" aria-labelledby="key">
  <div class="split">
    <div>
      ${sectionHeading({ title: 'Who holds the key', id: 'key', lede: 'You do.' })}
      <div class="prose">
        <p>You create the key in your provider’s console and paste it in when you run a review. It travels with that request to our server, goes on to the provider’s endpoint, and is gone when the request ends.</p>
        <p>Each provider is called at one fixed endpoint. A redirect is refused. An error message from the provider is shown to you with the key removed.</p>
        <p>Model usage is billed by the provider to the account that owns the key. Operator is a flat US$10 per week for unlimited reviews and does not include model usage.</p>
      </div>
    </div>
    <div>
      ${sectionHeading({ title: 'The privacy check', id: 'check', lede: 'It runs before anything is sent, in your browser and again on the server.' })}
      ${tickList([
        'Private keys, API keys, GitHub and Slack tokens, wallet keys and seed phrases block the request.',
        'A file that normally holds credentials blocks the request.',
        'An email address or a public IP address asks you to confirm before sending.',
        'A finding names the file and the line. It never repeats the secret.',
      ])}
      <p class="fine needs__limits">${LIMITS_LINE}</p>
    </div>
  </div>
</section>

<section class="section wrap" aria-labelledby="stored">
  ${sectionHeading({
    title: 'What is stored',
    id: 'stored',
    lede: html`The full list is on the <a class="link" href="/privacy">privacy page</a>, and the <a class="link" href="/security">security page</a> shows how it is protected.`,
  })}
  <div class="grid grid--2">
    ${card({
      title: 'Never stored',
      meta: statusChip('done', 'Memory only'),
      body: tickList(['Your files and your code', 'Your prompts and review instructions', 'Your provider API key and any GitHub token', 'The review the model returns']),
    })}
    ${card({
      title: 'Stored',
      meta: 'Account and service records',
      body: html`<ul class="stored">
        <li>A random account identifier, passkey public keys and a hashed recovery code.</li>
        <li>Hashed session tokens and hashed connection tokens, with their labels and last-use times.</li>
        <li>Review activity for up to seven days: status, profile, web or MCP, timestamps. It enforces the daily allowance.</li>
        <li>Billing references from Stripe: customer and subscription ids, status, paid-until and the receipt email.</li>
        <li>Daily totals per page and per event, with no account identifier.</li>
      </ul>`,
    })}
  </div>
</section>

<section class="section wrap" aria-labelledby="providers">
  ${sectionHeading({
    title: 'Providers supported',
    id: 'providers',
    lede: 'One key from any of these runs every review type. The default model is preselected and the others are suggestions in the model list.',
  })}
  ${providerTable}
</section>

<section class="section wrap wrap--narrow" aria-labelledby="faq">
  ${sectionHeading({ title: 'Questions', id: 'faq' })}
  ${faq(FAQ_ITEMS, { exclusive: 'byok-faq' })}
</section>

${ctaBand({
  title: 'Run it on the model you already pay for',
  lede: 'Paste a key, or export the prompt of a core profile to your chat app.',
  actions: html`${button({ label: 'Start a free review', href: workbenchLink(), variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${button({ label: 'MCP setup', href: '/mcp', size: 'lg' })}`,
  note: 'Free: 1 review a day. No card.',
})}

<section class="section section--tight wrap">
  ${relatedLinks([
    { label: 'Compare', href: '/compare', text: 'Bounty Operator next to a chat app, an audit skill and platform pre-checks.' },
    { label: 'Panel review', href: '/panel-review', text: 'Two to four models on one OpenRouter key.' },
    { label: 'Pricing', href: '/pricing', text: 'Free and Operator, side by side.' },
  ])}
</section>`;

export default {
  path: PATH,
  title: 'Your model, your key: where your code goes | Bounty Operator',
  description:
    'Where your code goes, who holds the API key and what is stored. Eight providers on your own key, prompt export for chat subscriptions, MCP for agents.',
  label: 'Your model, your key',
  styles: STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Your model, your key', path: PATH }]), faqPageLd(FAQ_ITEMS)],
  lastmod: '2026-10-09',
  body,
};
