// "/": the home page.
//
// Sections: Spec and the product promise, a confirmed finding, workbench,
// supporting examples, verdicts, benchmark, pricing and FAQ.
//
// Hooks other streams rely on:
//   [data-demo]      the hero's "View example" control; it also carries
//                    [data-example], the attribute /app/main.mjs listens for
//   #workspace       the workbench section (fragment owned by APP)
//   #pricing         the pricing section
//   #upgrade         the "Get Operator" button. It carries [data-upgrade] and
//                    data-account-action="checkout", the attribute /app/account.mjs listens for
//   [data-checkout-note]  where the account script writes its line after a cancelled checkout
//
// Providers and the profile count come from the engine at build time. The
// leading saved review opens the named confirmed-critical example.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  button,
  disclosure,
  faq,
  html,
  icon,
  isHtml,
  link,
  raw,
  sectionHeading,
  verdictChip,
} from '../components.mjs';
import { SITE, faqPageLd, organizationLd, softwareApplicationLd, websiteLd } from '../layout.mjs';
import { PROFILES } from '../../public/profiles.mjs';
import { PROVIDERS } from '../../public/providers.mjs';
import { reportSlip } from '../social/example.mjs';
import { IMMUNEFI, LEADERBOARDS, VERDICTS } from './method/_shared.mjs';
import { BENCH_TEASER } from './benchmark/_teaser.mjs';
import { ACCOUNT_TICK, AGENT_TICK, CHAT_TICK, FREE_LINE, INCLUDED_API_CREDIT, RENEWAL, SERVER_ONLY_EXAMPLES, SERVER_ONLY_TYPES, WHY_PAY } from '../plans.mjs';
import { walkthrough } from '../walkthroughs.mjs';

const LASTMOD = '2026-10-21';
const DEV_BUILD = process.argv.includes('--dev');

// ---------------------------------------------------------------------------
// Fragments owned by the app team
// ---------------------------------------------------------------------------

/**
 * Load a fragment module. A fragment that has not been written yet renders
 * nothing. One that throws fails a production build and only warns in a dev
 * build, so a half-written file cannot hide in a release.
 */
async function loadFragment(file) {
  const url = new URL(`../fragments/${file}`, import.meta.url);
  if (!existsSync(fileURLToPath(url))) {
    console.warn(`warning  index.mjs: fragments/${file} does not exist yet; its part of the page is empty`);
    return {};
  }
  try {
    return await import(url.href);
  } catch (error) {
    if (!DEV_BUILD) throw error;
    console.warn(`warning  index.mjs: fragments/${file} failed to load (${error.message}); its part of the page is empty`);
    return {};
  }
}

/** One export of a fragment as markup: a function is called, a value is used as it is. */
function markup(module, name) {
  const value = typeof module[name] === 'function' ? module[name]() : module[name];
  if (value === undefined || value === null || value === '') return null;
  return isHtml(value) ? value : raw(String(value));
}

/** Every stylesheet or script list a fragment exports: workbenchStyles, ACCOUNT_SCRIPTS, … */
function lists(module, suffix) {
  return Object.entries(module)
    .filter(([name, value]) => name.toLowerCase().endsWith(suffix) && Array.isArray(value))
    .flatMap(([, value]) => value);
}

const workbenchModule = await loadFragment('workbench.mjs');
const accountModule = await loadFragment('account-dialog.mjs');

const workbenchFragment = markup(workbenchModule, 'workbench');
const overlays = [markup(workbenchModule, 'workbenchDialogs'), markup(accountModule, 'accountDialog')].filter(Boolean);

/** The workbench section. #workspace always exists, so every /#workspace link lands. */
function workbenchSection() {
  if (!workbenchFragment) return html`<section id="workspace" class="home-workbench" aria-label="Workbench"></section>`;
  if (/\sid="workspace"/.test(String(workbenchFragment))) return workbenchFragment;
  return html`<section id="workspace" class="home-workbench" aria-label="Workbench">${workbenchFragment}</section>`;
}

const publicFile = (path) => existsSync(fileURLToPath(new URL(`../../public${path}`, import.meta.url)));

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

const PROFILE_TOTAL = PROFILES.filter((profile) => profile.listed).length;
const PROVIDER_NAMES = PROVIDERS.map((provider) => provider.label);
const PROVIDER_SENTENCE = `${PROVIDER_NAMES.slice(0, -1).join(', ')} or ${PROVIDER_NAMES.at(-1)}`;

