// Build-time HTML helpers for the static pages.
//
// Everything here runs in Node when scripts/build-site.mjs generates the site.
// Nothing in this file is shipped to the browser. The class names it emits are
// defined in web/public/css/base.css and documented in web/site/COMPONENTS.md.

// ---------------------------------------------------------------------------
// Escaping and the html tagged template
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Markup that is already safe to emit. Only `html`, `raw` and the helpers create it. */
class SafeHtml {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

/** Escape text for use in element content or a quoted attribute value. */
export function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/** Mark a string as trusted markup. Use it for fixed, author-written markup only. */
export function raw(markup) {
  return new SafeHtml(String(markup));
}

export function isHtml(value) {
  return value instanceof SafeHtml;
}

function render(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return esc(value);
}

/**
 * Auto-escaping template tag. Interpolated strings and numbers are escaped;
 * results of `html`, `raw` and the helpers pass through; arrays are joined;
 * null, undefined and booleans render as nothing.
 */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, index) => {
    out += render(value) + strings[index + 1];
  });
  return new SafeHtml(out);
}

/** Join class names, skipping falsy entries. */
export function cx(...names) {
  return names.flat().filter(Boolean).join(' ');
}

const ATTRIBUTE_NAME = /^[a-zA-Z_:][\w:.-]*$/;

/**
 * Render an attribute map with a leading space: attrs({ id: 'a', hidden: true })
 * gives ` id="a" hidden`. Null, undefined and false entries are dropped.
 */
export function attrs(map = {}) {
  let out = '';
  for (const [name, value] of Object.entries(map)) {
    if (value === null || value === undefined || value === false) continue;
    if (!ATTRIBUTE_NAME.test(name)) throw new Error(`Invalid attribute name: ${name}`);
    if (/^on/i.test(name) || name.toLowerCase() === 'style') {
      throw new Error(`The site CSP forbids the "${name}" attribute. Use a class or a module script.`);
    }
    out += value === true ? ` ${name}` : ` ${name}="${esc(value)}"`;
  }
  return new SafeHtml(out);
}

