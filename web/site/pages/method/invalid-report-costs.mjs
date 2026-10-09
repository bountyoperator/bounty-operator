// /invalid-report-costs: what a report closed as invalid, N/A or spam costs
// on each platform, from that platform's own rules. One factual table. Every
// statement carries a numbered source with the date it was published or
// checked, as on /compare. No ranking and no advice dressed up as a rule.

import { button, html, inline, link, sectionHeading, stackTable } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { STYLES, ctaBand, pageHero, points, relatedLinks, workbenchLink } from './_shared.mjs';

const PATH = '/invalid-report-costs';
const CHECKED = 'checked 7 October 2026';
// Bugcrowd changed its limits on 8 October 2026; its three sources were read again on this date.
const CHECKED_BUGCROWD = 'checked 9 October 2026';

const SOURCES = [
  { n: 1, label: 'HackerOne Help Center, “Reputation”', href: 'https://docs.hackerone.com/en/articles/8369865-reputation', date: `dated 1 December 2025, ${CHECKED}` },
  { n: 2, label: 'HackerOne, “Code of Conduct”', href: 'https://www.hackerone.com/policies/code-of-conduct', date: CHECKED },
  {
    n: 3,
    label: 'Bugcrowd Docs, “Submission Limit”',
    href: 'https://docs.bugcrowd.com/researchers/reporting-managing-submissions/reporting-a-bug/submissions-limit/',
    date: `updated 8 October 2026, ${CHECKED_BUGCROWD}`,
  },
  {
    n: 4,
    label: 'Bugcrowd, “Bugcrowd policy changes to address AI slop submissions”',
    href: 'https://www.bugcrowd.com/blog/bugcrowd-policy-changes-to-address-ai-slop-submissions/',
    date: `dated 10 March 2026, ${CHECKED_BUGCROWD}`,
  },
  { n: 5, label: 'Intigriti Help Center, “Submission limits (open submissions)”', href: 'https://kb.intigriti.com/en/articles/14482892-submission-limits-open-submissions', date: `dated 8 June 2026, ${CHECKED}` },
  { n: 6, label: 'Intigriti Help Center, “Community Code of Conduct”', href: 'https://kb.intigriti.com/en/articles/5247238-community-code-of-conduct', date: `dated 9 March 2026, ${CHECKED}` },
  { n: 7, label: 'YesWeHack Help Center, “YesWeHack credits”', href: 'https://helpcenter.yeswehack.io/en/articles/711408-yeswehack-credits', date: CHECKED },
  { n: 8, label: 'Immunefi, “Rules”', href: 'https://immunefi.com/rules/', date: CHECKED },
  { n: 9, label: 'Cantina Documentation, “Deposits for Bounty Submissions”', href: 'https://docs.cantina.security/researchers/participation/deposits', date: CHECKED },
  { n: 10, label: 'Sherlock Docs, “Audit Engine: For Participants”', href: 'https://docs.sherlock.xyz/audit-engine/for-participants', date: CHECKED },
  {
    n: 11,
    label: 'Bugcrowd Docs, “Accuracy Calculation Update”',
    href: 'https://docs.bugcrowd.com/changelog/researchers/accuracy-update/',
    date: `dated 8 October 2026, ${CHECKED_BUGCROWD}`,
  },
];

const NBSP = ' ';

/** A source marker: [4] linking to the source list. */
function src(number) {
  return html`<a class="src" href="#source-${number}" aria-label="Source ${number}">[${number}]</a>`;
}

/** A table cell. Strings are text (with `code` spans); numbers are source markers placed where they fall. */
function cell(...parts) {
  return html`<span class="cmp">${parts.map((part) => (typeof part === 'number' ? html`${NBSP}${src(part)}` : inline(part)))}</span>`;
}

/** Several statements in one cell, one per line. */
function cells(...parts) {
  return html`<span class="cmp-stack">${parts}</span>`;
}

const ROWS = [
  [
    'HackerOne',
    cells(
      cell('Not Applicable: −5 reputation, and the same for a duplicate of an N/A report. When reputation drops, the platform limits how many reports you can submit over a set period.', 1),
      cell('A report is closed N/A when it is speculative, has no proof of concept, cannot be reproduced, rests on a video alone or shows no impact.', 2),
    ),
    cells(
      cell('Spam: −10 reputation.', 1),
      cell('Large-scale submission of low-quality or unverified reports, including misuse of AI tools: a final warning, then a 12-month ban, then a permanent ban. A repeated pattern of inflated severity is a Code of Conduct violation.', 2),
    ),
  ],
  [
    'Bugcrowd',
    cells(
      cell('Managed programmes: an account whose accuracy over the last 90 days is below 50% is limited to 6 submissions a week, for at least 7 days. Accounts with a proven record of quality are exempt.', 3),
      cell('The limit is assessed once you have made 10 submissions in 90 days. Until 5 of them have a final state, your lifetime accuracy is used.', 3),
      cell('A report closed N/A counts as a rejection in that accuracy. Informational and duplicate reports are left out of it.', 11),
      cell('Identity verification is required before you take part in a managed programme.', 3),
    ),
    cell('10 or more invalid reports in a row: account review, and a possible 30-day suspension where they were AI-generated or automated without validation. Submission farming: a permanent ban.', 4),
  ],
  [
    'Intigriti',
    cell('Open submissions are capped by the validity of your last 20: 1 below 20%, 3 from 20%, 5 from 40%, 7 from 60%, no cap from 80%. With 5 or fewer processed, the cap is 1.', 5),
    cell('Reports that look like unverified AI output, or hold fabricated content or placeholder text, can be closed without response, take longer to validate, or lead to removal from the platform. AI use must be disclosed.', 6),
  ],
  [
    'YesWeHack',
    cell('Each programme sets a credit price per submission. A report closed as invalid, out of scope or N/A costs the price plus twice the price: three times the price in all.', 7),
    cell('Spam costs the price plus three times the price: four times in all. An accepted report pays back twice the price, plus a bonus by severity.', 7),
  ],
  [
    'Immunefi',
    cell('Misrepresenting the asset, the severity or the impact is prohibited: a temporary suspension or a permanent ban, loss of access to your reports and zero payout.', 8),
    cell('Testing on mainnet or a public testnet: an immediate and permanent ban. Spam, placeholder submissions, and AI or scanner reports without the impact on the asset are prohibited.', 8),
  ],
  [
    'Cantina',
    cell('Where a bounty requires a deposit, a valid or a legitimate invalid submission gets it back.', 9),
    cell('Spam, low-effort or AI submissions, and an over-inflated severity: the deposit is slashed. Repeated abuse: slashed, with possible account action.', 9),
  ],
  [
    'Sherlock Audit Engine',
    cell('A dismissed issue counts 0 of 1 in your Issues Ratio, a submission cannot be withdrawn or edited, and each rewrite adds 0.5 to the count. No payout until the ratio is at least 20% and you have 2 valid findings.', 10),
    cell('No separate rule on the page cited.'),
  ],
];