// A review type's name is not broken at its hyphen at the end of a line.
const keepTogether = (name) => html`<span class="nowrap">${name}</span>`;

// ---------------------------------------------------------------------------
// A short introduction, the review itself, and optional supporting pages.
// ---------------------------------------------------------------------------

const hero = html`
<div class="home-top">
  <section class="wrap home-hero" aria-labelledby="hero-title">
    <div class="home-hero__text">
      <h1 class="display home-hero__title" id="hero-title">${SITE.promise}</h1>
      <p class="lede home-hero__lede">${SITE.summary}</p>
      <div class="home-hero__actions">
        ${button({ label: 'Review my report', href: '/?profile=report&via=export#workspace', variant: 'primary', size: 'lg' })}
        ${button({ label: 'View example', href: '/?start=example&example=confirmed-critical#workspace', variant: 'secondary', size: 'lg', attrs: { 'data-demo': true, 'data-example': 'confirmed-critical' } })}
        <a class="link home-hero__film" href="/mcp#install">Use my coding agent ${icon('arrow-right')}</a>
      </div>
      <dl class="home-hero__free">
        <div><dt>No account</dt><dd>Code, Solidity and draft-report reviews in your AI chat or coding agent. Use the AI you already have; its usual costs and limits apply.</dd></div>
        <div><dt>Free account</dt><dd>All ${PROFILE_TOTAL} review types on this site, ${keepTogether(SERVER_ONLY_EXAMPLES[0])} and ${keepTogether(SERVER_ONLY_EXAMPLES[1])} included: 1 a day on your own API key from OpenRouter, OpenAI, Anthropic or another provider.</dd></div>
      </dl>
    </div>
    <div class="home-hero__shot">
      <figure class="spec-portrait">
        <img src="/brand/spec-960.webp" srcset="/brand/spec-640.webp 640w, /brand/spec-960.webp 960w" sizes="(min-width: 60em) 42vw, (min-width: 40em) 30rem, 90vw" width="960" height="960" fetchpriority="high" alt="Spec, a sceptical coral bug in a blue work jacket, holding a magnifying glass.">
        <figcaption><strong>Meet Spec.</strong><span>A bug with standards.</span></figcaption>
      </figure>
    </div>
  </section>
  <div class="wrap">
    <p class="home-proof">Built by Tradi3, ${link({ label: `${IMMUNEFI.badge} on Immunefi`, href: IMMUNEFI.profile, external: true })}: ${IMMUNEFI.rank} on its all-time leaderboard on ${IMMUNEFI.readOn}.</p>
    <ul class="home-stats">
      <li><a class="home-stats__item" href="${LEADERBOARDS.ens}" target="_blank" rel="noopener noreferrer"><span class="home-stats__n">17</span> <span class="home-stats__t">valid Critical submissions in Immunefi’s ENS competition, the most of 186 researchers</span></a></li>
      <li><a class="home-stats__item" href="${LEADERBOARDS.firelight}" target="_blank" rel="noopener noreferrer"><span class="home-stats__n">2nd</span> <span class="home-stats__t">of 133 in Firelight</span></a></li>
      <li><a class="home-stats__item" href="${LEADERBOARDS.quantus}" target="_blank" rel="noopener noreferrer"><span class="home-stats__n">8th</span> <span class="home-stats__t">of 65 in Quantus</span></a></li>
    </ul>
  </div>
</div>`;

const confirmedExample = html`
<section class="section wrap" id="confirmed-example" aria-labelledby="confirmed-title">
  <div class="spec-example">
    <div>
      ${sectionHeading({ title: 'See why this Critical holds up.', id: 'confirmed-title', lede: 'Explore a saved review of the invented Halyard Treasury. The draft claims a 3-of-5 approval bypass; the code and supplied proof support it.' })}
      <p>Follow the finding from its claim to the deciding source lines and proof of concept. Then put your own report through the same checks.</p>
      <p class="spec-example__link">${button({ label: 'Inspect the confirmed finding', href: '/?start=example&example=confirmed-critical#workspace', variant: 'secondary', attrs: { 'data-example': 'confirmed-critical' } })}</p>
    </div>
    <div class="spec-example__report">
      ${reportSlip({ exampleId: 'confirmed-critical', still: true })}
    </div>
  </div>
</section>`;

