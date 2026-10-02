// The budget planner: per-model cost from the measured token profile, cheapest first,
// a running total and the budget line. Pure functions, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetPlan, estimateTokens, priceTokens, profileClass, workspaceBytes } from '../lib/budget.mjs';
import { loadProtocol } from '../bench.mjs';

const kase = (id, family, variant, bytes) => ({ id, family, variant, workspace: [{ path: 'a', bytes: Buffer.alloc(bytes) }] });
const profile = { with_bug: { input: 1000, cached: 2000, output: 3000 }, clean: { input: 2000, cached: 4000, output: 6000 }, any: { input: 1500, cached: 3000, output: 4500 } };
const estimate = { workspace_bytes: 10_000, profiles: { mean: profile, low: { model: 'l', with_bug: { input: 500, cached: 0, output: 1000 }, clean: { input: 500, cached: 0, output: 1000 }, any: { input: 500, cached: 0, output: 1000 } }, high: { model: 'h', with_bug: { input: 2000, cached: 9000, output: 9000 }, clean: { input: 2000, cached: 9000, output: 9000 }, any: { input: 2000, cached: 9000, output: 9000 } } } };

test('a case is priced with the profile of its twin type; challenge drafts use the overall mean', () => {
  assert.equal(profileClass(kase('a-v', 'find-sol', 'vulnerable', 1)), 'with_bug');
  assert.equal(profileClass(kase('a-f', 'find-sol', 'fixed', 1)), 'clean');
  assert.equal(profileClass(kase('t-v', 'find-ts', 'vulnerable', 1)), 'with_bug');
  assert.equal(profileClass(kase('t-f', 'find-ts', 'fixed', 1)), 'clean');
  assert.equal(profileClass(kase('c-o', 'challenge', 'overclaimed', 1)), 'any');
  assert.equal(profileClass(kase('c-a', 'challenge', 'accurate', 1)), 'any');
});

test('input is scaled by workspace size, output is not', () => {
  const twice = kase('a-v', 'find-sol', 'vulnerable', 20_000);
  assert.equal(workspaceBytes(twice), 20_000);
  assert.deepEqual(estimateTokens(twice, profile, 10_000), { input: 2000, cached: 4000, output: 3000, scale: 2 });
  assert.deepEqual(estimateTokens(kase('a-f', 'find-sol', 'fixed', 5_000), profile, 10_000), { input: 1000, cached: 2000, output: 6000, scale: 0.5 });
  // no reference size or an empty workspace: the profile as measured
  assert.equal(estimateTokens(twice, profile, 0).scale, 1);
  assert.equal(estimateTokens(kase('x', 'find-sol', 'vulnerable', 0), profile, 10_000).scale, 1);
});

test('cost uses list prices per million and the cache-read rate when one is listed', () => {
  const tokens = { input: 1_000_000, cached: 2_000_000, output: 500_000 };
  assert.equal(priceTokens(tokens, { in: 2, out: 10, cache_read: 0.5 }), 2 + 1 + 5);
  assert.equal(priceTokens(tokens, { in: 2, out: 10, cache_read: null }), 2 + 4 + 5, 'no cache price: cached input at the input price');
  assert.equal(priceTokens(tokens, { in: null, out: null }), null);
  assert.equal(priceTokens(tokens, undefined), null);
});

test('models are listed cheapest first with a running total and the budget line', () => {
  const cases = [kase('a-v', 'find-sol', 'vulnerable', 10_000), kase('a-f', 'find-sol', 'fixed', 10_000), kase('c-o', 'challenge', 'overclaimed', 20_000)];
  // tokens per model: input 1000+2000+3000 = 6000, cached 2000+4000+6000 = 12000, output 3000+6000+4500 = 13500
  const models = [
    { slug: 'big/dear', run_tier: 3, price: { in: 1000, out: 2000, cache_read: 100 } },   // 6 + 1.2 + 27 = 34.2
    { slug: 'big/unlisted', run_tier: 2, price: { in: null, out: null } },
    { slug: 'small/cheap', run_tier: 1, price: { in: 100, out: 200, cache_read: null } },   // 0.6 + 1.2 + 2.7 = 4.5
    { slug: 'mid/model', run_tier: 2, price: { in: 500, out: 1000, cache_read: 50 } },      // 3 + 0.6 + 13.5 = 17.1
  ];
  const plan = budgetPlan({ cases, models, estimate, repeats: 1, budget: 25 });
  assert.deepEqual(plan.rows.map((r) => r.slug), ['small/cheap', 'mid/model', 'big/dear', 'big/unlisted']);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(plan.rows[0].usd, 4.5); near(plan.rows[1].usd, 17.1); near(plan.rows[2].usd, 34.2);
  assert.equal(plan.rows[3].usd, null);
  near(plan.rows[1].running, 21.6); near(plan.rows[2].running, 55.8);
  assert.deepEqual(plan.rows.map((r) => r.fits), [true, true, false, false]);
  assert.equal(plan.line, 2, 'the budget line falls before the third model');
  assert.equal(plan.fit, 2);
  near(plan.fit_usd, 21.6); near(plan.total, 55.8);
  assert.equal(plan.runsPerModel, 3);
  assert.ok(plan.rows.every((r) => r.usd === null || (r.low <= r.usd && r.usd <= r.high)), 'low and high bracket the estimate');

  // repeats multiply; a budget that covers everything puts the line after the last priced model
  const three = budgetPlan({ cases, models: models.filter((m) => m.price.in !== null), estimate, repeats: 3, budget: 1000 });
  near(three.total, 55.8 * 3);
  assert.equal(three.line, 3);
  assert.equal(three.runsPerModel, 9);
  // nothing fits
  assert.equal(budgetPlan({ cases, models, estimate, repeats: 1, budget: 1 }).fit, 0);
  assert.throws(() => budgetPlan({ cases, models, estimate: {}, budget: 10 }), /estimate\.raw_arm/);
});

test('protocol.json carries the measured raw-arm profile the planner needs', () => {
  const est = loadProtocol().protocol.estimate.raw_arm;
  assert.ok(est.workspace_bytes > 0);
  for (const name of ['mean', 'low', 'high']) for (const cls of ['with_bug', 'clean', 'any']) {
    const p = est.profiles[name][cls];
    assert.ok(p.input > 0 && p.cached >= 0 && p.output > 0 && p.runs > 0, `${name}.${cls}`);
  }
  assert.ok(est.profiles.mean.clean.output > est.profiles.mean.with_bug.output, 'the pilot measured a clean twin as dearer than a twin with the bug');
});
