// Shared data and helpers for the method and landing pages.
//
// This module has no default export, so the generator treats it as a helper.
// Method facts (the twelve checks, the gauntlet stages, the verdict words)
// are written at one depth: what each check asks, why reports die on it and
// the verdict it leads to; for a stage, its name, its question and the names
// of what it outputs. How a check or a stage is executed is the hosted
// product. It is not described on any page and does not belong in this file.

import {
  attrs,
  breadcrumbs,
  button,
  chip,
  closingBand,
  cx,
  html,
  icon,
  inline,
  link,
  statusChip,
  verdictChip,
} from '../../components.mjs';

export const LASTMOD = '2026-10-03';
export const STYLES = ['/css/landing.css'];

/** Opens the workbench with a review profile selected. */
export function workbenchLink(profileId) {
  return profileId ? `/?profile=${profileId}#workspace` : '/#workspace';
}

/**
 * Tradi3's results on Immunefi's public leaderboards, read on 8 October 2026
 * (ENS and Firelight again on 9 October 2026): Firelight 2nd of 133 (the last
 * rank on the board; two more rows are disqualified entries and are not
 * counted); Quantus 8th of 65; ENS 15th of 186. ENS credits 23 valid
 * submissions: 1 Chief and 22 duplicates
 * (17 Critical, 1 High, 4 Medium, 1 Low), plus 1 separate Insight. 17 valid
 * Critical submissions is the most on that board; the next count is 14.
 *
 * One wording everywhere. A short proof line says "17 valid Critical
 * submissions in Immunefi's ENS competition, the most of 186 researchers", or
 * the same fact in the line's own shape. The full breakdown is in README.md
 * and PRODUCT.md. Re-read a leaderboard before changing a number.
 */
export const LEADERBOARDS = {
  firelight: 'https://immunefi.com/audit-competition/audit-comp-firelight-1/leaderboard/',
  quantus: 'https://immunefi.com/audit-competition/audit-comp-quantus/leaderboard/',
  ens: 'https://immunefi.com/audit-competition/audit-competition-ens/leaderboard/',
};

/**
 * The FAQ entry for a Claude Max or Team subscriber, on /pricing and
 * /your-model-your-key. Every figure is from Anthropic's help article
 * "Monthly API credits for Max and Team plans", dated 7 October 2026 and read
 * on 9 October 2026: the credits cover the Claude API, are spent before
 * purchased credits, can be claimed after seven days on the plan, and are not
 * offered on Free, Pro or Enterprise. Read the article again before changing
 * a number.
 */
export const CLAUDE_CREDITS_FAQ = {
  id: 'claude-plan-credits',
  q: 'I am on Claude Max or Team. Do I have to buy API credit as well?',
  a: html`<p>Since October 2026 those plans include monthly credits for the Claude API: US$100 on Max 5x, US$200 on Max 20x, and up to US$500 pooled on Team. Link a Claude Console organization in the billing settings on claude.ai, create an API key in it, and reviews on that key draw on those credits first. New subscribers can claim them after seven days on the plan. Free, Pro and Enterprise plans are not eligible. The terms are in ${link({ label: 'Anthropic’s article on the credits', href: 'https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans', external: true })}.</p><p>If Claude blocks a review, see <a class="link" href="/guide#model-refuses">When the model refuses</a>.</p>`,
};

/** The record claim, at the depth PUBLIC-METHOD.md allows: the count, the platforms, wins and closures. One wording on every page. */
export const RECORD_CLAIM = 'Twelve checks from 105 real case files across five platforms, the paid ones and the closed ones.';

// ---------------------------------------------------------------------------
// The verdict vocabulary
// ---------------------------------------------------------------------------

export const VERDICTS = [
  { id: 'submit', meaning: 'Every decisive claim is backed by the supplied code and proof. File it.' },
  { id: 'rewrite-then-submit', meaning: 'The finding holds. The draft misstates its severity, impact, preconditions or fix.' },
  { id: 'prove-first', meaning: 'The claimed impact is not demonstrated on the real path yet. One artefact is missing.' },
  { id: 'hold-duplicate', meaning: 'A known issue, an audit note, a branch or your own earlier report has the same root cause or the same fix.' },
  { id: 'drop', meaning: 'The code contradicts the root cause, the behaviour is the design, or the rules exclude it.' },
];

// ---------------------------------------------------------------------------
// The twelve checks
// ---------------------------------------------------------------------------

/**
 * asks:  the one question the check asks.
 * why:   why reports die on it. Two sentences, true of any programme.
 * leads: verdict ids, or { label } where the check does not map to a verdict word.
 */