const meetSpec = html`
<section class="section section--tight wrap" id="meet-spec" aria-label="Supporting review examples">
  ${disclosure({
    summary: 'When a claim needs correcting',
    hint: 'Tessera example and videos',
    body: html`
      ${sectionHeading({ title: 'A different outcome, backed by the same checks.', id: 'spec-title', lede: 'In the invented Tessera Staking example, the reward-theft finding holds, but the evidence does not support a loss of staked principal.' })}
      <div class="spec-example">
        ${walkthrough('spec', 'spec-title')}
        <div class="spec-example__report">
          ${reportSlip({ still: true })}
          <p class="spec-example__link"><a class="link" href="/?start=example#workspace">Inspect the Tessera example ${icon('arrow-right')}</a></p>
        </div>
      </div>
      <section class="section section--tight" id="product-video" aria-labelledby="product-video-title">
        ${sectionHeading({ title: 'Follow the Tessera review in the workbench.', id: 'product-video-title', lede: 'The 54-second walkthrough follows this saved example from the draft to the cited code and downloadable packet.' })}
        ${walkthrough('product', 'product-video-title')}
        <p class="fine">Working in a coding agent? <a class="link" href="/mcp#mcp-walkthrough">Watch the MCP walkthrough</a>.</p>
      </section>`,
  })}
</section>`;

const STEPS = [
  { title: 'Add your files', text: 'Paste text, drop files or import from GitHub.' },
  { title: 'Choose your AI', text: 'Use your AI chat, connect a coding agent, or choose a provider with your own API key.' },
  { title: 'Read the result', text: 'See the verdict, source citations and next steps.' },
];

const howItWorks = html`
<section class="section section--tight wrap" aria-labelledby="how">
  <h2 class="visually-hidden" id="how">How it works</h2>
  <ol class="home-steps">${STEPS.map((step, index) => html`
    <li class="home-steps__item"><span class="home-steps__n" aria-hidden="true">${index + 1}</span><h3 class="home-steps__title">${step.title}</h3><p class="home-steps__text">${step.text}</p></li>`
  )}</ol>
</section>`;

// The five verdicts a review can stamp, with what each one means.
const verdicts = html`
<section class="section section--tight wrap" aria-labelledby="verdicts-title">
  ${sectionHeading({ title: 'Every review ends in one of five verdicts.', id: 'verdicts-title', lede: 'One decision, with the file and line behind it. The draft stays yours to rewrite.' })}
  <ul class="home-verdicts rise">${VERDICTS.map((verdict) => html`
    <li class="home-verdicts__item">${verdictChip(verdict.id, { size: 'lg' })}<p class="home-verdicts__text">${verdict.meaning}</p></li>`
  )}</ul>
</section>`;

const resources = html`
<section class="section section--tight wrap" aria-labelledby="free-tools">
  ${sectionHeading({ title: 'More ways to use Bounty Operator', id: 'free-tools' })}
  <ul class="home-resources">
    <li><a class="link" href="/tools">Free tools</a><span>Check a draft, scan for secrets or verify a review packet.</span></li>
    <li><a class="link" href="/mcp#install">Coding agent setup</a><span>Connect Claude Code, Codex, Cursor or OpenCode. Core reviews need no account.</span></li>
    <li><a class="link" href="/method">How the review works</a><span>The checks behind each verdict.</span></li>
  </ul>
</section>`;

const ticks = (items) => html`<ul class="home-ticks">${items.map((item) => html`<li>${icon('check')}<span>${item}</span></li>`)}</ul>`;

