// "/": the home page.
//
// Sections: the hero on the field with the report slip, three steps, the five
// verdicts, the workbench, benchmark, resources, pricing and FAQ.
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
// compact result is the first bundled example, opened by "View example".

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  button,
  faq,
  html,
  icon,
  isHtml,
  raw,
  sectionHeading,
  verdictChip,
} from '../components.mjs';
import { SITE, faqPageLd, organizationLd, softwareApplicationLd } from '../layout.mjs';
import { PROFILES } from '../../public/profiles.mjs';
import { PROVIDERS } from '../../public/providers.mjs';
import { reportSlip } from '../social/example.mjs';
import { LEADERBOARDS, VERDICTS } from './method/_shared.mjs';
import { BENCH_TEASER } from './benchmark/_teaser.mjs';
import { AGENT_TICK, CHAT_TICK, RENEWAL, WHY_PAY } from '../plans.mjs';

const LASTMOD = '2026-10-09';
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

// ---------------------------------------------------------------------------
// A short introduction, the review itself, and optional supporting pages.
// ---------------------------------------------------------------------------

const hero = html`
<div class="home-top page-field">
  <section class="wrap home-hero" aria-labelledby="hero-title">
    <div class="home-hero__text">
      <h1 class="display home-hero__title" id="hero-title">Check your report before you submit.</h1>
      <p class="lede home-hero__lede">Add your bug bounty draft and the files it cites. The review argues against the finding, checks every claim against the code and stamps one verdict, with the line that decides it.</p>
      <div class="home-hero__actions">
        ${button({ label: 'Review my report', href: '/?profile=report#workspace', variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}
        ${button({ label: 'View example', href: '#workspace', variant: 'secondary', size: 'lg', attrs: { 'data-demo': true, 'data-example': '' } })}
      </div>
      <p class="home-hero__free">Free: 1 review a day on your own model key.</p>
      <p class="home-hero__note">The example needs no account or API key.</p>
      <p class="home-hero__links">${BENCH_TEASER && html`<a class="link" href="/benchmark">See the model benchmark</a>`}<a class="link" href="/mcp">Use in your coding agent</a></p>
    </div>
    <div class="home-hero__shot">
      ${reportSlip()}
    </div>
  </section>
  <div class="wrap">
    <p class="home-proof fine">Built by Tradi3. <a class="link" href="${LEADERBOARDS.ens}" target="_blank" rel="noopener noreferrer">17 valid Critical submissions in Immunefi’s ENS competition, the most of 186 researchers</a> · <a class="link" href="${LEADERBOARDS.firelight}" target="_blank" rel="noopener noreferrer">2nd of 133 in Firelight</a> · <a class="link" href="${LEADERBOARDS.quantus}" target="_blank" rel="noopener noreferrer">8th of 65 in Quantus</a>.</p>
  </div>
</div>`;

const STEPS = [
  { title: 'Add your files', text: 'Paste text, drop files or import from GitHub.' },
  { title: 'Choose your model', text: 'Use your own API key, or your ChatGPT or Claude chat.' },
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
  <ul class="home-verdicts">${VERDICTS.map((verdict) => html`
    <li class="home-verdicts__item">${verdictChip(verdict.id, { size: 'lg' })}<p class="home-verdicts__text">${verdict.meaning}</p></li>`
  )}</ul>
</section>`;

const resources = html`
<section class="section section--tight wrap" aria-labelledby="free-tools">
  ${sectionHeading({ title: 'More ways to use Bounty Operator', id: 'free-tools' })}
  <ul class="home-resources">
    <li><a class="link" href="/tools">Free tools</a><span>Check a draft, scan for secrets or verify a review packet.</span></li>
    <li><a class="link" href="/mcp">Coding agent setup</a><span>Connect Claude Code, Codex or Cursor.</span></li>
    <li><a class="link" href="/method">How the review works</a><span>The checks behind each verdict.</span></li>
  </ul>
</section>`;

const ticks = (items) => html`<ul class="home-ticks">${items.map((item) => html`<li>${icon('check')}<span>${item}</span></li>`)}</ul>`;

const pricing = html`
<section class="section" id="pricing" aria-labelledby="pricing-title">
  <div class="wrap">
    ${sectionHeading({ title: 'Free for 1 review a day. US$10 a week for unlimited.', id: 'pricing-title', lede: 'Your model provider bills model usage to your own key.' })}
    <div class="home-plans__note" data-checkout-note></div>
    <div class="home-plans">
      <article class="home-plan" aria-labelledby="plan-free">
        <h3 class="home-plan__name" id="plan-free">Free</h3>
        <p class="home-plan__price"><span class="home-plan__amount">US$0</span></p>
        <p class="home-plan__for">No card needed.</p>
        ${ticks([`1 review a day, any of the ${PROFILE_TOTAL} review types`, CHAT_TICK, AGENT_TICK])}
        <div class="home-plan__cta">${button({ label: 'Start a free review', href: '#workspace', size: 'lg', block: true })}</div>
      </article>
      <article class="home-plan home-plan--operator on-stock" aria-labelledby="plan-operator">
        <h3 class="home-plan__name" id="plan-operator">Operator</h3>
        <p class="home-plan__price"><span class="home-plan__amount">US$10</span><span class="home-plan__per">per week</span></p>
        <p class="home-plan__for">Everything in Free, plus:</p>
        ${ticks([
          'Unlimited reviews, 4 at once',
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
    a: html`Yes, for 3 review types: code security, Solidity and draft reports. Copy the prompt into your chat and paste the answer back here. The other review types need an API key. <a class="link" href="/your-model-your-key">Model options</a>`,
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
    a: html`Cancel in the Stripe billing portal. Access continues until the end of your paid week. Contact <a class="link" href="mailto:${SITE.support}">${SITE.support}</a> for access problems or billing help. <a class="link" href="/terms">Refund terms</a>`,
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
${howItWorks}
${verdicts}
${workbenchSection()}
${BENCH_TEASER}
${resources}
${pricing}
${questions}`;

// The fragments name their own stylesheets and scripts. The page always loads
// the app entry module, and the workbench stylesheet as soon as it exists.
const unique = (items) => [...new Set(items)];
const styles = unique([
  '/css/home.css',
  ...lists(workbenchModule, 'styles'),
  ...lists(accountModule, 'styles'),
  ...(publicFile('/css/workbench.css') ? ['/css/workbench.css'] : []),
]);
const scripts = unique(['/app/main.mjs', ...lists(workbenchModule, 'scripts'), ...lists(accountModule, 'scripts')]);

export default {
  path: '/',
  title: 'Bounty Operator | Review your report before you submit',
  description:
    'Review your bug bounty report against its supporting files. Get a verdict, source citations and next steps using your own AI model.',
  label: 'Bounty Operator',
  og: {
    title: 'Check your report before you submit',
    alt: 'Bounty Operator. A draft report claiming Critical, cut to Medium by a review that cites file and line.',
  },
  styles,
  scripts,
  jsonld: [organizationLd(), softwareApplicationLd(), faqPageLd(FAQ_ITEMS)],
  lastmod: LASTMOD,
  body,
  ...(overlays.length ? { overlays: html`${overlays}` } : {}),
};
