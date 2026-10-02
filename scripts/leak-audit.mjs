#!/usr/bin/env node
// Leak audit: fails when text of the hosted method shows up anywhere it may
// not be. Run it before every commit, push, deploy, tarball and benchmark
// publication.
//
//   node scripts/leak-audit.mjs                                  the repository, web/public and the MCP download
//   node scripts/leak-audit.mjs --base-url http://localhost:8787  also the Worker's public JSON responses
//   node scripts/leak-audit.mjs --show                            print the matched words (keep that output private)
//
// How it works. The hosted method lives in web/private/operator-profiles.mjs,
// which git ignores. This script holds none of it. At run time it loads that
// module, cuts every instruction and output format into runs of eight words,
// and looks for each run in:
//   1. every file git tracks or would track (tracked, plus untracked and not ignored);
//   2. everything under web/public, ignored or not, because all of it is served;
//   3. the contents of every MCP tarball, and the files the next tarball is packed from;
//   4. with --base-url, what the Worker answers to anyone: /api/health,
//      /api/profiles, /api/account and every tool and prompt of /api/mcp.
// Words are compared in lower case with punctuation removed, so a quoted,
// re-wrapped or bulleted copy is found too. Each text is read twice: as it
// is, and with HTML tags and entities blanked, so a copy on a page is found
// with its markup between the words. One matching run fails the audit.
// Nothing is excluded except web/private itself.
//
// Without the private module there is nothing to compare against: the script
// says so and exits 0. A checkout that never had the method cannot leak it.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_DIR = join(ROOT, 'web', 'private');
const PRIVATE_MODULE = join(PRIVATE_DIR, 'operator-profiles.mjs');
const SHINGLE_WORDS = 8;
const WORD = /[\p{L}\p{N}]+/gu;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const posix = (path) => path.split(sep).join('/');
const repoPath = (path) => posix(relative(ROOT, path));

/** The words of a text with their offsets: lower case, letters and digits only. */
function wordsOf(text) {
  const list = [];
  for (const match of text.matchAll(WORD)) list.push({ word: match[0].toLowerCase(), at: match.index });
  return list;
}

/** Every eight-word run of the private module, mapped to the profile it belongs to. */
export async function privateShingles() {
  const module = await import(pathToFileURL(PRIVATE_MODULE).href);
  const profiles = module.OPERATOR_PROFILES;
  if (!profiles || typeof profiles !== 'object') throw new Error('The private module does not export OPERATOR_PROFILES.');

  const shingles = new Map();
  for (const [id, method] of Object.entries(profiles)) {
    for (const text of [method.instructions, method.extraFormat]) {
      const list = wordsOf(String(text ?? '')).map((entry) => entry.word);
      for (let index = 0; index + SHINGLE_WORDS <= list.length; index += 1) {
        const key = list.slice(index, index + SHINGLE_WORDS).join(' ');
        if (!shingles.has(key)) shingles.set(key, id);
      }
    }
  }
  return shingles;
}

/** `text` with every HTML tag and entity replaced by spaces of the same length, so offsets and lines stay put. */
function withoutMarkup(text) {
  const blank = (match) => match.replace(/[^\n]/g, ' ');
  return text.replace(/<\/?[A-Za-z][^<>]{0,400}>/g, blank).replace(/&(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,30});/g, blank);
}

/**
 * The matching runs in one text: [{ profile, line, words, text }], merged
 * where they overlap. The text is read as it is and, when it holds markup,
 * once more with the markup blanked.
 */
export function hitsIn(text, shingles) {
  const plain = runsIn(text, shingles);
  if (!/[<&]/.test(text)) return plain;
  const seen = new Set(plain.map((hit) => `${hit.line}:${hit.text}`));
  const stripped = runsIn(withoutMarkup(text), shingles).filter((hit) => !seen.has(`${hit.line}:${hit.text}`));
  return [...plain, ...stripped].sort((a, b) => a.line - b.line);
}

