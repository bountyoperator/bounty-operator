import test from 'node:test';
import assert from 'node:assert/strict';
import { runFacts } from '../lib/runs.mjs';

test('published cost includes recorded retries within and before the current invocation', () => {
  assert.equal(runFacts({ usd: 0.2, usd_all_attempts: 0.5, usd_prior_attempts: 0.3 }).usd, 0.8);
  assert.equal(runFacts({ usd: 0.2, usd_all_attempts: 0.5 }).usd, 0.5);
});

test('legacy cost remains usable and missing cost is not invented', () => {
  assert.equal(runFacts({ usd: 0.2 }).usd, 0.2);
  assert.equal(runFacts({ usd: 0, usd_all_attempts: 0 }).usd, 0);
  assert.equal(runFacts({}).usd, null);
  assert.equal(runFacts({ usd_prior_attempts: 0.3 }).usd, null);
});
