// "/": the home page.
//
// Sections, in order: hero, proof strip, how it works, the workbench, the
// gauntlet, what you get, your model, free tools, pricing, questions.
//
// Hooks other streams rely on:
//   [data-demo]      the hero's "Run the example" control; it also carries
//                    [data-example], the attribute /app/main.mjs listens for
//   #workspace       the workbench section (fragment owned by APP)
//   #pricing         the pricing section
//   #upgrade         the "Get Operator" button. It carries [data-upgrade] and
//                    data-account-action="checkout", the attribute /app/account.mjs listens for
//   [data-checkout-note]  where the account script writes its line after a cancelled checkout
//
// Facts are read from the engine at build time (providers, profile count,
// stage taglines, file limits) so the page cannot drift from what runs. The
// rendered result in the hero is the first bundled example, the one "Run the
// example" opens in the workbench: see ../social/example.mjs.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  button,
  chip,
  codeBlock,
  faq,
  hashChip,
  html,
  icon,
  inline,
  isHtml,
  link,
  raw,
  refChip,
  sectionHeading,
  statusChip,
  verdictChip,
} from '../components.mjs';
import { SITE, faqPageLd, organizationLd, softwareApplicationLd } from '../layout.mjs';
import { PROFILES, reviewProfile } from '../../public/profiles.mjs';
import { PROVIDERS } from '../../public/providers.mjs';
import { LIMITS } from '../../public/review-core.mjs';
import { EXAMPLE, exampleShot } from '../social/example.mjs';
import { LEADERBOARDS, STAGES, VERDICTS } from './method/_shared.mjs';
import { TOOLS } from './tools/_shared.mjs';

const LASTMOD = '2026-10-03';
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

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen'];
const word = (count) => WORDS[count] ?? String(count);

const PROFILE_COUNT = word(PROFILES.filter((profile) => profile.listed).length);
const PROVIDER_COUNT = word(PROVIDERS.length);
const PROVIDER_NAMES = PROVIDERS.map((provider) => provider.label);
const PROVIDER_SENTENCE = `${PROVIDER_NAMES.slice(0, -1).join(', ')} or ${PROVIDER_NAMES.at(-1)}`;
const FILE_LIMIT = `Up to ${LIMITS.files} files and ${LIMITS.totalBytes / 1000} KB per review.`;

const MCP_COMMAND = `claude mcp add --transport http bounty-operator ${SITE.origin}/api/mcp`;
const RENEWAL = 'US$10 billed weekly, renews until you cancel in the Stripe portal; access runs to the end of the paid week.';

// ---------------------------------------------------------------------------
// 1. Hero and 2. proof strip
// ---------------------------------------------------------------------------

const hero = html`
<div class="home-top wrap">
  <section class="home-hero" aria-labelledby="hero-title">
    <p class="eyebrow">Pre-submission review for bug bounty hunters and auditors</p>
    <h1 class="display home-hero__title" id="hero-title">Find the hole in your report before the triager does.</h1>
    <p class="lede home-hero__lede">Paste the draft and the code it cites. Your own model checks every claim against file and line, writes the strongest case against it and returns one verdict: submit, rewrite then submit, prove first, hold as a duplicate, or drop.</p>
    <div class="home-hero__actions">
      ${button({ label: 'Run the example', href: '#workspace', variant: 'primary', size: 'lg', iconEnd: 'arrow-right', attrs: { 'data-demo': true, 'data-example': '' } })}
      ${button({ label: 'Challenge my report', href: '/?profile=report#workspace', size: 'lg' })}
    </div>
    <p class="home-hero__note">The example runs with no account and no key.</p>
    <p class="home-hero__price">Free: one hosted review a day. Operator: US$10 a week for unlimited reviews, the full gauntlet, panel review and four at once.</p>
  </section>

  <div class="home-top__shot">
    ${exampleShot({ id: 'hero', rows: ['observed', 'counter', 'next'], steps: false, reveal: true })}
  </div>

  <section class="home-proof" aria-label="Who built it, and from what">
    <ul class="home-proof__list">
      <li class="home-proof__item">
        <span class="meta">Built by</span>
        <span class="home-proof__value">Tradi3</span>
      </li>
      <li class="home-proof__item">
        <span class="meta">Firelight</span>
        <a class="home-proof__value home-proof__link" href="${LEADERBOARDS.firelight}" target="_blank" rel="noopener noreferrer">2nd of 133${icon('arrow-up-right')}<span class="visually-hidden">, Immunefi Firelight leaderboard</span></a>
      </li>
      <li class="home-proof__item">
        <span class="meta">Quantus</span>
        <a class="home-proof__value home-proof__link" href="${LEADERBOARDS.quantus}" target="_blank" rel="noopener noreferrer">8th of 65${icon('arrow-up-right')}<span class="visually-hidden">, Immunefi Quantus leaderboard</span></a>
      </li>
      <li class="home-proof__item home-proof__item--wide">
        <span class="meta">The method</span>
        <a class="home-proof__value home-proof__link" href="/method">Twelve checks from 105 real case files${icon('arrow-right')}</a>
      </li>
    </ul>
  </section>
</div>`;

