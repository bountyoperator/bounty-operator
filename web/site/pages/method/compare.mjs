// /compare: Bounty Operator next to three other ways of checking a finding
// before it is filed, and four tools that cover part of the same ground. Two
// factual tables. Every fact about another product carries a numbered source
// with the date it was published or checked. No scores, no benchmarks. Audit
// skills are referred to as a kind; the four tools are rows named by what
// they do, and their repositories appear in the source list only.

import { button, html, inline, link, sectionHeading, stackTable, table } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { LASTMOD, STYLES, ctaBand, pageHero, points, relatedLinks, workbenchLink } from './_shared.mjs';

const PATH = '/compare';
const CHECKED = 'checked 2 October 2026';
// The four tool rows were read on this date.
const CHECKED_TOOLS = 'checked 3 October 2026';

const SOURCES = [
  { n: 1, label: 'Immunefi, “Immunefi Studio”', href: 'https://immunefi.com/studio/', date: CHECKED },
  { n: 2, label: 'Immunefi on X: Studio Review checks and beta status', href: 'https://x.com/immunefi/status/2098092155067826574', date: `posted 10 September 2026, ${CHECKED}` },
  { n: 3, label: 'Immunefi on X: the agent behind Studio Review', href: 'https://x.com/immunefi/status/2098494040618770874', date: `posted 11 September 2026, ${CHECKED}` },
  { n: 4, label: 'HackerOne Help Center, “Report Assistant”', href: 'https://docs.hackerone.com/en/articles/12648472-report-assistant', date: `dated 13 April 2026, ${CHECKED}` },
  { n: 5, label: 'Agent Skills, “What are Agent Skills?”', href: 'https://agentskills.io/', date: CHECKED },
  { n: 6, label: 'OpenAI Help Center, “Data controls in ChatGPT”', href: 'https://help.openai.com/en/articles/7730893-data-controls-faq', date: CHECKED },
  {
    n: 7,
    label: 'Anthropic Privacy Center, “Is my data used for model training?”',
    href: 'https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training',
    date: `dated 16 March 2026, ${CHECKED}`,
  },
  { n: 8, label: 'GitHub, “awarexone/Agentic-Bug-Hunter”, README', href: 'https://github.com/awarexone/Agentic-Bug-Hunter', date: CHECKED_TOOLS },
  { n: 9, label: 'GitHub, “Gabson0x/bountyforge”, README', href: 'https://github.com/Gabson0x/bountyforge', date: CHECKED_TOOLS },
  { n: 10, label: 'BountyForge, hosted version', href: 'https://bountyforge.xyz/', date: `price ${CHECKED_TOOLS}` },
  { n: 11, label: 'GitHub, “J4X-Security/K.I.T”, README', href: 'https://github.com/J4X-Security/K.I.T', date: CHECKED_TOOLS },
  { n: 12, label: 'GitHub, “heavyw8t/The-Judge”, README', href: 'https://github.com/heavyw8t/The-Judge', date: CHECKED_TOOLS },
];

const NBSP = ' ';

/** A source marker: [4] linking to the source list. */
function src(number) {
  return html`<a class="src" href="#source-${number}" aria-label="Source ${number}">[${number}]</a>`;
}

/**
 * A table cell. Strings are text (with `code` spans); numbers are source
 * markers placed where they fall: cell('Immunefi returns notes.', 1).
 */
function cell(...parts) {
  return html`<span class="cmp">${parts.map((part) => (typeof part === 'number' ? html`${NBSP}${src(part)}` : inline(part)))}</span>`;
}

/** Several statements in one cell, one per line. */
function cells(...parts) {
  return html`<span class="cmp-stack">${parts}</span>`;
}

