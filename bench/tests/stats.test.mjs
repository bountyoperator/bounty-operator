import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapMeanCI, median, pairedBootstrap, prng, quantileSorted, round, seedWords, tiersByOverlap } from '../lib/stats.mjs';

test('prng is seeded, repeatable and never uses Math.random', () => {
  const a = prng('paydirt-v1|test'), b = prng('paydirt-v1|test');
  const first = [a(), a(), a(), a()];
  assert.deepEqual(first, [b(), b(), b(), b()]);
  // pinned values: a change here means every published interval changes
  assert.deepEqual(first.map((x) => x.toFixed(12)), ['0.768919647904', '0.231937681092', '0.965152802877', '0.317766073626']);
  assert.deepEqual(seedWords('paydirt'), [3208889615, 3841644523, 524314952, 2199591993]);
  const c = prng('another seed');
  assert.notEqual(c(), first[0]);
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random must not be called'); };
  try { bootstrapMeanCI([1, 0, 1], { resamples: 200, seed: 's' }); } finally { Math.random = original; }
});

test('prng output stays in [0, 1) and is roughly uniform', () => {
  const r = prng('uniformity');
  let sum = 0;
  for (let i = 0; i < 20000; i++) { const v = r(); assert.ok(v >= 0 && v < 1); sum += v; }
  assert.ok(Math.abs(sum / 20000 - 0.5) < 0.01);
});

test('bootstrap interval: degenerate, pinned and empty cases', () => {
  assert.deepEqual(bootstrapMeanCI([1, 1, 1, 1], { resamples: 500, seed: 'x' }), [1, 1]);
  assert.deepEqual(bootstrapMeanCI([0, 0, 0], { resamples: 500, seed: 'x' }), [0, 0]);
  assert.equal(bootstrapMeanCI([], { seed: 'x' }), null);
  const values = [1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1, 0];
  const ci = bootstrapMeanCI(values, { resamples: 10000, seed: 'paydirt-v1|m|raw|score' });
  assert.deepEqual(ci, [0.4166666666666667, 0.9166666666666666]);
  assert.deepEqual(bootstrapMeanCI(values, { resamples: 10000, seed: 'paydirt-v1|m|raw|score' }), ci);
  assert.ok(ci[0] <= 8 / 12 && ci[1] >= 8 / 12);
});

test('paired bootstrap resamples pairs, not arms', () => {
  const res = pairedBootstrap([1, 1, 0, 1, 1, 1], [0, 1, 0, 0, 1, 0], { resamples: 10000, seed: 'x' });
  assert.equal(res.delta, 0.5);
  assert.deepEqual(res.ci, [0.16666666666666666, 0.8333333333333334]);
  assert.deepEqual(pairedBootstrap([1, 0], [1, 0], { resamples: 100, seed: 'x' }), { delta: 0, ci: [0, 0] });
  assert.throws(() => pairedBootstrap([1], [1, 0]));
  assert.deepEqual(pairedBootstrap([], []), { delta: null, ci: null });
});

test('median, quantile and round', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(quantileSorted([0, 10], 0.25), 2.5);
  assert.equal(round(66.666666, 2), 66.67);
  assert.equal(round(null), null);
  assert.equal(Object.is(round(-0.00001, 2), 0), true);
});

test('tiers: a model joins the best tier whose leader it overlaps', () => {
  const tiers = tiersByOverlap([
    { key: 'a', score: 90, ci: [80, 100] },
    { key: 'b', score: 85, ci: [75, 95] },   // overlaps a
    { key: 'c', score: 60, ci: [50, 70] },   // clear of a: leads tier 2
    { key: 'd', score: 55, ci: [40, 85] },   // wide interval reaches a
    { key: 'e', score: 30, ci: [20, 45] },   // clear of a and c: leads tier 3
  ]);
  assert.deepEqual(Object.fromEntries(tiers), { a: 1, b: 1, c: 2, d: 1, e: 3 });
  assert.deepEqual(Object.fromEntries(tiersByOverlap([{ key: 'y', score: 50, ci: [50, 50] }, { key: 'x', score: 50, ci: [50, 50] }])), { x: 1, y: 1 });
  assert.equal(tiersByOverlap([]).size, 0);
});
