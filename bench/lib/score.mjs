// Paydirt scoring. Two pure stages:
//   scoreInput(...)  one stored run + its answer key  -> one outcome record
//   aggregate(...)   every outcome record             -> the published results JSON
// No clock, no randomness (the bootstrap uses the seeded generator in stats.mjs), no I/O.

import { bootstrapMeanCI, pairedBootstrap, mean, median, round, tiersByOverlap } from './stats.mjs';

export const RESULTS_SCHEMA = 'paydirt.results/1';
export const SEVERITY_LEVEL = Object.freeze({ info: 1, low: 1, medium: 2, high: 3, critical: 4 });
/** Failure kinds that mean "the harness or the network failed", not "the model failed". */
export const UNRESOLVED = Object.freeze(['missing', 'infra']);

export const DEFAULT_SCORING = Object.freeze({
  headline_arm: 'raw',
  max_findings: 8,
  max_range_lines: 40,
  line_tolerance: 3,
  line_tolerance_named: 0,
  max_functions: 3,
  bite_severities: ['medium', 'high', 'critical', 'unrated'],
  max_quotes: 8,
  min_quote_chars: 20,
  max_quote_chars: 400,
  bootstrap: { resamples: 10000, seed: 'paydirt-v1', level: 0.95 },
  budget_usd_per_run: 0.1,
});

// ---------------------------------------------------------------- matching primitives

