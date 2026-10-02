// Paths: what the server reads from disk, and everything it refuses to.

import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LIMITS } from '../lib/review-core.mjs';
import { readPaths } from '../src/files.mjs';
import { VAULT, failure, project, server, sha256 } from './helpers.mjs';

const WINDOWS = process.platform === 'win32';
const SECRET = 'OUTSIDE_FILE_BODY_91c2';

/** A project folder next to a folder it must never read from. */
async function sandbox(t, files = {}) {
  const base = await project(t, { 'outside/secret.txt': SECRET, 'work/src/Vault.sol': VAULT, 'work/README.md': '# Vault\n' });
  const cwd = path.join(base, 'work');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await writeFile(path.join(cwd, name), content);
  }
  return { base, cwd, outside: path.join(base, 'outside', 'secret.txt') };
}

async function refusal(cwd, paths, env = {}) {
  const result = await server({ cwd, env }).tool('prepare_review', { paths });
  const body = failure(result);
  assert.ok(!JSON.stringify(result).includes(SECRET), 'a refusal never carries file content');
  return body;
}

async function labels(cwd, paths, env = {}) {
  const result = await server({ cwd, env }).tool('prepare_review', { paths });
  assert.equal(result.isError, false, result.content[0].text);
  return result.structuredContent.manifest.map((entry) => entry.label);
}

test('paths under the working directory are read, by relative or absolute name', async (t) => {
  const { cwd } = await sandbox(t);

  assert.deepEqual(await labels(cwd, ['src/Vault.sol', 'README.md']), ['input-1/src/Vault.sol', 'input-2/README.md']);
  assert.deepEqual(await labels(cwd, ['./src/Vault.sol']), ['input-1/src/Vault.sol']);
  assert.deepEqual(await labels(cwd, [path.join(cwd, 'src', 'Vault.sol')]), ['input-1/src/Vault.sol']);
  if (WINDOWS) assert.deepEqual(await labels(cwd, ['src\\Vault.sol']), ['input-1/src/Vault.sol']);
});

test('a path with ".." is refused, wherever it ends up', async (t) => {
  const { cwd } = await sandbox(t);

  for (const value of ['../outside/secret.txt', 'src/../../outside/secret.txt', 'src/../README.md', '..', 'src/..']) {
    const body = await refusal(cwd, [value]);
    assert.equal(body.code, 'bad_path', value);
    assert.match(body.error, /contains "\.\."/, value);
  }
  if (WINDOWS) {
    assert.match((await refusal(cwd, ['..\\outside\\secret.txt'])).error, /contains "\.\."/);
    assert.match((await refusal(cwd, ['src\\..\\..\\outside\\secret.txt'])).error, /contains "\.\."/);
  }
});

test('an absolute path outside the working directory is refused, whether or not it exists', async (t) => {
  const { cwd, base, outside } = await sandbox(t);
  // A sibling folder whose name starts with the working directory's name.
  await mkdir(`${cwd}-evil`);
  await writeFile(path.join(`${cwd}-evil`, 'secret.txt'), SECRET);

  const system = WINDOWS ? 'C:\\Windows\\win.ini' : '/etc/passwd';
  const answers = new Set();
  for (const value of [outside, path.join(base, 'outside', 'missing.txt'), path.join(`${cwd}-evil`, 'secret.txt'), base, system]) {
    const body = await refusal(cwd, [value]);
    assert.equal(body.code, 'bad_path', value);
    assert.match(body.error, /is outside the working directory/, value);
    answers.add(body.error.replace(/^paths\[0\] "(?:[^"\\]|\\.)*" /, ''));
  }
  assert.equal(answers.size, 1, 'the answer does not say whether the outside file exists');

  // One bad path refuses the whole call: nothing is read around it.
  assert.equal((await refusal(cwd, ['src/Vault.sol', outside])).error.startsWith('paths[1] '), true);
});

