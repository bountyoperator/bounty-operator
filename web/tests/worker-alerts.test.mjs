// The owner alert watch is wired into the scheduled handler: it runs on the
// */15 cron and not on the daily one, and stays a no-op when no binding is set.

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/worker.ts';
import { setEmailMessageForTests } from '../src/alerts.ts';
import { clearHostingState } from '../src/inference.ts';
import { createContext, createEnv } from './worker-helpers.mjs';

const DAILY = '17 3 * * *';
const FREQUENT = '*/15 * * * *';
const GRAPHQL = 'https://api.runpod.io/graphql';

class FakeEmailMessage {
  constructor(from, to, raw) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}

function fakeBinding() {
  const sent = [];
  return { sent, send: async (message) => { sent.push(message); return { messageId: `test-${sent.length}` }; } };
}

function fixture(t, overrides = {}) {
  setEmailMessageForTests(FakeEmailMessage);
  clearHostingState();
  t.after(() => setEmailMessageForTests(null));
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key', RUNPOD_ALERT_USD: '10', ...overrides });
  const logged = t.mock.method(console, 'log', () => {});
  const run = async (cron) => {
    const ctx = createContext();
    await worker.scheduled({ cron }, env, ctx);
    await ctx.settled();
    return logged.mock.calls.at(-1).arguments[1];
  };
  return { env, run };
}

test('the */15 cron reads the balance and emails the owner when it is low', async (t) => {
  const alertEmail = fakeBinding();
  const { run } = fixture(t, { ALERT_EMAIL: alertEmail });
  const fetched = t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(input, GRAPHQL);
    return Response.json({ data: { myself: { clientBalance: 1.25, underBalance: false } } });
  });

  const result = await run(FREQUENT);
  assert.equal(result.alerts.balance, 'sent');
  assert.equal(alertEmail.sent.length, 1);
  assert.equal(fetched.mock.callCount(), 1);
});

test('the daily cron does not run the alert watch', async (t) => {
  const alertEmail = fakeBinding();
  const { run } = fixture(t, { ALERT_EMAIL: alertEmail });
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('the daily cron must not read the RunPod balance'); });

  const result = await run(DAILY);
  assert.equal(result.alerts, undefined);
  assert.equal(alertEmail.sent.length, 0);
  assert.equal(fetched.mock.callCount(), 0);
});

test('with no binding the */15 cron reports disabled and reads nothing', async (t) => {
  const { run } = fixture(t);
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no RunPod read without a binding'); });

  const result = await run(FREQUENT);
  assert.deepEqual(result.alerts, { status: 'disabled' });
  assert.equal(fetched.mock.callCount(), 0);
});
