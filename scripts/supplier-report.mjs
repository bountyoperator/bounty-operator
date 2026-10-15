#!/usr/bin/env node
// Operator-only, aggregate reporting. Reads existing D1 records; never imports
// supplier bills, funds a budget, starts inference or contacts a model vendor.
//
//   node scripts/supplier-report.mjs --days 7
//   node scripts/supplier-report.mjs --from 2026-10-01 --to 2026-10-14
//   node scripts/supplier-report.mjs --days 7 --local --persist-to .local/report-fixture

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { supplierOperatingReport } from '../web/src/supplier-costs.ts';

const DATABASE = 'bounty-operator-accounts';
const PRODUCTION_CONFIG = 'wrangler.production.jsonc';
const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const DAY = 86400;
const MAX_DAYS = 31;
const normalize = (sql) => typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : '';

// Exact report statements form the read boundary. A new report query needs an
// explicit review here; even an arbitrary SELECT cannot read customer records.
const REPORT_QUERIES = [
  'SELECT * FROM supplier_budget_windows ORDER BY provider, starts_at',
  `SELECT provider, kind, COUNT(*) AS entries, SUM(CASE WHEN amount_micro > 0 THEN amount_micro ELSE 0 END) AS added_micro,
    SUM(CASE WHEN amount_micro < 0 THEN -amount_micro ELSE 0 END) AS removed_micro
    FROM supplier_budget_adjustments WHERE created_at >= ? AND created_at < ? GROUP BY provider, kind ORDER BY provider, kind`,
  `SELECT provider, resource_id, basis, state, COUNT(*) AS requests, SUM(hold_micro) AS allowance_micro,
    SUM(expense_micro) AS consumed_allowance_micro, SUM(estimated_cost_micro) AS estimated_cost_micro
    FROM supplier_commitments WHERE created_at >= ? AND created_at < ? GROUP BY provider, resource_id, basis, state`,
  `SELECT provider, resource_type, resource_id, SUM(total_micro) AS actual_cost_micro, MIN(bucket_start) AS first_bucket,
    MAX(bucket_end) AS last_bucket, MIN(fetched_at) AS oldest_read FROM supplier_billing_buckets
    WHERE bucket_start >= ? AND bucket_end <= ? GROUP BY provider, resource_type, resource_id`,
  'SELECT * FROM supplier_billing_syncs WHERE window_start <= ? AND window_end >= ? ORDER BY fetched_at DESC',
  "SELECT COALESCE(-SUM(amount_micro), 0) AS usage_revenue_micro FROM api_ledger WHERE kind = 'usage' AND created_at >= ? AND created_at < ?",
  `SELECT COALESCE(SUM(MAX(balance_micro, 0)), 0) AS customer_credit_liability_micro,
    COALESCE(SUM(MAX(-balance_micro, 0)), 0) AS customer_deficit_micro,
    COALESCE(SUM(reserved_micro), 0) AS customer_reserved_micro FROM api_wallets`,
].map(normalize);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOUND_QUERIES = REPORT_QUERIES.map((sql) => new RegExp(`^${sql.split('?').map(escapeRegex).join('(0|[1-9][0-9]*)')}$`));

function utcDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Dates must use YYYY-MM-DD in UTC.');
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    throw new Error('Dates must be real UTC calendar dates on or after 1970-01-01.');
  }
  return milliseconds / 1000;
}

/** --from and --to both include their whole UTC day; the report's end is exclusive. */
export function parseArguments(argv, now = new Date()) {
  const options = { local: false, persistTo: '', start: 0, end: 0, help: false };
  const seen = new Set();
  let days = 7;
  let from;
  let to;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) throw new Error(`Repeated argument: ${argument}`);
    seen.add(argument);
    if (argument === '--local') options.local = true;
    else if (argument === '--json') { /* JSON is always the output format. */ }
    else if (argument === '--help') options.help = true;
    else if (['--days', '--from', '--to', '--persist-to'].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--days') {
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_DAYS) {
          throw new Error(`--days must be an integer between 1 and ${MAX_DAYS}.`);
        }
        days = Number(value);
      } else if (argument === '--from') from = utcDay(value);
      else if (argument === '--to') to = utcDay(value);
      else options.persistTo = resolve(value);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.persistTo && !options.local) throw new Error('--persist-to requires --local.');
  if ((from === undefined) !== (to === undefined)) throw new Error('Use --from and --to together.');
  if (from !== undefined) {
    if (seen.has('--days')) throw new Error('Choose --days or --from/--to, not both.');
    options.start = from;
    options.end = to + DAY;
  } else {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Current UTC date is invalid.');
    options.end = utcDay(now.toISOString().slice(0, 10)) + DAY;
    options.start = options.end - days * DAY;
  }
  if (options.start < 0 || options.end <= options.start || options.end - options.start > MAX_DAYS * DAY) {
    throw new Error(`The inclusive UTC date range must contain 1 to ${MAX_DAYS} days.`);
  }
  return options;
}

