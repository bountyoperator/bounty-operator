// The operator report is read-only: tests use an in-memory migrated database,
// never Wrangler, a supplier endpoint, or the production account database.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { bindReportQuery, createReadOnlyDatabase, parseArguments, runReport, wranglerArguments } from '../../scripts/supplier-report.mjs';
import { supplierOperatingReport } from '../src/supplier-costs.ts';
import { addAccount, createDatabase } from './worker-helpers.mjs';

const DAY = 86400;
const NOW = new Date('2026-10-15T18:22:33Z');
const utc = (day) => Date.parse(`${day}T00:00:00Z`) / 1000;
const normalized = (sql) => sql.replace(/\s+/g, ' ').trim();
const BUDGETS = 'SELECT * FROM supplier_budget_windows ORDER BY provider, starts_at';
const REVENUE = "SELECT COALESCE(-SUM(amount_micro), 0) AS usage_revenue_micro FROM api_ledger WHERE kind = 'usage' AND created_at >= ? AND created_at < ?";

test('supplier report defaults to seven UTC dates including today', () => {
  assert.deepEqual(parseArguments([], NOW), {
    local: false, persistTo: '', start: utc('2026-10-09'), end: utc('2026-10-16'), help: false,
  });
  const offset = parseArguments(['--days', '1'], new Date('2026-10-15T02:00:00+08:00'));
  assert.equal(offset.start, utc('2026-10-14'));
  assert.equal(offset.end, utc('2026-10-15'));
  assert.equal(parseArguments(['--days', '31'], NOW).end - parseArguments(['--days', '31'], NOW).start, 31 * DAY);
});

test('supplier report explicit dates are inclusive and handle leap days and month boundaries', () => {
  const leap = parseArguments(['--from', '2024-02-28', '--to', '2024-03-01'], NOW);
  assert.equal(leap.start, utc('2024-02-28'));
  assert.equal(leap.end, utc('2024-03-02'));
  assert.equal(leap.end - leap.start, 3 * DAY);
  const longest = parseArguments(['--from', '2026-01-01', '--to', '2026-01-31'], NOW);
  assert.equal(longest.end, utc('2026-02-01'));
  assert.equal(longest.end - longest.start, 31 * DAY);
});

test('supplier report local persistence, JSON and help options preserve their contract', () => {
  const persistTo = 'C:/fixtures/local database';
  const options = parseArguments(['--local', '--persist-to', persistTo, '--json', '--days', '1'], NOW);
  assert.equal(options.local, true);
  assert.equal(options.persistTo, resolve(persistTo));
  assert.equal(options.end - options.start, DAY);
  assert.deepEqual(parseArguments(['--json'], NOW), parseArguments([], NOW));
  assert.equal(parseArguments(['--help'], NOW).help, true);
});

test('supplier report rejects malformed, ambiguous, oversized and destination-changing arguments', () => {
  const cases = [
    ['--days'], ['--days', '0'], ['--days', '32'], ['--days', '-1'], ['--days', '1.5'], ['--days', 'NaN'],
    ['--from', '2026-10-14'], ['--to', '2026-10-14'],
    ['--from', '2026-10-15', '--to', '2026-10-14'],
    ['--from', '2026-01-01', '--to', '2026-02-01'],
    ['--from', '2026-10-01', '--to', '2026-10-02', '--days', '2'],
    ['--persist-to', './elsewhere'], ['--local', '--persist-to'],
    ['--database', 'different-account'], ['--config', 'other.jsonc'], ['--remote'], ['unexpected'],
  ];
  for (const date of ['2023-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-1-1', '2026-10-01T00:00:00Z']) {
    cases.push(['--from', date, '--to', date]);
  }
  for (const argv of cases) assert.throws(() => parseArguments(argv, NOW), Error, JSON.stringify(argv));
});

test('report binding allows the exact report queries and safe integer values only', () => {
  assert.equal(normalized(bindReportQuery(`\n ${BUDGETS.replaceAll(' ', '  ')}\n`)), BUDGETS);
  assert.equal(normalized(bindReportQuery(REVENUE, [0, Number.MAX_SAFE_INTEGER])),
    REVENUE.replace('>= ?', '>= 0').replace('< ?', `< ${Number.MAX_SAFE_INTEGER}`));
  for (const value of ['1', '0 OR 1=1', -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, null, true, undefined, 1n, {}]) {
    assert.throws(() => bindReportQuery(REVENUE, [0, value]), Error, String(value));
  }
  for (const bindings of [[], [0], [0, 1, 2]]) assert.throws(() => bindReportQuery(REVENUE, bindings));
  assert.throws(() => bindReportQuery(REVENUE, new Array(2)), 'sparse bindings cannot stand in for integer values');
  assert.throws(() => bindReportQuery(BUDGETS, [0]));
});

