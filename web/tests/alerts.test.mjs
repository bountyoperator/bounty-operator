// The owner alert watch: monitorRunpod reads the RunPod account once per */15
// run, works out whether the Model API can sell, and emails the owner about
// every way sales can stop, at most once per condition per 24 hours. These
// tests drive it with a fake send_email binding, a mocked RunPod GraphQL
// endpoint and a mocked clock; no real email or network is involved.

import assert from 'node:assert/strict';
import test from 'node:test';

import { monitorRunpod, setEmailMessageForTests } from '../src/alerts.ts';
import { clearHostingState } from '../src/inference.ts';
import { createEnv } from './worker-helpers.mjs';

const GRAPHQL = 'https://api.runpod.io/graphql';
const NOW = 1_793_000_000;
const HOUR = 3600;
const DAY = 86400;
const OWNER = 'owner@example.com';

/** A stand-in for cloudflare:email's EmailMessage, so the send path runs under node:test. */
class FakeEmailMessage {
  constructor(from, to, raw) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}

/** A send_email binding that records every message it is handed, or refuses them all. */
function fakeBinding({ refuse = null } = {}) {
  const sent = [];
  const binding = {
    sent,
    refuse,
    send: async (message) => {
      if (binding.refuse) throw new Error(binding.refuse);
      sent.push(message);
      return { messageId: `test-${sent.length}` };
    },
  };
  return binding;
}

const subjects = (binding) => binding.sent.map((message) => message.raw.match(/\r\nSubject: (.*)\r\n/)[1]);
const bodyOf = (message) => message.raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');

/** Mocks fetch so every RunPod GraphQL read answers from `state`, which a test can change between runs. */
function mockRunpod(t, state) {
  return t.mock.method(globalThis, 'fetch', async (input, options) => {
    assert.equal(input, GRAPHQL);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(JSON.parse(options.body).query, '{ myself { clientBalance underBalance } }');
    if (state.answer) return state.answer();
    return Response.json({ data: { myself: { clientBalance: state.clientBalance, underBalance: state.underBalance } } });
  });
}

/** Mocks Date (the supplier checks read it) and returns a setter that moves it and hands back the time. */
function clock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
  return (at) => {
    t.mock.timers.setTime(at * 1000);
    return at;
  };
}

function balanceEnv(binding, overrides = {}) {
  return createEnv({ RUNPOD_API_KEY: 'read-only-key', RUNPOD_ALERT_USD: '10', ALERT_EMAIL: binding, ALERT_EMAIL_TO: OWNER, ...overrides });
}

const row = (env, id) => {
  const found = env.DB.sqlite.prepare('SELECT last_sent, note FROM operator_alerts WHERE id = ?').get(id);
  return found ? { ...found } : null;
};

// ---------------------------------------------------------------------------
// The selling fixture: one RunPod model, optionally a direct provider model,
// verified cost rules and funded budget windows, all relative to NOW.
// ---------------------------------------------------------------------------

const RUNPOD_MODEL = { id: 'cyber-test', name: 'Cyber test', source: 'test/model', revision: 'abc', license: 'Apache-2.0', quantization: 'AWQ', endpoint: 'https://watch123.api.runpod.ai', upstreamModel: 'cyber-test', inputRate: 2, outputRate: 8, minimumMicro: 10000, context: 32768, maxOutput: 8192 };
const DIRECT_MODEL = { id: 'direct-test', name: 'Direct test', source: 'vendor/direct-test', revision: null, license: null, quantization: null, endpoint: 'https://api.infron.ai', upstreamModel: 'vendor/direct-test', inputRate: 2, outputRate: 8, minimumMicro: 10000, context: 32768, maxOutput: 8192 };

function runpodRule(validUntil = NOW + 60 * DAY, model = RUNPOD_MODEL) {
  return { model: model.id, endpoint: model.endpoint, upstreamModel: model.upstreamModel, provider: 'runpod', resourceId: /^https:\/\/([a-z0-9]+)\./.exec(model.endpoint)[1],
    basis: 'runtime_allowance', revision: 'test-only-quote', source: 'https://fixtures.invalid/pricing', validUntil, holdMicro: 1000 };
}

function directRule(validUntil = NOW + 60 * DAY) {
  return { model: DIRECT_MODEL.id, endpoint: DIRECT_MODEL.endpoint, upstreamModel: DIRECT_MODEL.upstreamModel, provider: 'infron', resourceId: DIRECT_MODEL.upstreamModel,
    basis: 'token_rate', revision: 'test-only-quote', source: 'https://fixtures.invalid/pricing', validUntil, inputMicroPerMillion: 1000000, outputMicroPerMillion: 1000000, fixedMicro: 0 };
}

function addWindow(env, { id = 'runpod-window', provider = 'runpod', starts = NOW - DAY, ends = NOW + 30 * DAY, limit = 100_000_000, consumed = 0, enabled = 1 } = {}) {
  env.DB.sqlite.prepare(`INSERT INTO supplier_budget_windows (id, provider, starts_at, ends_at, limit_micro, consumed_micro, enabled, funding_reference, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'test fixture only - not real funding', ?)`).run(id, provider, starts, ends, limit, consumed, enabled, NOW);
}

