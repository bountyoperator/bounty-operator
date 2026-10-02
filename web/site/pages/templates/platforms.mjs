// /templates/immunefi, /templates/sherlock, /templates/cantina, /templates/hackerone
//
// One page per platform, all rendered from data.mjs.

import { chip, html } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { CHECKED, PLATFORMS } from './data.mjs';
import { checkDraft, closedList, crumbs, pageIndex, sourceList, templateActions, templateArticle } from './shared.mjs';

function platformPage(platform) {
  const others = PLATFORMS.filter((other) => other.id !== platform.id);

  const body = html`
<div class="wrap tpl-page">
  <header class="tpl-hero">
    ${crumbs([{ label: platform.name }])}
    <h1>${platform.h1}</h1>
    <p class="lede">${platform.lede}</p>
    ${templateActions({ file: platform.file, download: platform.download })}
    <p class="meta">Rules checked ${CHECKED.label} · ${platform.sources.length} sources</p>
  </header>

  <div class="tpl-layout">
    ${pageIndex([
      { id: 'template', label: 'The template' },
      { id: 'closed', label: 'What gets this closed' },
      { id: 'check', label: 'Challenge the draft' },
      { id: 'sources', label: 'Sources' },
    ])}

    <div class="tpl-main">
      <section class="tpl-block" aria-labelledby="template">
        <h2 id="template">The template</h2>
        <p class="tpl-block__lede">${platform.formNote}</p>
        <p class="tpl-legend">
          ${chip('Platform', { tone: 'observed' })}<span>asked for in ${platform.name}’s published guidance.</span>
          ${chip('Added', { dashed: true })}<span>answers the two objections that close reports late: overclaiming and known issues.</span>
        </p>
        ${templateArticle(platform)}
      </section>

      <section class="tpl-block" aria-labelledby="closed">
        <h2 id="closed">What gets this closed on ${platform.name}</h2>
        <p class="tpl-block__lede">Each reason comes from a page ${platform.name} publishes. The programme or contest page adds its own rules on top, and those win.</p>
        ${closedList(platform)}
      </section>

      <section class="tpl-block" aria-labelledby="check">
        <h2 id="check">Challenge the filled draft</h2>
        ${checkDraft({
          profile: 'report',
          focus: platform.focus,
          fileName: `${platform.id}-report-draft.md`,
          note: `Draft written from the ${platform.name} report template at bountyoperator.com${platform.path}. Platform rules checked ${CHECKED.label}.`,
          label: 'Your filled draft',
          placeholder: 'Paste the report with every placeholder replaced.',
          primary: { label: 'Challenge it in the workbench', href: '/?profile=report#workspace' },
          secondary: { label: 'Run the report check', href: '/tools/report-check' },
          intro: html`<p class="tpl-block__lede">Paste the report once every placeholder is replaced. The workbench opens with <a class="link" href="/challenge-report">Challenge a draft report</a> selected and argues against each claim: the impact row, the proof, the severity, the known issues. You decide what to rewrite.</p>`,
        })}
      </section>

      <section class="tpl-block" aria-labelledby="sources">
        <h2 id="sources">Sources</h2>
        <p class="tpl-block__lede">Primary sources only, read on ${CHECKED.label}. Rules change. Read the programme page on the day you submit.</p>
        ${sourceList(platform.sources)}
      </section>

      <nav class="tpl-next" aria-label="Other templates">
        <p class="meta">Other templates</p>
        <ul>
          ${others.map((other) => html`<li><a href="${other.path}">${other.name}</a></li>`)}
          <li><a href="/templates/foundry-poc">Foundry PoC</a></li>
          <li><a href="/templates">All templates</a></li>
        </ul>
      </nav>
    </div>
  </div>
</div>`;

  return {
    path: platform.path,
    title: platform.title,
    description: platform.description,
    label: `${platform.name} template`,
    styles: ['/css/templates.css'],
    scripts: ['/templates/template.mjs'],
    jsonld: [
      breadcrumbsLd([
        { name: 'Report templates', path: '/templates' },
        { name: platform.name, path: platform.path },
      ]),
    ],
    lastmod: CHECKED.iso,
    body,
  };
}

export default PLATFORMS.map(platformPage);
