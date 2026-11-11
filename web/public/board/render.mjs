// What the board shows, as trees (tree.mjs). The site build turns them into the
// page; the page script turns them into DOM again when newer data arrives or a
// filter changes. Every figure comes from the data as it is: nothing here
// estimates, converts a currency or fills a gap.

import { ASSET_KINDS, PLATFORMS, platform, programLink } from './platforms.mjs';
import { h } from './tree.mjs';

// --- Words and figures -------------------------------------------------------

export const count = (value) => Number(value).toLocaleString('en-US');

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

/** 15500000 -> "$15.5M", 250000 -> "$250K", 8500 -> "$8,500"; another currency keeps its code. */
export function money(amount, currency = 'USD') {
  if (typeof amount !== 'number') return '';
  const short = amount >= 1e6 ? `${trim(amount / 1e6)}M` : amount >= 1e5 ? `${trim(amount / 1e3)}K` : count(Math.round(amount));
  const symbol = SYMBOLS[currency];
  return symbol ? `${symbol}${short}` : `${short} ${currency ?? ''}`.trim();
}

function trim(value) {
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "5 Nov", or "5 Nov 2025" when the year differs from `today`'s. */
export function shortDate(day, today) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const [year, month, date] = day.split('-').map(Number);
  const text = `${date} ${MONTHS[month - 1]}`;
  return today && today.slice(0, 4) === String(year) ? text : `${text} ${year}`;
}