function salesEnv(binding, { models = [RUNPOD_MODEL], rules = [runpodRule()], ...overrides } = {}) {
  const env = balanceEnv(binding, { INFERENCE_ENABLED: 'true', INFERENCE_MODELS: JSON.stringify(models), SUPPLIER_COST_RULES: JSON.stringify(rules), ...overrides });
  addWindow(env);
  return env;
}

test.beforeEach(() => {
  setEmailMessageForTests(FakeEmailMessage);
  clearHostingState();
});

test.afterEach(() => {
  setEmailMessageForTests(null);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('a missing send_email binding is a quiet no-op: no read, no send, no row', async (t) => {
  const env = createEnv({ RUNPOD_API_KEY: 'read-only-key', ALERT_EMAIL_TO: OWNER });
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No RunPod read is expected without a binding'); });

  assert.deepEqual(await monitorRunpod(env, NOW), { status: 'disabled' });
  assert.equal(fetched.mock.callCount(), 0);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM operator_alerts').get().n, 0);
});

test('a binding with no ALERT_EMAIL_TO is not configured: there is no default recipient, so nothing is read or sent', async (t) => {
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No RunPod read is expected without a recipient'); });
  for (const to of [undefined, '', '   ', 'not-an-address', `${OWNER}\r\nBcc: someone@example.net`, `Owner <${OWNER}>`]) {
    const binding = fakeBinding();
    const env = balanceEnv(binding, { ALERT_EMAIL_TO: to });
    assert.deepEqual(await monitorRunpod(env, NOW), { status: 'not_configured', missing: 'ALERT_EMAIL_TO' }, JSON.stringify(to));
    assert.equal(binding.sent.length, 0);
  }
  assert.equal(fetched.mock.callCount(), 0);
});

test('with no RunPod key the RunPod checks are skipped and every email would say the balance was not checked', async (t) => {
  const binding = fakeBinding();
  const env = createEnv({ ALERT_EMAIL: binding, ALERT_EMAIL_TO: OWNER });
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No RunPod read is expected without a key'); });

  const result = await monitorRunpod(env, NOW);
  assert.deepEqual(result, { status: 'ok', runpod: 'not_configured', balance: null, sales: 'off', sent: [], held: [] });
  assert.equal(fetched.mock.callCount(), 0);
});

// ---------------------------------------------------------------------------
// The RunPod balance
// ---------------------------------------------------------------------------

test('a balance below the threshold emails ALERT_EMAIL_TO once, with the balance once and what to do', async (t) => {
  const binding = fakeBinding();
  const env = balanceEnv(binding);
  mockRunpod(t, { clientBalance: 3.5, underBalance: false });

  const result = await monitorRunpod(env, NOW);

  assert.deepEqual(result, { status: 'ok', runpod: 'read', balance: 3.5, sales: 'off', sent: ['runpod_balance_low'], held: [] });
  assert.equal(binding.sent.length, 1);
  const [message] = binding.sent;
  assert.equal(message.from, 'alerts@bountyoperator.com');
  assert.equal(message.to, OWNER);
  assert.match(message.raw, /^From: Bounty Operator Alerts <alerts@bountyoperator\.com>\r\nTo: <owner@example\.com>\r\n/);
  assert.match(message.raw, /\r\nSubject: Bounty Operator: RunPod balance is low\r\n/);
  assert.match(message.raw, /Content-Type: text\/plain; charset=utf-8/);
  const body = bodyOf(message);
  assert.match(body, /below the \$10\.00 alert threshold \(RUNPOD_ALERT_USD\)/);
  assert.equal(body.match(/\$3\.50/g).length, 1, 'the balance is stated once');
  assert.match(body, /Current RunPod balance: \$3\.50\./);
  assert.match(body, /https:\/\/console\.runpod\.io\/user\/billing/);
  assert.match(body, /auto-pay/);
  assert.match(body, /When it runs out, RunPod workers stop/);
  assert.doesNotMatch(body, /[^\r\n\x20-\x7e]/, 'plain ASCII, as 7bit promises');
  assert.doesNotMatch(body.replace(/\r\n/g, ''), /[\r\n]/, 'CRLF line endings only');
  assert.deepEqual(row(env, 'runpod_balance_low'), { last_sent: NOW, note: 'below $10.00' });
});

test('an account under its minimum balance sends the out-of-funds email even when RunPod reports no number', async (t) => {
  const binding = fakeBinding();
  const env = balanceEnv(binding);
  mockRunpod(t, { clientBalance: null, underBalance: true });

  const result = await monitorRunpod(env, NOW);

  assert.deepEqual(result.sent, ['runpod_under_balance']);
  assert.deepEqual(subjects(binding), ['Bounty Operator: RunPod account is out of funds']);
  const body = bodyOf(binding.sent[0]);
  assert.match(body, /under its minimum balance, so no RunPod worker can start/);
  assert.match(body, /Model inference is switched off/);
  assert.match(body, /Current RunPod balance: not reported by RunPod\./);
});

test('a standing low balance emails at most once in 24 hours, then again once a day', async (t) => {
  const binding = fakeBinding();
  const env = balanceEnv(binding);
  mockRunpod(t, { clientBalance: 2, underBalance: false });

  assert.deepEqual((await monitorRunpod(env, NOW)).sent, ['runpod_balance_low']);
  assert.deepEqual((await monitorRunpod(env, NOW + HOUR)).held, ['runpod_balance_low']);
  assert.deepEqual((await monitorRunpod(env, NOW + DAY - 1)).held, ['runpod_balance_low']);
  assert.equal(binding.sent.length, 1);

  assert.deepEqual((await monitorRunpod(env, NOW + DAY)).sent, ['runpod_balance_low']);
  assert.equal(binding.sent.length, 2);
});

test('a balance that recovers and dips again within the day still sends only one email in 24 hours', async (t) => {
  const binding = fakeBinding();
  const env = balanceEnv(binding);
  const state = { clientBalance: 1, underBalance: false };
  mockRunpod(t, state);

  assert.deepEqual((await monitorRunpod(env, NOW)).sent, ['runpod_balance_low']);
  state.clientBalance = 50;
  assert.deepEqual(await monitorRunpod(env, NOW + 600), { status: 'ok', runpod: 'read', balance: 50, sales: 'off', sent: [], held: [] });
  state.clientBalance = 1;
  assert.deepEqual((await monitorRunpod(env, NOW + 1200)).held, ['runpod_balance_low']);
  assert.equal(binding.sent.length, 1);
  assert.deepEqual((await monitorRunpod(env, NOW + DAY)).sent, ['runpod_balance_low']);
});

test('a healthy balance sends nothing', async (t) => {
  const binding = fakeBinding();
  const env = balanceEnv(binding);
  mockRunpod(t, { clientBalance: 42, underBalance: false });

  assert.deepEqual(await monitorRunpod(env, NOW), { status: 'ok', runpod: 'read', balance: 42, sales: 'off', sent: [], held: [] });
  assert.equal(binding.sent.length, 0);
});

test('a blank, spaced or unreadable RUNPOD_ALERT_USD means the $10 default, never $0', async (t) => {
  mockRunpod(t, { clientBalance: 2, underBalance: false });
  for (const threshold of ['', '   ', 'ten', undefined, '-5']) {
    const binding = fakeBinding();
    const env = balanceEnv(binding, { RUNPOD_ALERT_USD: threshold });
    assert.deepEqual((await monitorRunpod(env, NOW)).sent, ['runpod_balance_low'], JSON.stringify(threshold));
    assert.match(bodyOf(binding.sent[0]), /below the \$10\.00 alert threshold/);
  }
  // A real value is used as given.
  const binding = fakeBinding();
  assert.deepEqual((await monitorRunpod(balanceEnv(binding, { RUNPOD_ALERT_USD: ' 1.5 ' }), NOW)).sent, []);
});

test('an unreadable RunPod answer sends nothing and writes no balance row', async (t) => {
  const answers = {
    'a network failure': () => { throw new Error('upstream down'); },
    'a 500': () => new Response('nope', { status: 500 }),
    'a redirect': () => new Response(null, { status: 302, headers: { Location: 'https://example.net/' } }),
    'GraphQL errors beside null data': () => Response.json({ errors: [{ message: 'unauthorized' }], data: { myself: { clientBalance: null, underBalance: null } } }),
    'GraphQL errors beside a real-looking answer': () => Response.json({ errors: [{ message: 'partial' }], data: { myself: { clientBalance: 1, underBalance: true } } }),
    'no underBalance field': () => Response.json({ data: { myself: { clientBalance: 1 } } }),
    'a non-boolean underBalance': () => Response.json({ data: { myself: { clientBalance: 1, underBalance: 'yes' } } }),
    'no account': () => Response.json({ data: { myself: null } }),
    'a body that is not JSON': () => new Response('<html>', { status: 200 }),
  };
  for (const [name, answer] of Object.entries(answers)) {
    const binding = fakeBinding();
    const env = balanceEnv(binding);
    const fetched = mockRunpod(t, { answer });
    const result = await monitorRunpod(env, NOW);
    assert.equal(result.runpod, 'unreadable', name);
    assert.equal(result.balance, null, name);
    assert.deepEqual(result.sent, [], name);
    assert.equal(binding.sent.length, 0, name);
    assert.equal(row(env, 'runpod_balance_low'), null, name);
    assert.equal(row(env, 'runpod_under_balance'), null, name);
    fetched.mock.restore();
  }
});

test('reads that keep failing send one "cannot be read" email after an hour, and a good read resets the count', async (t) => {
  const binding = fakeBinding();
  const env = balanceEnv(binding);
  const state = { answer: () => new Response('down', { status: 503 }) };
  mockRunpod(t, state);

  assert.deepEqual((await monitorRunpod(env, NOW)).sent, []);
  assert.deepEqual(row(env, 'runpod_read'), { last_sent: 0, note: String(NOW) });
  assert.deepEqual((await monitorRunpod(env, NOW + HOUR - 1)).sent, []);
  assert.deepEqual((await monitorRunpod(env, NOW + HOUR)).sent, ['runpod_unreadable']);
  assert.deepEqual(subjects(binding), ['Bounty Operator: the RunPod account cannot be read']);
  const body = bodyOf(binding.sent[0]);
  assert.match(body, /since 2026-10-26 \d\d:\d\d UTC has failed/);
  assert.match(body, /RUNPOD_API_KEY/);
  assert.match(body, /Current RunPod balance: could not be read\./);
  assert.deepEqual((await monitorRunpod(env, NOW + 2 * HOUR)).held, ['runpod_unreadable']);
  assert.deepEqual((await monitorRunpod(env, NOW + DAY + HOUR)).sent, ['runpod_unreadable'], 'one email per day while it lasts');

  // One good read clears the failing-since time.
  delete state.answer;
  Object.assign(state, { clientBalance: 50, underBalance: false });
  assert.equal((await monitorRunpod(env, NOW + DAY + 2 * HOUR)).runpod, 'read');
  assert.equal(row(env, 'runpod_read').note, 'ok');
  state.answer = () => new Response('down', { status: 503 });
  await monitorRunpod(env, NOW + DAY + 3 * HOUR);
  assert.equal(row(env, 'runpod_read').note, String(NOW + DAY + 3 * HOUR));
  assert.equal(binding.sent.length, 2);
});

test('with only RunPod models on sale, the "cannot be read" email says sales and top-ups are closed', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  const state = { answer: () => new Response('down', { status: 503 }) };
  mockRunpod(t, state);

  assert.equal((await monitorRunpod(env, at(NOW))).sales, 'unknown');
  const result = await monitorRunpod(env, at(NOW + HOUR));
  assert.equal(result.sales, 'unknown');
  assert.deepEqual(result.sent, ['runpod_unreadable']);
  const body = bodyOf(binding.sent[0]);
  assert.match(body, /the Model API is selling nothing and taking no top-up while the read keeps failing/);
  // No paused or recovery email comes out of a read that failed.
  assert.equal(row(env, 'model_sales'), null);

  // Once a model on another provider can sell, the email is the milder one again.
  const mixed = fakeBinding();
  const open = salesEnv(mixed, { models: [RUNPOD_MODEL, DIRECT_MODEL], rules: [runpodRule(), directRule()], INFRON_API_KEY: 'direct-key' });
  addWindow(open, { id: 'infron-window', provider: 'infron' });
  assert.equal((await monitorRunpod(open, at(NOW))).sales, 'available');
  assert.deepEqual((await monitorRunpod(open, at(NOW + HOUR))).sent, ['runpod_unreadable']);
  assert.match(bodyOf(mixed.sent[0]), /RunPod-hosted model sales may stop without a warning/);
});

// ---------------------------------------------------------------------------
// Model sales: the RunPod pause
// ---------------------------------------------------------------------------

test('when the account empties and sales pause, the owner gets one combined email, not two', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  const state = { clientBalance: 50, underBalance: false };
  mockRunpod(t, state);

  let result = await monitorRunpod(env, at(NOW));
  assert.equal(result.sales, 'available');
  assert.deepEqual(result.sent, []);

  Object.assign(state, { clientBalance: 0, underBalance: true });
  result = await monitorRunpod(env, at(NOW + 900));
  assert.equal(result.sales, 'paused');
  assert.deepEqual(result.sent, ['runpod_under_balance']);
  assert.deepEqual(subjects(binding), ['Bounty Operator: RunPod is out of funds and model sales are paused']);
  const body = bodyOf(binding.sent[0]);
  assert.match(body, /The Model API is not selling: every model that could sell runs on RunPod/);
  assert.match(body, /Current RunPod balance: \$0\.00\./);
  assert.deepEqual(row(env, 'model_sales'), { last_sent: 0, note: 'paused' });
});

