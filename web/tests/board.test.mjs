// The bounty board: reading each platform's list, remembering what is new,
// the figures, the markup built from third-party names, the page, the route
// that serves a newer day, and the workflow that builds one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildDay, normalizeAll } from '../../scripts/build-board.mjs';
import { NEW_DAYS, addHistory, assemble, dayNumber, dayOf, derive, emptyState, platformFigures, publicProgram, remember, series } from '../../scripts/board/assemble.mjs';
import { backfillDays } from '../../scripts/board/backfill.mjs';
import * as normalize from '../../scripts/board/normalize.mjs';
import { readAll, readJson } from '../../scripts/board/sources.mjs';
import { PLATFORMS, platform, programLink } from '../public/board/platforms.mjs';
import { contestList, costLabel, costLines, costPanel, filingNotes, freshList, hours, money, platformTable, programTable, select, shortDate, shownLine, spark, tiles, unseenCounts, updatedLine, withFresh } from '../public/board/render.mjs';
import { h, toHtml } from '../public/board/tree.mjs';
import { BOARD_SOURCE, boardData, clearBoardData } from '../src/board.ts';
import { CLIENT_EVENTS } from '../src/funnel.ts';
import { createEnv } from './worker-helpers.mjs';

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_DIR = path.join(WEB_DIR, '..');
const read = (...parts) => readFileSync(path.join(REPO_DIR, ...parts), 'utf8');
const TODAY = '2026-11-10';

// --- What each platform published, in small ----------------------------------

const RAW = {
  hackerone: {
    targets: [
      { handle: 'acme', name: 'Acme', url: 'https://hackerone.com/acme', submission_state: 'open', offers_bounties: true, managed_program: true, response_efficiency_percentage: 97,
        targets: { in_scope: [
          { asset_type: 'WILDCARD', asset_identifier: '*.acme.test', eligible_for_submission: true },
          { asset_type: 'URL', asset_identifier: 'https://app.acme.test', eligible_for_submission: true },
          { asset_type: 'URL', asset_identifier: 'https://app.acme.test', eligible_for_submission: true },
          { asset_type: 'SMART_CONTRACT', asset_identifier: '0xabc', eligible_for_submission: true },
          { asset_type: 'URL', asset_identifier: 'https://old.acme.test', eligible_for_submission: false },
        ], out_of_scope: [] } },
      { handle: 'vdp', name: 'Quiet VDP', url: 'https://hackerone.com/vdp', submission_state: 'open', offers_bounties: false, targets: { in_scope: [], out_of_scope: [] } },
      { handle: 'closed', name: 'Closed', url: 'https://hackerone.com/closed', submission_state: 'paused', offers_bounties: true, targets: { in_scope: [] } },
      { handle: 'elsewhere', name: 'Elsewhere', url: 'https://evil.test/elsewhere', submission_state: 'open', offers_bounties: true, targets: { in_scope: [] } },
    ],
    teams: [{ handle: 'acme', launched_at: '2026-11-01T10:00:00.000Z', maximum_bounty_table_value: 25000, resolved_report_count: 40, reports_received_last_90_days: 120, formatted_bounties_paid_last_90_days: 9000,
      most_recent_sla_snapshot: { average_time_to_first_program_response: 7.4, average_time_to_bounty_awarded: 52, average_time_to_report_resolved: 300 } }],
  },
  bugcrowd: {
    targets: [{ name: ' Paying  Co ', url: 'https://bugcrowd.com/engagements/paying-co', max_payout: 7500, managed_by_bugcrowd: true,
      targets: { in_scope: [{ type: 'website', target: '*.paying.test' }, { type: 'api', target: 'https://api.paying.test' }, { type: 'iot', name: 'Thermostat' }], out_of_scope: [] } }],
    disclosure: [
      { name: 'Open VDP', briefUrl: '/engagements/open-vdp', accessStatus: 'open', isPrivate: false, isDemo: false },
      { name: 'Paying Co again', briefUrl: '/engagements/paying-co', accessStatus: 'open', isPrivate: false, isDemo: false },
      { name: 'Private VDP', briefUrl: '/engagements/private-vdp', accessStatus: 'open', isPrivate: true, isDemo: false },
    ],
  },
  intigriti: {
    targets: [{ id: 'int-1', targets: { in_scope: [{ type: 'wildcard', endpoint: '*.int.test' }, { type: 'ios', endpoint: 'com.int.app' }] } }],
    programs: [
      { programId: 'int-1', status: 3, confidentialityLevel: 4, companyHandle: 'intco', handle: 'main', name: 'Int Co', maxBounty: { value: 4000, currency: 'EUR' }, createdAt: 1762000000, lastSubmissionAt: 1762700000 },
      { programId: 'int-2', status: 3, confidentialityLevel: 4, companyHandle: 'intco', handle: 'vdp', name: 'Int VDP', maxBounty: { value: 0, currency: 'EUR' }, createdAt: 1700000000 },
      { programId: 'int-3', status: 4, confidentialityLevel: 4, companyHandle: 'x', handle: 'y', name: 'Suspended', maxBounty: { value: 100, currency: 'EUR' } },
      { programId: 'int-4', status: 3, confidentialityLevel: 2, companyHandle: 'x', handle: 'z', name: 'By application', maxBounty: { value: 100, currency: 'EUR' } },
    ],
  },
  yeswehack: {
    targets: [
      { id: 'ywh-usd', name: 'Dollar program', public: true, disabled: false, max_bounty: 2000, targets: { in_scope: [{ type: 'web-application', target: 'https://a.test' }] } },
      { id: 'ywh-unknown', name: 'No currency known', public: true, disabled: false, max_bounty: 900, targets: { in_scope: [] } },
      { id: 'ywh-off', name: 'Disabled', public: true, disabled: true, max_bounty: 900, targets: { in_scope: [] } },
    ],
    programs: [{ slug: 'ywh-usd', reports_count: 640, business_unit: { currency: 'USD' } }],
  },
  immunefi: [
    { slug: 'vault', project: 'Vault', isPaused: false, endDate: null, maxBounty: 1000000, launchDate: '2024-03-01T00:00:00.000Z', kyc: true, features: ['Pay to Submit', 'Managed Triage: Time Saver'],
      pocPerTypeAndSeverity: ['smart_contract - critical'], inviteOnly: false,
      assets: [{ url: 'https://etherscan.io/address/0x1', type: 'smart_contract', addedAt: '2024-03-01T00:00:00.000Z' }, { url: 'https://etherscan.io/address/0x2', type: 'smart_contract', addedAt: '2026-11-05T00:00:00.000Z' }] },
    { slug: 'paused', project: 'Paused', isPaused: true, endDate: null, maxBounty: 5, assets: [] },
    { slug: 'live-comp', project: 'Audit Competition | Live', isPaused: false, endDate: '2026-11-16T00:00:00.000Z', launchDate: '2026-11-02T00:00:00.000Z', maxBounty: 80000, rewardsPool: 80000, features: ['Pay to Submit'], kyc: false, pocPerTypeAndSeverity: [], assets: [] },
    { slug: 'old-comp', project: 'Audit Comp | Old', isPaused: false, endDate: '2026-09-14T00:00:00.000Z', launchDate: '2026-08-18T00:00:00.000Z', maxBounty: 70000, assets: [] },
  ],
  cantina: { items: [
    { id: 'c-1', kind: 'public_bounty', status: 'live', name: 'Pool', url: 'https://cantina.xyz/bounties/c-1', totalRewardPot: '15500000', submissionFee: '50.00', kycRequired: true, cantinaTriaged: true, totalFindings: 1140,
      timeframe: { start: '2024-11-26T14:00:00Z', end: null }, assetGroups: [{ name: 'Smart Contracts', outOfScope: false, hidden: false, assets: [{ id: 'a1' }, { id: 'a2', hidden: true }] }, { name: 'Out', outOfScope: true, assets: [{ id: 'a3' }] }] },
    { id: 'c-2', kind: 'private_bounty', status: 'live', name: null, url: null, totalRewardPot: '10000', kycRequired: false },
    { id: 'c-3', kind: 'public_contest', status: 'judging', name: 'Ended contest', url: 'https://cantina.xyz/competitions/c-3', totalRewardPot: '50000', timeframe: { start: '2026-10-06T18:30:00Z', end: '2026-11-03T18:30:00Z' } },
    { id: 'c-4', kind: 'public_bounty', status: 'migrated', name: 'Moved', url: 'https://cantina.xyz/bounties/c-4', totalRewardPot: '5' },
  ] },
  sherlock: {
    bounties: [{ id: 56, title: 'Usual', payout: 16000000, live_since: 1744113073, is_ready: true, severities: [{ deposit_amount: 250 }, { deposit_amount: 500 }] }],
    contests: [{ id: 9, title: 'Done', status: 'FINISHED', private: false, starts_at: 1757948400, ends_at: 1760367600, prize_pool: 1 }],
  },
  code4rena: { data: { audits: [
    { slug: '2026-04-old', title: 'Old', codeAccess: 'public', startTime: '2026-04-24T20:00:00.000Z', endTime: '2026-05-04T20:00:00.000Z', formattedAmount: '$22,000 in USDC' },
    { slug: '2026-11-live', title: 'Live', codeAccess: 'public', startTime: '2026-11-05T20:00:00.000Z', endTime: '2026-11-20T20:00:00.000Z', formattedAmount: '$135,000 in USDC', hasMandatoryProofOfConcept: true },
  ] } },
};