// ---------------------------------------------------------------------------
// 3. How it works
// ---------------------------------------------------------------------------

const STEPS = [
  {
    title: 'Load the code and the draft',
    text: `Drop files, paste them, or import from GitHub at a pinned commit. ${FILE_LIMIT} Pick one of ${PROFILE_COUNT} profiles.`,
  },
  {
    title: 'Run it on your model',
    text: 'Use your own API key, connect OpenRouter in one click, or call it from your coding agent over MCP. The review goes through our server to your provider. The three core profiles also export as a prompt for your chat app. Read what is sent before it leaves the tab.',
  },
  {
    title: 'Take the verdict and the packet',
    text: 'One verdict, every finding tied to file and line, and the next action. The review, your evidence notes and a SHA-256 manifest download as one record. Bounty Operator stores none of it.',
  },
];

const howItWorks = html`
<section class="section wrap" aria-labelledby="how">
  ${sectionHeading({ title: 'How it works', id: 'how' })}
  <ol class="home-steps">${STEPS.map(
    (step) => html`
    <li class="home-steps__item">
      <h3 class="home-steps__title">${step.title}</h3>
      <p class="home-steps__text">${inline(step.text)}</p>
    </li>`,
  )}</ol>
</section>`;

// ---------------------------------------------------------------------------
// 5. The gauntlet
// ---------------------------------------------------------------------------

// The order runs the gates that end a report before the stages that cost work.
const STAGE_GROUPS = [
  { kind: 'gate', label: 'Gates', note: 'These end a report before the proof costs you a day.', ids: ['scope', 'provenance', 'prior-art'] },
  { kind: 'work', label: 'Work', note: 'What the draft has to show.', ids: ['poc', 'severity', 'triage', 'report'] },
  { kind: 'verdict', label: 'Decision', note: 'One of five.', ids: ['verdict'] },
];

const stageById = new Map(STAGES.map((stage) => [stage.id, stage]));

const pipeline = html`
<div class="home-pipe">${STAGE_GROUPS.map((group) => {
  const stages = group.ids.map((id) => stageById.get(id));
  return html`
  <div class="home-pipe__group" data-kind="${group.kind}" data-count="${stages.length}">
    <p class="home-pipe__label"><span class="meta">${group.label}</span><span class="home-pipe__note">${group.note}</span></p>
    <ol class="home-pipe__stages" start="${stages[0].n}">${stages.map(
      (stage) => html`
      <li class="home-pipe__stage">
        <span class="home-pipe__n" aria-hidden="true">${stage.n}</span>
        <h3 class="home-pipe__name">${stage.name}</h3>
        <p class="home-pipe__text">${reviewProfile(stage.id).tagline}</p>
      </li>`,
    )}</ol>
  </div>`;
})}</div>`;

const verdicts = html`
<dl class="home-verdicts">${VERDICTS.map(
  (verdict) => html`<div class="home-verdicts__row"><dt>${verdictChip(verdict.id)}</dt><dd>${verdict.meaning}</dd></div>`,
)}</dl>`;

