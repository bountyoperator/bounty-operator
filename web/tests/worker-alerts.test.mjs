// The owner alert watch is wired into the scheduled handler: it runs on the
// */15 cron and not on the daily one, stays a no-op when no binding is set,
// and a failure inside it is logged with its message without stopping the run.

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

function fakeBinding({ refuse = null } = {}) {
  const sent = [];
  return {
    sent,
    send: async (message) => {
      if (refuse) throw new Error(refuse);
      sent.push(message);
      return { messageId: `test-${sent.length}` };
    },
  };
}

function fixture(t, overrides = {}) {
  setEmailMessageForTests(FakeEmailMessage);
  clearHostingState();
  t.after(() => setEmailMessageForTests(null));
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key', RUNPOD_ALERT_USD: '10', ALERT_EMAIL_TO: 'owner@example.com', ...overrides });
  const logged = t.mock.method(console, 'log', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  const run = async (cron) => {
    const ctx = createContext();
    await worker.scheduled({ cron }, env, ctx);
    await ctx.settled();
    const line = logged.mock.calls.at(-1).arguments;
    assert.equal(line[0], 'Scheduled cleanup');
    return line[1];
  };
  return { env, run, errors };
}

const lowBalance = () => Response.json({ data: { myself: { clientBalance: 1.25, underBalance: false } } });

test('the */15 cron reads RunPod once and emails the owner when the balance is low', async (t) => {
  const alertEmail = fakeBinding();
  const { run } = fixture(t, { ALERT_EMAIL: alertEmail });
  const fetched = t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(input, GRAPHQL);
    return lowBalance();
  });

  const result = await run(FREQUENT);
  assert.deepEqual(result.alerts, { status: 'ok', runpod: 'read', balance: 1.25, sales: 'off', sent: ['runpod_balance_low'], held: [] });
  assert.equal(alertEmail.sent.length, 1);
  assert.equal(alertEmail.sent[0].to, 'owner@example.com');
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

test('with the binding but no ALERT_EMAIL_TO the cron says what is missing and reads nothing', async (t) => {
  const { run } = fixture(t, { ALERT_EMAIL: fakeBinding(), ALERT_EMAIL_TO: '' });
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no RunPod read without a recipient'); });

  const result = await run(FREQUENT);
  assert.deepEqual(result.alerts, { status: 'not_configured', missing: 'ALERT_EMAIL_TO' });
  assert.equal(fetched.mock.callCount(), 0);
});

test('a refused send leaves the scheduled run standing, with the message in the log, and retries next run', async (t) => {
  const { env, run, errors } = fixture(t, { ALERT_EMAIL: fakeBinding({ refuse: 'email to owner@example.com not allowed' }) });
  t.mock.method(globalThis, 'fetch', async () => lowBalance());

  const result = await run(FREQUENT);
  assert.equal(result.alerts.status, 'error');
  assert.deepEqual(result.alerts.failed, ['runpod_balance_low']);
  assert.equal(result.alerts.error, 'email to owner@example.com not allowed');
  assert.ok(errors.mock.calls.some((call) => call.arguments[1]?.message === 'email to owner@example.com not allowed'));
  // No slot is held, so the next run sends.
  assert.equal(env.DB.sqlite.prepare("SELECT last_sent FROM operator_alerts WHERE id = 'runpod_balance_low'").get().last_sent, 0);
});

test('a database failure inside the watch is logged with its message and does not stop the run', async (t) => {
  const { env, run, errors } = fixture(t, { ALERT_EMAIL: fakeBinding() });
  t.mock.method(globalThis, 'fetch', async () => lowBalance());
  env.DB.sqlite.exec('DROP TABLE operator_alerts');

  const result = await run(FREQUENT);
  assert.equal(result.alerts.status, 'error');
  assert.match(result.alerts.error, /operator_alerts/);
  const logged = errors.mock.calls.find((call) => call.arguments[0] === 'Owner alert watch failed');
  assert.ok(logged, 'the failure is logged');
  assert.match(logged.arguments[1].message, /operator_alerts/);
});
