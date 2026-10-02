// Packs the package and checks what went into the tarball. Shared by the
// release build (scripts/build-mcp.mjs at the repository root) and the tests.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { ENGINE_FILES, ENGINE_SOURCE, PACKAGE_ROOT, REPO_ROOT, syncEngine } from './sync-engine.mjs';

const execFileAsync = promisify(execFile);
const WINDOWS = process.platform === 'win32';

/** Every path a tarball may hold. Anything else fails the build. */
export const WHITELIST = /^package\/(?:package\.json|README\.md|LICENSE|server\.json|(?:bin|src|lib)\/[a-z][a-z0-9-]*\.mjs)$/;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Runs npm. On Windows npm is a .cmd file, which only the command interpreter can start. */
export function npm(args, options = {}) {
  const [command, prefix] = WINDOWS ? ['cmd.exe', ['/d', '/s', '/c', 'npm']] : ['npm', []];
  return execFileAsync(command, [...prefix, ...args], { maxBuffer: 16 * 1024 * 1024, ...options });
}

function field(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** The `path` record of a PAX extended header, when it has one. */
function paxPath(body) {
  const text = body.toString('utf8');
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
  return match ? match[1] : null;
}

/**
 * The regular files of a .tgz as a Map of path to bytes. Throws on an entry
 * that is not a regular file or a directory: a package holds no links.
 *
 * @param {Buffer} tgz
 * @returns {Map<string, Buffer>}
 */
export function readTarball(tgz) {
  const tar = gunzipSync(tgz);
  const files = new Map();
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

    if (type === 'x') longName = paxPath(body);
    else if (type === 'g' || type === '5') continue;
    else if (type === '0') files.set(name, Buffer.from(body));
    else throw new Error(`Tarball entry ${name} has type "${type}". Only regular files are allowed.`);
  }
  return files;
}

async function listed(directory) {
  const names = await readdir(join(PACKAGE_ROOT, directory));
  return names.map((name) => `${directory}/${name}`);
}

/** The files the tarball must hold, as paths inside the package. */
export async function expectedFiles() {
  const files = ['package.json', 'README.md', 'LICENSE', 'server.json', ...(await listed('bin')), ...(await listed('src')), ...ENGINE_FILES.map((name) => `lib/${name}`)];
  return files.sort();
}

const METHOD_RUN_WORDS = 8;
const WORD = /[\p{L}\p{N}]+/gu;
const wordsOf = (text) => (text.match(WORD) ?? []).map((word) => word.toLowerCase());

/**
 * The paths in `files` that repeat eight words in a row of a hosted method.
 * Words are compared in lower case without punctuation, as the leak audit does.
 *
 * @param {Map<string, Buffer>} files
 * @param {Record<string, { instructions: string, extraFormat: string }>} methods
 * @returns {string[]}
 */
export function hostedTextIn(files, methods) {
  const runs = new Set();
  for (const method of Object.values(methods)) {
    for (const text of [method.instructions, method.extraFormat]) {
      const list = wordsOf(String(text ?? ''));
      for (let index = 0; index + METHOD_RUN_WORDS <= list.length; index += 1) runs.add(list.slice(index, index + METHOD_RUN_WORDS).join(' '));
    }
  }

  const found = [];
  for (const [path, bytes] of files) {
    const list = wordsOf(bytes.toString('utf8'));
    for (let index = 0; index + METHOD_RUN_WORDS <= list.length; index += 1) {
      if (!runs.has(list.slice(index, index + METHOD_RUN_WORDS).join(' '))) continue;
      found.push(path);
      break;
    }
  }
  return found;
}

/** The hosted methods this checkout can run, private or stub, or null when none was selected yet. */
async function hostedMethods() {
  const generated = join(REPO_ROOT, 'web', 'src', 'operator-profiles.generated.mjs');
  try {
    await access(generated);
  } catch {
    return null;
  }
  return (await import(pathToFileURL(generated).href)).OPERATOR_PROFILES;
}

/**
 * Throws when a tarball carries the method of a hosted profile: as a field of
 * the packaged profile list, or as text in any file.
 *
 * @param {Map<string, Buffer>} files
 */
export async function assertNoHostedMethod(files) {
  // The packaged list is the file in lib/, byte for byte: verifyTarball has checked that.
  const { PROFILES } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'profiles.mjs')).href);
  const open = PROFILES.filter((profile) => !profile.hosted).map((profile) => profile.id);
  if (open.join() !== 'general,solidity,report') throw new Error(`The package ships these profiles with their method: ${open.join(', ')}. Only general, solidity and report are core profiles.`);
  for (const profile of PROFILES) {
    if (profile.hosted && (profile.instructions || profile.extraFormat)) throw new Error(`lib/profiles.mjs carries the method of the hosted profile "${profile.id}".`);
  }

  const methods = await hostedMethods();
  if (!methods) return;
  const leaking = hostedTextIn(files, methods);
  if (leaking.length) throw new Error(`The tarball repeats text of a hosted method in: ${leaking.join(', ')}.`);
}