test('a failed read while sales are paused sends no false "back" email and keeps the paused status', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  const state = { clientBalance: 50, underBalance: false };
  mockRunpod(t, state);

  await monitorRunpod(env, at(NOW));
  Object.assign(state, { clientBalance: 0, underBalance: true });
  await monitorRunpod(env, at(NOW + 900));
  assert.deepEqual(subjects(binding), ['Bounty Operator: RunPod is out of funds and model sales are paused']);

  // A network failure: no email, the status row stays paused.
  state.answer = () => { throw new Error('timeout'); };
  let result = await monitorRunpod(env, at(NOW + 1800));
  assert.equal(result.sales, 'unknown');
  assert.deepEqual(result.sent, []);
  assert.deepEqual(row(env, 'model_sales'), { last_sent: 0, note: 'paused' });

  // Paused again on a good read: nothing new (the pause email is held for the day).
  delete state.answer;
  result = await monitorRunpod(env, at(NOW + 2700));
  assert.equal(result.sales, 'paused');
  assert.deepEqual(result.sent, []);

  // A 500 while paused: still nothing.
  state.answer = () => new Response('busy', { status: 500 });
  result = await monitorRunpod(env, at(NOW + 3600));
  assert.equal(result.sales, 'unknown');
  assert.deepEqual(result.sent, []);
  assert.equal(binding.sent.length, 1);

  // Funded again: one email says sales are back.
  delete state.answer;
  Object.assign(state, { clientBalance: 60, underBalance: false });
  result = await monitorRunpod(env, at(NOW + 4500));
  assert.equal(result.sales, 'available');
  assert.deepEqual(result.sent, ['model_sales_resumed']);
  assert.deepEqual(subjects(binding).slice(1), ['Bounty Operator: model sales are back']);
  assert.match(bodyOf(binding.sent[1]), /Current RunPod balance: \$60\.00\./);
  assert.deepEqual(row(env, 'model_sales'), { last_sent: 0, note: 'available' });
});