const byId = (programs) => new Map(programs.map((program) => [program.id, program]));

test('every platform on the board has a name, a directory, the hosts its links may use and a source in words', () => {
  assert.deepEqual(PLATFORMS.map((entry) => entry.id), ['hackerone', 'bugcrowd', 'intigriti', 'yeswehack', 'immunefi', 'cantina', 'sherlock', 'code4rena']);
  for (const entry of PLATFORMS) {
    assert.ok(entry.name && entry.source.length > 20, entry.id);
    assert.ok(['web2', 'web3'].includes(entry.side));
    assert.ok(entry.hosts.includes(new URL(entry.home).hostname), `${entry.id}: its own directory is on one of its hosts`);
  }
  // A template link, where there is one, is a page the site builds.
  const built = JSON.parse(read('web', 'site', '.generated.json'));
  const files = new Set(Array.isArray(built) ? built : built.files ?? Object.keys(built));
  for (const entry of PLATFORMS) if (entry.template) assert.ok([...files].some((file) => String(file).includes(`${entry.template.slice(1)}.html`)), entry.template);
});

test('a program link is kept only when it is https on one of its platform’s hosts', () => {
  assert.equal(programLink('hackerone', 'https://hackerone.com/acme'), 'https://hackerone.com/acme');
  for (const bad of ['http://hackerone.com/acme', 'https://hackerone.com.evil.test/acme', 'https://evil.test/hackerone.com', 'javascript:alert(1)', 'https://user:pw@hackerone.com/x', 'https://hackerone.com:8443/x', '', null, 42, `https://hackerone.com/${'a'.repeat(400)}`]) {
    assert.equal(programLink('hackerone', bad), null, String(bad));
  }
  assert.equal(programLink('nowhere', 'https://hackerone.com/acme'), null);
  assert.equal(platform('cantina').name, 'Cantina');
});