export const CHECKS = [
  {
    n: 1,
    name: 'Actor trace',
    asks: 'Who performs every step, and who supplies every decisive value?',
    why: 'A programme pays for what an unprivileged attacker does. When the deciding step belongs to an owner, an operator or the victim’s own approval, the report is closed as a trusted-role or user-error case, however real the flaw in the code.',
    leads: ['drop'],
  },
  {
    n: 2,
    name: 'Own-verdict reversal',
    asks: 'Which new evidence defeats each reason you recorded when you held this finding or lowered its severity?',
    why: 'A finding reads stronger on the second look because nothing argues back. A report revived with no new evidence is closed for the reason already written in your own notes.',
    leads: [{ label: 'Earlier verdict stands' }],
  },
  {
    n: 3,
    name: 'Design intent and counterfactual',
    asks: 'Did the project mean this behaviour, and does the bug step add anything over the intended path?',
    why: 'Behaviour the project documented, tested or introduced as an audit fix is closed as intended. A proof that reaches the same end state without the bug step shows no loss the design did not already allow.',
    leads: ['drop'],
  },
  {
    n: 4,
    name: 'Literal impact and exclusion fit',
    asks: 'Does an exclusion name this class, and does every clause of the impact row have an artefact behind it?',
    why: 'A triager reads the exclusions first and the impact row word by word. One matching exclusion ends the report, and one clause with nothing behind it moves the report to a lower row.',
    leads: ['drop', 'rewrite-then-submit'],
  },
  {
    n: 5,
    name: 'Asset and version binding',
    asks: 'Does the cited code exist in the scoped asset, at the revision that is deployed?',
    why: 'A bug in a branch, a mirror or an old tag is a bug in something the programme does not pay for. A proof built on another revision proves that revision and leaves the deployed one untested.',
    leads: ['drop', 'prove-first'],
  },
  {
    n: 6,
    name: 'Prior-art sweep',
    asks: 'Does a known issue, an audit note, a branch or a pull request cover the same function and consequence, or carry the same fix?',
    why: 'Duplicates are judged on root cause and on the fix. Titles, wording and the strength of the proof carry no weight, so a report on a root cause someone already wrote down is closed.',
    leads: ['hold-duplicate'],
  },
  {
    n: 7,
    name: 'Own-report family',
    asks: 'Stated with no file and no entry point, is the broken invariant one you have already reported on this programme?',
    why: 'Two reports on one invariant are grouped as one finding, and the later one is closed against the earlier. New evidence belongs in the report that already exists.',
    leads: ['hold-duplicate'],
  },
  {
    n: 8,
    name: 'Executed end-state proof',
    asks: 'Does the final assertion read the object the impact row names, on production code, with the command and its output in the report?',
    why: 'A proof that shows the defect and describes the loss leaves the impact unproven. Triagers pay for an end state they can see asserted, and a proof they cannot run or read inline counts as no proof.',
    leads: ['prove-first'],
  },
  {
    n: 9,
    name: 'Production reachability',
    asks: 'Does every state the proof sets up have a route from live state by public calls?',
    why: 'A test can write any state it likes. A state that no public call reaches is an artefact of the test, and the report is closed as not exploitable.',
    leads: ['prove-first'],
  },
  {
    n: 10,
    name: 'Severity against the written scale',
    asks: 'Which row of the programme’s own scale does the proof assert, after every recovery action is applied?',
    why: 'Severity is graded on the programme’s written scale, read literally. A tier claimed above the measured loss, or a loss the project can undo, is downgraded.',
    leads: ['rewrite-then-submit'],
  },
  {
    n: 11,
    name: 'Submission integrity',
    asks: 'Does what the platform stored match the draft: the proof field, the severity, the impact row?',
    why: 'The triager judges the stored submission and never sees the draft on your disk. An empty proof field, or a form that disagrees with the body, closes a finding that is real.',
    leads: ['rewrite-then-submit'],
  },
  {
    n: 12,
    name: 'Private-duplicate clock',
    asks: 'Small fix, old code, central path, checklist class: how long before someone else files it?',
    why: 'Other hunters file in private, so a clean public search says nothing about who is ahead of you. A bug that is easy to find on old, central code is found more than once, and the later reports are closed as duplicates.',
    leads: [{ label: 'Sets a filing deadline' }],
  },
];

/** The one line that sits under the checks wherever they are listed. */
export const CHECKS_RUN_LINE = 'The executable version of each check runs inside the gauntlet.';

/** That line, with "the gauntlet" linked to its page. */
export function checksRunLine({ className = 'link' } = {}) {
  const [before, after] = CHECKS_RUN_LINE.split('the gauntlet');
  return html`${before}<a${attrs({ class: className })} href="/gauntlet">the gauntlet</a>${after}`;
}

// ---------------------------------------------------------------------------
// The gauntlet: eight stages, in this order
// ---------------------------------------------------------------------------