const gauntlet = html`
<section class="section home-band" aria-labelledby="gauntlet">
  <div class="wrap">
    ${sectionHeading({
      title: 'The gauntlet: eight stages, one verdict',
      id: 'gauntlet',
      eyebrow: statusChip('operator'),
      lede: 'Hand over the draft, the code and the programme rules. One run takes the report through eight stages in the order that saves work, and ends on one decision.',
      aside: link({ label: 'See a full example dossier', href: '/gauntlet', className: 'home-more' }),
    })}
    ${pipeline}
    <h3 class="home-verdicts__title meta">The run ends on one of five verdicts</h3>
    ${verdicts}
    <div class="cluster home-band__actions">
      ${button({ label: 'Get Operator', href: '#pricing', variant: 'primary', iconEnd: 'arrow-right' })}
      ${button({ label: 'How the gauntlet runs', href: '/gauntlet' })}
    </div>
  </div>
</section>`;

// ---------------------------------------------------------------------------
// 6. What you get
// ---------------------------------------------------------------------------

const GETS = [
  {
    title: 'Every claim tied to file and line',
    text: 'No reference, no claim. A finding cites the lines it rests on, and every reference is checked against the files you supplied.',
    specimen: refChip(EXAMPLE.finding.locations[0]),
  },
  {
    title: 'The triager’s objection first',
    text: 'Each finding carries the strongest case against it and says whether your evidence beats it: resolved or open.',
    specimen: html`${statusChip('resolved')}${statusChip('open')}`,
  },
  {
    title: 'One verdict with one blocker',
    text: 'Submit, rewrite then submit, prove first, hold as a duplicate, or drop. Each finding names the one artefact still missing and the next action.',
    specimen: html`${verdictChip('prove-first')}${chip('1 blocker', { tone: 'unproven', dashed: true })}`,
  },
  {
    title: 'Nothing leaves unseen',
    text: 'A scan in your browser stops private keys, API and GitHub tokens, seed phrases and private report links. You read the request before it leaves the tab. The packet lists every file with its SHA-256.',
    specimen: hashChip(EXAMPLE.sha256),
  },
];

const whatYouGet = html`
<section class="section wrap" aria-labelledby="what-you-get">
  ${sectionHeading({
    title: 'Any model can read code. This makes it argue like a triager.',
    id: 'what-you-get',
  })}
  <ul class="home-gets">${GETS.map(
    (item) => html`
    <li class="home-get">
      <div class="home-get__specimen" aria-hidden="true">${item.specimen}</div>
      <h3 class="home-get__title">${item.title}</h3>
      <p class="home-get__text">${inline(item.text)}</p>
    </li>`,
  )}</ul>
</section>`;

// ---------------------------------------------------------------------------
// 7. Your model
// ---------------------------------------------------------------------------

const yourModel = html`
<section class="section wrap" aria-labelledby="your-model">
  ${sectionHeading({
    title: 'Your model, your key',
    id: 'your-model',
    lede: 'A review runs on the model you choose, under your own key. It passes through our server in memory, which adds the review method and stores no file, key or review. Your provider bills the usage.',
    aside: link({ label: 'Where your code goes', href: '/your-model-your-key', className: 'home-more' }),
  })}
  <ul class="home-providers" aria-label="Providers a hosted review runs on">${PROVIDER_NAMES.map((name) => html`<li>${chip(name, { tone: 'neutral' })}</li>`)}</ul>
  <div class="home-paths">
    <article class="home-path">
      <h3 class="home-path__title">${icon('key')}API key</h3>
      <p class="home-path__text">Paste a key for any of the ${PROVIDER_COUNT} providers, or connect OpenRouter in one click and pick any model it carries. The key is used for the one request it belongs to.</p>
      <p class="home-path__action">${button({ label: 'Run with a key', href: '#workspace', size: 'sm', iconEnd: 'arrow-right' })}</p>
    </article>
    <article class="home-path">
      <h3 class="home-path__title">${icon('copy')}Chat subscription</h3>
      <p class="home-path__text">No key at hand. Export the prompt of a core profile (code security review, Solidity review or challenge a draft report), paste it into ChatGPT, Claude or a local model, then paste the answer back. The workbench turns it into finding cards and a packet. No daily limit.</p>
      <p class="home-path__action">${button({ label: 'Run without a key', href: '#workspace', size: 'sm', iconEnd: 'arrow-right' })}</p>
    </article>
    <article class="home-path home-path--wide">
      <h3 class="home-path__title">${icon('terminal')}Coding agent</h3>
      <p class="home-path__text">Add the MCP endpoint to Claude Code, Codex or Cursor. Your agent prepares a core review from the files in your repository and answers it on its own model, or runs any profile hosted with a connection token and your provider key.</p>
      ${codeBlock({ code: MCP_COMMAND, name: 'Terminal', numbers: false, wrap: true, copy: true, label: 'Claude Code: add the MCP endpoint' })}
      <p class="home-path__action">${link({ label: 'MCP setup for Codex, Cursor and tokens', href: '/mcp', className: 'home-more' })}</p>
    </article>
  </div>
</section>`;

