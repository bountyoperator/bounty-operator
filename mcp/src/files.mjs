// Reads the files a tool call names by path. Every path must stay under the
// working directory: no "..", no absolute path outside it, no link that leaves
// it. Contents go to the engine and never back to the caller.

import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { LIMITS, validName } from '../lib/review-core.mjs';
import { ToolError } from './errors.mjs';

const MAX_PATH_CHARS = 1024;
const SHOWN_PATH_CHARS = 120;
const WINDOWS = path.sep === '\\';
const FILE_KB = LIMITS.fileBytes / 1000;
const TOTAL_KB = LIMITS.totalBytes / 1000;

/**
 * The directory paths resolve under: BOUNTY_OPERATOR_ROOT when it is set, the
 * directory the server was started in otherwise.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd
 * @returns {string}
 */
export function rootFor(env, cwd) {
  const configured = env.BOUNTY_OPERATOR_ROOT;
  if (configured === undefined || configured === '') return path.resolve(cwd);
  if (!path.isAbsolute(configured)) {
    throw new ToolError('BOUNTY_OPERATOR_ROOT must be an absolute path to the project folder.', 'bad_root');
  }
  return path.resolve(configured);
}

/** `target` relative to `root` when it lies inside it, otherwise null. */
function inside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative;
}

function samePath(a, b) {
  return path.relative(a, b) === '';
}

/**
 * The working directory as given and with links resolved. A filesystem root
 * or a home directory is refused: under either, "inside the working
 * directory" would mean every file the user can read.
 */
async function projectRoot(root) {
  const lexical = path.resolve(root);
  let real;
  try {
    real = await realpath(lexical);
  } catch {
    throw new ToolError(`The working directory ${lexical} cannot be read. Pass the files inline.`, 'bad_root');
  }
  if (path.parse(real).root === real || samePath(real, homedir())) {
    throw new ToolError(
      `Paths are read under the working directory, and this server was started in ${real}. Start it in the project folder or set BOUNTY_OPERATOR_ROOT to that folder. Inline files work from any directory.`,
      'bad_root',
    );
  }
  return { lexical, real };
}

function shown(value) {
  const text = String(value);
  return JSON.stringify(text.length > SHOWN_PATH_CHARS ? `${text.slice(0, SHOWN_PATH_CHARS)}…` : text);
}

function refused(index, value, reason) {
  return new ToolError(`paths[${index}] ${shown(value)} ${reason}`, 'bad_path');
}

/** Refuses a path by its text alone, before anything on disk is touched. */
function checkShape(value, index) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolError(`paths[${index}] must be a file path under the working directory.`, 'bad_path');
  }
  if (value.length > MAX_PATH_CHARS) throw refused(index, value, `is longer than ${MAX_PATH_CHARS} characters.`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw refused(index, value, 'contains a control character.');

  const segments = value.split(WINDOWS ? /[\\/]/ : '/');
  if (segments.includes('..')) {
    throw refused(index, value, 'contains "..". Name the file by its path under the working directory.');
  }
  if (WINDOWS) {
    if (/^[\\/]{2}/.test(value)) throw refused(index, value, 'is a network or device path. Name a file under the working directory.');
    // A colon after the drive letter names a drive-relative path or an alternate data stream.
    if (value.replace(/^[A-Za-z]:(?=[\\/])/, '').includes(':')) {
      throw refused(index, value, 'contains ":". Name the file by its path under the working directory.');
    }
  }
}

/** Reads at most one byte more than the per-file limit, so a file that grows mid-read is still caught. */
async function readBounded(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(LIMITS.fileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function readOne(base, value, index, remaining) {
  checkShape(value, index);

  const resolved = path.resolve(base.lexical, value);
  const relative = inside(base.lexical, resolved) ?? inside(base.real, resolved);
  if (!relative) throw refused(index, value, `is outside the working directory ${base.lexical}.`);

  let real;
  let info;
  try {
    real = await realpath(resolved);
    // The check runs on the resolved target, so a link cannot point it elsewhere.
    if (!inside(base.real, real)) throw refused(index, value, 'is a link that leaves the working directory.');
    info = await stat(real);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
    throw refused(index, value, missing ? `does not exist under ${base.lexical}.` : 'cannot be read.');
  }

  if (info.isDirectory()) throw refused(index, value, 'is a directory. Name the files in it.');
  if (!info.isFile()) throw refused(index, value, 'is not a regular file.');
  if (info.size > LIMITS.fileBytes) throw refused(index, value, `exceeds the ${FILE_KB} KB limit per file.`);
  if (info.size > remaining) throw new ToolError(`Files exceed the combined limit of ${TOTAL_KB} KB.`, 'bad_input');

  let bytes;
  try {
    bytes = await readBounded(real);
  } catch {
    throw refused(index, value, 'cannot be read.');
  }
  if (bytes.length > LIMITS.fileBytes) throw refused(index, value, `exceeds the ${FILE_KB} KB limit per file.`);
  if (bytes.length > remaining) throw new ToolError(`Files exceed the combined limit of ${TOTAL_KB} KB.`, 'bad_input');
  if (bytes.includes(0)) throw refused(index, value, 'is a binary file. Pass UTF-8 text files.');

  let content;
  try {
    // The byte order mark is kept, so the manifest hash equals the hash of the file on disk.
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw refused(index, value, 'is not UTF-8 text.');
  }

  const name = relative.split(path.sep).join('/');
  if (!validName(name)) {
    throw refused(index, value, 'has a name a review cannot carry. Pass it inline under a plain repo-relative name.');
  }
  return { name, content, bytes: bytes.length };
}

/**
 * Reads `paths` under `root`, in order.
 *
 * @param {unknown[]} paths
 * @param {string} root
 * @returns {Promise<{ name: string, content: string }[]>}
 */
export async function readPaths(paths, root) {
  const base = await projectRoot(root);
  const files = [];
  let total = 0;
  for (const [index, value] of paths.entries()) {
    const file = await readOne(base, value, index, LIMITS.totalBytes - total);
    total += file.bytes;
    files.push({ name: file.name, content: file.content });
  }
  return files;
}

/**
 * The files of a tool call: those read from `paths` first, then the inline
 * `files`, each list in the order given. `fromDisk` is how many came from disk.
 *
 * @param {{ paths?: unknown, files?: unknown }} args
 * @param {() => string} root  Returns the working directory. Called only when there are paths to read.
 * @returns {Promise<{ files: { name: string, content: string }[], fromDisk: number }>}
 */
export async function collectFiles(args, root) {
  const paths = args.paths ?? [];
  const inline = args.files ?? [];
  if (!Array.isArray(paths)) throw new ToolError('paths must be a list of file paths.', 'bad_input');
  if (!Array.isArray(inline)) throw new ToolError('files must be a list of { name, content } entries.', 'bad_input');

  const count = paths.length + inline.length;
  if (count < 1 || count > LIMITS.files) {
    throw new ToolError(`Pass between 1 and ${LIMITS.files} files: as paths, as files, or both.`, 'bad_input');
  }

  const read = paths.length ? await readPaths(paths, root()) : [];
  return { files: [...read, ...inline], fromDisk: read.length };
}