test('a failed read while sales are available changes nothing either', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  const state = { clientBalance: 50, underBalance: false };
  mockRunpod(t, state);

  await monitorRunpod(env, at(NOW));
  state.answer = () => new Response('busy', { status: 500 });
  assert.equal((await monitorRunpod(env, at(NOW + 900))).sales, 'unknown');
  delete state.answer;
  assert.deepEqual((await monitorRunpod(env, at(NOW + 1800))).sent, []);
  assert.equal(binding.sent.length, 0);
});

test('a direct provider keeps sales open while RunPod is out of funds, and the email says so', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding, { models: [RUNPOD_MODEL, DIRECT_MODEL], rules: [runpodRule(), directRule()], INFRON_API_KEY: 'direct-key' });
  addWindow(env, { id: 'infron-window', provider: 'infron' });
  mockRunpod(t, { clientBalance: 0, underBalance: true });

  const result = await monitorRunpod(env, at(NOW));
  assert.equal(result.sales, 'available');
  assert.deepEqual(result.sent, ['runpod_under_balance']);
  assert.deepEqual(subjects(binding), ['Bounty Operator: RunPod account is out of funds']);
  assert.match(bodyOf(binding.sent[0]), /Models on other providers still sell, but the RunPod-hosted models cannot run/);
});

