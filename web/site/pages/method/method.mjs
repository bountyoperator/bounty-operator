// /method: why bug bounty reports get closed. The twelve checks, what makes a
// report land, and the eight-stage gauntlet.
//
// Depth is fixed by .local/build/PUBLIC-METHOD.md. For each check the page
// gives its name, the one question it asks, why reports die on it and the
// verdict it leads to. For each gauntlet stage: its name, its question and the
// names of what it outputs. How a check is executed is the hosted product and
// is not described here.

import { button, card, dossier, html, icon, rail, sectionHeading, statusChip, verdictChip } from '../../components.mjs';
import { SITE, absoluteUrl, breadcrumbsLd } from '../../layout.mjs';
import {
  CHECKS,
  GAUNTLET_EXAMPLE,
  LASTMOD,
  RECORD_CLAIM,
  STYLES,
  checksRunLine,
  exampleFrame,
  forcedChip,
  pageHero,
  pipeline,
  proofLine,
  relatedLinks,
  stageList,
  tickList,
  verdictList,
  workbenchLink,
} from './_shared.mjs';

const PATH = '/method';
const TITLE = 'The twelve checks that decide a bug bounty report';

// ---------------------------------------------------------------------------
// The twelve checks (the data is CHECKS in _shared.mjs)
// ---------------------------------------------------------------------------

function leadChips(check) {
  return check.leads.map((lead) => (typeof lead === 'string' ? verdictChip(lead) : forcedChip(lead.label)));
}

function checkCard(check) {
  const id = `check-${check.n}`;
  const number = String(check.n).padStart(2, '0');
  return html`
<article class="finding check-card" id="${id}" aria-labelledby="${id}-title">
  <header class="finding__head">
    <div class="finding__tags"><span class="finding__id">Check ${number}</span></div>
    <h3 class="finding__title" id="${id}-title">${check.name}</h3>
  </header>
  <dl class="finding__rows">
    ${rail('observed', html`<p class="check-card__asks">${check.asks}</p>`, { label: 'Asks' })}
    ${rail('gap', html`<p>${check.why}</p>`, { label: 'Why it kills' })}
    ${rail('next', html`<p class="check-card__leads">${leadChips(check)}</p>`, { label: 'Leads to' })}
  </dl>
</article>`;
}

const checksIndex = html`
<nav class="toc" aria-label="The twelve checks">
  <p class="meta">The twelve checks</p>
  <ol class="toc__list">${CHECKS.map(
    (check) => html`<li><a href="#check-${check.n}"><span class="toc__n">${String(check.n).padStart(2, '0')}</span>${check.name}</a></li>`,
  )}</ol>
</nav>`;

// ---------------------------------------------------------------------------
// Closure reasons, mapped to checks
// ---------------------------------------------------------------------------

function checkRefs(numbers) {
  return numbers.map((number, index) => html`${index > 0 ? ' ' : ''}<a class="checkref" href="#check-${number}">${String(number).padStart(2, '0')}</a>`);
}

const CLOSURES = [
  ['Out of scope', 'The file is not in the scoped asset, the revision is not the deployed one, or an exclusion names the bug class.', [4, 5]],
  ['Intended behaviour', 'A comment, a project test or the introducing commit describes the behaviour as the design.', [3]],
  ['Trusted role or user error', 'A decisive step is performed by an admin, an operator or the victim.', [1]],
  ['Duplicate or known issue', 'A known issue, an audit note, a branch, a pull request or your own earlier report has the same root cause or the same fix.', [6, 7, 12]],
  ['Impact not demonstrated', 'The proof shows the bug and never asserts the loss, a mock performs the deciding step, or the starting state has no public route.', [8, 9]],
  ['Severity downgraded', 'The loss is recoverable, or the body argues a lower row than the one selected.', [10]],
  ['Incomplete submission', 'The stored submission is missing the proof, or the form says one thing and the body another.', [11]],
];

const closureList = html`
<ul class="closures" aria-label="Closure reasons and the checks that catch them">
  <li class="closures__head" aria-hidden="true"><span>Closed as</span><span>What the triager saw</span><span>Checks</span></li>
  ${CLOSURES.map(
    ([reason, saw, numbers]) => html`<li class="closures__row"><p class="closures__reason">${reason}</p><p class="closures__saw">${saw}</p><span class="checkrefs"><span class="visually-hidden">Checks </span>${checkRefs(numbers)}</span></li>`,
  )}
</ul>`;