export function normPath(value) {
  let p = String(value ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\\/g, '/');
  p = p.replace(/:\d+(?:-\d+)?$/, '');          // "src/A.sol:70-77"
  p = p.replace(/^[a-z]:\//i, '/');              // drive letter
  p = p.replace(/^(?:\.\/)+/, '').replace(/^input-\d+\//i, '').replace(/\/{2,}/g, '/');
  return p.toLowerCase();
}

/** Same file: equal after normalisation, or one is a path-segment suffix of the other. */
export function sameFile(a, b) {
  const x = normPath(a).replace(/^\/+/, ''), y = normPath(b).replace(/^\/+/, '');
  if (!x || !y) return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** Function names read from a finding's `function` field (at most `limit`, lower-cased). */
export function functionNames(value, limit = 3) {
  const names = [];
  const cleaned = String(value ?? '').replace(/[`'"]/g, ' ').replace(/\([^)]*\)?/g, ' ');
  for (const chunk of cleaned.split(/[\s,;/&|]+|\band\b/i)) {
    const last = (chunk ?? '').split(/[.:#>]+/).filter(Boolean).pop();
    if (!last || !/^[A-Za-z_$][\w$]*$/.test(last)) continue;
    const name = last.toLowerCase();
    if (['function', 'modifier', 'method', 'fn', 'func', 'handler', 'internal', 'external', 'public', 'private', 'async', 'export', 'const'].includes(name)) continue;
    if (!names.includes(name)) names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

function findingRange(finding, scoring) {
  const start = Number.isInteger(finding.line_start) ? finding.line_start : 0;
  if (start <= 0) return null;
  const end = Number.isInteger(finding.line_end) && finding.line_end >= start ? finding.line_end : start;
  if (end - start + 1 > scoring.max_range_lines) return null; // over-long ranges carry no line evidence
  return [start, end];
}

/**
 * Does `finding` hit `target` ({file, lines: [[a,b]], functions: []})?
 * Same file AND (a named function is in the target's list OR the line range overlaps a
 * target range). The overlap is widened by `line_tolerance` only when the finding names no
 * function: the tolerance forgives line drift, and a finding that names another function
 * (often the neighbour three lines away) says itself that it is about that function, so its
 * range must really overlap (`line_tolerance_named`, 0). Returns null or { by_line, by_function }.
 */
export function hit(finding, target, scoring = DEFAULT_SCORING) {
  if (!target || !sameFile(finding.file, target.file)) return null;
  const wanted = (target.functions ?? []).map((f) => String(f).toLowerCase());
  const named = functionNames(finding.function, scoring.max_functions);
  const byFunction = named.some((n) => wanted.includes(n));
  const range = findingRange(finding, scoring);
  const tol = named.length ? (scoring.line_tolerance_named ?? 0) : scoring.line_tolerance;
  const byLine = !!range && (target.lines ?? []).some(([a, b]) => range[0] <= b + tol && range[1] >= a - tol);
  return byFunction || byLine ? { by_line: byLine, by_function: byFunction } : null;
}

/** Text normalisation for quote matching: case, typographic punctuation, markdown marks, whitespace. */
export function normQuote(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Is `quote` found in the draft at a position that overlaps one of `ranges` (1-based
 * inclusive line ranges of the draft)? Whitespace-normalised substring match.
 */
export function quoteInLines(quote, draftText, ranges, scoring = DEFAULT_SCORING) {
  const q = normQuote(quote);
  if (q.length < scoring.min_quote_chars || q.length > scoring.max_quote_chars) return false;
  let flat = '';
  const lineOf = [];
  const lines = String(draftText ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const piece = normQuote(lines[i]);
    if (!piece) continue;
    if (flat) { flat += ' '; lineOf.push(i + 1); }
    flat += piece;
    for (let k = 0; k < piece.length; k++) lineOf.push(i + 1);
  }
  for (let at = flat.indexOf(q); at >= 0; at = flat.indexOf(q, at + 1)) {
    const first = lineOf[at], last = lineOf[at + q.length - 1];
    if (ranges.some(([a, b]) => first <= b && last >= a)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- one input

const levelOf = (severity) => SEVERITY_LEVEL[severity] ?? null;

function severityAgainst(severity, accepted) {
  const level = levelOf(severity);
  const levels = (accepted ?? []).map(levelOf).filter((v) => v !== null);
  if (level === null || !levels.length) return { exact: null, distance: null };
  let best = null;
  for (const l of levels) if (best === null || Math.abs(level - l) < Math.abs(best)) best = level - l;
  return { exact: best === 0, distance: best };
}

/**
 * Score one input.
 *   kase   { id, pair, family, variant }
 *   truth  the case's truth.json
 *   run    null when the run is missing, else
 *          { failure: null|'timeout'|'truncated'|'error'|'infra', sheet: {ok, sheet, reason}, draft: string|null, facts: {...} }
 * `facts` (cost, time, tokens, effort, provider) is copied through untouched.
 */
export function scoreInput(kase, truth, run, scoring = DEFAULT_SCORING) {
  const base = {
    case: kase.id, pair: kase.pair, family: kase.family, variant: kase.variant,
    status: 'ok', failure: null, correct: false,
    findings_read: 0, hits: [], planted: (truth.planted ?? []).length, primary_all: null,
    bite: null, decoys: (truth.decoys ?? []).length, decoy_bites: 0, unmatched: 0,
    verdict: null, quote_hit: null, max_severity: null, max_severity_exact: null,
    ...(run?.facts ?? {}),
  };
  const fail = (kind) => ({ ...base, status: 'failed', failure: kind, correct: false });
  if (!run) return fail('missing');
  if (run.failure) return fail(run.failure);
  if (!run.sheet?.ok) return fail(run.sheet?.reason === 'empty' ? 'empty' : 'unparseable');

  const sheet = run.sheet.sheet;
  const findings = sheet.findings.slice(0, scoring.max_findings);
  const biteSet = new Set(scoring.bite_severities);
  base.findings_read = findings.length;
  base.max_severity = sheet.max_severity;

  if (kase.family === 'challenge') {
    const report = truth.report ?? {};
    base.verdict = sheet.verdict;
    base.max_severity_exact = report.max_severity ? sheet.max_severity === report.max_severity : null;
    if (kase.variant === 'overclaimed') {
      const ranges = (report.false_claims ?? []).flatMap((c) => c.draft_lines ?? []);
      const quotes = sheet.rejected.slice(0, scoring.max_quotes);
      base.quote_hit = quotes.some((r) => quoteInLines(r.quote, run.draft ?? '', ranges, scoring));
      base.correct = (sheet.verdict === 'overclaimed' || sheet.verdict === 'unsupported') && base.quote_hit;
    } else {
      base.correct = sheet.verdict === 'supported';
    }
    return base;
  }

  // find families
  const claimed = new Set(); // findings that hit a planted bug or the patched region
  for (const p of truth.planted ?? []) {
    for (let i = 0; i < findings.length; i++) {
      const h = hit(findings[i], p, scoring);
      if (!h) continue;
      const sev = severityAgainst(findings[i].severity, p.severity);
      base.hits.push({ id: p.id, primary: p.primary === true, finding: i, by_line: h.by_line, by_function: h.by_function, severity: findings[i].severity, severity_exact: sev.exact, severity_distance: sev.distance });
      claimed.add(i);
      break; // the first finding that hits is the one that counts
    }
  }
  for (const p of truth.planted ?? []) for (let i = 0; i < findings.length; i++) if (hit(findings[i], p, scoring)) claimed.add(i);

  if (kase.variant === 'fixed') {
    base.bite = false;
    for (let i = 0; i < findings.length; i++) {
      if (!hit(findings[i], truth.patched_region, scoring)) continue;
      claimed.add(i);
      if (biteSet.has(findings[i].severity)) base.bite = true;
    }
    base.correct = !base.bite;
  } else {
    const primaries = (truth.planted ?? []).filter((p) => p.primary === true);
    base.primary_all = primaries.length > 0 && primaries.every((p) => base.hits.some((h) => h.id === p.id));
    base.correct = base.primary_all;
  }

  const decoyHit = new Set();
  for (const d of truth.decoys ?? []) {
    for (let i = 0; i < findings.length; i++) {
      if (claimed.has(i) || !biteSet.has(findings[i].severity) || !hit(findings[i], d, scoring)) continue;
      decoyHit.add(i);
      base.decoy_bites += 1;
      break;
    }
  }
  for (let i = 0; i < findings.length; i++) {
    if (claimed.has(i) || decoyHit.has(i) || !biteSet.has(findings[i].severity)) continue;
    const acceptable = (truth.acceptable ?? []).some((a) => hit(findings[i], { file: a.file, lines: a.lines, functions: a.functions ?? [] }, scoring));
    const onDecoy = (truth.decoys ?? []).some((d) => hit(findings[i], d, scoring));
    if (!acceptable && !onDecoy) base.unmatched += 1;
  }
  return base;
}

// ---------------------------------------------------------------- aggregation

const pct = (v) => round(v === null ? null : v * 100, 2);
const rate = (num, den) => (den > 0 ? round(num / den, 4) : null);
export const vendorOf = (slug) => String(slug ?? '').split('/')[0].toLowerCase();
export const modelFile = (slug) => `${String(slug).replace(/[^A-Za-z0-9._-]+/g, '__')}.json`;

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/**
 * Build the published results object.
 *   input.meta     { release, run_id, protocol_sha256, hashes, harness_commit, generated_at, prices_at, omp_version, repeats }
 *                  `hashes` (optional) is { protocol, core, arms: { <arm>: hash } }: the hash each arm's runs were made under
 *   input.scoring  protocol.scoring
 *   input.arms     { family: [arm, ...] }
 *   input.pairs    [{ pair, family, visibility, author, cases: { <variant>: caseId, ... } }]
 *   input.models   [{ slug, name, vendor, open_weight, price: {in, out}, run_tier, outcomes: [ {...scoreInput, arm, rep} ] }]
 */
export function aggregate(input) {
  const scoring = { ...DEFAULT_SCORING, ...(input.scoring ?? {}), bootstrap: { ...DEFAULT_SCORING.bootstrap, ...(input.scoring?.bootstrap ?? {}) } };
  const pairs = [...input.pairs].sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
  const families = [...new Set(pairs.map((p) => p.family))].sort();
  const armList = [...new Set(families.flatMap((f) => input.arms[f] ?? []))];
  const headline = scoring.headline_arm;
  const completeArm = (arm) => !!arm && arm.unresolved === 0 && arm.runs === arm.runs_expected;
  const maxRep = Math.max(0, ...input.models.flatMap((m) => m.outcomes.map((o) => o.rep)));
  const repeats = Number.isInteger(input.meta?.repeats) && input.meta.repeats > 0 ? input.meta.repeats : maxRep;
  const reps = Array.from({ length: repeats }, (_, i) => i + 1);
  const boot = (values, label) => {
    const ci = bootstrapMeanCI(values, { resamples: scoring.bootstrap.resamples, level: scoring.bootstrap.level, seed: `${scoring.bootstrap.seed}|${label}` });
    return ci ? [pct(ci[0]), pct(ci[1])] : null;
  };

  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const models = input.models.map((model) => {
    const vendor = model.vendor ?? vendorOf(model.slug);
    const byKey = new Map(model.outcomes.map((o) => [`${o.case}|${o.arm}|${o.rep}`, o]));
    const get = (caseId, arm, rep) => byKey.get(`${caseId}|${arm}|${rep}`) ?? null;
    const arms = {};
    const majorityByArm = {};

    for (const arm of armList) {
      const armPairs = pairs.filter((p) => (input.arms[p.family] ?? []).includes(arm));
      if (!armPairs.length) continue;
      if (!model.outcomes.some((o) => o.arm === arm && o.failure !== 'missing')) continue; // this arm was never run for this model
      // inputs[rep] = outcomes of every input of every pair for this rep (missing -> synthetic record)
      const outcome = (p, variant, rep) => get(p.cases[variant], arm, rep)
        ?? { case: p.cases[variant], pair: p.pair, family: p.family, variant, status: 'failed', failure: 'missing', correct: false, hits: [], planted: 0, decoys: 0, decoy_bites: 0, bite: null };
      const pairOk = (p, rep) => Object.keys(p.cases).every((variant) => outcome(p, variant, rep).correct === true);
      const correct = new Map(armPairs.map((p) => [p.pair, reps.map((rep) => pairOk(p, rep))]));
      const scoreOn = (subset, rep) => (subset.length ? (100 * subset.filter((p) => correct.get(p.pair)[rep - 1]).length) / subset.length : null);
      const medOn = (subset) => (subset.length && reps.length ? round(median(reps.map((rep) => scoreOn(subset, rep))), 2) : null);
      const majority = armPairs.map((p) => (correct.get(p.pair).filter(Boolean).length * 2 > reps.length ? 1 : 0));
      majorityByArm[arm] = new Map(armPairs.map((p, i) => [p.pair, majority[i]]));
      const perRep = reps.map((rep) => scoreOn(armPairs, rep));

      const all = [];
      for (const p of armPairs) for (const variant of Object.keys(p.cases)) for (const rep of reps) all.push(outcome(p, variant, rep));
      const present = all.filter((o) => o.failure !== 'missing');
      const of = (variant) => all.filter((o) => o.variant === variant);
      const findInputs = all.filter((o) => o.family !== 'challenge');
      const hits = of('vulnerable').flatMap((o) => o.hits ?? []);
      const rated = hits.filter((h) => h.severity_distance !== null && h.severity_distance !== undefined);
      const usd = present.map((o) => o.usd).filter((v) => typeof v === 'number');
      const walls = present.map((o) => o.wall_s).filter((v) => typeof v === 'number');
      const correctPairReps = armPairs.reduce((n, p) => n + correct.get(p.pair).filter(Boolean).length, 0);
      const usdTotal = usd.reduce((s, v) => s + v, 0);
      const unresolved = all.filter((o) => UNRESOLVED.includes(o.failure)).length;

      const byFamily = {};
      for (const f of families) { const sub = armPairs.filter((p) => p.family === f); if (sub.length) byFamily[f] = medOn(sub); }
      const byAuthor = {};
      for (const author of [...new Set(armPairs.map((p) => p.author))].sort()) {
        const sub = armPairs.filter((p) => p.author === author);
        byAuthor[author] = { pairs: sub.length, score: medOn(sub) };
      }
      const others = armPairs.filter((p) => p.author !== vendor);

      arms[arm] = {
        pairs: armPairs.length,
        score: {
          median: round(median(perRep), 2), min: round(Math.min(...perRep), 2), max: round(Math.max(...perRep), 2),
          majority: pct(mean(majority)), ci95: boot(majority, `${model.slug}|${arm}|score`),
        },
        by_family: byFamily,
        by_author: byAuthor,
        excl_same_vendor: { score: medOn(others), n_pairs: others.length },
        recall: rate(hits.length, of('vulnerable').reduce((n, o) => n + (o.planted ?? 0), 0)),
        fools_gold: rate(of('fixed').filter((o) => o.bite === true).length, of('fixed').length),
        decoy_rate: rate(findInputs.reduce((n, o) => n + (o.decoy_bites ?? 0), 0), findInputs.reduce((n, o) => n + (o.decoys ?? 0), 0)),
        line_acc: rate(hits.filter((h) => h.by_line).length, hits.length),
        sev_exact: rate(rated.filter((h) => h.severity_exact).length, rated.length),
        sev_bias: rated.length ? round(mean(rated.map((h) => h.severity_distance)), 3) : null,
        unrated: rate(hits.filter((h) => h.severity === 'unrated').length, hits.length),
        false_reject: rate(of('accurate').filter((o) => !o.correct).length, of('accurate').length),
        challenge_ba: of('overclaimed').length && of('accurate').length
          ? round((of('overclaimed').filter((o) => o.correct).length / of('overclaimed').length + of('accurate').filter((o) => o.correct).length / of('accurate').length) / 2, 4)
          : null,
        failure: rate(all.filter((o) => o.status === 'failed').length, all.length),
        truncated: rate(all.filter((o) => o.failure === 'truncated').length, all.length),
        repeat_agreement: reps.length > 1 ? rate(armPairs.filter((p) => new Set(correct.get(p.pair)).size === 1).length, armPairs.length) : null,
        usd_run: usd.length ? round(mean(usd), 6) : null,
        usd_run_p50: usd.length ? round(median(usd), 6) : null,
        usd_total: round(usdTotal, 6),
        usd_per_correct_pair: correctPairReps > 0 && usd.length ? round(usdTotal / correctPairReps, 6) : null,
        latency_p50_s: walls.length ? round(median(walls), 1) : null,
        runs: present.length,
        runs_expected: all.length,
        unresolved,
      };
    }

    const lift = {};
    for (const arm of armList) {
      if (arm === headline || !majorityByArm[arm] || !majorityByArm[headline]) continue;
      if (!completeArm(arms[arm]) || !completeArm(arms[headline])) continue;
      const ids = [...majorityByArm[arm].keys()].filter((id) => majorityByArm[headline].has(id));
      const a = ids.map((id) => majorityByArm[arm].get(id)), b = ids.map((id) => majorityByArm[headline].get(id));
      const res = pairedBootstrap(a, b, { resamples: scoring.bootstrap.resamples, level: scoring.bootstrap.level, seed: `${scoring.bootstrap.seed}|${model.slug}|${arm}|lift` });
      const ci = res.ci ? [pct(res.ci[0]), pct(res.ci[1])] : null;
      lift[arm] = { delta: pct(res.delta), ci95: ci, n_pairs: ids.length, significant: !!ci && (ci[0] > 0 || ci[1] < 0) };
    }

    const seen = model.outcomes.filter((o) => o.failure !== 'missing');
    const efforts = mode(seen.map((o) => o.effort).filter((v) => typeof v === 'string'));
    const providers = mode(seen.flatMap((o) => o.providers ?? []));
    const totalUsd = seen.reduce((s, o) => s + (typeof o.usd === 'number' ? o.usd : 0), 0);
    // attempts of the counted runs that failed for infrastructure reasons and were made again;
    // only runs stored with their attempt record carry the count, and without any the field is left out
    const retried = seen.filter((o) => Number.isInteger(o.infra_retries));
    return {
      slug: model.slug,
      name: model.name ?? model.slug,
      vendor,
      open_weight: model.open_weight === true,
      cutoff: model.cutoff ?? null,
      price: { in: model.price?.in ?? null, out: model.price?.out ?? null },
      effort: efforts.length ? efforts[0][0] : null,
      effort_requested: input.meta?.thinking ?? null,
      effort_mixed: efforts.length > 1 ? Object.fromEntries(efforts) : null,
      providers: providers.map(([name, runs]) => ({ name, runs })),
      tier: null,
      run_tier: model.run_tier ?? null,
      complete: Object.values(arms).every((a) => a.unresolved === 0),
      usd_total: round(totalUsd, 6),
      ...(retried.length ? { infra_retries: retried.reduce((n, o) => n + o.infra_retries, 0) } : {}),
      arms,
      lift,
      detail: `models/${modelFile(model.slug)}`,
    };
  });

  const ranked = models.filter((m) => completeArm(m.arms[headline]));
  const tiers = tiersByOverlap(ranked.map((m) => ({ key: m.slug, score: m.arms[headline].score.majority, ci: m.arms[headline].score.ci95 })));
  for (const m of ranked) m.tier = tiers.get(m.slug);
  const key = (m) => (m.arms[headline] ? [m.arms[headline].score.median, m.arms[headline].score.majority] : [-1, -1]);
  models.sort((x, y) => key(y)[0] - key(x)[0] || key(y)[1] - key(x)[1] || cmp(x.slug, y.slug));

  // picks: best score per task; equal scores go to the cheaper run
  const picks = [];
  for (const family of families) {
    const candidates = [];
    for (const m of ranked) for (const arm of input.arms[family] ?? []) {
      const a = m.arms[arm];
      if (!completeArm(a) || a.by_family[family] === null || a.by_family[family] === undefined || a.usd_run === null) continue;
      candidates.push({ model: m.slug, arm, score: a.by_family[family], usd: a.usd_run_p50 ?? a.usd_run, open: m.open_weight });
    }
    const best = (list) => [...list].sort((x, y) => y.score - x.score || x.usd - y.usd || cmp(x.model, y.model) || cmp(x.arm, y.arm))[0];
    for (const [tier, list] of [['best', candidates], ['budget', candidates.filter((c) => c.usd < scoring.budget_usd_per_run)], ['open-weight', candidates.filter((c) => c.open)]]) {
      const pick = best(list);
      if (pick) picks.push({ task: family, tier, model: pick.model, arm: pick.arm, score: pick.score, usd_run: pick.usd });
    }
  }

  const count = (pred) => pairs.filter(pred).length;
  return {
    schema: RESULTS_SCHEMA,
    release: input.meta?.release ?? null,
    run_id: input.meta?.run_id ?? null,
    protocol_sha256: input.meta?.protocol_sha256 ?? null,
    // the hash each arm's runs were made and counted under: { protocol, core, arms: { <arm>: hash } }
    ...(input.meta?.hashes ? { hashes: input.meta.hashes } : {}),
    harness_commit: input.meta?.harness_commit ?? null,
    omp_version: input.meta?.omp_version ?? null,
    generated_at: input.meta?.generated_at ?? null,
    prices_at: input.meta?.prices_at ?? null,
    thinking: input.meta?.thinking ?? null,
    repeats,
    cases: {
      pairs: pairs.length,
      inputs: pairs.reduce((n, p) => n + Object.keys(p.cases).length, 0),
      public: count((p) => p.visibility === 'public'),
      held: count((p) => p.visibility !== 'public'),
      by_family: Object.fromEntries(families.map((f) => [f, count((p) => p.family === f)])),
      by_author: Object.fromEntries([...new Set(pairs.map((p) => p.author))].sort().map((a) => [a, count((p) => p.author === a)])),
    },
    scoring,
    arms: input.arms,
    pairs: pairs.map((p) => ({ pair: p.pair, family: p.family, visibility: p.visibility, author: p.author, cases: p.cases })),
    commitments: input.meta?.commitments ?? [],
    downloads: input.meta?.downloads ?? null,
    // models of the protocol's tiers with no counted answer, and the release's own notes (see notRun)
    ...(Array.isArray(input.meta?.not_run) ? { not_run: input.meta.not_run } : {}),
    ...(Array.isArray(input.meta?.notes) ? { notes: input.meta.notes } : {}),
    picks,
    models,
  };
}

/** The reason a model of the protocol's tiers is listed as not run when the release notes give none. */
export const NOT_RUN_REASON = "The release's credit did not reach it.";

/**
 * Every model of the protocol's tiers that has no counted answer in the release, in run order:
 * [{ slug, name, tier, reason }]. A counted answer is an outcome that is neither missing nor an
 * unresolved infrastructure failure, on any arm.
 *   tiers    protocol.tiers ({ "1": [slug, ...], ... })
 *   models   [{ slug, outcomes }] of the release
 *   reasons  { slug: sentence } from the release notes; NOT_RUN_REASON otherwise
 *   names    { slug: display name } where one is known (the plan); the slug otherwise
 */
export function notRun({ tiers = {}, models = [], reasons = {}, names = {} } = {}) {
  const answered = new Set(models.filter((m) => (m.outcomes ?? []).some((o) => !UNRESOLVED.includes(o.failure))).map((m) => m.slug));
  const list = [];
  for (const [tier, slugs] of Object.entries(tiers).sort(([a], [b]) => Number(a) - Number(b))) {
    for (const slug of slugs ?? []) {
      if (answered.has(slug) || list.some((entry) => entry.slug === slug)) continue;
      list.push({ slug, name: names[slug] ?? slug, tier: Number(tier), reason: reasons[slug] ?? NOT_RUN_REASON });
    }
  }
  return list;
}

/**
 * Read a release-notes file: { "not_run": { "<slug>": "<one short sentence>" }, "notes": ["<sentence>", ...] }.
 * Both keys are optional. Throws on any other shape, so a typo cannot publish silently.
 */
export function parseReleaseNotes(text, where = 'release notes') {
  if (text === null || text === undefined) return { not_run: {}, notes: [] };
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`${where} is not JSON: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object with "not_run" and/or "notes"`);
  const extra = Object.keys(value).filter((k) => k !== 'not_run' && k !== 'notes');
  if (extra.length) throw new Error(`${where} has unknown key(s): ${extra.join(', ')}`);
  const reasons = value.not_run ?? {};
  if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons) || Object.values(reasons).some((v) => typeof v !== 'string' || !v.trim())) {
    throw new Error(`${where}: "not_run" must map model slugs to one non-empty sentence each`);
  }
  const notes = value.notes ?? [];
  if (!Array.isArray(notes) || notes.some((v) => typeof v !== 'string' || !v.trim())) throw new Error(`${where}: "notes" must be a list of non-empty sentences`);
  return { not_run: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, v.trim()])), notes: notes.map((v) => v.trim()) };
}

/** Rebuild aggregate()'s input from a published results object plus its per-model detail files. */
export function aggregateInputFromPublished(results, details) {
  const bySlug = new Map(details.map((d) => [d.slug, d]));
  return {
    meta: {
      release: results.release, run_id: results.run_id, protocol_sha256: results.protocol_sha256, ...(results.hashes ? { hashes: results.hashes } : {}), harness_commit: results.harness_commit,
      omp_version: results.omp_version, generated_at: results.generated_at, prices_at: results.prices_at, repeats: results.repeats,
      thinking: results.thinking ?? null, commitments: results.commitments, downloads: results.downloads,
      ...(Array.isArray(results.not_run) ? { not_run: results.not_run } : {}), ...(Array.isArray(results.notes) ? { notes: results.notes } : {}),
    },
    scoring: results.scoring,
    arms: results.arms,
    pairs: results.pairs,
    models: results.models.map((m) => ({
      slug: m.slug, name: m.name, vendor: m.vendor, open_weight: m.open_weight, cutoff: m.cutoff, price: m.price, run_tier: m.run_tier,
      outcomes: bySlug.get(m.slug)?.outcomes ?? [],
    })),
  };
}
