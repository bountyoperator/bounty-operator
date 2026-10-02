// Tests for the packet verifier at /tools/verify.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { manifestFor } from '../public/review-core.mjs';
import { reviewPacket } from '../public/evidence.mjs';
import {
  STATUS_LABELS,
  parseManifest,
  readManifest,
  summaryLine,
  verificationMarkdown,
  verifyFiles,
} from '../public/tools/verify-core.mjs';

const VAULT = 'contract Vault {\n    function withdraw() external {}\n}\n';
const TEST = 'function test_drain() public {\n    assertEq(token.balanceOf(mallory), 100e18);\n}\n';
const NOTES = '# Notes\n\nReproduced on a local fork.\n';

const FILES = [
  { name: 'src/Vault.sol', content: VAULT },
  { name: 'test/Drain.t.sol', content: TEST },
  { name: 'notes.md', content: NOTES },
];

async function packetFor(files = FILES) {
  const manifest = await manifestFor(files);
  const packet = reviewPacket({
    review: '# Review\nVerdict: prove-first\nMode: bounty\n',
    manifest,
    context: { target: 'Example', notes: '## Files\n- not-a-row · 1 bytes · SHA-256 none' },
    provider: 'openrouter',
    model: 'example/model',
    timestamp: '2026-10-02T10:00:00.000Z',
    profileId: 'report',
    parsed: { ok: true, verdict: 'prove-first', mode: 'bounty', headline: 'One artifact is missing.' },
  });
  return { manifest, packet };
}