/** "Nov 2025": for a date the board only knows to the month. */
export function monthOf(day) {
  const [year, month] = day.split('-').map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** 7 -> "7 h", 52 -> "2 d", 3258 -> "136 d". */
export function hours(value) {
  return value < 48 ? `${value} h` : `${Math.round(value / 24)} d`;
}

const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** What filing costs at one program, in a few words; '' when it costs nothing the platform states. */
export function costLabel(cost) {
  if (!cost) return '';
  const what = cost.type === 'deposit' ? 'stake' : 'fee';
  return typeof cost.amount === 'number' ? `${money(cost.amount)} ${what}` : `${what[0].toUpperCase()}${what.slice(1)} to file`;
}

// --- Small parts -------------------------------------------------------------

const chip = (label, tone = 'neutral', extra = {}) => h('span', { class: 'chip', 'data-tone': tone, ...extra }, [label]);

function platformChip(id) {
  const known = platform(id);
  return h('span', { class: 'board-platform', 'data-platform': id }, [known ? known.name : id]);
}

/** A program's name as a link to its page on the platform, when the link is one of that platform's. */
function programName(program) {
  const href = programLink(program.p, program.url);
  if (!href) return h('span', { class: 'board-name' }, [program.name]);
  return h('a', { class: 'board-name link link--external', href, target: '_blank', rel: 'noopener noreferrer' }, [program.name, h('span', { class: 'icon icon--arrow-up-right', 'aria-hidden': 'true' })]);
}

/**
 * A line for a run of [day, value] points, oldest first; null for fewer than
 * four. A run that moves less than 2% is drawn flat, so noise does not read as
 * a trend.
 */
export function spark(points, label) {
  if (!Array.isArray(points) || points.length < 4) return null;
  const values = points.map((point) => point[1]);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const first = Date.parse(points[0][0]);
  const span = Math.max(1, Date.parse(points.at(-1)[0]) - first);
  const flat = high === 0 || (high - low) / high < 0.02;
  const x = (point) => ((Date.parse(point[0]) - first) / span) * 100;
  const y = (value) => (flat ? 14 : 25 - ((value - low) / (high - low)) * 22);
  const line = points.map((point) => `${x(point).toFixed(1)},${y(point[1]).toFixed(1)}`).join(' ');
  const change = values.at(-1) - values[0];
  const trend = flat || change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
  const text = `${label}: ${count(values[0])} on ${shortDate(points[0][0])}, ${count(values.at(-1))} on ${shortDate(points.at(-1)[0])}`;
  return h('svg', { class: 'board-spark', 'data-trend': trend, viewBox: '0 0 100 28', preserveAspectRatio: 'none', role: 'img', 'aria-label': text }, [
    h('polygon', { class: 'board-spark__area', points: `0,28 ${line} 100,28` }),
    h('polyline', { class: 'board-spark__line', points: line, 'vector-effect': 'non-scaling-stroke' }),
  ]);
}

// --- The top figures ---------------------------------------------------------

function tile(figure, label, note, tone = null) {
  return h('li', { class: 'board-tile', 'data-tone': tone }, [
    h('span', { class: 'board-tile__n num' }, [figure]),
    h('span', { class: 'board-tile__label meta' }, [label]),
    note && h('span', { class: 'board-tile__note fine' }, [note]),
  ]);
}

export function tiles(snapshot) {
  const { totals } = snapshot;
  return h('ul', { class: 'board-tiles' }, [
    tile(count(totals.programs), 'Programs open', `${count(totals.paying)} pay a bounty, ${count(totals.vdps)} take reports without one`),
    tile(count(totals.assets), 'Assets in scope', `${count(totals.wildcards)} of them wildcards`),
    tile(count(totals.launched30), `Launched in ${snapshot.newDays} days`, `${plural(totals.new30, 'asset')} added to scope in the same time`),
    tile(count(totals.withCost), 'Charge to file', 'a fee or a stake with every report', 'accent'),
    tile(count(totals.kyc), 'Ask for KYC', 'an identity check to join or be paid'),
    totals.top && tile(money(totals.top.max, totals.top.cur), 'Highest reward', totals.top.name),
  ]);
}

// --- By platform -------------------------------------------------------------

/** What filing takes on one platform, as short phrases. */
export function filingNotes(entry) {
  const notes = [];
  if (entry.withCost) {
    const what = entry.costType === 'deposit' ? 'A stake' : 'A fee';
    const range = typeof entry.costMin === 'number'
      ? entry.costMin === entry.costMax ? `, ${money(entry.costMin)}` : `, ${money(entry.costMin)} to ${money(entry.costMax)}`
      : '';
    notes.push(`${what} on ${count(entry.withCost)}${range}`);
  }
  if (entry.kyc) notes.push(`KYC on ${count(entry.kyc)}`);
  if (entry.poc) notes.push(`Proof of concept required on ${count(entry.poc)}`);
  if (typeof entry.respMedianH === 'number') notes.push(`First answer in ${hours(entry.respMedianH)}, the median of ${count(entry.respOf)}`);
  if (typeof entry.paid90 === 'number') notes.push(`${money(entry.paid90)} paid in 90 days`);
  if (typeof entry.reports90 === 'number') notes.push(`${count(entry.reports90)} reports in 90 days`);
  if (typeof entry.reports === 'number') notes.push(`${count(entry.reports)} reports to date`);
  if (typeof entry.findings === 'number') notes.push(`${count(entry.findings)} findings filed to date`);
  return notes;
}

const cellLabel = (text) => h('span', { class: 'cell-label' }, [text]);

const EMPTY = '–';

function figureCell(label, value, chart) {
  return h('td', { class: value === EMPTY ? 'num board-figure is-empty' : 'num board-figure' }, [cellLabel(label), h('span', { class: 'board-figure__n' }, [value]), chart]);
}

function platformRow(entry, snapshot) {
  const known = platform(entry.id);
  if (!known) return null;
  const name = h('th', { scope: 'row', class: 'board-platforms__name' }, [
    h('a', { class: 'link link--external', href: known.home, target: '_blank', rel: 'noopener noreferrer' }, [known.name, h('span', { class: 'icon icon--arrow-up-right', 'aria-hidden': 'true' })]),
    h('span', { class: 'board-platforms__side fine' }, [known.side === 'web3' ? 'Web3' : 'Web2']),
    entry.stale && chip(`As of ${shortDate(entry.asOf, snapshot.day)}`, 'unproven', { class: 'chip chip--dashed' }),
  ]);
  if (entry.missing) return h('tr', {}, [name, h('td', { colspan: 7, class: 'muted' }, ['Not read yet.'])]);
  const notes = filingNotes(entry);
  const idle = entry.programs === 0 && entry.contests === 0;
  return h('tr', { 'data-platform': entry.id }, [
    name,
    figureCell('Programs', count(entry.programs)),
    figureCell('Paying', count(entry.paying), spark(entry.series?.paying, `${known.name}, paying programs`)),
    figureCell('Assets in scope', entry.assets ? count(entry.assets) : EMPTY, spark(entry.series?.assets, `${known.name}, assets in scope`)),
    figureCell(`Added to scope, ${snapshot.newDays} d`, entry.new30 ? `+${count(entry.new30)}` : EMPTY),
    figureCell(`Launched, ${snapshot.newDays} d`, entry.launched30 ? count(entry.launched30) : EMPTY),
    h('td', { class: entry.top ? 'board-top' : 'board-top is-empty' }, [cellLabel('Highest reward'), entry.top ? [h('span', { class: 'num board-figure__n' }, [money(entry.top.max, entry.top.cur)]), h('span', { class: 'fine board-top__name' }, [entry.top.name])] : EMPTY]),
    h('td', { class: 'board-filing' }, [cellLabel('To file there'), idle ? h('span', { class: 'muted' }, ['No audit is open today.']) : notes.length ? h('ul', { class: 'board-notes' }, notes.map((note) => h('li', {}, [note]))) : h('span', { class: 'muted' }, ['Nothing published.'])]),
  ]);
}

export function platformTable(snapshot) {
  const head = ['Platform', 'Programs', 'Paying', 'Assets in scope', `Added to scope, ${snapshot.newDays} d`, `Launched, ${snapshot.newDays} d`, 'Highest reward', 'To file there'];
  return h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Figures by platform' }, [
    h('table', { class: 'table stack-table stack-table--wide board-platforms' }, [
      h('caption', { class: 'visually-hidden' }, ['Figures by platform']),
      h('thead', {}, [h('tr', {}, head.map((label, index) => h('th', { scope: 'col', class: index > 0 && index < 6 ? 'num' : null }, [label])))]),
      h('tbody', {}, snapshot.platforms.map((entry) => platformRow(entry, snapshot))),
    ]),
  ]);
}

