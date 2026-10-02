// /pricing: the standalone pricing page. It mirrors the home pricing section.
// Pricing is fixed by SPEC section 2: Free = 1 hosted review per UTC day,
// Operator = US$10 per week.
//
// The page loads the account panel (/app/account.mjs). "Get Operator" carries
// data-account-action="checkout": sign-in when needed, then Stripe. A cancelled
// checkout comes back to /pricing?checkout=cancelled (web/src/billing.ts) and
// the account script writes its line into [data-checkout-note].

import { button, chip, faq, html, icon, inline, sectionHeading, statusChip, table } from '../../components.mjs';
import { breadcrumbsLd, faqPageLd, softwareApplicationLd } from '../../layout.mjs';
import { ACCOUNT_SCRIPTS, ACCOUNT_STYLES, accountDialog } from '../../fragments/account-dialog.mjs';
import { GAUNTLET, PROFILES, reviewProfile } from '../../../public/profiles.mjs';
import { LASTMOD, STYLES, pageHero, relatedLinks, tickList, workbenchLink } from './_shared.mjs';

const PATH = '/pricing';

// Which profiles are core and which run hosted only is read from the engine,
// so the page cannot name a profile on the wrong side.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const LISTED = PROFILES.filter((profile) => profile.listed);
const CORE = LISTED.filter((profile) => !profile.hosted);
const HOSTED = LISTED.filter((profile) => profile.hosted);
const HOSTED_STAGES = GAUNTLET.filter((id) => reviewProfile(id).hosted).length;
if (LISTED.length !== 11 || CORE.length !== 3) {
  throw new Error(`/pricing is written for eleven single profiles, three of them core; the engine has ${LISTED.length} and ${CORE.length}.`);
}
const listOf = (items) => `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);
const CORE_NAMES = listOf(CORE.map((profile) => profile.name));
const HOSTED_NAMES = listOf(HOSTED.map((profile) => lowerFirst(profile.name)));

const RENEWAL = 'US$10 billed weekly, renews until you cancel in the Stripe portal; access runs to the end of the paid week.';

const yes = () => html`<span class="plan-yes">${icon('check', { label: 'Yes' })}</span>`;
const exampleOnly = () => chip('Example only', { tone: 'neutral', dashed: true });

const planTable = table({
  label: 'Free and Operator, line by line',
  columns: [{ label: 'What you get' }, { label: 'Free' }, { label: 'Operator · US$10/week' }],
  rows: [
    ['Hosted reviews', '1 per UTC day', 'Unlimited'],
    ['All eleven single profiles, hosted', 'Any one, once a day', yes()],
    [html`<a class="link" href="/gauntlet">Gauntlet</a>: eight stages, one verdict dossier`, exampleOnly(), yes()],
    [html`<a class="link" href="/panel-review">Panel review</a>: two to four models, then cross-examination`, exampleOnly(), yes()],
    ['Hosted reviews running at once', '1', '4'],
    ['Prompt export with paste-back, three core profiles', yes(), yes()],
    ['Free tools', yes(), yes()],
    ['Repository import from GitHub', yes(), yes()],
    ['Local history', yes(), yes()],
    ['MCP: prepare a core profile for your agent’s own model', yes(), yes()],
    [inline('MCP: run any profile hosted with `run_review`'), 'Uses the daily review', 'Unlimited'],
  ],
  className: 'plans-table',
});

const FAQ_ITEMS = [
  {
    q: 'What counts as a hosted review?',
    a: 'One review profile run through bountyoperator.com on your own API key, from the workbench or from a coding agent with `run_review`. Exporting the prompt of a core profile to your chat app does not count and has no daily limit. Neither does a core profile prepared over MCP for your agent’s own model.',
  },
  {
    q: 'Which profiles does the free review cover?',
    a: `Any single profile, all eleven. ${CORE_NAMES} are the three core profiles: they also export as a prompt and prepare over MCP. The other ${WORDS[HOSTED.length]} run hosted only, in the workbench or through \`run_review\`: ${HOSTED_NAMES}.`,
  },
  {
    q: 'When does the free review reset?',
    a: 'At 00:00 UTC. A review the provider fails, refuses or cuts off at the start does not use the day’s allowance.',
  },
  {
    q: 'What does Operator add?',
    a: `Unlimited hosted reviews, the Gauntlet, Panel review and four hosted reviews running at once. The gauntlet from a coding agent over MCP uses ${WORDS[HOSTED_STAGES]} hosted reviews, so it runs on Operator too.`,
  },
  {
    q: 'Who pays for the model?',
    a: 'Your provider bills model usage to your own key. The US$10 per week covers the hosted workbench and does not include model usage.',
  },
  {
    q: 'How does billing work?',
    a: RENEWAL,
  },
  {
    q: 'Can I use a chat subscription instead of an API key?',
    a: 'Yes, on both plans, for the three core profiles: code security review, Solidity review and challenge a draft report. Export the prompt, paste it into your chat app and paste the answer back. The other profiles run hosted on an API key.',
  },
  {
    q: 'Do I need an email address or a card for the free plan?',
    a: 'No. An account is a passkey. A card is entered only at Stripe when you buy Operator.',
  },
];

