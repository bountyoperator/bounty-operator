// Local document checks. A linked citation proves only that a location exists.
// Nothing in this module executes a file, visits a URL or judges a vulnerability.
import { LIMITS, manifestFor, splitLines, textBytes, validName } from '../review-core.mjs';

export const PACKET_SCHEMA = 'bounty-operator.report-evidence.v1';
export const PACKET_MAX_BYTES = LIMITS.totalBytes * 7 + 100000;

const PATH = '(?:input-\\d{1,3}(?:/[A-Za-z0-9_./-]+)?|[A-Za-z0-9_./-]+\\.[A-Za-z0-9]{1,16})';
const RANGE = '(?::L?|#L)(\\d{1,9})(?!\\d)(?:[-–—]L?(\\d{1,9})(?!\\d))?';
const REFERENCE = new RegExp(`(?<![A-Za-z0-9_./-])(${PATH})${RANGE}`, 'g');
const MORE_RANGES = /^,L?(\d{1,9})(?!\d)(?:[-–—]L?(\d{1,9})(?!\d))?/;

export const REFERENCE_STATUS = Object.freeze({
  linked: 'Line found',
  missing: 'File not attached',
  ambiguous: 'Two files match',
  range: 'Line out of range',
});

function basename(name) { return name.slice(name.lastIndexOf('/') + 1); }

/** Preserve attachment order: input-N references stay stable in the workbench. */
export function reportFiles(draft, evidence = []) {
  let name = 'draft-report.md';
  let suffix = 2;
  const names = new Set(evidence.map((file) => file.name));
  while (names.has(name)) name = `draft-report-${suffix++}.md`;
  return [...evidence.map(({ name: fileName, content }) => ({ name: fileName, content })), { name, content: draft }];
}

/** Size and filename rules only. Secret checks remain in the workbench gate. */
export function evidenceLimits(draft, evidence = []) {
  const files = reportFiles(draft, evidence);
  if (files.length > LIMITS.files) return `Keep at most ${LIMITS.files - 1} evidence files with one draft.`;
  const names = new Set();
  let bytes = 0;
  let lines = 0;
  for (const file of files) {
    if (!validName(file.name)) return `Use a relative filename for ${file.name}.`;
    if (names.has(file.name)) return `Two attachments have the same name: ${file.name}.`;
    names.add(file.name);
    let size;
    try { size = textBytes(file.content); } catch { return `${file.name} is not plain UTF-8 text.`; }
    if (size > LIMITS.fileBytes) return `${file.name} exceeds ${LIMITS.fileBytes / 1000} KB.`;
    bytes += size;
    lines += splitLines(file.content).length;
  }
  if (bytes > LIMITS.totalBytes) return `The draft and evidence exceed ${LIMITS.totalBytes / 1000} KB combined.`;
  if (lines > LIMITS.totalLines) return `The draft and evidence exceed ${LIMITS.totalLines.toLocaleString('en-US')} lines.`;
  return '';
}

/** A rejected replacement leaves the old file intact; no silent renaming. */
export function addEvidence(current, incoming, draft = '') {
  let files = current.map(({ name, content }) => ({ name, content }));
  const errors = [];
  for (const entry of incoming) {
    const file = { name: typeof entry.name === 'string' ? entry.name.replaceAll('\\', '/') : '', content: entry.content };
    const index = files.findIndex((item) => item.name === file.name);
    const next = [...files];
    if (index === -1) next.push(file);
    else next[index] = file;
    const error = evidenceLimits(draft, next);
    if (error) errors.push(error);
    else files = next;
  }
  return { files, errors };
}

function resolveFile(path, files) {
  const numbered = path.match(/^input-(\d{1,3})(?:\/(.*))?$/);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    const file = files[index];
    if (!file || (numbered[2] && file.name !== numbered[2] && !file.name.endsWith(`/${numbered[2]}`))) return [];
    return [index];
  }
  const clean = path.replace(/^\.\//, '');
  const exact = files.findIndex((file) => file.name === clean);
  if (exact !== -1) return [exact];
  if (clean.includes('/')) return [];
  return files.flatMap((file, index) => basename(file.name) === clean ? [index] : []);
}

/**
 * Read local file:line references, including Markdown #L anchors. Remote URLs
 * are counted separately and never fetched or treated as attached evidence.
 */