test('report binding rejects arbitrary reads, writes, comments and stacked statements', () => {
  const forbidden = [
    'SELECT * FROM accounts', 'SELECT 1', 'PRAGMA database_list',
    'DELETE FROM supplier_budget_windows', 'UPDATE supplier_budget_windows SET enabled = 1',
    'INSERT INTO supplier_budget_windows(id) VALUES(1)',
    `${BUDGETS}; DELETE FROM supplier_budget_windows`, `${BUDGETS}; SELECT * FROM accounts`,
    `${BUDGETS} -- commentary`, `/* commentary */ ${BUDGETS}`, `${BUDGETS} /* commentary */`,
    `${BUDGETS} LIMIT 1`, `${BUDGETS} UNION SELECT * FROM accounts`,
    REVENUE.replace("kind = 'usage'", "kind = 'topup'"),
  ];
  for (const sql of forbidden) assert.throws(() => bindReportQuery(sql), Error, sql);
});

test('read-only database supports bound all/first without exposing mutation methods', async () => {
  const calls = [];
  const rows = [{ usage_revenue_micro: 123 }, { usage_revenue_micro: 456 }];
  const db = createReadOnlyDatabase(async (sql) => { calls.push(sql); return rows; });
  const statement = db.prepare(REVENUE).bind(10, 20);
  assert.deepEqual(await statement.all(), { results: rows });
  assert.deepEqual(await statement.first(), rows[0]);
  assert.equal(calls.length, 2);
  assert(calls.every((sql) => normalized(sql) === REVENUE.replace('>= ?', '>= 10').replace('< ?', '< 20')));
  for (const target of [db, statement]) {
    for (const method of ['run', 'batch', 'exec', 'raw']) assert.equal(target[method], undefined, method);
  }
  const empty = createReadOnlyDatabase(async () => []).prepare(BUDGETS);
  assert.deepEqual(await empty.all(), { results: [] });
  assert.equal(await empty.first(), null);
});

test('the database adapter never executes rejected SQL or invalid bindings', async () => {
  let executions = 0;
  const db = createReadOnlyDatabase(async () => { executions += 1; return []; });
  for (const sql of ['SELECT * FROM accounts', 'DELETE FROM api_ledger', `${BUDGETS}; SELECT 1`]) {
    await assert.rejects(async () => db.prepare(sql).all());
  }
  await assert.rejects(async () => db.prepare(REVENUE).bind(0, '1; DELETE FROM accounts').all());
  await assert.rejects(async () => db.prepare(REVENUE).all());
  assert.equal(executions, 0);
});

test('read-only database preserves execution failures instead of returning an empty report', async () => {
  const failure = new Error('D1 unavailable');
  const db = createReadOnlyDatabase(async () => { throw failure; });
  await assert.rejects(db.prepare(BUDGETS).all(), (error) => error === failure);
  await assert.rejects(db.prepare(BUDGETS).first(), (error) => error === failure);
  for (const value of [undefined, null, {}, { results: [] }]) {
    await assert.rejects(createReadOnlyDatabase(async () => value).prepare(BUDGETS).all());
  }
});

test('Wrangler arguments fix the database and production config while respecting explicit local storage', () => {
  const entry = 'C:/fixtures/wrangler.mjs';
  const options = parseArguments([], NOW);
  const remote = wranglerArguments({ ...options, database: 'untrusted', config: 'other.jsonc' }, BUDGETS, entry);
  assert.deepEqual(remote.slice(0, 4), [entry, 'd1', 'execute', 'bounty-operator-accounts']);
  assert(remote.includes('--remote'));
  assert(remote.includes('--json'));
  assert.match(remote[remote.indexOf('--config') + 1], /(?:^|[\\/])wrangler\.production\.jsonc$/);
  assert.equal(remote[remote.indexOf('--command') + 1], BUDGETS);
  assert(!remote.includes('--local'));
  assert(!remote.includes('untrusted'));
  assert(!remote.includes('other.jsonc'));

  const local = wranglerArguments(parseArguments(['--local', '--persist-to', 'C:/fixtures/local database'], NOW), BUDGETS, entry);
  assert.deepEqual(local.slice(0, 4), remote.slice(0, 4));
  assert(local.includes('--local'));
  assert(!local.includes('--remote'));
  assert.equal(local[local.indexOf('--persist-to') + 1], resolve('C:/fixtures/local database'));
  assert.equal(local[local.indexOf('--command') + 1], BUDGETS);
  const bound = bindReportQuery(REVENUE, [0, 86400]);
  const boundArgs = wranglerArguments(options, bound, entry);
  assert.equal(boundArgs[boundArgs.indexOf('--command') + 1], bound);
  for (const sql of [REVENUE, `${bound}; DELETE FROM accounts`, `${bound} -- comment`, 'SELECT * FROM accounts']) {
    assert.throws(() => wranglerArguments(options, sql, entry), Error, sql);
  }
  assert.throws(() => wranglerArguments({ ...options, persistTo: './remote-override' }, BUDGETS, entry));
});

