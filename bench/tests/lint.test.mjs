import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffHunks, lintCases, loadCases, matchGlob, pairsOf, parseNodeTestOutput, resolveProof, splitProofRef } from '../lib/cases.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const rules = (res) => res.errors.map((e) => `${e.scope}:${e.rule}`).sort();

/** Copy the fixture tree to a temp dir, apply `mutate(root)`, lint, clean up. */
async function lintMutated(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-lint-'));
  try {
    fs.cpSync(FIXTURES, root, { recursive: true, filter: (src) => !/[\\/](out|cache)([\\/]|$)/.test(src) });
    mutate(root);
    return await lintCases(loadCases([path.join(root, 'cases')]), { benchDir: root });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const edit = (file, fn) => fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
const editJson = (file, fn) => edit(file, (t) => { const j = JSON.parse(t); fn(j); return `${JSON.stringify(j, null, 2)}\n`; });

test('the fixture cases pass lint', async () => {
  const cases = loadCases([path.join(FIXTURES, 'cases')]);
  assert.deepEqual(cases.map((c) => c.id), ['fx-01-f', 'fx-01-v', 'fx-02-a', 'fx-02-o']);
  const res = await lintCases(cases, { benchDir: FIXTURES });
  assert.deepEqual(res.errors, []);
  assert.ok(res.warnings.every((w) => w.rule === 'realism'), 'only the size warnings of a deliberately tiny fixture');
  const pairs = pairsOf(cases);
  assert.deepEqual(pairs.map((p) => [p.pair, p.family, p.author, p.visibility]), [['fx-01', 'find-sol', 'anthropic', 'public'], ['fx-02', 'challenge', 'anthropic', 'public']]);
  assert.deepEqual(pairs[0].cases, { fixed: 'fx-01-f', vulnerable: 'fx-01-v' });
});

test('CRLF line endings are an error', async () => {
  const res = await lintMutated((root) => edit(path.join(root, 'cases/fx-01-v/workspace/src/LedgerMath.sol'), (t) => t.replace(/\n/g, '\r\n')));
  assert.ok(rules(res).includes('fx-01-v:line-endings'));
  assert.ok(rules(res).includes('fx-01:pair.twin'), 'and the twins no longer match outside the patch');
});

test('answer keys, tests and agent files may not sit in the workspace', async () => {
  const res = await lintMutated((root) => {
    const ws = path.join(root, 'cases/fx-01-v/workspace');
    fs.copyFileSync(path.join(root, 'cases/fx-01-v/truth.json'), path.join(ws, 'truth.json'));
    fs.mkdirSync(path.join(ws, 'test'));
    fs.writeFileSync(path.join(ws, 'test', 'Bank.t.sol'), '// test\n');
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'be nice\n');
  });
  const got = res.errors.filter((e) => e.scope === 'fx-01-v').map((e) => `${e.rule}|${e.message}`).join('\n');
  assert.match(got, /workspace\.forbidden\|.*truth\.json/);
  assert.match(got, /workspace\.forbidden\|.*Bank\.t\.sol/);
  assert.match(got, /workspace\.forbidden\|.*AGENTS\.md/);
  assert.match(got, /workspace\.extra/);
  assert.match(got, /leak\|.*canary/, 'truth.json in the workspace also leaks the canary');
});

test('the canary, the case id and variant words must not be visible to the model', async () => {
  const res = await lintMutated((root) => {
    edit(path.join(root, 'cases/fx-01-f/workspace/src/LedgerMath.sol'), (t) => `${t}// c4a91e02-7b3d-4d85-9e61-2f8a0c5d7b33 fx-01-f\n`);
    fs.renameSync(path.join(root, 'cases/fx-02-o/workspace/src/LedgerMath.sol'), path.join(root, 'cases/fx-02-o/workspace/src/LedgerMathFixed.sol'));
  });
  const messages = res.errors.map((e) => `${e.scope}|${e.rule}|${e.message}`).join('\n');
  assert.match(messages, /fx-01-f\|leak\|the canary appears/);
  assert.match(messages, /fx-01-f\|leak\|.*"fx-01-f"/);
  assert.match(messages, /fx-02-o\|workspace\.name-leak/);
});

test('line ranges and function names must exist in the file', async () => {
  const res = await lintMutated((root) => {
    editJson(path.join(root, 'cases/fx-01-v/truth.json'), (t) => { t.planted[0].lines = [[36, 470]]; t.decoys[0].functions = ['sweepEverything']; });
    editJson(path.join(root, 'cases/fx-02-o/truth.json'), (t) => { t.report.false_claims[0].draft_lines = [[90, 91]]; });
  });
  assert.deepEqual(rules(res), ['fx-01-v:truth.functions', 'fx-01-v:truth.lines', 'fx-02-o:truth.lines']);
});

test('twins may differ only inside the patched region', async () => {
  const outside = await lintMutated((root) => edit(path.join(root, 'cases/fx-01-f/workspace/src/PocketBank.sol'), (t) => t.replace('uint16 public constant EXIT_FEE_BPS = 25;', 'uint16 public constant EXIT_FEE_BPS = 30;')));
  assert.deepEqual(rules(outside), ['fx-01:pair.twin']);
  assert.match(outside.errors[0].message, /fixed-file lines 12-12, outside patched_region/);
  const otherFile = await lintMutated((root) => edit(path.join(root, 'cases/fx-01-f/workspace/src/LedgerMath.sol'), (t) => t.replace('rounded down', 'rounded  down')));
  assert.deepEqual(rules(otherFile), ['fx-01:pair.twin']);
  const identical = await lintMutated((root) => fs.copyFileSync(path.join(root, 'cases/fx-01-v/workspace/src/PocketBank.sol'), path.join(root, 'cases/fx-01-f/workspace/src/PocketBank.sol')));
  assert.deepEqual(rules(identical), ['fx-01:pair.twin']);
  const challenge = await lintMutated((root) => edit(path.join(root, 'cases/fx-02-a/workspace/src/PocketBank.sol'), (t) => t.replace('EXIT_FEE_BPS = 25', 'EXIT_FEE_BPS = 26')));
  assert.deepEqual(rules(challenge), ['fx-02:pair.twin'], 'challenge twins share their code');
});

test('schema errors: variant, profile, visibility, twin task text, truth shape', async () => {
  const res = await lintMutated((root) => {
    editJson(path.join(root, 'cases/fx-01-v/case.json'), (c) => { c.profile = 'general'; c.focus = 'Find the re-entrancy.'; });
    editJson(path.join(root, 'cases/fx-01-f/truth.json'), (t) => { t.patched_region = null; t.origin = 'code4rena'; t.canary = 'not-a-uuid'; });
    editJson(path.join(root, 'cases/fx-02-a/truth.json'), (t) => { t.report.verdict = 'overclaimed'; t.canary = '0f6d2b9e-41c7-4a53-8b1e-9a7c3d5e6f21'; });
    editJson(path.join(root, 'cases/fx-02-o/truth.json'), (t) => { t.report.false_claims = []; });
  });
  const got = rules(res);
  for (const want of ['fx-01-v:case.profile', 'fx-01:pair.task', 'fx-01-f:truth.region', 'fx-01-f:truth.origin', 'fx-01-f:truth.canary', 'fx-02-a:truth.report', 'fx-02-o:truth.report', 'fx-02-o:truth.canary']) assert.ok(got.includes(want), `expected ${want} in ${got.join(', ')}`);
});

test('a pair needs both variants and a proof project; proof references must resolve', async () => {
  const res = await lintMutated((root) => {
    fs.rmSync(path.join(root, 'cases/fx-02-a'), { recursive: true });
    editJson(path.join(root, 'cases/fx-01-v/truth.json'), (t) => { t.planted[0].proof = 'test/Vulnerable.t.sol:test_does_not_exist'; t.decoys[0].proof = 'test/Missing.t.sol:test_decoy_D1'; });
  });
  assert.deepEqual(rules(res), ['fx-01-v:truth.proof', 'fx-01-v:truth.proof', 'fx-02:pair.members']);
  const noProject = await lintMutated((root) => fs.rmSync(path.join(root, 'verify'), { recursive: true }));
  assert.ok(rules(noProject).includes('fx-01:pair.proof'));
});

test('a held case in bench/cases is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-lint-'));
  try {
    const dest = path.join(root, 'bench', 'cases');
    fs.cpSync(path.join(FIXTURES, 'cases'), dest, { recursive: true });
    editJson(path.join(dest, 'fx-01-v', 'case.json'), (c) => { c.visibility = 'held'; });
    const res = await lintCases(loadCases([dest]), {});
    assert.ok(rules(res).includes('fx-01-v:case.visibility'));
    assert.ok(rules(res).includes('fx-01:pair.task'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a challenge workspace may carry the programme rules, a changelog and a deployments manifest', async () => {
  const add = (root, id, name, text, list = true) => {
    fs.writeFileSync(path.join(root, 'cases', id, 'workspace', name), text);
    if (list) editJson(path.join(root, 'cases', id, 'case.json'), (c) => { c.files = [...c.files, name].sort(); });
  };
  // the three papers, the same in both drafts' workspaces: no error and no new warning
  const ok = await lintMutated((root) => {
    for (const id of ['fx-02-o', 'fx-02-a']) {
      add(root, id, 'programme.md', '# Bug bounty programme\n\nKnown issues: an exploit of K-01 is not eligible.\n');
      add(root, id, 'CHANGELOG.md', '## 1.2.0\n\n- hack week fixes\n');
      add(root, id, 'deployments.json', '{"mainnet":{"bank":"0x0000000000000000000000000000000000000001"}}\n');
    }
  });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.warnings.filter((w) => ['workspace.type', 'hint'].includes(w.rule) || /source files/.test(w.message)), [], 'the papers are neither odd file types, nor hint-scanned, nor counted as sources');

  // they still have to be listed, be the same in both twins, and keep the answer key out
  const bad = await lintMutated((root) => {
    add(root, 'fx-02-o', 'programme.md', '# Programme\n', false);
    add(root, 'fx-02-o', 'CHANGELOG.md', 'only in one draft\n');
    add(root, 'fx-02-a', 'CHANGELOG.md', 'different here\n');
    add(root, 'fx-02-o', 'deployments.json', '{"note":"see truth.json"}\n');
    add(root, 'fx-02-a', 'deployments.json', '{"note":"see truth.json"}\n');
  });
  const got = bad.errors.map((e) => `${e.scope}|${e.rule}|${e.message}`).join('\n');
  assert.match(got, /fx-02-o\|workspace\.extra\|.*programme\.md/);
  assert.match(got, /fx-02\|pair\.twin\|CHANGELOG\.md differs/);
  assert.match(got, /fx-02-o\|leak\|deployments\.json contains "truth\.json"/);

  // any other document, the papers in a subdirectory, and the papers in a find case are still flagged
  const odd = await lintMutated((root) => {
    for (const id of ['fx-02-o', 'fx-02-a']) { add(root, id, 'NOTES.md', 'notes\n'); fs.mkdirSync(path.join(root, 'cases', id, 'workspace', 'docs')); add(root, id, 'docs/programme.md', 'rules\n'); }
    for (const id of ['fx-01-v', 'fx-01-f']) add(root, id, 'programme.md', 'rules\n');
  });
  const types = odd.warnings.filter((w) => w.rule === 'workspace.type').map((w) => `${w.scope}|${w.message.split(': ')[1]}`).sort();
  assert.deepEqual(types, ['fx-01-f|programme.md', 'fx-01-v|programme.md', 'fx-02-a|NOTES.md', 'fx-02-a|docs/programme.md', 'fx-02-o|NOTES.md', 'fx-02-o|docs/programme.md']);
});

