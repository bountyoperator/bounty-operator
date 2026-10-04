// The workbench modules, run under node: every decision that needs no DOM.
// The flows through a real browser are checked with Playwright against
// wrangler dev; this file pins the logic those flows rest on, the markup
// contract of the fragment, and the rules the app code has to keep (no markup
// parsing, tokens only, nothing key-like in a stored record).

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { CONTEXT_FIELDS, profileNeeds } from '../public/evidence.mjs';
import { PROFILES } from '../public/profiles.mjs';
import { PROVIDERS } from '../public/providers.mjs';
import { LIMITS, checkInputs, manifestFor } from '../public/review-core.mjs';
import {
  ACCEPT,
  EXTENSIONS,
  createIntake,
  hasTextExtension,
  isSkippedPath,
  meterText,
  planAdd,
  suggestName,
  summarizeErrors,
  uniqueName,
} from '../public/app/files.mjs';
import {
  buildTree,
  candidateFiles,
  defaultExtensions,
  extensionCounts,
  extensionOf,
  isTestPath,
  pickDefaults,
  reasonFrom,
  selectionSummary,
  visibleFiles,
} from '../public/app/github-ui.mjs';
import { historyRecord } from '../public/app/history.mjs';
import { PLACEHOLDER_EXAMPLE, deepLink, exampleList } from '../public/app/main.mjs';
import { cleanReply, pastedResult } from '../public/app/pasteback.mjs';
import { authUrl, challengeFor, newVerifier, reconcileVia } from '../public/app/providers-ui.mjs';
import {
  analyse,
  cellTone,
  issueMarkdown,
  manifestJson,
  orderSections,
  packetFor,
  packetName,
  sectionColumns,
  sectionKey,
  sectionShape,
  splitInline,
  stageFileName,
  textBlocks,
} from '../public/app/results.mjs';
import { failureFor, listedProfile, quotaLine } from '../public/app/run.mjs';
import { excerpt, fileForLabel } from '../public/app/source-pane.mjs';
import { snapshot } from '../public/app/state.mjs';
import {
  evidenceGroups,
  findingTarget,
  maskLine,
  profileGroups,
  promptFileName,
  stepStates,
  totals,
  warnSignature,
} from '../public/app/workbench.mjs';
import { WORKBENCH_STEPS, workbench, workbenchDialogs, workbenchScripts, workbenchStyles } from '../site/fragments/workbench.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

const APP_DIR = new URL('../public/app/', import.meta.url);
const CORE_MODULES = [
  'main.mjs', 'workbench.mjs', 'files.mjs', 'github-ui.mjs', 'providers-ui.mjs',
  'run.mjs', 'results.mjs', 'source-pane.mjs', 'pasteback.mjs', 'history.mjs',
];

const file = (name, content) => ({ name, content });
const lines = (count, text = 'x') => `${Array.from({ length: count }, () => text).join('\n')}\n`;

// ---------------------------------------------------------------------------
// Steps, profiles, evidence
// ---------------------------------------------------------------------------

describe('steps', () => {
  test('the stepper marks what is done, current and still to do', () => {
    assert.deepEqual(stepStates({ step: 'files', files: [], result: null }), { files: 'current', review: 'todo', results: 'todo' });
    assert.deepEqual(stepStates({ step: 'review', files: [file('a', 'b')], result: null }), { files: 'done', review: 'current', results: 'todo' });
    assert.deepEqual(stepStates({ step: 'results', files: [file('a', 'b')], result: {} }), { files: 'done', review: 'done', results: 'current' });
    // Back on Load with a result kept: nothing is shown as done ahead of the current step.
    assert.deepEqual(stepStates({ step: 'files', files: [file('a', 'b')], result: {} }), { files: 'current', review: 'todo', results: 'todo' });
    // A saved review opened read-only has no files of its own.
    assert.deepEqual(stepStates({ step: 'results', files: [], result: null }, { history: {} }), { files: 'todo', review: 'done', results: 'current' });
  });

  test('the fragment and the store agree on the three steps', () => {
    assert.deepEqual(WORKBENCH_STEPS.map((step) => step.id), ['files', 'review', 'results']);
    assert.deepEqual(WORKBENCH_STEPS.map((step) => step.label), ['Load', 'Run', 'Result']);
  });
});

describe('profile chooser', () => {
  test('every listed profile appears exactly once, and no unlisted one does', () => {
    const shown = profileGroups().flatMap((group) => group.profiles.map((profile) => profile.id));
    const listed = PROFILES.filter((profile) => profile.listed).map((profile) => profile.id);
    assert.deepEqual([...shown].sort(), [...listed].sort());
    assert.equal(new Set(shown).size, shown.length);
    assert.ok(!shown.includes('verdict') && !shown.includes('panel'));
  });

  test('groups are titled and none is empty', () => {
    for (const group of profileGroups()) {
      assert.ok(group.title.length > 3);
      assert.ok(group.profiles.length > 0);
    }
  });
});

describe('evidence form', () => {
  test('a profile is asked only for the fields it reads, plus notes', () => {
    for (const profile of PROFILES.filter((entry) => entry.listed)) {
      const asked = evidenceGroups(profile.id).flatMap((group) => group.fields.map((field) => field.key));
      const needed = profileNeeds(profile.id).context.map((field) => field.key);
      assert.deepEqual([...asked].sort(), [...new Set([...needed, 'notes'])].sort(), profile.id);
      assert.equal(new Set(asked).size, asked.length, `${profile.id}: a field is asked twice`);
    }
  });

  test('every Context field of the engine has a named group, so none lands under "More"', () => {
    const everything = { needs: CONTEXT_FIELDS.map((field) => `context:${field.key}`) };
    const titles = new Set();
    for (const profile of PROFILES) {
      for (const group of evidenceGroups(profile.id)) titles.add(group.title);
    }
    assert.ok(!titles.has('More'), 'a Context field has no group in EVIDENCE_GROUPS');
    assert.ok(everything.needs.length >= 7);
  });
});

// ---------------------------------------------------------------------------
// Privacy helpers
// ---------------------------------------------------------------------------