const ROWS = [
  [
    'Built for',
    cell('Arguing against one finding or one draft report before it is filed.'),
    cell('Whatever you ask. The conversation is the workflow.'),
    cell('Running a packaged procedure inside a coding agent. A skill is a folder with a `SKILL.md` of instructions the agent loads when a task matches.', 5),
    cells(cell('Feedback on a draft inside one platform.'), cell('Immunefi: Studio Review.', 1), cell('HackerOne: Report Assistant.', 4)),
  ],
  [
    'Inputs pinned and hashed',
    cell('Every file is labelled, line-numbered and listed in a SHA-256 manifest. Line references in the review are checked against it.'),
    cell('What you paste into the conversation.'),
    cell('The files in your working tree, as the agent reads them. The skill format defines instructions and optional scripts.', 5),
    cell('The report form. HackerOne states that only the text you enter is used to generate suggestions.', 4),
  ],
  [
    'Method',
    html`<span class="cmp">Twelve checks and eleven review profiles with a fixed output format. The checks are on <a class="link" href="/method">the method page</a>. The three core profiles are open source. The others run on the hosted service.</span>`,
    cell('The prompt you write that day.'),
    cell('The instructions the skill’s author wrote.', 5),
    cells(
      cell('Immunefi: PoC clarity, impact framing, completeness and duplicate risk', 2, ', run by the triaging agent its triage team uses.', 3),
      cell('HackerOne: steps to reproduce, expected and actual behaviour, impact, asset scope, severity, supporting material and custom fields.', 4),
    ),
  ],
  [
    'Counterargument',
    cell('Every finding carries the strongest objection, marked resolved or open, with the line that settles it.'),
    cell('When you ask for one.'),
    cell('When the skill’s instructions ask for one.'),
    cells(cell('Immunefi returns improvement notes.', 1), cell('HackerOne returns check results and suggestions you choose to apply.', 4)),
  ],
  [
    'Verdict',
    cell('One of five: `submit`, `rewrite-then-submit`, `prove-first`, `hold-duplicate`, `drop`.'),
    cell('Free text.'),
    cell('The report format the skill defines.'),
    cells(cell('Immunefi’s sample review shows a verdict line with ratings for PoC clarity, impact and duplicate risk.', 1), cell('HackerOne shows a result per check.', 4)),
  ],
  [
    'Duplicate signal',
    cell('Overlap with the known issues and audits you supply, classed by root cause.'),
    cell('Overlap with what you paste.'),
    cell('Overlap with what the agent reads.'),
    cell('Immunefi: a duplicate-risk assessment', 1, ', from an agent backed by the reports submitted to Immunefi.', 3),
  ],
  [
    'Platforms',
    cell('Any. You paste the programme’s rules: Immunefi, Cantina, Sherlock, HackerOne.'),
    cell('Any.'),
    cell('Any.'),
    cells(cell('Its own.'), cell('Studio Review: Immunefi.', 1), cell('Report Assistant: the HackerOne report form.', 4)),
  ],
  [
    'Access and cost shape',
    cell('Open to anyone. Free: 1 review a day. Operator: US$10 per week, unlimited. Your provider bills model usage to your key.'),
    cell('Your chat subscription.'),
    cells(cell('A folder you install.', 5), cell('Model usage is billed by the plan your coding agent runs on.')),
    cells(cell('Studio Review is in invite-only beta.', 2), cell('Report Assistant is optional in the report form.', 4), cell('Neither page cited states a price.')),
  ],
  [
    'Where your draft goes',
    cell('Through our server to the model provider you choose, on your key. Bounty Operator stores no files, prompts, keys or results. A core profile exported as a prompt goes from your browser to the chat app you paste it into.'),
    cells(
      cell('To the chat provider, into your chat history.'),
      cell('Consumer plans use conversations for model training according to your settings: OpenAI’s “Improve the model for everyone” control', 6, ' and Anthropic’s model-improvement setting.', 7),
    ),
    cell('To the model behind your coding agent, under that provider’s terms.'),
    cells(cell('To the platform that triages the report.'), cell('HackerOne states that report data is not shared with the programme before you submit.', 4)),
  ],
];

const compareTable = table({
  label: 'What each option gives you',
  columns: [
    { label: 'What you get' },
    { label: 'Bounty Operator' },
    { label: 'Pasting into a chat app' },
    { label: 'Open-source audit skills' },
    { label: 'Platform pre-checks' },
  ],
  rows: ROWS,
  className: 'compare',
});

// Four tools that cover part of the same ground. Each row is named by what
// the tool does. "Same ground as" names the gauntlet stages that ask the same
// kind of question; it is a map, not a score.
const TOOL_ROWS = [
  [
    'A free hunting kit with a go/no-go gate',
    cell(
      'Runs recon, hunts for bugs and writes the report for HackerOne, Bugcrowd, Intigriti or Immunefi. A seven-question gate checks the finding before the report is written, and a two-minute check gives a go or a no-go.',
      8,
    ),
    cell('A command-line tool and a plugin for a coding agent.', 8),
    cell('Free. MIT licence.', 8),
    'Scope, provenance, proof',
  ],
  [
    'A hosted bounty tool with a lifetime price',
    cell(
      'Eight agents hunt in parallel across web, API and smart-contract targets. Findings are deduplicated, put through four gates (refutation, reachability, trigger, impact), scored with CVSS and written up for the same four platforms.',
      9,
    ),
    cell('A skill for a coding agent, and a hosted version that runs each session in its own sandbox on your AI key.', 9),
    cells(cell('The skill is free.', 9), cell('The hosted version listed a one-time lifetime price of US$199.', 10)),
    'Provenance, proof',
  ],
  [
    'A known-issue register',
    cell(
      'Builds one `known-issues.json` from audit reports: local files and folders, PDFs, URLs and GitHub repositories. A new issue, or a whole report, is then compared with the register for duplicates.',
      11,
    ),
    cell('A command in a coding agent, or a Python command-line tool.', 11),
    cell('Free. MIT licence.', 11),
    'Prior art',
  ],
  [
    'A false-positive filter',
    cell(
      'Takes a finding, or a CSV of findings, and the codebase. It verifies the location, tests whether the attack reduces to a trusted role acting maliciously, argues generic and issue-specific counter-arguments against the code, and returns VALID, INVALID or DOWNGRADED with code-line evidence.',
      12,
    ),
    cell('A skill and a slash command in a coding agent.', 12),
    cell('Free.', 12),
    'Provenance, triager',
  ],
];

