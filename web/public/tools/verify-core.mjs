// Packet verifier: read the file list out of a review packet or a manifest,
// hash the supplied files again and compare.
//
// Pure functions. Hashing goes through manifestFor, the same function the
// workbench uses when it writes the manifest, so both sides hash the same bytes.

import { manifestFor } from '../review-core.mjs';

/**
 * @typedef {{ label: string, name: string, bytes: number | null, lines: number | null, sha256: string }} Entry
 * @typedef {{ kind: 'packet' | 'manifest', entries: Entry[], details: { created?: string, profile?: string, verdict?: string } }} ManifestSource
 * @typedef {{ name: string, content: string, bom?: boolean }} SuppliedFile
 * @typedef {'match' | 'normalised' | 'mismatch' | 'missing'} RowStatus
 * @typedef {{ label: string, name: string, status: RowStatus, expected: string, actual: string | null, expectedBytes: number | null, actualBytes: number | null, supplied: string | null, note: string }} Row
 * @typedef {{ rows: Row[], extras: string[], counts: Record<RowStatus, number>, total: number }} Verification
 */

export const STATUS_LABELS = Object.freeze({
  match: 'Match',
  normalised: 'Matches after line-ending normalisation',
  mismatch: 'Mismatch',
  missing: 'Missing',
});

const SHA256 = /^[0-9a-f]{64}$/i;
// "- input-1/src/Vault.sol · 4210 bytes · 179 lines · SHA-256 <hex>" (packets since v0.7)
const ROW = /^- (.+) · (\d+) bytes(?: · (\d+) lines)? · SHA-256 ([0-9a-fA-F]{64})\s*$/;
// "- input-1/Vault.sol: 4210 bytes; SHA-256 <hex>" (packets up to v0.6)
const LEGACY_ROW = /^- (.+): (\d+) bytes; SHA-256 ([0-9a-fA-F]{64})\s*$/;
const FILES_HEADING = /^## (?:Files|Checked files)\s*$/;
const HEADER_FIELD = /^(Created|Profile|Review profile|Verdict): (.+)$/;

/** A packet escapes a few characters in each label so the row stays one line of plain Markdown. */
function unescapeLabel(label) {
  return label.replaceAll('!\\[', '![').replaceAll(']\\:', ']:').replaceAll('&lt;', '<');
}

function entry(label, bytes, lines, sha256) {
  const clean = unescapeLabel(String(label).trim());
  return {
    label: clean,
    name: clean.replace(/^input-\d+\//, ''),
    bytes: Number.isFinite(bytes) ? bytes : null,
    lines: Number.isFinite(lines) ? lines : null,
    sha256: sha256.toLowerCase(),
  };
}

function rowEntry(line) {
  const row = line.match(ROW);
  if (row) return entry(row[1], Number(row[2]), row[3] === undefined ? NaN : Number(row[3]), row[4]);
  const legacy = line.match(LEGACY_ROW);
  if (legacy) return entry(legacy[1], Number(legacy[2]), NaN, legacy[3]);
  return null;
}

function parsePacket(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const details = {};
  for (const line of lines.slice(0, 16)) {
    const field = line.match(HEADER_FIELD);
    if (!field) continue;
    const key = field[1] === 'Review profile' ? 'profile' : field[1].toLowerCase();
    details[key] ??= field[2].trim();
  }

  const start = lines.findIndex((line) => FILES_HEADING.test(line));
  const entries = [];
  if (start !== -1) {
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith('## ')) break;
      const parsed = rowEntry(line);
      if (parsed) entries.push(parsed);
    }
  } else {
    // A packet pasted without its headings still carries the rows.
    for (const line of lines) {
      const parsed = rowEntry(line);
      if (parsed) entries.push(parsed);
    }
  }
  return { kind: 'packet', entries, details };
}