const costTable = stackTable({
  label: 'What a closed report costs on each platform',
  columns: [{ label: 'Platform' }, { label: 'Closed as invalid or N/A' }, { label: 'Spam, AI misuse or abuse' }],
  rows: ROWS,
  className: 'compare-tools',
  wide: true,
});

const sourceList = html`
<ol class="sources">${SOURCES.map(
  (source) => html`<li class="sources__item" id="source-${source.n}"><span class="sources__n">[${source.n}]</span><span>${link({ label: source.label, href: source.href, external: true })}<span class="sources__date">${source.date}</span></span></li>`,
)}</ol>`;

const body = html`
${pageHero({
  trail: [{ label: 'Bounty Operator', href: '/' }, { label: 'Invalid report costs' }],
  title: 'What an invalid report costs on each platform',
  lede: 'A report closed as invalid, N/A or spam can cost you reputation, credits, submission slots, a deposit or the account. The table gives each platform’s rule, from its own pages, with the date we read it.',
  actions: html`${button({ label: 'Check a draft for free', href: '/tools/report-check', variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${button({ label: 'Review my report', href: workbenchLink('report'), size: 'lg' })}`,
})}

<section class="section section--tight wrap" aria-labelledby="costs">
  ${sectionHeading({ title: 'The rule on each platform', id: 'costs', lede: 'Programmes can add their own rules on top. Read the programme page before you submit.' })}
  ${costTable}
</section>

<section class="section wrap" aria-labelledby="before">
  ${sectionHeading({ title: 'What the rules ask of a report', id: 'before', lede: 'Each line comes from the rules above. The free report check looks for all of them in a draft.' })}
  ${points(
    [
      { title: 'A proof on a local fork', text: 'Run it on a fork, and paste the command and its output into the report. Immunefi bans testing on mainnet or a public testnet, and HackerOne closes a report with no proof of concept.' },
      { title: 'One severity, argued', text: 'HackerOne treats a repeated pattern of inflated severity as a violation, Immunefi prohibits misrepresenting it, and Cantina slashes the deposit for it.' },
      { title: 'AI use stated', text: 'Intigriti requires you to disclose when and how AI was used. HackerOne, Bugcrowd and Intigriti hold you responsible for what an AI tool wrote.' },
      { title: 'No placeholder left', text: 'Intigriti names placeholder text as fabricated content, and Immunefi prohibits placeholder submissions.' },
    ],
    { columns: 2 },
  )}
</section>

<section class="section wrap" aria-labelledby="sources">
  ${sectionHeading({ title: 'Sources', id: 'sources', lede: 'Each number in the table points here.' })}
  ${sourceList}
</section>

${ctaBand({
  title: 'Check the draft before the triager does',
  lede: 'The report check runs in your browser and sends nothing. The challenge runs on your own model and key. Free: 1 review a day.',
  actions: html`${button({ label: 'Check a draft for free', href: '/tools/report-check', variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${button({ label: 'See pricing', href: '/pricing', size: 'lg' })}`,
})}

<section class="section section--tight wrap">
  ${relatedLinks([
    { label: 'Report check', href: '/tools/report-check', text: 'Instant checks on a pasted draft, in the browser.' },
    { label: 'Report templates', href: '/templates', text: 'Immunefi, Cantina, Sherlock and HackerOne, section by section.' },
    { label: 'Compare', href: '/compare', text: 'Bounty Operator next to platform pre-checks and other tools.' },
  ])}
</section>`;

export default {
  path: PATH,
  title: 'What an invalid bug report costs | Bounty Operator',
  description: 'What an invalid, N/A or spam bug bounty report costs on HackerOne, Bugcrowd, Intigriti, YesWeHack, Immunefi, Cantina and Sherlock, from their rules.',
  label: 'Invalid report costs',
  styles: STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Invalid report costs', path: PATH }])],
  lastmod: '2026-10-09',
  body,
};