function runsIn(text, shingles) {
  const list = wordsOf(text);
  const hits = [];
  let open = null;
  for (let index = 0; index + SHINGLE_WORDS <= list.length; index += 1) {
    const key = list.slice(index, index + SHINGLE_WORDS).map((entry) => entry.word).join(' ');
    const profile = shingles.get(key);
    if (!profile) {
      open = null;
      continue;
    }
    if (open && open.last === index - 1) {
      open.last = index;
      open.words += 1;
    } else {
      open = { profile, first: index, last: index, words: SHINGLE_WORDS };
      hits.push(open);
    }
  }
  return hits.map((hit) => ({
    profile: hit.profile,
    line: text.slice(0, list[hit.first].at).split('\n').length,
    words: hit.words,
    text: list.slice(hit.first, hit.first + hit.words).map((entry) => entry.word).join(' '),
  }));
}

function field(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** The regular files of a .tgz as [path, bytes] pairs. */
function tarEntries(tgz) {
  const tar = gunzipSync(tgz);
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    longName = null;
    if (type === 'x') longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
    else if (type === '0' || type === '\0') entries.push([name, Buffer.from(body)]);
  }
  return entries;
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      found.push(...(await walk(path)));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/** Tracked files plus untracked files git would add. */
function gitFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean).map((path) => join(ROOT, path));
}

function inPrivate(path) {
  return path === PRIVATE_DIR || path.startsWith(PRIVATE_DIR + sep);
}

