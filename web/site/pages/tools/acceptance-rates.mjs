// /tools/acceptance-rates: accepted and judged counts per bug class.
//
// The data is embedded here, copied from
// bounty_operator_kit/data/vulnerability_acceptance_rates.json.
// web/tests/tools-pages.test.mjs fails when the two differ.
//
// Tags overlap: a finding can carry more than one. Nothing on this page sums
// the rows, charts them as shares of a whole, or shows the "duplicated" count.

import { attrs, button, chip, html, icon, link } from '../../components.mjs';
import { absoluteUrl } from '../../layout.mjs';
import { COUNTER_LINE, LASTMOD, TOOL_STYLES, nextAction, relatedTools, toolCrumbsLd, toolHead } from './_shared.mjs';

const PATH = '/tools/acceptance-rates';

export const DATASET = {
  source: 'Sherlock audit-competition judging repos (public GitHub)',
  license: 'CC0 - public domain, use freely with or without attribution',
  upstream: 'https://github.com/holistis/bug-bounty-intelligence-mcp/blob/main/vulnerability-acceptance-rates.json',
  methodology_url: 'https://github.com/holistis/bug-bounty-intelligence-mcp/blob/main/METHODOLOGY.md',
  last_updated: '2026-07-21T19:51:20.564Z',
  contests_included: 10,
  total_findings: 1032,
  total_accepted: 461,
  note: "Only contests where accepted plus invalid counts reconcile exactly against Sherlock's published results are included.",
  patterns: {
    'fee-miscalculation': { acceptance_rate: 0.5, accepted: 55, rejected: 51, total: 109 },
    'dos-griefing': { acceptance_rate: 0.41, accepted: 64, rejected: 90, total: 156 },
    reentrancy: { acceptance_rate: 0.78, accepted: 40, rejected: 11, total: 51 },
    'trusted-actor': { acceptance_rate: 0.51, accepted: 159, rejected: 148, total: 311 },
    overflow: { acceptance_rate: 0.58, accepted: 26, rejected: 19, total: 45 },
    staleness: { acceptance_rate: 0.49, accepted: 86, rejected: 84, total: 174 },
    rounding: { acceptance_rate: 0.4, accepted: 25, rejected: 38, total: 63 },
    'access-control': { acceptance_rate: 0.47, accepted: 35, rejected: 39, total: 74 },
    'oracle-manipulation': { acceptance_rate: 0.36, accepted: 47, rejected: 78, total: 131 },
    'mev-slippage': { acceptance_rate: 0.49, accepted: 44, rejected: 44, total: 89 },
    liquidation: { acceptance_rate: 0.29, accepted: 4, rejected: 9, total: 14 },
    'flash-loan': { acceptance_rate: 0.46, accepted: 6, rejected: 6, total: 13 },
  },
};

/** A sample under this size is marked on its row. */
export const SMALL_SAMPLE = 20;

const LABELS = {
  'fee-miscalculation': 'Fee miscalculation',
  'dos-griefing': 'DoS and griefing',
  reentrancy: 'Reentrancy',
  'trusted-actor': 'Trusted actor',
  overflow: 'Overflow',
  staleness: 'Staleness',
  rounding: 'Rounding',
  'access-control': 'Access control',
  'oracle-manipulation': 'Oracle manipulation',
  'mev-slippage': 'MEV and slippage',
  liquidation: 'Liquidation',
  'flash-loan': 'Flash loan',
};

const number = (value) => value.toLocaleString('en-US');
const percent = (rate) => `${Math.round(rate * 100)}%`;

/** The rows, highest acceptance rate first; ties go to the larger sample. */
export const ROWS = Object.entries(DATASET.patterns)
  .map(([tag, stats]) => ({
    tag,
    label: LABELS[tag],
    rate: stats.acceptance_rate,
    accepted: stats.accepted,
    total: stats.total,
    small: stats.total < SMALL_SAMPLE,
  }))
  .sort((a, b) => b.rate - a.rate || b.total - a.total);

const row = (tag) => ROWS.find((entry) => entry.tag === tag);
const figure = (tag) => {
  const entry = row(tag);
  return `${percent(entry.rate)} (${entry.accepted} of ${entry.total})`;
};

const SNAPSHOT = '21 July 2026';

function sortHeader(label, key, direction, numeric) {
  const headAttrs = attrs({ scope: 'col', class: numeric ? 'num' : null, 'aria-sort': direction, 'data-sort-key': key });
  const iconName = direction === 'descending' ? 'sort-down' : direction === 'ascending' ? 'sort-up' : 'sort';
  return html`<th${headAttrs}><button class="table__sort" type="button">${label}${icon(iconName)}</button></th>`;
}

function rateRow(entry) {
  const rowAttrs = attrs({
    id: entry.tag,
    'data-label': entry.label,
    'data-rate': Math.round(entry.rate * 100),
    'data-accepted': entry.accepted,
    'data-total': entry.total,
  });
  return html`<tr${rowAttrs}>
<th scope="row"><a class="rates__class" href="#${entry.tag}"><span class="rates__label">${entry.label}</span><code class="rates__tag">${entry.tag}</code></a>${entry.small && chip('Small sample', { tone: 'unproven', dashed: true, className: 'rates__small' })}</th>
<td class="num rates__rate">${percent(entry.rate)}</td>
<td class="num">${number(entry.total)}</td>
<td class="num">${number(entry.accepted)}</td>
<td class="rates__actions">${button({ label: `Copy the ${entry.label} row as Markdown`, icon: 'copy', iconOnly: true, variant: 'quiet', size: 'sm', attrs: { 'data-copy-row': entry.tag } })}</td>
</tr>`;
}

