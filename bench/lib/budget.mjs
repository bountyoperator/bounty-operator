// Paydirt budget planner: what one arm at N repeats is expected to cost per model, from the
// token profile measured in the pilot (protocol.json `estimate.raw_arm`) scaled by case size.
// Pure functions: no clock, no network, no file access.

/** Which measured class a case belongs to. Only find pairs were measured per twin; the rest use the overall mean. */
export function profileClass(kase) {
  if (kase.family === 'find-sol' || kase.family === 'find-ts') return kase.variant === 'fixed' ? 'clean' : 'with_bug';
  return 'any';
}

export const workspaceBytes = (kase) => (kase.workspace ?? []).reduce((n, f) => n + (f.bytes?.length ?? 0), 0);

/**
 * Tokens one run on `kase` is expected to use under one measured profile.
 * Input (fresh and cached) is scaled by workspace bytes over the pilot's mean workspace
 * size, because every turn re-sends what was read; output is not scaled, because the pilot
 * showed no relation between workspace size and output tokens.
 */
export function estimateTokens(kase, profile, referenceBytes) {
  const p = profile[profileClass(kase)] ?? profile.any;
  const bytes = workspaceBytes(kase);
  const scale = referenceBytes > 0 && bytes > 0 ? bytes / referenceBytes : 1;
  return { input: p.input * scale, cached: p.cached * scale, output: p.output, scale };
}

/** USD for a token estimate at catalogue prices (USD per million). null when the model has no price. */
export function priceTokens(tokens, price) {
  if (!price || typeof price.in !== 'number' || typeof price.out !== 'number') return null;
  const cacheRead = typeof price.cache_read === 'number' ? price.cache_read : price.in;
  return (tokens.input * price.in + tokens.cached * cacheRead + tokens.output * price.out) / 1e6;
}

/**
 * The budget plan.
 *   cases     loaded cases (the inputs of the headline arm)
 *   models    [{ slug, run_tier, price: { in, out, cache_read } }]
 *   estimate  protocol.estimate.raw_arm: { workspace_bytes, profiles: { mean, low, high } }
 *   repeats   runs per input
 *   budget    USD
 *   order     'cost' (cheapest model first) or 'tier' (run tier 1, then 2, then 3; cheapest first inside a tier)
 *   profile   optional { models: [slug], cases: [...] }: the profile arms of a few models. Each
 *             gets a second row, placed straight after the model's headline row, priced on
 *             `profile.cases` with the same token profile (the pilot measured the profile arm
 *             at or below the raw arm).
 * Returns { rows, fit, line, total, runsPerModel }: each row has
 * { slug, arm, tier, price, runs, usd, low, high, running, fits }; `line` is the index of
 * the first row that does not fit (rows.length when everything fits).
 */
export function budgetPlan({ cases, models, estimate, repeats = 1, budget, order = 'cost', profile = null }) {
  const profiles = estimate?.profiles ?? {};
  if (!profiles.mean) throw new Error('protocol.json has no estimate.raw_arm.profiles.mean (the measured token profile)');
  const cost = (model, tokenProfile, list) => {
    let usd = 0;
    for (const kase of list) {
      const one = priceTokens(estimateTokens(kase, tokenProfile, estimate.workspace_bytes), model.price);
      if (one === null) return null;
      usd += one * repeats;
    }
    return usd;
  };
  const rowOf = (m, list, arm) => {
    const usd = cost(m, profiles.mean, list);
    const band = [profiles.low, profiles.high].filter(Boolean).map((p) => cost(m, p, list)).filter((v) => v !== null);
    return { slug: m.slug, arm, tier: m.run_tier ?? null, price: m.price, runs: list.length * repeats, usd, low: band.length ? Math.min(...band, usd ?? Infinity) : null, high: band.length ? Math.max(...band, usd ?? 0) : null };
  };
  const byCost = (a, b) => (a.usd === null) - (b.usd === null) || a.usd - b.usd || (a.slug < b.slug ? -1 : 1);
  const tierKey = (r) => (r.usd === null ? Infinity : r.tier ?? 99);
  const head = models.map((m) => rowOf(m, cases, 'headline')).sort(order === 'tier' ? (a, b) => tierKey(a) - tierKey(b) || byCost(a, b) : byCost);
  const wanted = new Set(profile?.cases?.length ? profile.models ?? [] : []);
  const bySlug = new Map(models.map((m) => [m.slug, m]));
  const rows = head.flatMap((r) => (wanted.has(r.slug) && r.usd !== null ? [r, rowOf(bySlug.get(r.slug), profile.cases, 'profile')] : [r]));
  let running = 0, line = rows.length, highRunning = 0;
  rows.forEach((row, i) => {
    running += row.usd ?? 0;
    highRunning += row.high ?? row.usd ?? 0;
    row.running = running;
    row.running_high = highRunning;
    row.fits = row.usd !== null && running <= budget;
    if (!row.fits && line === rows.length) line = i;
  });
  // in run order, so once one row does not fit no later one is counted as fitting
  rows.forEach((row, i) => { if (i > line) row.fits = false; });
  const fit = rows.slice(0, line);
  return {
    rows, line, fit: fit.length,
    fit_usd: fit.reduce((s, r) => s + (r.usd ?? 0), 0),
    fit_high_usd: fit.reduce((s, r) => s + (r.high ?? r.usd ?? 0), 0),
    total: rows.reduce((s, r) => s + (r.usd ?? 0), 0),
    runsPerModel: cases.length * repeats,
  };
}