test('a link that leaves the working directory is refused', async (t) => {
  const { cwd, base } = await sandbox(t);

  // A junction needs no privilege on Windows; elsewhere it is an ordinary directory link.
  await symlink(path.join(base, 'outside'), path.join(cwd, 'vendor'), 'junction');
  const viaDirectory = await refusal(cwd, ['vendor/secret.txt']);
  assert.equal(viaDirectory.code, 'bad_path');
  assert.match(viaDirectory.error, /is a link that leaves the working directory/);

  let fileLinks = true;
  try {
    await symlink(path.join(base, 'outside', 'secret.txt'), path.join(cwd, 'notes.txt'), 'file');
    await symlink(path.join(cwd, 'src', 'Vault.sol'), path.join(cwd, 'alias.sol'), 'file');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    fileLinks = false;
  }
  if (!fileLinks) return t.diagnostic('file links need a privilege this account lacks; the directory link was checked');

  assert.match((await refusal(cwd, ['notes.txt'])).error, /is a link that leaves the working directory/);
  // A link that stays inside is an ordinary file under the name it was given.
  assert.deepEqual(await labels(cwd, ['alias.sol']), ['input-1/alias.sol']);
});

test('what is not a readable text file is refused by name', async (t) => {
  const { cwd } = await sandbox(t, {
    'big.sol': 'a'.repeat(LIMITS.fileBytes + 1),
    'full.sol': 'a'.repeat(LIMITS.fileBytes),
    'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9]),
  });

  assert.match((await refusal(cwd, ['src'])).error, /is a directory\. Name the files in it\./);
  assert.match((await refusal(cwd, ['src/Missing.sol'])).error, /does not exist under/);
  assert.match((await refusal(cwd, ['README.md/x'])).error, /does not exist under/);
  assert.match((await refusal(cwd, ['big.sol'])).error, /exceeds the 120 KB limit per file/);
  assert.match((await refusal(cwd, ['image.png'])).error, /is a binary file/);
  assert.match((await refusal(cwd, ['latin1.txt'])).error, /is not UTF-8 text/);
  assert.deepEqual(await labels(cwd, ['full.sol']), ['input-1/full.sol']);
});

test('paths count toward the same limits as inline files', async (t) => {
  const chunk = 'a'.repeat(100000);
  const { cwd } = await sandbox(t, { 'a.txt': chunk, 'b.txt': chunk, 'c.txt': chunk });

  assert.match((await refusal(cwd, ['a.txt', 'b.txt', 'c.txt'])).error, /Files exceed the combined limit of 240 KB/);

  const { tool } = server({ cwd });
  const mixed = failure(await tool('prepare_review', { paths: ['a.txt', 'b.txt'], files: [{ name: 'c.txt', content: chunk }] }));
  assert.match(mixed.error, /240 KB/);

  const tooMany = failure(await tool('prepare_review', { paths: new Array(LIMITS.files + 1).fill('a.txt') }));
  assert.match(tooMany.error, /between 1 and 50 files/);
});

test('a path that is not a plain file name is refused before the disk is touched', async (t) => {
  const { cwd } = await sandbox(t);

  assert.equal((await refusal(cwd, [''])).code, 'bad_path');
  assert.equal((await refusal(cwd, ['   '])).code, 'bad_path');
  assert.equal((await refusal(cwd, [42])).code, 'bad_path');
  assert.equal((await refusal(cwd, [null])).code, 'bad_path');
  assert.equal((await refusal(cwd, [['src/Vault.sol']])).code, 'bad_path');
  assert.match((await refusal(cwd, ['src/Vault.sol\0.txt'])).error, /control character/);
  assert.match((await refusal(cwd, ['src/Vault.sol\n'])).error, /control character/);
  assert.match((await refusal(cwd, [`${'a/'.repeat(600)}x`])).error, /longer than 1024 characters/);

  if (WINDOWS) {
    assert.match((await refusal(cwd, ['\\\\server\\share\\secret.txt'])).error, /network or device path/);
    assert.match((await refusal(cwd, ['//server/share/secret.txt'])).error, /network or device path/);
    assert.match((await refusal(cwd, ['\\\\?\\C:\\Windows\\win.ini'])).error, /network or device path/);
    assert.match((await refusal(cwd, ['C:secret.txt'])).error, /contains ":"/);
    assert.match((await refusal(cwd, ['README.md:stream'])).error, /contains ":"/);
    assert.match((await refusal(cwd, ['README.md::$DATA'])).error, /contains ":"/);
    for (const device of ['NUL', 'CON', 'COM1', 'src\\NUL']) {
      assert.equal((await refusal(cwd, [device])).code, 'bad_path', device);
    }
  } else {
    // A backslash is an ordinary character here, and no review name may hold one.
    await writeFile(path.join(cwd, 'odd\\name.sol'), VAULT);
    assert.match((await refusal(cwd, ['odd\\name.sol'])).error, /has a name a review cannot carry/);
  }
});