const ratesTable = html`<div class="table-wrap" tabindex="0" role="region" aria-label="Acceptance rate by bug class">
<table class="table rates" id="rates">
<caption>Acceptance rate by bug class</caption>
<thead><tr>
${sortHeader('Bug class', 'label', 'none', false)}
${sortHeader('Rate', 'rate', 'descending', true)}
${sortHeader('n', 'total', 'none', true)}
${sortHeader('Accepted', 'accepted', 'none', true)}
<th scope="col"><span class="visually-hidden">Copy</span></th>
</tr></thead>
<tbody>${ROWS.map(rateRow)}</tbody>
</table>
</div>`;

const datasetLd = {
  '@context': 'https://schema.org',
  '@type': 'Dataset',
  name: 'Acceptance rates by smart-contract bug class',
  description: `Accepted and judged counts for ${ROWS.length} smart-contract vulnerability classes across ${DATASET.contests_included} audit contests and ${number(DATASET.total_findings)} judged findings.`,
  url: absoluteUrl(PATH),
  license: 'https://creativecommons.org/publicdomain/zero/1.0/',
  isBasedOn: DATASET.upstream,
  dateModified: DATASET.last_updated.slice(0, 10),
  variableMeasured: ['acceptance rate', 'accepted findings', 'judged findings'],
  publisher: { '@type': 'Organization', name: 'Bounty Operator', url: absoluteUrl('/') },
};

const body = html`
<section class="section section--tight wrap">
${toolHead({
  path: PATH,
  lede: `Twelve bug classes, ranked by how often contest judges accepted them. ${number(DATASET.total_accepted)} of ${number(DATASET.total_findings)} judged findings were accepted; the spread between classes is wide.`,
})}

<ul class="rates-facts">
<li><span class="rates-facts__n">${number(DATASET.total_findings)}</span><span class="meta">judged findings</span></li>
<li><span class="rates-facts__n">${number(DATASET.total_accepted)}</span><span class="meta">accepted</span></li>
<li><span class="rates-facts__n">${DATASET.contests_included}</span><span class="meta">contests</span></li>
<li><span class="rates-facts__n">${ROWS.length}</span><span class="meta">bug classes</span></li>
</ul>

${ratesTable}

<p class="tool-table__foot" id="method">Source: Sherlock audit-contest judging repositories on public GitHub, compiled in ${link({ label: 'vulnerability-acceptance-rates.json', href: DATASET.upstream, external: true })} (${link({ label: 'methodology', href: DATASET.methodology_url, external: true })}), licence CC0, snapshot of ${SNAPSHOT}. Only contests whose accepted and invalid counts reconcile with Sherlock’s published results are included. Tags are assigned by keyword and a finding can carry more than one, so the rows overlap.</p>
</section>

<section class="section section--tight wrap" aria-labelledby="read">
<div class="split">
<div class="tool-copy">
<h2 id="read">How to read a row</h2>
<p><strong>n</strong> is the number of judged findings that carry the tag. <strong>Accepted</strong> is how many of those the judges accepted. <strong>Rate</strong> is the second divided by the first.</p>
<p>A row with n under ${SMALL_SAMPLE} is marked as a small sample. Liquidation (${row('liquidation').total}) and flash loan (${row('flash-loan').total}) are the two; one more accepted finding moves either rate by more than seven points.</p>
<p>Every header sorts. Each row has its own link, and the copy button gives the row as one line of Markdown with its source.</p>
<p>Sorting and copying run in this tab. ${COUNTER_LINE}</p>
</div>
<div class="tool-copy">
<h2>What stands out</h2>
<ul class="ticks ticks--plain">
<li><span class="meta">High</span><span>Reentrancy was accepted ${figure('reentrancy')}, the highest rate in the table. Overflow follows at ${figure('overflow')}.</span></li>
<li><span class="meta">Size</span><span>Trusted actor is the largest tag, ${number(row('trusted-actor').total)} findings, and splits down the middle: ${figure('trusted-actor')}.</span></li>
<li><span class="meta">Low</span><span>Oracle manipulation was accepted ${figure('oracle-manipulation')}, rounding ${figure('rounding')}, DoS and griefing ${figure('dos-griefing')}.</span></li>
</ul>
<p>For a class in the lower half, settle three things before you write: who performs each step, whether every precondition is reachable from live state by public calls, and what loss is left after every recovery action.</p>
</div>
</div>
</section>

${nextAction({
  title: 'Find out which side of the rate your finding is on',
  text: 'The triager simulation reads your draft as the programme triager, ranks the three likeliest rejection reasons, quotes the sentence that triggers each and names the evidence that flips it.',
  primary: { label: 'Simulate the triager', href: '/?profile=triage#workspace' },
  secondary: { label: 'How the simulation works', href: '/triager-simulation' },
})}

${relatedTools(PATH)}`;

export default {
  path: PATH,
  title: 'Acceptance rates by vulnerability class | Bounty Operator',
  description: `Acceptance rates for ${ROWS.length} smart-contract bug classes from ${number(DATASET.total_findings)} judged audit-contest findings, with the sample size on every row. Sortable.`,
  nav: 'tools',
  label: 'Acceptance rates',
  order: 4,
  styles: TOOL_STYLES,
  scripts: ['/tools/acceptance-rates.mjs'],
  jsonld: [toolCrumbsLd(PATH), datasetLd],
  lastmod: LASTMOD,
  body,
};
