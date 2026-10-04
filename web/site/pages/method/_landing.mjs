// The template shared by the profile landing pages. No default export, so the
// generator treats this module as a helper.

import { button, cx, faq, html, icon, inline, sectionHeading } from '../../components.mjs';
import { breadcrumbsLd, faqPageLd } from '../../layout.mjs';
import { LIMITS } from '../../../public/review-core.mjs';
import { LASTMOD, STYLES, ctaBand, exampleFrame, pageHero, points, relatedLinks, tickList, workbenchLink } from './_shared.mjs';

const KB = 1000;

/** "Up to 50 files, 120 KB per file, 240 KB and 20,000 lines in total", read from the engine. */
export const LIMITS_LINE = `Up to ${LIMITS.files} files, ${LIMITS.fileBytes / KB} KB per file, ${LIMITS.totalBytes / KB} KB and ${LIMITS.totalLines.toLocaleString('en-US')} lines in total.`;

/** What to paste in: [{ name, note, optional }]. */
function needsList(items) {
  return html`<ul class="needs">${items.map(
    (item) => html`<li class="needs__item">${icon('file')}<div><p class="needs__name">${inline(item.name)}${item.optional && html`<span class="needs__opt">Optional</span>`}</p>${item.note && html`<p class="needs__note">${inline(item.note)}</p>`}</div></li>`,
  )}</ul>`;
}

/**
 * One landing page for a review profile.
 *
 * profileId, profileName   the profile the call to action preselects
 * hero                     { eyebrow, title, lede, example, exampleLabel }
 * checks                   { title, lede, items: [{ title, text }], columns }
 *                          A core profile says what it checks. A hosted profile
 *                          says what it answers and outputs, and nothing of how.
 * checksButton             label of the hero button that jumps to that section
 * paste                    { lede, items: [{ name, note, optional }] }
 * returns                  { lede, items: string[] }
 * more                     { title, lede, label, body } more of the example output, optional
 * faqItems, related
 * cta                      { button, title, lede }; button is the label of the primary action
 */
export function profileLanding({ path, title, description, label, profileId, profileName, hero, checks, checksButton = 'What it checks', paste, returns, more, faqItems, related, cta }) {
  const open = (size = 'lg') =>
    button({ label: cta.button, href: workbenchLink(profileId), variant: 'primary', size, iconEnd: 'arrow-right' });

  const body = html`
${pageHero({
  trail: [{ label: 'Bounty Operator', href: '/' }, { label: 'Method', href: '/method' }, { label: label ?? profileName }],
  eyebrow: hero.eyebrow ?? profileName,
  title: hero.title,
  lede: hero.lede,
  actions: html`${open()}${button({ label: checksButton, href: '#checks', size: 'lg' })}`,
  note: 'Free: 1 review a day on your own key. No card.',
  aside: exampleFrame({ label: hero.exampleLabel, body: hero.example, className: 'example--narrow' }),
  stickyText: true,
})}

<section class="section wrap" aria-labelledby="checks">
  ${sectionHeading({ title: checks.title, id: 'checks', lede: checks.lede })}
  ${points(checks.items, { columns: checks.columns ?? 3 })}
</section>

<section class="section wrap">
  <div class="split">
    <div>
      ${sectionHeading({ title: 'What to paste in', id: 'paste', lede: paste.lede })}
      ${needsList(paste.items)}
      <p class="fine needs__limits">${LIMITS_LINE} Paste, drop files, or import a repository, pull request or commit from GitHub at a pinned commit.</p>
    </div>
    <div>
      ${sectionHeading({ title: 'What comes back', id: 'returns', lede: returns.lede })}
      ${tickList(returns.items)}
    </div>
  </div>
</section>

${more && html`
<section class="section wrap" aria-labelledby="more">
  ${sectionHeading({ title: more.title, id: 'more', lede: more.lede })}
  ${exampleFrame({ label: more.label ?? hero.exampleLabel, body: more.body })}
</section>`}

<section class="${cx('section', 'wrap', 'wrap--narrow')}" aria-labelledby="faq">
  ${sectionHeading({ title: 'Questions', id: 'faq' })}
  ${faq(faqItems, { exclusive: `${profileId}-faq` })}
</section>

${ctaBand({
  title: cta.title,
  lede: cta.lede,
  actions: html`${open()}${button({ label: 'Read the method', href: '/method', size: 'lg' })}`,
  note: 'Free: 1 review a day. Operator: unlimited, US$10 per week.',
})}

<section class="section section--tight wrap">
  ${relatedLinks(related, { title: 'Run next' })}
</section>`;

  return {
    path,
    title,
    description,
    label: label ?? profileName,
    styles: STYLES,
    jsonld: [breadcrumbsLd([{ name: 'Method', path: '/method' }, { name: label ?? profileName, path }]), faqPageLd(faqItems)],
    lastmod: LASTMOD,
    body,
  };
}

/**
 * A ledger card built from finding-card parts, for output that is a list of
 * judged rows (claims, rejection reasons, overlap) instead of one finding.
 * rows: [{ label, kind, status, name, quote, plain, chip, text, refs }]
 */
export function ledgerCard({ id, tag, title, chips, bar, rows, next }) {
  return html`
<article class="finding ledger-card" aria-labelledby="${id}-title">
  ${bar && html`<div class="finding__bar">${icon('file')}<span class="finding__file">${bar.name}</span>${bar.tag && html`<span class="finding__tag">${bar.tag}</span>`}</div>`}
  <header class="finding__head">
    <div class="finding__tags"><span class="finding__id">${tag}</span>${chips}</div>
    <h3 class="finding__title" id="${id}-title">${inline(title)}</h3>
  </header>
  <dl class="finding__rows">
    ${rows.map(
      (row) => html`
    <div class="rail" data-rail="${row.kind}"${row.status ? html` data-status="${row.status}"` : ''}>
      <dt class="rail__label">${row.label}</dt>
      <dd class="rail__body">
        ${row.name && html`<p class="ledger-card__name">${row.name}</p>`}
        ${row.quote && html`<p class="rail__quote">${inline(row.quote)}</p>`}
        ${row.plain && html`<p>${inline(row.plain)}</p>`}
        ${(row.chip || row.text) && html`<p class="rail__answer">${row.chip}<span>${inline(row.text ?? '')}</span></p>`}
        ${row.refs && html`<p class="ledger-card__refs">${row.refs}</p>`}
      </dd>
    </div>`,
    )}
    ${next && html`
    <div class="rail" data-rail="next">
      <dt class="rail__label">Next</dt>
      <dd class="rail__body"><p class="rail__next">${icon('arrow-right')}<span>${inline(next)}</span></p></dd>
    </div>`}
  </dl>
</article>`;
}