// ---------------------------------------------------------------------------
// 8. Free tools
// ---------------------------------------------------------------------------

const FREE = [
  ...TOOLS.map((tool) => ({ href: tool.path, icon: tool.icon, name: tool.name, text: tool.outcome })),
  {
    href: '/templates',
    icon: 'file',
    name: 'Report templates',
    text: 'Report skeletons for Immunefi, Sherlock, Cantina and HackerOne, and a Foundry proof that asserts the impact.',
  },
  {
    href: '/guide',
    icon: 'eye',
    name: 'Report guide',
    text: 'What a report needs to survive its first read, and one report rewritten fragment by fragment.',
  },
  {
    href: '/method',
    icon: 'shield',
    name: 'The twelve checks',
    text: 'Every check exists because real reports were closed for that reason. The question each one asks, and why reports die on it.',
  },
];

const freeTools = html`
<section class="section wrap" aria-labelledby="free-tools">
  ${sectionHeading({
    title: 'Free tools',
    id: 'free-tools',
    lede: 'No account, no key. Each tool runs in your browser.',
    aside: link({ label: 'All tools', href: '/tools', className: 'home-more' }),
  })}
  <ul class="home-tools">${FREE.map(
    (item) => html`
    <li><a class="home-tool" href="${item.href}">
      <span class="home-tool__name">${icon(item.icon)}${item.name}</span>
      <span class="home-tool__text">${item.text}</span>
      <span class="home-tool__go" aria-hidden="true">${icon('arrow-right')}</span>
    </a></li>`,
  )}</ul>
</section>`;

// ---------------------------------------------------------------------------
// 9. Pricing
// ---------------------------------------------------------------------------

const ticks = (items) => html`<ul class="home-ticks">${items.map((item) => html`<li>${icon('check')}<span>${item}</span></li>`)}</ul>`;

const pricing = html`
<section class="section home-band" id="pricing" aria-labelledby="pricing-title">
  <div class="wrap">
    ${sectionHeading({
      title: 'US$10 a week. Unlimited reviews. Your model.',
      id: 'pricing-title',
      lede: 'Two plans. No seats, no credits, no per-line metering.',
    })}
    <div class="home-plans__note" data-checkout-note></div>
    <div class="home-plans">
      <article class="home-plan" aria-labelledby="plan-free">
        <div class="home-plan__head">
          <h3 class="home-plan__name" id="plan-free">Free</h3>
          ${statusChip('free')}
        </div>
        <p class="home-plan__price"><span class="home-plan__amount">US$0</span></p>
        <p class="home-plan__for">One hosted review per UTC day. No card.</p>
        ${ticks([
          '1 hosted review per UTC day',
          `Any of the ${PROFILE_COUNT} single profiles`,
          html`<a class="link" href="/gauntlet">Gauntlet</a> and <a class="link" href="/panel-review">Panel review</a>: the worked examples`,
          'Prompt export and MCP prepare for the three core profiles, no daily limit',
          'Free tools, GitHub import and local history',
        ])}
        <div class="home-plan__cta">${button({ label: 'Run today’s free review', href: '#workspace', size: 'lg', block: true })}</div>
      </article>
      <article class="home-plan home-plan--operator" aria-labelledby="plan-operator">
        <div class="home-plan__head">
          <h3 class="home-plan__name" id="plan-operator">Operator</h3>
          ${statusChip('operator')}
        </div>
        <p class="home-plan__price"><span class="home-plan__amount">US$10</span><span class="home-plan__per">per week</span></p>
        <p class="home-plan__for">For contest weeks and live hunts.</p>
        ${ticks([
          'Unlimited hosted reviews',
          html`The <a class="link" href="/gauntlet">Gauntlet</a>: eight stages, one verdict dossier`,
          html`<a class="link" href="/panel-review">Panel review</a>: two to four models, then cross-examination`,
          'Four hosted reviews running at once',
          'Everything in Free',
        ])}
        <div class="home-plan__cta">${button({ label: 'Get Operator', id: 'upgrade', variant: 'primary', size: 'lg', block: true, iconEnd: 'arrow-right', attrs: { 'data-upgrade': true, 'data-account-action': 'checkout' } })}</div>
      </article>
    </div>
    <p class="fine home-plans__terms">${RENEWAL} <a class="link" href="/terms">Terms</a></p>
  </div>
</section>`;

