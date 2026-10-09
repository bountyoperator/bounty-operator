// The page shell: <head>, site header, footer and the JSON-LD helpers.
//
// scripts/build-site.mjs calls renderPage(page, site) for every page module
// under web/site/pages. The page contract is documented in COMPONENTS.md.

import { attrs, brandMark, button, cx, esc, html, icon, inline, raw, textOf } from './components.mjs';
import { CHAT_LINE, FREE_LINE, OPERATOR_LINE } from './plans.mjs';

export const SITE = {
  origin: 'https://bountyoperator.com',
  name: 'Bounty Operator',
  promise: 'Find the hole in your report before the triager does.',
  summary:
    'Pre-submission review for bug bounty reports and smart-contract findings. The AI argues against the finding. The hunter writes the report.',
  defaultImage: '/social-v5.png',
  source: 'https://github.com/bountyoperator/bounty-operator',
  support: 'support@bountyoperator.com',
  security: 'security@bountyoperator.com',
  // The builder's public contest profile, and the builder's handle on X for link
  // previews (twitter:creator). The product has no X account, so no twitter:site.
  builder: { name: 'Tradi3', url: 'https://audits.sherlock.xyz/watson/Tradi3', x: '@Tradi3_' },
  // Keep in step with --bg in web/public/css/base.css and with web/public/theme.js.
  themeColor: { dark: '#09090a', light: '#09090a' },
};

/** The one webfont: Archivo, self-hosted. Preloaded so headings do not reflow when it lands. */
export const FONT_FILE = '/fonts/archivo-latin-wdth.woff2';

/**
 * The design contract (impeccable direction, seed b5682f59), emitted as the
 * first child of every <body> so the built pages carry it. DESIGN.md records
 * the system that was built from it.
 */
export const DESIGN_CONTRACT = `<!--
THESIS: The verdict is a stamp on your draft, and the red pen has been through it first. The site is the inspection a finding passes before a triager sees it.
OWN-WORLD: A black page, bone-white print and one hot ink, vermilion: the red of a seal and of a marking pen. The report is a sheet of paper lying on the page. Behind each page head lie lines of a report and of its code; lights drift over them and the pen strikes a line now and then. Archivo: wide heavy cuts for headlines and figures, condensed caps for stamps and labels; mono only for code and typed entries.
STORY: A hunter sees a Critical stamped down to Medium with the line that decides it, trusts that the review argues against them, and starts a review or opens the example.
FIRST VIEWPORT: The moving field on black. Left: the headline with "the hole" circled in pen, the lede, a vermilion Review my report, a ruled View example. Right: the paper slip, tilted, Critical struck, Medium and the verdict stamped on it, in the light of the ember. Under them the three results of the builder as figures, then the five verdicts running past.
FORM: Rubber-stamp verdicts and a report marked in red pen, seed b5682f59.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`;

/**
 * Header navigation. `requires` hides an item until that page exists in the
 * page set. `page` is the item's own page: the link goes there from every page
 * but the home page, which keeps the section link in `href`.
 */
export const NAV = [
  { id: 'workbench', label: 'Review', href: '/#workspace' },
  { id: 'benchmark', label: 'Benchmark', href: '/benchmark', requires: '/benchmark' },
  { id: 'tools', label: 'Tools', href: '/tools' },
  { id: 'guide', label: 'Guide', href: '/guide' },
  { id: 'pricing', label: 'Pricing', href: '/#pricing', page: '/pricing' },
];

/** Where the Pricing links of a page point: the pricing page, or the home section while that page does not exist. */
function pricingHref(page, site) {
  return page.path !== '/' && site.has('/pricing') ? '/pricing' : '/#pricing';
}

