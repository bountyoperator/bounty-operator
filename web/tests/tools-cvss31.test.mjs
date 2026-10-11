import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvss31BaseScore } from '../public/tools/cvss31-core.mjs';
import { checkReport, checklistMarkdown } from '../public/tools/report-check-core.mjs';

const UNCHANGED = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
const CHANGED = UNCHANGED.replace('S:U', 'S:C');
const severity = (text) => checkReport(text).checks.find((check) => check.id === 'severity');

test('CVSS 3.1 arithmetic matches FIRST calculator examples across scopes and privileges', () => {
  // Expected values independently read from FIRST's CVSS 3.1 calculator.
  // https://www.first.org/cvss/calculator/3.1
  const cases = [
    [UNCHANGED, 9.8],
    [CHANGED, 10],
    ['CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N', 0],
    ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N', 6.4],
    ['CVSS:3.1/AV:A/AC:H/PR:H/UI:R/S:C/C:H/I:N/A:L', 5.9],
    ['CVSS:3.1/AV:L/AC:H/PR:L/UI:N/S:U/C:L/I:H/A:L', 5.8],
    ['CVSS:3.1/AV:P/AC:L/PR:N/UI:R/S:U/C:L/I:N/A:N', 2.1],
    ['CVSS:3.1/AV:N/AC:H/PR:H/UI:R/S:C/C:H/I:H/A:H', 7.6],
  ];
  for (const [vector, score] of cases) assert.deepEqual(cvss31BaseScore(vector), { kind: 'base', score }, vector);
});

test('base metrics may be reordered, but missing, repeated or unknown metrics do not get a score', () => {
  assert.deepEqual(cvss31BaseScore('CVSS:3.1/A:H/C:H/I:H/S:C/UI:N/PR:N/AC:L/AV:N'), { kind: 'base', score: 10 });
  for (const vector of [
    CHANGED.replace('/A:H', ''),
    CHANGED + '/A:H',
    CHANGED.replace('PR:N', 'PR:X'),
    CHANGED + '/ZZ:H',
    CHANGED + '/',
    CHANGED.replace('AC:L', '__proto__:L'),
    'CVSS:3.1/' + 'A:H/'.repeat(2000),
  ]) assert.equal(cvss31BaseScore(vector).kind, 'invalid', vector.slice(0, 100));
});

test('other versions and extended metrics are explicitly unsupported, never silently scored as Base', () => {
  for (const vector of [CHANGED.replace('3.1', '3.0'), CHANGED.replace('3.1', '4.0'), CHANGED + '/E:P', CHANGED + '/CR:H', CHANGED + '/MAV:L']) {
    const result = cvss31BaseScore(vector);
    assert.equal(result.kind, 'unsupported');
    assert.equal(Object.hasOwn(result, 'score'), false);
  }
});

test('the supplied score/vector mismatch is flagged with a line reference and survives export', () => {
  const draft = `Severity: Critical\n\n${CHANGED} = 9.8`;
  const result = severity(draft);
  assert.equal(result.status, 'flagged');
  assert.equal(result.evidence[0].line, 3);
  assert.match(result.evidence[0].note, /9\.8 differs.*10\.0/);
  assert.match(checklistMarkdown(checkReport(draft)), /L3:.*9\.8 differs.*10\.0/);
});

test('labelled scores before and after a vector work with ordinary Markdown formatting', () => {
  const examples = [
    `CVSS score: 9.8 (${UNCHANGED})`,
    `**CVSS v3.1 base score:** **9.8** (${UNCHANGED})`,
    `CVSS: 9.8/10 (Critical) [${UNCHANGED}]`,
    `\`${UNCHANGED}\` = 9.8`,
    `(${UNCHANGED}): 9.8`,
    `${UNCHANGED} score: 9.8`,
    `${UNCHANGED} = 9.8/10`,
    `${UNCHANGED} (base score: 9.8)`,
  ];
  for (const example of examples) {
    const result = severity(`Severity: Critical\n${example}`);
    assert.equal(result.status, 'pass', example);
    assert.match(result.finding, /Base score matches/, example);
  }
});

test('the score check validates arithmetic without asserting the selected metrics or severity are right', () => {
  const result = severity(`Severity: Medium\n${CHANGED} = 10.0`);
  assert.equal(result.status, 'pass');
  assert.match(result.finding, /metric choices are not verified/);
  assert.equal(severity(`${CHANGED} = 10.0`).status, 'missing', 'CVSS is not a substitute for the programme severity');
});

test('invalid base vectors and invalid score ranges are flagged without inventing missing metrics', () => {
  for (const example of [`${CHANGED.replace('/I:H', '')} = 10.0`, `${CHANGED} = 11`, `${CHANGED} = -1`, `${CHANGED} = 9.85`]) {
    assert.equal(severity(`Severity: High\n${example}`).status, 'flagged', example);
  }
  assert.match(severity(`Severity: High\n${CHANGED.replace('/I:H', '')} = 10`).evidence[0].note, /missing I/);
});

test('CVSS is optional and code examples do not change the report severity check', () => {
  const ordinary = severity('Severity: High');
  assert.equal(ordinary.finding, 'Severity stated: high.');
  assert.equal(ordinary.evidence.length, 1);
  const quoted = severity(`Severity: High\n\n\`\`\`text\n${CHANGED} = 9.8\n\`\`\``);
  assert.deepEqual(quoted, ordinary);
});

test('unlabelled numbers, a version number, or a score on a different line are not guessed', () => {
  for (const example of [
    `${CHANGED} reported by 9.8 users`,
    `CVSS v3.1: (${CHANGED})`,
    `9.8 (${CHANGED})`,
    `CVSS score: 9.8\n${CHANGED}`,
  ]) {
    const result = severity(`Severity: High\n${example}`);
    assert.equal(result.status, 'pass', example);
    assert.match(result.evidence[0].note, /no single labelled score/, example);
    assert.doesNotMatch(result.finding, /Base score matches/);
  }
});

test('ambiguous pairings and non-Base scores are left for manual review', () => {
  for (const example of [
    `CVSS score: 9.8 (${CHANGED}) = 10`,
    `Temporal CVSS score: 9.8 (${CHANGED})`,
    `${CHANGED}/E:P = 9.8`,
    `${CHANGED.replace('3.1', '4.0')} = 9.8`,
    `${CHANGED} = 9.8; ${UNCHANGED} = 9.8`,
  ]) {
    const result = severity(`Severity: High\n${example}`);
    assert.equal(result.status, 'pass', example);
    assert.doesNotMatch(result.finding, /Base score matches/);
    assert.ok(result.evidence[0].note, example);
  }
});

test('long and truncated vector lines are bounded and not falsely reported as complete', () => {
  const result = severity(`Severity: High\n${CHANGED} = 9.8 ${'x'.repeat(100000)}`);
  assert.equal(result.status, 'pass');
  assert.match(result.evidence[0].note, /one complete vector per line/);
});
