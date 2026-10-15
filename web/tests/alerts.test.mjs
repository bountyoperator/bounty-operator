// The owner alert watch: monitorRunpod reads the RunPod balance and the
// inference status on the */15 cron and emails the owner when either needs
// attention. These tests drive it with a fake send_email binding and a mocked
// RunPod GraphQL endpoint; no real email or network is involved.

import assert from 'node:assert/strict';
import test from 'node:test';

import { monitorRunpod, setEmailMessageForTests } from '../src/alerts.ts';
import { clearHostingState } from '../src/inference.ts';
import { createEnv } from './worker-helpers.mjs';
import { enableSupplierFixture } from './supplier-fixtures.mjs';

const GRAPHQL = 'https://api.runpod.io/graphql';
const NOW = 1_793_000_000;

/** A stand-in for cloudflare:email's EmailMessage, so the send path runs under node:test. */
class FakeEmailMessage {
  constructor(from, to, raw) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}

/** A send_email binding that records every message it is handed. */
function fakeBinding() {
  const sent = [];
  return { sent, send: async (message) => { sent.push(message); return { messageId: `test-${sent.length}` }; } };
}

/** Mocks fetch so every RunPod GraphQL read returns the given balance. */
function mockBalance(t, state) {
  return t.mock.method(globalThis, 'fetch', async (input, options) => {
    assert.equal(input, GRAPHQL);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    return Response.json({ data: { myself: { clientBalance: state.clientBalance, underBalance: state.underBalance } } });
  });
}

test.beforeEach(() => {
  setEmailMessageForTests(FakeEmailMessage);
  clearHostingState();
});

test.afterEach(() => {
  setEmailMessageForTests(null);
});

test('a balance below the threshold emails the owner once, with the balance and what to do', async (t) => {
  const alertEmail = fakeBinding();
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key', RUNPOD_ALERT_USD: '10', ALERT_EMAIL: alertEmail });
  mockBalance(t, { clientBalance: 3.5, underBalance: false });

  const result = await monitorRunpod(env, NOW);

  assert.equal(result.balance, 'sent');
  assert.equal(alertEmail.sent.length, 1);
  const [message] = alertEmail.sent;
  assert.equal(message.from, 'alerts@bountyoperator.com');
  assert.equal(message.to, 'support@bountyoperator.com');
  assert.match(message.raw, /^From: Bounty Operator Alerts <alerts@bountyoperator\.com>\r\n/);
  assert.match(message.raw, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(message.raw, /\$3\.50/);
  assert.match(message.raw, /below the \$10 alert threshold/);
  assert.match(message.raw, /https:\/\/console\.runpod\.io\/user\/billing/);
  assert.match(message.raw, /auto-pay/);
  // The row remembers when the owner was told.
  const row = env.DB.sqlite.prepare("SELECT last_sent, note FROM operator_alerts WHERE id = 'runpod_balance'").get();
  assert.deepEqual({ ...row }, { last_sent: NOW, note: 'low' });
});

test('underBalance alerts even when the numeric balance is unknown', async (t) => {
  const alertEmail = fakeBinding();
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key', ALERT_EMAIL: alertEmail });
  mockBalance(t, { clientBalance: null, underBalance: true });

  const result = await monitorRunpod(env, NOW);

  assert.equal(result.balance, 'sent');
  assert.equal(alertEmail.sent.length, 1);
  assert.match(alertEmail.sent[0].raw, /under its minimum balance/);
  assert.match(alertEmail.sent[0].raw, /Current RunPod balance: unknown/);
});

test('a second run within 24 hours does not email again', async (t) => {
  const alertEmail = fakeBinding();
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key', RUNPOD_ALERT_USD: '10', ALERT_EMAIL: alertEmail });
  mockBalance(t, { clientBalance: 2, underBalance: false });

  assert.equal((await monitorRunpod(env, NOW)).balance, 'sent');
  assert.equal((await monitorRunpod(env, NOW + 3600)).balance, 'suppressed');
  assert.equal((await monitorRunpod(env, NOW + DAY_MINUS_ONE())).balance, 'suppressed');
  assert.equal(alertEmail.sent.length, 1);

  // Once a full day has passed the standing problem is reported again.
  assert.equal((await monitorRunpod(env, NOW + 86400)).balance, 'sent');
  assert.equal(alertEmail.sent.length, 2);
});

test('a recovery resets the hold so the next dip emails straight away', async (t) => {
  const alertEmail = fakeBinding();
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key', RUNPOD_ALERT_USD: '10', ALERT_EMAIL: alertEmail });
  const state = { clientBalance: 1, underBalance: false };
  mockBalance(t, state);

  assert.equal((await monitorRunpod(env, NOW)).balance, 'sent');
  assert.equal(alertEmail.sent.length, 1);

  // Balance recovers above the threshold: no email, and the hold is cleared.
  state.clientBalance = 50;
  assert.equal((await monitorRunpod(env, NOW + 600)).balance, 'ok');
  assert.equal(alertEmail.sent.length, 1);
  assert.deepEqual({ ...env.DB.sqlite.prepare("SELECT last_sent, note FROM operator_alerts WHERE id = 'runpod_balance'").get() }, { last_sent: 0, note: 'ok' });

  // It dips again within the same day and alerts at once, because the hold was reset.
  state.clientBalance = 1;
  assert.equal((await monitorRunpod(env, NOW + 1200)).balance, 'sent');
  assert.equal(alertEmail.sent.length, 2);
});

test('a healthy balance sends nothing', async (t) => {
  const alertEmail = fakeBinding();
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key', RUNPOD_ALERT_USD: '10', ALERT_EMAIL: alertEmail });
  mockBalance(t, { clientBalance: 42, underBalance: false });

  assert.equal((await monitorRunpod(env, NOW)).balance, 'ok');
  assert.equal(alertEmail.sent.length, 0);
});

test('a missing send_email binding is a quiet no-op: no read, no send, no throw', async (t) => {
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key' });
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No RunPod read is expected without a binding'); });

  assert.deepEqual(await monitorRunpod(env, NOW), { status: 'disabled' });
  assert.equal(fetched.mock.callCount(), 0);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM operator_alerts').get().n, 0);
});

test('no RunPod key reports not_configured and reads nothing', async (t) => {
  const env = createEnv({ ALERT_EMAIL: fakeBinding() });
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No RunPod read is expected without a key'); });

  assert.deepEqual(await monitorRunpod(env, NOW), { status: 'not_configured' });
  assert.equal(fetched.mock.callCount(), 0);
});

test('a failed RunPod read sends nothing and does not throw', async (t) => {
  const alertEmail = fakeBinding();
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key', ALERT_EMAIL: alertEmail });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('upstream down'); });

  const result = await monitorRunpod(env, NOW);

  assert.equal(result.balance, 'unknown');
  assert.equal(alertEmail.sent.length, 0);
  // No balance row was written, so a later good read starts clean.
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM operator_alerts WHERE id = 'runpod_balance'").get().n, 0);
});

test('a non-200 RunPod read also sends nothing and does not throw', async (t) => {
  const alertEmail = fakeBinding();
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key', ALERT_EMAIL: alertEmail });
  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 500 }));

  assert.equal((await monitorRunpod(env, NOW)).balance, 'unknown');
  assert.equal(alertEmail.sent.length, 0);
});

