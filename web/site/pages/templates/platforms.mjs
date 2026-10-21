// /templates/immunefi, /templates/sherlock, /templates/cantina, /templates/hackerone
// and /templates/github-private-vulnerability-report
//
// One page per template, all rendered from data.mjs.

import { chip, closingBand, html } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { TEMPLATES } from './data.mjs';
import { checkDraft, checkedOf, closedList, crumbs, headHandoff, pageIndex, plain, sourceList, templateActions, templateArticle } from './shared.mjs';

// The hand-off at the head and the second one in "Challenge the filled draft"
// went onto every template page on this day.
const HANDOFF_ADDED = '2026-10-15';

const later = (a, b) => (a > b ? a : b);

function platformPage(platform) {
  const others = TEMPLATES.filter((other) => other.id !== platform.id);
  const checked = checkedOf(platform);
  // Who reads the report first: a platform's triager, or a repository's maintainer.
  const reader = platform.reader ?? 'triager';

  const body = html`
<div class="wrap tpl-page">
  <header class="page-head page-field">
    ${crumbs([{ label: platform.name }])}
    <h1>${platform.h1}</h1>
    <p class="lede">${platform.lede}</p>
    ${templateActions({
      file: platform.file,
      download: platform.download,
      copied: 'Copied. Once it is filled in, paste it under Challenge the filled draft for a free check before you submit.',
    })}
    ${headHandoff({
      text: `Bounty Operator checks the draft against the code you add, including counterarguments a ${reader} could raise. Supported claims are confirmed and missing evidence is identified. Free in ChatGPT or Claude with no account, or once a day on your own AI key with a free account.`,
      label: 'Challenge my draft',
    })}
    <p class="meta">Rules checked ${checked.label} · ${platform.sources.length} sources</p>
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
        <p class="tpl-block__lede">${platform.closedNote ?? html`Each reason comes from a page ${platform.name} publishes. The programme or contest page adds its own rules on top, and those win.`}</p>
        ${closedList(platform)}
      </section>

      <section class="tpl-block" aria-labelledby="check">
        <h2 id="check">Challenge the filled draft</h2>
        ${checkDraft({
          profile: 'report',
          focus: platform.focus,
          fileName: `${platform.id}-report-draft.md`,
          note: `Draft written from the ${platform.h1} at bountyoperator.com${platform.path}. Platform rules checked ${checked.label}.`,
          label: 'Your filled draft',
          placeholder: 'Paste the report with every placeholder replaced.',
          primary: { label: 'Challenge this draft', href: '/?profile=report#workspace' },
          secondary: { label: 'Run the report check', href: '/tools/report-check' },
          more: {
            text: html`<a class="link" href="/triager-simulation">Triager simulation</a> ranks the three reasons a ${reader} would close this report. It needs a free account: one passkey prompt, no email, no card.`,
            label: 'Run the Triager simulation',
            href: '/?profile=triage#workspace',
            profile: 'triage',
            focus: `${platform.h1.replace(/ template$/, '')} draft. Act as the ${reader} who reads it first: give the three likeliest reasons to close this report and the evidence that flips each one.`,
          },
          intro: html`<p class="tpl-block__lede">Paste the report once every placeholder is replaced. The button below opens a review with <a class="link" href="/challenge-report">Challenge a draft report</a> selected. It checks the evidence for each claim: the impact row, the proof, the severity, the known issues. Supported claims are confirmed; gaps and counterarguments show what still needs work. You decide what to rewrite.</p>`,
        })}
      </section>

      <section class="tpl-block" aria-labelledby="sources">
        <h2 id="sources">Sources</h2>
        <p class="tpl-block__lede">${platform.sourcesLede ?? `Primary sources only, read on ${checked.label}. Rules change. Read the programme page on the day you submit.`}</p>
        ${platform.sourcesNote && html`<p class="tpl-block__lede">${platform.sourcesNote}</p>`}
        ${sourceList(
          platform.sources.map((source) => ({ ...source, note: html`${plain(source.note)}` })),
          { checked: checked.label },
        )}
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

  ${closingBand({
    title: 'Check the filled draft before you submit',
    text: html`Paste it under <a class="link" href="#check">Challenge the filled draft</a>. The review marks each claim confirmed, overstated, contradicted or unverifiable, with the line that decides it.`,
    actions: [
      { label: 'Challenge my draft', href: '#check' },
      { label: 'Run the report check', href: '/tools/report-check' },
    ],
  })}
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
    lastmod: later(platform.lastmod ?? checked.iso, HANDOFF_ADDED),
    body,
  };
}

export default TEMPLATES.map(platformPage);