/**
 * Checks a tarball against the whitelist, the package folder and the engine
 * source, and for text of a hosted method. Returns its files; throws with the
 * first difference.
 *
 * @param {Buffer} tgz
 * @returns {Promise<Map<string, Buffer>>}
 */
export async function verifyTarball(tgz) {
  const files = readTarball(tgz);
  const paths = [...files.keys()].sort();

  for (const path of paths) {
    if (!WHITELIST.test(path)) throw new Error(`Tarball holds ${path}, which is not on the whitelist.`);
  }
  const expected = (await expectedFiles()).map((path) => `package/${path}`);
  const missing = expected.filter((path) => !files.has(path));
  const extra = paths.filter((path) => !expected.includes(path));
  if (missing.length || extra.length) {
    throw new Error(`Tarball contents differ from the package. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${extra.join(', ') || 'none'}.`);
  }

  for (const path of expected) {
    const onDisk = await readFile(join(PACKAGE_ROOT, path.slice('package/'.length)));
    if (!onDisk.equals(files.get(path))) throw new Error(`${path} in the tarball differs from the file in mcp/.`);
  }
  for (const name of ENGINE_FILES) {
    const source = await readFile(join(ENGINE_SOURCE, name));
    if (!source.equals(files.get(`package/lib/${name}`))) throw new Error(`lib/${name} in the tarball differs from web/public/${name}.`);
  }

  const manifest = JSON.parse(files.get('package/package.json').toString('utf8'));
  if (manifest.dependencies && Object.keys(manifest.dependencies).length) {
    throw new Error('The package must install with no dependency.');
  }
  if (!files.get(`package/${manifest.bin['bounty-operator-mcp']}`).toString('utf8').startsWith('#!/usr/bin/env node\n')) {
    throw new Error('The bin file must start with "#!/usr/bin/env node" and a Unix line end.');
  }
  await assertNoHostedMethod(files);
  return files;
}

/**
 * Copies the engine, runs `npm pack` and returns the tarball.
 *
 * @param {string} destination  Directory the .tgz is written into.
 * @returns {Promise<{ path: string, filename: string, bytes: Buffer, version: string }>}
 */
export async function pack(destination) {
  await syncEngine();
  await mkdir(destination, { recursive: true });
  const { stdout } = await npm(['pack', '--json', '--pack-destination', destination], { cwd: PACKAGE_ROOT });
  const [report] = JSON.parse(stdout.slice(stdout.indexOf('[')));
  const path = join(destination, report.filename);
  return { path, filename: report.filename, bytes: await readFile(path), version: report.version };
}

/** A fresh temporary directory, and the function that removes it. */
export async function scratch(prefix = 'bo-mcp-pack-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, remove: () => rm(directory, { recursive: true, force: true }) };
}

/**
 * Talks MCP to a command over stdio: initialize, list the tools, then run
 * `calls` in order. Resolves with the responses once the process has exited.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, shell?: boolean, calls?: { name: string, arguments: object }[], timeoutMs?: number }} [options]
 */
export function handshake(command, args, { cwd, shell = false, calls = [], timeoutMs = 120000 } = {}) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bounty-operator-smoke', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ...calls.map((call, index) => ({ jsonrpc: '2.0', id: 3 + index, method: 'tools/call', params: call })),
  ];
  const lastId = 2 + calls.length;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map();
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`No answer within ${timeoutMs / 1000} seconds. stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (;;) {
        const end = stdout.indexOf('\n');
        if (end === -1) break;
        const line = stdout.slice(0, end).trim();
        stdout = stdout.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        replies.set(message.id, message);
        // Everything has been answered: closing stdin lets the server exit.
        if (replies.has(lastId)) child.stdin.end();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !replies.has(lastId)) {
        reject(new Error(`Server exited with code ${code} after ${replies.size} answers. stderr: ${stderr}`));
        return;
      }
      resolve({
        initialize: replies.get(1).result,
        tools: replies.get(2).result.tools,
        results: calls.map((_, index) => replies.get(3 + index).result),
        stderr,
      });
    });

    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

/**
 * Installs a tarball into an empty folder, the way a user's machine would,
 * and returns where its files and its command landed.
 *
 * @param {string} tarball  Absolute path of the .tgz.
 * @param {string} prefix  Empty directory to install into.
 */
export async function install(tarball, prefix) {
  await mkdir(prefix, { recursive: true });
  // The package has no dependency, so the install needs no registry.
  await npm(['install', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error', tarball], { cwd: prefix });
  const root = join(prefix, 'node_modules', 'bounty-operator-mcp');
  return {
    root,
    bin: join(root, 'bin', 'bounty-operator-mcp.mjs'),
    command: join(prefix, 'node_modules', '.bin', WINDOWS ? 'bounty-operator-mcp.cmd' : 'bounty-operator-mcp'),
  };
}
