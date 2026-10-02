// Tests for the pre-publish check at /tools/secret-check.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '../public/review-core.mjs';
import {
  hitLocation,
  scanFile,
  scanFiles,
  scanMarkdown,
  scanSummary,
  workbenchHandoff,
} from '../public/tools/secret-check-core.mjs';

// Secret-shaped fixtures are assembled at run time so the repository never
// contains a string a scanner would flag.
const WALLET_KEY = `0x${'ab12'.repeat(16)}`;
const GITHUB_TOKEN = `ghp_${'a1B2'.repeat(9)}`;
const PRIVATE_LINK = ['https://bugs.immunefi.com', 'dashboard', 'submission', '4821'].join('/');
const EMAIL = ['hunter', 'protonmail.com'].join('@');

const POC = `// SPDX-License-Identifier: MIT
contract Exploit {
    function run() external {}
}
`;

describe('pre-publish check', () => {
  test('a clean file reports nothing', () => {
    const scan = scanFiles([{ name: 'test/Exploit.t.sol', content: POC }]);
    assert.deepEqual(scan.files[0], { name: 'test/Exploit.t.sol', status: 'clean', hits: [], blocking: 0, warnings: 0, reason: '' });
    assert.deepEqual(scan.totals, { files: 1, scanned: 1, skipped: 0, flagged: 0, blocking: 0, warnings: 0 });
    assert.equal(scanSummary(scan), 'Nothing found in 1 file.');
    assert.equal(scanSummary(scanFiles([])), 'No files scanned.');
  });

  test('each hit is a line and a kind, and the matched text never appears', () => {
    const script = `const rpc = "http://127.0.0.1:8545";\nconst DEPLOYER_PRIVATE_KEY = "${WALLET_KEY}";\n// token ${GITHUB_TOKEN}\n// see ${PRIVATE_LINK}\n// contact ${EMAIL}\n`;
    const scan = scanFiles([
      { name: 'script/run.js', content: script },
      { name: 'README.md', content: '# PoC\n' },
    ]);
    const [file] = scan.files;

    assert.equal(file.status, 'block');
    assert.deepEqual(file.hits, [
      { line: 2, kind: 'wallet-key', label: 'wallet private key', severity: 'block' },
      { line: 3, kind: 'github-token', label: 'GitHub token', severity: 'block' },
      { line: 4, kind: 'private-report', label: 'link to a private platform report', severity: 'block' },
      { line: 5, kind: 'email-address', label: 'email address', severity: 'warn' },
    ]);
    assert.equal(hitLocation(file, file.hits[0]), 'script/run.js:2');
    assert.deepEqual(scan.totals, { files: 2, scanned: 2, skipped: 0, flagged: 1, blocking: 3, warnings: 1 });
    assert.equal(scanSummary(scan), '3 blocking, 1 warning in 1 of 2 files.');

    const everything = JSON.stringify(scan) + scanMarkdown(scan);
    for (const secret of [WALLET_KEY, GITHUB_TOKEN, '4821', EMAIL]) assert.ok(!everything.includes(secret));
    assert.match(scanMarkdown(scan), /^- BLOCK `script\/run\.js:2` wallet private key$/m);
    assert.match(scanMarkdown(scan), /^- WARN `script\/run\.js:5` email address$/m);
  });

  test('a credential file is reported by its name, and a name that holds a secret is withheld', () => {
    const scan = scanFiles([
      { name: 'poc/.env', content: 'RPC=local\n' },
      { name: `${GITHUB_TOKEN}.txt`, content: 'x\n' },
      { name: '.env.example', content: 'RPC_URL=\n' },
    ]);
    assert.deepEqual(scan.files[0].hits, [{ line: 0, kind: 'private-file', label: 'file that normally holds credentials', severity: 'block' }]);
    assert.equal(hitLocation(scan.files[0], scan.files[0].hits[0]), 'poc/.env');
    assert.equal(scan.files[1].name, 'file 2 (name withheld)');
    assert.equal(scan.files[1].hits[0].kind, 'github-token');
    assert.equal(scan.files[2].status, 'clean');
    assert.ok(!scanMarkdown(scan).includes(GITHUB_TOKEN));
  });

  test('a warning-only set is a warn, not a block', () => {
    const scan = scanFiles([{ name: 'notes.md', content: `Contact ${EMAIL}\nHost 8.8.8.8\nLocal 192.168.1.4 and 127.0.0.1\n` }]);
    assert.equal(scan.files[0].status, 'warn');
    assert.deepEqual(scan.files[0].hits.map((hit) => [hit.line, hit.kind]), [[1, 'email-address'], [2, 'ip-address']]);
    assert.equal(scanSummary(scan), '0 blocking, 2 warnings in 1 of 1 file.');
  });

  test('the public development keys are not flagged', () => {
    const anvil = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const scan = scanFiles([{ name: 'script/Deploy.s.sol', content: `uint256 deployerPrivateKey = 0x${anvil};\n` }]);
    assert.equal(scan.files[0].status, 'clean');
  });

  test('a binary file is skipped and the rest is still scanned', () => {
    const scan = scanFiles([
      { name: 'image.png', content: 'PNG\0\0data' },
      { name: 'run.sh', content: `export PRIVATE_KEY=${WALLET_KEY}\n` },
    ]);
    assert.equal(scan.files[0].status, 'skipped');
    assert.equal(scan.files[0].reason, 'Not a text file.');
    assert.equal(scan.files[1].status, 'block');
    assert.deepEqual(scan.totals, { files: 2, scanned: 1, skipped: 1, flagged: 1, blocking: 1, warnings: 0 });
    assert.match(scanMarkdown(scan), /^Not scanned: image\.png$/m);
  });

  test('a file over the review limit is scanned in pieces with the right line numbers', () => {
    const filler = `${'trace line with nothing in it '.repeat(3)}\n`;
    const before = filler.repeat(2500);
    const content = `${before}SIGNER_KEY=${WALLET_KEY}\n${filler.repeat(2500)}token ${GITHUB_TOKEN}\n`;
    assert.ok(content.length > LIMITS.fileBytes * 3);

    const result = scanFile({ name: 'trace.log', content });
    assert.equal(result.status, 'block');
    assert.deepEqual(result.hits.map((hit) => [hit.line, hit.kind]), [[2501, 'wallet-key'], [5002, 'github-token']]);
  });

  test('one very long line is scanned too', () => {
    const line = `${'x'.repeat(200000)} ${GITHUB_TOKEN} ${'y'.repeat(200000)}`;
    const result = scanFile({ name: 'bundle.min.js', content: `first\n${line}\nlast\n` });
    assert.deepEqual(result.hits.map((hit) => [hit.line, hit.kind]), [[2, 'github-token']]);
  });

  test('a file of many short lines is scanned, not skipped', () => {
    const result = scanFile({ name: 'trace.log', content: `${'a\n'.repeat(30000)}token ${GITHUB_TOKEN}\n` });
    assert.equal(result.status, 'block');
    assert.deepEqual(result.hits.map((hit) => [hit.line, hit.kind]), [[30001, 'github-token']]);
  });

  test('a skipped file whose name holds a secret is listed without the name', () => {
    const scan = scanFiles([{ name: `${GITHUB_TOKEN}.bin`, content: 'a\0b' }]);
    assert.equal(scan.files[0].status, 'skipped');
    assert.equal(scan.files[0].name, 'file 1 (name withheld)');
    assert.ok(!scanMarkdown(scan).includes(GITHUB_TOKEN));
  });

  test('a name the scanner cannot take falls back without losing the scan', () => {
    const result = scanFile({ name: 'C:\\poc\\.env', content: `KEY=${GITHUB_TOKEN}\n` }, 3);
    assert.equal(result.status, 'block');
    assert.deepEqual(result.hits.map((hit) => hit.kind), ['private-file', 'github-token']);
  });

  test('workbenchHandoff is offered only for a set the workbench accepts', () => {
    const clean = [{ name: 'test/Exploit.t.sol', content: POC }];
    const handoff = workbenchHandoff(clean, scanFiles(clean));
    assert.deepEqual(Object.keys(handoff), ['files', 'profile', 'focus', 'context']);
    assert.equal(handoff.profile, 'poc');
    assert.deepEqual(handoff.files, clean);

    const blocked = [{ name: 'run.sh', content: `export PRIVATE_KEY=${WALLET_KEY}\n` }];
    assert.equal(workbenchHandoff(blocked, scanFiles(blocked)), null);

    const large = [{ name: 'big.log', content: 'a\n'.repeat(70000) }];
    assert.equal(workbenchHandoff(large, scanFiles(large)), null);

    // Under the size limits and over the line limit: the workbench refuses it, so it is not handed over.
    const lines = [{ name: 'short-lines.log', content: 'a\n'.repeat(25000) }];
    assert.equal(scanFiles(lines).files[0].status, 'clean');
    assert.equal(workbenchHandoff(lines, scanFiles(lines)), null);

    const many = Array.from({ length: LIMITS.files + 1 }, (_, index) => ({ name: `f${index}.txt`, content: 'x' }));
    assert.equal(workbenchHandoff(many, scanFiles(many)), null);
    assert.equal(workbenchHandoff([], scanFiles([])), null);

    const warned = [{ name: 'notes.md', content: `Contact ${EMAIL}\n` }];
    assert.equal(workbenchHandoff(warned, scanFiles(warned)).files.length, 1);
  });
});
