#!/usr/bin/env node
// Prints page views, referrers and the sign-up to subscription funnel from the
// funnel_daily table, for the last N days.
//
//   node scripts/stats.mjs            last 7 days, production database
//   node scripts/stats.mjs 30         last 30 days
//   node scripts/stats.mjs 7 --json   the raw rows as JSON
//   node scripts/stats.mjs 7 --local --persist-to .local/dev-v070
//
// The table holds one number per UTC day and event name. It has no account id,
// no address and no content, so this report cannot show a person.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATABASE = 'bounty-operator-accounts';
const PRODUCTION_CONFIG = 'wrangler.production.jsonc';
const MAX_DAYS = 400;
const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');

function parseArguments(argv) {
  const options = { days: 7, local: false, json: false, persistTo: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--local') options.local = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--persist-to') options.persistTo = resolve(argv[(index += 1)] ?? '');
    else if (/^\d+$/.test(argument)) options.days = Number(argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.days < 1 || options.days > MAX_DAYS) throw new Error(`Days must be between 1 and ${MAX_DAYS}.`);
  if (options.persistTo && !options.local) throw new Error('--persist-to only applies with --local.');
  return options;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/** The first and last UTC day of a window of `days` days ending today. */
function window(days) {
  const today = new Date();
  const first = new Date(today.getTime() - (days - 1) * 86400000);
  return { first: isoDay(first), last: isoDay(today) };
}

/** The path of Wrangler's own entry script, so it runs under this Node without a shell. */
function wranglerEntry() {
  const require = createRequire(join(WEB_DIR, 'package.json'));
  const manifestPath = require.resolve('wrangler/package.json');
  const manifest = require(manifestPath);
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.wrangler;
  return join(dirname(manifestPath), bin);
}

function queryRows(options, firstDay) {
  // firstDay is a date this script formatted itself; nothing typed by the user reaches the SQL.
  const sql = `SELECT day, event, n FROM funnel_daily WHERE day >= '${firstDay}' ORDER BY day, event`;
  const args = [wranglerEntry(), 'd1', 'execute', DATABASE, '--json', '--command', sql];
  if (options.local) {
    args.push('--local');
  } else {
    // The production database id is in the configuration git does not track.
    if (!existsSync(join(WEB_DIR, PRODUCTION_CONFIG))) {
      throw new Error(`web/${PRODUCTION_CONFIG} does not exist: it names the production database. Pass --local to read a development database.`);
    }
    args.push('--remote', '--config', PRODUCTION_CONFIG);
  }
  if (options.persistTo) args.push('--persist-to', options.persistTo);

  const result = spawnSync(process.execPath, args, { cwd: WEB_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed:\n${(result.stderr || result.stdout).trim()}`);
  }
  const start = result.stdout.indexOf('[');
  if (start === -1) throw new Error(`wrangler returned no JSON:\n${result.stdout.trim()}`);
  const [first] = JSON.parse(result.stdout.slice(start));
  return first.results;
}

/** Totals per event name over the whole window. */
function totals(rows) {
  const sums = new Map();
  for (const { event, n } of rows) sums.set(event, (sums.get(event) ?? 0) + n);
  return sums;
}

/** The entries whose name starts with `prefix`, without the prefix, largest first. */
function withPrefix(sums, prefix) {
  return [...sums]
    .filter(([event]) => event.startsWith(prefix))
    .map(([event, n]) => [event.slice(prefix.length), n])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sum(entries) {
  return entries.reduce((total, [, n]) => total + n, 0);
}

function percent(part, whole) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '-';
}

function printTable(title, entries, note = () => '') {
  console.log(`\n${title}`);
  if (entries.length === 0) {
    console.log('  none');
    return;
  }
  const width = Math.max(...entries.map(([name]) => name.length), 12);
  for (const [name, n] of entries) {
    console.log(`  ${name.padEnd(width)}  ${String(n).padStart(7)}  ${note(name, n)}`.trimEnd());
  }
}

function report(rows, options, range) {
  const sums = totals(rows);
  const count = (event) => sums.get(event) ?? 0;

  const pages = withPrefix(sums, 'pv:');
  const referrers = withPrefix(sums, 'ref:');
  const reviewsByProfile = withPrefix(sums, 'review_ok:');
  const failuresByReason = withPrefix(sums, 'review_fail:');
  const pageviews = sum(pages);
  const reviews = sum(reviewsByProfile);

  const where = options.local ? 'local database' : 'production';
  console.log(`Bounty Operator, last ${options.days} days (${range.first} to ${range.last} UTC, ${where})`);

  printTable(`Page views: ${pageviews}`, pages, (_name, n) => percent(n, pageviews));
  printTable(`Referrers: ${sum(referrers)}`, referrers, (_name, n) => percent(n, sum(referrers)));

  const registers = count('register');
  const checkouts = count('checkout_created');
  const subscriptions = count('sub_active');
  printTable('Funnel', [
    ['page views', pageviews],
    ['register', registers],
    ['login', count('login')],
    ['review_ok', reviews],
    ['review_fail', count('review_fail')],
    ['quota_hit', count('quota_hit')],
    ['checkout_created', checkouts],
    ['sub_active', subscriptions],
  ], (name) => {
    if (name === 'register') return `${percent(registers, pageviews)} of page views`;
    if (name === 'review_ok') return `${percent(reviews, reviews + count('review_fail'))} of reviews started`;
    if (name === 'checkout_created') return `${percent(checkouts, count('quota_hit'))} of quota hits`;
    if (name === 'sub_active') return `${percent(subscriptions, checkouts)} of checkouts, ${percent(subscriptions, registers)} of registrations`;
    return '';
  });

  printTable('Completed reviews by profile', reviewsByProfile, (_name, n) => percent(n, reviews));
  // Counted since 0.7.5: provider_<kind>, cut_short, refused, single_answer_limit, client_gone, other.
  printTable('Failed reviews by reason', failuresByReason, (_name, n) => percent(n, sum(failuresByReason)));

  const known = (event) => /^(pv|ref|review_ok|review_fail):/.test(event)
    || ['register', 'login', 'review_fail', 'quota_hit', 'checkout_created', 'sub_active'].includes(event);
  const clientEvents = [...sums].filter(([event]) => !known(event)).sort((a, b) => b[1] - a[1]);
  printTable('Client events', clientEvents);

  const days = new Map();
  for (const { day, event, n } of rows) {
    const entry = days.get(day) ?? { views: 0, registers: 0, reviews: 0, subscriptions: 0 };
    if (event.startsWith('pv:')) entry.views += n;
    else if (event === 'register') entry.registers += n;
    else if (event.startsWith('review_ok:')) entry.reviews += n;
    else if (event === 'sub_active') entry.subscriptions += n;
    days.set(day, entry);
  }
  console.log('\nPer day        views  register  reviews  subs');
  for (const [day, entry] of [...days].sort()) {
    const cells = [entry.views, entry.registers, entry.reviews, entry.subscriptions];
    console.log(`  ${day}  ${String(cells[0]).padStart(6)}  ${String(cells[1]).padStart(8)}  ${String(cells[2]).padStart(7)}  ${String(cells[3]).padStart(4)}`);
  }
  if (days.size === 0) console.log('  none');
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const range = window(options.days);
  const rows = queryRows(options, range.first);
  if (options.json) console.log(JSON.stringify({ ...range, rows }, null, 2));
  else report(rows, options, range);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