export function checkEvidence(draft, files = []) {
  const refs = [];
  const fileLines = files.map((file) => splitLines(file.content));
  let remoteLinks = 0;
  let omitted = 0;
  for (const [lineIndex, text] of splitLines(draft).entries()) {
    const urls = [...text.matchAll(/https?:\/\/[^\s<>"`]+/gi)].map((match) => [match.index, match.index + match[0].length]);
    remoteLinks += urls.length;
    for (const match of text.matchAll(REFERENCE)) {
      if (urls.some(([start, end]) => match.index >= start && match.index < end)) continue;
      const ranges = [[Number(match[2]), Number(match[3] ?? match[2])]];
      let tail = text.slice(match.index + match[0].length);
      for (let more = tail.match(MORE_RANGES); more; more = tail.match(MORE_RANGES)) {
        ranges.push([Number(more[1]), Number(more[2] ?? more[1])]);
        tail = tail.slice(more[0].length);
      }
      const matches = resolveFile(match[1], files);
      for (const [start, end] of ranges) {
        if (refs.length >= 500) { omitted += 1; continue; }
        const index = matches.length === 1 ? matches[0] : -1;
        const count = index < 0 ? 0 : fileLines[index].length;
        const status = matches.length === 0 ? 'missing' : matches.length > 1 ? 'ambiguous'
          : start < 1 || end < start || end > count ? 'range' : 'linked';
        refs.push({
          path: match[1], start, end, draftLine: lineIndex + 1, status,
          fileIndex: index, name: index < 0 ? null : files[index].name, lines: count,
          choices: matches.map((at) => files[at].name),
        });
      }
    }
  }
  const linked = refs.filter((ref) => ref.status === 'linked').length;
  return { refs, linked, unresolved: refs.length - linked, total: refs.length, remoteLinks, omitted };
}

/** Bounded preview; the packet still contains the complete original file. */
export function evidenceExcerpt(ref, files) {
  if (ref.status !== 'linked' || !files[ref.fileIndex]) return '';
  const lines = splitLines(files[ref.fileIndex].content);
  const end = Math.min(ref.end, ref.start + 39);
  const text = lines.slice(ref.start - 1, end).map((line, i) => `${ref.start + i}: ${line}`).join('\n');
  return `${text.slice(0, 6000)}${end < ref.end || text.length > 6000 ? '\n[Preview shortened. Original retained in attachment.]' : ''}`;
}

function plainCell(text) { return String(text).replace(/[\r\n|`]/g, ' '); }

/** No file content or draft quotations: safe to include in the local checklist. */
export function evidenceMarkdown(result, files) {
  const lines = ['## Citations', '', `${result.linked} of ${result.total} file:line citations point at a real line in the attached files.`, ''];
  for (const ref of result.refs) {
    lines.push(`- Draft L${ref.draftLine}: ${plainCell(ref.path)}:${ref.start}${ref.end !== ref.start ? `-${ref.end}` : ''} — ${REFERENCE_STATUS[ref.status]}.`);
  }
  if (!result.total) lines.push('No file:line citations found.');
  if (result.remoteLinks) lines.push(`${result.remoteLinks} external links were not opened.`);
  if (result.omitted) lines.push(`${result.omitted} more citations are not listed.`);
  lines.push('', '## Attached files', '');
  if (!files.length) lines.push('No files attached.');
  files.forEach((file, index) => lines.push(`- input-${index + 1}/${plainCell(file.name)} (${splitLines(file.content).length} lines)`));
  return `${lines.join('\n')}\n`;
}

/** A portable local packet includes originals, not only an uncheckable score. */
export async function createEvidencePacket(draft, evidence, createdAt = new Date().toISOString()) {
  const error = evidenceLimits(draft, evidence);
  if (error) throw new Error(error);
  const files = reportFiles(draft, evidence);
  return {
    schema: PACKET_SCHEMA, createdAt, draftIndex: files.length - 1,
    files, manifest: await manifestFor(files),
    note: 'Contains the original draft and attached evidence. Hashes check integrity, not authorship, correctness or eligibility.',
  };
}

/** Verify contents before restoring. Never trust a saved check result. */
export async function restoreEvidencePacket(text) {
  if (typeof text !== 'string' || textBytes(text) > PACKET_MAX_BYTES) throw new Error('This packet is too large.');
  let packet;
  try { packet = JSON.parse(text); } catch { throw new Error('This is not a valid JSON evidence packet.'); }
  if (!packet || packet.schema !== PACKET_SCHEMA || !Array.isArray(packet.files) || !packet.files.length
      || packet.files.length > LIMITS.files || packet.draftIndex !== packet.files.length - 1
      || !Array.isArray(packet.manifest) || packet.manifest.length !== packet.files.length) {
    throw new Error('This is not a supported report evidence packet.');
  }
  if (packet.files.some((file) => !file || typeof file.name !== 'string' || typeof file.content !== 'string')) {
    throw new Error('Every file in the packet needs a name and text content.');
  }
  const files = packet.files.map(({ name, content }) => ({ name, content }));
  const draftFile = files.at(-1);
  const evidence = files.slice(0, -1);
  const error = evidenceLimits(draftFile.content, evidence);
  if (error) throw new Error(error);
  // Validate the actual saved draft name as well as the generated handoff name.
  if (!validName(draftFile.name) || evidence.some((file) => file.name === draftFile.name)) throw new Error('The draft filename is invalid or repeated.');
  const actual = await manifestFor(files);
  if (actual.some((item, i) => ['label', 'bytes', 'lines', 'sha256'].some((key) => item[key] !== packet.manifest[i]?.[key]))) {
    throw new Error('A file differs from the saved checksum. The current draft and evidence were kept.');
  }
  return { draft: draftFile.content, files: evidence };
}