describe('privacy helpers', () => {
  test('masking a line keeps every line number and every line break', () => {
    const content = 'one\r\ntwo\nthree\rfour';
    const masked = maskLine(content, 2, 'AWS access key');
    assert.equal(masked, 'one\r\n[masked: AWS access key]\nthree\rfour');
    assert.equal(maskLine(content, 4, 'x'), 'one\r\ntwo\nthree\r[masked: x]');
    assert.equal(maskLine(content, 9, 'x'), content);
    assert.equal(maskLine(content, 0, 'x'), content);
  });

  test('a masked secret no longer blocks, and the scan never repeats the secret', () => {
    const secret = `AWS_KEY = "AKIA${'IOSFODNN7EXAMPLE'}"`;
    const files = [file('deploy.py', `import os\n\n${secret}\n`)];
    const before = checkInputs(files, '');
    assert.equal(before.blocking, 1);
    assert.ok(!JSON.stringify(before.findings).includes('IOSFODNN7'));

    const target = findingTarget(before.findings[0]);
    assert.deepEqual(target, { kind: 'line', index: 0, line: 3 });
    const after = checkInputs([file('deploy.py', maskLine(files[0].content, target.line, 'AWS access key'))], '');
    assert.equal(after.blocking, 0);
    assert.equal(after.warnings, 0);
  });

  test('a finding points at the thing that fixes it', () => {
    assert.deepEqual(findingTarget({ source: 'input-3', name: 'a.py', line: 12 }), { kind: 'line', index: 2, line: 12 });
    assert.deepEqual(findingTarget({ source: 'input-2-name', name: '.env', line: 0 }), { kind: 'file', index: 1 });
    assert.deepEqual(findingTarget({ source: 'context', name: 'notes', line: 1 }), { kind: 'context', field: 'notes' });
    assert.deepEqual(findingTarget({ source: 'instructions', name: 'instructions', line: 1 }), { kind: 'focus' });
  });

  test('an acceptance covers exactly the warnings that were shown', () => {
    const one = checkInputs([file('notes.md', 'mail alice.hunter@protonmail.com\n')], '');
    const two = checkInputs([file('notes.md', 'mail alice.hunter@protonmail.com\nand bob.smith@fastmail.com\n')], '');
    assert.equal(one.warnings, 1);
    assert.notEqual(warnSignature(one), '');
    assert.notEqual(warnSignature(one), warnSignature(two));
    assert.equal(warnSignature(checkInputs([file('a.sol', 'contract A {}\n')], '')), '');
    assert.equal(warnSignature(null), '');
  });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

describe('files', () => {
  test('the pickers accept the languages a hunter loads', () => {
    for (const extension of ['.sol', '.vy', '.rs', '.move', '.cairo', '.go', '.ts', '.js', '.py', '.yul', '.huff', '.circom', '.md', '.json', '.toml', '.yaml', '.txt']) {
      assert.ok(EXTENSIONS.includes(extension), extension);
      assert.ok(ACCEPT.split(',').includes(extension), extension);
    }
    assert.ok(hasTextExtension('src/Vault.T.SOL'));
    assert.ok(!hasTextExtension('logo.png'));
  });

  test('a folder drop leaves out dependencies, build output and lock files', () => {
    for (const path of ['node_modules/x/index.js', 'repo/.git/config', 'out/Vault.json', 'a/b/cache/x.json', 'package-lock.json', 'app/yarn.lock']) {
      assert.ok(isSkippedPath(path), path);
    }
    for (const path of ['src/Vault.sol', 'test/Vault.t.sol', 'README.md', 'outbox/a.ts']) assert.ok(!isSkippedPath(path), path);
  });

  test('a bad file is named with its reason and the rest of the batch is kept', () => {
    const plan = planAdd([], [
      file('src/Vault.sol', 'contract Vault {}\n'),
      file('../escape.sol', 'x'),
      file('empty.sol', '   \n'),
      file('binary.bin', 'a\0b'),
      file('big.sol', 'x'.repeat(LIMITS.fileBytes + 1)),
      file('ok.md', '# notes\n'),
    ]);
    assert.deepEqual(plan.added, ['src/Vault.sol', 'ok.md']);
    assert.deepEqual(plan.files.map((entry) => entry.name), ['src/Vault.sol', 'ok.md']);
    const reasons = Object.fromEntries(plan.errors.map((error) => [error.name, error.reason]));
    assert.match(reasons['../escape.sol'], /name/);
    assert.match(reasons['empty.sol'], /empty/);
    assert.match(reasons['binary.bin'], /not UTF-8 text/);
    assert.match(reasons['big.sol'], /120 KB/);
  });

  test('the count, size and line limits are the engine limits', () => {
    const many = Array.from({ length: LIMITS.files + 2 }, (unused, index) => file(`f${index}.sol`, 'a\n'));
    const counted = planAdd([], many);
    assert.equal(counted.files.length, LIMITS.files);
    assert.equal(counted.errors.length, 2);
    assert.match(counted.errors[0].reason, /50 files is the limit/);

    const big = 'x'.repeat(100000);
    const sized = planAdd([], [file('a.txt', big), file('b.txt', big), file('c.txt', big)]);
    assert.deepEqual(sized.added, ['a.txt', 'b.txt']);
    assert.match(sized.errors[0].reason, /240 KB total is full/);

    const long = planAdd([], [file('a.txt', lines(15000)), file('b.txt', lines(6000))]);
    assert.deepEqual(long.added, ['a.txt']);
    assert.match(long.errors[0].reason, /20,000-line total is full/);

    // What planAdd accepts, the engine accepts.
    assert.doesNotThrow(() => checkInputs(counted.files, ''));
    assert.doesNotThrow(() => checkInputs(sized.files, ''));
    assert.doesNotThrow(() => checkInputs(long.files, ''));
  });

  test('a file with a loaded name replaces it and frees its room', () => {
    const current = [file('a.txt', 'x'.repeat(100000)), file('b.txt', 'x'.repeat(100000))];
    const plan = planAdd(current, [file('a.txt', 'y'.repeat(110000))]);
    assert.deepEqual(plan.replaced, ['a.txt']);
    assert.deepEqual(plan.added, []);
    assert.equal(plan.files.length, 2);
    assert.equal(plan.files[0].content[0], 'y');
    assert.equal(current[0].content[0], 'x', 'the current list is not mutated');
  });

  test('an intake says when it is full, so a folder read can stop early', () => {
    const intake = createIntake(Array.from({ length: LIMITS.files }, (unused, index) => file(`f${index}.sol`, 'a\n')));
    assert.equal(intake.full, true);
    assert.equal(createIntake([]).full, false);
  });

  test('pasted text is named from what it is', () => {
    assert.equal(suggestName('pragma solidity ^0.8.20;\ncontract Vault {\n  function f() external {}\n}'), 'Vault.sol');
    assert.equal(suggestName('import os\n\n# helper\ndef run(x):\n    total = 0\n    total += x\n    return total\n'), 'pasted.py');
    assert.equal(suggestName('use std::fmt;\n\npub fn main() {\n    let x = 1;\n}\n'), 'pasted.rs');
    assert.equal(suggestName('package main\n\nfunc main() {\n\tprintln("x")\n}\n'), 'pasted.go');
    assert.equal(suggestName('{"version":"2.1.0","runs":[]}'), 'scan.sarif.json');
    assert.equal(suggestName('{"results":{"detectors":[]}}'), 'tool-output.json');
    assert.equal(suggestName('# Reentrancy in withdraw\n\nThe vault sends ETH first. An attacker re-enters.\n\n```solidity\ncontract A {}\n```\n', { wantsDraft: true }), 'draft-report.md');
    assert.equal(suggestName('The claim holds. I checked it twice.'), 'notes.md');
    assert.equal(suggestName('just words'), 'pasted.txt');
    assert.equal(suggestName(''), 'pasted.txt');
  });

  test('a suggested name never collides with a loaded file', () => {
    assert.equal(suggestName('contract Vault {\n}\n', { existing: ['Vault.sol'] }), 'Vault-2.sol');
    assert.equal(suggestName('# Report\n\nIt breaks. Here is why.\n', { existing: ['draft-report.md'], wantsDraft: true }), 'notes.md');
    assert.equal(uniqueName('src/Vault.t.sol', ['src/Vault.t.sol', 'src/Vault-2.t.sol']), 'src/Vault-3.t.sol');
    assert.equal(uniqueName('Makefile', ['Makefile']), 'Makefile-2');
    assert.equal(uniqueName('a.sol', []), 'a.sol');
  });

  test('the meter reads as one line against the limits', () => {
    assert.equal(meterText({ bytes: 148000, files: 12, lines: 3210 }), '148 / 240 KB · 12 / 50 files · 3,210 lines');
    assert.equal(meterText({ bytes: 812, files: 1, lines: 10 }), '812 B / 240 KB · 1 / 50 files · 10 lines');
    assert.deepEqual(totals([file('a', 'one\ntwo\n'), file('b', 'x')]), { files: 2, bytes: 9, lines: 3 });
  });

  test('a long run of one reason is folded into one line', () => {
    const errors = Array.from({ length: 40 }, (unused, index) => ({ name: `f${index}.sol`, reason: 'was left out: 50 files is the limit' }));
    const folded = summarizeErrors([...errors, { name: 'x.bin', reason: 'is not UTF-8 text' }]);
    assert.equal(folded.length, 6);
    assert.deepEqual(folded[4], { name: '36 more files', reason: 'were left out: 50 files is the limit' });
    assert.deepEqual(folded[5], { name: 'x.bin', reason: 'is not UTF-8 text' });
  });
});

// ---------------------------------------------------------------------------
// GitHub picker
// ---------------------------------------------------------------------------

describe('GitHub picker', () => {
  const tree = [
    { path: 'README.md', size: 900 },
    { path: 'src/Vault.sol', size: 4000 },
    { path: 'src/libs/Math.sol', size: 2000 },
    { path: 'src/periphery/Router.sol', size: 3000 },
    { path: 'test/Vault.t.sol', size: 5000 },
    { path: 'src/mocks/MockToken.sol', size: 800 },
    { path: 'lib/forge-std/src/Test.sol', size: 9000 },
    { path: 'docs/logo.png', size: 50000 },
    { path: 'node_modules/x/index.js', size: 100 },
    { path: 'src/Huge.sol', size: LIMITS.fileBytes + 1 },
  ];

  test('extensions and the test preset', () => {
    assert.equal(extensionOf('src/Vault.t.sol'), '.sol');
    assert.equal(extensionOf('Makefile'), '');
    assert.equal(extensionOf('.env'), '');
    for (const path of ['test/Vault.t.sol', 'src/mocks/MockToken.sol', 'lib/forge-std/src/Test.sol', 'src/Vault.t.sol', 'a/vault.test.ts', 'a/VaultTest.sol', 'script/Deploy.s.sol']) {
      assert.ok(isTestPath(path), path);
    }
    for (const path of ['src/Vault.sol', 'src/libraries/Math.sol', 'contracts/Testament.sol', 'src/protest/A.sol']) assert.ok(!isTestPath(path), path);
  });

  test('only text files under the linked folder are offered', () => {
    const all = candidateFiles(tree).map((entry) => entry.path);
    assert.ok(!all.includes('docs/logo.png') && !all.includes('node_modules/x/index.js'));
    assert.deepEqual(candidateFiles(tree, 'src').map((entry) => entry.path), ['src/Vault.sol', 'src/libs/Math.sol', 'src/periphery/Router.sol', 'src/mocks/MockToken.sol', 'src/Huge.sol']);
    assert.deepEqual(candidateFiles(tree, 'sr'), []);
  });

  test('code is shown at the start; docs only when there is nothing else', () => {
    const counts = extensionCounts(candidateFiles(tree));
    assert.equal(counts[0].extension, '.sol');
    assert.deepEqual([...defaultExtensions(counts)], ['.sol']);
    assert.deepEqual([...defaultExtensions([{ extension: '.md', count: 3 }])], ['.md']);
  });

  test('filters, defaults and the folder tree', () => {
    const candidates = candidateFiles(tree, 'src');
    const visible = visibleFiles(candidates, { extensions: new Set(['.sol']), skipTests: true, search: '' });
    assert.deepEqual(visible.map((entry) => entry.path), ['src/Vault.sol', 'src/periphery/Router.sol', 'src/Huge.sol']);
    assert.deepEqual(visibleFiles(candidates, { extensions: new Set(['.sol']), skipTests: true, search: 'ROUTER' }).map((entry) => entry.path), ['src/periphery/Router.sol']);
    assert.deepEqual(visibleFiles(candidates, { extensions: new Set(['.sol']), skipTests: false, search: '', only: new Set(['src/Vault.sol']) }).map((entry) => entry.path), ['src/Vault.sol']);

    // Everything that fits is ticked; a file over the per-file limit never is.
    assert.deepEqual([...pickDefaults(visible, { files: 50, bytes: 240000 })], ['src/Vault.sol', 'src/periphery/Router.sol']);
    assert.equal(pickDefaults(visible, { files: 1, bytes: 240000 }).size, 0);
    assert.equal(pickDefaults(visible, { files: 50, bytes: 5000 }).size, 0);

    const root = buildTree(visible, 'src');
    assert.deepEqual(root.files.map((entry) => entry.name), ['Vault.sol', 'Huge.sol']);
    assert.deepEqual([...root.dirs.keys()], ['periphery']);
    assert.equal(root.dirs.get('periphery').path, 'src/periphery');
    assert.equal(buildTree(candidateFiles(tree)).dirs.get('src').dirs.get('periphery').files[0].path, 'src/periphery/Router.sol');
  });

  test('the meter counts the selection with what is already loaded', () => {
    const sizes = new Map([['src/A.sol', 100000], ['src/B.sol', 100000], ['src/C.sol', 68000]]);
    const existing = { files: 2, bytes: 40000, lines: 1000, names: new Set(['src/A.sol']) };
    const fits = selectionSummary(new Set(['src/A.sol', 'src/B.sol']), sizes, existing);
    assert.equal(fits.files, 3, 'a file that is already loaded is replaced, not counted twice');
    assert.deepEqual(fits.over, []);
    assert.match(fits.text, /^240 \/ 240 KB · 3 \/ 50 files · about [\d,]+ lines$/);

    const over = selectionSummary(new Set(sizes.keys()), sizes, existing);
    assert.deepEqual(over.over, ['size']);
    const none = selectionSummary(new Set(), sizes, { files: 0, bytes: 0, lines: 0 });
    assert.equal(none.text, '0 B / 240 KB · 0 / 50 files · about 0 lines');
  });

  test('an import error reads as a clause after the file name', () => {
    assert.equal(reasonFrom('src/a.bin', 'src/a.bin is not UTF-8 text.'), 'is not UTF-8 text');
    assert.equal(reasonFrom('src/a.sol', 'GitHub rate limit reached. A token raises the limit.'), 'could not be fetched: GitHub rate limit reached. A token raises the limit');
    assert.equal(reasonFrom('src/a.sol', ''), 'could not be fetched');
  });
});

// ---------------------------------------------------------------------------
// Providers and OpenRouter connect
// ---------------------------------------------------------------------------

describe('providers', () => {
  test('the PKCE challenge is S256 of the verifier (RFC 7636, appendix B)', async () => {
    assert.equal(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('a verifier is 43 URL-safe characters and never repeats', () => {
    const first = newVerifier();
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, newVerifier());
  });

  test('the consent link carries the callback and the challenge, and nothing else', () => {
    const url = new URL(authUrl('https://bountyoperator.com/', 'abc-123'));
    assert.equal(url.origin + url.pathname, 'https://openrouter.ai/auth');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['callback_url', 'code_challenge', 'code_challenge_method']);
    assert.equal(url.searchParams.get('callback_url'), 'https://bountyoperator.com/');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  });

  test('the "run with" choice follows the stored provider', () => {
    assert.deepEqual(reconcileVia('export', 'connect', 'anthropic'), { via: 'export', keyProvider: 'anthropic' });
    assert.deepEqual(reconcileVia('openrouter', 'connect', 'anthropic'), { via: 'connect', keyProvider: 'anthropic' });
    assert.deepEqual(reconcileVia('openrouter', 'key', 'anthropic'), { via: 'key', keyProvider: 'openrouter' });
    assert.deepEqual(reconcileVia('openai', 'connect', 'anthropic'), { via: 'key', keyProvider: 'openai' });
    assert.deepEqual(reconcileVia('openai', 'export', 'anthropic'), { via: 'key', keyProvider: 'openai' });
    assert.deepEqual(reconcileVia('nonsense', 'key', 'nonsense'), { via: 'key', keyProvider: PROVIDERS[0].id });
  });
});

// ---------------------------------------------------------------------------
// The run: failures and allowance
// ---------------------------------------------------------------------------

describe('run failures', () => {
  const failure = (code, data = {}, message = 'Server text.') => failureFor({ code, message, data });

  test('the allowance, the privacy stops and sign-in each get their own handling', () => {
    assert.equal(failure('daily_used', { resetsAt: '2026-10-03T00:00:00.000Z' }).upgrade, true);
    assert.equal(failure('privacy_warn', { findings: [] }).warn, true);
    assert.equal(failure('privacy_block', { findings: [] }).block, true);
    assert.equal(failure('signin').signin, true);
    assert.match(failure('review_running').message, /already running/);
  });

  test('a gauntlet or panel profile refused for the plan offers Operator, and leaves the daily review alone', () => {
    const refused = failure('operator_only', { profile: 'verdict', upgradeUrl: 'https://bountyoperator.com/pricing' }, 'Final verdict is the last stage of the gauntlet, which runs on Operator.');
    assert.deepEqual(refused, { message: 'Final verdict is the last stage of the gauntlet, which runs on Operator.', tone: 'warn', upgrade: true, operatorOnly: true });
    assert.equal(failure('daily_used').operatorOnly, undefined);
  });

  test('a single run takes a listed profile only', () => {
    for (const id of ['general', 'solidity', 'report', 'scope', 'triage', 'scanner']) assert.equal(listedProfile(id), true, id);
    for (const id of ['verdict', 'panel', 'no-such-profile', '', undefined]) assert.equal(listedProfile(id), false, String(id));
  });

  test('a withheld answer shows the server sentence on the model field', () => {
    const sentence = 'The model repeated its instructions instead of reviewing, so the answer was stopped and the call used one review. Run it again or choose a stronger model.';
    assert.deepEqual(failure('output_withheld', {}, sentence), { message: sentence, tone: 'error', field: 'model' });
  });

  test('a provider failure lands on the field that fixes it', () => {
    assert.equal(failure('bad_key').field, 'key');
    assert.equal(failureFor({ code: 'bad_key', message: 'x', data: {} }, 'connect').field, 'connect');
    assert.equal(failure('bad_model').field, 'model');
    assert.equal(failure('provider', { kind: 'auth' }).field, 'key');
    assert.equal(failure('provider', { kind: 'model' }).field, 'model');
    assert.match(failureFor({ code: 'provider', message: 'Provider rejected the key.', data: { kind: 'auth' } }, 'connect').message, /connect OpenRouter again/);
    const limited = failure('provider', { kind: 'rate', retryAfter: 30 }, 'Provider rate limit reached.');
    assert.equal(limited.field, undefined);
    assert.equal(limited.message, 'Provider rate limit reached. Try again in 30 seconds.');
    assert.match(failure('rate_limited', { retryAfter: 240 }).message, /Try again in 4 minutes/);
  });

  test('text that arrived before a failure is offered, when there is enough of it', () => {
    const partial = `# Review\n${'x'.repeat(500)}`;
    assert.equal(failure('stream_ended', { partial }).partial, partial);
    assert.equal(failure('aborted', { partial }).partial, partial);
    assert.equal(failure('timeout', { partial: 'short' }).partial, undefined);
    assert.equal(failure('aborted').message, 'Stopped. No review was produced.');
    assert.equal(failure('network').tone, 'error');
  });

  test('an unknown code shows the server sentence', () => {
    assert.equal(failure('something_new', {}, 'Exactly this.').message, 'Exactly this.');
    assert.match(failureFor({}).message, /did not finish/);
  });

  test('the allowance line and the used-up state', () => {
    const base = { loaded: true, signedIn: true, csrf: 'x', billing: 'live', hasSubscription: false, limits: null, price: null, version: '' };
    const usage = (plan, remainingToday) => ({ plan, usedToday: 0, remainingToday, running: 0, concurrency: 1, resetsAt: '2026-10-03T00:00:00.000Z', paidUntil: null });
    assert.deepEqual(quotaLine({ ...base, loaded: false, signedIn: false, usage: null }), { text: '', used: false, pastDue: false });
    assert.match(quotaLine({ ...base, signedIn: false, usage: null }).text, /1 free review a day/);
    assert.deepEqual(quotaLine({ ...base, usage: usage('free', 1) }), { text: 'Free plan: 1 review left today.', used: false, pastDue: false });
    assert.equal(quotaLine({ ...base, usage: usage('free', 0) }).used, true);
    assert.deepEqual(quotaLine({ ...base, usage: usage('weekly', null) }), { text: 'Operator: unlimited reviews.', used: false, pastDue: false });
    const pastDue = quotaLine({ ...base, usage: usage('past_due', 0) });
    assert.equal(pastDue.used, true);
    assert.equal(pastDue.pastDue, true);
  });
});

// ---------------------------------------------------------------------------
// Paste-back
// ---------------------------------------------------------------------------

describe('paste-back', () => {
  test('a pasted reply becomes the same result shape as a hosted run', () => {
    const now = new Date('2026-10-02T12:00:00.000Z');
    const profile = PROFILES.find((entry) => entry.id === 'solidity');
    const result = pastedResult({ reply: '﻿Hi\r\n# Review\r\nVerdict: drop\r\n', model: ' gpt-6-astra ', profile, mode: 'own-code', manifest: [], now });
    assert.equal(result.source, 'pasted');
    assert.equal(result.review, 'Hi\n# Review\nVerdict: drop');
    assert.equal(result.model, 'gpt-6-astra');
    assert.equal(result.mode, 'own-code');
    assert.deepEqual(result.profile, { id: 'solidity', name: 'Solidity review' });
    assert.equal(result.timestamp, '2026-10-02T12:00:00.000Z');
    assert.equal(result.provider, '');
    // The stored snapshot keeps it.
    assert.deepEqual(snapshot({ files: [], focus: '', context: {}, profile: 'solidity', mode: 'own-code', provider: 'export', model: '', step: 'results', result }).result, result);
  });

  test('a fixed-mode profile decides the mode, and a model name with spaces is dropped', () => {
    const report = PROFILES.find((entry) => entry.id === 'report');
    const result = pastedResult({ reply: 'x', model: 'some chat app', profile: report, mode: 'own-code', manifest: [] });
    assert.equal(result.mode, 'bounty');
    assert.equal(result.model, '');
    assert.equal(cleanReply(null), '');
  });
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

describe('the placeholder example', () => {
  test('parses, cites only real lines, states its own counts and passes the privacy scan', async () => {
    const example = PLACEHOLDER_EXAMPLE;
    const manifest = await manifestFor(example.files);
    const analysis = analyse({ review: example.review, manifest });
    assert.equal(analysis.parsed.ok, true);
    assert.equal(analysis.parsed.verdict, 'fix-before-deploy');
    assert.equal(analysis.parsed.findings.length, 2);
    assert.deepEqual(analysis.problems, []);
    assert.ok(analysis.refCount >= 10);
    assert.deepEqual({ ...analysis.parsed.counts }, { ...analysis.parsed.statedCounts });
    assert.ok(analysis.parsed.headline.length <= 140);
    for (const finding of analysis.parsed.findings) {
      assert.ok(finding.locations.length > 0 && finding.path.length > 0 && finding.fix && finding.test && finding.next, finding.id);
    }

    const coverage = checkInputs(example.files.map((entry) => ({ ...entry })), example.focus, example.context);
    assert.equal(coverage.blocking + coverage.warnings, 0);
    assert.ok(PROFILES.some((profile) => profile.id === example.profile && profile.listed));
  });

  test('an example module in the old shape falls back to the placeholder; the v0.7 shape is used', () => {
    assert.deepEqual(exampleList({ EXAMPLE: { files: [file('a.py', 'x')], instructions: 'old', review: '# Example report' } }), [PLACEHOLDER_EXAMPLE]);
    assert.deepEqual(exampleList(null), [PLACEHOLDER_EXAMPLE]);
    const entry = { id: 'tidal', title: 'T', profile: 'solidity', mode: 'own-code', files: [file('T.sol', 'contract T {}\n')], focus: '', context: {}, review: '# Review\nVerdict: no-blocking-issues\n', model: 'm', generatedAt: '2026-10-02T00:00:00.000Z' };
    assert.deepEqual(exampleList({ EXAMPLES: [entry, { id: 'broken' }] }), [entry]);
    assert.deepEqual(exampleList({ default: [entry] }), [entry]);
    assert.deepEqual(exampleList({ EXAMPLE: entry }), [entry]);
  });
});

describe('deep links', () => {
  test('?profile and ?start name a listed profile; anything else is ignored', () => {
    assert.deepEqual(deepLink('?profile=triage'), { profile: 'triage', example: false, exampleId: '' });
    assert.deepEqual(deepLink('?start=report'), { profile: 'report', example: false, exampleId: '' });
    // v0.6 links carried the Solidity profile under a prefixed id.
    assert.equal(deepLink('?profile=v06-solidity').profile, 'solidity');
    assert.equal(deepLink('?profile=verdict').profile, '');
    assert.equal(deepLink('?profile=%3Cscript%3E').profile, '');
    assert.deepEqual(deepLink('?start=example'), { profile: '', example: true, exampleId: '' });
    assert.deepEqual(deepLink('?checkout=complete&session_id=cs_x'), { profile: '', example: false, exampleId: '' });
  });
});

describe('result analysis', () => {
  const manifest = [{ label: 'input-1/Vault.sol', bytes: 600, sha256: 'a'.repeat(64), lines: 21 }];
  const review = [
    '# Review', 'Verdict: prove-first', 'Mode: bounty', 'Counts: critical=0 high=1 medium=0 hardening=1 checked-safe=0',
    'Headline: The mint math is off.', '',
    '## Claims', '- C1 | confirmed | input-1/Vault.sol:9 | Mint uses the post-deposit balance', '- C2 | contradicted | input-1/Vault.sol:16 | No reentrancy', '',
    '## F-1: Mint divides by the wrong balance', 'Severity: high', 'Basis: needs-test', 'Location: input-1/Vault.sol:9; input-1/Vault.sol:140; input-9/Ghost.sol:3',
    'Impact: Later depositors lose value.', 'Path:', '1. Deposit 1 ETH.', '2. See `input-1/Vault.sol:9`.', 'Counterargument: Seeded by the team | open | Not shown',
    'Gap: A fork test.', 'Fix: Subtract msg.value.', 'Test:', '```solidity', 'function test() public {}', '```', 'Next: Write the test.', '',
    '## Hardening', '- Zero mint | input-1/Vault.sol:9-10 | Revert on zero', '',
    '## Coverage', 'Reviewed: input-1/Vault.sol', 'Not supplied: tests',
  ].join('\n');

  test('references outside the supplied files are found and keyed', () => {
    const analysis = analyse({ review, manifest });
    assert.equal(analysis.parsed.ok, true);
    assert.deepEqual(analysis.problems.map((entry) => entry.problem).sort(), ['line-out-of-range', 'unknown-file']);
    assert.equal(analysis.problemAt.get('input-1/Vault.sol:140-140'), 'line-out-of-range');
    assert.equal(analysis.problemAt.get('input-9/Ghost.sol:3-3'), 'unknown-file');
    assert.equal(analysis.problemAt.get('input-1/Vault.sol:9-9'), undefined);
  });

  test('a reply outside the format is not parsed, and still analysed without throwing', () => {
    const analysis = analyse({ review: 'I could not review this.', manifest });
    assert.equal(analysis.parsed.ok, false);
    assert.deepEqual(analysis.problems, []);
    assert.equal(analyse(null).parsed.ok, false);
  });

  test('sections become tables, lists, fields or blocks', () => {
    const { parsed } = analyse({ review, manifest });
    const byTitle = Object.fromEntries(parsed.sections.map((section) => [sectionKey(section.title), sectionShape(section)]));
    assert.equal(byTitle.claims.kind, 'table');
    assert.deepEqual(byTitle.claims.columns, ['Claim', 'Status', 'Location', 'What it says, and why']);
    assert.equal(byTitle.hardening.kind, 'table');
    assert.equal(byTitle.coverage.kind, 'fields');
    assert.deepEqual(byTitle.coverage.fields, [['Reviewed', 'input-1/Vault.sol'], ['Not supplied', 'tests']]);

    assert.deepEqual(sectionShape({ title: 'Open questions', rows: [['Who seeds it'], ['What pauses it']], text: '' }), { kind: 'list', items: ['Who seeds it', 'What pauses it'] });
    const ragged = sectionShape({ title: 'Unknown', rows: [['a', 'b', 'c'], ['d']], text: '' });
    assert.equal(ragged.columns, null);
    assert.deepEqual(ragged.rows[1], ['d', '', '']);
    const blocks = sectionShape({ title: 'PoC plan', rows: null, text: 'Run this:\n\n```solidity\ncontract T {}\n```\n\nThen read the balance.' });
    assert.deepEqual(blocks.blocks.map((block) => block.type), ['p', 'code', 'p']);
    assert.equal(blocks.blocks[1].language, 'solidity');
  });

  test('every table a profile defines has column names of the right width', () => {
    const checkedTitles = [];
    for (const profile of PROFILES) {
      const formatLines = `${profile.extraFormat}\n## Hardening\n- a | b | c\n## Checked and safe\n- a | b | c`.split('\n');
      let title = '';
      for (const line of formatLines) {
        if (line.startsWith('## ')) title = line.slice(3).trim();
        else if (line.startsWith('- ') && line.includes(' | ')) {
          const width = line.slice(2).split(' | ').length;
          assert.ok(sectionColumns(title, width), `${profile.id}: "${title}" has no ${width}-column header`);
          assert.equal(sectionColumns(title, width).length, width);
          checkedTitles.push(title);
        }
      }
    }
    assert.ok(checkedTitles.length > 20);
    assert.equal(sectionColumns('Entry points', 9), null);
    assert.deepEqual(sectionColumns('Checked & Safe (2)', 3), ['Item', 'Location', 'Why it holds']);
  });

  test('supporting sections go below the findings, coverage last', () => {
    const titles = ['Coverage', 'Claims', 'Hardening', 'Entry points', 'Checked and safe', 'Rejection reasons'].map((title) => ({ title, rows: null, text: '' }));
    const { lead, tail } = orderSections(titles);
    assert.deepEqual(lead.map((section) => section.title), ['Claims', 'Rejection reasons']);
    assert.deepEqual(tail.map((section) => section.title), ['Entry points', 'Hardening', 'Checked and safe', 'Coverage']);
    assert.deepEqual(orderSections(undefined), { lead: [], tail: [] });
  });

  test('fixed values in a cell get a tone; prose does not', () => {
    assert.equal(cellTone('confirmed'), 'observed');
    assert.equal(cellTone(' Contradicted '), 'danger');
    assert.equal(cellTone('not-supplied'), 'unproven');
    assert.equal(cellTone('Mint uses the post-deposit balance'), '');
    assert.equal(cellTone(''), '');
  });

  test('inline text is split into text, code, strong and cited locations, and nothing else', () => {
    const labels = ['input-1/Vault.sol'];
    assert.deepEqual(splitInline('See `input-1/Vault.sol:9-10` and input-1/Vault.sol:16, then **stop**.', labels), [
      { type: 'text', text: 'See ' },
      { type: 'ref', ref: { label: 'input-1/Vault.sol', start: 9, end: 10 } },
      { type: 'text', text: ' and ' },
      { type: 'ref', ref: { label: 'input-1/Vault.sol', start: 16, end: 16 } },
      { type: 'text', text: ', then ' },
      { type: 'strong', text: 'stop' },
      { type: 'text', text: '.' },
    ]);
    assert.deepEqual(splitInline('`balanceOf[msg.sender]` is read', labels)[0], { type: 'code', text: 'balanceOf[msg.sender]' });
    // Markup and links in model output stay text.
    const hostile = '<img src=x onerror=alert(1)> [click](javascript:alert(1)) ![x](https://evil.example/p.png)';
    assert.deepEqual(splitInline(hostile, labels), [{ type: 'text', text: hostile }]);
    assert.deepEqual(splitInline('', labels), []);
  });

  test('text blocks keep fenced code apart, closed or not', () => {
    assert.deepEqual(textBlocks('a\nb\n\n~~~\ncode\n~~~\nc'), [{ type: 'p', text: 'a\nb' }, { type: 'code', code: 'code', language: '' }, { type: 'p', text: 'c' }]);
    assert.deepEqual(textBlocks('```js\nunclosed'), [{ type: 'code', code: 'unclosed', language: 'js' }]);
    assert.deepEqual(textBlocks(''), []);
  });

  test('shorthand citations link to the supplied file and keep unknown locations visible', () => {
    const labels = ['input-1/draft.md'];
    assert.deepEqual(splitInline('See `input-1:2-3`, input-1:4 and input-9:1.', labels), [
      { type: 'text', text: 'See ' },
      { type: 'ref', ref: { label: 'input-1/draft.md', start: 2, end: 3 } },
      { type: 'text', text: ', ' },
      { type: 'ref', ref: { label: 'input-1/draft.md', start: 4, end: 4 } },
      { type: 'text', text: ' and ' },
      { type: 'ref', ref: { label: 'input-9', start: 1, end: 1 } },
      { type: 'text', text: '.' },
    ]);
    const prose = 'xinput-1:2 src/input-1:2 input-1:1234567890';
    assert.deepEqual(splitInline(prose, labels), [{ type: 'text', text: prose }]);
  });

  test('the issue body, the manifest and the packet', async () => {
    const result = { review, manifest, profile: { id: 'report', name: 'Challenge a draft report' }, mode: 'bounty', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', source: 'ai', timestamp: '2026-10-02T14:05:09.000Z' };
    const analysis = analyse(result);

    const issue = issueMarkdown(result, analysis);
    assert.match(issue, /^# Mint divides by the wrong balance\n/);
    assert.match(issue, /- Location: `input-1\/Vault\.sol:9`/);
    assert.match(issue, /\*\*Fix\*\*\n\nSubtract msg\.value\./);
    assert.ok(!issue.includes('## F-1'), 'a single finding is the issue itself');
    const hostile = issueMarkdown({ ...result, review: review.replace('Later depositors lose value.', 'Bad <script>x</script> ![p](https://evil.example/a.png)') });
    assert.ok(!hostile.includes('<script>') && !hostile.includes('![p]('));
    assert.equal(issueMarkdown({ ...result, review: 'free text <b>x</b>' }), 'free text &lt;b>x&lt;/b>\n');

    const json = JSON.parse(manifestJson(result, analysis));
    assert.deepEqual(json.files, manifest);
    assert.equal(json.verdict, 'prove-first');
    assert.equal(json.verify, 'https://bountyoperator.com/tools/verify');
    assert.ok(!('apiKey' in json));

    const packet = packetFor(result, { target: 'Example', version: 'abc' }, analysis);
    assert.match(packet, /Produced by: Hosted review by OpenRouter \/ anthropic\/claude-sonnet-5\.5\./);
    assert.match(packet, /## Reference check\n- input-1\/Vault\.sol:140 · line is outside the file/);
    assert.match(packet, /Verify: https:\/\/bountyoperator\.com\/tools\/verify\n$/);
    // A Context value the engine refuses must not cost the user the packet.
    assert.match(packetFor(result, { proof: 'nonsense' }, analysis), /^# Bounty Operator review packet/);

    assert.equal(packetName(result), 'bounty-operator-report-20261002-1405.md');
    assert.equal(packetName(result, 'json'), 'bounty-operator-report-20261002-1405.json');
    assert.match(packetName({}), /^bounty-operator-review-\d{8}-\d{4}\.md$/);
    assert.equal(promptFileName('prior-art'), 'bounty-operator-prompt-prior-art.md');
  });

  test('the review travels to the next profile as a numbered stage file', () => {
    assert.equal(stageFileName([], 'report'), 'stage-1-report.md');
    assert.equal(stageFileName([file('Vault.sol', ''), file('stage-1-report.md', '')], 'triage'), 'stage-2-triage.md');
    assert.equal(stageFileName([file('stage-1-report.md', ''), file('stage-2-report.md', '')], 'report'), 'stage-3-report.md');
  });
});

describe('source pane', () => {
  const files = [file('Vault.sol', lines(40, 'line')), file('src/A.sol', 'a\nb\nc\n')];
  const manifest = [{ label: 'input-1/Vault.sol' }, { label: 'input-2/src/A.sol' }];

  test('a label opens the file it was written about, and only that file', () => {
    assert.equal(fileForLabel('input-2/src/A.sol', files, manifest), files[1]);
    assert.equal(fileForLabel('input-1/Vault.sol', files, []), files[0]);
    assert.equal(fileForLabel('input-2/Vault.sol', files, manifest), null);
    assert.equal(fileForLabel('input-3/Missing.sol', files, manifest), null);
    // The file at that position was replaced by another one since the review.
    assert.equal(fileForLabel('input-1/Vault.sol', [file('Other.sol', 'x'), files[1]], manifest), null);
  });

  test('the excerpt marks the cited lines and adds context inside the file', () => {
    const view = excerpt(files[0].content, { start: 10, end: 12 }, 3);
    assert.deepEqual(view.lines.map((line) => line.n), [7, 8, 9, 10, 11, 12, 13, 14, 15]);
    assert.deepEqual(view.lines.filter((line) => line.cited).map((line) => line.n), [10, 11, 12]);
    assert.equal(excerpt(files[1].content, { start: 1, end: 1 }, 6).lines.length, 3);
    assert.equal(excerpt(files[0].content, { start: 5, end: 5 }, Infinity).lines.length, 40);
    assert.deepEqual(excerpt(files[1].content, { start: 2, end: 2 }, 0).lines, [{ n: 2, text: 'b', cited: true }]);
  });
});

describe('history', () => {
  test('a stored record holds the packet, the manifest and facts, and nothing else', () => {
    const result = {
      review: '# Review\nVerdict: drop\n',
      manifest: [{ label: 'input-1/Vault.sol', bytes: 10, sha256: 'b'.repeat(64), lines: 2, content: 'contract Vault {}' }],
      profile: { id: 'report', name: 'Challenge a draft report' },
      mode: 'bounty',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      truncated: false,
      refused: false,
      source: 'ai',
      timestamp: '2026-10-02T14:05:09.000Z',
      apiKey: 'sk-should-never-be-here-0123456789',
      files: [file('Vault.sol', 'contract Vault {}')],
    };
    const record = historyRecord({ result, packet: '# Bounty Operator review packet\n', verdict: 'drop', headline: 'Nothing holds.', counts: { critical: 0, high: 0, medium: 0, hardening: 1, checkedSafe: 0 }, now: new Date('2026-10-02T14:06:00.000Z') });
    assert.deepEqual(Object.keys(record).sort(), [
      'counts', 'created', 'headline', 'id', 'manifest', 'mode', 'model', 'packet', 'profileId', 'profileName', 'provider', 'refused', 'review', 'savedAt', 'source', 'truncated', 'verdict',
    ]);
    const text = JSON.stringify(record);
    assert.ok(!text.includes('sk-should-never') && !text.includes('contract Vault'));
    assert.deepEqual(Object.keys(record.manifest[0]).sort(), ['bytes', 'label', 'lines', 'sha256']);
    assert.equal(record.id, '2026-10-02T14:05:09.000Z');
    assert.equal(record.savedAt, '2026-10-02T14:06:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// The fragment
// ---------------------------------------------------------------------------

describe('workbench fragment', () => {
  const markup = `${workbench()}${workbenchDialogs()}`;
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

  test('it is the #workspace section with one status line and three panels', () => {
    assert.match(String(workbench()), /^<section class="[^"]*" id="workspace"[^>]* data-step="files">/);
    for (const id of ['wb-status', 'wb-panel-files', 'wb-panel-review', 'wb-panel-results', 'wb-step-files', 'wb-step-review', 'wb-step-results']) {
      assert.equal(ids.filter((entry) => entry === id).length, 1, id);
    }
    assert.match(markup, /id="wb-status" role="status"/);
    assert.match(markup, /aria-current="step"[^>]*id="wb-step-files"|id="wb-step-files"[^>]*aria-current="step"/);
  });

  test('every element the modules look up by id exists once', async () => {
    assert.equal(new Set(ids).size, ids.length, 'duplicate id');
    const dynamic = new Set([
      'wb-more-profiles',
      // Built by script inside the containers above.
      'wb-privacy-ack', 'wb-files-toggle', 'wb-source-code', 'wb-upgrade-go', 'wb-upgrade-export', 'wb-run-ack', 'wb-result-tabs', 'wb-export-hosted',
      // Owned by other modules or pages.
      'account-button', 'workspace',
    ]);
    const missing = [];
    for (const name of CORE_MODULES) {
      const source = await readFile(new URL(name, APP_DIR), 'utf8');
      for (const match of source.matchAll(/qs\('#([a-z][a-z0-9-]*)(?:'| |\[|:|>)/g)) {
        if (!ids.includes(match[1]) && !dynamic.has(match[1])) missing.push(`${name}: #${match[1]}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test('nothing inline: no style attribute, no handler, no script', () => {
    assert.ok(!/\sstyle=/.test(markup));
    assert.ok(!/\son[a-z]+=/.test(markup));
    assert.ok(!/<script|<style/i.test(markup));
  });

  test('it names its stylesheet and its entry script for the page', () => {
    // runners.css carries the gauntlet and panel rows (tests/app-runners.test.mjs).
    assert.deepEqual([...workbenchStyles], ['/css/workbench.css', '/css/runners.css']);
    assert.deepEqual([...workbenchScripts], ['/app/main.mjs']);
  });

  test('the key field cannot be autofilled or stored by the form', () => {
    const key = markup.match(/<input[^>]*id="wb-key"[^>]*>/)[0];
    assert.match(key, /type="password"/);
    assert.match(key, /autocomplete="off"/);
  });
});

// ---------------------------------------------------------------------------
// Rules the code keeps
// ---------------------------------------------------------------------------

describe('rules', () => {
  test('no module parses a string as markup', async () => {
    const banned = new RegExp(['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML', 'document\\.write', 'DOMParser', 'createContextualFragment'].join('|'));
    for (const name of CORE_MODULES) {
      const source = await readFile(new URL(name, APP_DIR), 'utf8');
      assert.ok(!banned.test(source), `${name} uses a markup-parsing API`);
    }
    assert.ok(!banned.test(await readFile(new URL('../site/fragments/workbench.mjs', import.meta.url), 'utf8')));
  });

  test('keys reach storage in one place only, and only by the user\'s choice', async () => {
    for (const name of CORE_MODULES) {
      const source = await readFile(new URL(name, APP_DIR), 'utf8');
      assert.ok(!/localStorage[^\n]*(?:apiKey|token|keys\.get|connected)/.test(source), `${name} writes a key to localStorage`);
      if (name !== 'providers-ui.mjs') assert.ok(!/writeSession\([^)]*(?:apiKey|token|\bkey\b)/.test(source), `${name} stores a key`);
    }
    const providers = await readFile(new URL('providers-ui.mjs', APP_DIR), 'utf8');
    const writes = [...providers.matchAll(/writeSession\(([A-Z_]+)/g)].map((match) => match[1]);
    assert.deepEqual(writes.sort(), ['KEPT_KEY', 'PKCE_KEY']);
    assert.match(providers, /if \(pending\.keep\) writeSession\(KEPT_KEY, key\)/);
  });

  test('the stylesheet uses tokens only, and every token exists', async () => {
    const css = await readFile(new URL('../public/css/workbench.css', import.meta.url), 'utf8');
    const base = await readFile(new URL('../public/css/base.css', import.meta.url), 'utf8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual(rules.match(/#[0-9a-fA-F]{3,8}\b(?![^{]*\{)/g) ?? [], [], 'a colour that is not a token');
    assert.ok(!/\b(?:rgb|hsl)a?\(/.test(rules));
    const defined = new Set([...base.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const used = new Set([...rules.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]));
    assert.deepEqual([...used].filter((name) => !defined.has(name)), []);
    // Nothing renders below 12px.
    assert.ok(!/font-size:\s*(?:0\.[0-6]\d*rem|[0-9]px|1[01]px)/.test(rules));
  });

  test('the copy keeps the voice: no hedges, no borrowed names', async () => {
    const banned = /\b(?:simply|powerful|seamless|not a guarantee|can help|we cannot)\b|!['"`]\s*[,)]/i;
    const sources = [String(workbench()), String(workbenchDialogs())];
    for (const name of CORE_MODULES) sources.push(await readFile(new URL(name, APP_DIR), 'utf8'));
    for (const source of sources) {
      // Names that must stay out are read from lists git ignores (./private-lists.mjs): a pattern here would publish the name it guards.
      assertNoBannedNames(source, 'workbench copy');
      const hit = source.match(banned);
      assert.equal(hit, null, hit ? `banned wording: ${hit[0]}` : '');
    }
  });

  test('the old v0.6 entry and stylesheet are gone', async () => {
    const publicFiles = await readdir(new URL('../public/', import.meta.url));
    assert.ok(!publicFiles.includes('app.mjs'));
    assert.ok(!publicFiles.includes('style.css'));
  });
});