test('each platform’s list becomes program records, and what it does not publish is left out', () => {
  const all = normalizeAll(RAW, TODAY);
  const programs = byId(Object.values(all).flat());

  // HackerOne: scope from the data set, the rest from its directory. A closed program and a link on another host are dropped.
  assert.deepEqual(all.hackerone.map((program) => program.id), ['hackerone:acme', 'hackerone:vdp']);
  const acme = programs.get('hackerone:acme');
  assert.deepEqual([acme.kind, acme.max, acme.cur, acme.launched, acme.assets, acme.wildcards], ['bounty', 25000, 'USD', '2026-11-01', 3, 1]);
  assert.deepEqual([acme.kinds.web, acme.kinds.contract], [2, 1], 'a repeated asset counts once and one not open to reports is left out');
  assert.deepEqual([acme.firstResponseH, acme.bountyH, acme.reports90, acme.paid90, acme.triaged], [7, 52, 120, 9000, true]);
  assert.deepEqual([programs.get('hackerone:vdp').kind, programs.get('hackerone:vdp').max], ['vdp', null]);

  // Bugcrowd: paying engagements with scope, plus the disclosure list without; a private one and a repeat are left out.
  assert.deepEqual(all.bugcrowd.map((program) => [program.id, program.kind, program.assets]), [['bugcrowd:paying-co', 'bounty', 3], ['bugcrowd:open-vdp', 'vdp', null]]);
  assert.equal(programs.get('bugcrowd:paying-co').name, 'Paying Co');
  assert.deepEqual([programs.get('bugcrowd:paying-co').wildcards, programs.get('bugcrowd:paying-co').kinds.hardware], [1, 1]);

  // Intigriti: open and public only; the launch date and currency are its own.
  assert.deepEqual(all.intigriti.map((program) => program.id), ['intigriti:int-1', 'intigriti:int-2']);
  const int = programs.get('intigriti:int-1');
  assert.deepEqual([int.kind, int.max, int.cur, int.launched, int.assets, int.url], ['bounty', 4000, 'EUR', '2025-11-01', 2, 'https://app.intigriti.com/programs/intco/main/detail']);
  assert.equal(programs.get('intigriti:int-2').kind, 'vdp');

  // YesWeHack: a reward whose currency is not known is not shown as a figure.
  const usd = programs.get('yeswehack:ywh-usd');
  assert.deepEqual([usd.max, usd.cur, usd.reports], [2000, 'USD', 640]);
  assert.deepEqual([programs.get('yeswehack:ywh-unknown').max, programs.get('yeswehack:ywh-unknown').kind], [null, 'bounty']);
  assert.ok(!programs.has('yeswehack:ywh-off'));

  // Immunefi: the fee flag, KYC, proof of concept, dated assets; a paused program and an ended competition are left out.
  assert.deepEqual(all.immunefi.map((program) => [program.id, program.kind]), [['immunefi:vault', 'bounty'], ['immunefi:live-comp', 'contest']]);
  const vault = programs.get('immunefi:vault');
  assert.deepEqual([vault.cost, vault.kyc, vault.poc, vault.triaged], [{ type: 'fee', amount: null, cur: null }, true, true, true]);
  assert.deepEqual(Object.values(vault.assetDates).sort(), ['2024-03-01', '2026-11-05']);
  const comp = programs.get('immunefi:live-comp');
  assert.deepEqual([comp.name, comp.url, comp.ends, comp.pool], ['Live', 'https://immunefi.com/audit-competition/live-comp/information/', '2026-11-16', 80000]);

  // Cantina: the fee as published; an unnamed private bounty, an ended contest and a moved bounty are left out.
  assert.deepEqual(all.cantina.map((program) => program.id), ['cantina:c-1']);
  const pool = programs.get('cantina:c-1');
  assert.deepEqual([pool.cost, pool.kyc, pool.max, pool.assets, pool.findings, pool.launched], [{ type: 'fee', amount: 50, cur: 'USD' }, true, 15500000, 1, 1140, '2024-11-26']);

  // Sherlock: the lowest stake of its severities; a finished contest is left out.
  assert.deepEqual(all.sherlock.map((program) => [program.id, program.cost, program.max, program.url]), [['sherlock:bounty-56', { type: 'deposit', amount: 250, cur: 'USD' }, 16000000, 'https://audits.sherlock.xyz/bug-bounties/56']]);

  // Code4rena: only an audit that has not ended, with the pool as it prints it.
  assert.deepEqual(all.code4rena.map((program) => [program.id, program.pool, program.poc, program.ends]), [['code4rena:2026-11-live', 135000, true, '2026-11-20']]);
});

test('a name is one clean line, and a key for an asset is stable and ignores case', () => {
  assert.equal(normalize.cleanName('  Evil‮\n\tName\u0000  '), 'Evil Name');
  assert.equal(normalize.cleanName('x'.repeat(300)).length, 120);
  assert.equal(normalize.cleanName(42), '');
  assert.equal(normalize.assetKey('p:1', 'HTTPS://A.test '), normalize.assetKey('p:1', 'https://a.test'));
  assert.notEqual(normalize.assetKey('p:1', 'https://a.test'), normalize.assetKey('p:2', 'https://a.test'));
  assert.deepEqual([normalize.day('2026-11-05T10:00:00Z'), normalize.day(1744113073), normalize.day('nonsense'), normalize.day(null)], ['2026-11-05', '2025-04-08', null, null]);
});

// --- What is new -------------------------------------------------------------