test('the byte order mark is kept, so the manifest hash is the hash of the file', async (t) => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('contract A {}\r\n')]);
  const { cwd } = await sandbox(t, { 'bom.sol': bytes });

  const [file] = await readPaths(['bom.sol'], cwd);
  assert.equal(Buffer.from(file.content, 'utf8').equals(bytes), true);

  const result = await server({ cwd }).tool('prepare_review', { paths: ['bom.sol'] });
  assert.equal(result.structuredContent.manifest[0].sha256, sha256(bytes));
  assert.equal(result.structuredContent.manifest[0].bytes, bytes.length);
});

test('a home directory or a filesystem root is not a project folder', async () => {
  for (const cwd of [homedir(), path.parse(process.cwd()).root]) {
    const result = await server({ cwd }).tool('prepare_review', { paths: ['anything.txt'] });
    const body = failure(result);
    assert.equal(body.code, 'bad_root', cwd);
    assert.match(body.error, /set BOUNTY_OPERATOR_ROOT/);

    // Inline files need no working directory.
    const inline = await server({ cwd }).tool('prepare_review', { files: [{ name: 'a.sol', content: VAULT }] });
    assert.equal(inline.isError, false);
  }
});

test('BOUNTY_OPERATOR_ROOT names the project folder when the client starts the server elsewhere', async (t) => {
  const { cwd, base, outside } = await sandbox(t);
  const env = { BOUNTY_OPERATOR_ROOT: cwd };

  assert.deepEqual(await labels(base, ['src/Vault.sol'], env), ['input-1/src/Vault.sol']);
  assert.match((await refusal(base, [outside], env)).error, /is outside the working directory/);
  assert.match((await refusal(base, ['../outside/secret.txt'], env)).error, /contains "\.\."/);

  const relative = await refusal(cwd, ['src/Vault.sol'], { BOUNTY_OPERATOR_ROOT: 'work' });
  assert.equal(relative.code, 'bad_root');
  assert.match(relative.error, /must be an absolute path/);
  // The setting matters only to a call that names paths.
  const inline = await server({ cwd, env: { BOUNTY_OPERATOR_ROOT: 'work' } }).tool('prepare_review', { files: [{ name: 'a.sol', content: VAULT }] });
  assert.equal(inline.isError, false);
});

test('run_review reads paths under the same rules', async (t) => {
  const { cwd, outside } = await sandbox(t);
  let called = 0;
  const fetch = async () => {
    called += 1;
    return new Response('{}');
  };
  const env = { BOUNTY_OPERATOR_TOKEN: `bok_${'A'.repeat(43)}`, OPENAI_API_KEY: 'sk-test-0123456789' };
  const { tool } = server({ cwd, env, fetch });

  for (const value of [outside, '../outside/secret.txt']) {
    const body = failure(await tool('run_review', { paths: [value], provider: 'openai', model: 'gpt-6.1-sol' }));
    assert.equal(body.code, 'bad_path', value);
  }
  assert.equal(called, 0, 'nothing was sent');
});
