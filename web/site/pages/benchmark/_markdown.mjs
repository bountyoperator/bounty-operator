// bench/METHOD.md rendered at build time, the way /changelog renders
// CHANGELOG.md: read the file when the site is generated, understand the
// subset of Markdown it uses, emit components. No default export.
//
//   # Title                       the page title
//   ## Heading                    a section of the page (and an entry of "On this page")
//   ### Heading                   a sub-heading inside a section
//   paragraph lines               a paragraph
//   - item / 1. item              lists; an indented marker opens a nested list
//   | a | b |  + |---|             a table
//   ```lang ... ```               a code block with a copy button
//   > quote                       a block quote
//   <!-- … -->                    dropped (the generated blocks are fenced by comments)
//   `code` **bold** [text](url)   inline
//
// Repository paths: a link to a relative path, and the first `code` span on
// the page that names a public file of bench/ (protocol.json,
// prompts/answer-sheet.md, tools/select.mjs ...), point at that file in the
// public repository. Held material (private/, runs/, verify/) is never linked.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeBlock, html, table } from '../../components.mjs';
import { SITE } from '../../layout.mjs';

const REPO_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const BENCH_DIR = path.join(REPO_DIR, 'bench');
export const BLOB = `${SITE.source}/blob/main`;

/** Paths under bench/ that hold material that is never published. */
const HELD = /^(?:private|runs|verify|cases)(?:\/|$)|(?:^|\/)\.|benchmark\.env/;

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The repository URL of a path named in METHOD.md, or null. `bench/`-relative
 * paths first, then `web/public/` paths from the repository root.
 */