const program = (id, keys, extra = {}) => ({ id, platform: id.split(':')[0], kind: 'bounty', name: id, url: 'https://hackerone.com/x', max: null, cur: null, assets: keys.length, wildcards: 0,
  kinds: Object.fromEntries(normalize.ASSET_KIND_IDS.map((kind) => [kind, 0])), assetKeys: keys, assetDates: {}, launched: null, cost: null, kyc: null, poc: null, triaged: null, ...extra });

test('the first run records everything as already there; later runs mark only what appears', () => {
  const state = emptyState();
  remember(state, [program('hackerone:a', ['k1', 'k2'])], '2026-11-01');
  assert.equal(state.since, '2026-11-01');
  assert.deepEqual(derive(program('hackerone:a', ['k1', 'k2']), state, '2026-11-01'), { launched: null, launchedBy: null, new30: 0, scopeAt: null, isNew: false });

  // Next day: one asset more on a, and a program not seen before.
  remember(state, [program('hackerone:a', ['k1', 'k2', 'k3']), program('hackerone:b', ['b1'])], '2026-11-02');
  assert.deepEqual(derive(program('hackerone:a', ['k1', 'k2', 'k3']), state, '2026-11-02'), { launched: null, launchedBy: null, new30: 1, scopeAt: '2026-11-02', isNew: false });
  assert.deepEqual(derive(program('hackerone:b', ['b1']), state, '2026-11-02'), { launched: '2026-11-02', launchedBy: 'seen', new30: 1, scopeAt: '2026-11-02', isNew: true });

  // A platform's own launch date wins over the day the board first saw the program.
  assert.equal(derive(program('hackerone:b', ['b1'], { launched: '2026-10-30' }), state, '2026-11-02').launchedBy, 'platform');

  // After the window nothing is new any more.
  const later = dayOf(dayNumber('2026-11-02') + NEW_DAYS);
  assert.deepEqual([derive(program('hackerone:b', ['b1']), state, later).isNew, derive(program('hackerone:b', ['b1']), state, later).new30], [false, 0]);
});

test('a program that drops out of a list for a day and returns is neither a launch nor new scope', () => {
  const state = emptyState();
  remember(state, [program('bugcrowd:a', ['k1']), program('bugcrowd:b', ['x'])], '2026-11-01');
  remember(state, [program('bugcrowd:b', ['x'])], '2026-11-02');
  assert.equal(state.programs['bugcrowd:a'].gone, dayNumber('2026-11-02'));
  remember(state, [program('bugcrowd:a', ['k1']), program('bugcrowd:b', ['x'])], '2026-11-03');
  assert.equal(state.programs['bugcrowd:a'].gone, undefined);
  assert.deepEqual(derive(program('bugcrowd:a', ['k1']), state, '2026-11-03'), { launched: null, launchedBy: null, new30: 0, scopeAt: null, isNew: false });
  // An asset that left the scope and is still remembered does not count as scope today.
  assert.equal(derive(program('bugcrowd:a', []), state, '2026-11-03').new30, 0);
});

test('a platform read for the first time, and a new source of one, arrive without a day of false launches', () => {
  const state = emptyState();
  remember(state, [program('hackerone:a', ['k1'])], '2026-11-01');
  // Immunefi is followed from the second day: its programs were not launched that day.
  remember(state, [program('hackerone:a', ['k1']), program('immunefi:v', ['c1'], { assetDates: { c1: '2026-11-02' } })], '2026-11-02');
  const fresh = derive(program('immunefi:v', ['c1']), state, '2026-11-02');
  assert.deepEqual([fresh.isNew, fresh.launched, fresh.new30], [false, null, 1], 'the platform dates its assets itself, so a dated one still counts');
  // quietNew: programs of a known platform that appear because a source was added.
  remember(state, [program('hackerone:a', ['k1']), program('hackerone:late', ['z'])], '2026-11-03', { quietNew: true });
  assert.equal(derive(program('hackerone:late', ['z']), state, '2026-11-03').isNew, false);
  // A platform that could not be read keeps what it had.
  remember(state, [program('immunefi:v', ['c1'])], '2026-11-04');
  assert.equal(state.programs['hackerone:a'].gone, undefined);
});

test('the figures of a platform are counted from its records and nothing else', () => {
  const state = emptyState();
  const programs = [
    program('cantina:a', ['1', '2'], { max: 500000, cur: 'USD', cost: { type: 'fee', amount: 50 }, kyc: true, wildcards: 1, findings: 10 }),
    program('cantina:b', ['3'], { max: 100000, cur: 'USD', cost: { type: 'fee', amount: 5 }, kyc: false }),
    program('cantina:c', [], { kind: 'vdp', assets: null }),
    program('cantina:d', [], { kind: 'contest', max: 9, cur: 'USD' }),
  ];
  remember(state, programs, TODAY);
  const figures = platformFigures(programs, new Map(programs.map((entry) => [entry.id, derive(entry, state, TODAY)])));
  assert.deepEqual([figures.programs, figures.paying, figures.vdps, figures.contests, figures.assets, figures.wildcards], [3, 2, 1, 1, 3, 1]);
  assert.deepEqual([figures.withCost, figures.costMin, figures.costMax, figures.costType, figures.kyc, figures.kycKnown], [2, 5, 50, 'fee', 1, 2]);
  assert.deepEqual([figures.top.name, figures.top.max, figures.medianMax, figures.medianOf, figures.findings, figures.findingsOf], ['cantina:a', 500000, 300000, 2, 10, 1]);
  assert.equal(figures.respMedianH, undefined, 'a figure no program publishes is absent, not zero');
});

