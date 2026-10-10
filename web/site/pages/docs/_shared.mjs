// Shared layout for the guide, MCP, legal and trust pages. No default export,
// so the generator treats this module as a helper and builds no page from it.
//
// Styles: /css/docs.css. Every class used here is defined there or in base.css.

import { attrs, breadcrumbs, cx, html, icon, raw } from '../../components.mjs';
import { SITE } from '../../layout.mjs';

export const DOCS_STYLES = ['/css/docs.css'];

/** The date the legal and trust text was last changed. */
export const UPDATED = '2026-10-07';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-10-02' -> '2 October 2026' */
export function longDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** <time datetime="2026-10-02">2 October 2026</time> */
export function time(iso) {
  return html`<time datetime="${iso}">${longDate(iso)}</time>`;
}

export function mailto(address) {
  return html`<a href="mailto:${address}">${address}</a>`;
}

export const supportLink = () => mailto(SITE.support);
export const securityLink = () => mailto(SITE.security);

/** An external link for use inside prose: opens in a new tab, no icon. */
export function ext(label, href) {
  return html`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/**
 * The page head: breadcrumbs, the one h1, the lede and an optional meta line
 * and action row.
 */
export function docHead({ crumbs, title, lede, meta, actions }) {
  return html`<header class="page-head page-field">
${breadcrumbs(crumbs)}
<h1>${title}</h1>
${lede && html`<p class="lede">${lede}</p>`}
${meta && html`<p class="meta">${meta}</p>`}
${actions && html`<div class="cluster page-head__actions">${actions}</div>`}
</header>`;
}

/**
 * The page body: an "On this page" index and the sections it lists. The index
 * and the headings come from one list, so a link can never point at a missing id.
 *
 * sections: [{ id, title, label?, body, prose? }]
 *   label  shorter text for the index (default: the title)
 *   prose  false when the body lays itself out (default: wrapped in .prose)
 */
export function docBody(sections, { before } = {}) {
  const index = sections.map((section) => html`<li><a href="#${section.id}">${section.label ?? section.title}</a></li>`);
  const blocks = sections.map((section) => {
    const content = section.prose === false ? section.body : html`<div class="prose">${section.body}</div>`;
    return html`<section class="docs-section" aria-labelledby="${section.id}">
<h2 class="docs-section__title" id="${section.id}">${section.title}</h2>
${content}
</section>`;
  });

  return html`<div class="docs-body">
<nav class="docs-toc" aria-label="On this page">
<p class="meta">On this page</p>
<ul>${index}</ul>
</nav>
<div class="docs-content">
${before}
${blocks}
</div>
</div>`;
}

/** The whole page: head, an optional full-width lead block, then the body. */
export function docPage({ head, lead, sections, before, after }) {
  return html`<article class="docs wrap">
${docHead(head)}
${lead && html`<div class="docs-lead">${lead}</div>`}
${docBody(sections, { before })}
${after}
</article>`;
}

/**
 * A grid of short facts, each with an icon: facts([{ icon: 'lock', title, text }])
 */
export function facts(items, { className } = {}) {
  const rows = items.map(
    (item) => html`<li class="facts__item">${icon(item.icon ?? 'check')}<div><p class="facts__title">${item.title}</p>${item.text && html`<p class="facts__text">${item.text}</p>`}</div></li>`,
  );
  return html`<ul class="${cx('facts', className)}">${rows}</ul>`;
}

/** A list with a tick in front of every item. Items are html or strings. */
export function checklist(items, { className } = {}) {
  return html`<ul class="${cx('checklist', className)}">${items.map((item) => html`<li>${icon('check')}<div>${item}</div></li>`)}</ul>`;
}

/** A heading element with an id, for sub-sections inside a section body. */
export function heading(level, id, text) {
  return html`${raw(`<h${level}`)}${attrs({ id })}>${text}${raw(`</h${level}>`)}`;
}