// --- What filing costs -------------------------------------------------------

/** The platforms that charge, ask for KYC or require a proof, with their counts: the lines of the cost panel. */
export function costLines(snapshot) {
  const named = (field, text) => snapshot.platforms
    .filter((entry) => entry[field] > 0)
    .map((entry) => ({ id: entry.id, name: platform(entry.id)?.name ?? entry.id, n: entry[field], text: text(entry) }));
  return {
    cost: named('withCost', (entry) => {
      if (typeof entry.costMin !== 'number') return 'the amount is shown when you submit';
      const what = entry.costType === 'deposit' ? 'stake, returned for a valid report' : 'fee';
      return entry.costMin === entry.costMax ? `${money(entry.costMin)} ${what}` : `${money(entry.costMin)} to ${money(entry.costMax)} ${what}`;
    }),
    kyc: named('kyc', (entry) => `of ${count(entry.kycKnown)}`),
    poc: named('poc', (entry) => `of ${count(entry.pocKnown)}`),
  };
}

function costColumn(figure, title, rows) {
  return h('div', { class: 'board-cost__col' }, [
    h('p', { class: 'board-cost__n num' }, [count(figure)]),
    h('h3', { class: 'board-cost__title' }, [title]),
    h('ul', { class: 'board-cost__rows' }, rows.map((row) => h('li', {}, [h('span', { class: 'board-cost__who' }, [`${row.name} `, h('span', { class: 'num' }, [count(row.n)])]), h('span', { class: 'fine' }, [row.text])]))),
  ]);
}

export function costPanel(snapshot) {
  const lines = costLines(snapshot);
  const total = (rows) => rows.reduce((sum, row) => sum + row.n, 0);
  return h('div', { class: 'board-cost' }, [
    costColumn(total(lines.cost), 'programs charge you to file a report', lines.cost),
    costColumn(total(lines.kyc), 'ask for an identity check', lines.kyc),
    costColumn(total(lines.poc), 'require a proof of concept', lines.poc),
  ]);
}

// --- What is new -------------------------------------------------------------

/**
 * @param {object} snapshot
 * @param {{ limit?: number, since?: string | null }} [options]  `since`: the day of this browser's last visit; newer rows are marked.
 */
export function freshList(snapshot, { limit = 14, since = null } = {}) {
  const rows = snapshot.fresh.slice(0, limit);
  if (!rows.length) return h('p', { class: 'muted' }, [`Nothing launched or added scope in the last ${snapshot.newDays} days.`]);
  return h('ol', { class: 'board-fresh' }, rows.map((row) => {
    const launched = row.what === 'launched';
    const unseen = since && row.date > since;
    return h('li', { class: 'board-fresh__row', 'data-what': row.what }, [
      h('span', { class: 'board-fresh__date num fine' }, [shortDate(row.date, snapshot.day)]),
      h('span', { class: 'board-fresh__main' }, [
        programName(row),
        h('span', { class: 'board-fresh__what' }, [
          platformChip(row.p),
          launched ? chip(row.by === 'seen' ? 'First listed' : 'Launched', 'ok') : chip(`+${plural(row.n, 'asset')}`, 'observed'),
          unseen && chip('New to you', 'unproven', { class: 'chip chip--dashed' }),
        ]),
      ]),
      h('span', { class: 'board-fresh__max num' }, [typeof row.max === 'number' ? money(row.max, row.cur) : row.kind === 'vdp' ? 'No bounty' : '']),
    ]);
  }));
}

