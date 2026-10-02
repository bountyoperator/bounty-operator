// The public repository names its builder as Tradi3 and nobody else, names no
// third party's method, and keeps the operating entity to the legal pages.
// The strings that must stay out are not spelled in any test: a pattern in a
// test file would publish the name it guards. They are read through
// ./private-lists.mjs from two lists git ignores, and looked for in every file
// git would publish. A checkout without a list has nothing to compare against,
// and its test is skipped.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { COPY_LIST, NAMES_LIST, REPO_DIR, bannedIn, copyBans, namePattern, pageOf, parseBan, privateNames } from './private-lists.mjs';

const MAX_FILE_BYTES = 16 * 1024 * 1024;

function git(args) {
  return execFileSync('git', args, { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Every file git would publish, with its text. Files deleted in the working tree or too large to be text are left out. */
function publishableFiles() {
  const files = git(['ls-files', '-co', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
  assert.ok(files.length > 100, 'git lists the files of this repository');
  return files
    .filter((file) => {
      const full = path.join(REPO_DIR, file);
      return existsSync(full) && statSync(full).size <= MAX_FILE_BYTES;
    })
    // Decoding never throws: bytes that are not text become replacement characters.
    .map((file) => ({ file, text: `${file}\n${readFileSync(path.join(REPO_DIR, file), 'utf8')}` }));
}

const names = privateNames();
const bans = copyBans();

test('the name pattern matches a whole word in any case and nothing longer', () => {
  const pattern = namePattern('Example');
  assert.match('Built by example.', pattern);
  assert.match('EXAMPLE@host', pattern);
  assert.match('path/example/file', pattern);
  assert.match('Example’s report', pattern);
  assert.doesNotMatch('examples', pattern);
  assert.doesNotMatch('counterexample', pattern);
  assert.match('a.b+c@example.org', namePattern('a.b+c@example.org'));
  assert.doesNotMatch('aXb+c@example.org', namePattern('a.b+c@example.org'));
  assert.deepEqual(privateNames(path.join(REPO_DIR, 'no-such-list.txt')), []);
});

test('a copy ban is a pattern in any case, with its own flags or its own pages when the line says so', () => {
  const plain = parseBan('example corp');
  assert.match('Operated by Example Corp.', plain.pattern);
  assert.deepEqual(plain.allow, []);

  const exact = parseBan('/\\bEXM\\b/');
  assert.match('the EXM result', exact.pattern);
  assert.doesNotMatch('the exm result', exact.pattern);
  assert.doesNotMatch('FLEXMODE', exact.pattern);

  const legal = parseBan('example corp    allow=/terms,/privacy');
  assert.match('example corp', legal.pattern);
  assert.deepEqual(legal.allow, ['/terms', '/privacy']);

  assert.equal(pageOf('web/public/terms.html'), '/terms');
  assert.equal(pageOf('web/site/pages/docs/terms.mjs'), '/terms');
  assert.equal(pageOf('web/public/tools/verify.html'), '/tools/verify');
  assert.equal(pageOf('web/tests/docs-pages.test.mjs'), '');
  assert.equal(pageOf('README.md'), '');
  assert.deepEqual(copyBans(path.join(REPO_DIR, 'no-such-list.txt')), []);
});

test('no file git would publish spells a private name', { skip: names.length ? false : 'this checkout has no list of private names' }, () => {
  // The list itself must be one of the files git leaves out.
  assert.doesNotThrow(() => git(['check-ignore', '-q', NAMES_LIST]), 'the list of private names is git-ignored');

  const files = publishableFiles();
  assert.ok(!files.some(({ file }) => file === NAMES_LIST));

  const patterns = names.map(namePattern);
  const hits = [];
  for (const { file, text } of files) {
    patterns.forEach((pattern, index) => {
      if (pattern.test(text)) hits.push(`${file}: entry ${index + 1} of the list`);
    });
  }
  // The failure names the file and the entry's position, never the string.
  assert.deepEqual(hits, []);
});

test('no file git would publish matches a copy ban, outside the pages a ban allows', { skip: bans.length ? false : 'this checkout has no copy ban list' }, () => {
  assert.doesNotThrow(() => git(['check-ignore', '-q', COPY_LIST]), 'the copy ban list is git-ignored');

  const files = publishableFiles();
  assert.ok(!files.some(({ file }) => file === COPY_LIST));

  const hits = [];
  let allowed = 0;
  for (const { file, text } of files) {
    const page = pageOf(file);
    bans.forEach((ban, index) => {
      if (!ban.pattern.test(text)) return;
      if (page && ban.allow.includes(page)) allowed += 1;
      else hits.push(`${file}: entry ${index + 1} of the list`);
    });
  }
  assert.deepEqual(hits, []);

  // A ban that allows pages is there because those pages carry it: the source and the built page of each.
  const expected = bans.reduce((sum, ban) => sum + ban.allow.length * 2, 0);
  assert.equal(allowed, expected, 'every allowed page carries its entry, in the page module and in the HTML built from it');
});

test('the helper the other tests call agrees with the lists', { skip: names.length || bans.length ? false : 'this checkout has neither list' }, () => {
  assert.deepEqual(bannedIn('Find the hole in your report before the triager does.'), []);
  if (names.length) assert.deepEqual(bannedIn(`Built by ${names[0]}.`).filter((hit) => hit.startsWith('private name')), ['private name 1']);
});
