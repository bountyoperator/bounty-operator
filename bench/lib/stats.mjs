// Paydirt statistics: a seeded PRNG (no Math.random anywhere in scoring), percentile
// bootstrap intervals over pairs, and tiering by interval overlap. Pure functions only.

/** 128-bit string hash (cyrb128). Turns any seed label into four 32-bit words. */
export function seedWords(text) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** sfc32 generator seeded from a string. Returns a function yielding floats in [0, 1). */
export function prng(seed) {
  let [a, b, c, d] = seedWords(seed);
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) next(); // discard the warm-up outputs
  return next;
}

export function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = 10 ** digits;
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function mean(values) {
  if (!values.length) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear-interpolated quantile of an ascending-sorted array (R type 7). */
export function quantileSorted(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Percentile bootstrap interval for the mean of `values` (one value per pair).
 * Returns [lo, hi] in the same unit as the values, or null for an empty input.
 */
export function bootstrapMeanCI(values, { resamples = 10000, seed = 'paydirt', level = 0.95 } = {}) {
  const n = values.length;
  if (!n) return null;
  const rand = prng(seed);
  const stats = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)];
    stats[b] = sum / n;
  }
  const sorted = Array.from(stats).sort((x, y) => x - y);
  const alpha = (1 - level) / 2;
  return [quantileSorted(sorted, alpha), quantileSorted(sorted, 1 - alpha)];
}

/**
 * Paired bootstrap for mean(a[i] - b[i]): the same resampled pair indices are used for
 * both arms, so pair difficulty cancels. Returns { delta, ci: [lo, hi] }.
 */
export function pairedBootstrap(a, b, { resamples = 10000, seed = 'paydirt', level = 0.95 } = {}) {
  if (a.length !== b.length) throw new Error('pairedBootstrap needs equal-length arrays');
  const diffs = a.map((v, i) => v - b[i]);
  if (!diffs.length) return { delta: null, ci: null };
  return { delta: mean(diffs), ci: bootstrapMeanCI(diffs, { resamples, seed, level }) };
}

/**
 * Tiering by interval overlap. `rows` = [{ key, score, ci: [lo, hi] }]. Rows are taken in
 * score order (descending, ties by key). A row joins the first (best) tier whose leader's
 * interval overlaps its own; a row that overlaps no leader starts the next tier and leads it.
 * Returns Map(key -> tier number, 1-based).
 */
export function tiersByOverlap(rows) {
  const order = [...rows].sort((x, y) => (y.score - x.score) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const tiers = new Map();
  const leaders = [];
  for (const row of order) {
    let tier = leaders.findIndex((leader) => row.ci && leader.ci && row.ci[1] >= leader.ci[0] && row.ci[0] <= leader.ci[1]);
    if (tier < 0) {
      leaders.push(row);
      tier = leaders.length - 1;
    }
    tiers.set(row.key, tier + 1);
  }
  return tiers;
}
