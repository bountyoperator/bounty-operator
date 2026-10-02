// Reads a review written in the Bounty Operator output format back into data,
// checks its code references against the manifest, and neutralises markup in
// model output before it leaves the page.
//
// This module has no imports: the browser, the Worker, the MCP server and the
// benchmark all load it.

/**
 * @typedef {{ label: string, start: number, end: number }} Ref
 * @typedef {{ critical: number, high: number, medium: number, hardening: number, checkedSafe: number }} Counts
 * @typedef {object} ParsedFinding
 * @property {string} id
 * @property {string} title
 * @property {string} severity
 * @property {string} basis
 * @property {Ref[]} locations
 * @property {string} impact
 * @property {string[]} path
 * @property {number} pathStart  The number the review gave the first step: 6 for a Path that runs "6." and "7.". 1 for a list without numbers.
 * @property {{ objection: string, status: string, why: string }} counterargument
 * @property {string} gap
 * @property {string} fix
 * @property {string} test
 * @property {string} next
 * @typedef {{ title: string, rows: string[][] | null, text: string, lead: string, tail: string }} ParsedSection
 *   `lead` and `tail` are the lines of a section with rows that are not rows: what stands before the first row, and what follows it.
 * @typedef {object} ParsedReview
 * @property {boolean} ok
 * @property {string} verdict
 * @property {string} mode
 * @property {Counts} counts
 * @property {{ [K in keyof Counts]: number | null } | null} statedCounts
 * @property {string} headline
 * @property {ParsedFinding[]} findings
 * @property {ParsedSection[]} sections
 * @property {string} raw
 * @typedef {{ ref: Ref, problem: 'unknown-file' | 'line-out-of-range' }} RefProblem
 */

export const VERDICTS = Object.freeze({
  bounty: Object.freeze(['submit', 'rewrite-then-submit', 'prove-first', 'hold-duplicate', 'drop']),
  'own-code': Object.freeze(['fix-before-deploy', 'no-blocking-issues']),
});

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium']);

export const BASES = Object.freeze(['proven-in-source', 'needs-test', 'depends-on-unsupplied-code']);

const HEADER_FIELDS = ['verdict', 'mode', 'counts', 'headline'];

const FINDING_FIELDS = [
  'severity', 'basis', 'location', 'impact', 'path',
  'counterargument', 'gap', 'fix', 'test', 'next',
];

// Labels models write in place of the ones in the format.
const FIELD_ALIASES = Object.freeze({
  'final verdict': 'verdict',
  'overall verdict': 'verdict',
  locations: 'location',
  'counter-argument': 'counterargument',
  'counter argument': 'counterargument',
  'attack path': 'path',
  'regression test': 'test',
  'next step': 'next',
  'next steps': 'next',
});

