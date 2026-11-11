// RunPod's own "under balance" flag stayed false on an account at -US$0.05
// (read 9 to 11 November 2026), with every model still listed as available and
// top-ups open. A balance that cannot pay for one request is out of funds,
// whatever the flag says.

import assert from 'node:assert/strict';
import test from 'node:test';

import { HOSTING_MIN_BALANCE_USD, clearHostingState, hostingRead, inferencePaused } from '../src/inference.ts';
import { createEnv } from './worker-helpers.mjs';

const answer = (myself) => Response.json({ data: { myself } });

test('a balance that cannot pay for one request reads as out of funds, whatever the flag says', async (t) => {
  let myself = {};
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    asked.push(JSON.parse(options.body).query);
    return answer(myself);
  });
  const env = createEnv({ RUNPOD_API_KEY: 'fixture-runpod-key' });
  const state = async (value) => {
    myself = value;
    clearHostingState();
    return (await hostingRead(env, true)).state;
  };

  assert.equal(HOSTING_MIN_BALANCE_USD, 0.5);
  for (const balance of [-0.0466678762, 0, 0.01, 0.49]) assert.equal(await state({ underBalance: false, clientBalance: balance }), 'paused', String(balance));
  for (const balance of [0.5, 1, 19.54]) assert.equal(await state({ underBalance: false, clientBalance: balance }), 'funded', String(balance));
  // The flag still decides when it says so, and an answer without a usable balance falls back to the flag.
  assert.equal(await state({ underBalance: true, clientBalance: 50 }), 'paused');
  for (const balance of [undefined, null, '12', Number.NaN]) assert.equal(await state({ underBalance: false, clientBalance: balance }), 'funded', String(balance));
  // No flag is still an unknown state, never funded on the balance alone.
  assert.deepEqual(await hostingReadOf(env, { clientBalance: 50 }, () => { myself = { clientBalance: 50 }; }), { state: 'unknown', reason: 'no_flag' });
  assert.ok(asked.every((query) => query === '{ myself { underBalance clientBalance } }'));

  // The same read closes sales: the account at -US$0.05 is paused.
  myself = { underBalance: false, clientBalance: -0.0466678762 };
  clearHostingState();
  assert.equal(await inferencePaused(env), true);
});

async function hostingReadOf(env, _value, set) {
  set();
  clearHostingState();
  return hostingRead(env, true);
}