/** How many rows of what is new are newer than `since`: [launched, scope]. */
export function unseenCounts(snapshot, since) {
  const newer = snapshot.fresh.filter((row) => since && row.date > since);
  return [newer.filter((row) => row.what === 'launched').length, newer.filter((row) => row.what === 'scope').length];
}

// --- Audit contests ----------------------------------------------------------

export function contestList(snapshot) {
  const quiet = PLATFORMS.filter((known) => ['sherlock', 'code4rena', 'cantina', 'immunefi'].includes(known.id) && !snapshot.contests.some((contest) => contest.p === known.id)).map((known) => known.name);
  const none = quiet.length ? h('p', { class: 'fine board-contests__quiet' }, [`No public audit contest is open on ${quiet.join(', ').replace(/, ([^,]+)$/, ' or $1')} today.`]) : null;
  if (!snapshot.contests.length) return h('div', {}, [h('p', { class: 'muted' }, ['No public audit contest is open today on the platforms the board reads.']), none]);
  return h('div', {}, [
    h('ul', { class: 'board-contests' }, snapshot.contests.map((contest) => {
      const left = daysBetween(snapshot.day, contest.ends);
      return h('li', { class: 'board-contest' }, [
        h('div', { class: 'board-contest__head' }, [programName(contest), platformChip(contest.p)]),
        h('p', { class: 'board-contest__pool num' }, [typeof contest.pool === 'number' ? money(contest.pool, contest.cur) : 'Pool not published', h('span', { class: 'fine' }, [' pool'])]),
        h('p', { class: 'fine' }, [`${shortDate(contest.starts, snapshot.day)} to ${shortDate(contest.ends, snapshot.day)}, ${left <= 0 ? 'ends today' : `${plural(left, 'day')} left`}`]),
        h('p', { class: 'board-contest__chips' }, [contest.cost && chip(costLabel(contest.cost), 'unproven'), contest.kyc === 1 && chip('KYC', 'neutral'), contest.poc === 1 && chip('PoC required', 'neutral')]),
      ]);
    })),
    none,
  ]);
}

// --- Every program -----------------------------------------------------------

export const SORTS = Object.freeze([
  ['max', 'Highest reward'],
  ['new', 'Newest'],
  ['scope', 'Scope added lately'],
  ['assets', 'Most assets'],
  ['paid', 'Most paid in 90 days'],
  ['resp', 'Fastest first answer'],
  ['name', 'Name'],
]);