test('a mixed catalog that stops selling after the day\'s out-of-funds email still gets one stop email', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding, { models: [RUNPOD_MODEL, DIRECT_MODEL], rules: [runpodRule(), directRule()], INFRON_API_KEY: 'direct-key' });
  addWindow(env, { id: 'infron-window', provider: 'infron' });
  mockRunpod(t, { clientBalance: 0, underBalance: true });

  // RunPod is out of funds while the direct model still sells, so that email cannot carry a stop.
  let result = await monitorRunpod(env, at(NOW));
  assert.equal(result.sales, 'available');
  assert.deepEqual(result.sent, ['runpod_under_balance']);

  // The direct budget runs down, then out: nothing sells, and the day's out-of-funds email is held.
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = 85000000 WHERE id = 'infron-window'").run();
  assert.deepEqual((await monitorRunpod(env, at(NOW + HOUR))).sent, ['budget_low:infron-window']);
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = limit_micro WHERE id = 'infron-window'").run();
  result = await monitorRunpod(env, at(NOW + 2 * HOUR));

  assert.equal(result.sales, 'paused');
  assert.deepEqual(result.sent, ['model_sales_paused']);
  assert.deepEqual(result.held, ['runpod_under_balance', 'budget_low:infron-window']);
  assert.equal(subjects(binding).at(-1), 'Bounty Operator: model sales have stopped, RunPod is out of funds');
  const body = bodyOf(binding.sent.at(-1));
  assert.match(body, /not selling: RunPod reports the account under its minimum balance and no model on another provider can sell/);
  assert.match(body, /new top-ups are closed too/);
  assert.match(body, /- direct-test: its provider's supplier budget window is used up\./);
  assert.match(body, /https:\/\/console\.runpod\.io\/user\/billing/);
  assert.deepEqual(row(env, 'model_sales'), { last_sent: 0, note: 'paused' });

  // The stop is said once: the next run adds nothing.
  assert.deepEqual((await monitorRunpod(env, at(NOW + 3 * HOUR))).sent, []);
  assert.equal(binding.sent.length, 3);
});

test('a used-up budget while RunPod is paused does not say that other providers still sell', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding, { models: [RUNPOD_MODEL, DIRECT_MODEL], rules: [runpodRule(), directRule()], INFRON_API_KEY: 'direct-key' });
  addWindow(env, { id: 'infron-window', provider: 'infron' });
  mockRunpod(t, { clientBalance: 0, underBalance: true });

  await monitorRunpod(env, at(NOW));
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = limit_micro WHERE id = 'infron-window'").run();
  const result = await monitorRunpod(env, at(NOW + HOUR));

  assert.equal(result.sales, 'paused');
  assert.deepEqual(result.sent, ['model_sales_paused', 'budget_low:infron-window']);
  assert.equal(subjects(binding).at(-1), 'Bounty Operator: the Infron supplier budget is used up');
  const body = bodyOf(binding.sent.at(-1));
  assert.match(body, /so the Infron models have stopped selling\. Nothing else is selling either: RunPod reports the account under its minimum balance\./);
  assert.doesNotMatch(body, /Models on other providers still sell/);
});

test('a second RunPod pause the same day is announced, though the out-of-funds email is held', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  const state = { clientBalance: 50, underBalance: false };
  mockRunpod(t, state);

  await monitorRunpod(env, at(NOW));
  Object.assign(state, { clientBalance: 0, underBalance: true });
  assert.deepEqual((await monitorRunpod(env, at(NOW + HOUR))).sent, ['runpod_under_balance']);
  Object.assign(state, { clientBalance: 30, underBalance: false });
  assert.deepEqual((await monitorRunpod(env, at(NOW + 2 * HOUR))).sent, ['model_sales_resumed']);
  // The pause slot is still free, so a second pause would be announced at once: the email promises no wait.
  assert.doesNotMatch(bodyOf(binding.sent.at(-1)), /waits until then/);

  Object.assign(state, { clientBalance: 0, underBalance: true });
  const result = await monitorRunpod(env, at(NOW + 3 * HOUR));
  assert.equal(result.sales, 'paused');
  assert.deepEqual(result.sent, ['model_sales_paused']);
  assert.deepEqual(result.held, ['runpod_under_balance']);
  assert.equal(subjects(binding).at(-1), 'Bounty Operator: model sales have stopped, RunPod is out of funds');
  assert.deepEqual(row(env, 'model_sales'), { last_sent: 0, note: 'paused' });
});