export async function auditFiles(shingles, show) {
  const seen = new Set();
  const failures = [];
  let scanned = 0;

  async function scanBytes(label, bytes) {
    scanned += 1;
    // Binary files are read as text too: a method pasted into one would still be found.
    for (const hit of hitsIn(bytes.toString('utf8'), shingles)) failures.push({ where: label, ...hit });
    if (/\.t(?:ar\.)?gz$/i.test(label)) {
      let entries = [];
      try {
        entries = tarEntries(bytes);
      } catch {
        failures.push({ where: label, profile: '-', line: 0, words: 0, text: '', note: 'the archive could not be read, so its contents are unchecked' });
      }
      for (const [name, body] of entries) await scanBytes(`${label} > ${name}`, body);
    }
  }

  async function scanPath(path, group) {
    if (inPrivate(path) || seen.has(path)) return;
    seen.add(path);
    let info;
    try {
      info = await stat(path);
    } catch {
      return; // tracked and deleted in the working tree
    }
    if (!info.isFile()) return;
    if (info.size > MAX_FILE_BYTES) {
      failures.push({ where: `${group}: ${repoPath(path)}`, profile: '-', line: 0, words: 0, text: '', note: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, so it is unchecked` });
      return;
    }
    await scanBytes(`${group}: ${repoPath(path)}`, await readFile(path));
  }

  for (const path of gitFiles()) await scanPath(path, 'git');
  for (const path of await walk(join(ROOT, 'web', 'public'))) await scanPath(path, 'served');
  // What the next MCP tarball is packed from, and any tarball lying in mcp/.
  for (const directory of ['bin', 'src', 'lib']) {
    for (const path of await walk(join(ROOT, 'mcp', directory))) await scanPath(path, 'mcp package');
  }
  for (const name of ['package.json', 'README.md', 'server.json', 'LICENSE']) await scanPath(join(ROOT, 'mcp', name), 'mcp package');
  for (const path of await walk(join(ROOT, 'mcp'))) {
    if (/\.t(?:ar\.)?gz$/i.test(path)) await scanPath(path, 'mcp package');
  }

  if (show) for (const failure of failures) failure.shown = failure.text;
  return { failures, scanned };
}

export async function auditWorker(base, shingles) {
  const failures = [];
  let scanned = 0;
  const { PROFILES } = await import(pathToFileURL(join(ROOT, 'web', 'public', 'profiles.mjs')).href);

  async function check(label, path, init) {
    let text;
    try {
      const response = await fetch(new URL(path, base), { redirect: 'manual', ...init });
      text = await response.text();
    } catch (error) {
      failures.push({ where: `worker: ${label}`, profile: '-', line: 0, words: 0, text: '', note: `no answer (${error instanceof Error ? error.message : 'request failed'}), so it is unchecked` });
      return null;
    }
    scanned += 1;
    // JSON escapes line breaks and quotes; compare the decoded strings as well as the raw body.
    let decoded = '';
    try {
      const strings = [];
      JSON.stringify(JSON.parse(text), (_key, value) => {
        if (typeof value === 'string') strings.push(value);
        return value;
      });
      decoded = strings.join('\n');
    } catch {
      decoded = '';
    }
    for (const hit of hitsIn(`${text}\n${decoded}`, shingles)) failures.push({ where: `worker: ${label}`, ...hit });
    return text;
  }

  const rpc = (id, method, params) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const files = [{ name: 'src/Vault.sol', content: 'contract Vault {\n  function withdraw() external {}\n}\n' }];

  for (const path of ['/api/health', '/api/profiles', '/api/account']) await check(`GET ${path}`, path);
  await check('mcp initialize', '/api/mcp', rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'leak-audit', version: '1' } }));
  await check('mcp tools/list', '/api/mcp', rpc(2, 'tools/list', {}));
  const prompts = await check('mcp prompts/list', '/api/mcp', rpc(3, 'prompts/list', {}));
  let promptNames = [];
  try {
    promptNames = JSON.parse(prompts).result.prompts.map((prompt) => prompt.name);
  } catch {
    promptNames = ['challenge-report', 'solidity-review', 'gauntlet'];
  }
  for (const name of promptNames) await check(`mcp prompts/get ${name}`, '/api/mcp', rpc(4, 'prompts/get', { name }));
  await check('mcp list_profiles', '/api/mcp', rpc(5, 'tools/call', { name: 'list_profiles', arguments: {} }));
  for (const profile of PROFILES) {
    await check(`mcp prepare_review ${profile.id}`, '/api/mcp', rpc(6, 'tools/call', { name: 'prepare_review', arguments: { files, profile: profile.id } }));
  }
  // Calls that need an account answer with an error body. That body is public too.
  await check('mcp run_review without a token', '/api/mcp', rpc(7, 'tools/call', { name: 'run_review', arguments: { files, provider: 'openrouter', profile: 'scope' } }));
  await check('POST /api/client/review without a token', '/api/client/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, profile: 'verdict', provider: 'openrouter' }),
  });
  return { failures, scanned };
}

function report(title, { failures, scanned }) {
  if (!failures.length) {
    console.log(`${title}: clean (${scanned} checked).`);
    return 0;
  }
  console.error(`${title}: ${failures.length} problem${failures.length === 1 ? '' : 's'} in ${scanned} checked.`);
  for (const failure of failures) {
    if (failure.note) console.error(`  ${failure.where}: ${failure.note}`);
    else console.error(`  ${failure.where}:${failure.line}  ${failure.words} words of the ${failure.profile} method${failure.shown ? `  "${failure.shown}"` : ''}`);
  }
  return failures.length;
}

async function main(argv) {
  const baseIndex = argv.indexOf('--base-url');
  const baseUrl = baseIndex === -1 ? null : argv[baseIndex + 1];
  const show = argv.includes('--show');

  if (!existsSync(PRIVATE_MODULE)) {
    console.log('Leak audit: no private module in this checkout (web/private/operator-profiles.mjs), so there is no hosted text to look for.');
    return 0;
  }
  if (baseIndex !== -1 && !/^https?:\/\//.test(baseUrl ?? '')) {
    console.error('--base-url needs an address, such as http://localhost:8787.');
    return 2;
  }

  const shingles = await privateShingles();
  console.log(`Leak audit: ${shingles.size} eight-word runs from the private module.`);

  let problems = report('Files', await auditFiles(shingles, show));
  if (baseUrl) problems += report(`Worker at ${baseUrl}`, await auditWorker(baseUrl, shingles));
  else console.log('Worker responses: not checked. Pass --base-url to check them.');

  if (problems) {
    console.error('Leak audit FAILED. Remove the text from every place listed, or reword the private method, then run the audit again. --show prints the matched words.');
    return 1;
  }
  console.log('Leak audit passed.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