test('history keeps one point a day and a long run is thinned to the newest eighty', () => {
  const history = { v: 1, days: [] };
  addHistory(history, '2026-11-02', { hackerone: { programs: 5, paying: 3, assets: 9, wildcards: 1 } });
  addHistory(history, '2026-11-01', { hackerone: { programs: 4, paying: 2, assets: 8, wildcards: 1 } });
  addHistory(history, '2026-11-02', { hackerone: { programs: 6, paying: 3, assets: 9, wildcards: 1 }, cantina: { programs: 1, paying: 1, assets: 0, wildcards: 0 } });
  assert.deepEqual(history.days.map((entry) => entry.d), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(series(history, 'hackerone', 0), [['2026-11-01', 4], ['2026-11-02', 6]]);
  assert.deepEqual(series(history, 'cantina', 1), [['2026-11-02', 1]]);
  for (let index = 0; index < 200; index += 1) addHistory(history, dayOf(dayNumber('2026-01-01') + index), { hackerone: { programs: index, paying: 0, assets: 0, wildcards: 0 } });
  const thin = series(history, 'hackerone', 0);
  assert.equal(thin.length, 80);
  assert.equal(thin.at(-1)[0], history.days.at(-1).d, 'the newest day is always kept');
});

test('a day’s build: a platform that cannot be read keeps its last good figures, marked with their date', () => {
  const first = buildDay({ raw: RAW, prior: {}, today: '2026-11-09', at: '2026-11-09T05:23:00.000Z' });
  assert.deepEqual(Object.keys(first.problems), []);
  assert.equal(first.snapshot.totals.platforms, 8);
  assert.deepEqual(first.snapshot.fresh.map((row) => row.id), ['immunefi:vault', 'hackerone:acme'], 'on the first day only what a platform dates itself is new: an asset and a launch');

  const { immunefi, ...rest } = RAW;
  const second = buildDay({ raw: rest, failed: { immunefi: 'immunefi.com: HTTP 403' }, prior: first, today: TODAY, at: '2026-11-10T05:23:00.000Z' });
  assert.deepEqual(second.snapshot.failed, ['immunefi']);
  const stale = second.snapshot.platforms.find((entry) => entry.id === 'immunefi');
  assert.deepEqual([stale.stale, stale.asOf, stale.programs, stale.withCost], [true, '2026-11-09', 1, 1]);
  assert.ok(second.programs.programs.some((entry) => entry.id === 'immunefi:vault'), 'its programs stay on the list');
  assert.equal(second.snapshot.platforms.find((entry) => entry.id === 'cantina').asOf, TODAY);
  assert.match(updatedLine(second.snapshot), /Immunefi could not be read that day and shows its last good figures\./);

  // A list that halves overnight is treated as a failed read, not as an exodus.
  const many = { ...RAW, cantina: { items: Array.from({ length: 12 }, (_, index) => ({ ...RAW.cantina.items[0], id: `c-${index + 10}`, url: `https://cantina.xyz/bounties/c-${index + 10}` })) } };
  const full = buildDay({ raw: many, prior: {}, today: '2026-11-09', at: 'x' });
  const shrunk = buildDay({ raw: RAW, prior: full, today: TODAY, at: 'y' });
  assert.match(shrunk.problems.cantina, /shrank from 12 to 1/);
  assert.equal(shrunk.snapshot.platforms.find((entry) => entry.id === 'cantina').programs, 12);
});

test('the public program is short: no empty field, no asset keys, and flags as 1 or 0', () => {
  const state = emptyState();
  const [vault] = normalize.immunefi(RAW.immunefi, TODAY);
  remember(state, [vault], '2026-11-01');
  const out = publicProgram(vault, derive(vault, state, TODAY));
  assert.deepEqual(Object.keys(out).sort(), ['assets', 'cost', 'cur', 'id', 'kind', 'kinds', 'kyc', 'launched', 'max', 'name', 'new30', 'p', 'poc', 'scopeAt', 'triaged', 'url']);
  assert.deepEqual([out.kyc, out.poc, out.cost, out.new30, out.scopeAt], [1, 1, { type: 'fee' }, 1, '2026-11-05']);
});

test('the backfill reads a day a month, then a day a week, then every day of the last three weeks', () => {
  const days = backfillDays('2026-11-10', '2025-11-10');
  assert.equal(days.at(-1), '2026-11-09');
  assert.deepEqual(days.slice(-3), ['2026-11-07', '2026-11-08', '2026-11-09']);
  assert.ok(days.includes('2025-12-01') && days.includes('2026-08-01'));
  assert.ok(days.every((entry, index) => index === 0 || entry > days[index - 1]), 'oldest first, no day twice');
  assert.ok(days.length > 30 && days.length < 50);
});

// --- Reading the platforms ---------------------------------------------------

test('one platform’s outage does not empty the board, and a refusal is not asked again at once', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    if (String(url).includes('immunefi.com')) return new Response('blocked', { status: 403 });
    if (String(url).includes('code4rena.com')) return Response.json({ data: { audits: [] } });
    return new Response('not json', { status: 200 });
  };
  const { raw, failed } = await readAll({ fetchImpl, tries: 1 });
  assert.deepEqual(Object.keys(raw), ['code4rena']);
  assert.match(failed.immunefi, /^immunefi\.com: HTTP 403$/);
  assert.equal(Object.keys(failed).length, 7);
  assert.equal(asked.filter((url) => url.includes('immunefi.com')).length, 1);

  let tries = 0;
  await assert.rejects(readJson('https://cantina.xyz/x', { fetchImpl: async () => { tries += 1; return new Response('', { status: 404 }); }, tries: 3 }), /cantina\.xyz: HTTP 404/);
  assert.equal(tries, 1);
  await assert.rejects(readJson('https://cantina.xyz/x', { fetchImpl: async () => new Response('x'.repeat(50)), maxBytes: 10, tries: 1 }), /larger than 10 bytes/);
});