export function repoLink(name) {
  const clean = String(name).trim().replace(/^\.\//, '');
  if (!clean || /[<>*\s]/.test(clean) || clean.includes('..') || !/[./]/.test(clean)) return null;
  if (!HELD.test(clean) && isFile(path.join(BENCH_DIR, clean))) return `${BLOB}/bench/${clean}`;
  if (/^web\/public\/[\w./-]+$/.test(clean) && isFile(path.join(REPO_DIR, clean))) return `${BLOB}/${clean}`;
  return null;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function externalLink(href, content) {
  return html`<a href="${href}" target="_blank" rel="noopener noreferrer">${content}</a>`;
}

/**
 * Inline Markdown to markup. `linked` remembers which repository paths were
 * already linked on this page, so a path is linked once.
 */
export function renderInline(text, linked = new Set()) {
  const out = [];
  const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > last) out.push(html`${text.slice(last, match.index)}`);
    last = match.index + match[0].length;
    if (match[1] !== undefined) {
      const code = match[1];
      const href = linked.has(code) ? null : repoLink(code);
      if (href) {
        linked.add(code);
        out.push(externalLink(href, html`<code>${code}</code>`));
      } else {
        out.push(html`<code>${code}</code>`);
      }
    } else if (match[2] !== undefined) {
      const label = renderInline(match[2], linked);
      const target = match[3];
      if (/^https?:\/\//.test(target)) out.push(externalLink(target, label));
      else if (target.startsWith('#')) out.push(html`<a href="#${slugify(target.slice(1))}">${label}</a>`);
      else {
        const href = repoLink(target.split('#')[0]);
        out.push(href ? externalLink(href, label) : label);
      }
    } else {
      out.push(html`<strong>${renderInline(match[4], linked)}</strong>`);
    }
  }
  if (last < text.length) out.push(html`${text.slice(last)}`);
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const indentOf = (line) => /^\s*/.exec(line)[0].length;
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableRule = (line) => /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
const cellsOf = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());

/** Lines of one list (and everything nested in it) into a tree of items. */
function parseList(lines) {
  const base = indentOf(lines[0]);
  const ordered = /\d/.test(LIST_ITEM.exec(lines[0])[2]);
  const start = ordered ? Number.parseInt(LIST_ITEM.exec(lines[0])[2], 10) : 1;
  const items = [];
  for (const line of lines) {
    const marker = LIST_ITEM.exec(line);
    if (marker && marker[1].length === base) {
      items.push({ text: [marker[3].trim()], children: [] });
    } else if (items.length) {
      const item = items.at(-1);
      if (marker || item.children.length) item.children.push(line);
      else item.text.push(line.trim());
    }
  }
  return { ordered, start, items };
}

function renderList(lines, linked) {
  const { ordered, start, items } = parseList(lines);
  const body = items.map((item) => {
    const nested = item.children.filter((line) => line.trim());
    return html`<li>${renderInline(item.text.join(' '), linked)}${nested.length ? renderList(nested, linked) : ''}</li>`;
  });
  if (!ordered) return html`<ul>${body}</ul>`;
  return start === 1 ? html`<ol>${body}</ol>` : html`<ol start="${start}">${body}</ol>`;
}

function renderTable(rows, linked, label) {
  const [head, ...body] = rows;
  return table({
    columns: head.map((cell) => ({ label: renderInline(cell, linked) })),
    rows: body.map((row) => head.map((_, index) => renderInline(row[index] ?? '', linked))),
    dense: true,
    label,
    className: 'md-table',
  });
}

/**
 * Split the lines of one section into blocks and render them.
 * `context` names the section, for the accessible name of tables and code.
 */
function renderBlocks(lines, linked, context, ids) {
  const out = [];
  let index = 0;
  let tables = 0;
  let codes = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
      index += 1;
      codes += 1;
      out.push(codeBlock({ code: code.join('\n'), numbers: false, copy: true, label: `${context}: ${fence[1] ? `${fence[1].toUpperCase()} ` : ''}example ${codes}`, className: 'md-code' }));
      continue;
    }
    const heading = /^###\s+(.*)$/.exec(line);
    if (heading) {
      let id = slugify(heading[1]);
      while (ids.has(id)) id = `${id}-2`;
      ids.add(id);
      out.push(html`<h3 id="${id}">${renderInline(heading[1], linked)}</h3>`);
      index += 1;
      continue;
    }
    if (isTableRow(line) && isTableRule(lines[index + 1] ?? '')) {
      const rows = [cellsOf(line)];
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) rows.push(cellsOf(lines[index++]));
      tables += 1;
      out.push(renderTable(rows, linked, `${context}: table ${tables}`));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      out.push(html`<blockquote><p>${renderInline(quote.join(' ').trim(), linked)}</p></blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = [];
      while (index < lines.length) {
        const current = lines[index];
        if (current.trim()) {
          if (LIST_ITEM.test(current) || /^\s+\S/.test(current)) list.push(current);
          else break;
        } else {
          // A blank line ends the list unless the list goes on after it.
          const next = lines.slice(index + 1).find((entry) => entry.trim());
          if (!next || !(LIST_ITEM.test(next) || /^\s+\S/.test(next))) break;
        }
        index += 1;
      }
      out.push(renderList(list, linked));
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*```/.test(lines[index]) &&
      !/^#{2,3}\s/.test(lines[index]) &&
      !(isTableRow(lines[index]) && isTableRule(lines[index + 1] ?? '')) &&
      !/^\s*>/.test(lines[index]) &&
      !(paragraph.length && LIST_ITEM.test(lines[index]))
    ) {
      paragraph.push(lines[index++].trim());
    }
    if (!paragraph.length) {
      paragraph.push(lines[index++].trim());
    }
    out.push(html`<p>${renderInline(paragraph.join(' '), linked)}</p>`);
  }
  return out;
}

/**
 * METHOD.md -> { title, intro, sections: [{ id, title, body }], text }
 * `intro` is what stands between the title and the first section.
 */
export function renderMethod(markdown) {
  const text = String(markdown).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split('\n');
  const linked = new Set();
  const ids = new Set();
  let title = null;
  const intro = [];
  const sections = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h1 = !inFence && /^#\s+(.*)$/.exec(line);
    const h2 = !inFence && /^##\s+(.*)$/.exec(line);
    if (h1 && title === null) title = h1[1].trim();
    else if (h2) {
      let id = slugify(h2[1]);
      while (ids.has(id)) id = `${id}-2`;
      ids.add(id);
      sections.push({ id, title: h2[1].trim(), lines: [] });
    } else if (sections.length) sections.at(-1).lines.push(line);
    else intro.push(line);
  }
  return {
    title,
    intro: renderBlocks(intro, linked, 'Introduction', ids),
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      body: renderBlocks(section.lines, linked, section.title, ids),
    })),
  };
}

/** One sentence of METHOD.md that starts with `prefix`, as plain text (code marks removed), or null. */
export function methodSentence(markdown, prefix) {
  const line = String(markdown).split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  return line ? line.replace(/`/g, '').trim() : null;
}