const pricing = html`
<section class="section" id="pricing" aria-labelledby="pricing-title">
  <div class="wrap">
    ${sectionHeading({ title: 'Free for 1 review a day. US$10 a month for unlimited.', id: 'pricing-title', lede: 'Operator includes US$2 in Bounty Operator API credit per paid month. Other model providers bill usage separately.' })}
    <div class="home-plans__note" data-checkout-note></div>
    <div class="home-plans rise">
      <article class="home-plan" aria-labelledby="plan-free">
        <h3 class="home-plan__name" id="plan-free">Free</h3>
        <p class="home-plan__price"><span class="home-plan__amount">US$0</span></p>
        <p class="home-plan__for">No card or email.</p>
        ${ticks([FREE_LINE.replace(/\.$/, ''), ACCOUNT_TICK, CHAT_TICK, AGENT_TICK])}
        <div class="home-plan__cta">${button({ label: 'Start a free review', href: '#workspace', size: 'lg', block: true })}</div>
      </article>
      <article class="home-plan home-plan--operator" aria-labelledby="plan-operator">
        <h3 class="home-plan__name" id="plan-operator">Operator</h3>
        <p class="home-plan__price"><span class="home-plan__amount">US$10</span><span class="home-plan__per">per month</span></p>
        <p class="home-plan__for">Everything in Free, plus:</p>
        ${ticks([
          'Unlimited reviews, 4 at once',
          INCLUDED_API_CREDIT,
          html`<a class="link" href="/gauntlet">Gauntlet</a>: eight stages on one finding, then a verdict`,
          html`<a class="link" href="/panel-review">Panel review</a>: compare 2 to 4 models`,
        ])}
        <div class="home-plan__cta">${button({ label: 'Get Operator', id: 'upgrade', variant: 'primary', size: 'lg', block: true, attrs: { 'data-upgrade': true, 'data-account-action': 'checkout' } })}</div>
      </article>
    </div>
    <p class="fine home-plans__terms">${RENEWAL} <a class="link" href="/pricing">Full plan comparison</a> · <a class="link" href="/terms">Terms</a></p>
  </div>
</section>`;

const FAQ_ITEMS = [
  {
    q: 'I already pay for my model. Why pay for this?',
    a: html`${WHY_PAY} <a class="link" href="/pricing">Pricing</a>`,
  },
  {
    q: 'Can I use my ChatGPT or Claude subscription?',
    a: html`Yes, for 3 review types: code security, Solidity and draft reports. Copy the prompt into your chat and paste the answer back here. The other ${SERVER_ONLY_TYPES} review types need an API key and a free account. <a class="link" href="/your-model-your-key">Model options</a>`,
  },
  {
    q: 'Where do my files go?',
    a: html`Your files and API key pass through our server to your provider. The server adds the review instructions and stores no files, prompts, keys or results. A copy-paste prompt stays in your browser until you copy it. <a class="link" href="/privacy">Privacy details</a>`,
  },
  {
    q: 'Which models can I use?',
    a: `Choose a model from ${PROVIDER_SENTENCE}, on your own API key.`,
  },
  {
    q: 'How do I cancel or get help?',
    a: html`Cancel in the Stripe billing portal. Access continues until the end of your paid period. Contact <a class="link" href="mailto:${SITE.support}">${SITE.support}</a> for access problems or billing help. <a class="link" href="/terms">Refund terms</a>`,
  },
];

const questions = html`
<section class="section section--tight wrap" aria-labelledby="faq">
  <div class="home-faq">
    ${sectionHeading({ title: 'Questions', id: 'faq' })}
    ${faq(FAQ_ITEMS, { exclusive: 'home-faq' })}
  </div>
</section>`;


// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const body = html`
${hero}
${confirmedExample}
${workbenchSection()}
${meetSpec}
${verdicts}
${BENCH_TEASER}
${pricing}
${questions}`;

// The fragments name their own stylesheets and scripts. The page always loads
// the app entry module, and the workbench stylesheet as soon as it exists.
const unique = (items) => [...new Set(items)];
const styles = unique([
  '/css/home.css',
  '/css/walkthrough.css',
  ...lists(workbenchModule, 'styles'),
  ...lists(accountModule, 'styles'),
  ...(publicFile('/css/workbench.css') ? ['/css/workbench.css'] : []),
]);
const scripts = unique(['/app/main.mjs', ...lists(workbenchModule, 'scripts'), ...lists(accountModule, 'scripts')]);

export default {
  path: '/',
  title: 'Bounty Operator: pre-submission review for bug bounty reports',
  description: SITE.summary,
  label: 'Bounty Operator',
  og: {
    title: SITE.promise,
    alt: `Bounty Operator. ${SITE.promise} Spec, a coral bug with a magnifying glass.`,
  },
  styles,
  scripts,
  jsonld: [websiteLd(), organizationLd(), softwareApplicationLd(), faqPageLd(FAQ_ITEMS)],
  lastmod: LASTMOD,
  body,
  ...(overlays.length ? { overlays: html`${overlays}` } : {}),
};
