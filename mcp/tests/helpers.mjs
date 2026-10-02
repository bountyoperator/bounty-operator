// Shared by the tests: an in-process server, a throwaway project folder, a
// stand-in for the account API, and a line-based stdio client.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../src/server.mjs';

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BIN = join(PACKAGE_ROOT, 'bin', 'bounty-operator-mcp.mjs');

export const TOKEN = `bok_${'A'.repeat(43)}`;
export const PROVIDER_KEY = `sk-or-test-${'k'.repeat(40)}`;

export const VAULT = 'contract Vault {\n  function withdraw() external {}\n}\n';

/** A review in the contract's format that cites one line that exists and one that does not. */
export function reviewFor(label, verdict = 'prove-first') {
  return [
    '# Review',
    `Verdict: ${verdict}`,
    'Mode: bounty',
    'Counts: critical=0 high=1 medium=0 hardening=0 checked-safe=0',
    'Headline: withdraw has no access check.',
    '',
    '## F-1: Anyone can withdraw',
    'Severity: high',
    'Basis: proven-in-source',
    `Location: ${label}:2; ${label}:40`,
    'Impact: any caller drains the vault.',
    'Counterargument: a modifier may exist | open | not in the supplied file',
    'Gap: a local test',
    `Fix: add an owner check at ${label}:2`,
    'Next: write the test',
  ].join('\n');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A folder holding `files` ({ 'src/Vault.sol': 'text' | Buffer }). Returns its
 * real path, so comparisons do not trip over a linked temp directory.
 */
export async function project(t, files = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'bo-mcp-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

let nextId = 0;

/** An in-process server with `call` for any method and `tool` for a tool call. */
export function server(options = {}) {
  const instance = createServer({ env: {}, cwd: PACKAGE_ROOT, ...options });
  const call = async (method, params, notify) => {
    nextId += 1;
    return instance.handle({ jsonrpc: '2.0', id: nextId, method, ...(params === undefined ? {} : { params }) }, notify);
  };
  const tool = async (name, args = {}) => {
    const reply = await call('tools/call', { name, arguments: args });
    if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
    return reply.result;
  };
  return { ...instance, call, tool };
}

/** The coded body of a failed tool call. */
export function failure(result) {
  if (!result.isError) throw new Error(`Expected a failed call, got: ${result.content[0].text.slice(0, 200)}`);
  return JSON.parse(result.content[0].text);
}

/**
 * A stand-in for fetch. `routes` maps "METHOD /path" to a function of the
 * parsed request returning `{ status?, body }`. Every call is recorded.
 */
export function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname, origin } = new URL(url);
    const request = {
      origin,
      path: pathname,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
      signal: init.signal,
    };
    calls.push(request);
    const route = routes[`${request.method} ${pathname}`];
    if (!route) return new Response('not found', { status: 404 });
    const { status = 200, body } = await route(request);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

/**
 * Starts a command and talks MCP to it line by line. `request` resolves with
 * the response that carries the same id.
 */
export function stdioClient(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  const waiting = new Map();
  const stray = [];
  let buffer = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end === -1) break;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = waiting.get(message.id);
      if (resolve) {
        waiting.delete(message.id);
        resolve(message);
      } else {
        stray.push(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  let id = 0;

  return {
    child,
    stray,
    exited,
    stderr: () => stderr,
    write: (text) => child.stdin.write(text),
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    request(method, params) {
      id += 1;
      const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
      const reply = new Promise((resolve, reject) => {
        waiting.set(id, resolve);
        exited.then((code) => reject(new Error(`Server exited with code ${code} before answering ${method}. stderr: ${stderr}`)));
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return reply;
    },
    async close() {
      child.stdin.end();
      return exited;
    },
  };
}
