// The published Paydirt results, read at build time, and everything the
// benchmark pages compute from them. No default export: the generator treats
// this module as a helper.
//
// Source: the folder `bench/bench.mjs publish` writes, web/public/bench by
// default. PAYDIRT_PUBLISHED_DIR points the build at another folder (a
// preview publish). When the folder has no latest.json there is nothing to
// show: loadPublished() returns null and no benchmark page is generated.
//
// Only the published files are read: latest.json, models/<slug>.json and
// practice/latest.json. They carry outcomes and hashes, never case text.
// Every number a page shows goes through one of the formatters in `fmt`, and
// the tests run the file's numbers through the same formatters.
//
// The pages rank models on the headline (raw) arm. A release's profile arms
// stay in its results file and are not turned into a view here: the page
// shows no with/without comparison.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { longDate } from '../docs/_shared.mjs';

export const DEFAULT_DIR = fileURLToPath(new URL('../../../public/bench/', import.meta.url));
export const PUBLISHED_DIR = process.env.PAYDIRT_PUBLISHED_DIR ? path.resolve(process.env.PAYDIRT_PUBLISHED_DIR) : DEFAULT_DIR;

/** Where the published files are served on the site. */
export const SERVED = '/bench';
export const PAGE_PATH = '/benchmark';
export const METHOD_PATH = '/benchmark/method';

const SCHEMA = 'paydirt.results/1';

/** Task families in the order the pages list them, with the words a hunter uses. */
export const FAMILIES = {
  'find-sol': { label: 'Solidity review', short: 'Solidity', noun: 'Solidity', profile: 'solidity' },
  'find-ts': { label: 'TypeScript API review', short: 'TypeScript API', noun: 'TypeScript API', profile: 'general' },
  challenge: { label: 'Challenging a draft report', short: 'Draft report', noun: 'draft-report', profile: 'report' },
};
const FAMILY_ORDER = Object.keys(FAMILIES);

export const familyLabel = (family) => FAMILIES[family]?.label ?? family;

