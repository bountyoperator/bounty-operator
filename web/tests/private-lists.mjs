// The strings this repository must not spell, read from two lists git ignores.
//
// A pattern in a test file would publish the very name it guards, so no test
// holds one. The lists live outside the repository's history:
//
//   .local/private-names.txt   one string per line, matched as a whole word in
//                              any case. No file git would publish spells one.
//   .local/copy-banlist.txt    one regular expression per line, matched in any
//                              case; write /pattern/flags to choose the flags.
//                              "allow=/terms,/privacy" after a pattern permits
//                              it on those pages and nowhere else.
//
// In both, a line that starts with # is a note. A checkout without a list has
// nothing to compare against: the readers return an empty array, the
// assertions below pass without looking, and the scanning tests are skipped.
//
// A failure names the text that was checked and the position of the entry in
// its list. It never prints the entry.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NAMES_LIST = '.local/private-names.txt';
export const COPY_LIST = '.local/copy-banlist.txt';

function entries(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** The entries of the private-name list, or an empty array when this checkout has none. */
export function privateNames(file = path.join(REPO_DIR, NAMES_LIST)) {
  return entries(file);
}

/** A whole-word, any-case pattern for one private name. */
export function namePattern(entry) {
  const literal = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * One line of the copy ban list as `{ pattern, allow }`.
 *
 * @param {string} line
 * @returns {{ pattern: RegExp, allow: string[] }}
 */
export function parseBan(line) {
  const allowed = /^(.*?)\s+allow=(\S+)$/.exec(line);
  const source = (allowed ? allowed[1] : line).trim();
  const allow = allowed ? allowed[2].split(',').filter(Boolean) : [];
  const explicit = /^\/(.+)\/([a-z]*)$/.exec(source);
  const pattern = explicit ? new RegExp(explicit[1], explicit[2].replace(/[gy]/g, '')) : new RegExp(source, 'i');
  return { pattern, allow };
}

/** The entries of the copy ban list, or an empty array when this checkout has none. */
export function copyBans(file = path.join(REPO_DIR, COPY_LIST)) {
  return entries(file).map(parseBan);
}

/**
 * The page a repository file belongs to, for the `allow=` of a copy ban: the
 * built page and the module it is built from. '' for every other file.
 *
 * @param {string} file  Repo-relative path with forward slashes.
 */
export function pageOf(file) {
  const built = /^web\/public\/(.+)\.html$/.exec(file);
  if (built) return `/${built[1]}`;
  const source = /^web\/site\/pages\/(?:[^/]+\/)*([^/]+)\.mjs$/.exec(file);
  return source ? `/${source[1]}` : '';
}

const NAME_PATTERNS = privateNames().map(namePattern);
const COPY_BANS = copyBans();

/** True when this checkout has at least one of the two lists. */
export const HAS_LISTS = NAME_PATTERNS.length > 0 || COPY_BANS.length > 0;

/**
 * What `text` spells that it must not, as positions in the lists:
 * 'private name 3', 'copy ban 1'. Empty when the text is clean, and always
 * empty in a checkout without the lists.
 *
 * @param {string} text
 * @param {{ page?: string }} [options]  `page` is the page path the text belongs to, such as '/terms'.
 * @returns {string[]}
 */
export function bannedIn(text, { page = '' } = {}) {
  const value = String(text);
  const hits = [];
  NAME_PATTERNS.forEach((pattern, index) => {
    if (pattern.test(value)) hits.push(`private name ${index + 1}`);
  });
  COPY_BANS.forEach((ban, index) => {
    if (page && ban.allow.includes(page)) return;
    if (ban.pattern.test(value)) hits.push(`copy ban ${index + 1}`);
  });
  return hits;
}

/**
 * Fails when `text` spells a private name or matches a copy ban. `label`
 * says what was checked; the failure adds the position of each entry.
 *
 * @param {string} text
 * @param {string} label
 * @param {{ page?: string }} [options]
 */
export function assertNoBannedNames(text, label, options) {
  assert.deepEqual(bannedIn(text, options), [], `${label} spells an entry of a private list`);
}