test('a pause email that fails keeps the last sales status, so the next run sends it', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  const state = { clientBalance: 50, underBalance: false };
  mockRunpod(t, state);
  t.mock.method(console, 'error', () => {});

  await monitorRunpod(env, at(NOW));
  Object.assign(state, { clientBalance: 0, underBalance: true });
  assert.deepEqual((await monitorRunpod(env, at(NOW + HOUR))).sent, ['runpod_under_balance']);
  Object.assign(state, { clientBalance: 30, underBalance: false });
  assert.deepEqual((await monitorRunpod(env, at(NOW + 2 * HOUR))).sent, ['model_sales_resumed']);

  // The out-of-funds slot is held, so model_sales_paused alone carries this pause; its send fails.
  Object.assign(state, { clientBalance: 0, underBalance: true });
  binding.refuse = 'temporarily refused';
  const failed = await monitorRunpod(env, at(NOW + 3 * HOUR));
  assert.deepEqual(failed.failed, ['model_sales_paused']);
  assert.notEqual(row(env, 'model_sales').note, 'paused');

  binding.refuse = null;
  const retried = await monitorRunpod(env, at(NOW + 3 * HOUR + 15 * 60));
  assert.deepEqual(retried.sent, ['model_sales_paused']);
  assert.deepEqual(row(env, 'model_sales'), { last_sent: 0, note: 'paused' });
});

test('a combined pause email that fails is retried and still carries the stop, so no second one is sent', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  const state = { clientBalance: 50, underBalance: false };
  mockRunpod(t, state);
  t.mock.method(console, 'error', () => {});

  await monitorRunpod(env, at(NOW));
  Object.assign(state, { clientBalance: 0, underBalance: true });
  binding.refuse = 'temporarily refused';
  // The slot is handed back, so the same email goes out next run, stop and all.
  assert.deepEqual((await monitorRunpod(env, at(NOW + HOUR))).failed, ['runpod_under_balance']);
  assert.equal(row(env, 'runpod_under_balance').last_sent, 0);

  binding.refuse = null;
  assert.deepEqual((await monitorRunpod(env, at(NOW + 2 * HOUR))).sent, ['runpod_under_balance']);
  assert.deepEqual(subjects(binding), ['Bounty Operator: RunPod is out of funds and model sales are paused']);
  assert.deepEqual(row(env, 'model_sales'), { last_sent: 0, note: 'paused' });
});

test('the "sales are back" email names the time a new stop email would wait for', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  await monitorRunpod(env, at(NOW));
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = limit_micro WHERE id = 'runpod-window'").run();
  assert.deepEqual((await monitorRunpod(env, at(NOW + HOUR))).sent, ['model_sales_stopped']);
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET limit_micro = limit_micro * 2 WHERE id = 'runpod-window'").run();
  assert.deepEqual((await monitorRunpod(env, at(NOW + 2 * HOUR))).sent, ['model_sales_resumed']);
  assert.match(bodyOf(binding.sent.at(-1)), /If sales stop the same way again before 2026-10-27 \d\d:\d\d UTC, the email about it waits until then\./);

  // And they do wait: the second stop inside the day is held, as the email said.
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = limit_micro WHERE id = 'runpod-window'").run();
  assert.deepEqual((await monitorRunpod(env, at(NOW + 3 * HOUR))).held, ['model_sales_stopped']);

  // With the slot free again, the recovery email says nothing about a wait.
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET limit_micro = limit_micro * 2 WHERE id = 'runpod-window'").run();
  assert.deepEqual((await monitorRunpod(env, at(NOW + 2 * DAY))).sent, ['model_sales_resumed']);
  assert.doesNotMatch(bodyOf(binding.sent.at(-1)), /waits until then/);
});

// ---------------------------------------------------------------------------
// Model sales: supplier budget and cost rules
// ---------------------------------------------------------------------------

test('a used-up supplier budget stops sales: one email with the reason, daily while it lasts, and one when sales come back', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  assert.equal((await monitorRunpod(env, at(NOW))).sales, 'available');

  // Less is left than one request's hold.
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = limit_micro - 500 WHERE id = 'runpod-window'").run();
  let result = await monitorRunpod(env, at(NOW + 900));
  assert.equal(result.sales, 'unavailable');
  assert.deepEqual(result.sent, ['model_sales_stopped'], 'the budget-low warning is folded into the stop email');
  assert.deepEqual(subjects(binding), ['Bounty Operator: model sales have stopped']);
  const body = bodyOf(binding.sent[0]);
  assert.match(body, /inference is switched on, but no model can take a paid request/);
  assert.match(body, /- cyber-test: its provider's supplier budget window is used up\./);
  assert.match(body, /Raise limit_micro on the current supplier_budget_windows row/);
  assert.match(body, /Current RunPod balance: \$50\.00\./);
  assert.deepEqual(row(env, 'model_sales_stopped'), { last_sent: NOW + 900, note: 'cyber-test:budget_exhausted' });

  assert.deepEqual((await monitorRunpod(env, at(NOW + 1800))).held, ['model_sales_stopped']);
  assert.deepEqual((await monitorRunpod(env, at(NOW + 900 + DAY))).sent, ['model_sales_stopped'], 'a standing stop is repeated once a day');

  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET limit_micro = limit_micro * 2 WHERE id = 'runpod-window'").run();
  result = await monitorRunpod(env, at(NOW + 2 * DAY));
  assert.equal(result.sales, 'available');
  assert.deepEqual(result.sent, ['model_sales_resumed']);
  assert.equal(subjects(binding).at(-1), 'Bounty Operator: model sales are back');
});

