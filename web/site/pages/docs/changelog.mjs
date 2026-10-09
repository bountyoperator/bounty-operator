// /changelog — rendered from CHANGELOG.md at build time.
//
// The file at the repository root is the single source. This module reads it
// when the site is generated and understands the subset of Markdown it uses:
//
//   ## 0.7.0 — 2026-10-02      a release: version and ISO date
//   Reviews                     a short line on its own before a list: a group label
//   - item                      a list item; indented lines continue it
//   Any other text              a paragraph
//   <!-- … -->                  a comment, dropped
//   `code`                      inline code

import { readFileSync } from 'node:fs';

import { button, chip, html, inline } from '../../components.mjs';
import { SITE, breadcrumbsLd } from '../../layout.mjs';
import { DOCS_STYLES, docPage, nextStep, time } from './_shared.mjs';

const PATH = '/changelog';
const SOURCE = new URL('../../../../CHANGELOG.md', import.meta.url);
const RELEASE = /^##\s+(\S+)\s+[—–-]\s+(\d{4}-\d{2}-\d{2})\s*$/;

/** Split the text of one release into paragraphs, group labels and lists. */
function parseBlocks(lines) {
  const blocks = [];
  let paragraph = [];
  let list = null;

  const closeParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  const closeList = () => {
    if (list) blocks.push({ type: 'list', items: list });
    list = null;
  };

  for (const line of lines) {
    const item = /^-\s+(.*)$/.exec(line);
    if (item) {
      closeParagraph();
      list ??= [];
      list.push(item[1].trim());
    } else if (!line.trim()) {
      closeParagraph();
      closeList();
    } else if (list && /^\s+\S/.test(line)) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  closeParagraph();
  closeList();

  // A short line with no full stop, directly before a list, labels that list.
  return blocks.map((block, index) => {
    const labelsList = block.type === 'paragraph' && blocks[index + 1]?.type === 'list' && block.text.length <= 40 && !/[.:;,]$/.test(block.text);
    return labelsList ? { type: 'group', text: block.text } : block;
  });
}

/** [{ version, date, blocks }] in file order, newest first. */
export function parseChangelog(markdown) {
  const text = markdown.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const releases = [];
  let current = null;

  for (const line of text.split('\n')) {
    const heading = RELEASE.exec(line);
    if (heading) {
      current = { version: heading[1], date: heading[2], lines: [] };
      releases.push(current);
    } else if (current && !/^#\s/.test(line)) {
      current.lines.push(line);
    }
  }
  return releases.map(({ version, date, lines }) => ({ version, date, blocks: parseBlocks(lines) }));
}

function renderBlock(block) {
  if (block.type === 'group') return html`<h3 class="release__group">${block.text}</h3>`;
  if (block.type === 'list') return html`<ul>${block.items.map((item) => html`<li>${inline(item)}</li>`)}</ul>`;
  return html`<p>${inline(block.text)}</p>`;
}

const releases = parseChangelog(readFileSync(SOURCE, 'utf8'));
if (!releases.length) throw new Error('CHANGELOG.md has no "## <version> — <YYYY-MM-DD>" headings to render.');

const latest = releases[0];

const sections = releases.map((release, index) => ({
  id: `v${release.version.replace(/[^0-9a-z]+/gi, '-')}`,
  label: release.version,
  title: html`${release.version}<span class="release__date">${time(release.date)}</span>${index === 0 && html`<span class="release__latest">${chip('Latest', { tone: 'observed' })}</span>`}`,
  body: release.blocks.map(renderBlock),
}));

const body = docPage({
  head: {
    crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Changelog' }],
    title: 'Bounty Operator changelog',
    lede: html`The current version is ${latest.version}.`,
    meta: html`${releases.length} releases · latest ${time(latest.date)}`,
  },
  sections,
  after: nextStep({
    title: 'Read the open-source code',
    text: 'The site, the review engine with its three core profiles, the free tools, the MCP server and the command-line kit are in one public repository. The gauntlet stages and the panel cross-examination run on the hosted service.',
    actions: html`${button({ label: 'Start a free review', href: '/#workspace', variant: 'primary', iconEnd: 'arrow-right' })}${button({ label: 'Source on GitHub', href: SITE.source, external: true, iconEnd: 'arrow-up-right' })}`,
  }),
});

export default {
  path: PATH,
  title: 'Changelog | Bounty Operator',
  label: 'Changelog',
  description: 'Every Bounty Operator release with its date: what changed in reviews, the site, the MCP server and the command-line kit.',
  styles: DOCS_STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Changelog', path: PATH }])],
  lastmod: latest.date,
  body,
};
