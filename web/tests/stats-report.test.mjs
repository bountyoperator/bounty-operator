// The stats report reads rows it is given: these tests never run Wrangler or
// read a database. They check what it prints first and how it lays out a day.

import assert from 'node:assert/strict';
import test from 'node:test';

import { report } from '../../scripts/stats.mjs';

const RANGE = { first: '2026-10-09', last: '2026-10-15' };
const STANDING = { accounts: 9, paying: 1, next_end: null };

/** The lines report() prints for `rows`. */
function printed(t, rows) {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(...args.join(' ').split('\n')));
  report(rows, { days: 7, local: true }, RANGE, STANDING);
  t.mock.restoreAll();
  return lines;
}

test('the report leads with the pages people saw, ahead of the page views scripts swell', (t) => {
  const lines = printed(t, [
    { day: '2026-10-14', event: 'pv:/', n: 300 },
    { day: '2026-10-14', event: 'browser_view', n: 40 },
    { day: '2026-10-14', event: 'page_seen', n: 12 },
    { day: '2026-10-14', event: 'register', n: 1 },
    { day: '2026-10-15', event: 'pv:/templates/immunefi', n: 50 },
    { day: '2026-10-15', event: 'page_seen', n: 9 },
    { day: '2026-10-15', event: 'ref:search-console', n: 2 },
    { day: '2026-10-15', event: 'ref:google-apps', n: 3 },
    { day: '2026-10-15', event: 'template_handoff', n: 3 },
    { day: '2026-10-15', event: 'signup_prompt_clicked', n: 1 },
  ]);
  const at = (pattern) => lines.findIndex((line) => pattern.test(line));

  assert.match(lines[1], /^Now: 9 accounts, 1 paying subscriber$/);
  const seen = at(/^Pages seen by people: 21 \(page_seen; the page views below include scripts\)$/);
  assert.ok(seen > 1, 'printed');
  assert.ok(seen < at(/^Page views: 350, of which a browser navigated to 40/), 'before the page views');
  assert.equal(lines.slice(2, seen).every((line) => line === ''), true, 'nothing comes between the standing line and it');

  // In the funnel too it comes first, and sign-ups are read against it.
  const funnel = at(/^Funnel$/);
  assert.match(lines[funnel + 1], /^ {2}pages seen +21$/);
  assert.match(lines[funnel + 2], /^ {2}page views +350$/);
  assert.match(lines[funnel + 3], /^ {2}register +1 {2}4\.8% of pages seen$/);

  // The split Google buckets are referrers like any other.
  assert.ok(at(/^ {2}google-apps +3 /) > at(/^Referrers: 5$/));
  assert.ok(at(/^ {2}search-console +2 /) > at(/^Referrers: 5$/));

  // The names other pages send are client events; page_seen is not repeated there.
  const events = at(/^Client events$/);
  const listed = lines.slice(events + 1).filter((line) => line.startsWith('  ')).map((line) => line.trim().split(/ +/)[0]);
  assert.ok(listed.includes('template_handoff') && listed.includes('signup_prompt_clicked'));
  assert.equal(listed.includes('page_seen'), false);

  // Each day shows what people saw before the page views.
  const days = at(/^Per day +seen +views +register +reviews +subs$/);
  assert.ok(days > events);
  assert.match(lines[days + 1], /^ {2}2026-10-14 +12 +300 +1 +0 +0$/);
  assert.match(lines[days + 2], /^ {2}2026-10-15 +9 +50 +0 +0 +0$/);
});

test('before page_seen was counted, sign-ups are still read against page views', (t) => {
  const lines = printed(t, [
    { day: '2026-10-10', event: 'pv:/', n: 200 },
    { day: '2026-10-10', event: 'register', n: 2 },
  ]);
  assert.ok(lines.includes('Pages seen by people: 0 (page_seen; the page views below include scripts)'));
  assert.ok(lines.some((line) => /^ {2}register +2 {2}1\.0% of page views$/.test(line)));
  assert.ok(lines.some((line) => /^ {2}2026-10-10 +0 +200 +2 +0 +0$/.test(line)));
});