test('a budget window that ended stops sales with that reason', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET ends_at = ? WHERE id = 'runpod-window'").run(NOW + HOUR);
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  assert.equal((await monitorRunpod(env, at(NOW))).sales, 'available');
  const result = await monitorRunpod(env, at(NOW + HOUR));
  assert.equal(result.sales, 'unavailable');
  assert.deepEqual(result.sent, ['model_sales_stopped']);
  const body = bodyOf(binding.sent.at(-1));
  assert.match(body, /- cyber-test: no enabled, funded supplier budget window covers now for its provider/);
  assert.match(body, /Open a funded supplier_budget_windows row for that provider/);
});

test('an expired cost rule stops sales with one email that names it, not a second rule warning', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding, { rules: [runpodRule(NOW - HOUR)] });
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  const result = await monitorRunpod(env, at(NOW));
  assert.equal(result.sales, 'unavailable');
  assert.deepEqual(result.sent, ['model_sales_stopped']);
  const body = bodyOf(binding.sent[0]);
  assert.match(body, /- cyber-test: its SUPPLIER_COST_RULES entry expired on 2026-10-26 \d\d:\d\d UTC\./);
  assert.match(body, /Renew the expired SUPPLIER_COST_RULES entry/);
});

test('inference switched on with no usable model is a stop too', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding, { models: [] });
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  const result = await monitorRunpod(env, at(NOW));
  assert.equal(result.sales, 'unavailable');
  assert.deepEqual(result.sent, ['model_sales_stopped']);
  assert.match(bodyOf(binding.sent[0]), /No model in INFERENCE_MODELS is usable/);
  assert.deepEqual(row(env, 'model_sales_stopped'), { last_sent: NOW, note: 'no models' });
});

test('inference switched off by the operator sends no sales or supplier warnings', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding, { INFERENCE_ENABLED: 'false', rules: [runpodRule(NOW + DAY)] });
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = limit_micro WHERE id = 'runpod-window'").run();
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  const result = await monitorRunpod(env, at(NOW));
  assert.equal(result.sales, 'off');
  assert.deepEqual(result.sent, []);
});

test('a cost rule expiring within 7 days is warned about once a day, per rule', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const second = { ...RUNPOD_MODEL, id: 'cyber-two', endpoint: 'https://watch456.api.runpod.ai', upstreamModel: 'cyber-two' };
  const env = salesEnv(binding, { models: [RUNPOD_MODEL, second], rules: [runpodRule(NOW + 3 * DAY + HOUR), runpodRule(NOW + 6 * DAY, second)] });
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  let result = await monitorRunpod(env, at(NOW));
  assert.equal(result.sales, 'available');
  assert.deepEqual(result.sent, ['supplier_rule:cyber-test', 'supplier_rule:cyber-two']);
  assert.deepEqual(subjects(binding), ['Bounty Operator: the cost rule for cyber-test expires in 3 days', 'Bounty Operator: the cost rule for cyber-two expires in 6 days']);
  const body = bodyOf(binding.sent[0]);
  assert.match(body, /The SUPPLIER_COST_RULES entry for cyber-test \(RunPod\) is valid until 2026-10-29 \d\d:\d\d UTC, in 3 days\./);
  assert.match(body, /When it expires, cyber-test stops selling/);
  assert.match(body, /check RunPod's current price, update the entry's rates, revision, source and validUntil, and deploy/);

  result = await monitorRunpod(env, at(NOW + 12 * HOUR));
  assert.deepEqual(result.sent, []);
  assert.deepEqual(result.held, ['supplier_rule:cyber-test', 'supplier_rule:cyber-two']);

  result = await monitorRunpod(env, at(NOW + DAY));
  assert.deepEqual(result.sent, ['supplier_rule:cyber-test', 'supplier_rule:cyber-two']);
  assert.equal(subjects(binding)[2], 'Bounty Operator: the cost rule for cyber-test expires in 2 days');
});

test('a rule more than 7 days out is not warned about, and an expired rule keeps warning while another model sells', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding, { models: [RUNPOD_MODEL, DIRECT_MODEL], rules: [runpodRule(NOW - HOUR), directRule(NOW + 8 * DAY)], INFRON_API_KEY: 'direct-key' });
  addWindow(env, { id: 'infron-window', provider: 'infron' });
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  const result = await monitorRunpod(env, at(NOW));
  assert.equal(result.sales, 'available');
  assert.deepEqual(result.sent, ['supplier_rule:cyber-test']);
  assert.deepEqual(subjects(binding), ['Bounty Operator: the cost rule for cyber-test has expired']);
  assert.match(bodyOf(binding.sent[0]), /cyber-test has not sold since/);
});

