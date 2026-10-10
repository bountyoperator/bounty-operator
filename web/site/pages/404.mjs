// The not-found page. Cloudflare serves 404.html for any path without a match.

import { button, html } from '../components.mjs';

const body = html`
<div class="wrap">
  <header class="page-head page-field">
    <h1>No page at this address.</h1>
    <p class="lede">The server answered 404. The link is out of date or the address has a typo.</p>
    <div class="cluster page-head__actions">
      ${button({ label: 'Start a free review', href: '/#workspace', variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}
      ${button({ label: 'Free tools', href: '/tools', size: 'lg' })}
      ${button({ label: 'Report guide', href: '/guide', size: 'lg' })}
    </div>
  </header>
</div>`;

export default {
  path: '/404',
  title: 'Page not found | Bounty Operator',
  description: 'No page at this address. Start a review, open the free tools or read the report guide from here.',
  robots: 'noindex',
  sitemap: false,
  body,
};