function parseJsonManifest(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.manifest) ? data.manifest : Array.isArray(data?.files) ? data.files : null;
  if (!list) return { kind: 'manifest', entries: [], details: {} };

  const entries = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const label = typeof item.label === 'string' ? item.label : typeof item.name === 'string' ? item.name : typeof item.path === 'string' ? item.path : null;
    if (!label || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) continue;
    entries.push(entry(label, Number(item.bytes), Number(item.lines), item.sha256));
  }
  return { kind: 'manifest', entries, details: {} };
}

/**
 * Reads the file list from a packet (.md) or a manifest (.json). Returns null
 * when the text holds no file hashes, so a caller can tell a manifest from an
 * ordinary source file.
 *
 * @param {string} text
 * @returns {ManifestSource | null}
 */
export function readManifest(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const trimmed = text.trimStart();
  const source = trimmed.startsWith('{') || trimmed.startsWith('[') ? parseJsonManifest(text) ?? parsePacket(text) : parsePacket(text);
  return source.entries.length ? source : null;
}

/** As readManifest, and throws a message for the page when nothing is found. */
export function parseManifest(text) {
  const source = readManifest(text);
  if (!source) {
    throw new Error('No file hashes found. Use a packet saved from the workbench, or a manifest JSON with label and sha256 fields.');
  }
  return source;
}

// ---------------------------------------------------------------------------
// Hashing and matching
// ---------------------------------------------------------------------------

const toLf = (text) => text.replace(/\r\n/g, '\n');
const toCrlf = (text) => text.replace(/\r?\n/g, '\r\n');

/** SHA-256 of the file as supplied and of each line-ending variant that differs from it. */
async function variantsOf(file) {
  const candidates = [['exact', file.content]];
  if (file.bom) candidates.push(['bom', `﻿${file.content}`]);
  const lf = toLf(file.content);
  const crlf = toCrlf(file.content);
  if (lf !== file.content) candidates.push(['lf', lf]);
  if (crlf !== file.content) candidates.push(['crlf', crlf]);
  if (file.bom && lf !== file.content) candidates.push(['lf', `﻿${lf}`]);
  if (file.bom && crlf !== file.content) candidates.push(['crlf', `﻿${crlf}`]);

  const hashed = await manifestFor(candidates.map(([, content]) => ({ name: file.name, content })));
  return candidates.map(([kind], index) => ({ kind, sha256: hashed[index].sha256, bytes: hashed[index].bytes }));
}

const normalPath = (name) => String(name).replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');

/** How many trailing path segments two names share; 0 when the file names differ. */
function sharedSuffix(a, b) {
  const left = normalPath(a).split('/');
  const right = normalPath(b).split('/');
  let shared = 0;
  while (shared < left.length && shared < right.length && left[left.length - 1 - shared] === right[right.length - 1 - shared]) shared += 1;
  // One name must be the whole tail of the other: "src/Vault.sol" matches
  // "repo/src/Vault.sol" and "Vault.sol", never "lib/Vault.sol".
  return shared === Math.min(left.length, right.length) ? shared : 0;
}

function describeMatch(kind, suppliedName, entryName, byName) {
  const renamed = byName ? '' : ` Supplied as ${suppliedName}.`;
  if (kind === 'exact') return renamed.trim();
  if (kind === 'bom') return `Matches with the byte-order mark kept.${renamed}`;
  const direction = kind === 'lf'
    ? 'The supplied file has CRLF line endings; the manifest was made from LF.'
    : 'The supplied file has LF line endings; the manifest was made from CRLF.';
  return `${direction}${renamed}`;
}

function matchIn(candidates, expected, kinds) {
  for (const candidate of candidates) {
    const variant = candidate.variants.find((entry) => kinds.includes(entry.kind) && entry.sha256 === expected);
    if (variant) return { candidate, variant };
  }
  return null;
}

/**
 * Compares every manifest entry with the supplied files.
 *
 * match       the file hashes to the manifest value as supplied
 * normalised  it hashes to the manifest value once CRLF and LF are swapped
 * mismatch    a file with that name was supplied and its content differs
 * missing     no supplied file has that name or that hash
 *
 * @param {Entry[]} entries
 * @param {SuppliedFile[]} files
 * @returns {Promise<Verification>}
 */
