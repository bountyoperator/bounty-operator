// Pre-publish check: run the workbench's privacy scanner over a set of files
// and list every hit as file:line and kind.
//
// Pure functions. The scanner (checkInputs in review-core.mjs) never returns
// the text it matched, and nothing here reads it back out of the file.

import { LIMITS, checkInputs, describeFinding, splitLines, validName } from '../review-core.mjs';

/**
 * @typedef {{ name: string, content: string }} InputFile
 * @typedef {{ line: number, kind: string, label: string, severity: 'block' | 'warn' }} Hit
 * @typedef {{ name: string, status: 'clean' | 'block' | 'warn' | 'skipped', hits: Hit[], blocking: number, warnings: number, reason: string }} FileResult
 * @typedef {{ files: FileResult[], totals: { files: number, scanned: number, skipped: number, flagged: number, blocking: number, warnings: number } }} Scan
 */

// Text is scanned in pieces that stay under the scanner's per-file limits (120 KB
// and 20,000 lines), so a long trace or log is covered in full.
const PIECE_BYTES = 90_000;
const PIECE_CHARS = 30_000;
const PIECE_LINES = 10_000;

function scannerName(name, position) {
  if (validName(name)) return name;
  const base = String(name).replaceAll('\\', '/').split('/').pop();
  return validName(base) ? base : `file-${position}.txt`;
}

/** Splits text into pieces under the scanner limit; each carries the number of the line it starts on. */
function* pieces(text) {
  const lines = splitLines(text);
  let buffer = [];
  let size = 0;
  let start = 0;

  const flush = function* flush(nextStart) {
    if (buffer.length) yield { text: buffer.join('\n'), offset: start };
    buffer = [];
    size = 0;
    start = nextStart;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // UTF-8 never needs more than three bytes per UTF-16 unit.
    const bytes = line.length * 3 + 1;
    if (bytes > PIECE_BYTES) {
      yield* flush(index);
      // One very long line: overlapping slices, all reported on the same line number.
      for (let at = 0; at < line.length; at += PIECE_CHARS - 200) {
        yield { text: line.slice(at, at + PIECE_CHARS), offset: index };
      }
      start = index + 1;
      continue;
    }
    if (size + bytes > PIECE_BYTES || buffer.length >= PIECE_LINES) yield* flush(index);
    buffer.push(line);
    size += bytes;
  }
  yield* flush(lines.length);
}

function labelOf(finding) {
  const described = describeFinding(finding);
  return described.slice(described.lastIndexOf(' · ') + 3);
}

/**
 * Scans one file.
 *
 * @param {InputFile} file
 * @param {number} [position] 1-based position in the set, used when the name has to be withheld
 * @returns {FileResult}
 */
export function scanFile(file, position = 1) {
  const result = { name: file.name, status: 'clean', hits: [], blocking: 0, warnings: 0, reason: '' };
  const name = scannerName(file.name, position);
  const seen = new Set();

  const add = (finding, offset) => {
    const line = finding.line > 0 ? finding.line + offset : 0;
    const key = `${line}:${finding.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.hits.push({ line, kind: finding.kind, label: labelOf(finding), severity: finding.severity });
    // A name that holds a secret is never shown.
    if (finding.name.endsWith('(name withheld)')) result.name = `file ${position} (name withheld)`;
  };

  try {
    // The name is scanned even when the file is empty.
    let scanned = false;
    for (const piece of pieces(file.content)) {
      const coverage = checkInputs([{ name, content: piece.text }]);
      for (const finding of coverage.findings) {
        if (scanned && finding.line === 0) continue;
        add(finding, piece.offset);
      }
      scanned = true;
    }
    if (!scanned) {
      for (const finding of checkInputs([{ name, content: '' }]).findings) add(finding, 0);
    }
  } catch (error) {
    result.status = 'skipped';
    result.hits = [];
    result.reason = /Binary/.test(String(error?.message)) ? 'Not a text file.' : 'Could not be read as text.';
    // A skipped file is still listed by name, so a name that holds a secret is withheld here too.
    try {
      if (checkInputs([{ name, content: '' }]).findings.some((finding) => finding.name.endsWith('(name withheld)'))) {
        result.name = `file ${position} (name withheld)`;
      }
    } catch {
      result.name = `file ${position}`;
    }
    return result;
  }

  result.hits.sort((a, b) => a.line - b.line);
  result.blocking = result.hits.filter((hit) => hit.severity === 'block').length;
  result.warnings = result.hits.length - result.blocking;
  result.status = result.blocking ? 'block' : result.warnings ? 'warn' : 'clean';
  return result;
}

/**
 * Scans a set of files, each on its own, so one large or binary file never
 * stops the rest from being checked.
 *
 * @param {InputFile[]} files
 * @returns {Scan}
 */
export function scanFiles(files) {
  const results = files.map((file, index) => scanFile(file, index + 1));
  const sum = (key) => results.reduce((total, file) => total + file[key], 0);
  return {
    files: results,
    totals: {
      files: results.length,
      scanned: results.filter((file) => file.status !== 'skipped').length,
      skipped: results.filter((file) => file.status === 'skipped').length,
      flagged: results.filter((file) => file.status === 'block' || file.status === 'warn').length,
      blocking: sum('blocking'),
      warnings: sum('warnings'),
    },
  };
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 blocking, 1 warning in 2 of 5 files" */
export function scanSummary(scan) {
  const { totals } = scan;
  if (!totals.files) return 'No files scanned.';
  const scope = count(totals.scanned, 'file');
  if (!totals.blocking && !totals.warnings) return `Nothing found in ${scope}.`;
  return `${totals.blocking} blocking, ${count(totals.warnings, 'warning')} in ${totals.flagged} of ${scope}.`;
}

export function hitLocation(file, hit) {
  return hit.line > 0 ? `${file.name}:${hit.line}` : file.name;
}

/**
 * The hits as a Markdown list: location and kind, never the matched text.
 *
 * @param {Scan} scan
 * @returns {string}
 */
export function scanMarkdown(scan) {
  const out = ['# Pre-publish check', '', scanSummary(scan), ''];
  for (const file of scan.files) {
    for (const hit of file.hits) {
      out.push(`- ${hit.severity === 'block' ? 'BLOCK' : 'WARN'} \`${hitLocation(file, hit).replaceAll('`', "'")}\` ${hit.label}`);
    }
  }
  const skipped = scan.files.filter((file) => file.status === 'skipped');
  if (skipped.length) out.push('', `Not scanned: ${skipped.map((file) => file.name).join(', ')}`);
  out.push('', 'Scanned in the browser at https://bountyoperator.com/tools/secret-check');
  return `${out.join('\n')}\n`;
}

/**
 * The files for a workbench handoff, or null when the set would be refused
 * there: a blocking hit, too many files, or more text than a review accepts.
 *
 * @param {InputFile[]} files
 * @param {Scan} scan
 */
export function workbenchHandoff(files, scan) {
  if (!files.length || scan.totals.blocking > 0 || scan.totals.skipped > 0 || files.length > LIMITS.files) return null;
  // The workbench runs this same call before a review. A set it throws on
  // (too large, too many lines, a name it cannot take) is not handed over.
  try {
    if (checkInputs(files.map((file) => ({ name: file.name, content: file.content }))).blocking > 0) return null;
  } catch {
    return null;
  }
  return {
    files: files.map((file) => ({ name: file.name, content: file.content })),
    profile: 'poc',
    focus: 'Review this proof before it is published. Say which steps run production code, which are mocked, and what the final assertion reads.',
    context: {},
  };
}
