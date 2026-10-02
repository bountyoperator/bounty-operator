// Rendering helpers shared by the report-template pages.
//
// No default export: the generator skips this module. `toMarkdown` is also
// used by write-md.mjs and by web/tests/templates.test.mjs, so the page, the
// "Copy as Markdown" source and the downloadable file cannot drift apart.

import { breadcrumbs, button, chip, codeBlock, cx, disclosure, field, html, icon, link, notice, textarea } from '../../components.mjs';
import { CHECKED } from './data.mjs';

const SITE_ORIGIN = 'https://bountyoperator.com';

// ---------------------------------------------------------------------------
// Inline text: `code` and {placeholders}
// ---------------------------------------------------------------------------

function withSlots(text) {
  const parts = String(text).split(/\{([^{}\n]+)\}/);
  return parts.map((part, index) => (index % 2 === 1 ? html`<span class="slot">${part}</span>` : html`${part}`));
}

/** Escape text, turn `spans` into <code> and {placeholders} into amber slots. */
export function rich(text) {
  const parts = String(text).split(/`([^`\n]+)`/);
  return parts.map((part, index) => (index % 2 === 1 ? html`<code>${withSlots(part)}</code>` : withSlots(part)));
}

/** Escape text and turn `spans` into <code>. Placeholders are left as written. */
export function plain(text) {
  const parts = String(text).split(/`([^`\n]+)`/);
  return parts.map((part, index) => (index % 2 === 1 ? html`<code>${part}</code>` : html`${part}`));
}

// ---------------------------------------------------------------------------
// Template body: the Markdown subset used in data.mjs
// ---------------------------------------------------------------------------

/** Render a template body (paragraphs, lists, fenced code) as HTML. */
export function renderBody(source) {
  const lines = String(source).split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(codeBlock({ code: code.join('\n'), numbers: false, wrap: true, label: language ? `Code: ${language}` : 'Code', className: 'tpl__code' }));
      continue;
    }
    if (/^- /.test(line)) {
      const items = [];
      while (index < lines.length && /^- /.test(lines[index])) {
        items.push(lines[index].slice(2));
        index += 1;
      }
      blocks.push(html`<ul class="tpl__list">${items.map((item) => html`<li>${rich(item)}</li>`)}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\. /.test(lines[index])) {
        items.push(lines[index].replace(/^\d+\. /, ''));
        index += 1;
      }
      blocks.push(html`<ol class="steps tpl__steps">${items.map((item) => html`<li>${rich(item)}</li>`)}</ol>`);
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(```|- |\d+\. )/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(html`<p>${rich(paragraph.join(' '))}</p>`);
  }
  return blocks;
}

