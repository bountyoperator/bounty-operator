// /tools: the hub that lists the free tools with one-line outcomes.

import { breadcrumbs, button, html, icon } from '../../components.mjs';
import { absoluteUrl, breadcrumbsLd } from '../../layout.mjs';
import { HOME_CRUMB, LASTMOD, LOCAL_LINE, TOOLS, TOOL_STYLES, localLine } from './_shared.mjs';


const rows = TOOLS.map((entry, index) => html`<li class="tool-row">
<span class="tool-row__n" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
<div class="tool-row__main">
<h2 class="tool-row__title"><a class="tool-row__link" href="${entry.path}">${entry.name}</a></h2>
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
<p class="lede">Five tools. No account or API key needed.</p>
${localLine()}
</header>

<ol class="tool-rows">${rows}</ol>
</section>

<section class="section section--tight wrap" aria-labelledby="next-action">
<div class="tool-next">
<div class="tool-next__text">
<h2 class="h3" id="next-action">Want an AI review?</h2>
<p>Add your draft and supporting files. Get a verdict and next steps.</p>
</div>
<div class="cluster">
${button({ label: 'Review my report', href: '/?profile=report#workspace', variant: 'primary', iconEnd: 'arrow-right' })}
${button({ label: 'Report guide', href: '/guide' })}
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
