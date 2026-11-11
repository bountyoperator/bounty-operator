// Turns the program records of one day into what the board shows: the public
// program list, the per-platform figures, the list of what is new, and one
// more point on each platform's history. Pure: the same records, state and day
// give the same output.
//
// "New" needs memory. `state` remembers, for every program, the day the board
// first saw it and the day it first saw each of its assets, as day numbers
// (days since 2020-01-01; 0 means "already there when tracking began", so its
// real date is not known and it is never called new).

import { PLATFORMS } from '../../web/public/board/platforms.mjs';
import { ASSET_KIND_IDS } from './normalize.mjs';

const EPOCH = Date.UTC(2020, 0, 1);
const DAY_MS = 86400000;

export const dayNumber = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - EPOCH) / DAY_MS);
export const dayOf = (number) => new Date(EPOCH + number * DAY_MS).toISOString().slice(0, 10);

/** How long a launch or a new asset counts as new. */
export const NEW_DAYS = 30;
const FRESH_ROWS = 60;
const SERIES_POINTS = 80;

export function emptyState() {
  return { v: 1, since: null, programs: {} };
}

/**
 * Folds one day's records into the state. Only platforms in `platforms` are
 * touched: a platform whose read failed keeps what it had.
 *
 * @param {ReturnType<typeof emptyState>} state  Changed in place and returned.
 * @param {object[]} programs  Records from normalize.mjs.
 * @param {string} today 'YYYY-MM-DD'
 * @param {{ seed?: boolean, quietNew?: boolean }} [options]  `seed` records everything as already there
 *   (the first run). `quietNew` does the same for programs not seen before: for the day a new source of
 *   a platform is added, when what appears for the first time is not a day's launches.
 */
export function remember(state, programs, today, { seed = false, quietNew = false } = {}) {
  const now = dayNumber(today);
  const platformOf = (id) => id.slice(0, id.indexOf(':'));
  // The first run, and the first day of a platform the board starts to follow
  // later, arrive whole: none of it is new that day.
  const tracked = new Set(seed || state.since === null ? [] : Object.keys(state.programs).map(platformOf));
  state.since ??= today;
  const read = new Set(programs.map((program) => program.platform));
  const present = new Set();
  for (const program of programs) {
    present.add(program.id);
    const known = state.programs[program.id];
    const entry = known ?? { f: tracked.has(program.platform) && !quietNew ? now : 0, a: {} };
    delete entry.gone;
    for (const key of program.assetKeys) {
      if (key in entry.a) continue;
      const dated = program.assetDates[key];
      // An asset the platform dates itself keeps that date; one found on a later run is new that day.
      entry.a[key] = dated ? Math.max(1, dayNumber(dated)) : !known && entry.f === 0 ? 0 : now;
    }
    state.programs[program.id] = entry;
  }
  for (const [id, entry] of Object.entries(state.programs)) {
    if (present.has(id) || !read.has(platformOf(id))) continue;
    // A program that left the list is remembered with its assets: lists drop a
    // program for a day and bring it back, and a return is neither a launch nor new scope.
    entry.gone ??= now;
  }
  return state;
}

/** What the state says about one program on `today`. */
export function derive(program, state, today) {
  const now = dayNumber(today);
  const entry = state.programs[program.id] ?? { f: 0, a: {} };
  const seen = entry.f > 0 ? dayOf(entry.f) : null;
  const launched = program.launched ?? seen;
  // Only the assets in scope today count; the state also remembers ones that have left.
  const dates = program.assetKeys.map((key) => entry.a[key] ?? 0).filter((value) => value > 0);
  const recent = dates.filter((value) => now - value < NEW_DAYS && value <= now);
  return {
    launched,
    // 'platform' when the platform publishes the date, 'seen' when it is the day the board first listed the program.
    launchedBy: program.launched ? 'platform' : seen ? 'seen' : null,
    new30: recent.length,
    scopeAt: recent.length ? dayOf(Math.max(...recent)) : null,
    isNew: launched !== null && now - dayNumber(launched) < NEW_DAYS && dayNumber(launched) <= now,
  };
}

const flag = (value) => (value === true ? 1 : value === false ? 0 : undefined);