const HEADING = /^ {0,3}(#{1,6})(?!#)(.*)$/;

// A finding title written as a bold line instead of a heading: "**F-1: title**".
const BOLD_FINDING = /^ {0,3}\*\*\s*(\[?(?:F[-\u2012-\u2015]?|Finding\s+#?)\d{1,3}\b.*)\*\*\s*$/i;

// A header field written as a heading: "## Verdict: submit".
const HEADER_HEADING = /^(verdict|mode|counts|headline)\b\s*[:\uff1a]?\s*(.*)$/i;

const REVIEW_TITLE = /^review\b/i;

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

// A fence that holds a Markdown document, such as the report editor's cleaned report.
const MARKDOWN_INFO = /^(?:markdown|md)\b/i;

// A field label that carries its opening fence on the same line ("Test: ```solidity").
const INLINE_FENCE = /^(\s*(?:[-*+]\s+)?[*_]{0,3}[A-Za-z][A-Za-z -]{0,24}[*_]{0,3}\s*[:\uff1a][*_]{0,3}\s*)(`{3,}[^`]*)$/;

// "F-1: title", and the spellings models drift to: "F1 - title", "[F-1] title", "Finding #1: title".
const FINDING_TITLE = /^\[?(?:F[-\u2012-\u2015]?|Finding\s+#?)(\d{1,3})\]?\s*(?:[^\w\s([]\s*)?(.*)$/i;

// "Severity: high", "**Severity:** high", "- _Severity_: high".
const FIELD_LINE = /^\s*(?:[-*+]\s+)?[*_]{0,3}([A-Za-z][A-Za-z -]{0,24}?)[*_]{0,3}\s*[:\uff1a][*_]{0,3}\s*(.*)$/;

// "1. step", "2) step", "- step", "**3.** step", "Step 4: step".
const LIST_ITEM = /^(?:\*{0,2}(?:step\s+)?\d{1,3}\*{0,2}[.):]\*{0,2}|[-*+])\s+(.*)$/i;
// The number of a numbered item.
const ITEM_NUMBER = /^\*{0,2}(?:step\s+)?(\d{1,3})\*{0,2}[.):]/i;

// U+2010 hyphen and U+2011 non-breaking hyphen. Some chat models write every
// hyphen as one of them, in "fix-before-deploy" and in "input-1/Vault.sol"
// alike. Neither is ever meant as anything but "-".
const SOFT_HYPHENS = /[\u2010\u2011]/g;
// Figure dash, en dash, em dash, horizontal bar and minus sign, inside a fixed value.
const DASHES = /[\u2012-\u2015\u2212]/g;

// Characters that cannot appear in a cited label. Bounded quantifiers keep the scan linear.
const LABEL_CHARS = '[^\\s:;|,()\\[\\]{}<>`\'"*]';
const LINE_NUMBER = '(\\d{1,9})(?!\\d)';
// ":64", ":64-67", ":L64-L67", "#L64-L67", with the label optionally closed by "`" or "**".
const LINE_RANGE = `[\`*]{0,3}(?::L?|#L)${LINE_NUMBER}(?:\\s?[-\\u2012-\\u2015]\\s?L?${LINE_NUMBER})?`;
// Further ranges after the first, as in ":64-67,90,120-125".
const MORE_RANGES = '((?:,L?\\d{1,9}(?!\\d)(?:[-\\u2012-\\u2015]L?\\d{1,9}(?!\\d))?)*)';
const TAIL_RANGE = /,L?(\d{1,9})(?:[-\u2012-\u2015]L?(\d{1,9}))?/g;
const GENERIC_REF = `input-\\d{1,3}\\/${LABEL_CHARS}{1,300}`;
const INPUT_PREFIX = /^input-\d{1,3}\//;
// A reference never starts in the middle of a longer path or word.
const REF_START = '(?<![A-Za-z0-9_./-])';
// A file cited without its input-N/ prefix: "src/Vault.sol:64".
const BARE_PATH = '[A-Za-z0-9_./-]{3,300}';
const BARE_PATH_ONLY = new RegExp(`^${BARE_PATH}$`);
const BARE_REF = new RegExp(`${REF_START}(${BARE_PATH})${LINE_RANGE}${MORE_RANGES}`, 'g');

// Characters that render as nothing or reorder the text around them: soft
// hyphen, zero-width characters and joiners, line and paragraph separators,
// bidi marks, embeddings, overrides and isolates, annotation anchors and tags.
const HIDDEN_CLASS = '[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}]';
const HIDDEN_CHARS = new RegExp(HIDDEN_CLASS, 'gu');
const HIDDEN_CHAR = new RegExp(HIDDEN_CLASS, 'u');

const ROW_BULLET = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const EMPTY_VALUE = /^(?:none|nothing|n\/a|not applicable)\.?$/i;
// A cell separator in a row written without spaces, or in a table: a single unescaped pipe.
const TIGHT_PIPE = /(?<![\\|])\|(?!\|)/;

const SCRIPT_SCHEME = /^(?:javascript|vbscript|data|file):/i;

const QUOTE_LINE = /^ {0,3}>/;
// "[" at the head of a line, with no other unescaped bracket after it on that line.
const UNCLOSED_BRACKET = /^( {0,3})\[(?=(?:\\[[\]]|[^[\]])*$)/;
// Markdown's own definition of a blank line: other whitespace characters are text.
const BLANK_LINE = /^[ \t]*$/;

function openFence([, indent, marker, info], nestMarkdown) {
  // The info string of a backtick fence cannot contain a backtick.
  if (marker[0] === '`' && info.includes('`')) return null;
  return {
    char: marker[0],
    length: marker.length,
    indent: indent.length,
    depth: 1,
    nests: nestMarkdown && MARKDOWN_INFO.test(info.trim()),
  };
}

/** Applies one fence line to the open block and reports whether it closed the block. */
function closeFence(open, [, , marker, info]) {
  if (marker[0] !== open.char || marker.length < open.length) return false;
  if (info.trim() === '') {
    open.depth -= 1;
    return open.depth === 0;
  }
  if (open.nests && !info.includes('`')) open.depth += 1;
  return false;
}

/**
 * Tags every line as code or prose using CommonMark fence rules. An unclosed
 * fence runs to the end, exactly as a Markdown renderer treats it. Code lines
 * carry the fence that opened their block: its character, length and indent.
 *
 * `nestMarkdown` is for reading a review, never for rendering one. Inside a
 * fence labelled markdown, a labelled fence of the same length starts an inner
 * block: that is what a model writes when it wraps a report that contains code
 * and forgets to lengthen the outer fence.
 */
function tagLines(text, { splitInlineFences = false, nestMarkdown = false } = {}) {
  const tagged = [];
  let open = null;

  for (const original of text.split('\n')) {
    const pending = [original];
    if (splitInlineFences && !open) {
      const inline = original.match(INLINE_FENCE);
      if (inline) pending.splice(0, 1, inline[1].trimEnd(), inline[2]);
    }

    for (const line of pending) {
      const fence = line.match(FENCE);
      if (!open) {
        open = fence ? openFence(fence, nestMarkdown) : null;
        const opened = Boolean(open);
        tagged.push({ line, code: opened, fence: opened, opens: opened, indent: open ? open.indent : 0 });
        continue;
      }
      const closed = fence ? closeFence(open, fence) : false;
      tagged.push({ line, code: true, fence: closed, opens: false, indent: open.indent, char: open.char, length: open.length });
      if (closed) open = null;
    }
  }

  return { lines: tagged, unclosed: open };
}

/** Drops chat preamble and a wrapping code fence so parsing starts at "# Review". */
function reviewBody(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').replace(HIDDEN_CHARS, '').replace(SOFT_HYPHENS, '-').split('\n');
  let start = lines.findIndex((line) => /^#{1,3}\s+Review\b/i.test(line.trim()));
  if (start === -1) start = lines.findIndex((line) => /^[*_]{0,3}(?:Final\s+)?Verdict[*_]{0,3}\s*[:\uff1a]/i.test(line.trim()));
  if (start === -1) return lines.join('\n');

  const before = lines.slice(0, start).filter((line) => line.trim());
  const wrapped = before.length > 0 && FENCE.test(before[before.length - 1]);
  const body = lines.slice(start);

  if (wrapped) {
    let last = body.length - 1;
    while (last >= 0 && !body[last].trim()) last -= 1;
    if (last >= 0 && FENCE.test(body[last]) && body[last].trim().replace(/[`~]/g, '') === '') {
      body.length = last;
    }
  }
  return body.join('\n');
}

/** The text of a heading without closing hashes, emphasis marks or a trailing colon. */
function headingTitle(text) {
  const trimmed = text.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === '#') end -= 1;
  const title = trimmed.slice(0, end).replaceAll('*', '').trim();
  return title.endsWith(':') ? title.slice(0, -1).trimEnd() : title;
}

/** `{ level, title }` for a heading line, or null. A bold finding title counts as the deepest level. */
function headingOf(entry) {
  if (entry.code) return null;

  const match = entry.line.match(HEADING);
  if (match) {
    const level = match[1].length;
    // "#tag" is a tag, not a heading.
    if (level === 1 && !/^\s/.test(match[2])) return null;
    const title = headingTitle(match[2]);
    return title ? { level, title } : null;
  }

  const bold = entry.line.match(BOLD_FINDING);
  return bold ? { level: 7, title: headingTitle(bold[1]) } : null;
}

/**
 * The heading level that separates sections. The format uses level 2. A reply
 * that has no level-2 heading at all was shifted as a whole ("### Hardening"
 * under "## Review"), so its shallowest level takes that role.
 */
function sectionLevel(headings) {
  let shallowest = 7;
  for (const heading of headings) {
    if (!heading) continue;
    if (heading.level === 2) return 2;
    if (heading.level < shallowest) shallowest = heading.level;
  }
  return shallowest === 7 ? 2 : shallowest;
}

function splitSections(tagged) {
  const head = [];
  const sections = [];
  let current = null;

  const headings = tagged.map(headingOf);
  // The review's own title is not a section.
  if (headings[0] && REVIEW_TITLE.test(headings[0].title)) headings[0] = null;
  const boundary = sectionLevel(headings.filter((heading) => heading && !HEADER_HEADING.test(heading.title)));

  tagged.forEach((entry, index) => {
    const heading = headings[index];
    const header = heading && !sections.length ? heading.title.match(HEADER_HEADING) : null;
    const isFinding = Boolean(heading) && FINDING_TITLE.test(heading.title);

    if (header) {
      head.push({ line: `${header[1]}: ${header[2]}`, code: false, fence: false });
    } else if (heading && (heading.level === boundary || (isFinding && heading.level > boundary))) {
      // Sections sit at one level; a finding is also accepted at any deeper level.
      current = { title: heading.title, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(entry);
    } else {
      head.push(entry);
    }
  });
  return { head, sections };
}

/** Groups lines under the known field label that precedes them. */
function readFields(tagged, known) {
  const fields = new Map();
  let active = null;

  for (const entry of tagged) {
    const match = entry.code ? null : entry.line.match(FIELD_LINE);
    const label = match ? match[1].trim().toLowerCase() : '';
    const key = Object.hasOwn(FIELD_ALIASES, label) ? FIELD_ALIASES[label] : label;
    if (match && known.includes(key)) {
      active = [{ line: match[2], code: false, fence: false }];
      if (!fields.has(key)) fields.set(key, active);
    } else if (active) {
      active.push(entry);
    }
  }
  return fields;
}

/**
 * A field's value as one line: its first paragraph, with wrapped lines joined.
 * Whatever follows a blank line is commentary, not part of the field.
 */
function inlineText(entries) {
  if (!entries) return '';
  const parts = [];
  for (const entry of entries) {
    if (entry.code) continue;
    const text = entry.line.trim();
    if (text) parts.push(text);
    else if (parts.length) break;
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** `text`, or '' when it only says that there is nothing: "none", "None.", "N/A". */
function unlessNone(text) {
  return EMPTY_VALUE.test(text.trim()) ? '' : text;
}

function codeText(entries) {
  if (!entries) return '';
  const code = entries.filter((entry) => entry.code && !entry.fence).map((entry) => entry.line);
  return code.length ? code.join('\n') : unlessNone(inlineText(entries));
}

function listItems(entries) {
  if (!entries) return [];
  const items = [];
  let afterBlank = false;
  for (const entry of entries) {
    if (entry.code) continue;
    const text = entry.line.trim();
    if (!text) {
      afterBlank = true;
      continue;
    }
    const item = text.match(LIST_ITEM);
    if (item) {
      items.push(item[1].trim());
    } else if (!items.length) {
      if (unlessNone(text)) items.push(text);
    } else if (afterBlank) {
      // A paragraph after the list is commentary, not another step.
      break;
    } else {
      items[items.length - 1] += ` ${text}`;
    }
    afterBlank = false;
  }
  return items;
}

/**
 * The number the first item of a list carries, so that steps written "6." and
 * "7." are shown as 6 and 7. 1 when the list is not numbered or starts at 0.
 */
function listStart(entries) {
  if (!entries) return 1;
  for (const entry of entries) {
    if (entry.code) continue;
    const text = entry.line.trim();
    if (!text) continue;
    const number = Number(text.match(ITEM_NUMBER)?.[1] ?? 1);
    return number >= 1 ? number : 1;
  }
  return 1;
}

/** `text` without leading and trailing `char`, in one pass. */
function trimChar(text, char) {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === char) start += 1;
  while (end > start && text[end - 1] === char) end -= 1;
  return text.slice(start, end);
}

/** An enum value as models decorate it: `**High**`, `"open"`, `<submit>`, `rewrite_then_submit`. */
function plainToken(value) {
  const bare = value.replace(/[*`"'<>[\]]/g, '').replace(DASHES, '-').replaceAll('_', '-').trim();
  return trimChar(bare, '-').trim().toLowerCase();
}

function matchEnum(value, allowed) {
  const token = plainToken(value);
  const dashed = token.replace(/\s+/g, '-');
  const startsWith = (candidate) => (text) => text === candidate
    || (text.startsWith(candidate) && !/[a-z-]/.test(text[candidate.length]));
  // Longest first, so "rewrite-then-submit" is never read as "submit".
  const ordered = [...allowed].sort((a, b) => b.length - a.length);
  return ordered.find((candidate) => startsWith(candidate)(token) || startsWith(candidate)(dashed)) || '';
}

/** The verdict on the Verdict line, or '' when the line names none or offers a choice of two. */
function readVerdict(text) {
  const allowed = [...VERDICTS.bounty, ...VERDICTS['own-code']];
  const verdict = matchEnum(text, allowed);
  if (!verdict) return '';

  // "submit or drop" is not a decision. The second value follows the first directly.
  const rest = plainToken(text).replace(/\s+/g, '-').slice(verdict.length);
  const alternative = rest.match(/^-?(?:or|\/|\|)-?(.*)$/);
  return alternative && matchEnum(alternative[1], allowed) ? '' : verdict;
}

function counterStatus(cell) {
  if (/^(?:unresolved|unanswered|not resolved)\b/.test(plainToken(cell))) return 'open';
  return matchEnum(cell, ['resolved', 'open']);
}

function parseCounterargument(value) {
  const empty = { objection: '', status: '', why: '' };
  // The row is sometimes written as a list item under the label.
  const text = unlessNone(value.replace(/^[-*]\s+/, ''));
  if (!text) return empty;

  const cells = text.split(/\s\|\s/).map((cell) => cell.trim());
  if (cells.length >= 3) {
    return { objection: cells[0], status: counterStatus(cells[1]), why: cells.slice(2).join(' | ') };
  }
  if (cells.length === 2 && counterStatus(cells[1])) {
    return { objection: cells[0], status: counterStatus(cells[1]), why: '' };
  }

  const loose = text.match(/^(.*?)\s*(?:\||—|\u2013|-|:)\s*\**(unresolved|resolved|open)\**\s*(?:\||—|\u2013|-|:)\s*(.*)$/i);
  if (loose) return { objection: loose[1].trim(), status: counterStatus(loose[2]), why: loose[3].trim() };
  return { ...empty, objection: text };
}

function parseStatedCounts(text) {
  if (!text) return null;
  const read = (name) => {
    const match = text.match(new RegExp(`${name}\\s*[=:]\\s*(\\d{1,4})`, 'i'));
    return match ? Number(match[1]) : null;
  };
  const stated = {
    critical: read('critical'),
    high: read('high'),
    medium: read('medium'),
    hardening: read('hardening'),
    checkedSafe: read('checked[-_ ]?safe'),
  };
  return Object.values(stated).some((value) => value !== null) ? stated : null;
}

/** Every non-blank prose line of a field, joined: a Location list may be one ref per line. */
function proseText(entries) {
  if (!entries) return '';
  return entries.filter((entry) => !entry.code).map((entry) => entry.line.trim()).filter(Boolean).join(' ');
}

function parseFinding(number, title, entries, labels) {
  const fields = readFields(entries, FINDING_FIELDS);
  const severityText = inlineText(fields.get('severity'));
  const basisText = inlineText(fields.get('basis'));

  return {
    id: `F-${number}`,
    title,
    severity: matchEnum(severityText, SEVERITIES) || plainToken(severityText),
    basis: matchEnum(basisText, BASES) || plainToken(basisText),
    locations: extractRefs(proseText(fields.get('location')), labels),
    impact: inlineText(fields.get('impact')),
    path: listItems(fields.get('path')),
    pathStart: listStart(fields.get('path')),
    counterargument: parseCounterargument(inlineText(fields.get('counterargument'))),
    gap: unlessNone(inlineText(fields.get('gap'))),
    fix: inlineText(fields.get('fix')),
    test: codeText(fields.get('test')),
    next: inlineText(fields.get('next')),
  };
}

/** A cell without the emphasis or code marks that wrap the whole of it. */
function cleanCell(cell) {
  let text = cell.trim();
  for (const mark of ['**', '__', '`']) {
    const wrapped = text.length > 2 * mark.length && text.startsWith(mark) && text.endsWith(mark);
    const inner = wrapped ? text.slice(mark.length, -mark.length) : '';
    if (wrapped && !inner.includes(mark)) text = inner.trim();
  }
  return text;
}

/** Splits a row on " | ", or on bare pipes when the row was written without the spaces. */
function splitCells(text) {
  // The padding lets a row that ends in " |" close with an empty cell
  // instead of leaving the pipe inside the cell before it.
  const spaced = ` ${text.trim()} `.split(/\s\|\s/);
  if (spaced.length > 1) return spaced.map(cleanCell);
  const tight = text.split(TIGHT_PIPE);
  return (tight.length > 2 ? tight : [text]).map(cleanCell);
}

/** The cells of a Markdown table row ("| a | b |"), or null when the line is not one. */
function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || trimmed.length < 2) return null;
  const inner = trimmed.slice(1, trimmed.endsWith('|') ? -1 : trimmed.length);
  return inner.split(TIGHT_PIPE).map(cleanCell);
}

function isTableDivider(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function parseSection(title, entries) {
  const rows = [];
  let lastIsTableRow = false;
  // How far the line that opened the last row was indented.
  let rowIndent = 0;
  // Lines that are not rows: before the first row, and after it. A blank line keeps paragraphs apart.
  const lead = [];
  const tail = [];

  for (const entry of entries) {
    if (entry.code) continue;
    const table = tableCells(entry.line);
    const bullet = table ? null : entry.line.match(ROW_BULLET);
    const indent = entry.line.length - entry.line.trimStart().length;

    if (table) {
      // The row above a divider is the table's header, not data.
      if (isTableDivider(table)) {
        if (lastIsTableRow) rows.pop();
      } else {
        rows.push(table);
        rowIndent = indent;
      }
    } else if (bullet && rows.length && indent >= rowIndent + 2 && !/\s\|\s/.test(bullet[1])) {
      // A bullet indented under a row, with no cells of its own, itemises that row's last cell.
      const last = rows[rows.length - 1];
      last[last.length - 1] += ` ${bullet[1].trim()}`;
    } else if (bullet) {
      // "- none" under a heading means the section is empty, not that it has one row.
      if (!EMPTY_VALUE.test(bullet[1].trim())) {
        rows.push(splitCells(bullet[1]));
        rowIndent = indent;
      }
    } else if (rows.length && /^\s+\S/.test(entry.line)) {
      const last = rows[rows.length - 1];
      last[last.length - 1] += ` ${entry.line.trim()}`;
    } else if (entry.line.split(/\s\|\s/).length > 2) {
      // A row written without its bullet.
      rows.push(splitCells(entry.line.trim()));
      rowIndent = indent;
    } else {
      (rows.length ? tail : lead).push(entry.line.trim());
    }
    lastIsTableRow = Boolean(table) && !isTableDivider(table);
  }

  const text = entries.map((entry) => entry.line).join('\n').trim();
  const prose = (lines) => lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, rows: rows.length ? rows : null, text, lead: rows.length ? prose(lead) : '', tail: rows.length ? prose(tail) : '' };
}

/** "Checked and safe", "Checked-and-safe", "Checked & Safe" and "CHECKED AND SAFE" are the same section. */
function sectionKey(title) {
  return title.toLowerCase().replaceAll('&', ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function sectionRows(sections, key) {
  // "Hardening (2)" is still the Hardening section.
  const section = sections.find((candidate) => {
    const candidateKey = sectionKey(candidate.title);
    return candidateKey === key || candidateKey.startsWith(`${key} `);
  });
  return section && section.rows ? section.rows.length : 0;
}

/**
 * Parses a review in the contract's output format.
 *
 * `ok` is false when the Verdict line is missing or not one of VERDICTS; callers
 * then show `raw` as plain text. `counts` are counted from the parsed body, so
 * they always agree with `findings` and `sections`; the model's own Counts line
 * is kept in `statedCounts`.
 *
 * Pass the manifest labels as `options.labels` so that finding locations in
 * files whose names contain spaces or brackets are read exactly.
 *
 * @param {unknown} markdown
 * @param {{ labels?: string[] }} [options]
 * @returns {ParsedReview}
 */
export function parseReview(markdown, { labels = [] } = {}) {
  const raw = typeof markdown === 'string' ? markdown : '';
  const { lines } = tagLines(reviewBody(raw), { splitInlineFences: true, nestMarkdown: true });
  const { head, sections: rawSections } = splitSections(lines);
  const header = readFields(head, HEADER_FIELDS);

  const verdict = readVerdict(inlineText(header.get('verdict')));
  const statedMode = matchEnum(inlineText(header.get('mode')), Object.keys(VERDICTS));
  const verdictMode = Object.keys(VERDICTS).find((mode) => VERDICTS[mode].includes(verdict)) || '';

  const findings = [];
  const sections = [];
  for (const section of rawSections) {
    const finding = section.title.match(FINDING_TITLE);
    if (finding) findings.push(parseFinding(Number(finding[1]), finding[2].trim(), section.lines, labels));
    else sections.push(parseSection(section.title, section.lines));
  }

  const countSeverity = (severity) => findings.filter((finding) => finding.severity === severity).length;

  return {
    ok: Boolean(verdict),
    verdict,
    mode: verdictMode || statedMode,
    counts: {
      critical: countSeverity('critical'),
      high: countSeverity('high'),
      medium: countSeverity('medium'),
      hardening: sectionRows(sections, 'hardening'),
      checkedSafe: sectionRows(sections, 'checked and safe'),
    },
    statedCounts: parseStatedCounts(inlineText(header.get('counts'))),
    headline: inlineText(header.get('headline')),
    findings,
    sections,
    raw,
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The shorter names a supplied file gets cited by, mapped to its label: the
 * path without `input-N/` and the bare file name, each only when it can mean
 * one file and nothing else.
 */
function labelAliases(labels) {
  const owners = new Map();
  const claim = (alias, label) => {
    if (!BARE_PATH_ONLY.test(alias) || !/[./]/.test(alias)) return;
    const taken = owners.has(alias) && owners.get(alias) !== label;
    owners.set(alias, taken ? null : label);
  };

  for (const label of labels) {
    const name = label.replace(INPUT_PREFIX, '');
    if (name === label) continue;
    claim(name, label);
    claim(name.slice(name.lastIndexOf('/') + 1), label);
  }
  for (const [alias, label] of owners) {
    if (label === null) owners.delete(alias);
  }
  return owners;
}

/**
 * The label a citation means when it keeps the input number and shortens the
 * path: `input-1/Vault.sol` for `input-1/src/vault/Vault.sol`. An input number
 * names one file, so the citation resolves when what it wrote is the end of
 * that file's path. Anything else is returned unchanged and reported.
 */
function resolveShortened(cited, known) {
  if (known.includes(cited)) return cited;
  const prefix = cited.match(INPUT_PREFIX);
  if (!prefix) return cited;
  const owners = known.filter((label) => label.startsWith(prefix[0]));
  if (owners.length !== 1) return cited;
  return owners[0].endsWith(`/${cited.slice(prefix[0].length)}`) ? owners[0] : cited;
}

/** Every range of one match: the first, and any that follow it after a comma. */
function matchedRanges(first, last, tail) {
  const ranges = [[first, last]];
  for (const more of tail.matchAll(TAIL_RANGE)) ranges.push([more[1], more[2]]);
  return ranges.map(([start, end]) => ({ start: Number(start), end: Number(end === undefined ? start : end) }));
}

/**
 * Finds `input-N/name:start[-end]` references, in the order they appear.
 * A list of ranges after one name (`:64-67,90`) gives one reference each.
 *
 * Pass the manifest labels to match file names that contain spaces or
 * punctuation exactly, and to resolve a citation that leaves the `input-N/`
 * prefix out (`src/Vault.sol:64`, `Vault.sol:64`) when only one supplied file
 * answers to that name, or keeps the prefix and shortens the path after it
 * (`input-1/Vault.sol:64` for `input-1/src/Vault.sol`).
 *
 * @param {unknown} text
 * @param {string[]} [labels]
 * @returns {Ref[]}
 */
export function extractRefs(text, labels = []) {
  if (typeof text !== 'string' || !text) return [];

  const known = labels.filter((label) => typeof label === 'string' && label);
  const exact = [...known].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const labelled = exact.length ? `(?:${exact.join('|')}|${GENERIC_REF})` : GENERIC_REF;
  const source = text.replace(HIDDEN_CHARS, '').replace(SOFT_HYPHENS, '-');

  const found = [];
  const collect = (match, label) => {
    for (const range of matchedRanges(match[2], match[3], match[4])) {
      found.push({ index: match.index, ref: { label, ...range } });
    }
  };

  for (const match of source.matchAll(new RegExp(`${REF_START}(${labelled})${LINE_RANGE}${MORE_RANGES}`, 'g'))) {
    collect(match, known.length ? resolveShortened(match[1], known) : match[1]);
  }
  const aliases = labelAliases(known);
  if (aliases.size) {
    for (const match of source.matchAll(BARE_REF)) {
      const label = aliases.get(match[1]);
      // A name that carries its own input-N/ prefix was read by the first pass.
      if (label && !INPUT_PREFIX.test(match[1])) collect(match, label);
    }
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.ref);
}

/**
 * Lists every cited location that does not exist in the supplied files.
 * Manifest entries without a `lines` count are checked for the label only.
 *
 * @param {{ raw: string } | null | undefined} parsed
 * @param {{ label: string, lines?: number }[]} manifest
 * @returns {RefProblem[]}
 */
export function checkRefs(parsed, manifest) {
  const lineCounts = new Map((manifest || []).map((entry) => [entry.label, entry.lines]));
  const text = parsed && typeof parsed.raw === 'string' ? parsed.raw : '';
  const problems = [];
  const seen = new Set();

  for (const ref of extractRefs(text, [...lineCounts.keys()])) {
    const key = `${ref.label}:${ref.start}-${ref.end}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!lineCounts.has(ref.label)) {
      problems.push({ ref, problem: 'unknown-file' });
      continue;
    }
    const lines = lineCounts.get(ref.label);
    const inRange = ref.start >= 1 && ref.end >= ref.start && (!Number.isFinite(lines) || ref.end <= lines);
    if (!inRange) problems.push({ ref, problem: 'line-out-of-range' });
  }
  return problems;
}

/**
 * True when text contains a character that renders as nothing or reorders the
 * text around it, such as a zero-width space or a bidi override.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasHiddenChars(text) {
  return HIDDEN_CHAR.test(text);
}

/** True when a link destination can resolve to a script, data or local-file URL. */
function unsafeDestination(destination) {
  // Browsers ignore whitespace and control characters inside a scheme.
  const compact = destination.replace(/[\x00-\x20\x7f\s]+/g, '');
  // The scheme is whatever precedes the first "/", "?" or "#". Markdown decodes
  // backslash escapes and character references, so a scheme written with
  // either is not the scheme it appears to be.
  const scheme = compact.split(/[/?#]/, 1)[0];
  return SCRIPT_SCHEME.test(scheme) || /[\\&]/.test(scheme);
}

/**
 * Blocks every inline link whose destination is a script, data or file URL.
 * The destination is read in a lookahead, so the "](" of one link can never
 * hide inside the destination of the one before it.
 */
function defangLinks(line) {
  // Any whitespace may precede the destination: some renderers skip a
  // no-break or an ideographic space there as they do a plain one.
  return line.replace(/\]\((?=(\s*)(<[^<>]*|[^\s<>()]*))/g, (opener, space, destination, offset) => {
    // Markdown lets a destination start on the next line, where this pass
    // cannot read it. Escaping the bracket voids that link.
    const endsLine = !destination && offset + opener.length + space.length === line.length;
    if (endsLine) return ']\\(';
    return unsafeDestination(destination.replace('<', '')) ? '](blocked:' : opener;
  });
}

/**
 * Neutralises one line of prose. `holdsImage` says whether the paragraph the
 * line belongs to could hold an inline image; see linkParagraphs.
 */
function defangLine(line, holdsImage) {
  const text = line.replace(/<(?=[A-Za-z/!?])/g, '&lt;');
  // "![alt](url)" stops being an image once its bracket is a character
  // reference. A backslash would not do: some renderers take the escape off
  // again when the image sits inside the text of a link.
  const withoutImages = holdsImage ? text.replace(/!\[/g, '!&#91;') : text;
  const withoutDefinitions = withoutImages
    // A reference definition can aim a link or an image at any URL from inside
    // a quote or a list, with its label split across lines. Escaping the colon
    // voids them all, and with them every "![alt][ref]".
    .replace(/\]:/g, ']\\:')
    // A bracket that opens a line and is not closed on it can start a
    // definition that some renderers read on through blank lines and through
    // the opening fence of a code block, as far as the first "]:" they meet.
    // That turns the rest of the block into live text. This runs after the
    // image step, which can take away the bracket that closed the line.
    .replace(UNCLOSED_BRACKET, '$1\\[');
  return defangLinks(withoutDefinitions);
}

/**
 * For every line, whether its paragraph contains "](". An inline image needs
 * one, and its "![" may sit on an earlier line of the same paragraph, so the
 * whole paragraph is marked. Lines of other paragraphs keep "![" as written,
 * which leaves code such as `vec![1, 2]` readable.
 */
function linkParagraphs(lines) {
  const marked = new Array(lines.length).fill(false);
  let start = 0;
  const closeParagraph = (end) => {
    let holdsLink = false;
    for (let index = start; index < end && !holdsLink; index += 1) holdsLink = lines[index].line.includes('](');
    if (holdsLink) marked.fill(true, start, end);
    start = end + 1;
  };

  lines.forEach((entry, index) => {
    if (entry.code || BLANK_LINE.test(entry.line)) closeParagraph(index);
  });
  closeParagraph(lines.length);
  return marked;
}

/** An opening fence at the margin, keeping only the language name of its info string. */
function plainOpeningFence(line) {
  const [, , marker, info] = line.match(FENCE);
  // Some renderers read a fence line that contains "|" as a table header, and
  // then render the block below it as prose.
  const language = (info.trim().split(/\s+/, 1)[0] || '').replace(/[^A-Za-z0-9_+#.-]/g, '').slice(0, 40);
  return `${marker}${language}`;
}

/** True for a code line that some renderers take as the closing fence although Markdown does not. */
function looksLikeClosingFence(line, entry) {
  const fence = line.match(FENCE);
  if (!fence || fence[2][0] !== entry.char || fence[2].length < entry.length) return false;
  return /^[`~\s]*$/.test(fence[3]);
}

function defangCode(entry) {
  if (entry.opens) return plainOpeningFence(entry.line);
  // An indented fence may sit inside a list item, where the block ends with the
  // item and the text after it renders as prose. At the margin it is a
  // top-level block that only its own closing fence can end.
  if (entry.fence) return entry.line.trim();

  let cut = 0;
  while (cut < entry.indent && entry.line[cut] === ' ') cut += 1;
  const content = entry.line.slice(cut);
  // Four spaces keep the line inside the block for every renderer.
  return looksLikeClosingFence(content, entry) ? `    ${content.trimStart()}` : content;
}

/**
 * Line endings as "\n", and no character that is invisible once rendered.
 * Renderers disagree on whether a form feed or a vertical tab is whitespace,
 * and on whether a line of tabs ends a paragraph, and nothing here may depend
 * on which one is right: the first two become spaces, and a line that holds
 * only spaces and tabs becomes an empty line.
 */
function visibleText(markdown) {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(HIDDEN_CHARS, '')
    .replace(/[\f\v]/g, ' ')
    .replace(/^[ \t]+$/gm, '');
}

/**
 * Neutralises remote images, raw HTML, script links, reference definitions and
 * hidden characters in Markdown that came from a model or a pasted reply.
 * Fenced code keeps its text; a fence is moved to the margin and reduced to
 * its language name, and a fence the text never closes is closed, so that no
 * code block can end early or swallow whatever is appended after it.
 *
 * @param {unknown} markdown
 * @returns {string}
 */
export function defang(markdown) {
  if (typeof markdown !== 'string' || !markdown) return '';
  // Hidden characters go first: one placed before a fence would otherwise hide
  // that fence from this pass and reveal it to the renderer.
  const { lines, unclosed } = tagLines(visibleText(markdown));
  const holdsImage = linkParagraphs(lines);
  const output = [];
  let afterQuote = false;

  lines.forEach((entry, index) => {
    const isQuote = !entry.code && QUOTE_LINE.test(entry.line);
    // A line that follows a quote without a blank line is a lazy continuation
    // of it. Renderers disagree on where such a quote ends, so it is ended here.
    if (afterQuote && !isQuote && !BLANK_LINE.test(entry.line)) output.push('');
    output.push(entry.code ? defangCode(entry) : defangLine(entry.line, holdsImage[index]));
    afterQuote = isQuote;
  });
  if (unclosed) output.push(unclosed.char.repeat(unclosed.length));
  return output.join('\n');
}

// A heading may sit inside a quote or a list item, at any indent: "> ## x", "- ## x".
const ATX_HEADING = /^([ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*)(#{1,6})(?=\s|$)/;
// An underline continues the paragraph above it, so only indentation and quote marks can precede it.
const SETEXT_UNDERLINE = /^[ \t]*(?:>[ \t]*)*(?:=+|-+)\s*$/;

// What would start a block at the head of a line: heading, quote, list item,
// rule, underline or fence.
const BLOCK_START = /^(?:#{1,6}(?=\s|$)|>|[-+*_=](?=[-*_=\s]|$)|`{3}|~{3})/;
const ORDERED_START = /^(\d{1,9})([.)])(?=\s|$)/;

/**
 * One line of untrusted text for a place that holds a single line, such as a
 * packet header field or a list row. Line breaks become spaces and hidden
 * characters go. Raw HTML is escaped, and every "](" and "]:" is voided: the
 * line can then neither hold a link, an image or a definition nor complete one
 * that starts on a line next to it. A leading block marker is escaped, so the
 * text cannot open a heading, a list, a quote or a code block either.
 *
 * `restoreInline` turns the result back into the text.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function defangInline(text) {
  if (typeof text !== 'string' || !text) return '';
  return visibleText(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
    .replace(/\](?=[(:])/g, ']\\')
    .replace(BLOCK_START, '\\$&')
    .replace(ORDERED_START, '$1\\$2');
}

/**
 * Reverses defangInline, for a reader that needs the original text of a
 * packet field, such as the file label in a manifest row.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function restoreInline(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/^\\(?=[#>\-+*_=`~])/, '')
    .replace(/^(\d{1,9})\\(?=[.)])/, '$1')
    .replace(/\]\\(?=[(:])/g, ']')
    .replaceAll('&lt;', '<');
}

/**
 * Pushes Markdown headings down by `levels` so one document can nest inside
 * another; level 6 is the deepest there is. An underlined heading cannot be
 * pushed down, so its underline is detached from the text above it and the
 * text stays a paragraph.
 *
 * @param {unknown} markdown
 * @param {number} [levels]
 * @returns {string}
 */
export function shiftHeadings(markdown, levels = 2) {
  if (typeof markdown !== 'string' || !markdown) return '';
  const { lines } = tagLines(visibleText(markdown));
  const shift = Math.max(0, levels);
  const output = [];
  let previousIsText = false;

  for (const entry of lines) {
    if (entry.code) {
      output.push(entry.line);
      previousIsText = false;
      continue;
    }
    if (previousIsText && SETEXT_UNDERLINE.test(entry.line)) output.push('');
    output.push(entry.line.replace(ATX_HEADING, (match, indent, hashes) => `${indent}${'#'.repeat(Math.min(6, hashes.length + shift))}`));
    previousIsText = !BLANK_LINE.test(entry.line);
  }
  return output.join('\n');
}