const toolTable = stackTable({
  label: 'Tools that cover part of the same ground',
  columns: [{ label: 'Tool' }, { label: 'What it does' }, { label: 'How it runs' }, { label: 'Cost' }, { label: 'Same ground as' }],
  rows: TOOL_ROWS,
  className: 'compare-tools',
  wide: true,
});

const sourceList = html`
<ol class="sources">${SOURCES.map(
  (source) => html`<li class="sources__item" id="source-${source.n}"><span class="sources__n">[${source.n}]</span><span>${link({ label: source.label, href: source.href, external: true })}<span class="sources__date">${source.date}</span></span></li>`,
)}</ol>`;

const body = html`
${pageHero({
  trail: [{ label: 'Bounty Operator', href: '/' }, { label: 'Compare' }],
  eyebrow: 'Compare',
  title: 'Bounty Operator vs a chat app, a local audit skill and platform pre-checks',
  lede: 'Four ways to check a finding before you file it, and four tools that cover part of the same ground. The tables say what each one gives you: pinned inputs and hashes, method, counterargument, verdict, cost shape and privacy. Facts about other products are numbered, linked and dated.',
  actions: html`${button({ label: 'Start a free review', href: workbenchLink(), variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${button({ label: 'Read the method', href: '/method', size: 'lg' })}`,
})}

<section class="section section--tight wrap" aria-labelledby="table">
  ${sectionHeading({ title: 'What each one gives you', id: 'table' })}
  <p class="fine compare__hint">Scroll the table sideways for the other three columns.</p>
  ${compareTable}
  <p class="fine compare__note">“Open-source audit skills” means the free skill packs that run a security review from inside a coding agent. “Platform pre-checks” means the draft-review tools the bounty platforms publish for their own report forms.</p>
</section>

<section class="section wrap" aria-labelledby="tools">
  ${sectionHeading({
    title: 'Four tools on the same ground',
    id: 'tools',
    lede: 'Each of these checks a finding before it is filed, as one step of a larger job: hunting, filtering or deduplicating. The last column names the gauntlet stages that ask the same kind of question.',
  })}
  ${toolTable}
  <p class="fine compare__note">Three of the four find the bug or filter a batch of findings. Bounty Operator starts from one finding you already hold and argues against the report: scope, design intent, duplicates, proof, severity and what the platform stored.</p>
</section>

<section class="section wrap" aria-labelledby="sources">
  ${sectionHeading({
    title: 'Sources',
    id: 'sources',
    lede: 'Each number in the table points here. Statements about Bounty Operator describe the product on this site.',
  })}
  ${sourceList}
</section>

<section class="section wrap" aria-labelledby="together">
  ${sectionHeading({
    title: 'Where each one fits',
    id: 'together',
    lede: 'They answer different questions, and they combine.',
  })}
  ${points(
    [
      { title: 'A chat app', text: 'One question about one function, answered in a minute. The record is the conversation.' },
      { title: 'An open-source audit skill', text: 'A sweep of a repository from your coding agent. It produces candidates for you to verify.' },
      { title: 'A platform pre-check', text: 'A read of your draft on the platform that will triage it, where you have access to it.' },
      { title: 'A hunting kit or a finding filter', text: 'Recon, hunting and a first gate on what an agent found. What it keeps is a candidate.' },
      {
        title: 'Bounty Operator',
        text: 'One candidate, argued against in a fixed order: scope, intent, prior art, proof, severity. Pinned inputs, one verdict, any platform. It also runs from a coding agent over MCP.',
      },
    ],
    { columns: 3 },
  )}
</section>

${ctaBand({
  title: 'Put your next finding through it',
  lede: 'Free: 1 review a day, on your own model and key.',
  actions: html`${button({ label: 'Start a free review', href: workbenchLink(), variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${button({ label: 'See pricing', href: '/pricing', size: 'lg' })}`,
})}

<section class="section section--tight wrap">
  ${relatedLinks([
    { label: 'The twelve checks', href: '/method', text: 'The question each check asks, and why reports die on it.' },
    { label: 'Your model, your key', href: '/your-model-your-key', text: 'Where your code goes and what is stored.' },
    { label: 'Gauntlet', href: '/gauntlet', text: 'One run, eight stages, one verdict.' },
  ])}
</section>`;

export default {
  path: PATH,
  title: 'Bounty Operator vs chat apps, audit skills and pre-checks',
  description:
    'Sourced tables: what Bounty Operator, a chat app, audit skills, platform pre-checks and four overlapping tools each give you before you file a finding.',
  label: 'Compare',
  styles: STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Compare', path: PATH }])],
  lastmod: LASTMOD,
  body,
};