test('runReport returns the module report unchanged with date boundaries, liabilities and unknown totals intact', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('The report must not contact suppliers'); });
  const DB = createDatabase();
  t.after(() => DB.sqlite.close());
  const options = parseArguments(['--from', '2026-10-14', '--to', '2026-10-14'], NOW);
  const { start, end } = options;
  addAccount(DB, 'creditor');
  addAccount(DB, 'debtor');
  const ledger = DB.sqlite.prepare('INSERT INTO api_ledger(id, account_id, amount_micro, kind, reference, created_at) VALUES(?, ?, ?, ?, ?, ?)');
  ledger.run('topup', 'creditor', 1000000, 'topup', 'fixture', start - DAY);
  for (const [id, amount, at] of [['prior', 300, start - 1], ['first', 700, start], ['last', 200, end - 1], ['later', 500, end]]) {
    ledger.run(id, 'creditor', -amount, 'usage', 'fixture', at);
  }
  DB.sqlite.prepare('INSERT INTO api_wallets(account_id, balance_micro) VALUES(?, ?)').run('debtor', -400);
  DB.sqlite.prepare(`INSERT INTO supplier_budget_windows(id, provider, starts_at, ends_at, limit_micro, consumed_micro, enabled, funding_reference, updated_at)
    VALUES('budget', 'runpod', ?, ?, 100000, 6000, 1, 'fixture-only', ?)`).run(start, end, start);
  const cost = DB.sqlite.prepare(`INSERT INTO supplier_billing_buckets(provider, resource_type, resource_id, bucket_start, bucket_end, total_micro, fetched_at, source_hash)
    VALUES('runpod', 'serverless', 'fixture123', ?, ?, ?, ?, 'fixture')`);
  for (const [at, amount] of [[start - 3600, 4000], [start, 1000], [start + 3600, 2000], [end, 8000]]) {
    cost.run(at, at + 3600, amount, end + 10);
  }
  DB.sqlite.prepare(`INSERT INTO supplier_billing_syncs(provider, resource_type, resource_id, window_start, window_end, fetched_at, record_count)
    VALUES('runpod', 'serverless', 'fixture123', ?, ?, ?, 2)`).run(start, end, end + 10);
  DB.sqlite.exec('PRAGMA query_only = ON');
  const before = DB.sqlite.prepare('SELECT total_changes() AS n').get().n;
  const expected = await supplierOperatingReport({ DB }, start, end);
  const sqls = [];
  const actual = await runReport(options, { execute: async (sql) => { sqls.push(sql); return DB.sqlite.prepare(sql).all(); } });
  assert.deepEqual(actual, expected);
  assert.equal(sqls.length, 6, 'only the six report queries ran');
  assert(sqls.every((sql) => /^SELECT\b/.test(sql) && !sql.includes('?')));
  assert.equal(DB.sqlite.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(actual.revenue.usage_revenue_micro, 900);
  assert.equal(actual.actual_supplier_costs[0].actual_cost_micro, 3000);
  assert.equal(actual.budgets[0].consumed_micro, 6000, 'allowance consumption stays separate from actual vendor cost');
  assert.equal(actual.successful_billing_reads.length, 1);
  assert.equal(actual.current_customer_wallets.customer_credit_liability_micro, 998300);
  assert.equal(actual.current_customer_wallets.customer_deficit_micro, 400);
  for (const field of ['stripe_fees_micro', 'net_profit_micro', 'owner_withdrawable_micro']) assert.equal(actual[field], null);
});

test('runReport propagates an unavailable database without producing a partial financial report', async () => {
  const failure = new Error('Database read failed');
  await assert.rejects(runReport(parseArguments([], NOW), { execute: async () => { throw failure; } }), (error) => error === failure);
});

test('runReport refuses invalid direct-call windows before executing a query', async () => {
  let executions = 0;
  const execute = async () => { executions += 1; return []; };
  for (const [start, end] of [[-1, DAY], [0, 0], [DAY, 0], [0, 32 * DAY], [0.5, DAY], [0, Infinity], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    await assert.rejects(runReport({ start, end }, { execute }));
  }
  assert.equal(executions, 0);
});
