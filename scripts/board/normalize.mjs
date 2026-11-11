// One program record per public program, from each platform's own published
// list. Every function here is pure: it takes what a platform published and
// returns records, and leaves out a field the platform does not publish. No
// figure is estimated, converted or filled in.
//
// A record:
//   id        '<platform>:<the platform's own id>'
//   platform  a PLATFORMS id
//   kind      'bounty' pays for reports, 'vdp' accepts them without paying,
//             'contest' is an audit competition with an end date
//   name, url
//   max, cur  the highest reward the platform publishes for the program and
//             the currency it publishes it in; null when it publishes none
//   assets    in-scope assets counted; null when the platform lists none
//   wildcards how many of those are wildcard hosts
//   kinds     { web, api, mobile, contract, chain, source, network, hardware, other }
//   assetKeys one stable key per in-scope asset, to tell a new asset from a known one
//   assetDates { key: 'YYYY-MM-DD' } where the platform dates its assets itself
//   launched  'YYYY-MM-DD' when the platform publishes the launch date, else null
//   cost      what filing a report costs: { type: 'fee' | 'deposit', amount, cur } with
//             amount null when the platform says there is one but not how much; else null
//   kyc, poc, triaged  true, false, or null when the platform does not say
//   starts, ends, pool  contests only

import { createHash } from 'node:crypto';
import { programLink } from '../../web/public/board/platforms.mjs';

const KINDS = ['web', 'api', 'mobile', 'contract', 'chain', 'source', 'network', 'hardware', 'other'];