const body = html`
${pageHero({
  trail: [{ label: 'Bounty Operator', href: '/' }, { label: 'Pricing' }],
  eyebrow: 'Pricing',
  title: 'Bounty Operator pricing: Free, or Operator at US$10 per week',
  lede: 'Two plans. No seats, no credits, no per-line metering. Both run on your own model and your own key, so your provider bills the model usage and Bounty Operator bills a flat week.',
})}

<section class="section section--tight wrap" aria-labelledby="plans">
  <h2 class="visually-hidden" id="plans">Plans</h2>
  <div class="plans__note" data-checkout-note></div>
  <div class="plans">
    <article class="plan" aria-labelledby="plan-free">
      <div class="plan__head">
        <h3 class="plan__name" id="plan-free">Free</h3>
        ${statusChip('free')}
      </div>
      <p class="plan__price"><span class="plan__amount">US$0</span></p>
      <p class="plan__for">One hosted review per UTC day. No card.</p>
      ${tickList([
        '1 hosted review per UTC day',
        'Any of the eleven single profiles',
        'Gauntlet and Panel review: the worked examples',
        '1 hosted review running at a time',
        'Prompt export with paste-back and MCP prepare for the three core profiles, no daily limit',
        'Free tools, repository import and local history',
      ])}
      <div class="plan__cta">${button({ label: 'Run today’s free review', href: workbenchLink(), variant: 'secondary', size: 'lg', block: true })}</div>
    </article>
    <article class="plan plan--accent" aria-labelledby="plan-operator">
      <div class="plan__head">
        <h3 class="plan__name" id="plan-operator">Operator</h3>
        ${statusChip('operator')}
      </div>
      <p class="plan__price"><span class="plan__amount">US$10</span><span class="plan__per">per week</span></p>
      <p class="plan__for">For contest weeks and live hunts.</p>
      ${tickList([
        'Unlimited hosted reviews',
        'All eleven single profiles',
        'The Gauntlet: eight stages, one verdict dossier',
        'Panel review: two to four models, then cross-examination',
        '4 hosted reviews running at once',
        'Everything in Free',
      ])}
      <div class="plan__cta">${button({ label: 'Get Operator', variant: 'primary', size: 'lg', block: true, iconEnd: 'arrow-right', id: 'upgrade', attrs: { 'data-account-action': 'checkout' } })}</div>
    </article>
  </div>
  <p class="fine plans__terms">${RENEWAL}</p>
</section>

<section class="section wrap" aria-labelledby="compare-plans">
  ${sectionHeading({ title: 'Line by line', id: 'compare-plans' })}
  ${planTable}
</section>

<section class="section wrap wrap--narrow" aria-labelledby="faq">
  ${sectionHeading({ title: 'Pricing questions', id: 'faq' })}
  ${faq(FAQ_ITEMS, { exclusive: 'pricing-faq' })}
</section>

<section class="section section--tight wrap">
  ${relatedLinks([
    { label: 'Gauntlet', href: '/gauntlet', text: 'What an Operator run returns, with a full example dossier.' },
    { label: 'Panel review', href: '/panel-review', text: 'Two to four models, then a cross-examination pass.' },
    { label: 'Your model, your key', href: '/your-model-your-key', text: 'Providers, prompt export and what is stored.' },
    { label: 'Compare', href: '/compare', text: 'Bounty Operator next to a chat app, an audit skill and platform pre-checks.' },
  ])}
</section>`;

export default {
  path: PATH,
  title: 'Pricing: Free, or Operator at US$10 per week | Bounty Operator',
  description:
    'Free gives you 1 hosted review per UTC day. Operator is US$10 per week for unlimited reviews, the Gauntlet, Panel review and four reviews at once.',
  label: 'Pricing',
  nav: 'pricing',
  styles: [...STYLES, ...ACCOUNT_STYLES],
  scripts: ACCOUNT_SCRIPTS,
  overlays: accountDialog(),
  jsonld: [breadcrumbsLd([{ name: 'Pricing', path: PATH }]), softwareApplicationLd(), faqPageLd(FAQ_ITEMS)],
  lastmod: LASTMOD,
  body,
};