describe('packet verifier', () => {
  test('reads the file rows and the header of a packet the workbench wrote', async () => {
    const { manifest, packet } = await packetFor();
    const source = parseManifest(packet);

    assert.equal(source.kind, 'packet');
    assert.deepEqual(source.details, { created: '2026-10-02T10:00:00.000Z', profile: 'Challenge a draft report', verdict: 'prove-first' });
    assert.deepEqual(source.entries.map((entry) => entry.label), manifest.map((entry) => entry.label));
    assert.deepEqual(source.entries.map((entry) => entry.name), ['src/Vault.sol', 'test/Drain.t.sol', 'notes.md']);
    assert.deepEqual(source.entries.map((entry) => entry.sha256), manifest.map((entry) => entry.sha256));
    assert.deepEqual(source.entries.map((entry) => entry.bytes), manifest.map((entry) => entry.bytes));
    assert.deepEqual(source.entries.map((entry) => entry.lines), manifest.map((entry) => entry.lines));
  });

  test('reads a v0.6 packet, a manifest array and an API response', async () => {
    const manifest = await manifestFor(FILES);
    const legacy = `# Bounty Operator review packet\n\nCreated: 2026-08-01T00:00:00Z\nReview profile: General\n\n## Checked files\n\n${manifest.map((file) => `- ${file.label}: ${file.bytes} bytes; SHA-256 ${file.sha256}`).join('\n')}\n\n## AI review\n\ntext\n`;
    const fromLegacy = parseManifest(legacy);
    assert.equal(fromLegacy.entries.length, 3);
    assert.equal(fromLegacy.entries[0].lines, null);
    assert.equal(fromLegacy.details.profile, 'General');

    const fromArray = parseManifest(JSON.stringify(manifest));
    assert.equal(fromArray.kind, 'manifest');
    assert.deepEqual(fromArray.entries.map((entry) => entry.sha256), manifest.map((entry) => entry.sha256));

    assert.equal(parseManifest(JSON.stringify({ review: 'x', manifest })).entries.length, 3);
    assert.equal(parseManifest(JSON.stringify({ files: [{ name: 'a.sol', sha256: 'AB'.repeat(32) }] })).entries[0].sha256, 'ab'.repeat(32));
  });

  test('text without file hashes is not a manifest', () => {
    assert.equal(readManifest(VAULT), null);
    assert.equal(readManifest('{"name":"pkg","version":"1.0.0"}'), null);
    assert.equal(readManifest('[{"label":"a","sha256":"short"}]'), null);
    assert.equal(readManifest(''), null);
    assert.throws(() => parseManifest('# Just a report\n'), /No file hashes found/);
  });

  test('a label escaped by the packet writer is restored', async () => {
    const files = [{ name: 'a![x]:<b>.sol', content: VAULT }];
    const { packet } = await packetFor(files);
    const source = parseManifest(packet);
    assert.equal(source.entries[0].name, 'a![x]:<b>.sol');
    const result = await verifyFiles(source.entries, files);
    assert.equal(result.rows[0].status, 'match');
  });

  test('unchanged files match, by full path, by base name and inside a dropped folder', async () => {
    const { packet } = await packetFor();
    const { entries } = parseManifest(packet);

    const exact = await verifyFiles(entries, FILES);
    assert.deepEqual(exact.rows.map((row) => row.status), ['match', 'match', 'match']);
    assert.deepEqual(exact.counts, { match: 3, normalised: 0, mismatch: 0, missing: 0 });
    assert.deepEqual(exact.extras, []);
    assert.equal(summaryLine(exact), 'All 3 files match the manifest.');
    assert.equal(exact.rows[0].note, '');
    assert.equal(exact.rows[0].actual, exact.rows[0].expected);

    const baseNames = await verifyFiles(entries, [
      { name: 'Vault.sol', content: VAULT },
      { name: 'Drain.t.sol', content: TEST },
      { name: 'notes.md', content: NOTES },
    ]);
    assert.deepEqual(baseNames.rows.map((row) => row.status), ['match', 'match', 'match']);

    const folder = await verifyFiles(entries, FILES.map((file) => ({ name: `repo/${file.name}`, content: file.content })));
    assert.deepEqual(folder.rows.map((row) => row.status), ['match', 'match', 'match']);
  });

  test('CRLF and LF differences are reported separately from a mismatch', async () => {
    const { packet } = await packetFor();
    const { entries } = parseManifest(packet);

    const crlf = await verifyFiles(entries, [
      { name: 'src/Vault.sol', content: VAULT.replace(/\n/g, '\r\n') },
      { name: 'test/Drain.t.sol', content: TEST },
      { name: 'notes.md', content: NOTES },
    ]);
    assert.deepEqual(crlf.rows.map((row) => row.status), ['normalised', 'match', 'match']);
    assert.equal(crlf.rows[0].note, 'The supplied file has CRLF line endings; the manifest was made from LF.');
    assert.notEqual(crlf.rows[0].actual, crlf.rows[0].expected);
    assert.equal(summaryLine(crlf), '2 of 3 files match. 1 matches after line-ending normalisation.');

    // The other direction: the manifest was made on a CRLF checkout.
    const windowsFiles = [{ name: 'a.sol', content: 'a\r\nb\r\n' }];
    const windowsManifest = await manifestFor(windowsFiles);
    const lf = await verifyFiles(parseManifest(JSON.stringify(windowsManifest)).entries, [{ name: 'a.sol', content: 'a\nb\n' }]);
    assert.equal(lf.rows[0].status, 'normalised');
    assert.equal(lf.rows[0].note, 'The supplied file has LF line endings; the manifest was made from CRLF.');
  });

  test('changed content is a mismatch and an absent file is missing', async () => {
    const { packet } = await packetFor();
    const { entries } = parseManifest(packet);
    const result = await verifyFiles(entries, [
      { name: 'src/Vault.sol', content: VAULT.replace('external', 'public') },
      { name: 'notes.md', content: NOTES.replace('local', 'LOCAL') },
      { name: 'unrelated.txt', content: 'x' },
    ]);

    assert.deepEqual(result.rows.map((row) => row.status), ['mismatch', 'missing', 'mismatch']);
    assert.match(result.rows[0].note, /^Content differs: the manifest records \d+ bytes, the supplied file has \d+\.$/);
    assert.equal(result.rows[2].note, 'Content differs at the same size.');
    assert.equal(result.rows[1].note, 'No supplied file has this name or this hash.');
    assert.equal(result.rows[1].actual, null);
    assert.deepEqual(result.extras, ['unrelated.txt']);
    assert.deepEqual(result.counts, { match: 0, normalised: 0, mismatch: 2, missing: 1 });
    assert.equal(summaryLine(result), '0 of 3 files match. 2 mismatches. 1 missing.');
  });

  test('a renamed file is found by its hash, and a same-named file in another folder is not confused', async () => {
    const { packet } = await packetFor();
    const { entries } = parseManifest(packet);

    const renamed = await verifyFiles(entries.slice(0, 1), [{ name: 'Vault-copy.sol', content: VAULT }]);
    assert.equal(renamed.rows[0].status, 'match');
    assert.equal(renamed.rows[0].note, 'Supplied as Vault-copy.sol.');

    const twoVaults = await verifyFiles(entries.slice(0, 1), [
      { name: 'lib/Vault.sol', content: 'other' },
      { name: 'repo/src/Vault.sol', content: VAULT },
    ]);
    assert.equal(twoVaults.rows[0].status, 'match');
    assert.equal(twoVaults.rows[0].supplied, 'repo/src/Vault.sol');
    assert.deepEqual(twoVaults.extras, ['lib/Vault.sol']);
  });

  test('a file read without its byte-order mark still matches a manifest made with it', async () => {
    const manifest = await manifestFor([{ name: 'a.sol', content: `﻿${VAULT}` }]);
    const { entries } = parseManifest(JSON.stringify(manifest));
    const stripped = await verifyFiles(entries, [{ name: 'a.sol', content: VAULT, bom: true }]);
    assert.equal(stripped.rows[0].status, 'match');
    assert.equal(stripped.rows[0].note, 'Matches with the byte-order mark kept.');
    assert.equal((await verifyFiles(entries, [{ name: 'a.sol', content: VAULT }])).rows[0].status, 'mismatch');
  });

  test('verificationMarkdown lists every file with its result', async () => {
    const { packet } = await packetFor();
    const { entries } = parseManifest(packet);
    const result = await verifyFiles(entries, [FILES[0], { name: 'extra|file.txt', content: 'x' }]);
    const markdown = verificationMarkdown(result, { checkedAt: '2026-10-02T12:00:00.000Z' });
    const lines = markdown.split('\n');

    assert.equal(lines[0], '# Packet verification');
    assert.equal(lines[2], '1 of 3 files match. 2 missing.');
    assert.ok(lines.includes('Checked: 2026-10-02T12:00:00.000Z'));
    assert.ok(lines.includes(`| input-1/src/Vault.sol | ${STATUS_LABELS.match} | \`${entries[0].sha256}\` |`));
    assert.ok(lines.includes(`| input-2/test/Drain.t.sol | ${STATUS_LABELS.missing} | \`${entries[1].sha256}\` |`));
    assert.ok(lines.includes('Supplied and not in the manifest: extra\\|file.txt'));
    assert.ok(markdown.endsWith('https://bountyoperator.com/tools/verify\n'));
  });
});