export function absoluteUrl(path) {
  if (/^https?:\/\//.test(path)) return path;
  return `${SITE.origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Short page name for footer links and breadcrumbs: `label`, or the title up to its first separator. */
export function pageLabel(page) {
  if (page.label) return page.label;
  return String(page.title).split(/\s+[—|·-]\s+/)[0].trim();
}

function isIndexable(page) {
  return !page.dev && !/noindex/i.test(page.robots ?? '');
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

/** Serialise JSON so it cannot close the script element or start a comment. */
function jsonForScript(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function jsonLdScript(data) {
  return html`<script type="application/ld+json">${raw(jsonForScript(data))}</script>`;
}

export function organizationLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE.name,
    url: `${SITE.origin}/`,
    logo: absoluteUrl('/icon-512.png'),
    email: SITE.support,
    sameAs: [SITE.source],
  };
}

/** The product with its two fixed offers: Free, and Operator at US$10 per week. */
export function softwareApplicationLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE.name,
    url: `${SITE.origin}/`,
    applicationCategory: 'SecurityApplication',
    operatingSystem: 'Web',
    description: SITE.summary,
    image: absoluteUrl(SITE.defaultImage),
    creator: { '@type': 'Organization', name: SITE.builder.name, url: SITE.builder.url },
    offers: [
      {
        '@type': 'Offer',
        name: 'Free',
        price: '0',
        priceCurrency: 'USD',
        description: `${FREE_LINE} ${CHAT_LINE}. Free tools, repo import and local history.`,
        url: absoluteUrl('/pricing'),
      },
      {
        '@type': 'Offer',
        name: 'Operator',
        price: '10.00',
        priceCurrency: 'USD',
        description: OPERATOR_LINE,
        url: absoluteUrl('/pricing'),
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price: '10.00',
          priceCurrency: 'USD',
          billingDuration: 'P1W',
          unitText: 'week',
        },
      },
    ],
  };
}

/** faqPageLd([{ q, a }]) takes the same items as the faq() component. */
export function faqPageLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: textOf(item.q),
      acceptedAnswer: { '@type': 'Answer', text: textOf(inline(item.a)) },
    })),
  };
}

/** breadcrumbsLd([{ name: 'Tools', path: '/tools' }, { name: 'Report check', path: '/tools/report-check' }]) */
export function breadcrumbsLd(trail) {
  const crumbs = [{ name: SITE.name, path: '/' }, ...trail];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path),
    })),
  };
}

// ---------------------------------------------------------------------------
// <head>
// ---------------------------------------------------------------------------

function socialTags(page, canonical) {
  const og = page.og ?? {};
  const title = og.title ?? page.title;
  const description = og.description ?? page.description;
  const image = absoluteUrl(og.image ?? SITE.defaultImage);
  const usesDefaultImage = !og.image;
  const width = og.width ?? (usesDefaultImage ? 1200 : null);
  const height = og.height ?? (usesDefaultImage ? 630 : null);
  const alt = og.alt ?? `${SITE.name}. ${SITE.promise}`;

  return html`
<meta property="og:type" content="${og.type ?? 'website'}">
<meta property="og:site_name" content="${SITE.name}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">${canonical && html`
<meta property="og:url" content="${canonical}">`}
<meta property="og:image" content="${image}">${width && html`
<meta property="og:image:width" content="${width}">`}${height && html`
<meta property="og:image:height" content="${height}">`}
<meta property="og:image:alt" content="${alt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:creator" content="${SITE.builder.x}">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
<meta name="twitter:image:alt" content="${alt}">`;
}

// The page's modules are fetched at low priority. A page is readable without
// them, and a browser fetches a module at the priority of a blocking script:
// on a slow connection the workbench's 28 files then compete with the
// stylesheets and the font for the first paint. Preloading keeps them from
// loading one level of imports at a time.
function head(page, site) {
  const indexable = isIndexable(page);
  const canonical = indexable ? absoluteUrl(page.path) : null;
  const robots = page.robots ?? (page.dev ? 'noindex, nofollow' : null);
  const styles = ['/css/base.css', ...(page.styles ?? [])];
  const scripts = ['/field.mjs', ...(page.scripts ?? [])];
  const preloads = site.preloadsFor ? site.preloadsFor(page) : (page.preload ?? []);

  return html`<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<meta name="description" content="${page.description}">${canonical && html`
<link rel="canonical" href="${canonical}">`}${robots && html`
<meta name="robots" content="${robots}">`}
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="${SITE.themeColor.dark}">${socialTags(page, canonical)}
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
${site.has(FONT_FILE) && html`<link rel="preload" href="${FONT_FILE}" as="font" type="font/woff2" crossorigin>
`}<script src="/theme.js"></script>${styles.map((href) => html`
<link rel="stylesheet" href="${href}">`)}${preloads.map((href) => html`
<link rel="modulepreload" href="${href}" fetchpriority="low">`)}${scripts.map((src) => html`
<script type="module" src="${src}" fetchpriority="low"></script>`)}${(page.jsonld ?? []).map((data) => html`
${jsonLdScript(data)}`)}
</head>`;
}

// ---------------------------------------------------------------------------
// Header and footer
// ---------------------------------------------------------------------------

function siteHeader(page, site) {
  const items = NAV.filter((item) => !item.requires || site.has(item.requires)).map((item) => {
    const href = item.page && page.path !== '/' && site.has(item.page) ? item.page : item.href;
    const linkAttrs = attrs({ href, 'aria-current': page.nav === item.id ? 'page' : null });
    return html`<li><a${linkAttrs}>${item.label}</a></li>`;
  });

  // The home page hosts the account dialog, so its control is a button the app wires up.
  // Both ship with the same label, the one a signed-out visitor needs. A page that
  // loads /app/account.mjs relabels it "Account" once it knows the visitor is signed in.
  const account =
    page.path === '/'
      ? html`<button id="account-button" class="btn btn--secondary btn--sm" type="button">Sign in</button>`
      : html`<a class="btn btn--secondary btn--sm" href="/#account">Sign in</a>`;

  return html`<header class="site-header">
<div class="wrap site-header__inner">
<a class="brand" href="/">${brandMark()}<span class="brand__name">${SITE.name}</span></a>
<nav class="site-nav" aria-label="Main"><ul>${items}</ul></nav>
<div class="site-header__actions">
${account}
</div>
</div>
</header>`;
}

function footerColumn(title, links) {
  const items = links.filter(Boolean).map((entry) => {
    if (entry.external) {
      return html`<li><a href="${entry.href}" target="_blank" rel="noopener noreferrer">${entry.label}${icon('arrow-up-right')}</a></li>`;
    }
    return html`<li><a href="${entry.href}">${entry.label}</a></li>`;
  });
  return html`<nav class="site-footer__col" aria-label="${title}"><h2 class="site-footer__title">${title}</h2><ul>${items}</ul></nav>`;
}

function siteFooter(page, site) {
  const optional = (path, label) => (site.has(path) ? { href: path, label } : null);
  return html`<footer class="site-footer theme-dark">
<div class="wrap site-footer__grid">
<div class="site-footer__brand">
<a class="brand" href="/">${brandMark()}<span class="brand__name">${SITE.name}</span></a>
<p class="site-footer__promise">${SITE.promise}</p>
<p class="site-footer__cta">${button({ label: 'Review my report', href: '/?profile=report#workspace', variant: 'primary', iconEnd: 'arrow-right' })}</p>
</div>
${footerColumn('Product', [
    { href: '/#workspace', label: 'Review a report' },
    optional('/benchmark', 'Benchmark'),
    { href: '/tools', label: 'Free tools' },
    { href: pricingHref(page, site), label: 'Pricing' },
    { href: '/#account', label: 'Account' },
  ])}
${footerColumn('Resources', [
    { href: '/guide', label: 'Report guide' },
    { href: '/mcp', label: 'MCP setup' },
    optional('/method', 'Review method'),
    optional('/templates', 'Report templates'),
    optional('/changelog', 'Changelog'),
    { href: SITE.source, label: 'Source', external: true },
  ])}
${footerColumn('Legal', [
    { href: '/privacy', label: 'Privacy' },
    { href: '/terms', label: 'Terms' },
    optional('/security', 'Security'),
    optional('/licenses', 'Licences'),
    { href: `mailto:${SITE.security}`, label: 'Report a vulnerability' },
  ])}
</div>
<div class="wrap">
<div class="site-footer__base">
<p>Built by <a href="${SITE.builder.url}" target="_blank" rel="noopener noreferrer">${SITE.builder.name}</a></p>
<p><button class="motion-toggle" type="button" data-motion-toggle hidden>Pause motion</button></p>
<p><a href="mailto:${SITE.support}">${SITE.support}</a></p>
</div>
</div>
<div class="site-footer__mark" aria-hidden="true">Bounty Operator</div>
</footer>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const EMPTY_SITE = { has: () => false, pages: [] };

/**
 * Render one page module to a complete HTML document.
 *
 * site.has(path)        true when the path is a generated page or a file in web/public
 * site.pages            every page in this build (used for the footer tool list)
 * site.preloadsFor(page) modulepreload hrefs; the generator derives them from the import graph
 */
export function renderPage(page, site = EMPTY_SITE) {
  const skip = page.skip ?? { href: '#main', label: 'Skip to content' };
  const document = html`<!doctype html>
<html lang="en">
${head(page, site)}
<body${attrs({ class: cx(page.bodyClass) || null })}>
${raw(DESIGN_CONTRACT)}
<a class="skip-link" href="${skip.href}">${skip.label}</a>
${siteHeader(page, site)}
<main id="main" tabindex="-1">
${page.body}
</main>
${siteFooter(page, site)}${page.overlays && html`
${page.overlays}`}
</body>
</html>
`;
  return document.toString();
}

/** Escape helper re-exported for page modules that only import the layout. */
export { esc };