test('the reader names itself and asks for nothing that needs an account', () => {
  const source = read('scripts', 'board', 'sources.mjs');
  assert.match(source, /bounty-operator-board\/1 \(\+https:\/\/bountyoperator\.com\/board\)/);
  assert.doesNotMatch(source, /Authorization|Cookie|api[_-]?key|token/i);
});

// --- Markup from third-party names -------------------------------------------

test('a tree escapes every text and attribute, and refuses a style or an event attribute', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const markup = toHtml(h('p', { title: evil, hidden: false, open: true }, [evil, 7, null, false, [h('b', {}, ['ok'])]]));
  assert.equal(markup, '<p title="&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;" open>&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;7<b>ok</b></p>');
  assert.throws(() => h('p', { style: 'color:red' }), /not allowed/);
  assert.throws(() => h('p', { onclick: 'x()' }), /not allowed/);
  assert.equal(toHtml(h('input', { type: 'search' })), '<input type="search">');
});

test('a program’s name is a link only to its own platform, and a hostile name stays text', () => {
  const snapshot = { day: TODAY, newDays: 30 };
  const rows = [
    { id: 'hackerone:x', p: 'hackerone', kind: 'bounty', name: '<script>alert(1)</script>', url: 'https://hackerone.com/x', max: 5000, cur: 'USD' },
    { id: 'hackerone:y', p: 'hackerone', kind: 'bounty', name: 'Elsewhere', url: 'https://evil.test/y' },
  ];
  const markup = toHtml(programTable(rows, snapshot));
  assert.ok(markup.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !markup.includes('<script>'));
  assert.ok(markup.includes('href="https://hackerone.com/x" target="_blank" rel="noopener noreferrer"'));
  assert.ok(!markup.includes('evil.test'), 'a link on another host is not written at all');
  assert.doesNotMatch(markup, /\sstyle=|\son[a-z]+=/);
});

test('figures are written as published: money by currency, hours, dates', () => {
  assert.deepEqual([money(15500000), money(250000), money(8500), money(230000, 'EUR'), money(51337, 'EUR'), money(20000, 'GBP'), money(5000, 'CHF'), money(null)], ['$15.5M', '$250K', '$8,500', '€230K', '€51,337', '£20,000', '5,000 CHF', '']);
  assert.deepEqual([hours(7), hours(47), hours(52), hours(3258)], ['7 h', '47 h', '2 d', '136 d']);
  assert.deepEqual([shortDate('2026-11-05', TODAY), shortDate('2025-04-08', TODAY), shortDate('nonsense', TODAY)], ['5 Nov', '8 Apr 2025', '']);
  assert.deepEqual([costLabel({ type: 'fee', amount: 50 }), costLabel({ type: 'deposit', amount: 250 }), costLabel({ type: 'fee' }), costLabel(null)], ['$50 fee', '$250 stake', 'Fee to file', '']);
});

test('a line needs four points, and a run that moves under 2% is drawn flat', () => {
  assert.equal(spark([['2026-01-01', 1], ['2026-02-01', 2], ['2026-03-01', 3]], 'x'), null);
  const points = (values) => values.map((value, index) => [dayOf(dayNumber('2026-01-01') + index * 30), value]);
  assert.equal(spark(points([100, 110, 120, 140]), 'Paying').attrs['data-trend'], 'up');
  assert.equal(spark(points([140, 120, 110, 100]), 'Paying').attrs['data-trend'], 'down');
  assert.equal(spark(points([1000, 1005, 998, 1001]), 'Paying').attrs['data-trend'], 'flat');
  assert.equal(spark(points([0, 0, 0, 0]), 'Paying').attrs['data-trend'], 'flat');
  const line = spark(points([100, 110, 120, 140]), 'Paying');
  assert.match(line.attrs['aria-label'], /^Paying: 100 on 1 Jan 2026, 140 on 1 Apr 2026$/);
  assert.doesNotMatch(toHtml(line), /NaN/);
});

// --- The built day, as the page shows it -------------------------------------

const BUILT = buildDay({ raw: RAW, prior: {}, today: TODAY, at: '2026-11-10T05:23:00.000Z' });

test('the sections say what the data says', () => {
  const { snapshot } = BUILT;
  const text = (tree) => toHtml(tree).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text(tiles(snapshot)), /11 Programs open 8 pay a bounty, 3 take reports without one/);
  assert.match(text(tiles(snapshot)), /1 Launched in 30 days 1 asset added to scope in the same time/);
  assert.match(text(tiles(snapshot)), /3 Charge to file/);
  const table = text(platformTable(snapshot));
  assert.match(table, /Cantina Web3 .* A fee on 1, \$50 KYC on 1 1,140 findings filed to date/);
  assert.match(table, /Sherlock Web3 .* A stake on 1, \$250/);
  assert.match(table, /HackerOne Web2 .* First answer in 7 h, the median of 1 \$9,000 paid in 90 days 120 reports in 90 days/);
  assert.deepEqual(filingNotes({ withCost: 0 }), []);
  const lines = costLines(snapshot);
  assert.deepEqual(lines.cost.map((row) => [row.name, row.n, row.text]), [['Immunefi', 1, 'the amount is shown when you submit'], ['Cantina', 1, '$50 fee'], ['Sherlock', 1, '$250 stake, returned for a valid report']]);
  assert.match(text(costPanel(snapshot)), /3 programs charge you to file a report/);
  assert.match(text(contestList(snapshot)), /Live Immunefi \$80,000 pool 2 Nov to 16 Nov, 6 days left Fee to file/);
  assert.match(text(contestList(snapshot)), /Live Code4rena \$135K pool .* PoC required/);
  assert.match(text(contestList(snapshot)), /No public audit contest is open on Cantina or Sherlock today\./);
});