/** One program as the page receives it: short, and without a field that has no value. */
export function publicProgram(program, derived) {
  const kinds = Object.fromEntries(ASSET_KIND_IDS.filter((kind) => program.kinds[kind] > 0).map((kind) => [kind, program.kinds[kind]]));
  const out = {
    id: program.id,
    p: program.platform,
    kind: program.kind,
    name: program.name,
    url: program.url,
    max: program.max ?? undefined,
    cur: program.max === null ? undefined : program.cur ?? undefined,
    assets: program.assets ?? undefined,
    wild: program.wildcards || undefined,
    kinds: Object.keys(kinds).length ? kinds : undefined,
    launched: derived.launched ?? undefined,
    by: derived.launchedBy === 'seen' ? 'seen' : undefined,
    cost: program.cost ? { type: program.cost.type, amount: program.cost.amount ?? undefined } : undefined,
    kyc: flag(program.kyc),
    poc: flag(program.poc),
    triaged: flag(program.triaged),
    invite: program.invite ? 1 : undefined,
    resp: program.firstResponseH ?? undefined,
    bountyH: program.bountyH ?? undefined,
    eff: program.efficiency ?? undefined,
    reports90: program.reports90 ?? undefined,
    paid90: program.paid90 ?? undefined,
    resolved: program.resolved ?? undefined,
    reports: program.reports ?? undefined,
    findings: program.findings ?? undefined,
    lastReport: program.lastReport ?? undefined,
    starts: program.starts ?? undefined,
    ends: program.ends ?? undefined,
    pool: program.pool ?? undefined,
    new30: derived.new30 || undefined,
    scopeAt: derived.scopeAt ?? undefined,
  };
  return JSON.parse(JSON.stringify(out));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

const sum = (values) => values.reduce((total, value) => total + value, 0);

/** The figures of one platform from its records. */
export function platformFigures(programs, derivedById) {
  const open = programs.filter((program) => program.kind !== 'contest');
  const paying = open.filter((program) => program.kind === 'bounty');
  const dollars = paying.filter((program) => program.max !== null && program.cur === 'USD');
  const top = [...paying].filter((program) => program.max !== null).sort((a, b) => b.max - a.max)[0] ?? null;
  const known = (field) => open.filter((program) => typeof program[field] === 'boolean');
  const responses = open.map((program) => program.firstResponseH).filter((value) => Number.isInteger(value));
  const counted = (field) => open.map((program) => program[field]).filter((value) => typeof value === 'number');
  const figures = {
    programs: open.length,
    paying: paying.length,
    vdps: open.length - paying.length,
    contests: programs.length - open.length,
    assets: sum(open.map((program) => program.assets ?? 0)),
    wildcards: sum(open.map((program) => program.wildcards)),
    launched30: open.filter((program) => derivedById.get(program.id)?.isNew).length,
    new30: sum(open.map((program) => derivedById.get(program.id)?.new30 ?? 0)),
    withCost: open.filter((program) => program.cost).length,
    kyc: known('kyc').filter((program) => program.kyc).length,
    kycKnown: known('kyc').length,
    poc: known('poc').filter((program) => program.poc).length,
    pocKnown: known('poc').length,
    top: top ? { name: top.name, url: top.url, max: top.max, cur: top.cur } : null,
    // The middle reward ceiling, in dollars, of the programs that publish one in dollars.
    medianMax: median(dollars.map((program) => program.max)),
    medianOf: dollars.length,
  };
  // What a report costs to file, where the platform says how much: the lowest and the highest.
  const costs = open.map((program) => program.cost?.amount).filter((value) => typeof value === 'number');
  if (costs.length) {
    figures.costMin = Math.min(...costs);
    figures.costMax = Math.max(...costs);
  }
  const costTypes = new Set(open.map((program) => program.cost?.type).filter(Boolean));
  if (costTypes.size === 1) figures.costType = [...costTypes][0];
  if (responses.length) {
    figures.respMedianH = median(responses);
    figures.respOf = responses.length;
  }
  for (const field of ['reports90', 'paid90', 'reports', 'findings']) {
    const values = counted(field);
    if (values.length) {
      figures[field] = Math.round(sum(values));
      figures[`${field}Of`] = values.length;
    }
  }
  return figures;
}

/** The history point of one platform: [programs, paying, assets, wildcards]. */
export const historyPoint = (figures) => [figures.programs, figures.paying, figures.assets, figures.wildcards];

/** Sets today's point; a second run on the same day replaces the first. Returns `history`. */
export function addHistory(history, today, figuresById) {
  history.v = 1;
  history.days ??= [];
  const point = { d: today, p: Object.fromEntries(Object.entries(figuresById).map(([id, figures]) => [id, historyPoint(figures)])) };
  const at = history.days.findIndex((entry) => entry.d === today);
  if (at >= 0) history.days[at] = { d: today, p: { ...history.days[at].p, ...point.p } };
  else history.days.push(point);
  history.days.sort((a, b) => (a.d < b.d ? -1 : 1));
  return history;
}

/** At most SERIES_POINTS points of one figure of one platform, oldest first: [[day, value], ...]. */
export function series(history, platformId, index) {
  const points = (history.days ?? []).filter((entry) => Array.isArray(entry.p?.[platformId])).map((entry) => [entry.d, entry.p[platformId][index]]);
  if (points.length <= SERIES_POINTS) return points;
  // Keep the newest point and thin the rest evenly.
  const step = (points.length - 1) / (SERIES_POINTS - 1);
  return Array.from({ length: SERIES_POINTS }, (_, at) => points[Math.round(at * step)]);
}

/**
 * Everything the page needs for one day.
 *
 * @param {object} input
 * @param {object[]} input.programs  Today's records, every platform that could be read.
 * @param {object[]} input.carried  Public programs kept from the last good read of a platform that failed today.
 * @param {Record<string, { asOf: string, figures: object }>} input.carriedFigures  The same platforms' last figures.
 * @param {ReturnType<typeof emptyState>} input.state  Already updated by remember().
 * @param {{ days?: object[] }} input.history  Already updated by addHistory().
 * @param {string} input.today
 * @param {string} input.at  ISO time of the read.
 * @param {Record<string, string>} input.failed  Platform id to the reason its read failed.
 */
export function assemble({ programs, carried = [], carriedFigures = {}, state, history, today, at, failed = {} }) {
  const derivedById = new Map(programs.map((program) => [program.id, derive(program, state, today)]));
  const listed = [...programs.map((program) => publicProgram(program, derivedById.get(program.id))), ...carried];

  const platforms = PLATFORMS.map((platform) => {
    const own = programs.filter((program) => program.platform === platform.id);
    const stale = platform.id in failed;
    const base = stale ? carriedFigures[platform.id] ?? null : { asOf: today, figures: platformFigures(own, derivedById) };
    if (!base) return { id: platform.id, missing: true };
    return {
      id: platform.id,
      asOf: base.asOf,
      ...(stale ? { stale: true } : {}),
      ...base.figures,
      series: { paying: series(history, platform.id, 1), assets: series(history, platform.id, 2) },
    };
  });

  const live = platforms.filter((platform) => !platform.missing);
  const add = (field) => sum(live.map((platform) => platform[field] ?? 0));
  const tops = live.map((platform) => platform.top).filter((top) => top && top.cur === 'USD').sort((a, b) => b.max - a.max);
  const totals = {
    platforms: live.length,
    programs: add('programs'),
    paying: add('paying'),
    vdps: add('vdps'),
    contests: add('contests'),
    assets: add('assets'),
    wildcards: add('wildcards'),
    launched30: add('launched30'),
    new30: add('new30'),
    withCost: add('withCost'),
    kyc: add('kyc'),
    top: tops[0] ?? null,
  };

  const fresh = [];
  for (const program of listed) {
    if (program.kind === 'contest') continue;
    const row = { id: program.id, p: program.p, name: program.name, url: program.url, max: program.max, cur: program.cur, kind: program.kind };
    const age = program.launched ? dayNumber(today) - dayNumber(program.launched) : null;
    if (age !== null && age >= 0 && age < NEW_DAYS) fresh.push({ ...row, what: 'launched', date: program.launched, by: program.by });
    else if (program.scopeAt) fresh.push({ ...row, what: 'scope', date: program.scopeAt, n: program.new30 });
  }
  // Newest day first; within a day launches lead, then the larger rewards.
  const weight = (row) => (row.what === 'launched' ? 2 : 0) + (row.kind === 'bounty' ? 1 : 0);
  fresh.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : weight(b) - weight(a) || (b.max ?? 0) - (a.max ?? 0) || (b.n ?? 0) - (a.n ?? 0)));

  const contests = listed.filter((program) => program.kind === 'contest')
    .map(({ id, p, name, url, starts, ends, pool, cur, cost, kyc, poc }) => ({ id, p, name, url, starts, ends, pool, cur, cost, kyc, poc }))
    .sort((a, b) => (a.ends < b.ends ? -1 : 1));

  return {
    programs: { v: 1, at, day: today, programs: listed },
    snapshot: JSON.parse(JSON.stringify({
      v: 1,
      at,
      day: today,
      since: state.since,
      newDays: NEW_DAYS,
      totals,
      platforms,
      fresh: fresh.slice(0, FRESH_ROWS),
      freshCount: fresh.length,
      contests,
      failed: Object.keys(failed),
    })),
  };
}
