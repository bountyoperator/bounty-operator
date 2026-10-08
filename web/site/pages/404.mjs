// The not-found page. Cloudflare serves 404.html for any path without a match.

import { button, html, rail } from '../components.mjs';

const body = html`
<section class="section wrap wrap--narrow">
  <article class="finding finding--raised" aria-labelledby="not-found-title">
    <div class="finding__bar finding__bar--form">
      <span class="finding__form">Page request</span>
      <span class="finding__tag">Returned · HTTP 404</span>
    </div>
    <header class="finding__head">
      <h1 class="finding__title" id="not-found-title">No page at this address.</h1>
    </header>
    <dl class="finding__rows">
      ${rail('observed', html`<p>The server answered 404. The link is out of date or the address has a typo.</p>`)}
      ${rail(
        'next',
        html`
        <p>Three pages that exist:</p>
        <div class="cluster">
          ${button({ label: 'Open the workbench', href: '/#workspace', variant: 'primary', iconEnd: 'arrow-right' })}
          ${button({ label: 'Free tools', href: '/tools' })}
          ${button({ label: 'Report guide', href: '/guide' })}
        </div>`,
      )}
    </dl>
  </article>
</section>`;

export default {
  path: '/404',
  title: 'Page not found | Bounty Operator',
  description: 'No page at this address. Open the workbench, the free tools or the report guide from here.',
  robots: 'noindex',
  sitemap: false,
  body,
};
