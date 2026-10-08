// Shared pieces of the free-tool pages. No default export, so the generator
// treats this module as a helper and builds no page from it.
//
// Styles: /css/tools.css. Browser modules: /tools/*.mjs.

import { attrs, breadcrumbs, button, cx, html, icon } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { CHECKS as REPORT_CHECKS } from '../../../public/tools/report-check-core.mjs';

export const TOOL_STYLES = ['/css/tools.css'];
export const LASTMOD = '2026-10-03';

/** The one line every tool carries. */
export const LOCAL_LINE = 'Your content never leaves the browser.';

/**
 * What a tool page does send, said once in its questions: the name-only
 * counter of /tools/ping.mjs.
 */
export const COUNTER_LINE = 'After the page has loaded it makes one request: a counter that says the tool was used, with nothing of yours in it.';

/** The tools, in the order the hub and the footer list them. */
export const TOOLS = [
  {
    path: '/tools/report-check',
    name: 'Report check',
    heading: 'Bug bounty report check',
    outcome: 'Check your draft for missing evidence, scope details, common report mistakes and broken file:line citations.',
    input: 'draft + cited files',
    output: `${REPORT_CHECKS.length} checks + citations`,
    icon: 'search',
  },
  {
    path: '/tools/verify',
    name: 'Packet verifier',
    heading: 'Verify a review packet',
    outcome: 'Check that the source files match the hashes in a saved review.',
    input: 'packet + files',
    output: 'hash per file',
    icon: 'hash',
  },
  {
    path: '/tools/secret-check',
    name: 'Secret check',
    heading: 'Check files for secrets',
    outcome: 'Flag common keys, tokens, seed phrases and private report links in your files.',
    input: 'PoC files',
    output: 'file:line hits',
    icon: 'key',
  },
  {
    path: '/tools/acceptance-rates',
    name: 'Acceptance rates',
    heading: 'Which bug classes get accepted',
    outcome: 'Compare acceptance rates for twelve bug classes, with sample sizes.',
    input: '1,032 findings',
    output: 'rate per class',
    icon: 'sort',
  },
  {
    path: '/tools/slither-focus',
    name: 'Slither triage queue',
    heading: 'Slither triage queue',
    outcome: 'Turn Slither JSON into a ranked list for manual review.',
    input: 'slither.json',
    output: 'ranked queue',
    icon: 'terminal',
  },
];

export function tool(path) {
  const found = TOOLS.find((entry) => entry.path === path);
  if (!found) throw new Error(`Unknown tool page ${path}`);
  return found;
}

export function toolCrumbsLd(path) {
  return breadcrumbsLd([{ name: 'Tools', path: '/tools' }, { name: tool(path).name, path }]);
}

/** Every breadcrumb trail on the site starts at the home page. */
export const HOME_CRUMB = { label: 'Bounty Operator', href: '/' };

/** The "your content never leaves the browser" line. */
export function localLine() {
  return html`<p class="tool-local">${icon('lock')}<span>${LOCAL_LINE}</span></p>`;
}

/** Breadcrumbs, the one h1, the lede and the local line. */
export function toolHead({ path, lede }) {
  const entry = tool(path);
  return html`<header class="tool-head page-field">
${breadcrumbs([HOME_CRUMB, { label: 'Tools', href: '/tools' }, { label: entry.name }])}
<h1>${entry.heading}</h1>
<p class="lede">${lede}</p>
${localLine()}
</header>`;
}

/**
 * The frame around the interactive part: the form's head, then the body.
 * The head prints the tool's form number (its place in TOOLS) and name;
 * `tag` is the text at its right edge. `name` names a tool that is not in TOOLS.
 */
export function toolPanel({ id, name, tag = 'Local', body, className }) {
  const index = TOOLS.findIndex((entry) => entry.path === `/tools/${id}`);
  const title = index >= 0 ? TOOLS[index].name : name;
  const form = index >= 0 ? `Form ${String(index + 1).padStart(2, '0')}` : null;
  return html`<div${attrs({ class: cx('tool-panel', className), id })}>
<div class="tool-panel__bar">${form && html`<span class="tool-panel__form">${form}</span>`}<span class="tool-panel__name">${title}</span><span class="tool-panel__tag">${tag}</span></div>
<div class="tool-panel__body">${body}</div>
</div>`;
}

/**
 * A drop zone: a label that wraps a file input, so a click, a tap, the
 * keyboard and a drop all work. The page script adds the drop handling.
 */
export function dropZone({ id, title, hint, multiple = true, accept, folder = false }) {
  const inputAttrs = attrs({ class: 'drop__input', type: 'file', id: `${id}-input`, multiple, accept });
  return html`<div class="drop" id="${id}" data-drop>
<label class="drop__label" for="${id}-input">
${icon('upload')}
<span class="drop__title">${title}</span>
<span class="drop__hint">${hint}</span>
<input${inputAttrs}>
</label>${folder && html`
<label class="drop__folder" for="${id}-folder">${icon('file')}<span>Choose a folder</span><input class="drop__input" type="file" id="${id}-folder" webkitdirectory multiple></label>`}
</div>`;
}

/** A numbered "how it works" strip. steps: [{ title, text }] */
export function stepsStrip(steps) {
  return html`<ol class="tool-steps">${steps.map((step) => html`<li><h3 class="tool-steps__title">${step.title}</h3><p>${step.text}</p></li>`)}</ol>`;
}

/** The other tools, as a compact list under a tool page. */
export function relatedTools(path) {
  const others = TOOLS.filter((entry) => entry.path !== path);
  return html`<section class="section section--tight wrap" aria-labelledby="more-tools">
<h2 class="h3" id="more-tools">More free tools</h2>
<ul class="tool-related">${others.map((entry) => html`<li><a class="tool-related__link" href="${entry.path}"><span class="tool-related__name">${entry.name}${icon('arrow-right')}</span><span class="tool-related__text">${entry.outcome}</span></a></li>`)}</ul>
</section>`;
}

/** The closing action: one sentence, one primary button, one quiet link. */
export function nextAction({ title, text, primary, secondary }) {
  return html`<section class="section section--tight wrap" aria-labelledby="next-action">
<div class="tool-next on-stock">
<div class="tool-next__text">
<h2 class="h3" id="next-action">${title}</h2>
<p>${text}</p>
</div>
<div class="cluster">
${button({ ...primary, variant: 'primary', iconEnd: 'arrow-right' })}
${secondary && button({ ...secondary, variant: 'secondary' })}
</div>
</div>
</section>`;
}
