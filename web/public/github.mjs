// Reads files from GitHub through the REST API, pinned to an exact commit.
// Every request is anonymous unless the user supplies a token, never follows a
// redirect and reads a bounded body.

import { LIMITS, boundedBody, textBytes, validName } from './review-core.mjs';

const API = 'https://api.github.com';
// GitHub's file host. It serves a file at an exact commit with open CORS and outside the
// API's rate limit, so reading file bodies here leaves a visitor without a token their 60
// API calls an hour for the commit and the listing.
const RAW = 'https://raw.githubusercontent.com';
// A file kept in Git LFS is, in the repository, a short pointer that starts with this line.
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\b/;
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 20000;
const CONCURRENT_FILES = 6;
const PULL_PAGE_SIZE = 100;
const PULL_MAX_PAGES = 5;

const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const UNSAFE_SEGMENT = /[\x00-\x1f\x7f\\]/;

const BODY_LIMIT = Object.freeze({
  sha: 256,
  file: LIMITS.fileBytes,
  tree: 8000000,
  pull: 1000000,
  pullFiles: 4000000,
});

/**
 * @typedef {object} GithubReference
 * @property {string} owner
 * @property {string} repo
 * @property {'repo' | 'tree' | 'blob' | 'pull' | 'commit'} kind
 * @property {string} [ref]
 * @property {string} [path]
 * @property {number} [number]
 *
 * @typedef {{ owner: string, repo: string, sha: string, token?: string }} CommitTarget
 */

class GithubError extends Error {
  constructor(message, { status = 0, reason = '' } = {}) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.reason = reason;
  }
}

function decodeSegments(segments) {
  let decoded;
  try {
    decoded = segments.map(decodeURIComponent);
  } catch {
    throw new GithubError('The GitHub link has invalid encoding.');
  }
  const unsafe = decoded.some((segment) => !segment || segment === '.' || segment === '..' || UNSAFE_SEGMENT.test(segment));
  if (unsafe) throw new GithubError('The GitHub link has an unsupported path.');
  return decoded;
}

function isRepoSegment(value) {
  // "." and ".." pass the character check and would climb out of /repos/ in the API path.
  return typeof value === 'string' && REPO_NAME.test(value) && value !== '.' && value !== '..';
}

function assertRepo(owner, repo) {
  if (!isRepoSegment(owner) || !isRepoSegment(repo)) {
    throw new GithubError('The GitHub link does not name a repository.');
  }
}

function withPath(reference, segments) {
  if (!segments.length) return reference;
  const path = segments.join('/');
  if (!validName(path)) throw new GithubError('The GitHub link has an unsupported path.');
  return { ...reference, path };
}

function rawReference(segments) {
  // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>, where <ref> may be spelled refs/heads/<branch>.
  const [owner, repo, ...rest] = segments;
  assertRepo(owner, repo);
  const named = rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags');
  const [ref, ...path] = decodeSegments(named ? rest.slice(2) : rest);
  if (!ref || !path.length) throw new GithubError('The raw GitHub link does not point at a file.');
  return withPath({ owner, repo, kind: 'blob', ref }, path);
}

/**
 * Parses a GitHub link into `{ owner, repo, kind, ref?, path?, number? }`.
 * Accepts repository, /tree/, /blob/, /pull/ and /commit/ links on github.com
 * and file links on raw.githubusercontent.com. The query string and fragment
 * are ignored, so `?plain=1` and `#L10` links work.
 *
 * The first path segment after /tree/ or /blob/ is taken as the ref. A branch
 * whose name contains "/" needs the commit permalink instead (press "y" on GitHub).
 *
 * @param {string} value
 * @returns {GithubReference}
 */