export const STAGES = [
  {
    n: 1,
    id: 'scope',
    name: 'Scope',
    decides:
      'Whether the code is in the scoped asset at the deployed revision, whether the class is excluded, and whether every clause of the chosen impact row has an artefact behind it.',
    outputs: ['Binding table', 'Exclusion matches', 'Impact row, clause by clause'],
    checks: [4, 5],
  },
  {
    n: 2,
    id: 'provenance',
    name: 'Provenance',
    decides:
      'Who performs each step, whether the behaviour is documented design or an audit fix, whether the bug adds anything over the intended path, and whether every precondition is reachable from live state.',
    outputs: ['Actor table', 'Intent evidence', 'Counterfactual', 'Preconditions'],
    checks: [1, 3, 9],
  },
  {
    n: 3,
    id: 'prior-art',
    name: 'Prior art',
    decides:
      'Whether a known issue, a prior audit note, a team branch or your own earlier report has the same root cause or the same one-line fix.',
    outputs: ['Root-cause fingerprint', 'Matches', 'The duplicate clock'],
    checks: [6, 7, 12],
  },
  {
    n: 4,
    id: 'poc',
    name: 'Proof',
    decides:
      'Whether the proof runs production code on every step and ends by reading the object the impact row names, with measured numbers.',
    outputs: ['Step table: executed, mocked or narrated', 'End-state assertion', 'Measured loss'],
    checks: [8],
  },
  {
    n: 5,
    id: 'severity',
    name: 'Severity',
    decides: 'The highest row of the programme’s own scale that the proof fully asserts, after every downgrade clause.',
    outputs: ['The tier to claim', 'The one fact that moves it'],
    checks: [10],
  },
  {
    n: 6,
    id: 'triage',
    name: 'Triager',
    decides: 'The one sentence that closes this report in ten minutes, and whether the first paragraph already answers it.',
    outputs: ['Ranked rejection reasons', 'The draft sentence that triggers each'],
    checks: [],
  },
  {
    n: 7,
    id: 'report',
    name: 'Report',
    decides: 'Whether the claims follow from the code, the proof is inline, the form and the body agree, and the limits are stated.',
    outputs: ['Claims table', 'The rewritten report'],
    checks: [11],
  },
  {
    n: 8,
    id: 'verdict',
    name: 'Verdict',
    decides: 'Which verdict the report gets.',
    outputs: ['One of five verdicts', 'The blocker', 'The cheapest action that removes it', 'A filing deadline'],
    checks: [],
  },
];

/** The head of the invented gauntlet run shown on /gauntlet and quoted on /method. */
export const GAUNTLET_EXAMPLE = {
  verdict: 'prove-first',
  headline:
    'The seizure bug is in the code. The proof reads the return value of `liquidate` on a mock oracle; the impact row names the borrower’s collateral.',
  counts: { critical: 0, high: 1, medium: 0, hardening: 1, 'checked-safe': 3 },
};

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/**
 * The page head, printed on the field: breadcrumbs, the H1 with an optional
 * stamp (an Operator feature) or meta line under it, the lede, actions and
 * an optional aside. With an aside the hero is two columns from 64em.
 */
export function pageHero({ trail, stamp, meta, title, lede, actions, note, aside, after, stickyText = false } = {}) {
  return html`
<section class="${cx('page-head', 'page-field', 'lp-hero', 'wrap', aside && 'lp-hero--split')}">
  ${breadcrumbs(trail)}
  <div class="lp-hero__grid">
    <div class="${cx('page-head__text', 'lp-hero__text', stickyText && 'lp-hero__text--sticky')}">
      <h1>${title}</h1>
      ${(stamp || meta) && html`<p class="lp-hero__meta">${stamp}${meta && html`<span class="meta">${meta}</span>`}</p>`}
      <p class="lede">${lede}</p>
      ${actions && html`<div class="cluster page-head__actions">${actions}</div>`}
      ${note && html`<p class="fine">${note}</p>`}
${after && html`      ${after}`}
    </div>
    ${aside && html`<div class="lp-hero__aside">${aside}</div>`}
  </div>
</section>`;
}

/** Tradi3's linked results. The only proof the site shows. */
export function proofLine() {
  return html`<p class="proofline">${icon('shield')}<span>Built by Tradi3: ${link({
    label: '2nd of 133 in Immunefi’s Firelight competition',
    href: LEADERBOARDS.firelight,
    external: true,
  })}, ${link({ label: '8th of 65 in Quantus', href: LEADERBOARDS.quantus, external: true })} and ${link({
    label: '15th of 186 in ENS, with 17 valid Critical submissions, the most on the board',
    href: LEADERBOARDS.ens,
    external: true,
  })}.</span></p>`;
}

/** A frame around invented example output, so nobody reads it as a real finding. */
export function exampleFrame({ label = 'Invented protocol', body, className } = {}) {
  return html`
<div class="${cx('example', className)}">
  <p class="example__bar">${statusChip('example')}<span class="meta">${label}</span></p>
  <div class="example__body">${body}</div>
</div>`;
}