/** Escape text and turn `backtick spans` into <code> elements. */
export function inline(text) {
  if (isHtml(text)) return text;
  const parts = String(text ?? '').split(/`([^`\n]+)`/);
  return parts.map((part, index) => (index % 2 === 1 ? html`<code>${part}</code>` : html`${part}`));
}

const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'code', 'em', 'i', 'kbd', 'mark', 'small', 'span', 'strong', 'sub', 'sup', 'time']);

/**
 * Markup with every tag taken out, in one pass. An inline tag joins its text
 * to the words around it ("`run_review`." reads "run_review."); any other tag
 * is a word break. A "<" opens a tag that runs to the next ">", and a "<" with
 * no ">" after it takes the rest of the text with it, so the result holds no
 * "<" at all: nothing a removal leaves behind can join into a tag.
 */
function withoutTags(source) {
  let out = '';
  let at = 0;
  while (at < source.length) {
    const open = source.indexOf('<', at);
    if (open === -1) return out + source.slice(at);
    out += source.slice(at, open);
    const close = source.indexOf('>', open + 1);
    if (close === -1) return out;
    const name = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(open + 1, close))?.[1].toLowerCase();
    if (!name || !INLINE_TAGS.has(name)) out += ' ';
    at = close + 1;
  }
  return out;
}

/** Plain text of a value, for JSON-LD and meta tags. */
export function textOf(value) {
  const source = Array.isArray(value) ? value.map(render).join('') : render(value);
  return withoutTags(source)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Brand mark and icons
// ---------------------------------------------------------------------------

/**
 * The "b/" mark as outlined paths on a 64 x 64 grid. scripts/build-icons.mjs
 * draws icon.svg and the PNG icons from the same geometry.
 */
export const BRAND_MARK = {
  viewBox: '0 0 64 64',
  tileRadius: 9,
  stem: 'M12.5 15h6.5v31.5h-6.5z',
  bowl: 'M25.5 25a10.75 10.75 0 1 0 0 21.5a10.75 10.75 0 0 0 0-21.5zm0 6.25a4.5 4.5 0 1 1 0 9a4.5 4.5 0 0 1 0-9z',
  slash: 'M45.5 13h6.25l-8.6 37.5h-6.25z',
};

export function brandMark() {
  return html`<svg class="brand__mark" viewBox="${BRAND_MARK.viewBox}" aria-hidden="true" focusable="false"><rect class="brand__tile" width="64" height="64" rx="${BRAND_MARK.tileRadius}"/><path class="brand__glyph" d="${BRAND_MARK.stem}"/><path class="brand__glyph" fill-rule="evenodd" d="${BRAND_MARK.bowl}"/><path class="brand__slash" d="${BRAND_MARK.slash}"/></svg>`;
}

/** Names with a matching `.icon--<name>` rule in base.css. */
export const ICONS = [
  'check', 'x', 'plus', 'minus', 'arrow-right', 'arrow-left', 'arrow-up-right', 'chevron-down',
  'chevron-right', 'copy', 'download', 'upload', 'file', 'search', 'lock', 'key', 'sun', 'moon',
  'info', 'warn', 'error', 'ok', 'clock', 'play', 'refresh', 'terminal', 'shield', 'hash', 'eye',
  'trash', 'user', 'menu', 'code', 'sort', 'sort-up', 'sort-down',
];

/** A decorative icon. Pass `label` when the icon is the only content of its control. */
export function icon(name, { label, className } = {}) {
  if (!ICONS.includes(name)) throw new Error(`Unknown icon "${name}". Known icons: ${ICONS.join(', ')}`);
  const classes = cx('icon', `icon--${name}`, className);
  if (label) return html`<span class="${classes}" role="img" aria-label="${label}"></span>`;
  return html`<span class="${classes}" aria-hidden="true"></span>`;
}

// ---------------------------------------------------------------------------
// Buttons and links
// ---------------------------------------------------------------------------

const BUTTON_VARIANTS = ['primary', 'secondary', 'quiet', 'danger'];
const BUTTON_SIZES = ['sm', 'md', 'lg'];

/**
 * A button, or a link styled as one when `href` is given.
 * button({ label: 'Run review', variant: 'primary', iconEnd: 'arrow-right' })
 */
export function button({
  label,
  href,
  variant = 'secondary',
  size = 'md',
  block = false,
  icon: iconStart,
  iconEnd,
  iconOnly = false,
  type = 'button',
  id,
  disabled = false,
  external = false,
  className,
  attrs: extra = {},
} = {}) {
  if (!label) throw new Error('button() needs a label. For icon-only buttons the label becomes the accessible name.');
  if (!BUTTON_VARIANTS.includes(variant)) throw new Error(`Unknown button variant "${variant}"`);
  if (!BUTTON_SIZES.includes(size)) throw new Error(`Unknown button size "${size}"`);

  const classes = cx(
    'btn',
    `btn--${variant}`,
    size !== 'md' && `btn--${size}`,
    block && 'btn--block',
    iconOnly && 'btn--icon',
    className,
  );
  const content = iconOnly
    ? html`${icon(iconStart ?? iconEnd)}<span class="visually-hidden">${label}</span>`
    : html`${iconStart && icon(iconStart)}<span class="btn__label">${label}</span>${iconEnd && icon(iconEnd)}`;

  if (href) {
    const linkAttrs = attrs({
      class: classes,
      href,
      id,
      target: external ? '_blank' : null,
      rel: external ? 'noopener noreferrer' : null,
      ...extra,
    });
    return html`<a${linkAttrs}>${content}</a>`;
  }
  return html`<button${attrs({ class: classes, type, id, disabled, ...extra })}>${content}</button>`;
}

/** A text link. External links open in a new tab and carry the arrow icon. */
export function link({ label, href, external = false, className } = {}) {
  if (external) {
    return html`<a class="${cx('link', 'link--external', className)}" href="${href}" target="_blank" rel="noopener noreferrer">${label}${icon('arrow-up-right')}</a>`;
  }
  return html`<a class="${cx('link', className)}" href="${href}">${label}</a>`;
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

const SEVERITIES = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
  unrated: 'Unrated',
};

const VERDICTS = {
  submit: 'Submit',
  'rewrite-then-submit': 'Rewrite, then submit',
  'prove-first': 'Prove first',
  'hold-duplicate': 'Hold: duplicate',
  drop: 'Drop',
  'fix-before-deploy': 'Fix before deploy',
  'no-blocking-issues': 'No blocking issues',
};

const STATUSES = {
  proven: 'Proven in source',
  'needs-test': 'Needs test',
  unsupplied: 'Depends on unsupplied code',
  resolved: 'Resolved',
  open: 'Open',
  running: 'Running',
  queued: 'Queued',
  done: 'Done',
  failed: 'Failed',
  example: 'Example',
  free: 'Free',
  operator: 'Operator',
};

/** Basis values from the review format, mapped to status chip ids. */
const BASIS_STATUS = {
  'proven-in-source': 'proven',
  'needs-test': 'needs-test',
  'depends-on-unsupplied-code': 'unsupplied',
};

const TONES = ['observed', 'unproven', 'ok', 'danger', 'neutral'];

/** A generic chip. Tones: observed (blue), unproven (amber), ok, danger, neutral. */
export function chip(label, { tone = 'neutral', dashed = false, className } = {}) {
  if (!TONES.includes(tone)) throw new Error(`Unknown chip tone "${tone}"`);
  return html`<span class="${cx('chip', dashed && 'chip--dashed', className)}" data-tone="${tone}">${label}</span>`;
}

/** severityChip('high'). `{ stamp: true }` prints it as a hand-stamped impression (.sev--stamp). */
export function severityChip(severity, label, { stamp = false } = {}) {
  const key = String(severity ?? 'unrated').toLowerCase();
  const known = Object.hasOwn(SEVERITIES, key) ? key : 'unrated';
  return html`<span class="${cx('chip', 'sev', stamp && 'sev--stamp')}" data-sev="${known}">${label ?? SEVERITIES[known]}</span>`;
}

/**
 * Words circled by the red pen: one stroke, drawn once when the page opens
 * (.pen in home.css). The ring is decoration; the words read as plain text.
 */
export function pen(words) {
  return html`<span class="pen">${words}<svg class="pen__ring" viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path pathLength="1000" d="M16 56C10 26 70 8 158 8c82 0 134 18 130 48-4 28-78 38-150 36C66 90 20 78 14 52 10 34 34 20 84 13"/></svg></span>`;
}

/** A sentence with one phrase of it circled. The sentence is returned as it is when the phrase is not in it. */
export function penned(sentence, phrase) {
  const at = sentence.indexOf(phrase);
  if (at < 0) return html`${sentence}`;
  return html`${sentence.slice(0, at)}${pen(phrase)}${sentence.slice(at + phrase.length)}`;
}

/** The printed name of a verdict. */
export function verdictLabel(verdict) {
  if (!Object.hasOwn(VERDICTS, verdict)) throw new Error(`Unknown verdict "${verdict}"`);
  return VERDICTS[verdict];
}

export function verdictChip(verdict, { size = 'md', label } = {}) {
  if (!Object.hasOwn(VERDICTS, verdict)) throw new Error(`Unknown verdict "${verdict}"`);
  return html`<span class="${cx('chip', 'verdict', size === 'lg' && 'verdict--lg')}" data-verdict="${verdict}">${label ?? VERDICTS[verdict]}</span>`;
}

export function statusChip(status, label) {
  if (!Object.hasOwn(STATUSES, status)) throw new Error(`Unknown status "${status}"`);
  return html`<span class="chip status" data-status="${status}">${label ?? STATUSES[status]}</span>`;
}

function refParts(ref) {
  if (typeof ref === 'string') {
    const match = ref.match(/^(.*?)(?::(\d+)(?:-(\d+))?)?$/);
    return { label: match[1], start: match[2] ? Number(match[2]) : null, end: match[3] ? Number(match[3]) : null };
  }
  return { label: ref.label, start: ref.start ?? null, end: ref.end ?? null };
}

/**
 * A file reference chip: refChip('input-1/TidalStaking.sol:60-69') or
 * refChip({ label, start, end }). With `href` it renders as a link.
 */
export function refChip(ref, { href } = {}) {
  const { label, start, end } = refParts(ref);
  const lines = start === null ? '' : end !== null && end !== start ? `:${start}-${end}` : `:${start}`;
  const content = html`<span class="ref__file">${label}</span>${lines && html`<span class="ref__lines">${lines}</span>`}`;
  // The chip never wraps; the title keeps the full reference when the file part is shortened.
  const title = `${label}${lines}`;
  if (href) return html`<a class="ref" href="${href}" title="${title}">${content}</a>`;
  return html`<span class="ref" title="${title}">${content}</span>`;
}

/** A hash prefix chip. The full value stays available in the title attribute. */
export function hashChip(hash, { algo = 'sha256', length = 12 } = {}) {
  const value = String(hash);
  const shown = value.length > length ? `${value.slice(0, length)}…` : value;
  return html`<span class="hash" title="${algo}: ${value}"><span class="hash__algo">${algo}</span>${shown}</span>`;
}

// ---------------------------------------------------------------------------
// Code blocks
// ---------------------------------------------------------------------------

/** Expand [64, [87, 90]] into a Set of line numbers. */
function lineSet(spec = []) {
  const lines = new Set();
  for (const entry of spec) {
    if (Array.isArray(entry)) {
      for (let line = entry[0]; line <= entry[1]; line += 1) lines.add(line);
    } else {
      lines.add(entry);
    }
  }
  return lines;
}

/**
 * A code block with optional line numbers, highlighted and dimmed lines.
 *
 * codeBlock({ code, name: 'input-1/TidalStaking.sol', start: 60, highlight: [64], copy: true })
 *
 * highlight  lines marked as observed (blue)
 * flag       lines marked as unproven (amber)
 * dim        context lines to recede; `dimOthers` dims every unmarked line
 */
export function codeBlock({
  code,
  name,
  start = 1,
  numbers = true,
  highlight = [],
  flag = [],
  dim = [],
  dimOthers = false,
  copy = false,
  label,
  wrap = false,
  className,
} = {}) {
  const source = String(code ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const highlighted = lineSet(highlight);
  const flagged = lineSet(flag);
  const dimmed = lineSet(dim);
  const rows = source.split('\n');

  const lines = rows.map((text, index) => {
    const number = start + index;
    const marked = highlighted.has(number) || flagged.has(number);
    const state = cx(
      'code__line',
      highlighted.has(number) && 'is-hl',
      flagged.has(number) && 'is-flag',
      (dimmed.has(number) || (dimOthers && !marked)) && 'is-dim',
    );
    return html`<span class="${state}"${attrs({ 'data-n': numbers ? number : null })}>${text}${'\n'}</span>`;
  });

  const range = numbers && rows.length > 1 ? `${start}–${start + rows.length - 1}` : '';
  const copyButton = (extraClass) =>
    html`<button class="${cx('code__copy', extraClass)}" type="button" data-copy>${icon('copy')}<span data-copy-label>Copy</span></button>`;
  // With a file name the block gets a bar. Without one the copy button sits in the corner.
  const bar = name
    ? html`<figcaption class="code__bar"><span class="code__name">${name}</span>${range && html`<span class="code__range">${range}</span>`}${copy && copyButton()}</figcaption>`
    : '';
  const corner = !name && copy ? copyButton('code__copy--corner') : '';
  const region = attrs({
    class: 'code__pre',
    tabindex: '0',
    role: 'region',
    'aria-label': label ?? (name ? `Source: ${name}` : 'Code'),
  });

  return html`<figure class="${cx('code', numbers && 'code--numbered', wrap && 'code--wrap', className)}">${bar}<pre${region}><code>${lines}</code></pre>${corner}</figure>`;
}

// ---------------------------------------------------------------------------
// Cards, notices, key/value lists
// ---------------------------------------------------------------------------

/**
 * card({ title: 'Manifest', body: html`…`, foot: html`…` })
 * variant: 'raised' (shadow) | 'inset' (recessed surface) | 'accent' (accent border)
 */
export function card({ title, meta, body, foot, variant, tag = 'div', level = 3, id, className } = {}) {
  const head = title
    ? html`<div class="card__head">${raw(`<h${level} class="card__title">`)}${title}${raw(`</h${level}>`)}${meta && html`<div class="card__meta">${meta}</div>`}</div>`
    : '';
  const classes = cx('card', variant && `card--${variant}`, className);
  return html`${raw(`<${tag}`)}${attrs({ class: classes, id })}>${head}<div class="card__body">${body}</div>${foot && html`<div class="card__foot">${foot}</div>`}${raw(`</${tag}>`)}`;
}

const NOTICE_ICONS = { info: 'info', success: 'ok', warn: 'warn', error: 'error' };

/**
 * notice({ tone: 'warn', title: 'Two files contain an email address', body: '…' })
 * `live` renders an empty live region the app fills later; errors use role="alert".
 */
export function notice({ tone = 'info', title, body, id, live = false, className } = {}) {
  if (!Object.hasOwn(NOTICE_ICONS, tone)) throw new Error(`Unknown notice tone "${tone}"`);
  const role = tone === 'error' ? 'alert' : live ? 'status' : null;
  const base = attrs({ class: cx('notice', `notice--${tone}`, className), id, role });
  if (live && !title && !body) return html`<div${base}></div>`;
  return html`<div${base}>${icon(NOTICE_ICONS[tone])}<div class="notice__content">${title && html`<p class="notice__title">${title}</p>`}${body && html`<div class="notice__body">${body}</div>`}</div></div>`;
}

/** A key/value ledger: kv([['Profile', 'Solidity review'], ['Files', '1']]) */
export function kv(rows, { className } = {}) {
  return html`<dl class="${cx('kv', className)}">${rows.map(([key, value]) => html`<div class="kv__row"><dt>${key}</dt><dd>${value}</dd></div>`)}</dl>`;
}

const COUNT_LABELS = [
  ['critical', 'Critical'],
  ['high', 'High'],
  ['medium', 'Medium'],
  ['hardening', 'Hardening'],
  ['checked-safe', 'Checked safe'],
];

/** The totals row of a review: counts({ critical: 1, high: 1, medium: 0, hardening: 3, 'checked-safe': 4 }) */
export function counts(values = {}) {
  const items = COUNT_LABELS.filter(([key]) => values[key] !== undefined).map(([key, label]) => {
    const amount = Number(values[key]);
    const itemAttrs = attrs({ 'data-sev': key, 'data-zero': amount === 0 });
    return html`<li${itemAttrs}><span class="counts__n">${amount}</span><span class="counts__label">${label}</span></li>`;
  });
  return html`<ul class="counts">${items}</ul>`;
}

/**
 * The head of a review: the verdict, the one-line headline and the counts.
 * dossier({ verdict: 'fix-before-deploy', headline: '…', counts: { critical: 1, high: 1 } })
 */
export function dossier({ verdict, headline, counts: totals, className } = {}) {
  return html`<header class="${cx('dossier', className)}"><div class="dossier__verdict"><span class="meta">Verdict</span>${verdictChip(verdict, { size: 'lg' })}</div><p class="dossier__headline">${inline(headline)}</p>${totals && counts(totals)}</header>`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const SORT_ICONS = { ascending: 'sort-up', descending: 'sort-down', none: 'sort' };

/**
 * table({
 *   caption: 'Checked and safe',
 *   columns: [{ label: 'Item', sort: 'ascending' }, { label: 'Lines', align: 'end', mono: true }],
 *   rows: [['recoverToken', '158-163']],
 * })
 * A column with `sort` renders a header button and sets aria-sort; the app wires the click.
 */
export function table({ caption, columns, rows, dense = false, label, className } = {}) {
  const head = columns.map((column) => {
    const cellClass = cx(column.align === 'end' && 'num');
    if (!column.sort) return html`<th scope="col"${attrs({ class: cellClass || null })}>${column.label}</th>`;
    return html`<th scope="col"${attrs({ class: cellClass || null, 'aria-sort': column.sort })}><button class="table__sort" type="button">${column.label}${icon(SORT_ICONS[column.sort] ?? 'sort')}</button></th>`;
  });

  const body = rows.map((row) => {
    const cells = row.map((value, index) => {
      const column = columns[index] ?? {};
      const cellClass = cx(column.align === 'end' && 'num', column.mono && 'mono');
      if (index === 0 && column.header !== false) {
        return html`<th scope="row"${attrs({ class: cellClass || null })}>${value}</th>`;
      }
      return html`<td${attrs({ class: cellClass || null })}>${value}</td>`;
    });
    return html`<tr>${cells}</tr>`;
  });

  const region = attrs({
    class: 'table-wrap',
    tabindex: '0',
    role: 'region',
    'aria-label': label ?? (typeof caption === 'string' ? caption : 'Table'),
  });
  return html`<div${region}><table class="${cx('table', dense && 'table--dense', className)}">${caption && html`<caption>${caption}</caption>`}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * A table that reads as a list on a narrow screen: one block per row, and every
 * cell after the first under its column name. Takes the options of table().
 *
 *   plain  leave the column names out of the stacked cells (two columns, or
 *          cells that explain themselves)
 *   wide   stack below 60em instead of 44em, two cells abreast on a tablet
 *          (four or more columns of prose)
 *
 * The rules are `.stack-table` in base.css. A script that builds the same
 * table writes `<span class="cell-label">` into each cell after the first.
 */
