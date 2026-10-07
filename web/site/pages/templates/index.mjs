// /templates — the hub: four platform templates, the Foundry scaffold, and what
// each platform's judges close reports for.

import { button, html, icon, stackTable } from '../../components.mjs';
import { absoluteUrl, breadcrumbsLd } from '../../layout.mjs';
import { CHECKED, COMPARISON, PARTS, PLATFORMS } from './data.mjs';
import { crumbs, plain } from './shared.mjs';

const FOUNDRY = {
  path: '/templates/foundry-poc',
  name: 'Foundry PoC',
  card: 'A fork-test scaffold: pinned block, named actors, concrete values, a control run and a fix run.',
  points: ['The final assertion reads the object the impact names', 'One file, one command, pasted output', 'Passes on deployed code, fails on the patched build'],
};

/**
 * "Open template", with the template's name for assistive technology. The
 * accessible name starts with the visible label (WCAG 2.5.3), so a voice
 * command that says what is on screen still reaches the button.
 */
const openLabel = (name) => html`Open template<span class="visually-hidden">: ${name}</span>`;

function platformCard(platform) {
  return html`<article class="tpl-card">
    <header class="tpl-card__head">
      <h3 class="tpl-card__title"><a href="${platform.path}">${platform.name}</a></h3>
      <span class="tpl-card__meta">${platform.sections.length} sections</span>
    </header>
    <p class="tpl-card__about">${platform.card}</p>
    <p class="meta">Judges close reports for</p>
    <ul class="tpl-card__closed">
      ${platform.cardClosed.map((reason) => html`<li>${icon('x')}<span>${reason}</span></li>`)}
    </ul>
    <div class="tpl-card__foot">
      ${button({ label: openLabel(platform.name), href: platform.path, iconEnd: 'arrow-right', block: true })}
    </div>
  </article>`;
}

const foundryCard = html`<article class="tpl-card tpl-card--wide">
  <header class="tpl-card__head">
    <h3 class="tpl-card__title"><a href="${FOUNDRY.path}">${FOUNDRY.name}</a></h3>
    <span class="tpl-card__meta">ImpactPoC.t.sol</span>
  </header>
  <p class="tpl-card__about">${FOUNDRY.card}</p>
  <ul class="tpl-card__closed tpl-card__closed--ok">
    ${FOUNDRY.points.map((point) => html`<li>${icon('check')}<span>${point}</span></li>`)}
  </ul>
  <div class="tpl-card__foot">
    ${button({ label: openLabel(FOUNDRY.name), href: FOUNDRY.path, iconEnd: 'arrow-right', block: true })}
  </div>
</article>`;

const comparison = stackTable({
  caption: `Published rules, checked ${CHECKED.label}`,
  label: 'What each platform closes reports for',
  columns: [{ label: 'Rule' }, ...PLATFORMS.map((platform) => ({ label: platform.name }))],
  rows: COMPARISON.map((row) => [row.question, ...row.cells.map((cell) => html`${plain(cell)}`)]),
  className: 'tpl-compare',
  wide: true,
});

const body = html`
<div class="wrap tpl-page">
  <header class="tpl-hero">
    ${crumbs([])}
    <h1>Bug bounty report templates</h1>
    <p class="lede">Four report templates built from what each platform publishes about submissions and judging, and one Foundry scaffold for the proof. Every page lists what that platform’s judges close reports for, with the source.</p>
    <p class="meta">Rules checked ${CHECKED.label} · Markdown, free to copy</p>
  </header>

  <section class="tpl-block" aria-labelledby="platforms">
    <h2 id="platforms" class="visually-hidden">Templates by platform</h2>
    <div class="tpl-cards">
      ${PLATFORMS.map(platformCard)}
      ${foundryCard}
    </div>
  </section>

  <section class="tpl-block" aria-labelledby="closed">
    <h2 id="closed">What each platform’s judges close reports for</h2>
    <p class="tpl-block__lede">The same finding is judged against a different rulebook on each platform. These are the published rules that end a report, side by side. Each template page links the source for every cell.</p>
    ${comparison}
  </section>

  <section class="tpl-block" aria-labelledby="parts">
    <h2 id="parts">Eight parts, on every platform</h2>
    <p class="tpl-block__lede">The headings change with the platform. The parts do not. Six are what the platform asks for. The last two are added, because reports get closed for overclaiming and for known issues after everything else has passed.</p>
    <ol class="tpl-parts">
      ${PARTS.map(([name, text]) => html`<li><span class="tpl-parts__name">${name}</span><span class="tpl-parts__text">${text}</span></li>`)}
    </ol>
    <p class="tpl-record">Twelve checks, distilled from 105 real case files across five platforms. The wins and the closures. Every check exists because real reports were closed for that reason, and the two added sections come from that record.</p>
  </section>

  <section class="tpl-block tpl-cta" aria-labelledby="next">
    <h2 id="next">Fill one in, then challenge it</h2>
    <p class="tpl-block__lede">A template gives the report its shape. The workbench argues against what you wrote in it: the impact row, the proof, the severity, the prior art. Find the hole in your report before the triager does. <a class="link" href="/challenge-report">How the challenge works</a>.</p>
    <div class="cluster">
      ${button({ label: 'Challenge a draft report', href: '/?profile=report#workspace', variant: 'primary', iconEnd: 'arrow-right' })}
      ${button({ label: 'Run the report check', href: '/tools/report-check' })}
    </div>
  </section>
</div>`;

export default {
  path: '/templates',
  title: 'Bug bounty report templates | Bounty Operator',
  description:
    'Report templates for Immunefi, Sherlock, Cantina and HackerOne, plus a Foundry PoC scaffold. Each lists what that platform’s judges close reports for.',
  label: 'Report templates',
  styles: ['/css/templates.css'],
  jsonld: [
    breadcrumbsLd([{ name: 'Report templates', path: '/templates' }]),
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Bug bounty report templates',
      itemListElement: [...PLATFORMS, FOUNDRY].map((entry, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: entry.h1 ?? 'Foundry PoC template',
        url: absoluteUrl(entry.path),
      })),
    },
  ],
  lastmod: CHECKED.iso,
  body,
};
