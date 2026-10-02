// scripts/leak-audit.mjs: the matching it does, on made-up text. The audit
// itself runs against the private module, which a public checkout does not have.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { hitsIn } from '../../scripts/leak-audit.mjs';

const METHOD = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima.';

/** The eight-word runs of a text, mapped to a profile id, as the audit builds them. */
function runsOf(text, profile = 'scope') {
  const list = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  const runs = new Map();
  for (let index = 0; index + 8 <= list.length; index += 1) runs.set(list.slice(index, index + 8).join(' '), profile);
  return runs;
}

test('a run of eight method words is found, with its line, its length and its profile', () => {
  const runs = runsOf(METHOD);
  const page = 'A page about scope.\n\nIt says: alpha bravo charlie delta echo foxtrot golf hotel india, and then goes on.\n';
  assert.deepEqual(hitsIn(page, runs), [{ profile: 'scope', line: 3, words: 9, text: 'alpha bravo charlie delta echo foxtrot golf hotel india' }]);
});

test('case, punctuation, markup and line breaks do not hide a copy', () => {
  const runs = runsOf(METHOD);
  for (const copy of [
    '> **ALPHA** bravo, charlie;\n> delta - echo\n> "foxtrot" (golf) hotel',
    '<li>alpha</li><li>bravo</li> charlie delta echo foxtrot golf hotel',
    '"alpha bravo charlie delta echo\\nfoxtrot golf hotel"'.replace('\\n', '\n'),
  ]) {
    assert.equal(hitsIn(copy, runs).length, 1, copy);
  }
});

test('seven words in a row, the same words in another order, and section headings are not a match', () => {
  const runs = runsOf(METHOD);
  assert.deepEqual(hitsIn('alpha bravo charlie delta echo foxtrot golf.', runs), []);
  assert.deepEqual(hitsIn('hotel golf foxtrot echo delta charlie bravo alpha india juliet', runs), []);
  assert.deepEqual(hitsIn('## Alpha\n- one | two\n\n## Bravo charlie\n- three | four\n', runs), []);
  assert.deepEqual(hitsIn('', runs), []);
});

test('two separate copies in one file are two findings', () => {
  const runs = runsOf(METHOD);
  const text = 'alpha bravo charlie delta echo foxtrot golf hotel\n\nunrelated words in between here\n\ncharlie delta echo foxtrot golf hotel india juliet kilo';
  const hits = hitsIn(text, runs);
  assert.deepEqual(hits.map((hit) => [hit.line, hit.words]), [[1, 8], [5, 9]]);
});

test('the audit script holds no method text and reads the private module only at run time', async () => {
  const source = await readFile(new URL('../../scripts/leak-audit.mjs', import.meta.url), 'utf8');
  assert.ok(!/^import .*operator-profiles/m.test(source), 'no static import of the private module');
  assert.match(source, /await import\(pathToFileURL\(PRIVATE_MODULE\)\.href\)/);
  assert.match(source, /no private module in this checkout/);
  // Every outlet it promises to read.
  for (const outlet of ["'ls-files', '-z', '--cached', '--others', '--exclude-standard'", "join(ROOT, 'web', 'public')", 'tarEntries(bytes)', "'/api/profiles'", "'/api/mcp'"]) {
    assert.ok(source.includes(outlet), outlet);
  }
  // Only the private directory is left out.
  assert.match(source, /if \(inPrivate\(path\) \|\| seen\.has\(path\)\) return;/);
});