export function stackTable({ columns, rows, className, plain = false, wide = false, ...rest } = {}) {
  const labelled = rows.map((row) => row.map((cell, index) => (index === 0 ? cell : html`<span class="cell-label">${columns[index].label}</span>${cell}`)));
  return table({ ...rest, columns, rows: labelled, className: cx('stack-table', plain && 'stack-table--plain', wide && 'stack-table--wide', className) });
}

// ---------------------------------------------------------------------------
// Disclosure, FAQ, section headings, breadcrumbs
// ---------------------------------------------------------------------------

/** A single disclosure: disclosure({ summary: 'Paste code instead', body: html`…` }) */
export function disclosure({ summary, hint, body, open = false, id, className } = {}) {
  return html`<details${attrs({ class: cx('disclosure', className), id, open })}><summary class="disclosure__summary">${summary}${hint && html`<span class="disclosure__hint">${hint}</span>`}</summary><div class="disclosure__body">${body}</div></details>`;
}

/**
 * An accordion of questions: faq([{ q: 'What do you keep?', a: 'Account and passkey records…' }])
 * Pass the same items to faqPageLd() in layout.mjs for the structured data.
 * `exclusive` gives the items a shared name so opening one closes the others.
 */
export function faq(items, { id, exclusive, className } = {}) {
  const rows = items.map((item) => {
    const itemAttrs = attrs({ class: 'accordion__item', id: item.id ?? null, name: exclusive ?? null });
    const answer = isHtml(item.a) ? item.a : html`<p>${inline(item.a)}</p>`;
    return html`<details${itemAttrs}><summary class="accordion__summary">${item.q}</summary><div class="accordion__body">${answer}</div></details>`;
  });
  return html`<div${attrs({ class: cx('accordion', className), id })}>${rows}</div>`;
}