/** A name as it is shown: one line, trimmed, at most 120 characters. */
export function cleanName(value) {
  if (typeof value !== 'string') return '';
  // Control characters and bidirectional overrides have no place in a name.
  const text = value.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 119).trimEnd()}…` : text;
}

/** 'YYYY-MM-DD' from an ISO string or a Unix time in seconds; null when it is neither. */
export function day(value) {
  const date = typeof value === 'number' ? new Date(value * 1000) : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  return year >= 2005 && year <= 2100 ? date.toISOString().slice(0, 10) : null;
}

/** A whole, non-negative amount; null for anything else, zero included when `positive`. */
function amount(value, positive = true) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1e12) return null;
  return positive && number === 0 ? null : Math.round(number * 100) / 100;
}

/** A short key for one asset of one program. Stable between runs. */
export function assetKey(programId, identifier) {
  return createHash('sha256').update(`${programId}\n${String(identifier).trim().toLowerCase()}`).digest('base64url').slice(0, 10);
}

function emptyKinds() {
  return Object.fromEntries(KINDS.map((kind) => [kind, 0]));
}

/** Counts a program's assets from [kind, identifier, isWildcard] rows; duplicates count once. */
function scope(programId, rows) {
  const kinds = emptyKinds();
  const keys = new Set();
  let wildcards = 0;
  for (const [kind, identifier, wildcard] of rows) {
    if (typeof identifier !== 'string' || identifier.trim() === '') continue;
    const key = assetKey(programId, identifier);
    if (keys.has(key)) continue;
    keys.add(key);
    kinds[KINDS.includes(kind) ? kind : 'other'] += 1;
    if (wildcard) wildcards += 1;
  }
  return { assets: keys.size, wildcards, kinds, assetKeys: [...keys] };
}

function record(platformId, ownId, fields) {
  const name = cleanName(fields.name);
  const url = programLink(platformId, fields.url);
  if (!name || !url || typeof ownId !== 'string' || ownId === '' || ownId.length > 120) return null;
  return {
    id: `${platformId}:${ownId}`,
    platform: platformId,
    kind: 'bounty',
    max: null,
    cur: null,
    assets: null,
    wildcards: 0,
    kinds: emptyKinds(),
    assetKeys: [],
    assetDates: {},
    launched: null,
    cost: null,
    kyc: null,
    poc: null,
    triaged: null,
    ...fields,
    name,
    url,
  };
}

const list = (value) => (Array.isArray(value) ? value : []);
const present = (items) => items.filter(Boolean);

// --- HackerOne ---------------------------------------------------------------

const H1_KIND = {
  URL: 'web', WILDCARD: 'web', API: 'api', GOOGLE_PLAY_APP_ID: 'mobile', APPLE_STORE_APP_ID: 'mobile', OTHER_APK: 'mobile',
  TESTFLIGHT: 'mobile', OTHER_IPA: 'mobile', WINDOWS_APP_STORE_APP_ID: 'mobile', SOURCE_CODE: 'source', IP_ADDRESS: 'network',
  CIDR: 'network', HARDWARE: 'hardware', SMART_CONTRACT: 'contract',
};

/**
 * @param {unknown} targets  bounty-targets-data's hackerone_data.json: scope per program.
 * @param {unknown} teams  Nodes of HackerOne's public `teams` list: launch date, reward ceiling, 90-day figures.
 */
export function hackerone(targets, teams = []) {
  const stats = new Map(list(teams).map((team) => [team?.handle, team]));
  return present(list(targets).map((program) => {
    if (program?.submission_state !== 'open' || typeof program.handle !== 'string') return null;
    const id = `hackerone:${program.handle}`;
    const team = stats.get(program.handle) ?? {};
    const sla = team.most_recent_sla_snapshot ?? {};
    const pays = program.offers_bounties === true;
    const hours = (value) => (typeof value === 'number' && value > 0 && value < 1e6 ? Math.round(value) : null);
    return record('hackerone', program.handle, {
      name: program.name,
      url: program.url,
      kind: pays ? 'bounty' : 'vdp',
      // HackerOne publishes a program's bounty table ceiling unless the program hides its amounts.
      max: pays ? amount(team.maximum_bounty_table_value) : null,
      cur: pays && amount(team.maximum_bounty_table_value) !== null ? 'USD' : null,
      launched: day(team.launched_at),
      triaged: typeof program.managed_program === 'boolean' ? program.managed_program : null,
      ...scope(id, list(program.targets?.in_scope).filter((asset) => asset?.eligible_for_submission !== false)
        .map((asset) => [H1_KIND[asset.asset_type] ?? 'other', asset.asset_identifier, asset.asset_type === 'WILDCARD'])),
      firstResponseH: hours(sla.average_time_to_first_program_response ?? program.average_time_to_first_program_response),
      bountyH: hours(sla.average_time_to_bounty_awarded ?? program.average_time_to_bounty_awarded),
      resolveH: hours(sla.average_time_to_report_resolved ?? program.average_time_to_report_resolved),
      efficiency: Number.isInteger(program.response_efficiency_percentage) ? program.response_efficiency_percentage : null,
      reports90: Number.isInteger(team.reports_received_last_90_days) ? team.reports_received_last_90_days : null,
      paid90: pays ? amount(team.formatted_bounties_paid_last_90_days, false) : null,
      resolved: Number.isInteger(team.resolved_report_count) ? team.resolved_report_count : null,
    });
  }));
}

// --- Bugcrowd ----------------------------------------------------------------

const BUGCROWD_KIND = { website: 'web', api: 'api', ios: 'mobile', android: 'mobile', network: 'network', ip_address: 'network', hardware: 'hardware', iot: 'hardware' };

/**
 * @param {unknown} programs  bounty-targets-data's bugcrowd_data.json: the paying engagements, with scope.
 * @param {unknown} disclosure  Bugcrowd's public list of vulnerability disclosure engagements; it carries no scope.
 */
export function bugcrowd(programs, disclosure = []) {
  const paying = bugcrowdPaying(programs);
  const have = new Set(paying.map((program) => program.id));
  const open = present(list(disclosure).map((item) => {
    const slug = typeof item?.briefUrl === 'string' ? item.briefUrl.split('/').filter(Boolean).pop() : null;
    if (!slug || item.accessStatus !== 'open' || item.isPrivate === true || item.isDemo === true || have.has(`bugcrowd:${slug}`)) return null;
    return record('bugcrowd', slug, { name: item.name, url: `https://bugcrowd.com/engagements/${encodeURIComponent(slug)}`, kind: 'vdp' });
  }));
  return [...paying, ...open];
}

