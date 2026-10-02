// Tests for the Slither focus port at /tools/slither-focus.
//
// The first test mirrors tests/test_slither_focus.py. The reference strings in
// the parity tests are the output of the Python module for the same fixture:
//   format_text(FIXTURE, DEFAULT_CHECKS) and format_markdown(FIXTURE, DEFAULT_CHECKS).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CHECKS,
  detectors,
  formatMarkdown,
  formatText,
  parseSlither,
  rankDetectors,
  triageQueue,
  workbenchHandoff,
} from '../public/tools/slither-focus-core.mjs';

const FIXTURE = {
  success: true,
  error: null,
  results: {
    detectors: [
      {
        check: 'unused-return',
        impact: 'Medium',
        confidence: 'Medium',
        description: 'Vault.sweep(address) (contracts/Vault.sol#40-44) ignores return value by token.transfer(owner,amount) (contracts/Vault.sol#42)\n',
        elements: [
          { type: 'function', name: 'sweep', source_mapping: { filename_relative: 'contracts/Vault.sol', filename_absolute: '/work/contracts/Vault.sol', lines: [40, 41, 42, 43, 44] } },
          { type: 'node', name: 'token.transfer(owner,amount)', source_mapping: { filename_relative: 'contracts/Vault.sol', lines: [42] } },
        ],
      },
      { check: 'naming-convention', impact: 'Informational', confidence: 'High', description: 'Style', elements: [] },
      {
        check: 'reentrancy-eth',
        impact: 'High',
        confidence: 'Medium',
        description: 'Reentrancy in Vault.withdraw(uint256) (contracts/Vault.sol#20-30):\n\tExternal calls:\n\t- (ok) = msg.sender.call{value: amount}() (contracts/Vault.sol#24)\n\tState variables written after the call(s):\n\t- balances[msg.sender] -= amount (contracts/Vault.sol#27) | `x` <b> & "q" \'a\'',
        elements: [
          { type: 'function', name: 'withdraw', source_mapping: { filename_absolute: '/work/contracts/Vault.sol', lines: [20, 21, 22, 23, 24, 25] } },
          { type: 'node', source_mapping: { filename_relative: 'contracts/Vault.sol', lines: [] } },
          { source_mapping: null },
          { type: 'node', name: 'a|b`c', source_mapping: {} },
        ],
      },
      {
        check: 'low-level-calls',
        impact: 'Informational',
        confidence: 'High',
        elements: [{ type: 'function', name: 'withdraw', source_mapping: { filename_relative: 'contracts/Vault.sol', lines: [20] } }],
      },
      { check: 'arbitrary-send-eth', confidence: 'Medium', description: '' },
    ],
  },
};

const PYTHON_TEXT = "=== unused-return | impact=Medium | confidence=Medium ===\nVault.sweep(address) (contracts/Vault.sol#40-44) ignores return value by token.transfer(owner,amount) (contracts/Vault.sol#42)\n  - contracts/Vault.sol:40,41,42,43 sweep\n  - contracts/Vault.sol:42 token.transfer(owner,amount)\n=== reentrancy-eth | impact=High | confidence=Medium ===\nReentrancy in Vault.withdraw(uint256) (contracts/Vault.sol#20-30): External calls: - (ok) = msg.sender.call{value: amount}() (contracts/Vault.sol#24) State variables written after the call(s): - balances[msg.sender] -= amount (contracts/Vault.sol#27) | `x` <b> & \"q\" 'a'\n  - /work/contracts/Vault.sol:20,21,22,23 withdraw\n  - contracts/Vault.sol node\n  - ? ?\n  - ? a|b`c\n=== low-level-calls | impact=Informational | confidence=High ===\n\n  - contracts/Vault.sol:20 withdraw\n=== arbitrary-send-eth | impact=None | confidence=Medium ===\n\n";

const PYTHON_MARKDOWN = "# Slither Focus\n\n## `unused-return`\n\n- Impact: `Medium`\n- Confidence: `Medium`\n\nVault.sweep(address) (contracts/Vault.sol#40-44) ignores return value by token.transfer(owner,amount) (contracts/Vault.sol#42)\n\n| Location | Element |\n|---|---|\n| `contracts/Vault.sol:40,41,42,43` | `sweep` |\n| `contracts/Vault.sol:42` | `token.transfer(owner,amount)` |\n\n## `reentrancy-eth`\n\n- Impact: `High`\n- Confidence: `Medium`\n\nReentrancy in Vault.withdraw(uint256) (contracts/Vault.sol#20-30): External calls: - (ok) = msg.sender.call{value: amount}() (contracts/Vault.sol#24) State variables written after the call(s): - balances[msg.sender] -= amount (contracts/Vault.sol#27) &#124; &#96;x&#96; &lt;b&gt; &amp; &quot;q&quot; &#x27;a&#x27;\n\n| Location | Element |\n|---|---|\n| `/work/contracts/Vault.sol:20,21,22,23` | `withdraw` |\n| `contracts/Vault.sol` | `node` |\n| `?` | `?` |\n| `?` | `a&#124;b&#96;c` |\n\n## `low-level-calls`\n\n- Impact: `Informational`\n- Confidence: `High`\n\n\n\n| Location | Element |\n|---|---|\n| `contracts/Vault.sol:20` | `withdraw` |\n\n## `arbitrary-send-eth`\n\n- Impact: `None`\n- Confidence: `Medium`\n\n\n\n| Location | Element |\n|---|---|\n";