export function githubReference(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new GithubError('Paste a GitHub link: a repository, folder, file, pull request or commit.');
  }
  if (url.username || url.password) throw new GithubError('Use a github.com link without credentials.');

  const host = url.hostname.toLowerCase();
  const knownHost = host === 'github.com' || host === 'www.github.com' || host === 'raw.githubusercontent.com';
  if (url.protocol !== 'https:' || url.port || !knownHost) throw new GithubError('Use an HTTPS github.com link.');

  const segments = url.pathname.split('/').filter(Boolean);
  if (host === 'raw.githubusercontent.com') return rawReference(segments);

  const [owner, rawRepo, kind, ...rest] = segments;
  const repo = (rawRepo || '').replace(/\.git$/, '');
  assertRepo(owner, repo);
  if (!kind) return { owner, repo, kind: 'repo' };

  if (kind === 'tree' || kind === 'blob') {
    const [ref, ...path] = decodeSegments(rest);
    if (!ref || ref.length > 160) throw new GithubError('The GitHub link has an unsupported ref.');
    if (kind === 'blob' && !path.length) throw new GithubError('The GitHub file link does not name a file.');
    return withPath({ owner, repo, kind, ref }, path);
  }
  if (kind === 'pull' && /^[1-9]\d{0,8}$/.test(rest[0] || '')) {
    return { owner, repo, kind: 'pull', number: Number(rest[0]) };
  }
  if (kind === 'commit' && /^[a-f0-9]{7,40}$/i.test(rest[0] || '')) {
    return { owner, repo, kind: 'commit', ref: rest[0].toLowerCase() };
  }
  throw new GithubError('Use a GitHub repository, folder, file, pull request or commit link.');
}

/**
 * Parses a link to one file. Returns `{ owner, repo, ref, path }` with `path` as segments.
 *
 * @param {string} value
 * @returns {{ owner: string, repo: string, ref: string, path: string[] }}
 */
export function githubFileReference(value) {
  const reference = githubReference(value);
  if (reference.kind !== 'blob') throw new GithubError('Open a file on GitHub and paste its /blob/ link.');
  return { owner: reference.owner, repo: reference.repo, ref: reference.ref, path: reference.path.split('/') };
}

function assertToken(token) {
  // Printable ASCII only: anything else cannot be sent in the Authorization header.
  if (typeof token !== 'string' || token.length > 4096 || /[^\x21-\x7e]/.test(token)) {
    throw new GithubError('Use a valid GitHub token, or leave the token empty for public repositories.');
  }
}

function statusFailure(response) {
  const { status } = response;
  const limited = response.headers.get('x-ratelimit-remaining') === '0';
  if (limited || status === 429) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const until = Number.isFinite(reset) && reset > 0
      ? ` It resets at ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC.`
      : '';
    return new GithubError(`GitHub rate limit reached.${until} A token raises the limit.`, { status });
  }
  if (status === 401) return new GithubError('GitHub rejected the token (HTTP 401).', { status });
  if (status === 404) {
    return new GithubError('GitHub has no such repository, ref or file (HTTP 404). Private repositories need a token.', { status });
  }
  return new GithubError(`GitHub returned HTTP ${status}.`, { status });
}

function isJson(response) {
  return /^application\/json\b/i.test(response.headers.get('content-type') || '');
}

/**
 * GETs one API path and returns the body as text. `fileOnly` is for the raw
 * media type: GitHub answers a folder or a submodule path with a JSON listing
 * instead of file contents, and that listing must not be imported as a file.
 */