function bugcrowdPaying(programs) {
  return present(list(programs).map((program) => {
    const slug = typeof program?.url === 'string' ? program.url.split('/').filter(Boolean).pop() : null;
    if (!slug) return null;
    const id = `bugcrowd:${slug}`;
    const max = amount(program.max_payout);
    return record('bugcrowd', slug, {
      name: program.name,
      url: program.url,
      kind: max === null ? 'vdp' : 'bounty',
      max,
      cur: max === null ? null : 'USD',
      triaged: typeof program.managed_by_bugcrowd === 'boolean' ? program.managed_by_bugcrowd : null,
      ...scope(id, list(program.targets?.in_scope).map((asset) => {
        const identifier = asset?.target || asset?.uri || asset?.name;
        return [BUGCROWD_KIND[asset?.type] ?? 'other', identifier, typeof identifier === 'string' && identifier.includes('*')];
      })),
    });
  }));
}

// --- Intigriti ---------------------------------------------------------------

const INTIGRITI_KIND = { url: 'web', wildcard: 'web', android: 'mobile', ios: 'mobile', iprange: 'network', device: 'hardware' };

/**
 * @param {unknown} targets  bounty-targets-data's intigriti_data.json: scope per public program.
 * @param {unknown} programs  Intigriti's public program list: status, launch date, reward range.
 */
export function intigriti(targets, programs = []) {
  const scoped = new Map(list(targets).map((program) => [program?.id, program]));
  return present(list(programs).map((program) => {
    // Status 3 is open and confidentiality 4 is public. A program that takes an application to join is not listed.
    if (program?.status !== 3 || program.confidentialityLevel !== 4 || typeof program.programId !== 'string') return null;
    if (typeof program.companyHandle !== 'string' || typeof program.handle !== 'string') return null;
    const id = `intigriti:${program.programId}`;
    const max = amount(program.maxBounty?.value);
    const cur = typeof program.maxBounty?.currency === 'string' && /^[A-Z]{3}$/.test(program.maxBounty.currency) ? program.maxBounty.currency : null;
    const own = scoped.get(program.programId);
    return record('intigriti', program.programId, {
      name: program.name,
      url: `https://app.intigriti.com/programs/${encodeURIComponent(program.companyHandle)}/${encodeURIComponent(program.handle)}/detail`,
      kind: max === null ? 'vdp' : 'bounty',
      max: cur ? max : null,
      cur: max === null ? null : cur,
      launched: day(program.createdAt),
      lastReport: day(program.lastSubmissionAt),
      ...(own ? scope(id, list(own.targets?.in_scope).map((asset) => [INTIGRITI_KIND[asset?.type] ?? 'other', asset?.endpoint, asset?.type === 'wildcard'])) : {}),
    });
  }));
}

/** The same programs from the data set alone, as far as it describes them: for days before the board read Intigriti's own list. */
export function intigritiFromDataset(targets) {
  return present(list(targets).map((program) => {
    if (program?.status !== 'open' || program.confidentiality_level !== 'public' || typeof program.id !== 'string') return null;
    const id = `intigriti:${program.id}`;
    const max = amount(program.max_bounty?.value);
    return record('intigriti', program.id, {
      name: program.name,
      url: program.url,
      kind: max === null ? 'vdp' : 'bounty',
      max,
      cur: max === null ? null : program.max_bounty?.currency ?? null,
      ...scope(id, list(program.targets?.in_scope).map((asset) => [INTIGRITI_KIND[asset?.type] ?? 'other', asset?.endpoint, asset?.type === 'wildcard'])),
    });
  }));
}

// --- YesWeHack ---------------------------------------------------------------

const YESWEHACK_KIND = {
  'web-application': 'web', wildcard: 'web', api: 'api', 'mobile-application': 'mobile', 'mobile-application-android': 'mobile',
  'mobile-application-ios': 'mobile', 'ip-address': 'network', iot: 'hardware',
};

/**
 * @param {unknown} targets  bounty-targets-data's yeswehack_data.json: scope per program.
 * @param {unknown} programs  Items of YesWeHack's public program list: the currency of each reward grid, and its report count.
 */