test('a budget window ending within 7 days with nothing after it is warned about; one with a funded successor is not', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET ends_at = ? WHERE id = 'runpod-window'").run(NOW + 2 * DAY);
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  let result = await monitorRunpod(env, at(NOW));
  assert.deepEqual(result.sent, ['budget_ending:runpod-window']);
  assert.deepEqual(subjects(binding), ['Bounty Operator: the RunPod supplier budget ends in 2 days']);
  assert.match(bodyOf(binding.sent[0]), /window runpod-window ends on 2026-10-28 \d\d:\d\d UTC, in 2 days, and no funded window follows it/);

  addWindow(env, { id: 'runpod-next', starts: NOW + 2 * DAY, ends: NOW + 40 * DAY });
  result = await monitorRunpod(env, at(NOW + DAY));
  assert.deepEqual(result.sent, []);
  assert.deepEqual(result.held, []);
});

test('a budget with less than a fifth left is warned about once a day while models still sell', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET limit_micro = 15000000, consumed_micro = 13000000 WHERE id = 'runpod-window'").run();
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  let result = await monitorRunpod(env, at(NOW));
  assert.equal(result.sales, 'available');
  assert.deepEqual(result.sent, ['budget_low:runpod-window']);
  assert.deepEqual(subjects(binding), ['Bounty Operator: the RunPod supplier budget is nearly used up']);
  assert.match(bodyOf(binding.sent[0]), /window runpod-window has \$2\.00 of \$15\.00 left \(13%\)/);
  result = await monitorRunpod(env, at(NOW + HOUR));
  assert.deepEqual(result.held, ['budget_low:runpod-window']);
});

test('a used-up budget for one provider while another still sells says those models have stopped', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding, { models: [RUNPOD_MODEL, DIRECT_MODEL], rules: [runpodRule(), directRule()], INFRON_API_KEY: 'direct-key' });
  addWindow(env, { id: 'infron-window', provider: 'infron' });
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = limit_micro - 500 WHERE id = 'runpod-window'").run();
  mockRunpod(t, { clientBalance: 50, underBalance: false });

  const result = await monitorRunpod(env, at(NOW));
  assert.equal(result.sales, 'available');
  assert.deepEqual(result.sent, ['budget_low:runpod-window']);
  assert.deepEqual(subjects(binding), ['Bounty Operator: the RunPod supplier budget is used up']);
  assert.match(bodyOf(binding.sent[0]), /so the RunPod models have stopped selling\. Models on other providers still sell\./);
});

// ---------------------------------------------------------------------------
// Failures and overlapping runs
// ---------------------------------------------------------------------------

test('a refused send does not throw: the run reports it, logs the message, and the next run tries again', async (t) => {
  const binding = fakeBinding({ refuse: 'email to owner@example.com not allowed' });
  const env = balanceEnv(binding);
  mockRunpod(t, { clientBalance: 2, underBalance: false });
  const errors = t.mock.method(console, 'error', () => {});

  const result = await monitorRunpod(env, NOW);
  assert.deepEqual(result, { status: 'error', runpod: 'read', balance: 2, sales: 'off', sent: [], held: [], failed: ['runpod_balance_low'], error: 'email to owner@example.com not allowed' });
  assert.deepEqual(errors.mock.calls[0].arguments, ['Owner alert email failed', { condition: 'runpod_balance_low', message: 'email to owner@example.com not allowed' }]);
  assert.equal(row(env, 'runpod_balance_low').last_sent, 0, 'the 24-hour slot was handed back');

  binding.refuse = null;
  assert.deepEqual((await monitorRunpod(env, NOW + 900)).sent, ['runpod_balance_low']);
  assert.equal(binding.sent.length, 1);
});

test('a "sales are back" email that fails keeps the old status, so the next run sends it', async (t) => {
  const at = clock(t);
  const binding = fakeBinding();
  const env = salesEnv(binding);
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = limit_micro WHERE id = 'runpod-window'").run();
  mockRunpod(t, { clientBalance: 50, underBalance: false });
  t.mock.method(console, 'error', () => {});

  assert.deepEqual((await monitorRunpod(env, at(NOW))).sent, ['model_sales_stopped']);
  env.DB.sqlite.prepare("UPDATE supplier_budget_windows SET consumed_micro = 0 WHERE id = 'runpod-window'").run();
  binding.refuse = 'temporarily refused';
  assert.deepEqual((await monitorRunpod(env, at(NOW + 900))).failed, ['model_sales_resumed']);
  assert.equal(row(env, 'model_sales').note, 'unavailable');

  binding.refuse = null;
  assert.deepEqual((await monitorRunpod(env, at(NOW + 1800))).sent, ['model_sales_resumed']);
  assert.equal(row(env, 'model_sales').note, 'available');
});

test('two overlapping runs send one email, not two', async (t) => {
  const binding = fakeBinding();
  const env = balanceEnv(binding);
  mockRunpod(t, { clientBalance: 2, underBalance: false });

  const [first, second] = await Promise.all([monitorRunpod(env, NOW), monitorRunpod(env, NOW + 1)]);
  assert.equal(binding.sent.length, 1);
  assert.deepEqual([...first.sent, ...second.sent], ['runpod_balance_low']);
  assert.deepEqual([...first.held, ...second.held], ['runpod_balance_low']);
});