test('inference flipping to paused and back emails the owner on each edge', async (t) => {
  const alertEmail = fakeBinding();
  const model = { id: 'cyber-test', name: 'Cyber test', source: 'test/model', revision: 'abc', license: 'Apache-2.0', quantization: 'AWQ', endpoint: 'https://watch123.api.runpod.ai', upstreamModel: 'cyber-test', inputRate: 2, outputRate: 8, minimumMicro: 10000, context: 32768, maxOutput: 8192 };
  const env = createEnv({ INFERENCE_ENABLED: 'true', RUNPOD_API_KEY: 'read-only-key', RUNPOD_ALERT_USD: '10', INFERENCE_MODELS: JSON.stringify([model]), ALERT_EMAIL: alertEmail });
  enableSupplierFixture(env);
  const state = { clientBalance: 50, underBalance: false };
  mockBalance(t, state);
  const subjects = () => alertEmail.sent.map((message) => message.raw.match(/Subject: (.*)\r\n/)[1]);

  // First pass: inference available, balance healthy. Nothing to report, the status is just recorded.
  let result = await monitorRunpod(env, NOW);
  assert.equal(result.inference, undefined);
  assert.equal(result.balance, 'ok');
  assert.equal(alertEmail.sent.length, 0);

  // The account empties: inference pauses and the balance is low, so both fire.
  state.clientBalance = 0;
  state.underBalance = true;
  clearHostingState();
  result = await monitorRunpod(env, NOW + 60);
  assert.equal(result.inference, 'paused');
  assert.equal(result.balance, 'sent');
  assert.deepEqual(subjects(), ['Bounty Operator: model inference paused', 'Bounty Operator: RunPod account is out of funds']);

  // Still paused within the day: no new email.
  clearHostingState();
  result = await monitorRunpod(env, NOW + 120);
  assert.equal(result.inference, undefined);
  assert.equal(result.balance, 'suppressed');
  assert.equal(alertEmail.sent.length, 2);

  // Funded again: inference recovers and the balance is healthy, so one recovery email.
  state.clientBalance = 50;
  state.underBalance = false;
  clearHostingState();
  result = await monitorRunpod(env, NOW + 180);
  assert.equal(result.inference, 'recovered');
  assert.equal(result.balance, 'ok');
  assert.deepEqual(subjects().slice(2), ['Bounty Operator: model inference back online']);
});

function DAY_MINUS_ONE() {
  return 86399;
}