/** Substitute only nonnegative integer timestamps into one approved report query. */
export function bindReportQuery(sql, bindings = []) {
  const query = normalize(sql);
  if (!REPORT_QUERIES.includes(query)) throw new Error('Only approved supplier report SELECT queries are allowed.');
  if (!Array.isArray(bindings) || bindings.length !== (query.match(/\?/g) ?? []).length ||
    Array.from(bindings).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Report bindings must match the query and contain only nonnegative safe integers.');
  }
  let index = 0;
  return query.replace(/\?/g, () => String(bindings[index++]));
}

function approvedBoundQuery(sql) {
  const query = normalize(sql);
  for (const pattern of BOUND_QUERIES) {
    const match = pattern.exec(query);
    if (match && match.slice(1).every((value) => Number.isSafeInteger(Number(value)))) return query;
  }
  throw new Error('Only approved supplier report SELECT queries are allowed.');
}

/** Deliberately supplies no run, batch or exec method. */
export function createReadOnlyDatabase(execute) {
  const statement = (sql, bindings = []) => Object.freeze({
    bind: (...values) => {
      bindReportQuery(sql, values);
      return statement(sql, values);
    },
    async all() {
      const results = await execute(bindReportQuery(sql, bindings));
      if (!Array.isArray(results)) throw new Error('Report query returned invalid rows.');
      return { results };
    },
    async first() { return (await this.all()).results[0] ?? null; },
  });
  return Object.freeze({ prepare(sql) {
    if (!REPORT_QUERIES.includes(normalize(sql))) throw new Error('Only approved supplier report SELECT queries are allowed.');
    return statement(sql);
  } });
}

function wranglerEntry() {
  const require = createRequire(join(WEB_DIR, 'package.json'));
  const manifestPath = require.resolve('wrangler/package.json');
  const manifest = require(manifestPath);
  return join(dirname(manifestPath), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.wrangler);
}

export function wranglerArguments(options, sql, entry = wranglerEntry()) {
  const args = [entry, 'd1', 'execute', DATABASE, '--json', '--command', approvedBoundQuery(sql)];
  if (options.local) args.push('--local');
  else args.push('--remote', '--config', PRODUCTION_CONFIG);
  if (options.persistTo) {
    if (!options.local) throw new Error('--persist-to requires --local.');
    args.push('--persist-to', options.persistTo);
  }
  return args;
}

function queryWrangler(options, sql) {
  if (!options.local && !existsSync(join(WEB_DIR, PRODUCTION_CONFIG))) {
    throw new Error(`web/${PRODUCTION_CONFIG} is missing; use --local for a development database.`);
  }
  const result = spawnSync(process.execPath, wranglerArguments(options, sql), {
    cwd: WEB_DIR, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.error || result.status !== 0) throw new Error('Read-only D1 report query failed. Check Wrangler access and applied database migrations.');
  const jsonStart = result.stdout.indexOf('[');
  let responses;
  try { responses = jsonStart < 0 ? null : JSON.parse(result.stdout.slice(jsonStart)); } catch { /* Fail closed below. */ }
  if (!Array.isArray(responses) || responses.length !== 1 || responses[0]?.success !== true || !Array.isArray(responses[0].results)) {
    throw new Error('Wrangler returned an invalid report response.');
  }
  return responses[0].results;
}

export async function runReport(options, { execute = (sql) => queryWrangler(options, sql) } = {}) {
  if (!Number.isSafeInteger(options.start) || !Number.isSafeInteger(options.end) || options.start < 0 ||
    options.end <= options.start || options.end - options.start > MAX_DAYS * DAY) throw new Error('Invalid report window; maximum 31 days.');
  return supplierOperatingReport({ DB: createReadOnlyDatabase(execute) }, options.start, options.end);
}

const HELP = `Usage: node scripts/supplier-report.mjs [--days 1..31 | --from YYYY-MM-DD --to YYYY-MM-DD] [--local [--persist-to DIR]]
Prints aggregate JSON from existing D1 records. Defaults to seven UTC days including today; --from and --to are inclusive UTC dates.
Reads production unless --local is given. Does not reconcile supplier bills, start workers, modify budgets or make payments.
Actual supplier bills, estimates, customer credit liability and usage revenue remain separate; missing fees and net profit remain unknown.`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    console.log(options.help ? HELP : JSON.stringify(await runReport(options), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Supplier report failed.');
    process.exitCode = 1;
  }
}