/** A list with a tick in front of every item. Items are strings or html. */
export function tickList(items, { className } = {}) {
  return html`<ul class="${cx('ticks', className)}">${items.map((item) => html`<li>${icon('check')}<span>${typeof item === 'string' ? inline(item) : item}</span></li>`)}</ul>`;
}

/** Numbered points in a grid: [{ title, text }]. */
export function points(items, { columns = 3, className } = {}) {
  return html`<ol class="${cx('points', `points--${columns}`, className)}">${items.map(
    (item) => html`<li class="points__item"><h3 class="points__title">${inline(item.title)}</h3><p class="points__text">${inline(item.text)}</p></li>`,
  )}</ol>`;
}

/** The five verdicts with what each one means. */
export function verdictList({ className } = {}) {
  return html`<dl class="${cx('verdicts', className)}">${VERDICTS.map(
    (verdict) => html`<div class="verdicts__row"><dt>${verdictChip(verdict.id)}</dt><dd>${verdict.meaning}</dd></div>`,
  )}</dl>`;
}

/**
 * The gauntlet as a pipeline: the stepper track, with links instead of buttons
 * so every stage is reachable without script.
 * states: { scope: 'done', verdict: 'current', … }; default is 'todo'.
 */
export function pipeline({ label = 'Gauntlet stages', states = {}, hrefFor = (stage) => `#stage-${stage.id}` } = {}) {
  const items = STAGES.map((stage) => {
    const state = states[stage.id] ?? 'todo';
    const linkAttrs = attrs({
      class: 'stepper__step',
      href: hrefFor(stage),
      'data-state': state,
      'aria-current': state === 'current' ? 'step' : null,
    });
    const marker = state === 'done' ? icon('check') : html`<span aria-hidden="true">${stage.n}</span>`;
    return html`<li><a${linkAttrs}><span class="stepper__marker">${marker}</span><span class="stepper__label">${stage.name}</span>${state === 'done' && html`<span class="visually-hidden">, done</span>`}</a></li>`;
  });
  return html`<nav class="stepper pipeline" aria-label="${label}"><ol>${items}</ol></nav>`;
}

/** "Checks 4, 5" with links to the check anchors on /method. */
export function checkLinks(numbers, { base = '/method' } = {}) {
  if (!numbers.length) return '';
  const links = numbers.map((number, index) => html`${index > 0 ? ', ' : ''}<a href="${base}#check-${number}">${number}</a>`);
  return html`<span class="meta stage__checks">${numbers.length > 1 ? 'Checks' : 'Check'} ${links}</span>`;
}

/**
 * The eight stages as a vertical run. `detail(stage)` adds content under a
 * stage (the example pages show what each stage decided).
 */
export function stageList({ detail, checkBase = '/method', className } = {}) {
  const items = STAGES.map(
    (stage) => html`
<li class="stage" id="stage-${stage.id}">
  <div class="stage__marker" aria-hidden="true"><span>${stage.n}</span></div>
  <div class="stage__body">
    <div class="stage__head">
      <h3 class="stage__name">${stage.name}</h3>
      <code class="stage__id">${stage.id}</code>
      ${checkLinks(stage.checks, { base: checkBase })}
    </div>
    <p class="stage__decides">${stage.decides}</p>
    <div class="stage__out">
      <span class="meta">Outputs</span>
      <ul class="stage__outputs">${stage.outputs.map((output) => html`<li>${output}</li>`)}</ul>
    </div>
    ${detail?.(stage)}
  </div>
</li>`,
  );
  return html`<ol class="${cx('stages', className)}">${items}</ol>`;
}

/**
 * The closing call to action of a page: the shared band, in a section of its own.
 * actions: [{ label, href }], the first one solid.
 */
export function ctaBand({ title, lede, actions, note } = {}) {
  return html`
<div class="section wrap">
  ${closingBand({ title, text: lede, actions, note })}
</div>`;
}

/** The two standard buttons of a paid feature page. */
export function operatorActions({ secondary } = {}) {
  return html`${button({ label: 'Get Operator', href: '/pricing', variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${secondary}`;
}

/** A plain labelled chip used where no verdict word applies. */
export function forcedChip(label) {
  return chip(label, { tone: 'neutral', dashed: true });
}

/** Internal links at the foot of a page: [{ label, href, text }]. */
export function relatedLinks(items, { title = 'Related' } = {}) {
  return html`
<nav class="related" aria-label="${title}">
  <p class="meta">${title}</p>
  <ul class="related__list">${items.map(
    (item) => html`<li><a class="related__link" href="${item.href}"><span class="related__label">${item.label}${icon('arrow-right')}</span><span class="related__text">${item.text}</span></a></li>`,
  )}</ul>
</nav>`;
}