describe('slither focus', () => {
  // Mirrors SlitherFocusTests.test_filters_to_selected_check.
  test('filters to the selected check', () => {
    const data = {
      results: {
        detectors: [
          {
            check: 'unused-return',
            impact: 'Medium',
            confidence: 'High',
            description: 'Ignored return value',
            elements: [{ name: 'transfer', source_mapping: { filename_relative: 'contracts/Vault.sol', lines: [42] } }],
          },
          { check: 'naming-convention', impact: 'Informational', confidence: 'High', description: 'Style', elements: [] },
        ],
      },
    };
    const output = formatText(data, new Set(['unused-return']));
    assert.ok(output.includes('unused-return'));
    assert.ok(output.includes('contracts/Vault.sol:42'));
    assert.ok(!output.includes('naming-convention'));
  });

  test('the curated set is the thirteen detectors of the Python module', () => {
    assert.deepEqual([...DEFAULT_CHECKS], [
      'arbitrary-send-erc20', 'arbitrary-send-eth', 'calls-loop', 'controlled-delegatecall', 'delegatecall-loop',
      'incorrect-equality', 'low-level-calls', 'reentrancy-benign', 'reentrancy-eth', 'reentrancy-no-eth',
      'unchecked-transfer', 'uninitialized-local', 'unused-return',
    ]);
  });

  test('formatText matches the Python output character for character', () => {
    assert.equal(formatText(FIXTURE, DEFAULT_CHECKS), PYTHON_TEXT);
    assert.equal(formatText(FIXTURE, ['x']), 'No matching Slither detectors found.\n');
  });

  test('formatMarkdown matches the Python output character for character', () => {
    assert.equal(formatMarkdown(FIXTURE, DEFAULT_CHECKS), PYTHON_MARKDOWN);
    assert.equal(formatMarkdown(FIXTURE, new Set(['x'])), '# Slither Focus\n\nNo matching Slither detectors found.\n');
  });

  test('the element limit caps the locations per detector and must be positive', () => {
    const one = formatMarkdown(FIXTURE, DEFAULT_CHECKS, 1);
    assert.ok(one.includes('| `contracts/Vault.sol:40,41,42,43` | `sweep` |'));
    assert.ok(!one.includes('token.transfer(owner,amount)` |'));
    assert.throws(() => formatMarkdown(FIXTURE, DEFAULT_CHECKS, 0), /element limit must be greater than zero/);
    assert.throws(() => formatText(FIXTURE, DEFAULT_CHECKS, -1), /element limit must be greater than zero/);
  });

  test('a long description is cut at 1800 characters, counted in code points', () => {
    const description = `${'word '.repeat(500)}${'\u{1F600}'.repeat(10)}`;
    const output = formatMarkdown({ results: { detectors: [{ check: 'unused-return', description, elements: [] }] } }, DEFAULT_CHECKS);
    const line = output.split('\n').find((entry) => entry.startsWith('word '));
    assert.equal(Array.from(line).length, 1800);
    assert.ok(line.endsWith('wo...'));
    // The Python module returns 1911 characters for this input.
    assert.equal(Array.from(output).length, 1911);
  });

  test('a failed or malformed scan throws instead of reading as clean', () => {
    const invalid = /invalid or the scanner failed/;
    assert.throws(() => detectors(null, DEFAULT_CHECKS), invalid);
    assert.throws(() => detectors([], DEFAULT_CHECKS), invalid);
    assert.throws(() => detectors({ success: false, results: { detectors: [] } }, DEFAULT_CHECKS), invalid);
    assert.throws(() => detectors({}, DEFAULT_CHECKS), /results\.detectors as a list/);
    assert.throws(() => detectors({ results: { detectors: {} } }, DEFAULT_CHECKS), /results\.detectors as a list/);
    assert.throws(() => detectors({ results: { detectors: [{ check: 1 }] } }, DEFAULT_CHECKS), /invalid detector/);
    assert.throws(() => detectors({ results: { detectors: ['x'] } }, DEFAULT_CHECKS), /invalid detector/);
    assert.throws(() => detectors({ results: { detectors: [{ check: 'a', description: null }] } }, DEFAULT_CHECKS), /description must be text/);
    assert.throws(() => detectors({ results: { detectors: [{ check: 'a', elements: {} }] } }, DEFAULT_CHECKS), /elements must be objects/);
    assert.throws(() => detectors({ results: { detectors: [{ check: 'a', elements: ['x'] }] } }, DEFAULT_CHECKS), /elements must be objects/);
    assert.throws(() => detectors({ results: { detectors: [{ check: 'a', elements: [{ source_mapping: 'x' }] }] } }, DEFAULT_CHECKS), /source mapping is malformed/);
    assert.throws(() => detectors({ results: { detectors: [{ check: 'a', elements: [{ source_mapping: { lines: 4 } }] }] } }, DEFAULT_CHECKS), /source mapping is malformed/);
    // A detector outside the selection is validated too.
    assert.throws(() => formatText({ results: { detectors: [{ check: 'naming-convention', elements: 'x' }] } }, DEFAULT_CHECKS), /elements must be objects/);

    assert.deepEqual(detectors({ results: { detectors: [] } }, DEFAULT_CHECKS), []);
    assert.deepEqual(detectors({ success: true, results: { detectors: [{ check: 'a', elements: [{ source_mapping: [] }] }] } }, ['a']).length, 1);
  });

  test('parseSlither reads JSON text and validates it', () => {
    assert.throws(() => parseSlither('{not json'), /not valid JSON/);
    assert.throws(() => parseSlither('{"success":false,"error":"compile failed","results":{}}'), /scanner failed/);
    assert.equal(parseSlither(JSON.stringify(FIXTURE)).results.detectors.length, 5);
  });

  test('a successful run with no detector result reads as an empty scan', () => {
    // Slither writes "results": {} when nothing fired.
    const clean = parseSlither('{"success":true,"error":null,"results":{}}');
    assert.deepEqual(clean.results.detectors, []);
    assert.equal(triageQueue(clean).kept, 0);
    assert.equal(formatText(clean, DEFAULT_CHECKS), 'No matching Slither detectors found.\n');
    // Without "success": true the same shape is still refused.
    assert.throws(() => parseSlither('{"results":{}}'), /results\.detectors as a list/);
    assert.throws(() => parseSlither('{"success":true,"results":{"detectors":{}}}'), /results\.detectors as a list/);
    assert.throws(() => parseSlither('{"success":true}'), /results\.detectors as a list/);
  });

  test('rankDetectors orders by impact, then confidence, and keeps ties in file order', () => {
    const data = {
      results: {
        detectors: [
          { check: 'low-level-calls', impact: 'Informational', confidence: 'High' },
          { check: 'unused-return', impact: 'Medium', confidence: 'Medium' },
          { check: 'reentrancy-benign', impact: 'Low', confidence: 'Medium' },
          { check: 'reentrancy-eth', impact: 'High', confidence: 'Medium' },
          { check: 'arbitrary-send-eth', impact: 'High', confidence: 'High' },
          { check: 'unchecked-transfer', impact: 'High', confidence: 'Medium' },
          { check: 'calls-loop' },
        ],
      },
    };
    const ranked = rankDetectors(data);
    assert.deepEqual(ranked.results.detectors.map((detector) => detector.check), [
      'arbitrary-send-eth', 'reentrancy-eth', 'unchecked-transfer', 'unused-return', 'reentrancy-benign', 'low-level-calls', 'calls-loop',
    ]);
    // The input is not reordered.
    assert.equal(data.results.detectors[0].check, 'low-level-calls');
    assert.throws(() => rankDetectors({ success: false }), /scanner failed/);
  });

  test('triageQueue returns the ranked Markdown and the figures shown beside it', () => {
    const queue = triageQueue(FIXTURE);
    assert.equal(queue.total, 5);
    assert.equal(queue.kept, 4);
    assert.deepEqual(queue.rows.map((row) => row.check), ['reentrancy-eth', 'unused-return', 'low-level-calls', 'arbitrary-send-eth']);
    assert.deepEqual(queue.rows[0], { check: 'reentrancy-eth', impact: 'High', confidence: 'Medium', locations: 4, first: '/work/contracts/Vault.sol:20,21,22,23' });
    assert.deepEqual(queue.rows[3], { check: 'arbitrary-send-eth', impact: 'None', confidence: 'Medium', locations: 0, first: '' });
    assert.ok(queue.markdown.indexOf('## `reentrancy-eth`') < queue.markdown.indexOf('## `unused-return`'));
    assert.ok(!queue.markdown.includes('naming-convention'));

    assert.equal(triageQueue(FIXTURE, { checks: ['naming-convention'] }).kept, 1);
    assert.throws(() => triageQueue(FIXTURE, { limit: 0 }), /element limit/);
    assert.equal(triageQueue({ results: { detectors: [] } }).markdown, '# Slither Focus\n\nNo matching Slither detectors found.\n');
  });

  test('workbenchHandoff follows the bo:handoff contract', () => {
    const { markdown } = triageQueue(FIXTURE);
    const handoff = workbenchHandoff(markdown);
    assert.deepEqual(Object.keys(handoff), ['files', 'profile', 'focus', 'context']);
    assert.deepEqual(handoff.files, [{ name: 'slither-focus.md', content: markdown }]);
    assert.equal(handoff.profile, 'scanner');
    assert.deepEqual(handoff.context, {});
  });
});