export async function verifyFiles(entries, files) {
  const supplied = await Promise.all(files.map(async (file) => ({ file, variants: await variantsOf(file), used: false })));
  const rows = [];

  for (const item of entries) {
    const named = supplied
      .map((candidate) => ({ candidate, shared: sharedSuffix(candidate.file.name, item.name) }))
      .filter((scored) => scored.shared > 0)
      .sort((a, b) => b.shared - a.shared)
      .map((scored) => scored.candidate);

    const row = {
      label: item.label,
      name: item.name,
      status: 'missing',
      expected: item.sha256,
      actual: null,
      expectedBytes: item.bytes,
      actualBytes: null,
      supplied: null,
      note: 'No supplied file has this name or this hash.',
    };

    // Same name first; a renamed file is still found by its hash.
    const found = matchIn(named, item.sha256, ['exact', 'bom'])
      ?? matchIn(named, item.sha256, ['lf', 'crlf'])
      ?? matchIn(supplied, item.sha256, ['exact', 'bom'])
      ?? matchIn(supplied, item.sha256, ['lf', 'crlf']);

    if (found) {
      const { candidate, variant } = found;
      candidate.used = true;
      row.status = variant.kind === 'lf' || variant.kind === 'crlf' ? 'normalised' : 'match';
      row.actual = candidate.variants[0].sha256;
      row.actualBytes = candidate.variants[0].bytes;
      row.supplied = candidate.file.name;
      row.note = describeMatch(variant.kind, candidate.file.name, item.name, named.includes(candidate));
    } else if (named.length) {
      const candidate = named[0];
      candidate.used = true;
      row.status = 'mismatch';
      row.actual = candidate.variants[0].sha256;
      row.actualBytes = candidate.variants[0].bytes;
      row.supplied = candidate.file.name;
      row.note = item.bytes !== null && item.bytes !== row.actualBytes
        ? `Content differs: the manifest records ${item.bytes} bytes, the supplied file has ${row.actualBytes}.`
        : 'Content differs at the same size.';
    }
    rows.push(row);
  }

  const counts = { match: 0, normalised: 0, mismatch: 0, missing: 0 };
  for (const row of rows) counts[row.status] += 1;
  return {
    rows,
    extras: supplied.filter((candidate) => !candidate.used).map((candidate) => candidate.file.name),
    counts,
    total: rows.length,
  };
}

/** "3 of 4 files match. 1 mismatch." */
export function summaryLine(verification) {
  const { counts, total } = verification;
  const files = total === 1 ? 'file' : 'files';
  if (counts.match === total) return total === 1 ? 'The file matches the manifest.' : `All ${total} files match the manifest.`;
  const parts = [`${counts.match} of ${total} ${files} match.`];
  if (counts.normalised) parts.push(`${counts.normalised} ${counts.normalised === 1 ? 'matches' : 'match'} after line-ending normalisation.`);
  if (counts.mismatch) parts.push(`${counts.mismatch} ${counts.mismatch === 1 ? 'mismatch' : 'mismatches'}.`);
  if (counts.missing) parts.push(`${counts.missing} missing.`);
  return parts.join(' ');
}

const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('`', "'");

/**
 * The result as a Markdown table, for a submission note or a chat message.
 *
 * @param {Verification} verification
 * @param {{ checkedAt?: string }} [options]
 * @returns {string}
 */
export function verificationMarkdown(verification, { checkedAt = new Date().toISOString() } = {}) {
  const out = [
    '# Packet verification',
    '',
    summaryLine(verification),
    '',
    `Checked: ${checkedAt}`,
    '',
    '| File | Result | SHA-256 in manifest |',
    '|---|---|---|',
    ...verification.rows.map((row) => `| ${cell(row.label)} | ${STATUS_LABELS[row.status]} | \`${row.expected}\` |`),
  ];
  if (verification.extras.length) {
    out.push('', `Supplied and not in the manifest: ${verification.extras.map(cell).join(', ')}`);
  }
  out.push('', 'Recomputed in the browser at https://bountyoperator.com/tools/verify');
  return `${out.join('\n')}\n`;
}