// ---------------------------------------------------------------------------
// What makes a report land
// ---------------------------------------------------------------------------

const LANDS = [
  { text: 'An executed proof with its command and output, plus a control case.', checks: [3, 8] },
  { text: 'A final assertion on the object the impact row names: a balance, an owner, a stored record.', checks: [4, 8] },
  { text: 'The exact code location on a pinned revision, and a concrete fix.', checks: [5] },
  { text: 'A title that states mechanism and consequence in one sentence, with numbered attack steps kept separate from test code.', checks: [1] },
  { text: 'Limits and non-claims stated by the author, with the nearest known issue named and distinguished.', checks: [6] },
  { text: 'The impact row quoted verbatim.', checks: [4, 10] },
  { text: 'Filed within hours of reproduction, with variants folded into one report.', checks: [7, 12] },
];

const landList = html`
<ul class="lands">${LANDS.map(
  (item) => html`<li class="lands__item">${icon('check')}<p class="lands__text">${item.text}</p><span class="checkrefs">${checkRefs(item.checks)}</span></li>`,
)}</ul>`;

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

const heroAside = html`
<div class="glance">
  <p class="meta">Every check leads to a decision</p>
  ${verdictList()}
  <p class="fine">The gauntlet returns exactly one of these, with one blocker and the cheapest action that removes it.</p>
</div>`;