const compare = {
  // Figures are compared as published; currencies are not converted.
  max: (a, b) => (b.max ?? -1) - (a.max ?? -1),
  new: (a, b) => (a.launched === b.launched ? 0 : (b.launched ?? '') < (a.launched ?? '') ? -1 : 1),
  scope: (a, b) => (a.scopeAt === b.scopeAt ? (b.new30 ?? 0) - (a.new30 ?? 0) : (b.scopeAt ?? '') < (a.scopeAt ?? '') ? -1 : 1),
  assets: (a, b) => (b.assets ?? -1) - (a.assets ?? -1),
  paid: (a, b) => (b.paid90 ?? -1) - (a.paid90 ?? -1),
  resp: (a, b) => (a.resp ?? Infinity) - (b.resp ?? Infinity),
  name: (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
};

/**
 * The programs a set of filters leaves, in order.
 *
 * @param {object[]} programs
 * @param {{ query?: string, platform?: string, pays?: boolean, free?: boolean, noKyc?: boolean, fresh?: boolean, sort?: string }} [filters]
 */
export function select(programs, { query = '', platform: only = '', pays = false, free = false, noKyc = false, fresh = false, sort = 'max' } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = programs.filter((program) => {
    if (program.kind === 'contest') return false;
    if (only && program.p !== only) return false;
    if (pays && program.kind !== 'bounty') return false;
    if (free && program.cost) return false;
    if (noKyc && program.kyc === 1) return false;
    if (fresh && !program.fresh && !program.scopeAt) return false;
    const text = `${program.name} ${platform(program.p)?.name ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const order = compare[sort] ?? compare.max;
  return kept.sort((a, b) => order(a, b) || compare.name(a, b));
}

/** Marks the programs launched within the snapshot's window, so "new" can be filtered without the clock. */
export function withFresh(programs, snapshot) {
  return programs.map((program) => {
    const age = program.launched ? daysBetween(program.launched, snapshot.day) : null;
    return age !== null && age >= 0 && age < snapshot.newDays ? { ...program, fresh: true } : program;
  });
}

function scopeText(program) {
  if (typeof program.assets !== 'number') return null;
  const kinds = ASSET_KINDS.filter(([id]) => program.kinds?.[id]).map(([id, label]) => `${count(program.kinds[id])} ${label.toLowerCase()}`);
  return [h('span', { class: 'num' }, [plural(program.assets, 'asset')]), kinds.length > 0 && h('span', { class: 'fine board-row__kinds' }, [kinds.slice(0, 3).join(', ')])];
}

function activityText(program) {
  const lines = [];
  if (typeof program.reports90 === 'number') lines.push(`${plural(program.reports90, 'report')} in 90 d`);
  if (typeof program.paid90 === 'number' && program.paid90 > 0) lines.push(`${money(program.paid90)} paid in 90 d`);
  if (typeof program.resp === 'number') lines.push(`first answer in ${hours(program.resp)}`);
  if (typeof program.reports === 'number') lines.push(`${plural(program.reports, 'report')} to date`);
  if (typeof program.findings === 'number') lines.push(`${plural(program.findings, 'finding')} filed`);
  return lines;
}

/** A cell of the program table; one with nothing to show is marked, so a phone can leave it out. */
function cell(className, label, content) {
  const empty = content === null || content === undefined;
  return h('td', { class: empty ? `${className} is-empty` : className }, [cellLabel(label), empty ? h('span', { class: 'muted' }, [EMPTY]) : content]);
}

function programRow(program, snapshot) {
  const filing = [
    program.cost && chip(costLabel(program.cost), 'unproven'),
    program.kyc === 1 && chip('KYC', 'neutral'),
    program.poc === 1 && chip('PoC required', 'neutral'),
    program.invite === 1 && chip('Invite only', 'neutral'),
  ].filter(Boolean);
  const activity = activityText(program);
  const scope = scopeText(program);
  const since = program.launched ? (program.by === 'seen' && daysBetween(program.launched, snapshot.day) > 60 ? monthOf(program.launched) : shortDate(program.launched, snapshot.day)) : null;
  return h('tr', { class: 'board-row' }, [
    h('th', { scope: 'row', class: 'board-row__name' }, [
      programName(program),
      h('span', { class: 'board-row__tags' }, [platformChip(program.p), program.kind === 'vdp' && chip('No bounty', 'neutral'), program.fresh && chip('New', 'ok'), !program.fresh && program.scopeAt && chip(`+${plural(program.new30, 'asset')}`, 'observed')]),
    ]),
    cell('num board-row__max', 'Highest reward', typeof program.max === 'number' ? money(program.max, program.cur) : null),
    cell('board-row__scope', 'Scope', scope),
    cell('board-row__filing', 'To file', filing.length ? h('span', { class: 'board-row__chips' }, filing) : null),
    cell('board-row__activity fine', 'Activity', activity.length ? activity.join(' · ') : null),
    cell('num board-row__since fine', program.by === 'seen' ? 'Listed since' : 'Launched', since),
  ]);
}

/** The program table for the rows a filter leaves. */
export function programTable(rows, snapshot, { limit = 40 } = {}) {
  const head = [['Program', null], ['Highest reward', 'num'], ['Scope', null], ['To file', null], ['Activity', null], ['Since', 'num']];
  return h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Programs' }, [
    h('table', { class: 'table table--dense stack-table stack-table--wide board-programs' }, [
      h('caption', { class: 'visually-hidden' }, ['Programs']),
      h('thead', {}, [h('tr', {}, head.map(([label, className]) => h('th', { scope: 'col', class: className }, [label])))]),
      h('tbody', {}, rows.slice(0, limit).map((program) => programRow(program, snapshot))),
    ]),
  ]);
}

/** "Showing 40 of 1,420 programs." */
export function shownLine(shown, total, all) {
  if (total === 0) return 'No program matches. Clear a filter or shorten the search.';
  const of = total === all ? `${count(all)} programs` : `${count(total)} matching programs`;
  return shown >= total ? `All ${of}.` : `Showing ${count(shown)} of ${of}.`;
}

/** The line under the page title that says how fresh the board is. */
export function updatedLine(snapshot) {
  const live = snapshot.platforms.filter((entry) => !entry.missing);
  const stale = live.filter((entry) => entry.stale).map((entry) => platform(entry.id)?.name ?? entry.id);
  const base = `Read ${shortDate(snapshot.day)} from ${live.length} platforms' public lists.`;
  return stale.length ? `${base} ${stale.join(' and ')} could not be read that day and ${stale.length === 1 ? 'shows its' : 'show their'} last good figures.` : base;
}