async function githubGet(path, { accept, limit, token = '', fileOnly = false }) {
  assertToken(token);
  const headers = { Accept: accept, 'X-GitHub-Api-Version': API_VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API}${path}`, {
      headers,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // GitHub answers a renamed or transferred repository with a redirect, which is refused here.
    throw new GithubError('GitHub could not be reached. Check the link and the connection. A renamed or transferred repository needs its current link.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw statusFailure(response);
  }
  if (fileOnly && isJson(response)) {
    await response.body?.cancel().catch(() => {});
    throw new GithubError('The path is a folder or a submodule, not a file.', { reason: 'not-a-file' });
  }
  try {
    return await boundedBody(response, limit);
  } catch (error) {
    if (/size limit/.test(error.message)) {
      throw new GithubError('GitHub returned more data than the import accepts.', { reason: 'too-large' });
    }
    throw new GithubError('GitHub sent a response that could not be read.', { reason: 'unreadable' });
  }
}

async function githubJson(path, options) {
  const text = await githubGet(path, { accept: 'application/vnd.github+json', ...options });
  try {
    return JSON.parse(text);
  } catch {
    throw new GithubError('GitHub sent a response that could not be read.', { reason: 'unreadable' });
  }
}

function repoPath({ owner, repo }) {
  assertRepo(owner, repo);
  return `/repos/${owner}/${repo}`;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function pullHead({ owner, repo, number, token }) {
  if (!Number.isInteger(number) || number < 1) throw new GithubError('The pull request number is not valid.');
  const pull = await githubJson(`${repoPath({ owner, repo })}/pulls/${number}`, { limit: BODY_LIMIT.pull, token });
  const sha = pull && pull.head && pull.head.sha;
  if (typeof sha !== 'string' || !COMMIT_SHA.test(sha)) throw new GithubError('GitHub did not return the pull request head commit.');
  return sha;
}

/**
 * Resolves a parsed GitHub reference to the 40-character commit it points at.
 * A repository link resolves to the default branch head, a pull request link
 * to the head commit of the pull request.
 *
 * @param {GithubReference} reference
 * @param {string} [token]
 * @returns {Promise<string>}
 */
export async function resolveCommit(reference, token = '') {
  if (!reference || typeof reference !== 'object') throw new GithubError('Pass a parsed GitHub reference.');
  if (reference.kind === 'pull') return pullHead({ ...reference, token });

  const ref = reference.ref || 'HEAD';
  let text;
  try {
    // The sha media type returns 40 bytes; the JSON form of a large commit can exceed any sane cap.
    text = await githubGet(`${repoPath(reference)}/commits/${encodeURIComponent(ref)}`, {
      accept: 'application/vnd.github.sha',
      limit: BODY_LIMIT.sha,
      token,
    });
  } catch (error) {
    if (error.status === 404 || error.status === 422) {
      throw new GithubError(`GitHub has no commit for "${ref}". For a branch with "/" in its name, use the commit permalink. Private repositories need a token.`, { status: error.status });
    }
    throw error;
  }
  const sha = text.trim();
  if (!COMMIT_SHA.test(sha)) throw new GithubError('GitHub did not return an exact commit.');
  return sha;
}

/**
 * Lists every file in the repository at `sha` as `{ path, size }`.
 * The returned array has `truncated: true` when GitHub cut the listing short.
 *
 * @param {CommitTarget} target
 * @returns {Promise<{ path: string, size: number }[] & { truncated: boolean }>}
 */
export async function listGithubTree({ owner, repo, sha, token = '' }) {
  if (!COMMIT_SHA.test(sha || '')) throw new GithubError('Resolve the commit before listing files.');
  const data = await githubJson(`${repoPath({ owner, repo })}/git/trees/${sha}?recursive=1`, { limit: BODY_LIMIT.tree, token });
  if (!data || !Array.isArray(data.tree)) throw new GithubError('GitHub did not return a file listing.');

  const files = data.tree
    .filter((entry) => entry && entry.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => ({ path: entry.path, size: Number.isFinite(entry.size) ? entry.size : 0 }));
  files.truncated = data.truncated === true;
  return files;
}

/**
 * One file's text from the file host, or null when that host does not give it: a missing
 * path, a folder, a throttled or failed request, bytes that are not text. The caller then
 * asks the API, which names the reason.
 */
async function rawFile({ owner, repo, sha, path }) {
  assertRepo(owner, repo);
  let response;
  try {
    response = await fetch(`${RAW}/${owner}/${repo}/${sha}/${encodePath(path)}`, {
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  try {
    return await boundedBody(response, BODY_LIMIT.file);
  } catch (error) {
    if (/size limit/.test(error.message)) throw new GithubError(`${path} is larger than 120 KB.`, { reason: 'too-large' });
    return null;
  }
}

async function apiFile({ owner, repo, sha, path, token }) {
  try {
    return await githubGet(`${repoPath({ owner, repo })}/contents/${encodePath(path)}?ref=${sha}`, {
      accept: 'application/vnd.github.raw+json',
      limit: BODY_LIMIT.file,
      token,
      fileOnly: true,
    });
  } catch (error) {
    if (error.reason === 'not-a-file') throw new GithubError(`${path} is a folder or a submodule, not a file.`, { reason: 'not-a-file' });
    if (error.reason === 'too-large') throw new GithubError(`${path} is larger than 120 KB.`, { reason: 'too-large' });
    if (error.reason === 'unreadable') throw new GithubError(`${path} is not UTF-8 text.`, { reason: 'unreadable' });
    throw error;
  }
}

async function fetchFile({ owner, repo, sha, path, token }) {
  // With a token the API reads the file, private repositories included. Without one the file
  // host does, and the API is asked only when that host gives nothing.
  const content = (token ? null : await rawFile({ owner, repo, sha, path })) ?? (await apiFile({ owner, repo, sha, path, token }));
  if (LFS_POINTER.test(content)) {
    throw new GithubError(`${path} is kept in Git LFS: the repository holds a pointer, not the file.`, { reason: 'unreadable' });
  }
  try {
    textBytes(content);
  } catch {
    throw new GithubError(`${path} is not UTF-8 text.`, { reason: 'unreadable' });
  }
  return { name: path, content };
}

/**
 * Fetches the given repo-relative paths at `sha`. Returns `{ name, content }`
 * in the order asked, with `name` set to the repo-relative path.
 *
 * @param {CommitTarget & { paths: string[] }} request
 * @returns {Promise<{ name: string, content: string }[]>}
 */
export async function importGithubFiles({ owner, repo, sha, paths, token = '' }) {
  if (!COMMIT_SHA.test(sha || '')) throw new GithubError('Resolve the commit before importing files.');
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > LIMITS.files) {
    throw new GithubError(`Select between 1 and ${LIMITS.files} files.`);
  }
  const invalid = paths.find((path) => !validName(path));
  if (invalid !== undefined) throw new GithubError('A selected path is not a supported file name.');

  const files = [];
  for (let start = 0; start < paths.length; start += CONCURRENT_FILES) {
    const batch = paths.slice(start, start + CONCURRENT_FILES);
    files.push(...await Promise.all(batch.map((path) => fetchFile({ owner, repo, sha, path, token }))));
  }

  const total = files.reduce((sum, file) => sum + textBytes(file.content), 0);
  if (total > LIMITS.totalBytes) throw new GithubError('The selected files exceed the combined 240 KB limit.');
  return files;
}

/**
 * Returns the head commit of a pull request and the paths it adds or changes.
 * `paths.truncated` is true when the pull request has more files than were read.
 *
 * @param {{ owner: string, repo: string, number: number, token?: string }} request
 * @returns {Promise<{ sha: string, paths: string[] & { truncated: boolean } }>}
 */
export async function pullRequestFiles({ owner, repo, number, token = '' }) {
  const sha = await pullHead({ owner, repo, number, token });
  const paths = [];
  paths.truncated = false;

  for (let page = 1; page <= PULL_MAX_PAGES; page += 1) {
    const entries = await githubJson(
      `${repoPath({ owner, repo })}/pulls/${number}/files?per_page=${PULL_PAGE_SIZE}&page=${page}`,
      { limit: BODY_LIMIT.pullFiles, token },
    );
    if (!Array.isArray(entries)) throw new GithubError('GitHub did not return the pull request files.');
    for (const entry of entries) {
      if (entry && typeof entry.filename === 'string' && entry.status !== 'removed') paths.push(entry.filename);
    }
    if (entries.length < PULL_PAGE_SIZE) return { sha, paths };
  }
  paths.truncated = true;
  return { sha, paths };
}

/**
 * Imports the single file a /blob/ or raw link points at, pinned to its commit.
 * Returns `{ file: { name, content }, commit, repository }`.
 *
 * @param {string} value
 * @param {string} [token]
 * @returns {Promise<{ file: { name: string, content: string }, commit: string, repository: string }>}
 */
export async function importGithubFile(value, token = '') {
  const reference = githubReference(value);
  if (reference.kind !== 'blob') throw new GithubError('Open a file on GitHub and paste its /blob/ link.');
  const { owner, repo } = reference;

  const commit = await resolveCommit(reference, token);
  const file = await fetchFile({ owner, repo, sha: commit, path: reference.path, token });
  return { file, commit, repository: `${owner}/${repo}` };
}