const body = html`
${pageHero({
  trail: [{ label: 'Bounty Operator', href: '/' }, { label: 'Method' }],
  eyebrow: 'Why bug bounty reports get rejected',
  title: TITLE,
  lede: `${RECORD_CLAIM} Every check exists because real reports were closed for that reason. For each one: the question it asks, why reports die on it and the verdict it leads to.`,
  actions: html`${button({ label: 'Start a free review', href: workbenchLink(), variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${button({ label: 'Go to the gauntlet', href: '#gauntlet', size: 'lg' })}`,
  note: 'Free: 1 review a day on your own model. No card.',
  after: proofLine(),
  aside: heroAside,
})}

<section class="section section--tight wrap" aria-labelledby="closures">
  ${sectionHeading({
    title: 'The closure reason, and the check that catches it',
    id: 'closures',
    lede: 'A report is closed at the first of these a triager reaches. Each one is answered by a check that comes before the report is filed.',
  })}
  ${closureList}
</section>

<section class="section wrap" aria-labelledby="checks">
  ${sectionHeading({
    title: 'The twelve checks',
    id: 'checks',
    lede: 'Each check asks one question. A report that fails the first never needs a proof.',
  })}
  <div class="checks">
    ${checksIndex}
    <div class="checks__list">
      <div class="findings">${CHECKS.map(checkCard)}</div>
      <p class="checks__run">${icon('play')}<span>${checksRunLine()}</span></p>
    </div>
  </div>
</section>

<section class="section wrap" aria-labelledby="land">
  ${sectionHeading({
    title: 'What makes a report land',
    id: 'land',
    lede: 'The reports that were paid share these. Each line answers one or more of the checks before the triager asks.',
  })}
  ${landList}
</section>

<section class="section wrap" aria-labelledby="gauntlet">
  ${sectionHeading({
    title: 'The eight-stage gauntlet',
    id: 'gauntlet',
    lede: 'The same checks, run as eight stages on your draft, your code and the programme rules. The order runs the gates that end a report before the stages that cost work.',
    aside: html`${statusChip('operator')} <a class="link" href="/gauntlet">How a run looks</a>`,
  })}
  ${pipeline()}
  ${stageList({ checkBase: '' })}
  <div class="gauntlet-end">
    ${exampleFrame({
      label: 'What stage 8 hands you · invented protocol',
      body: dossier({ verdict: GAUNTLET_EXAMPLE.verdict, headline: GAUNTLET_EXAMPLE.headline, counts: GAUNTLET_EXAMPLE.counts }),
    })}
    <p class="fine">One decision, one blocker, the cheapest action that removes it and a filing deadline. <a class="link" href="/gauntlet">Read the full example dossier</a></p>
  </div>
</section>

<section class="section wrap" aria-labelledby="run">
  ${sectionHeading({
    title: 'Two ways to run it',
    id: 'run',
    lede: 'Both run on your own model and your own key.',
  })}
  <div class="grid grid--2">
    ${card({
      title: 'One review type at a time',
      meta: statusChip('free'),
      body: html`<div class="stack stack--12">
        <p>Pick the review type that matches the check you are on: scope, design intent, prior art, proof, severity, triager or report. Free: 1 review a day.</p>
        ${tickList([
          'All 11 review types, on your own key',
          'Code security, Solidity and draft-report reviews also work in ChatGPT or Claude: copy the prompt, paste the answer back',
          'A downloadable review packet with a SHA-256 hash of every file',
        ])}
      </div>`,
      foot: html`${button({ label: 'Start a review', href: workbenchLink(), variant: 'secondary', iconEnd: 'arrow-right' })}`,
    })}
    ${card({
      title: 'The full gauntlet',
      meta: statusChip('operator', 'Operator · US$10/week'),
      variant: 'accent',
      body: html`<div class="stack stack--12">
        <p>One run takes the draft through all eight stages and ends in one verdict. Each stage reads the output of the stages before it.</p>
        ${tickList(['Unlimited reviews', 'The Gauntlet and Panel review', '4 reviews running at once'])}
      </div>`,
      foot: html`<div class="cluster">${button({ label: 'See pricing', href: '/pricing', variant: 'primary', iconEnd: 'arrow-right' })}${button({ label: 'See a gauntlet run', href: '/gauntlet', variant: 'quiet' })}</div>`,
    })}
  </div>
</section>

<section class="section section--tight wrap">
  ${relatedLinks([
    { label: 'Challenge a draft report', href: '/challenge-report', text: 'Every claim in your draft, checked against the code.' },
    { label: 'Triager simulation', href: '/triager-simulation', text: 'The three reasons a triager closes this report, ranked.' },
    { label: 'Prior-art overlap', href: '/prior-art-check', text: 'Same root cause, or only the same symptom.' },
    { label: 'Solidity review', href: '/solidity-review', text: 'Entry points, invariants and value flow in Solidity contracts.' },
    { label: 'Code security review', href: '/code-security-review', text: 'Authorization, data handling and failure paths in any codebase.' },
    { label: 'Your model, your key', href: '/your-model-your-key', text: 'Where your code goes and what is stored.' },
    { label: 'Compare', href: '/compare', text: 'Bounty Operator next to a chat app, an audit skill and platform pre-checks.' },
  ])}
</section>`;

const DESCRIPTION =
  'Why bug bounty reports get closed: twelve checks, the question each one asks, why reports die on it and the verdict it leads to. From 105 real case files.';

const articleLd = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: TITLE,
  description: DESCRIPTION,
  url: absoluteUrl(PATH),
  mainEntityOfPage: absoluteUrl(PATH),
  datePublished: LASTMOD,
  dateModified: LASTMOD,
  author: { '@type': 'Organization', name: SITE.builder.name, url: SITE.builder.url },
  publisher: { '@type': 'Organization', name: SITE.name, url: `${SITE.origin}/`, logo: { '@type': 'ImageObject', url: absoluteUrl('/icon-512.png') } },
  image: absoluteUrl(SITE.defaultImage),
};

const checksLd = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'The twelve checks',
  numberOfItems: CHECKS.length,
  itemListElement: CHECKS.map((check) => ({
    '@type': 'ListItem',
    position: check.n,
    name: check.name,
    description: check.asks,
    url: `${absoluteUrl(PATH)}#check-${check.n}`,
  })),
};

export default {
  path: PATH,
  title: 'Why bug bounty reports get rejected | Bounty Operator',
  description: DESCRIPTION,
  label: 'Method',
  styles: STYLES,
  og: { type: 'article', title: TITLE },
  jsonld: [breadcrumbsLd([{ name: 'Method', path: PATH }]), articleLd, checksLd],
  lastmod: LASTMOD,
  body,
};