/** Families in page order: the known three first, anything else after them. */
export function orderFamilies(families) {
  return [...families].sort((a, b) => {
    const x = FAMILY_ORDER.indexOf(a), y = FAMILY_ORDER.indexOf(b);
    return (x === -1 ? 99 : x) - (y === -1 ? 99 : y) || (a < b ? -1 : a > b ? 1 : 0);
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * The published files in `dir`, or null when there is no latest.json.
 * { dir, results, details: Map<slug, outcomes[]>, practice: results | null }
 */
export function loadPublished(dir = PUBLISHED_DIR) {
  const file = path.join(dir, 'latest.json');
  if (!existsSync(file)) return null;
  const results = readJson(file);
  if (results?.schema !== SCHEMA || !Array.isArray(results.models)) {
    throw new Error(`${file} is not a Paydirt results file (schema ${JSON.stringify(results?.schema)}, expected ${SCHEMA})`);
  }
  const details = new Map();
  for (const model of results.models) {
    const detail = model.detail ? path.join(dir, model.detail) : null;
    details.set(model.slug, detail && existsSync(detail) ? (readJson(detail).outcomes ?? []) : null);
  }
  const practiceFile = path.join(dir, 'practice', 'latest.json');
  const practice = existsSync(practiceFile) ? readJson(practiceFile) : null;
  return { dir, results, details, practice: practice?.schema === SCHEMA && Array.isArray(practice.models) && practice.models.length ? practice : null };
}

// ---------------------------------------------------------------------------
// Formatters: the one place a published number becomes text
// ---------------------------------------------------------------------------

const oneDecimal = (value) => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

export const fmt = {
  /** 77.78 -> "77.8", 100 -> "100". Scores and pair counts. */
  score: (value) => (typeof value === 'number' ? oneDecimal(value) : null),
  /** 0.9167 -> "92%". Rates stored as fractions. */
  rate: (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : null),
  /** US dollars: "$2.27", "$0.22", "$0.063", "$0.0075". */
  usd: (value) => {
    if (typeof value !== 'number') return null;
    if (value === 0) return '$0';
    if (value >= 1) return `$${value.toFixed(2)}`;
    // Three decimals below a dollar, four below a cent, then a trailing zero is dropped after
    // rounding: 0.2199 and 0.22 both read "$0.22", never "$0.220" next to "$0.10".
    const text = value >= 0.01 ? value.toFixed(3) : value.toFixed(4);
    return `$${text.endsWith('0') ? text.slice(0, -1) : text}`;
  },
  /** 313.1 -> "5m 13s", 42 -> "42s". */
  seconds: (value) => {
    if (typeof value !== 'number') return null;
    const total = Math.round(value);
    const minutes = Math.floor(total / 60);
    return minutes ? `${minutes}m ${String(total % 60).padStart(2, '0')}s` : `${total}s`;
  },
  /** "2026-10-02T23:05:19.396Z" -> "2 October 2026". */
  date: (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? longDate(iso.slice(0, 10)) : null),
  /** 327889 -> "320 KB". */
  bytes: (value) => {
    if (typeof value !== 'number') return null;
    return value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
  },
  /** 1234 -> "1,234". */
  count: (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : null),
  /** Times as much, one decimal: 6.56 -> "6.6". */
  ratio: (value) => (typeof value === 'number' ? oneDecimal(value) : null),
};

/** "14 of 18": pairs right, from the score and the number of pairs. */
export function pairsRight(score, pairs) {
  if (typeof score !== 'number' || typeof pairs !== 'number') return null;
  return `${fmt.score((score * pairs) / 100)} of ${pairs}`;
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** 3 -> "three", 14 -> "14". */
export const inWords = (count) => WORDS[count] ?? String(count);
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** "A", "A and B", "A, B and C". */
export function listing(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// ---------------------------------------------------------------------------
// The view: what the pages show, computed once from the files
// ---------------------------------------------------------------------------

/**
 * Standard competition rank over the file's order: equal scores share a rank.
 * The file is sorted by median score, then by majority score.
 */
function ranks(rows) {
  let rank = 0;
  let previous = null;
  return rows.map((row, index) => {
    const key = `${row.arm.score.median}|${row.arm.score.majority}`;
    if (key !== previous) rank = index + 1;
    previous = key;
    return rank;
  });
}

/** One pair of one model on one arm: 'right', 'wrong' or 'failed'. With repeats, the majority. */
function pairOutcome(outcomes, pair, arm, repeats) {
  const variants = Object.values(pair.cases ?? {});
  const perRep = [];
  for (let rep = 1; rep <= repeats; rep += 1) {
    const found = variants.map((caseId) => outcomes.find((o) => o.case === caseId && o.arm === arm && o.rep === rep) ?? null);
    if (found.every((o) => o?.correct === true)) perRep.push('right');
    else if (found.some((o) => !o || o.status === 'failed')) perRep.push('failed');
    else perRep.push('wrong');
  }
  const count = (value) => perRep.filter((entry) => entry === value).length;
  // The pair counts as the aggregate counts it: right when most repeats are right.
  if (count('right') * 2 > perRep.length) return 'right';
  return count('failed') > count('wrong') ? 'failed' : 'wrong';
}

/**
 * Everything the benchmark page shows.
 *
 * A model is ranked when its headline arm has no missing or unresolved run.
 * A model whose headline arm is incomplete is listed with the models that
 * were not run, with how many of its inputs were answered. A pick or a column
 * of the pair grid is shown only for arms with no unresolved run.
 */
export function buildView(published) {
  const { results, details } = published;
  const headline = results.scoring?.headline_arm ?? 'raw';
  const pairs = results.cases?.pairs ?? results.pairs?.length ?? 0;
  const repeats = results.repeats ?? 1;
  const complete = (model, arm) => !!model.arms?.[arm] && model.arms[arm].unresolved === 0 && model.arms[arm].runs === model.arms[arm].runs_expected;
  const notRunSlugs = new Set((results.not_run ?? []).map((entry) => entry.slug));

  const rankedModels = results.models.filter((model) => complete(model, headline));
  const rankList = ranks(rankedModels.map((model) => ({ arm: model.arms[headline] })));
  const rows = rankedModels.map((model, index) => {
    const arm = model.arms[headline];
    return {
      slug: model.slug,
      name: model.name ?? model.slug,
      vendor: model.vendor,
      open: model.open_weight === true,
      rank: rankList[index],
      tier: model.tier,
      model,
      arm,
      score: arm.score.median,
      pairs: arm.pairs,
      ci: Array.isArray(arm.score.ci95) ? arm.score.ci95 : null,
      effort: model.effort,
      effortRequested: model.effort_requested,
      effortMixed: model.effort_mixed,
      detail: model.detail,
    };
  });
  const bySlug = new Map(rows.map((row) => [row.slug, row]));

  // Tiers, in file order: the first row of each tier opens a group.
  const tiers = [];
  for (const row of rows) {
    const last = tiers.at(-1);
    if (last && last.tier === row.tier) last.rows.push(row);
    else tiers.push({ tier: row.tier, rows: [row] });
  }

  const incomplete = results.models
    .filter((model) => model.arms?.[headline] && !complete(model, headline) && !notRunSlugs.has(model.slug))
    .map((model) => {
      const arm = model.arms[headline];
      return { slug: model.slug, name: model.name ?? model.slug, tier: model.run_tier ?? null, answered: arm.runs_expected - arm.unresolved, inputs: arm.runs_expected };
    });

  // Picks: best, budget and open-weight per task family, merged where one model holds several.
  // They are taken on the ranked arm by the release's own rule (bench/lib/score.mjs): the
  // highest score on the pairs of that task, equal scores to the cheaper run. The results
  // file also lists picks made on profile arms; the page compares nothing, so it shows none.
  const budgetLine = results.scoring?.budget_usd_per_run ?? null;
  const cheaperFirst = (x, y) => y.score - x.score || x.usd_run - y.usd_run || (x.model < y.model ? -1 : x.model > y.model ? 1 : 0);
  const picks = [];
  for (const family of orderFamilies(new Set((results.picks ?? []).map((pick) => pick.task)))) {
    const candidates = rows
      .map((row) => ({ task: family, model: row.slug, arm: headline, score: row.arm.by_family?.[family], usd_run: row.arm.usd_run_p50 ?? row.arm.usd_run, row }))
      .filter((candidate) => typeof candidate.score === 'number' && typeof candidate.usd_run === 'number');
    const entries = [];
    for (const [tier, list] of [
      ['best', candidates],
      ['budget', budgetLine === null ? [] : candidates.filter((candidate) => candidate.usd_run < budgetLine)],
      ['open-weight', candidates.filter((candidate) => candidate.row.open)],
    ]) {
      const [pick] = [...list].sort(cheaperFirst);
      if (!pick) continue;
      const same = entries.find((entry) => entry.model === pick.model);
      if (same) same.tiers.push(tier);
      else entries.push({ ...pick, tiers: [tier] });
    }
    if (entries.length) picks.push({ family, pairs: results.cases?.by_family?.[family] ?? null, entries });
  }

  // Pair by pair, on the headline arm.
  const pairList = orderFamilies(new Set((results.pairs ?? []).map((pair) => pair.family))).flatMap((family) =>
    results.pairs.filter((pair) => pair.family === family),
  );
  const grid = rows.map((row) => {
    const outcomes = details.get(row.slug);
    const cells = pairList.map((pair) => (outcomes ? pairOutcome(outcomes, pair, headline, repeats) : null));
    return { row, cells, right: cells.filter((cell) => cell === 'right').length };
  });
  const gridComplete = grid.every((line) => line.cells.every(Boolean));

  // Input by input, on the headline arm: right, wrong or no answer, the last under the
  // file's own failure labels. A pair hides which of the three cost it; an input does not.
  const perModelInputs = Number.isInteger(results.cases?.inputs) ? results.cases.inputs * repeats : null;
  const split = rows.map((row) => {
    const outcomes = (details.get(row.slug) ?? []).filter((outcome) => outcome.arm === headline);
    const kinds = {};
    let right = 0;
    let wrong = 0;
    let failed = 0;
    for (const outcome of outcomes) {
      if (outcome.status === 'failed') {
        failed += 1;
        const kind = typeof outcome.failure === 'string' && outcome.failure ? outcome.failure : 'other';
        kinds[kind] = (kinds[kind] ?? 0) + 1;
      } else if (outcome.correct === true) right += 1;
      else wrong += 1;
    }
    return { row, inputs: outcomes.length, right, wrong, failed, kinds };
  });
  const splitComplete = split.length > 0 && perModelInputs !== null && split.every((line) => line.inputs === perModelInputs);

  const usdTotal = results.models.reduce((sum, model) => sum + (typeof model.usd_total === 'number' ? model.usd_total : 0), 0);
  const retries = results.models.filter((model) => Number.isInteger(model.infra_retries));

  return {
    results,
    headline,
    release: results.release,
    pairs,
    inputs: results.cases?.inputs ?? null,
    repeats,
    rows,
    tiers,
    incomplete,
    notRun: results.not_run ?? [],
    notes: results.notes ?? [],
    picks,
    pairList,
    grid,
    gridComplete,
    split,
    splitComplete,
    usdTotal,
    retries: retries.length ? retries.reduce((sum, model) => sum + model.infra_retries, 0) : null,
    budget: results.scoring?.budget_usd_per_run ?? null,
    biteSeverities: results.scoring?.bite_severities ?? ['medium', 'high', 'critical', 'unrated'],
    practice: published.practice ? practiceView(published.practice) : null,
  };
}

/**
 * What a release ran besides the ranked arm, counted from the results file:
 * which models, and on how many pairs each. A profile arm covers the pairs of
 * one task family, so a model's pairs are the sum over its profile arms. The
 * page states these counts where it says why it compares nothing.
 *
 * @returns {{ models: number, slugs: string[], minPairs: number, maxPairs: number } | null}
 */
export function profileRuns(results, headline = results.scoring?.headline_arm ?? 'raw') {
  const perModel = results.models
    .map((model) => ({
      slug: model.slug,
      pairs: Object.entries(model.arms ?? {}).filter(([name, arm]) => name !== headline && Number.isInteger(arm?.pairs)).map(([, arm]) => arm.pairs),
    }))
    .filter((entry) => entry.pairs.length);
  if (!perModel.length) return null;
  const each = perModel.map((entry) => entry.pairs.reduce((sum, pairs) => sum + pairs, 0));
  return { models: perModel.length, slugs: perModel.map((entry) => entry.slug), minPairs: Math.min(...each), maxPairs: Math.max(...each) };
}

function practiceView(practice) {
  const headline = practice.scoring?.headline_arm ?? 'raw';
  const rows = practice.models
    .filter((model) => model.arms?.[headline])
    .map((model) => ({ slug: model.slug, name: model.name ?? model.slug, arm: model.arms[headline], complete: model.arms[headline].unresolved === 0, detail: model.detail }));
  return { results: practice, headline, pairs: practice.cases?.pairs ?? 0, rows };
}

// ---------------------------------------------------------------------------
// "What the numbers say": each finding is checked before it is written
// ---------------------------------------------------------------------------

/**
 * Up to four sentences, each true of the data or left out. A finding whose
 * condition does not hold is omitted, never bent to fit.
 */
export function findings(view, { limit = 4 } = {}) {
  const out = [];
  const { rows } = view;
  if (!rows.length) return out;
  const top = view.tiers[0];
  const costed = (list) => list.filter((row) => typeof row.arm.usd_run === 'number' && row.arm.usd_run > 0);

  // 1. The top tier: how many models the interval cannot separate, and their score range.
  if (top && top.rows.length >= 2) {
    const scores = top.rows.map((row) => row.score);
    const high = Math.max(...scores), low = Math.min(...scores);
    const range = high === low ? `all at ${fmt.score(high)}` : `from ${fmt.score(low)} to ${fmt.score(high)}`;
    out.push({
      id: 'top-tier',
      text: `${capital(inWords(top.rows.length))} models share the top tier, ${range}: each one's 95% interval overlaps the leader's.`,
    });
  }

  // 2. Inside the top tier, the cheapest run against the dearest.
  const topCosted = top ? costed(top.rows) : [];
  if (topCosted.length >= 2) {
    const cheap = topCosted.reduce((a, b) => (b.arm.usd_run < a.arm.usd_run ? b : a));
    const dear = topCosted.reduce((a, b) => (b.arm.usd_run > a.arm.usd_run ? b : a));
    const ratio = dear.arm.usd_run / cheap.arm.usd_run;
    if (cheap !== dear && ratio >= 1.5) {
      out.push({
        id: 'top-tier-cost',
        text: `In that tier, ${cheap.name} costs ${fmt.usd(cheap.arm.usd_run)} a run and ${dear.name} ${fmt.usd(dear.arm.usd_run)}, ${fmt.ratio(ratio)} times as much.`,
      });
    }
  }

  // 3. The spread of cost per run across the ranked models.
  const all = costed(rows);
  if (all.length >= 3) {
    const cheap = all.reduce((a, b) => (b.arm.usd_run < a.arm.usd_run ? b : a));
    const dear = all.reduce((a, b) => (b.arm.usd_run > a.arm.usd_run ? b : a));
    if (dear.arm.usd_run > cheap.arm.usd_run) {
      out.push({
        id: 'cost-spread',
        text: `Across the ${inWords(all.length)} ranked models, a run costs from ${fmt.usd(cheap.arm.usd_run)} (${cheap.name}) to ${fmt.usd(dear.arm.usd_run)} (${dear.name}).`,
      });
    }
  }

  // 4. Failures: the models that answered every input, or the lowest failure rate.
  const rated = rows.filter((row) => typeof row.arm.failure === 'number');
  if (rated.length) {
    const lowest = Math.min(...rated.map((row) => row.arm.failure));
    const holders = rated.filter((row) => row.arm.failure === lowest);
    const inputs = rated[0].arm.runs_expected;
    if (lowest === 0 && holders.length === rated.length) {
      out.push({ id: 'failures', text: `Every ranked model returned a readable answer on all ${inputs} inputs.` });
    } else if (lowest === 0 && holders.length <= 3) {
      out.push({ id: 'failures', text: `${listing(holders.map((row) => row.name))} returned a readable answer on all ${inputs} inputs; every other ranked model failed on at least one.` });
    } else if (lowest === 0) {
      out.push({ id: 'failures', text: `${capital(inWords(holders.length))} of the ${inWords(rated.length)} ranked models returned a readable answer on all ${inputs} inputs.` });
    } else if (holders.length === 1 && Number.isInteger(holders[0].arm.runs_expected)) {
      const failed = Math.round(lowest * holders[0].arm.runs_expected);
      out.push({ id: 'failures', text: `The lowest failure rate is ${holders[0].name}'s: ${failed} of ${holders[0].arm.runs_expected} inputs ended with no readable answer.` });
    }
  }

  // 5. Fool's gold: models that reported the patched code of a fixed twin as a bug.
  const fixed = rows.filter((row) => typeof row.arm.fools_gold === 'number');
  if (fixed.length) {
    const bit = fixed.filter((row) => row.arm.fools_gold > 0).length;
    const n = fixed.length;
    const subject = bit === 0
      ? `None of the ${inWords(n)} ranked models`
      : bit === n ? (n === 1 ? 'The ranked model' : `All ${inWords(n)} ranked models`) : `${capital(inWords(bit))} of the ${inWords(n)} ranked models`;
    const object = bit === 0 ? 'the patched code of a fixed twin' : 'the patched code of at least one fixed twin';
    out.push({ id: 'fools-gold', text: `${subject} reported ${object} as a bug rated ${listingOr(view.biteSeverities)}.` });
  }

  return out.slice(0, limit);
}

/** "a, b or c". */
export function listingOr(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}
