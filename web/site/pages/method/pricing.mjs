// /pricing: the standalone pricing page. It mirrors the home pricing section.
// Pricing is fixed by SPEC section 2: Free = 1 review per day (00:00 UTC
// reset), Operator = US$10 per week. The plan lines come from ../../plans.mjs.
//
// The page loads the account panel (/app/account.mjs). "Get Operator" carries
// data-account-action="checkout": sign-in when needed, then Stripe. A cancelled
// checkout comes back to /pricing?checkout=cancelled (web/src/billing.ts) and
// the account script writes its line into [data-checkout-note].

import { button, faq, html, icon, sectionHeading, table } from '../../components.mjs';
import { breadcrumbsLd, faqPageLd, softwareApplicationLd } from '../../layout.mjs';
import { ACCOUNT_SCRIPTS, ACCOUNT_STYLES, accountDialog } from '../../fragments/account-dialog.mjs';
import { PROFILES } from '../../../public/profiles.mjs';
import { AGENT_TICK, CHAT_TICK, COUNTED, FREE_LINE, NOT_COUNTED, RENEWAL, RESET_LINE, WHY_PAY } from '../../plans.mjs';
import { LASTMOD, STYLES, pageHero, relatedLinks, tickList, workbenchLink } from './_shared.mjs';

const PATH = '/pricing';

// Which review types also run in a chat app is read from the engine, so the
// page cannot name one on the wrong side.
const LISTED = PROFILES.filter((profile) => profile.listed);
const CORE = LISTED.filter((profile) => !profile.hosted);
if (LISTED.length !== 11 || CORE.length !== 3) {
  throw new Error(`/pricing is written for 11 review types, 3 of them usable in a chat app; the engine has ${LISTED.length} and ${CORE.length}.`);
}
const CORE_NAMES = `${CORE.slice(0, -1).map((profile) => profile.name).join(', ')} and ${CORE.at(-1).name}`;
const API_ONLY = LISTED.length - CORE.length;

const yes = () => html`<span class="plan-yes">${icon('check', { label: 'Yes' })}</span>`;
const no = () => html`<span class="muted">—</span>`;

const planTable = table({
  label: 'Free and Operator, line by line',
  columns: [{ label: 'What you get' }, { label: 'Free' }, { label: 'Operator · US$10/week' }],
  rows: [
    [html`Reviews on your API key, on this site or with <code>run_review</code> from Claude Code, Codex or Cursor`, '1 a day', 'Unlimited'],
    ['Review types', 'All 11', 'All 11'],
    [html`<a class="link" href="/gauntlet">Gauntlet</a>: eight stages on one finding, then a verdict`, no(), yes()],
    [html`<a class="link" href="/panel-review">Panel review</a>: 2 to 4 models, then a cross-check`, no(), yes()],
    ['Reviews running at once', '1', '4'],
    ['Copy-paste reviews in ChatGPT or Claude (3 review types)', 'Unlimited, not counted', 'Unlimited'],
    [html`Reviews your coding agent’s own model writes with <code>prepare_review</code> or the skills (3 review types)`, 'Unlimited, not counted, no account', 'Unlimited'],
    ['Free tools, GitHub import, local history', yes(), yes()],
  ],
  className: 'plans-table',
});

const FAQ_ITEMS = [
  {
    q: 'I already pay for my model. What does the US$10 pay for?',
    a: WHY_PAY,
  },
  {
    q: 'What counts as my free review?',
    a: `${COUNTED} ${NOT_COUNTED} ${RESET_LINE}`,
  },
  {
    q: 'Can I use my ChatGPT or Claude subscription instead of an API key?',
    a: `Yes, for 3 review types: ${CORE_NAMES}. Copy the prompt into your chat, then paste the answer back. No account and no daily limit. The other ${API_ONLY} review types, the Gauntlet and Panel review need an API key.`,
  },
  {
    q: 'How does billing work?',
    a: `US$10 a week. ${RENEWAL}`,
  },
  {
    q: 'Do I need an email address or a card for the free plan?',
    a: 'No. Your account is a passkey. You enter a card only at Stripe when you buy Operator.',
  },
];

