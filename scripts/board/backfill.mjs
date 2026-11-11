#!/usr/bin/env node
// One-off: gives the board a past. The open bounty-targets-data set commits
// what HackerOne, Bugcrowd, Intigriti and YesWeHack publish every hour, so its
// history says how many programs and assets each had on a given day, and when
// a program or an asset first appeared.
//
//   node scripts/board/backfill.mjs --data <dir> [--cache <dir>] [--from YYYY-MM-DD]
//
// Reads one commit a month from `--from` (default: twelve months back), one a
// week for the last twelve weeks and one a day for the last three, and writes
// state.json and history.json to --data. Run the daily build afterwards with
// --quiet-new, so that what its other sources add is not taken for launches.
//
// Needs the GitHub CLI signed in (to look commits up by date) and network.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addHistory, derive, emptyState, platformFigures, remember } from './assemble.mjs';
import { bugcrowd, hackerone, intigritiFromDataset, yeswehack } from './normalize.mjs';

const REPO = 'arkadiyt/bounty-targets-data';
const FILES = { hackerone, bugcrowd, intigriti: intigritiFromDataset, yeswehack };
const DAY_MS = 86400000;

const iso = (time) => new Date(time).toISOString().slice(0, 10);

/** The days to read, oldest first. */
export function backfillDays(today, from) {
  const end = Date.parse(`${today}T00:00:00Z`) - DAY_MS;
  const days = new Set();
  for (let back = 0; back < 21; back += 1) days.add(iso(end - back * DAY_MS));
  for (let back = 21; back < 12 * 7; back += 7) days.add(iso(end - back * DAY_MS));
  const start = new Date(`${from}T00:00:00Z`);
  for (let month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); month.getTime() < end - 12 * 7 * DAY_MS; month.setUTCMonth(month.getUTCMonth() + 1)) {
    if (month.getTime() >= start.getTime()) days.add(iso(month.getTime()));
  }
  return [...days].filter((entry) => entry >= from).sort();
}

function commitAt(day) {
  const out = execFileSync('gh', ['api', `repos/${REPO}/commits?until=${day}T12:00:00Z&per_page=1`, '--jq', '.[0].sha'], { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(out)) throw new Error(`no commit of ${REPO} on or before ${day}`);
  return out;
}

async function fileAt(sha, name, cache) {
  const kept = path.join(cache, `${sha.slice(0, 12)}-${name}.json`);
  if (existsSync(kept)) return JSON.parse(await readFile(kept, 'utf8'));
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/data/${name}_data.json`, { signal: AbortSignal.timeout(240000) });
  // A file the data set did not have yet on that day is not an error.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${name} at ${sha.slice(0, 7)}: HTTP ${response.status}`);
  const text = await response.text();
  const parsed = JSON.parse(text);
  await writeFile(kept, text);
  return parsed;
}

async function main(argv) {
  const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const data = arg('--data');
  if (!data) throw new Error('--data <dir> is required');
  const cache = arg('--cache', path.join(data, '..', 'backfill-cache'));
  const today = new Date().toISOString().slice(0, 10);
  const yearBack = new Date(Date.parse(`${today}T00:00:00Z`));
  yearBack.setUTCFullYear(yearBack.getUTCFullYear() - 1);
  const from = arg('--from', iso(yearBack.getTime()));
  await mkdir(data, { recursive: true });
  await mkdir(cache, { recursive: true });

  const state = emptyState();
  const history = { v: 1, days: [] };
  const days = backfillDays(today, from);
  for (const [index, day] of days.entries()) {
    const sha = commitAt(day);
    const programs = [];
    const figures = {};
    const read = {};
    for (const [name, reader] of Object.entries(FILES)) {
      const raw = await fileAt(sha, name, cache);
      if (raw === null) continue;
      read[name] = reader(raw);
      programs.push(...read[name]);
    }
    remember(state, programs, day, { seed: index === 0 });
    const derivedById = new Map(programs.map((program) => [program.id, derive(program, state, day)]));
    for (const [name, own] of Object.entries(read)) figures[name] = platformFigures(own, derivedById);
    addHistory(history, day, figures);
    console.log(`${day} ${sha.slice(0, 7)} ${Object.entries(figures).map(([name, value]) => `${name} ${value.programs}/${value.assets}`).join('  ')}`);
  }

  await writeFile(path.join(data, 'state.json'), `${JSON.stringify(state)}\n`);
  await writeFile(path.join(data, 'history.json'), `${JSON.stringify(history)}\n`);
  console.log(`Wrote ${days.length} days from ${days[0]} to ${days.at(-1)}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('board', 'backfill.mjs'))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