export function yeswehack(targets, programs = []) {
  const listed = new Map(list(programs).map((program) => [program?.slug, program]));
  return present(list(targets).map((program) => {
    if (program?.public !== true || program.disabled === true || typeof program.id !== 'string') return null;
    const id = `yeswehack:${program.id}`;
    const own = listed.get(program.id) ?? {};
    const max = amount(program.max_bounty);
    // The reward grid is in the currency of the program's business unit: euros or dollars.
    const currency = typeof own.business_unit?.currency === 'string' && /^[A-Z]{3}$/.test(own.business_unit.currency) ? own.business_unit.currency : null;
    return record('yeswehack', program.id, {
      name: program.name,
      url: `https://yeswehack.com/programs/${encodeURIComponent(program.id)}`,
      kind: max === null ? 'vdp' : 'bounty',
      // Without the currency the figure says nothing, so it is left out.
      max: currency ? max : null,
      cur: max === null ? null : currency,
      triaged: typeof program.managed === 'boolean' ? program.managed : null,
      reports: Number.isInteger(own.reports_count) ? own.reports_count : null,
      ...scope(id, list(program.targets?.in_scope).map((asset) => [YESWEHACK_KIND[asset?.type] ?? 'other', asset?.target, asset?.type === 'wildcard'])),
    });
  }));
}

// --- Immunefi ----------------------------------------------------------------

const IMMUNEFI_KIND = { smart_contract: 'contract', blockchain_dlt: 'chain', websites_and_applications: 'web' };

/** @param {string} today 'YYYY-MM-DD': a competition that has ended is left out. */
export function immunefi(programs, today) {
  return present(list(programs).map((program) => {
    if (typeof program?.slug !== 'string' || program.isPaused === true) return null;
    const contest = typeof program.endDate === 'string';
    const ends = day(program.endDate);
    if (contest && (!ends || ends < today)) return null;
    const id = `immunefi:${program.slug}`;
    const features = list(program.features);
    const assets = list(program.assets).filter((asset) => typeof asset?.url === 'string');
    const scoped = scope(id, assets.map((asset) => [IMMUNEFI_KIND[asset.type] ?? 'other', asset.url, false]));
    const assetDates = {};
    for (const asset of assets) {
      const added = day(asset.addedAt);
      if (added) assetDates[assetKey(id, asset.url)] ??= added;
    }
    const slug = encodeURIComponent(program.slug);
    return record('immunefi', program.slug, {
      // A competition is listed as "Audit Competition | Name" or "Audit Comp | Name".
      name: contest ? String(program.project ?? '').replace(/^Audit Comp(?:etition)?\s*\|\s*/i, '') : program.project,
      url: contest ? `https://immunefi.com/audit-competition/${slug}/information/` : `https://immunefi.com/bug-bounty/${slug}/information/`,
      kind: contest ? 'contest' : 'bounty',
      max: amount(program.maxBounty),
      cur: amount(program.maxBounty) === null ? null : 'USD',
      launched: day(program.launchDate),
      // Immunefi marks a program "Pay to Submit"; the amount is shown at submission.
      cost: features.includes('Pay to Submit') ? { type: 'fee', amount: null, cur: null } : null,
      kyc: typeof program.kyc === 'boolean' ? program.kyc : null,
      poc: Array.isArray(program.pocPerTypeAndSeverity) ? program.pocPerTypeAndSeverity.length > 0 : null,
      triaged: features.some((feature) => typeof feature === 'string' && feature.startsWith('Managed Triage')),
      invite: program.inviteOnly === true,
      ...scoped,
      assetDates,
      ...(contest ? { starts: day(program.launchDate), ends, pool: amount(program.rewardsPool) ?? amount(program.maxBounty) } : {}),
    });
  }));
}

// --- Cantina -----------------------------------------------------------------

