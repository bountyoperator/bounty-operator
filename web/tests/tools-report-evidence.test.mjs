// Tests for the citation check and the evidence packet on /tools/report-check.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PACKET_SCHEMA,
  REFERENCE_STATUS,
  addEvidence,
  checkEvidence,
  createEvidencePacket,
  evidenceExcerpt,
  evidenceLimits,
  evidenceMarkdown,
  reportFiles,
  restoreEvidencePacket,
} from '../public/tools/report-evidence-core.mjs';
import { LIMITS } from '../public/review-core.mjs';

const lines = (count, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n');
const VAULT = { name: 'src/Vault.sol', content: lines(60, 'vault') };
const OUTPUT = { name: 'forge-output.txt', content: '$ forge test\n[PASS] testDrain()\nSuite result: ok.\n' };
const statusOf = (draft, files) => checkEvidence(draft, files).refs.map((ref) => ref.status);

describe('citation check', () => {
  test('resolves path, short name, #L anchors, input-N shorthand and comma ranges', () => {
    const draft = [
      'Root cause at src/Vault.sol:42-48.',
      'Also Vault.sol#L10 and Vault.sol:L12-L14.',
      'Output: input-2/forge-output.txt:2 and input-1:5.',
      'Two ranges: src/Vault.sol:1-2,7,9-10.',
    ].join('\n');
    const result = checkEvidence(draft, [VAULT, OUTPUT]);
    assert.deepEqual(result.refs.map((ref) => [ref.path, ref.start, ref.end, ref.status, ref.draftLine]), [
      ['src/Vault.sol', 42, 48, 'linked', 1],
      ['Vault.sol', 10, 10, 'linked', 2],
      ['Vault.sol', 12, 14, 'linked', 2],
      ['input-2/forge-output.txt', 2, 2, 'linked', 3],
      ['input-1', 5, 5, 'linked', 3],
      ['src/Vault.sol', 1, 2, 'linked', 4],
      ['src/Vault.sol', 7, 7, 'linked', 4],
      ['src/Vault.sol', 9, 10, 'linked', 4],
    ]);
    assert.equal(result.linked, 8);
    assert.equal(result.unresolved, 0);
  });

  test('names a missing file, a line past the end, an inverted range and an ambiguous short name', () => {
    const other = { name: 'lib/Vault.sol', content: lines(5) };
    assert.deepEqual(statusOf('See test/Drain.t.sol:12.', [VAULT]), ['missing']);
    assert.deepEqual(statusOf('See src/Vault.sol:61.', [VAULT]), ['range']);
    assert.deepEqual(statusOf('See src/Vault.sol:20-10.', [VAULT]), ['range']);
    assert.deepEqual(statusOf('See Vault.sol:3.', [VAULT, other]), ['ambiguous']);
    assert.deepEqual(checkEvidence('See Vault.sol:3.', [VAULT, other]).refs[0].choices, ['src/Vault.sol', 'lib/Vault.sol']);
    // The full path removes the ambiguity.
    assert.deepEqual(statusOf('See lib/Vault.sol:3.', [VAULT, other]), ['linked']);
    // input-N must name the file at that position when a path follows it.
    assert.deepEqual(statusOf('See input-1/forge-output.txt:1.', [VAULT, OUTPUT]), ['missing']);
    assert.deepEqual(statusOf('See input-9:1.', [VAULT]), ['missing']);
    for (const key of ['linked', 'missing', 'ambiguous', 'range']) assert.ok(REFERENCE_STATUS[key], key);
  });

  test('a URL is counted, never read as a citation', () => {
    const result = checkEvidence('See https://github.com/a/b/blob/abc/src/Vault.sol#L42 and src/Vault.sol:42.', [VAULT]);
    assert.equal(result.remoteLinks, 1);
    assert.equal(result.total, 1);
    assert.equal(result.refs[0].status, 'linked');
  });

  test('excerpts carry line numbers and stop at forty lines', () => {
    const [ref] = checkEvidence('src/Vault.sol:42-43', [VAULT]).refs;
    assert.equal(evidenceExcerpt(ref, [VAULT]), '42: vault 42\n43: vault 43');
    const [long] = checkEvidence('src/Vault.sol:1-60', [VAULT]).refs;
    const text = evidenceExcerpt(long, [VAULT]);
    assert.match(text, /^1: vault 1\n/);
    assert.match(text, /40: vault 40\n\[Preview shortened\. Original retained in attachment\.\]$/);
    const [missing] = checkEvidence('nope.sol:1', [VAULT]).refs;
    assert.equal(evidenceExcerpt(missing, [VAULT]), '');
  });

  test('the markdown summary lists citations and files without quoting either', () => {
    const files = [VAULT];
    const markdown = evidenceMarkdown(checkEvidence('Bug at src/Vault.sol:42. Test at t.sol:1.', files), files);
    assert.match(markdown, /^## Citations\n\n1 of 2 file:line citations point at a real line/);
    assert.match(markdown, /- Draft L1: src\/Vault\.sol:42 — Line found\./);
    assert.match(markdown, /- Draft L1: t\.sol:1 — File not attached\./);
    assert.match(markdown, /- input-1\/src\/Vault\.sol \(60 lines\)/);
    assert.ok(!markdown.includes('vault 42'));
  });

  test('a hostile draft is read in bounded time and the list is capped', () => {
    const many = Array.from({ length: 700 }, (_, i) => `src/Vault.sol:${(i % 60) + 1}`).join(' ');
    const started = Date.now();
    const result = checkEvidence(`${many}\n${'a.sol:'.repeat(20000)}\n${'x'.repeat(200000)}.sol:1`, [VAULT]);
    assert.ok(Date.now() - started < 2000, `checked in ${Date.now() - started} ms`);
    assert.equal(result.refs.length, 500);
    assert.ok(result.omitted >= 200);
  });
});

describe('evidence files', () => {
  test('the draft goes last under the review file name, renamed only on a clash', () => {
    assert.deepEqual(reportFiles('d', [VAULT]).map((file) => file.name), ['src/Vault.sol', 'draft-report.md']);
    assert.deepEqual(reportFiles('d', [{ name: 'draft-report.md', content: 'x' }]).map((file) => file.name), ['draft-report.md', 'draft-report-2.md']);
  });

  test('limits match the workbench: file count, size, names and duplicates', () => {
    assert.equal(evidenceLimits('d', [VAULT]), '');
    assert.equal(evidenceLimits('d', [{ name: '../etc/passwd', content: 'x' }]), 'Use a relative filename for ../etc/passwd.');
    assert.equal(evidenceLimits('d', [VAULT, VAULT]), 'Two attachments have the same name: src/Vault.sol.');
    const tooMany = Array.from({ length: LIMITS.files }, (_, i) => ({ name: `f${i}.txt`, content: 'x' }));
    assert.equal(evidenceLimits('d', tooMany), `Keep at most ${LIMITS.files - 1} evidence files with one draft.`);
    assert.match(evidenceLimits('d', [{ name: 'big.txt', content: 'x'.repeat(LIMITS.fileBytes + 1) }]), /^big\.txt exceeds /);
  });

  test('adding a file with the same name replaces it; a rejected file leaves the list as it was', () => {
    const first = addEvidence([], [VAULT, OUTPUT], 'draft');
    assert.deepEqual(first.errors, []);
    const replaced = addEvidence(first.files, [{ name: 'src\\Vault.sol', content: 'new' }], 'draft');
    assert.deepEqual(replaced.files.map((file) => [file.name, file.content.slice(0, 3)]), [['src/Vault.sol', 'new'], ['forge-output.txt', '$ f']]);
    const rejected = addEvidence(first.files, [{ name: '/abs/path.txt', content: 'x' }], 'draft');
    assert.equal(rejected.errors.length, 1);
    assert.deepEqual(rejected.files, first.files);
  });
});

describe('evidence packet', () => {
  test('saves the draft and files with checksums and opens them again', async () => {
    const packet = await createEvidencePacket('# Draft\nsrc/Vault.sol:1\n', [VAULT, OUTPUT], '2026-10-04T00:00:00.000Z');
    assert.equal(packet.schema, PACKET_SCHEMA);
    assert.equal(packet.draftIndex, 2);
    assert.equal(packet.manifest.length, 3);
    assert.match(packet.manifest[0].sha256, /^[0-9a-f]{64}$/);
    const restored = await restoreEvidencePacket(JSON.stringify(packet));
    assert.equal(restored.draft, '# Draft\nsrc/Vault.sol:1\n');
    assert.deepEqual(restored.files, [VAULT, OUTPUT]);
  });

  test('refuses a changed file, a wrong schema, broken JSON and an unsafe name', async () => {
    const packet = await createEvidencePacket('draft', [VAULT]);
    const changed = structuredClone(packet);
    changed.files[0].content += '\nextra';
    await assert.rejects(restoreEvidencePacket(JSON.stringify(changed)), /differs from the saved checksum/);
    await assert.rejects(restoreEvidencePacket(JSON.stringify({ ...packet, schema: 'other' })), /not a supported/);
    await assert.rejects(restoreEvidencePacket('{not json'), /not a valid JSON/);
    const unsafe = structuredClone(packet);
    unsafe.files[0].name = '../x.sol';
    await assert.rejects(restoreEvidencePacket(JSON.stringify(unsafe)), /relative filename/);
    const swapped = structuredClone(packet);
    swapped.draftIndex = 0;
    await assert.rejects(restoreEvidencePacket(JSON.stringify(swapped)), /not a supported/);
  });

  test('a packet over the size limit is refused before it is parsed', async () => {
    await assert.rejects(restoreEvidencePacket('x'.repeat(LIMITS.totalBytes * 8)), /too large/);
  });
});