const body = html`
${pageHero({
  trail: [{ label: 'Bounty Operator', href: '/' }, { label: 'Pricing' }],
  title: 'Free for 1 review a day. US$10 a week for unlimited.',
  lede: 'You bring the model: your own API key, or your ChatGPT or Claude chat. Your provider bills model usage.',
})}

<section class="section section--tight wrap" aria-labelledby="plans">
  <h2 class="visually-hidden" id="plans">Plans</h2>
  <div class="plans__note" data-checkout-note></div>
  <div class="plans">
    <article class="plan" aria-labelledby="plan-free">
      <div class="plan__head">
        <h3 class="plan__name" id="plan-free">Free</h3>
      </div>
      <p class="plan__price"><span class="plan__amount">US$0</span></p>
      <p class="plan__for">To try it on your next report. No card.</p>
      ${tickList([
        FREE_LINE.replace(/\.$/, ''),
        CHAT_TICK,
        AGENT_TICK,
        'Free tools and GitHub import',
      ])}
      <div class="plan__cta">${button({ label: 'Run today’s free review', href: workbenchLink(), variant: 'secondary', size: 'lg', block: true })}</div>
    </article>
    <article class="plan plan--accent" aria-labelledby="plan-operator">
      <div class="plan__head">
        <h3 class="plan__name" id="plan-operator">Operator</h3>
      </div>
      <p class="plan__price"><span class="plan__amount">US$10</span><span class="plan__per">per week</span></p>
      <p class="plan__for">For contest weeks: review every finding, not one a day.</p>
      ${tickList([
        'Unlimited reviews',
        'Gauntlet: eight stages on one finding, then a verdict',
        'Panel review: compare 2 to 4 models',
        '4 reviews running at once',
        'Everything in Free',
      ])}
      <div class="plan__cta">${button({ label: 'Get Operator', variant: 'primary', size: 'lg', block: true, iconEnd: 'arrow-right', id: 'upgrade', attrs: { 'data-account-action': 'checkout' } })}</div>
    </article>
  </div>
  <p class="fine plans__terms">${RENEWAL}</p>
</section>

<section class="section wrap" aria-labelledby="compare-plans">
  <h2 class="visually-hidden" id="compare-plans">Full plan comparison</h2>
  <details class="disclosure"><summary class="disclosure__summary">Compare every feature</summary><div class="disclosure__body">
  ${planTable}
  </div></details>
</section>

<section class="section wrap wrap--narrow" aria-labelledby="faq">
  ${sectionHeading({ title: 'Pricing questions', id: 'faq' })}
  ${faq(FAQ_ITEMS, { exclusive: 'pricing-faq' })}
</section>

<section class="section section--tight wrap">
  ${relatedLinks([
    { label: 'Gauntlet', href: '/gauntlet', text: 'What an Operator run returns, with a full example.' },
    { label: 'Panel review', href: '/panel-review', text: '2 to 4 models on the same code, then a cross-check.' },
    { label: 'Your model, your key', href: '/your-model-your-key', text: 'Providers, the chat route and what is stored.' },
    { label: 'Compare', href: '/compare', text: 'Bounty Operator next to a chat app, an audit skill and platform pre-checks.' },
  ])}
</section>`;

export default {
  path: PATH,
  title: 'Pricing: Free, or Operator at US$10 a week | Bounty Operator',
  description: `Free gives you ${FREE_LINE.replace(/\.$/, '')}. Operator is US$10 per week for unlimited reviews, the Gauntlet, Panel review and 4 reviews at once.`,
  label: 'Pricing',
  bodyClass: 'pricing-page',
  nav: 'pricing',
  styles: [...STYLES, ...ACCOUNT_STYLES],
  scripts: ACCOUNT_SCRIPTS,
  overlays: accountDialog(),
  jsonld: [breadcrumbsLd([{ name: 'Pricing', path: PATH }]), softwareApplicationLd(), faqPageLd(FAQ_ITEMS)],
  lastmod: LASTMOD,
  body,
};