/** @param {unknown} payload  { items } of Cantina's public opportunities list. */
export function cantina(payload, today) {
  return present(list(payload?.items).map((item) => {
    const contest = item?.kind === 'public_contest';
    if ((item?.kind !== 'public_bounty' && !contest) || typeof item.id !== 'string') return null;
    const ends = day(item.timeframe?.end);
    // A bounty is open while it is live; a competition while it has not ended.
    if (contest ? !ends || ends < today || item.status !== 'live' : item.status !== 'live') return null;
    const id = `cantina:${item.id}`;
    const groups = list(item.assetGroups).filter((group) => group && group.outOfScope !== true && group.hidden !== true);
    const rows = groups.flatMap((group) => list(group.assets).filter((asset) => asset && asset.hidden !== true)
      .map((asset) => [/contract/i.test(String(group.name)) ? 'contract' : 'other', asset.id ?? asset.name, false]));
    const fee = amount(item.submissionFee);
    const pot = amount(item.totalRewardPot);
    return record('cantina', item.id, {
      name: item.name,
      url: item.url,
      kind: contest ? 'contest' : 'bounty',
      max: pot,
      // Cantina names the reward token (USDC, mostly); the figure is in dollars of it.
      cur: pot === null ? null : 'USD',
      launched: day(item.timeframe?.start) ?? day(item.createdAt),
      cost: fee === null ? null : { type: 'fee', amount: fee, cur: 'USD' },
      kyc: typeof item.kycRequired === 'boolean' ? item.kycRequired : null,
      triaged: typeof item.cantinaTriaged === 'boolean' ? item.cantinaTriaged : null,
      findings: Number.isInteger(item.totalFindings) ? item.totalFindings : null,
      ...(rows.length ? scope(id, rows) : {}),
      ...(contest ? { starts: day(item.timeframe?.start), ends, pool: pot } : {}),
    });
  }));
}

// --- Sherlock ----------------------------------------------------------------

/**
 * @param {unknown[]} bounties  Items of Sherlock's public bug bounty list.
 * @param {unknown[]} contests  Items of its public contest list.
 */
export function sherlock(bounties, contests, today) {
  const open = list(bounties).map((item) => {
    if (!Number.isInteger(item?.id) || item.is_ready === false) return null;
    const max = amount(item.payout);
    // Sherlock asks for a deposit with a report, set per severity; the board shows the lowest.
    const deposits = list(item.severities).map((severity) => amount(severity?.deposit_amount)).filter((value) => value !== null);
    return record('sherlock', `bounty-${item.id}`, {
      name: item.title,
      url: `https://audits.sherlock.xyz/bug-bounties/${item.id}`,
      kind: 'bounty',
      max,
      cur: max === null ? null : 'USD',
      launched: day(item.live_since),
      cost: deposits.length ? { type: 'deposit', amount: Math.min(...deposits), cur: 'USD' } : null,
    });
  });
  const live = list(contests).map((item) => {
    if (!Number.isInteger(item?.id) || item.private === true || item.status === 'FINISHED') return null;
    const ends = day(item.ends_at);
    if (!ends || ends < today) return null;
    const pool = amount(item.prize_pool);
    return record('sherlock', `contest-${item.id}`, {
      name: item.title,
      url: `https://audits.sherlock.xyz/contests/${item.id}`,
      kind: 'contest',
      max: pool,
      cur: pool === null ? null : 'USD',
      launched: day(item.starts_at),
      starts: day(item.starts_at),
      ends,
      pool,
    });
  });
  return present([...open, ...live]);
}

// --- Code4rena ---------------------------------------------------------------

/** @param {unknown} payload  { data: { audits } } of Code4rena's public audit list. */
export function code4rena(payload, today) {
  return present(list(payload?.data?.audits).map((audit) => {
    if (typeof audit?.slug !== 'string' || audit.codeAccess !== 'public') return null;
    const ends = day(audit.endTime);
    if (!ends || ends < today) return null;
    // "$22,000 in USDC": the pool as Code4rena prints it.
    const printed = typeof audit.formattedAmount === 'string' ? /^\$([\d,]+(?:\.\d+)?)\b/.exec(audit.formattedAmount) : null;
    const pool = printed ? amount(printed[1].replaceAll(',', '')) : null;
    return record('code4rena', audit.slug, {
      name: audit.title,
      url: `https://code4rena.com/audits/${encodeURIComponent(audit.slug)}`,
      kind: 'contest',
      max: pool,
      cur: pool === null ? null : 'USD',
      launched: day(audit.startTime),
      poc: typeof audit.hasMandatoryProofOfConcept === 'boolean' ? audit.hasMandatoryProofOfConcept : null,
      starts: day(audit.startTime),
      ends,
      pool,
    });
  }));
}

export const ASSET_KIND_IDS = KINDS;