/** The downloadable Markdown for one platform template. */
export function toMarkdown(platform) {
  const out = [
    `> ${platform.name} report template from ${SITE_ORIGIN}${platform.path}. Platform rules checked ${CHECKED.label}.`,
    '> Replace every {placeholder}. Delete this note before you submit.',
    '',
  ];
  const marks = '#'.repeat(platform.headingLevel ?? 2);
  for (const section of platform.sections) {
    if (section.id === 'title') out.push(`# ${section.body}`, '');
    else out.push(`${marks} ${section.heading}`, '', section.body, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Page pieces
// ---------------------------------------------------------------------------

const ORIGIN_LABEL = { platform: 'Platform', added: 'Added' };

export function originChip(origin) {
  return origin === 'platform' ? chip(ORIGIN_LABEL.platform, { tone: 'observed' }) : chip(ORIGIN_LABEL.added, { dashed: true });
}

/** The two action buttons under a page heading. */
export function templateActions({ copyLabel = 'Copy as Markdown', file, download, downloadLabel = 'Download .md' }) {
  return html`<div class="cluster tpl-actions">
    ${button({ label: copyLabel, variant: 'primary', icon: 'copy', attrs: { 'data-template-copy': true } })}
    ${button({ label: downloadLabel, href: `/templates/${file}`, icon: 'download', attrs: { download } })}
    <span class="tpl-actions__status" role="status" data-template-status></span>
  </div>`;
}

/** The template as a ledger: one row per report section. */
export function templateArticle(platform) {
  const markdown = toMarkdown(platform);
  const rows = platform.sections.map((section, index) => {
    const number = String(index + 1).padStart(2, '0');
    return html`<section class="tpl__section" id="s-${section.id}" data-origin="${section.origin}">
      <div class="tpl__label"><span class="tpl__n">${number}</span>${originChip(section.origin)}</div>
      <div class="tpl__content">
        <h3 class="tpl__heading">${section.heading}</h3>
        <p class="tpl__rule">${plain(section.rule)}</p>
        <div class="tpl__fill">${renderBody(section.body)}</div>
      </div>
    </section>`;
  });

  return html`<article class="tpl" aria-labelledby="template">
    <div class="tpl__bar">${icon('file')}<span class="tpl__file">${platform.file}</span><span class="tpl__tag">${platform.sections.length} sections</span></div>
    ${rows}
    <div class="tpl__source" data-template-source>
      ${disclosure({
        summary: 'Markdown source',
        hint: platform.file,
        body: codeBlock({ code: markdown, name: platform.file, numbers: false, wrap: true, copy: true, label: `Markdown source: ${platform.file}` }),
      })}
    </div>
  </article>`;
}

/** "What gets this closed": numbered reasons, each tied to its sources. */
export function closedList(platform) {
  const byId = new Map(platform.sources.map((source) => [source.id, source]));
  const sourceLink = (id) => {
    const source = byId.get(id);
    if (!source) throw new Error(`${platform.id}: unknown source "${id}"`);
    // No arrow icon here: in a wrapped list of references it lands alone on a line.
    return html`<a class="link" href="${source.href}" target="_blank" rel="noopener noreferrer">${source.label}</a>`;
  };
  const items = platform.closed.map((item) => {
    const refs = item.sources.map((id, index) => html`${index > 0 ? ', ' : ''}${sourceLink(id)}`);
    const quote = item.quote
      ? html`<blockquote class="closed__quote"><p>${item.quote.text}</p><footer>${byId.get(item.quote.source)?.label}, ${platform.name}</footer></blockquote>`
      : '';
    return html`<li class="closed__item">
      <h3 class="closed__title">${item.title}</h3>
      <p>${plain(item.body)}</p>${quote}
      <p class="closed__refs"><span class="meta">Source</span> ${refs}</p>
    </li>`;
  });
  return html`<ol class="closed">${items}</ol>`;
}

/** The primary sources, each with the date it was read. */
export function sourceList(sources) {
  const items = sources.map(
    (source) => html`<li class="sources__item">
      <p class="sources__link">${link({ label: source.label, href: source.href, external: true })}</p>
      <p class="sources__note">${source.note}</p>
      <p class="sources__date meta">${source.dated ? `${source.dated} · ` : ''}checked ${CHECKED.label}</p>
    </li>`,
  );
  return html`<ul class="sources">${items}</ul>`;
}

/**
 * The call to action: paste the filled draft, send it to the workbench.
 * The link works without script. With script, /templates/template.mjs writes
 * the handoff to sessionStorage and opens the workbench.
 */
export function checkDraft({ id = 'draft', profile, focus, fileName, note, label, placeholder, primary, secondary, intro, markers = 'slots' }) {
  return html`<div class="tpl-check" data-handoff data-handoff-profile="${profile}" data-handoff-focus="${focus}" data-handoff-name="${fileName}" data-handoff-note="${note}" data-handoff-markers="${markers}">
    ${intro}
    ${field({
      label,
      for: id,
      control: textarea({ id, rows: 8, mono: true, placeholder, attrs: { spellcheck: 'false', 'data-handoff-input': true, 'aria-describedby': `${id}-help ${id}-state` } }),
      help: 'The draft stays in this browser. It is sent only when you run a review in the workbench.',
    })}
    <p class="tpl-check__state" id="${id}-state" aria-live="polite" data-handoff-state></p>
    ${notice({ tone: 'error', live: true, className: 'tpl-check__error' })}
    <div class="cluster">
      ${button({ label: primary.label, href: primary.href, variant: 'primary', iconEnd: 'arrow-right', attrs: { 'data-handoff-go': true } })}
      ${secondary && button({ label: secondary.label, href: secondary.href })}
    </div>
  </div>`;
}

/** Sticky "on this page" index for the wide layout. */
export function pageIndex(items) {
  return html`<nav class="tpl-toc" aria-label="On this page">
    <p class="meta">On this page</p>
    <ul>${items.map((item) => html`<li><a href="#${item.id}">${item.label}</a></li>`)}</ul>
  </nav>`;
}

/** Every trail starts at the home page, then the hub. On the hub itself the hub crumb is the current page. */
export function crumbs(trail) {
  return breadcrumbs([{ label: 'Bounty Operator', href: '/' }, { label: 'Templates', href: '/templates' }, ...trail]);
}

export { cx };
