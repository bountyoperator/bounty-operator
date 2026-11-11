// /board: the page script.
//
// The built page already shows the day the site was built with. This script
// asks the server for the newest day's data and redraws the sections from it
// with the same code that built them (render.mjs), then runs the search,
// filters and order of the program table.
//
// Requests: GET /api/board/snapshot and /api/board/programs, both to this
// site. One name-only counter, board_used, the first time a filter is used.
//
// Kept in this browser: localStorage "bo:board-seen", the day of the board
// you last looked at, so that the next visit can mark what is new since.
// Nothing about it is sent anywhere.

import { ping } from '../tools/ping.mjs';
import { contestList, costPanel, freshList, platformTable, programTable, select, shownLine, shortDate, tiles, unseenCounts, updatedLine, withFresh } from './render.mjs';
import { mount } from './tree.mjs';

const SEEN_KEY = 'bo:board-seen';
const PAGE = 40;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const byId = (id) => document.getElementById(id);

async function read(url) {
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.v === 1 && DAY.test(data.day) ? data : null;
  } catch {
    return null;
  }
}

/**
 * The figures and the program list of one and the same day: from the server's
 * newest day or, failing that, the copy the site was built with. A pair of
 * different days is refused, because the figures would not describe the list.
 */
async function load() {
  for (const [before, after] of [['/api/board/', ''], ['/board/data/', '.json']]) {
    const [snapshot, list] = await Promise.all([read(`${before}snapshot${after}`), read(`${before}programs${after}`)]);
    if (snapshot && list && Array.isArray(list.programs) && Array.isArray(snapshot.platforms) && snapshot.day === list.day) return { snapshot, list };
  }
  return null;
}

function lastSeen() {
  try {
    const value = localStorage.getItem(SEEN_KEY);
    return typeof value === 'string' && DAY.test(value) ? value : null;
  } catch {
    return null;
  }
}

function remember(day) {
  try {
    localStorage.setItem(SEEN_KEY, day);
  } catch {
    // Storage is off: the next visit simply marks nothing.
  }
}

const state = {
  snapshot: null,
  programs: [],
  limit: PAGE,
  since: lastSeen(),
};

function filters() {
  return {
    query: byId('board-q')?.value ?? '',
    platform: byId('board-platform')?.value ?? '',
    sort: byId('board-sort')?.value ?? 'max',
    pays: byId('board-pays')?.checked === true,
    free: byId('board-free')?.checked === true,
    noKyc: byId('board-nokyc')?.checked === true,
    fresh: byId('board-new')?.checked === true,
  };
}

function drawPrograms() {
  const { snapshot, programs } = state;
  const table = byId('board-programs');
  if (!snapshot || !programs.length || !table) return;
  const rows = select(programs, filters());
  const open = programs.filter((program) => program.kind !== 'contest').length;
  const shown = Math.min(state.limit, rows.length);
  mount(table, programTable(rows, snapshot, { limit: state.limit }));
  const line = byId('board-count');
  if (line) line.textContent = shownLine(shown, rows.length, open);
  const more = byId('board-more');
  if (more) more.hidden = shown >= rows.length;
}

function drawSections() {
  const { snapshot, since } = state;
  if (!snapshot) return;
  const sections = [['board-tiles', tiles(snapshot)], ['board-platforms', platformTable(snapshot)], ['board-cost', costPanel(snapshot)],
    ['board-fresh', freshList(snapshot, { since })], ['board-contests', contestList(snapshot)]];
  for (const [id, tree] of sections) {
    const target = byId(id);
    if (target) mount(target, tree);
  }
  const updated = byId('board-updated');
  if (updated) updated.textContent = updatedLine(snapshot);
  // A returning visitor reads what happened since their last look.
  const line = byId('board-since');
  if (line && since && since < snapshot.day) {
    const [launched, scope] = unseenCounts(snapshot, since);
    line.textContent = launched + scope === 0
      ? `Nothing launched or added scope since you last looked, on ${shortDate(since, snapshot.day)}.`
      : `Since you last looked, on ${shortDate(since, snapshot.day)}: ${launched} launched and ${scope} added scope. They are marked "New to you".`;
  }
}

function used() {
  ping('board_used');
}

function wire() {
  const form = byId('board-controls');
  if (form) {
    form.addEventListener('submit', (event) => event.preventDefault());
    const changed = () => {
      state.limit = PAGE;
      drawPrograms();
      used();
    };
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
  }
  byId('board-more')?.addEventListener('click', () => {
    state.limit += PAGE * 2;
    drawPrograms();
    used();
  });
}

async function start() {
  wire();
  const built = byId('board')?.dataset.at ?? '';
  const loaded = await load();
  if (!loaded) return;
  const { snapshot, list } = loaded;
  state.snapshot = snapshot;
  state.programs = withFresh(list.programs, snapshot);
  // The built sections stand unless the data is newer or there is a last visit to mark.
  if (snapshot.at !== built || (state.since && state.since < snapshot.day)) drawSections();
  drawPrograms();
  // The next visit compares against this day. Written when the page is left, so a reload keeps the marks.
  addEventListener('pagehide', () => remember(snapshot.day), { once: true });
}

start();