/**
 * sectionHeading({ title: 'Free tools', lede: 'Run them without an account.', id: 'tools' })
 * `aside` renders to the right of the heading on wide screens. A part rule
 * prints above it; there is no label above the heading.
 */
export function sectionHeading({ title, lede, aside, level = 2, id, className } = {}) {
  const headingId = id ?? slug(textOf(title));
  return html`<header class="${cx('section-head', className)}"><div class="section-head__text">${raw(`<h${level} id="${esc(headingId)}">`)}${title}${raw(`</h${level}>`)}${lede && html`<p class="lede">${lede}</p>`}</div>${aside && html`<div class="section-head__aside">${aside}</div>`}</header>`;
}

/** Visible breadcrumb trail: breadcrumbs([{ label: 'Tools', href: '/tools' }, { label: 'Report check' }]) */
/**
 * breadcrumbs([{ label: 'Bounty Operator', href: '/' }, { label: 'Tools', href: '/tools' }, { label: 'Report check' }])
 * A trail of two (home and this page) prints nothing: the mark in the header
 * is the way home, and a lone label above a heading reads as a kicker. The
 * BreadcrumbList in the page's JSON-LD carries every trail.
 */
export function breadcrumbs(trail) {
  if (trail.length <= 2) return '';
  const items = trail.map((crumb, index) => {
    const last = index === trail.length - 1;
    if (last || !crumb.href) return html`<li${attrs({ 'aria-current': last ? 'page' : null })}>${crumb.label}</li>`;
    return html`<li><a href="${crumb.href}">${crumb.label}</a></li>`;
  });
  return html`<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${items}</ol></nav>`;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/**
 * A labelled control: field({ label: 'Model', for: 'model', control: input({ id: 'model' }), help: '…' })
 * `error` renders an alert line and should be paired with aria-invalid on the control.
 */
export function field({ label, for: htmlFor, control, help, error, optional = false, className } = {}) {
  const helpId = help && htmlFor ? `${htmlFor}-help` : null;
  const errorId = error && htmlFor ? `${htmlFor}-error` : null;
  return html`<div class="${cx('field', className)}"><label class="label" for="${htmlFor}">${label}${optional && html`<span class="label__hint">Optional</span>`}</label>${control}${help && html`<p class="help"${attrs({ id: helpId })}>${help}</p>`}${error && html`<p class="field-error"${attrs({ id: errorId })} role="alert">${icon('error')}${error}</p>`}</div>`;
}

export function input({ id, name, type = 'text', value, placeholder, mono = false, invalid = false, className, attrs: extra = {} } = {}) {
  const all = attrs({
    class: cx('input', mono && 'mono', className),
    id,
    name: name ?? id,
    type,
    value,
    placeholder,
    'aria-invalid': invalid ? 'true' : null,
    ...extra,
  });
  return html`<input${all}>`;
}

export function textarea({ id, name, value = '', rows = 4, placeholder, mono = false, className, attrs: extra = {} } = {}) {
  const all = attrs({ class: cx('textarea', mono && 'mono', className), id, name: name ?? id, rows, placeholder, ...extra });
  return html`<textarea${all}>${value}</textarea>`;
}

/** select({ id: 'provider', options: [{ value: 'openrouter', label: 'OpenRouter' }], value: 'openrouter' }) */
export function select({ id, name, options, value, className, attrs: extra = {} } = {}) {
  const items = options.map((option) => {
    const optionAttrs = attrs({ value: option.value, selected: option.value === value, disabled: option.disabled });
    return html`<option${optionAttrs}>${option.label}</option>`;
  });
  return html`<select${attrs({ class: cx('select', className), id, name: name ?? id, ...extra })}>${items}</select>`;
}

export function checkbox({ id, name, label, checked = false, className, attrs: extra = {} } = {}) {
  const all = attrs({ class: 'check__box', type: 'checkbox', id, name: name ?? id, checked, ...extra });
  return html`<label class="${cx('check', className)}"><input${all}><span class="check__label">${label}</span></label>`;
}

// ---------------------------------------------------------------------------
// Tabs, stepper, progress, skeleton, dialog
// ---------------------------------------------------------------------------

/**
 * tabs({ label: 'Result view', items: [{ id: 'cards', label: 'Findings', selected: true }, { id: 'raw', label: 'Raw' }] })
 * Emits the tab list only. The app owns the panels and the roving focus.
 */
export function tabs({ label, items, className } = {}) {
  const buttons = items.map((item) => {
    const tabAttrs = attrs({
      class: 'tabs__tab',
      type: 'button',
      role: 'tab',
      id: item.id ? `tab-${item.id}` : null,
      'aria-selected': item.selected ? 'true' : 'false',
      'aria-controls': item.id ? `panel-${item.id}` : null,
      tabindex: item.selected ? null : '-1',
    });
    return html`<button${tabAttrs}>${item.label}${item.count !== undefined && html`<span class="tabs__count">${item.count}</span>`}</button>`;
  });
  return html`<div class="${cx('tabs', className)}" role="tablist" aria-label="${label}">${buttons}</div>`;
}

/**
 * stepper({ label: 'Review steps', steps: [{ label: 'Files', state: 'done' }, { label: 'Review', state: 'current' }, { label: 'Results' }] })
 * States: done | current | todo. The current step carries aria-current="step".
 */
export function stepper({ label, steps, className } = {}) {
  const items = steps.map((step, index) => {
    const state = step.state ?? 'todo';
    const stepAttrs = attrs({
      class: 'stepper__step',
      type: 'button',
      'data-state': state,
      'aria-current': state === 'current' ? 'step' : null,
      ...(step.attrs ?? {}),
    });
    const marker = state === 'done' ? icon('check') : html`<span aria-hidden="true">${index + 1}</span>`;
    return html`<li><button${stepAttrs}><span class="stepper__marker">${marker}</span><span class="stepper__label">${step.label}</span>${state === 'done' && html`<span class="visually-hidden">, done</span>`}</button></li>`;
  });
  return html`<nav class="${cx('stepper', className)}" aria-label="${label}"><ol>${items}</ol></nav>`;
}

/**
 * A radio group for two to four exclusive choices:
 * segmented({ name: 'mode', label: 'Mode', value: 'bounty', options: [{ value: 'bounty', label: 'Bounty' }, { value: 'own-code', label: 'Own code' }] })
 */
export function segmented({ name, label, options, value, className } = {}) {
  const items = options.map((option) => {
    const radio = attrs({ type: 'radio', name, value: option.value, checked: option.value === value });
    return html`<label class="segmented__option"><input${radio}><span>${option.label}</span></label>`;
  });
  return html`<div class="${cx('segmented', className)}" role="radiogroup" aria-label="${label}">${items}</div>`;
}

/** The indeterminate running bar. */
export function progress({ label = 'Working', className } = {}) {
  return html`<div class="${cx('progress', className)}" role="progressbar" aria-label="${label}"></div>`;
}

/** skeleton('title') | skeleton('text', { lines: 3 }) | skeleton('chip') | skeleton('block') */
export function skeleton(kind = 'text', { lines = 1 } = {}) {
  if (kind === 'text') {
    return Array.from({ length: lines }, () => html`<span class="skeleton skeleton--text"></span>`);
  }
  return html`<span class="skeleton skeleton--${kind}"></span>`;
}

/**
 * dialog({ id: 'account-dialog', title: 'Sign in', size: 'sm', body: html`…`, foot: html`…` })
 * The app opens it with showModal(). `closedby="any"` lets a backdrop tap close it.
 */
export function dialog({ id, title, body, foot, size = 'md', closeLabel = 'Close', open = false, className } = {}) {
  const titleId = `${id}-title`;
  const dialogAttrs = attrs({
    class: cx('dialog', `dialog--${size}`, className),
    id,
    'aria-labelledby': titleId,
    closedby: 'any',
    open,
  });
  return html`<dialog${dialogAttrs}><header class="dialog__head"><h2 class="dialog__title" id="${titleId}">${title}</h2><button class="dialog__close" type="button" data-close-dialog aria-label="${closeLabel}">${icon('x')}</button></header><div class="dialog__body">${body}</div>${foot && html`<footer class="dialog__foot">${foot}</footer>`}</dialog>`;
}

// ---------------------------------------------------------------------------
// The finding card
// ---------------------------------------------------------------------------

const RAIL_LABELS = {
  impact: 'Impact',
  observed: 'Observed',
  counter: 'Counterargument',
  gap: 'Evidence gap',
  fix: 'Fix',
  test: 'Test',
  next: 'Next',
};

const RAIL_ORDER = ['impact', 'observed', 'counter', 'gap', 'fix', 'test', 'next'];

/** One row of the ledger: a label in the margin, a coloured spine, the content. */
export function rail(kind, body, { label, status } = {}) {
  if (!Object.hasOwn(RAIL_LABELS, kind)) throw new Error(`Unknown rail kind "${kind}"`);
  const railAttrs = attrs({ class: 'rail', 'data-rail': kind, 'data-status': status ?? null });
  return html`<div${railAttrs}><dt class="rail__label">${label ?? RAIL_LABELS[kind]}</dt><dd class="rail__body">${body}</dd></div>`;
}

function isNone(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return /^(none|n\/a|-)?\.?$/i.test(String(value).trim());
}

function counterRow(counter) {
  const status = String(counter.status ?? 'open').toLowerCase() === 'resolved' ? 'resolved' : 'open';
  const body = html`<p class="rail__quote">${inline(counter.objection)}</p><p class="rail__answer">${statusChip(status)}<span>${inline(counter.why)}</span></p>`;
  return rail('counter', body, { status });
}

function gapRow(gap) {
  if (isNone(gap)) {
    return rail('gap', html`<p class="muted">None. Every step is backed by the supplied files.</p>`, { status: 'none' });
  }
  const items = Array.isArray(gap) ? gap : [gap];
  return rail('gap', html`<ul class="gaps">${items.map((item) => html`<li>${inline(item)}</li>`)}</ul>`, { status: 'open' });
}

/**
 * The signature component. `finding` has the shape parse.mjs returns:
 *
 *   { id, title, severity, basis, locations: Ref[], impact, path: string[],
 *     counterargument: { objection, status, why }, gap, fix, test, next }
 *
 * Options
 *   level   heading level of the title (default 3); 0 makes it a paragraph, for an
 *           example card that is not a section of the page
 *   bar     { name, hash, tag } renders the window bar above the head
 *   code    codeBlock() options for the excerpt shown under the path
 *   rows    which rows to render, in order (default: every row with content)
 *   reveal  add the entrance animation (rows and spine draw in, 40 ms apart)
 *   refHref (ref) => url, to make the ref chips links
 */
export function findingCard(finding, { level = 3, bar, code, rows, reveal = false, refHref, id, className } = {}) {
  const findingId = finding.id ?? 'F-1';
  const titleId = `${id ?? slug(findingId)}-title`;
  const basis = BASIS_STATUS[finding.basis];
  const locations = finding.locations ?? [];

  const available = {
    impact: () => finding.impact && rail('impact', html`<p>${inline(finding.impact)}</p>`),
    observed: () => {
      const steps = finding.path ?? [];
      if (!steps.length && !code) return null;
      const list = steps.length ? html`<ol class="steps">${steps.map((step) => html`<li>${inline(step)}</li>`)}</ol>` : '';
      return rail('observed', html`${list}${code && codeBlock(code)}`);
    },
    counter: () => finding.counterargument && counterRow(finding.counterargument),
    gap: () => (finding.gap === undefined ? null : gapRow(finding.gap)),
    fix: () => finding.fix && rail('fix', html`<p>${inline(finding.fix)}</p>`),
    test: () => {
      if (!finding.test) return null;
      const block = typeof finding.test === 'string' ? { code: finding.test, numbers: false, copy: true } : finding.test;
      return rail('test', codeBlock(block));
    },
    next: () => finding.next && rail('next', html`<p class="rail__next">${icon('arrow-right')}<span>${inline(finding.next)}</span></p>`),
  };
  const body = (rows ?? RAIL_ORDER).map((kind) => available[kind]?.()).filter(Boolean);

  const barMarkup = bar
    ? html`<div class="finding__bar">${icon('file')}<span class="finding__file">${bar.name}</span>${bar.hash && hashChip(bar.hash)}${bar.tag && html`<span class="finding__tag">${bar.tag}</span>`}</div>`
    : '';
  const refs = locations.length
    ? html`<ul class="finding__refs" aria-label="Locations">${locations.map((ref) => html`<li>${refChip(ref, { href: refHref?.(ref) })}</li>`)}</ul>`
    : '';
  const cardAttrs = attrs({
    class: cx('finding', reveal && 'finding--reveal', className),
    id,
    'data-sev': String(finding.severity ?? 'unrated').toLowerCase(),
    'aria-labelledby': titleId,
  });

  // level 0: the title is a paragraph, for a card shown as an example rather than as a section.
  const titleTag = level ? `h${level}` : 'p';
  return html`<article${cardAttrs}>${barMarkup}<header class="finding__head"><div class="finding__tags"><span class="finding__id">${findingId}</span>${severityChip(finding.severity)}${basis && statusChip(basis)}</div>${raw(`<${titleTag} class="finding__title" id="${esc(titleId)}">`)}${inline(finding.title)}${raw(`</${titleTag}>`)}${refs}</header><dl class="finding__rows">${body}</dl></article>`;
}