test('what is new is listed newest first, and a returning visitor’s unseen rows are marked', () => {
  const { snapshot } = BUILT;
  assert.deepEqual(snapshot.fresh.map((row) => [row.id, row.what, row.date]), [['immunefi:vault', 'scope', '2026-11-05'], ['hackerone:acme', 'launched', '2026-11-01'], ['intigriti:int-1', 'launched', '2025-11-01']].filter((row) => row[2] > '2026-10-11'));
  assert.deepEqual(unseenCounts(snapshot, '2026-11-03'), [0, 1]);
  assert.deepEqual(unseenCounts(snapshot, null), [0, 0]);
  const marked = toHtml(freshList(snapshot, { since: '2026-11-03' }));
  assert.equal(marked.split('New to you').length - 1, 1);
  assert.ok(!toHtml(freshList(snapshot)).includes('New to you'));
  assert.match(toHtml(freshList({ ...snapshot, fresh: [] })), /Nothing launched or added scope in the last 30 days\./);
});

test('the filters leave what they say, and an order never invents a figure', () => {
  const programs = withFresh(BUILT.programs.programs, BUILT.snapshot);
  const ids = (filters) => select(programs, filters).map((entry) => entry.id);
  assert.ok(!ids({}).some((id) => id.includes('comp') || id.includes('live')), 'contests have their own section');
  assert.deepEqual(ids({ sort: 'max' }).slice(0, 3), ['sherlock:bounty-56', 'cantina:c-1', 'immunefi:vault']);
  assert.deepEqual(ids({ platform: 'bugcrowd' }), ['bugcrowd:paying-co', 'bugcrowd:open-vdp']);
  assert.deepEqual(ids({ platform: 'bugcrowd', pays: true }), ['bugcrowd:paying-co']);
  assert.ok(!ids({ free: true }).some((id) => ['sherlock:bounty-56', 'cantina:c-1', 'immunefi:vault'].includes(id)));
  assert.ok(!ids({ noKyc: true }).some((id) => ['cantina:c-1', 'immunefi:vault'].includes(id)));
  assert.deepEqual(ids({ fresh: true }).sort(), ['hackerone:acme', 'immunefi:vault']);
  assert.deepEqual(ids({ query: 'int co' }), ['intigriti:int-1']);
  assert.deepEqual(ids({ query: 'cantina' }), ['cantina:c-1'], 'a platform name finds its programs');
  assert.equal(ids({ sort: 'paid' })[0], 'hackerone:acme');
  assert.equal(ids({ sort: 'resp' })[0], 'hackerone:acme');
  assert.equal(ids({ sort: 'nonsense' })[0], 'sherlock:bounty-56', 'an unknown order falls back to reward');
  assert.deepEqual([shownLine(40, 1406, 1406), shownLine(40, 55, 1406), shownLine(7, 7, 1406), shownLine(0, 0, 1406)], ['Showing 40 of 1,406 programs.', 'Showing 40 of 55 matching programs.', 'All 7 matching programs.', 'No program matches. Clear a filter or shorten the search.']);
});

// --- The page ----------------------------------------------------------------

test('the built page carries the bundled day’s figures, and its script asks this site only', async () => {
  const page = (await import('../site/pages/board.mjs')).default;
  const { SNAPSHOT, PROGRAMS, FIRST_ROWS } = await import('../site/pages/board.mjs');
  const built = readFileSync(path.join(WEB_DIR, 'public', 'board.html'), 'utf8');
  assert.equal(page.path, '/board');
  assert.ok(page.description.length >= 50 && page.description.length <= 160, String(page.description.length));
  assert.ok(built.includes(`data-day="${SNAPSHOT.day}"`));
  assert.ok(built.includes(`${SNAPSHOT.totals.programs.toLocaleString('en-US')} programs on HackerOne, Bugcrowd, Intigriti, YesWeHack, Immunefi, Cantina, Sherlock and Code4rena`));
  assert.equal(built.split('class="board-row"').length - 1, Math.min(FIRST_ROWS, PROGRAMS.filter((entry) => entry.kind !== 'contest').length));
  for (const id of ['board-tiles', 'board-platforms', 'board-cost', 'board-fresh', 'board-contests', 'board-programs', 'board-count', 'board-more', 'board-q', 'board-platform', 'board-sort', 'board-updated', 'board-since']) assert.ok(built.includes(`id="${id}"`), id);
  assert.ok(built.includes('<a href="/board" aria-current="page">Board</a>') || /href="\/board"[^>]*aria-current="page"/.test(built), 'the header marks the board as the current page');
  // Every link out goes to one of the platforms, the data set or a page of ours.
  const hosts = new Set([...built.matchAll(/href="https:\/\/([^/"]+)/g)].map((match) => match[1]));
  const allowed = new Set([...PLATFORMS.flatMap((entry) => entry.hosts), 'github.com', 'x.com', 'bountyoperator.com', 'immunefi.com']);
  for (const host of hosts) assert.ok(allowed.has(host), `the page links to ${host}`);

  const script = readFileSync(path.join(WEB_DIR, 'public', 'board', 'board.mjs'), 'utf8');
  const requests = [...script.matchAll(/\[\[('[^']+'), ('[^']*')\], \[('[^']+'), ('[^']*')\]\]/g)].flat().slice(1);
  assert.deepEqual(requests, ["'/api/board/'", "''", "'/board/data/'", "'.json'"], 'the data comes from this origin: the route, then the deployed copy');
  assert.doesNotMatch(script, /https?:\/\//, 'the script names no other origin');
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.deepEqual([...script.matchAll(/\bping\(([^)]*)\)/g)].map((match) => match[1]), ["'board_used'"]);
  assert.ok(CLIENT_EVENTS.has('board_used'));
  for (const file of ['render.mjs', 'tree.mjs', 'platforms.mjs']) assert.doesNotMatch(readFileSync(path.join(WEB_DIR, 'public', 'board', file), 'utf8'), /innerHTML|insertAdjacentHTML|\bfetch\(/, file);
});