test('line diff hunks', () => {
  const a = ['one', 'two', 'three', 'four', 'five'];
  assert.deepEqual(diffHunks(a, a), []);
  assert.deepEqual(diffHunks(a, ['one', 'two', 'THREE', 'four', 'five']), [{ a: [2, 3], b: [2, 3] }]);
  assert.deepEqual(diffHunks(a, ['one', 'two', 'four', 'five']), [{ a: [2, 3], b: [2, 2] }]);
  assert.deepEqual(diffHunks(a, ['one', 'new', 'two', 'three', 'four', 'five']), [{ a: [1, 1], b: [1, 2] }]);
  assert.deepEqual(diffHunks(['x', 'call', 'check', 'zero', 'y'], ['x', 'zero', 'call', 'check', 'y']).length, 2, 'a moved line is an insertion plus a deletion');
});

test('glob, proof references and node test output', () => {
  assert.equal(matchGlob('sol-01-v', 'sol-*'), true);
  assert.equal(matchGlob('ts-01-v', 'sol-*,ts-0?-v'), true);
  assert.equal(matchGlob('ts-01-f', 'sol-*,ts-0?-v'), false);
  assert.equal(matchGlob('anything', null), true);
  assert.deepEqual(splitProofRef('test/Vulnerable.t.sol:test_planted_P1'), { file: 'test/Vulnerable.t.sol', test: 'test_planted_P1' });
  assert.equal(splitProofRef('no-colon'), null);
  for (const ref of ['test/Vulnerable.t.sol:test_planted_P1', 'verify/fx-01/test/Vulnerable.t.sol:test_planted_P1']) {
    const r = resolveProof(ref, { benchDir: FIXTURES, pair: 'fx-01' });
    assert.equal(r.rel, 'test/Vulnerable.t.sol', ref);
  }
  assert.equal(resolveProof('test/Nope.t.sol:x', { benchDir: FIXTURES, pair: 'fx-01' }).abs, null);
  const tap = parseNodeTestOutput('TAP version 13\nnot ok 1 - planted_P1\n    ok 1 - nested\nok 2 - decoy_D1 # time=3ms\nPAYDIRT_RESULT {"passed":["control_a"],"failed":[]}\n');
  assert.deepEqual(Object.fromEntries(tap), { planted_P1: 'fail', decoy_D1: 'pass', control_a: 'pass' });
  assert.deepEqual(Object.fromEntries(parseNodeTestOutput('ok      planted_P1\nnot ok  decoy_D1\n{"results":{"decoy_D2":"pass"}}')), { planted_P1: 'pass', decoy_D1: 'fail', decoy_D2: 'pass' });
});
