// /tools: the hub that lists the free tools with one-line outcomes.

import { breadcrumbs, button, html, icon, link } from '../../components.mjs';
import { SITE, absoluteUrl, breadcrumbsLd } from '../../layout.mjs';
import { HOME_CRUMB, LASTMOD, LOCAL_LINE, TOOLS, TOOL_STYLES, localLine } from './_shared.mjs';

const FIRELIGHT = 'https://immunefi.com/audit-competition/audit-comp-firelight-1/leaderboard/';
const QUANTUS = 'https://immunefi.com/audit-competition/audit-comp-quantus/leaderboard/';

const rows = TOOLS.map((entry, index) => html`<li class="tool-row">
<span class="tool-row__n" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
<div class="tool-row__main">
<h2 class="tool-row__title"><a class="tool-row__link" href="${entry.path}">${entry.heading}</a></h2>
<p class="tool-row__text">${entry.outcome}</p>
</div>
<p class="tool-row__io"><span>${entry.input}</span>${icon('arrow-right')}<span>${entry.output}</span></p>
<span class="tool-row__go" aria-hidden="true">${icon('arrow-right')}</span>
</li>`);

const itemListLd = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'Free bug bounty tools',
  itemListElement: TOOLS.map((entry, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: entry.heading,
    url: absoluteUrl(entry.path),
  })),
};

const body = html`
<section class="section section--tight wrap">
<header class="tool-head">
${breadcrumbs([HOME_CRUMB, { label: 'Tools' }])}
<h1>Free bug bounty tools</h1>
<p class="lede">Check a report, a proof or a scanner dump before it leaves your machine. No account, no key.</p>
${localLine()}
</header>

<ol class="tool-rows">${rows}</ol>
</section>

<section class="section section--tight wrap" aria-labelledby="order">
<div class="split">
<div class="prose">
<h2 id="order">Where each one fits</h2>
<p>The order follows a finding from first lead to filed report.</p>
<ol>
<li><strong>Before you dig.</strong> <a href="/tools/acceptance-rates">Acceptance rates</a> show which bug classes judges accepted and which they closed. <a href="/tools/slither-focus">Slither triage queue</a> cuts a scanner dump to the detectors worth reading.</li>
<li><strong>Before you publish a proof.</strong> <a href="/tools/secret-check">Secret check</a> lists every key, token and private link by file and line.</li>
<li><strong>Before you submit.</strong> <a href="/tools/report-check">Report check</a> reads the draft for the things a triager looks for first.</li>
<li><strong>After a review.</strong> <a href="/tools/verify">Packet verifier</a> proves the files in a review packet are the files on disk.</li>
</ol>
</div>
<div class="prose">
<h2>What they are built from</h2>
<p>Twelve checks, distilled from 105 real case files across five platforms. The wins and the closures. Every check exists because real reports were closed for that reason. <a href="/method">The method page</a> has all twelve: the question each one asks, why reports die on it and the verdict it leads to.</p>
<p>The tools read text and hash files. The workbench goes further: your own model argues against the finding and returns one verdict.</p>
<p>Built by ${link({ label: 'Tradi3', href: SITE.builder.url, external: true })}: 2nd of 133 in Immunefi’s ${link({ label: 'Firelight competition', href: FIRELIGHT, external: true })}, 8th of 65 in ${link({ label: 'Quantus', href: QUANTUS, external: true })}.</p>
</div>
</div>
</section>

<section class="section section--tight wrap" aria-labelledby="next-action">
<div class="tool-next">
<div class="tool-next__text">
<h2 class="h3" id="next-action">Find the hole in your report before the triager does</h2>
<p>Hand a draft to the workbench and get the sentence it would be closed on. One hosted review per UTC day is free.</p>
</div>
<div class="cluster">
${button({ label: 'Open the workbench', href: '/#workspace', variant: 'primary', iconEnd: 'arrow-right' })}
${button({ label: 'Read the report guide', href: '/guide' })}
</div>
</div>
</section>`;

export default {
  path: '/tools',
  title: 'Free bug bounty tools | Bounty Operator',
  description: `Five free bug bounty tools: report check, packet verifier, secret check, acceptance rates and a Slither triage queue. ${LOCAL_LINE}`,
  nav: 'tools',
  label: 'All tools',
  styles: TOOL_STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Tools', path: '/tools' }]), itemListLd],
  lastmod: LASTMOD,
  body,
};