test('board.css uses tokens only', () => {
  const css = readFileSync(path.join(WEB_DIR, 'public', 'css', 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  assert.doesNotMatch(css, /prefers-reduced-motion|prefers-color-scheme/);
});

// --- The route ---------------------------------------------------------------

const doc = (name, day, extra = {}) => JSON.stringify({ v: 1, day, at: `${day}T05:23:00.000Z`, ...(name === 'programs' ? { programs: [] } : { platforms: [], totals: {} }), ...extra });

function boardEnv(deployed) {
  return createEnv({ ASSETS: { fetch: async (request) => {
    const name = new URL(request.url).pathname.match(/^\/board\/data\/(\w+)\.json$/)?.[1];
    return name && deployed[name] ? new Response(deployed[name]) : new Response('missing', { status: 404 });
  } } });
}

test('the route serves the later day of the branch and the deployed copy, and a bad branch file never replaces a good one', async (t) => {
  const asked = [];
  let branch = {};
  const modes = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    // As the Workers runtime does: the Fetch standard's 'error' redirect mode is not implemented and throws.
    if (init.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual".');
    modes.push(init.redirect);
    asked.push(String(url));
    const name = String(url).slice(BOARD_SOURCE.length + 1).replace('.json', '');
    if (branch[name] === undefined) return new Response('not found', { status: 404 });
    if (branch[name] instanceof Error) throw branch[name];
    return new Response(branch[name]);
  });
  const day = async (env, name) => {
    const response = await boardData(env, name);
    return [response.headers.get('x-board-day'), response.headers.get('content-type')];
  };
  const env = boardEnv({ snapshot: doc('snapshot', '2026-11-10'), programs: doc('programs', '2026-11-10') });

  clearBoardData();
  branch = { snapshot: doc('snapshot', '2026-11-12') };
  assert.deepEqual(await day(env, 'snapshot'), ['2026-11-12', 'application/json; charset=utf-8']);
  assert.deepEqual(asked, [`${BOARD_SOURCE}/snapshot.json`]);
  assert.deepEqual(modes, ['manual'], 'a redirect mode the Workers runtime accepts');
  // Kept for half an hour: the next visitor costs no request.
  await boardData(env, 'snapshot');
  assert.equal(asked.length, 1);

  // The deploy is newer than the branch.
  clearBoardData();
  branch = { snapshot: doc('snapshot', '2026-11-08') };
  assert.equal((await day(env, 'snapshot'))[0], '2026-11-10');

  // The branch is missing, unreadable, not JSON, the wrong shape, another version or too large: the deployed copy stands.
  for (const bad of [undefined, new Error('network'), 'not json', '[]', JSON.stringify({ v: 2, day: '2026-11-12', at: 'x', platforms: [], totals: {} }), JSON.stringify({ v: 1, day: 'soon', at: 'x', platforms: [], totals: {} }),
    JSON.stringify({ v: 1, day: '2026-11-12', at: 'x' }), doc('snapshot', '2026-11-12', { pad: 'x'.repeat(2_100_000) })]) {
    clearBoardData();
    branch = { snapshot: bad };
    assert.equal((await day(env, 'snapshot'))[0], '2026-11-10', String(bad).slice(0, 40));
  }
  clearBoardData();
  branch = { programs: JSON.stringify({ v: 1, day: '2026-11-12', at: 'x', programs: 'none' }) };
  assert.equal((await day(env, 'programs'))[0], '2026-11-10');

  // Neither can be read: a 503 the page answers by keeping what it was built with.
  clearBoardData();
  branch = {};
  await assert.rejects(boardData(boardEnv({}), 'snapshot'), (error) => error.status === 503 && error.code === 'board_unavailable');
});

test('no Worker code asks fetch for the redirect mode the Workers runtime does not implement', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = path.join(WEB_DIR, 'src');
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    assert.doesNotMatch(readFileSync(path.join(dir, file), 'utf8'), /redirect:\s*['"]error['"]/, file);
  }
});

test('the Worker routes both files, and only those', () => {
  const worker = read('web', 'src', 'worker.ts');
  assert.deepEqual([...worker.matchAll(/'\/api\/board\/(\w+)': \{ GET: boardRoute\('(\w+)'\) \}/g)].map((match) => [match[1], match[2]]), [['snapshot', 'snapshot'], ['programs', 'programs']]);
  assert.match(BOARD_SOURCE, /^https:\/\/raw\.githubusercontent\.com\/bountyoperator\/bounty-operator\/board-data$/);
});

// --- The workflow ------------------------------------------------------------

test('the daily workflow may write the data branch and nothing else, and uses no secret', () => {
  const workflow = read('.github', 'workflows', 'board-data.yml');
  assert.match(workflow, /^permissions:\n  contents: read$/m, 'the default is read');
  assert.deepEqual([...workflow.matchAll(/^\s+([a-z-]+): write\b/gm)].map((match) => match[1]), ['contents']);
  assert.deepEqual([...workflow.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]), ['github.token']);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /git push --force "https:\/\/x-access-token:\$\{GITHUB_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git" board-data$/m);
  assert.doesNotMatch(workflow, /push[^\n]*\bmain\b/);
  assert.match(workflow, /node scripts\/build-board\.mjs --data \.\.\/board-data$/m);
  assert.match(workflow, /cron: '\d+ \d+ \* \* \*'/);
});
