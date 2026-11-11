// The platforms on the board. One list for the data build (scripts/board), the
// page module and the page script, so a platform cannot be named, linked or
// counted differently in two places.
//
// `hosts` are the only hosts a program link of that platform may point to. The
// data build drops a program whose link is on another host, and the page
// script checks again before it writes a link, because the data is fetched at
// run time and names in it are written by third parties.

/**
 * @typedef {object} Platform
 * @property {string} id
 * @property {string} name
 * @property {'web2' | 'web3'} side
 * @property {string} home  The platform's public program directory.
 * @property {string[]} hosts
 * @property {string | null} template  Our report template for the platform, when there is one.
 * @property {string} source  Where the board reads the platform's programs from, in words.
 */

/** @type {readonly Platform[]} */
export const PLATFORMS = Object.freeze([
  { id: 'hackerone', name: 'HackerOne', side: 'web2', home: 'https://hackerone.com/opportunities/all', hosts: ['hackerone.com'], template: '/templates/hackerone', source: 'HackerOne’s public program directory, with scope from the open bounty-targets-data set' },
  { id: 'bugcrowd', name: 'Bugcrowd', side: 'web2', home: 'https://bugcrowd.com/engagements', hosts: ['bugcrowd.com'], template: null, source: 'the open bounty-targets-data set, read from Bugcrowd’s public engagements' },
  { id: 'intigriti', name: 'Intigriti', side: 'web2', home: 'https://www.intigriti.com/researchers/bug-bounty-programs', hosts: ['www.intigriti.com', 'app.intigriti.com'], template: null, source: 'the open bounty-targets-data set, read from Intigriti’s public programs' },
  { id: 'yeswehack', name: 'YesWeHack', side: 'web2', home: 'https://yeswehack.com/programs', hosts: ['yeswehack.com'], template: null, source: 'the open bounty-targets-data set, read from YesWeHack’s public programs' },
  { id: 'immunefi', name: 'Immunefi', side: 'web3', home: 'https://immunefi.com/bug-bounty/', hosts: ['immunefi.com'], template: '/templates/immunefi', source: 'Immunefi’s public bounty list' },
  { id: 'cantina', name: 'Cantina', side: 'web3', home: 'https://cantina.xyz/opportunities', hosts: ['cantina.xyz'], template: '/templates/cantina', source: 'Cantina’s public opportunities list' },
  { id: 'sherlock', name: 'Sherlock', side: 'web3', home: 'https://audits.sherlock.xyz/bug-bounties', hosts: ['audits.sherlock.xyz'], template: '/templates/sherlock', source: 'Sherlock’s public bug bounty and contest lists' },
  { id: 'code4rena', name: 'Code4rena', side: 'web3', home: 'https://code4rena.com/audits', hosts: ['code4rena.com'], template: null, source: 'Code4rena’s public audit list' },
]);

const BY_ID = new Map(PLATFORMS.map((platform) => [platform.id, platform]));

/** @param {string} id */
export function platform(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * A program link, when it is an https link on one of its platform's hosts;
 * otherwise null. A name or link in the data is never trusted to be what it
 * says.
 *
 * @param {string} platformId
 * @param {unknown} url
 * @returns {string | null}
 */
export function programLink(platformId, url) {
  const known = BY_ID.get(platformId);
  if (!known || typeof url !== 'string' || url.length > 300) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
  return known.hosts.includes(parsed.hostname) ? parsed.href : null;
}

/** The kinds of asset the board counts, in the order it lists them. */
export const ASSET_KINDS = Object.freeze([
  ['web', 'Web'],
  ['api', 'API'],
  ['mobile', 'Mobile'],
  ['contract', 'Smart contract'],
  ['chain', 'Blockchain'],
  ['source', 'Source code'],
  ['network', 'Network'],
  ['hardware', 'Hardware'],
  ['other', 'Other'],
]);