// ---------------------------------------------------------------------------
// 10. Questions
// ---------------------------------------------------------------------------

const FAQ_ITEMS = [
  {
    q: 'Can I use my ChatGPT or Claude subscription?',
    a: 'Yes, for the three core profiles: code security review, Solidity review and challenge a draft report. Export the prompt, paste it into your chat app and paste the answer back. The workbench turns the answer into finding cards and a packet, with no key and no daily limit. Every other profile, the Gauntlet and Panel review run hosted on an API key, which providers bill separately from a chat subscription. A free account runs any single profile hosted once per UTC day. Claude Code, Codex and Cursor connect over MCP.',
  },
  {
    q: 'What do you keep?',
    a: 'No code, no prompts, no keys, no results. A hosted review passes through our server in memory: it adds the review method and sends your files, with your key, to the provider you chose. We store a random account identifier, your passkey public keys, hashed tokens, seven days of review activity (status, profile and timestamps) and Stripe references. No ad cookies, no tracking pixels, no third-party analytics scripts.',
  },
  {
    q: 'What is in a review?',
    a: 'One verdict and a one-sentence headline. Then each finding: severity, the lines it rests on, who loses what, the path step by step, the strongest counterargument and whether it is resolved, the one missing artefact, a fix, a test and the next action. After the findings come hardening notes, what was checked and found safe, and which files were read. It downloads as one packet with a SHA-256 manifest. A review reads the files you supply; it runs no code and touches no target.',
  },
  {
    q: 'Which models does it run on?',
    a: `The one you pick, for every review. Hosted reviews run on your key at ${PROVIDER_SENTENCE}, and an OpenRouter key reaches models from several labs. The prompt export of the core profiles works with any chat or local model.`,
  },
  {
    q: 'What does Operator add?',
    a: 'Unlimited hosted reviews, the Gauntlet (eight stages, one verdict dossier), Panel review (two to four models, then a cross-examination pass) and four hosted reviews running at once. US$10 per week.',
  },
  {
    q: 'Who runs it, and what about refunds?',
    a: `Tradi3 builds it and submits to the same queues: 2nd of 133 in Immunefi’s Firelight competition, 8th of 65 in Quantus. Payment runs through Stripe. Cancel in the billing portal and access runs to the end of the paid week. If you paid and got no access, or the service was down for a material part of your week, we fix it or refund that charge. Support: ${SITE.support}.`,
  },
];

const questions = html`
<section class="section wrap" aria-labelledby="faq">
  <div class="home-faq">
    ${sectionHeading({
      title: 'Questions',
      id: 'faq',
      lede: html`The rest is in the <a class="link" href="/terms">terms</a> and the <a class="link" href="/privacy">privacy page</a>.`,
    })}
    ${faq(FAQ_ITEMS, { exclusive: 'home-faq' })}
  </div>
</section>`;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const body = html`
${hero}
${howItWorks}
${workbenchSection()}
${gauntlet}
${whatYouGet}
${yourModel}
${freeTools}
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
  title: 'Bounty Operator — find the hole in your bug bounty report before the triager does',
  description:
    'Your own model checks a draft report against the code it cites and returns one verdict: submit, rewrite then submit, prove first, hold as a duplicate, or drop.',
  label: 'Bounty Operator',
  og: {
    title: 'Find the hole in your report before the triager does',
    alt: 'Bounty Operator. A draft report claiming Critical, cut to Medium by a review that cites file and line.',
  },
  styles,
  scripts,
  jsonld: [organizationLd(), softwareApplicationLd(), faqPageLd(FAQ_ITEMS)],
  lastmod: LASTMOD,
  body,
  ...(overlays.length ? { overlays: html`${overlays}` } : {}),
};
