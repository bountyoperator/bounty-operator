#!/usr/bin/env node
// Builds the bounty board's data: reads each platform's public program list,
// and writes the program list, the day's figures, the history and the memory
// of what has been seen.
//
//   node scripts/build-board.mjs --data <dir> [--publish <dir>] [--raw <dir>] [--from-raw <dir>] [--day YYYY-MM-DD] [--quiet-new]
//
//   --data      the store: state.json, history.json, programs.json, snapshot.json.
//               Read first (yesterday's), then written.
//   --publish   also copy programs.json and snapshot.json here (web/public/board/data).
//   --raw       keep what each platform answered, one file per platform.
//   --from-raw  read those files instead of the network (tests, and re-running a day).
//   --day       the day to record; default today in UTC.
//   --quiet-new programs seen for the first time are recorded as already there, not as launched
//               today. For the one run after a new source of a platform is added.
//
// A platform that cannot be read keeps its last good figures, marked with
// their date. Exit status 1 only when no platform could be read.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../web/public/board/platforms.mjs';
import { addHistory, assemble, derive, emptyState, platformFigures, remember } from './board/assemble.mjs';
import * as normalize from './board/normalize.mjs';
import { readAll } from './board/sources.mjs';

/** Today's records of every platform in `raw`. */
export function normalizeAll(raw, today) {
  const readers = {
    hackerone: (value) => normalize.hackerone(value.targets, value.teams),
    bugcrowd: (value) => normalize.bugcrowd(value.targets, value.disclosure),
    intigriti: (value) => normalize.intigriti(value.targets, value.programs),
    yeswehack: (value) => normalize.yeswehack(value.targets, value.programs),
    immunefi: (value) => normalize.immunefi(value, today),
    cantina: (value) => normalize.cantina(value, today),
    sherlock: (value) => normalize.sherlock(value.bounties, value.contests, today),
    code4rena: (value) => normalize.code4rena(value, today),
  };
  return Object.fromEntries(Object.entries(raw).filter(([id]) => id in readers).map(([id, value]) => [id, readers[id](value)]));
}

async function readStored(dir, name, fallback) {
  try {
    return JSON.parse(await readFile(path.join(dir, name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`${name} in ${dir} is not readable: ${error.message}`);
  }
}

const stored = (value) => `${JSON.stringify(value)}\n`;

/**
 * One day's build from what the platforms answered and what the store held.
 * Pure but for the clock passed in.
 */
export function buildDay({ raw, failed = {}, prior, today, at, quietNew = false }) {
  const state = prior.state ?? emptyState();
  const history = prior.history ?? { v: 1, days: [] };
  const byPlatform = normalizeAll(raw, today);
  const problems = { ...failed };
  const priorPrograms = prior.programs?.programs ?? [];
  const before = (id) => priorPrograms.filter((program) => program.p === id).length;

  for (const platform of PLATFORMS) {
    if (platform.id in problems) continue;
    const found = byPlatform[platform.id];
    if (!found) problems[platform.id] = 'not read';
    // A list that halves overnight is a changed answer format far more often than a real exodus.
    else if (before(platform.id) >= 10 && found.length < before(platform.id) / 2) {
      problems[platform.id] = `the list shrank from ${before(platform.id)} to ${found.length}; kept the last good read`;
    }
  }

  const programs = PLATFORMS.filter((platform) => !(platform.id in problems)).flatMap((platform) => byPlatform[platform.id]);
  remember(state, programs, today, { quietNew });
  const derivedById = new Map(programs.map((program) => [program.id, derive(program, state, today)]));
  const figures = Object.fromEntries(PLATFORMS.filter((platform) => !(platform.id in problems))
    .map((platform) => [platform.id, platformFigures(programs.filter((program) => program.platform === platform.id), derivedById)]));
  addHistory(history, today, figures);

  const carried = priorPrograms.filter((program) => program.p in problems);
  const carriedFigures = {};
  for (const platform of prior.snapshot?.platforms ?? []) {
    if (!(platform.id in problems) || platform.missing) continue;
    const { id, asOf, stale, series, ...rest } = platform;
    carriedFigures[id] = { asOf, figures: rest };
  }
  const built = assemble({ programs, carried, carriedFigures, state, history, today, at, failed: problems });
  return { ...built, state, history, problems, read: Object.keys(figures) };
}

function options(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--quiet-new') {
      out.quietNew = true;
      continue;
    }
    if (!['--data', '--publish', '--raw', '--from-raw', '--day'].includes(name)) throw new Error(`Unknown option ${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    out[name.slice(2)] = value;
    index += 1;
  }
  if (!out.data) throw new Error('--data <dir> is required');
  if (out.day && !/^\d{4}-\d{2}-\d{2}$/.test(out.day)) throw new Error('--day must be YYYY-MM-DD');
  return out;
}

async function main(argv) {
  const opts = options(argv);
  const at = new Date().toISOString();
  const today = opts.day ?? at.slice(0, 10);

  let raw = {};
  let failed = {};
  if (opts['from-raw']) {
    for (const platform of PLATFORMS) {
      const value = await readStored(opts['from-raw'], `${platform.id}.json`, null);
      if (value === null) failed[platform.id] = 'no saved answer';
      else raw[platform.id] = value;
    }
  } else {
    ({ raw, failed } = await readAll());
  }
  if (opts.raw) {
    await mkdir(opts.raw, { recursive: true });
    for (const [id, value] of Object.entries(raw)) await writeFile(path.join(opts.raw, `${id}.json`), JSON.stringify(value));
  }

  const prior = {
    state: await readStored(opts.data, 'state.json', null),
    history: await readStored(opts.data, 'history.json', null),
    programs: await readStored(opts.data, 'programs.json', null),
    snapshot: await readStored(opts.data, 'snapshot.json', null),
  };
  const built = buildDay({ raw, failed, prior, today, at, quietNew: opts.quietNew === true });

  for (const [id, reason] of Object.entries(built.problems)) console.error(`not read: ${id}: ${reason}`);
  if (!built.read.length) {
    console.error('No platform could be read. Nothing was written.');
    return 1;
  }

  await mkdir(opts.data, { recursive: true });
  await writeFile(path.join(opts.data, 'state.json'), stored(built.state));
  await writeFile(path.join(opts.data, 'history.json'), stored(built.history));
  await writeFile(path.join(opts.data, 'programs.json'), stored(built.programs));
  await writeFile(path.join(opts.data, 'snapshot.json'), stored(built.snapshot));
  if (opts.publish) {
    await mkdir(opts.publish, { recursive: true });
    await writeFile(path.join(opts.publish, 'programs.json'), stored(built.programs));
    await writeFile(path.join(opts.publish, 'snapshot.json'), stored(built.snapshot));
  }

  const { totals } = built.snapshot;
  console.log(`${today}: ${totals.programs} programs on ${built.read.length} of ${PLATFORMS.length} platforms, ${totals.paying} paying, ${totals.assets} assets, ${totals.contests} live contests, ${built.snapshot.freshCount} new.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
