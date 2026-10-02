// Tests for the report check at /tools/report-check.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKS,
  DRAFT_NAME,
  SELF_NEGATING_PHRASES,
  checkReport,
  checklistMarkdown,
  scoreLine,
  workbenchHandoff,
} from '../public/tools/report-check-core.mjs';

const COMMIT = '3f9c2a71d0b84e6fa1c5d2e9b7a6c4f8e1d0b3a2';

// A draft that carries everything the fourteen checks look for.
const STRONG = `# Missing checkpoint in \`stake()\` lets a new staker drain accrued rewards

Severity: High

## Scope
Asset: https://github.com/example-protocol/staking/blob/${COMMIT}/src/TidalStaking.sol
Commit: ${COMMIT}

## Impact
"Theft of unclaimed yield"

A new staker is paid rewards that accrued before the stake. The loss is capped at the reward balance the contract holds.

## Attack path
1. Alice stakes 100e18 and rewards accrue for three days.
2. Mallory stakes 200e18 in block N.
3. Mallory calls claim() in block N and receives 4.66 ETH that belongs to Alice.

## Proof
\`\`\`
$ forge test --match-test test_freshStakerDrainsRewards -vvv
[PASS] test_freshStakerDrainsRewards() (gas: 214512)
Suite result: ok. 1 passed; 0 failed; 0 skipped
\`\`\`

\`\`\`solidity
function test_freshStakerDrainsRewards() public {
    vm.prank(mallory);
    staking.stake(200e18);
    vm.prank(mallory);
    staking.claim();
    assertEq(mallory.balance, 4.66 ether);
}
\`\`\`

## Prior art
The 2025 audit report lists a rounding issue in earned(). This finding differs from it: the root cause is the skipped checkpoint, not the division.

## Limits
This report does not claim loss of staked principal. The proof was not tested against the upgraded proxy.
`;

const byId = (report) => Object.fromEntries(report.checks.map((check) => [check.id, check]));
const statuses = (report) => Object.fromEntries(report.checks.map((check) => [check.id, check.status]));

describe('report check', () => {
  test('defines fourteen checks, each with a label, a test line and a one-sentence fix', () => {
    assert.equal(CHECKS.length, 14);
    assert.equal(new Set(CHECKS.map((check) => check.id)).size, 14);
    for (const check of CHECKS) {
      assert.ok(check.label && check.test && check.source, check.id);
      assert.match(check.fix, /^[A-Z][^.]*\.$/, `${check.id} fix is one sentence`);
    }
    assert.deepEqual([...SELF_NEGATING_PHRASES], [
      'closest impact', 'if compromised', 'assuming', 'could potentially', 'currently zero', 'can be avoided by', 'does not establish',
    ]);
  });

  test('a complete draft passes every check', () => {
    const report = checkReport(STRONG);
    const open = report.checks.filter((check) => check.status !== 'pass').map((check) => `${check.id}: ${check.finding}`);
    assert.deepEqual(open, []);
    assert.equal(scoreLine(report), '14 of 14 checks pass');
    assert.equal(report.passed + report.missing + report.flagged, report.total);
  });

  test('an empty draft passes nothing and says so', () => {
    const report = checkReport('  \n');
    assert.equal(report.empty, true);
    assert.equal(scoreLine(report), '0 of 14 checks pass');
    assert.ok(report.checks.every((check) => check.status === 'missing' && check.finding === 'No draft supplied.'));
  });

  test('findings state what the text contains, never a verdict', () => {
    const report = checkReport('# Bug\n\nThe contract is broken.\n');
    const text = report.checks.map((check) => `${check.finding} ${check.fix}`).join(' ');
    assert.doesNotMatch(text, /\b(?:invalid|valid|will be (?:rejected|accepted|paid)|not a bug|is a bug|out of scope)\b/i);
    assert.equal(byId(report).revision.finding, 'No commit hash found.');
  });

  test('title: mechanism and consequence', () => {
    const title = (text) => byId(checkReport(text)).title;
    assert.equal(title('# Reentrancy in withdraw\n').status, 'flagged');
    assert.equal(title('# Reentrancy in withdraw\n').finding, 'Title is 3 words.');
    assert.equal(title('# The reward math inside the staking contract is wrong\n').finding, 'Title names no consequence: nothing lost, locked, read, bypassed or blocked.');
    assert.equal(title('# Missing access control in the admin settings page\n').status, 'flagged');
    assert.equal(title('# Reentrancy in withdraw() lets a staker drain the reward pool\n').status, 'pass');
    // A web finding: the consequence is what the attacker reads.
    assert.equal(title('## Summary:\nIDOR in /api/v2/invoices/{id} lets any logged-in user read other invoices\n').status, 'pass');
    assert.equal(title('Title: [High] Stale price in `liquidate` allows theft of collateral\n').status, 'pass');
    // A section heading or a labelled field is not a title.
    assert.equal(title('## Summary\n\nA long paragraph. With two sentences in it.\n').status, 'missing');
    assert.equal(title('Severity: High\n\n## Description\n\nText here. And more text.\n').status, 'missing');
    assert.equal(title('# Missing check in claim() lets anyone steal rewards\n').evidence[0].line, 1);
  });

  test('scope: a label needs an address, a repository or a file next to it', () => {
    const scope = (text) => byId(checkReport(text)).scope;
    assert.equal(scope('# T\n\nTarget: 0x' + 'a1'.repeat(20) + '\n').status, 'pass');
    assert.equal(scope('# T\n\n## Scope\n\nsrc/Vault.sol\n').status, 'pass');
    assert.equal(scope('# T\n\nScope: the staking system\n').finding, 'A scope line was found. It names no address, repository or file.');
    assert.equal(scope('# T\n\nThis class is out of scope: https://example.com\n').finding, 'No line names the asset in scope.');
  });

  test('revision: a commit hash passes, a branch link is flagged', () => {
    const revision = (text) => byId(checkReport(text)).revision;
    assert.equal(revision(`Reproduced at commit ${COMMIT.slice(0, 9)}.\n`).status, 'pass');
    assert.equal(revision(`See https://github.com/a/b/blob/${COMMIT}/src/A.sol#L10\n`).status, 'pass');
    assert.equal(revision('\`\`\`\ngit checkout 9fceb02\n\`\`\`\n').status, 'pass');
    // An address, a transaction hash and a plain number are not commits.
    assert.equal(revision(`Vault 0x${'ab12'.repeat(10)} tx 0x${'cd34'.repeat(16)} amount 1000000000\n`).status, 'missing');
    assert.equal(revision('The 2025 commit added 1234567 wei.\n').status, 'missing');

    const branch = revision(`Commit ${COMMIT}\nhttps://github.com/a/b/blob/main/src/A.sol#L10\n`);
    assert.equal(branch.status, 'flagged');
    assert.equal(branch.finding, '1 code link points at a branch, which moves.');
    assert.equal(branch.evidence[0].line, 2);
  });

  test('impact: the row must be quoted or use standard row wording', () => {
    const impact = (text) => byId(checkReport(text)).impact;
    assert.equal(impact('## Impact\n\nAn attacker takes the rewards.\n').finding, 'Impact section found. No impact row in quotation marks.');
    assert.equal(impact('The bug is bad.\n').finding, 'No impact section found.');
    assert.equal(impact('## Impact\n\n> Permanent loss of user deposits above the stated threshold\n').status, 'pass');
    assert.equal(impact('Selected impact: “Loss of user funds by direct theft”\n').status, 'pass');
    assert.equal(impact('Impact: Direct theft of any user funds, whether at-rest or in-motion\n').finding, 'Impact row wording found.');
    // A quoted string far from the impact heading does not count.
    assert.equal(impact('## Impact\n\nFunds are lost.\n\n\n\n\n\n\nThe call reverts with "transfer amount exceeds balance".\n').status, 'missing');
  });

  test('severity: one level passes, a range or two levels are flagged', () => {
    const severity = (text) => byId(checkReport(text)).severity;
    assert.equal(severity('No level here.\n').finding, 'No severity statement found.');
    assert.equal(severity('**Severity**: Medium\n').finding, 'Severity stated: medium.');
    assert.equal(severity('## Severity\n\nCritical\n').status, 'pass');
    assert.equal(severity('Severity: High\n\nThis high-severity issue…\n').status, 'pass');
    assert.equal(severity('Severity: Medium/High\n').finding, 'Severity is given as two levels on one line.');
    assert.equal(severity('Severity: Medium to High\n').status, 'flagged');

    const mixed = severity('# [High] Title\n\nSeverity: Critical\n');
    assert.equal(mixed.finding, 'Severity is stated as high and critical.');
    assert.deepEqual(mixed.evidence.map((entry) => entry.line), [1, 3]);
    // The word inside a code block is not a statement.
    assert.equal(severity('\`\`\`\nseverity: high\n\`\`\`\n').status, 'missing');
  });

  test('roles: trusted-role words inside the numbered attack path are quoted', () => {
    const roles = (text) => byId(checkReport(text)).roles;
    assert.equal(roles('Prose only.\n').finding, 'No numbered attack path found.');

    const flagged = roles('## Attack path\n1. The owner sets the fee to 100%.\n2. Mallory deposits.\n3. Governance pauses.\n\n## Recommendation\n1. Let only the admin call it.\n');
    assert.equal(flagged.status, 'flagged');
    assert.equal(flagged.finding, '2 attack steps name a trusted role.');
    assert.deepEqual(flagged.evidence.map((entry) => [entry.line, entry.note]), [[2, 'names “owner”'], [4, 'names “governance”']]);

    // Without an attack heading, numbered fixes are still left out.
    const fallback = roles('1. Mallory deposits.\n2. Mallory withdraws twice.\n\n## Recommendation\n1. Restrict it to the owner.\n');
    assert.equal(fallback.status, 'pass');
    assert.match(fallback.finding, /^2 numbered steps\./);
  });

  test('proof: needs a command and its output in the body', () => {
    const proof = (text) => byId(checkReport(text)).proof;
    assert.equal(proof('Words.\n').finding, 'No proof found: no code block, command or output.');
    assert.equal(proof('PoC: https://gist.github.com/someone/abc123\n').finding, 'The proof is a link. No command or output is in the report body.');
    assert.equal(proof('PoC: https://gist.github.com/someone/abc123\n').status, 'flagged');
    assert.equal(proof('Run `forge test --match-test testExploit -vvv`.\n').finding, 'Command found. No captured output found.');
    assert.equal(proof('\`\`\`\n[PASS] testExploit() (gas: 1234)\n\`\`\`\n').finding, 'Captured output found. No command found.');
    assert.equal(proof('\`\`\`solidity\nfunction f() public {}\n\`\`\`\n').finding, 'Code block found. No command and no captured output.');

    const pass = proof('\`\`\`\n$ npx hardhat test test/exploit.js\n  1 passing (2s)\n\`\`\`\n');
    assert.equal(pass.status, 'pass');
    assert.deepEqual(pass.evidence.map((entry) => entry.note), ['command', 'output']);
    // Whatever a "$" prompt printed counts as its output, here an HTTP response body.
    const web = proof('\`\`\`\n$ curl -s https://app.example.com/api/v2/invoices/1042\n{"id":1042,"customer":"A"}\n\`\`\`\n');
    assert.equal(web.status, 'pass');
    assert.equal(web.evidence[1].quote, '{"id":1042,"customer":"A"}');
    assert.equal(proof('\`\`\`\n$ curl -s https://app.example.com/a\n$ curl -s https://app.example.com/b\n\`\`\`\n').finding, 'Command found. No captured output found.');
    assert.equal(proof('\`\`\`\nGET /api/v2/invoices/1042\nHTTP/1.1 200 OK\n\`\`\`\n').finding, 'Captured output found. No command found.');
    // "Make sure…" in prose is not a make command.
    assert.equal(proof('make sure the vault is funded.\n').status, 'missing');
    assert.equal(proof('\`\`\`\nmake exploit\nok  \texploit\t0.2s\n\`\`\`\n').status, 'pass');
  });

  test('assertion: the proof must read a balance, an owner or a stored value', () => {
    const assertion = (text) => byId(checkReport(text)).assertion;
    assert.equal(assertion('assertEq(a, b) in prose is not proof.\n').finding, 'No assertion found in the proof.');
    assert.equal(assertion('\`\`\`\nassertTrue(success);\n\`\`\`\n').finding, '1 assertion found. None reads a balance, an owner or a stored value.');
    assert.equal(assertion('\`\`\`\nassertTrue(success);\nassertEq(token.balanceOf(attacker), 100e18);\nassertTrue(done);\n\`\`\`\n').status, 'pass');
    assert.equal(assertion('\`\`\`js\nexpect(await vault.owner()).to.equal(attacker.address);\n\`\`\`\n').status, 'pass');
    assert.equal(assertion('\`\`\`python\nassert vault.totalSupply() == 0\n\`\`\`\n').status, 'pass');
  });

  test('mocks: pranks of role-named addresses, mocks and forced state are quoted', () => {
    const mocks = (text) => byId(checkReport(text)).mocks;
    assert.equal(mocks('\`\`\`\nvm.prank(mallory);\ndeal(address(token), mallory, 1e18);\n\`\`\`\n').status, 'pass');

    const flagged = mocks('We use a mock oracle.\n\`\`\`\nvm.startPrank(owner);\nvm.store(address(vault), slot, value);\nMockOracle oracle = new MockOracle();\n\`\`\`\n');
    assert.equal(flagged.status, 'flagged');
    assert.equal(flagged.finding, '4 lines use a prank of a role-named address, a mock or a forced state write.');
    assert.deepEqual(flagged.evidence.map((entry) => entry.note), [
      'mentions a mock', 'acts as owner', 'forces state or replaces code', 'forces state or replaces code',
    ]);
  });

  test('prior art and limits are present or missing', () => {
    const report = byId(checkReport('# T\n\nNothing else.\n'));
    assert.equal(report['prior-art'].finding, 'No known-issue or prior-audit comparison found.');
    assert.equal(report.limits.finding, 'No limits or non-claims found.');

    const present = byId(checkReport('Known issue #4 covers fees only.\n\n## Limitations\nMainnet only.\n'));
    assert.equal(present['prior-art'].status, 'pass');
    assert.equal(present.limits.status, 'pass');
    assert.equal(byId(checkReport('The loss is capped at the pool balance.\n')).limits.status, 'pass');
  });

  test('self-negating phrases are flagged with the sentence that holds them', () => {
    const draft = [
      'First sentence is fine. This maps to the closest impact available. Third sentence.',
      'If the admin key is compromised, funds move.',
      'Assuming the pool is empty, the call succeeds.',
      'An attacker could potentially drain it.',
      'The exposed balance is currently zero.',
      'The loss can be avoided by calling sync() first.',
      'The test does not establish that mainnet is affected.',
      '```',
      'assuming could potentially currently zero',
      '```',
    ].join('\n');
    const phrases = byId(checkReport(draft)).phrases;
    assert.equal(phrases.status, 'flagged');
    assert.equal(phrases.finding, '7 sentences contain a listed phrase.');
    assert.equal(phrases.evidence.length, 6);
    assert.equal(phrases.more, 1);
    assert.equal(phrases.evidence[0].quote, 'This maps to the closest impact available.');
    assert.match(phrases.evidence[0].note, /^“closest impact”: /);
    assert.deepEqual(phrases.evidence.map((entry) => entry.line), [1, 2, 3, 4, 5, 6]);

    assert.equal(byId(checkReport('The attacker drains the pool in one call.\n')).phrases.status, 'pass');
  });

  test('secrets and private links are reported by line and kind, never quoted', () => {
    // Assembled at run time so the repository never holds a secret-shaped string.
    const key = `ghp_${'a1B2'.repeat(9)}`;
    const privateLink = ['https://bugs.immunefi.com', 'dashboard', 'submission', '12345'].join('/');
    const draft = `# T\n\ntoken ${key}\nSee ${privateLink}\nContact hunter@protonmail.com\n`;
    const report = checkReport(draft);
    const secrets = byId(report).secrets;

    assert.equal(secrets.status, 'flagged');
    assert.equal(secrets.finding, '2 lines hold a secret or a private link; 1 line holds an email or IP address.');
    assert.deepEqual(secrets.evidence, [
      { line: 3, quote: null, note: 'GitHub token' },
      { line: 4, quote: null, note: 'link to a private platform report' },
      { line: 5, quote: null, note: 'email address' },
    ]);

    const markdown = checklistMarkdown(report);
    assert.ok(!markdown.includes(key) && !markdown.includes('12345') && !markdown.includes('protonmail'));
    assert.match(markdown, /L3: GitHub token/);

    // A draft longer than one review file is scanned to its last line.
    const long = `${'A line of ordinary report text.\n'.repeat(5000)}token ${key}\n`;
    assert.ok(long.length > 150000);
    assert.deepEqual(byId(checkReport(long)).secrets.evidence, [{ line: 5001, quote: null, note: 'GitHub token' }]);
    assert.equal(byId(checkReport('x'.repeat(130000))).secrets.status, 'pass');
    assert.equal(byId(checkReport('# T\n\u0000binary\n')).secrets.finding, 'The privacy scan did not run: the draft is not plain text.');
  });

  test('very long lines are read in bounded time', () => {
    // Each of these made an earlier pattern take quadratic time on one line.
    const drafts = [
      `# title: ${' '.repeat(100000)}x${'a '.repeat(50000)}`,
      `# a${' '.repeat(150000)}b\nSeverity: High\n`,
      `Impact${' '.repeat(150000)}x\n`,
      `Severity${' '.repeat(150000)}x\n`,
      `**${'*'.repeat(150000)} x\n`,
      `${'a.'.repeat(100000)}\n`,
    ];
    for (const draft of drafts) {
      const started = Date.now();
      const report = checkReport(draft);
      assert.equal(report.total, 14);
      assert.ok(Date.now() - started < 2000, `checked in ${Date.now() - started} ms`);
    }
    // The local-path check still reads the whole line.
    assert.equal(byId(checkReport(`${'x'.repeat(9000)} /home/kali/poc/\n`)).paths.status, 'flagged');
  });

  test('headings: closing hashes are dropped, a hash inside a word is kept', () => {
    const title = (text) => byId(checkReport(text)).title;
    assert.equal(title('# Missing check in `claim()` lets anyone drain rewards ##\n').status, 'pass');
    assert.equal(title('## Unchecked cast in the C# bridge lets a caller mint tokens\n').status, 'pass');
    assert.equal(title('**Title:** **Missing check in `claim()` lets anyone drain rewards**\n').status, 'pass');
    assert.equal(title('# ##\n\nSeverity: High\n').status, 'flagged');
  });

  test('local paths are flagged in prose and in traces', () => {
    const paths = (text) => byId(checkReport(text)).paths;
    assert.equal(paths('See src/Vault.sol and https://example.com/home/page/\n').status, 'pass');
    const flagged = paths('Run from /home/kali/audits/x\n\`\`\`\n  at C:\\Users\\dev\\poc\\test.js:4\n  at /Users/sam/poc/test.js:9\n\`\`\`\n');
    assert.equal(flagged.finding, '3 lines contain a local path.');
    assert.deepEqual(flagged.evidence.map((entry) => entry.line), [1, 3, 4]);
  });

  test('a weak draft: the score line and the per-check statuses', () => {
    const weak = [
      '# Reentrancy in withdraw',
      '',
      'Severity: Medium/High',
      '',
      'The closest impact is theft. See https://github.com/acme/vault/blob/main/src/Vault.sol',
      '',
      '1. The owner calls pause().',
      '2. The attacker withdraws.',
      '',
      'PoC: https://gist.github.com/acme/1',
    ].join('\n');
    const report = checkReport(weak);
    assert.deepEqual(statuses(report), {
      title: 'flagged',
      scope: 'missing',
      revision: 'flagged',
      impact: 'missing',
      severity: 'flagged',
      roles: 'flagged',
      proof: 'flagged',
      assertion: 'missing',
      mocks: 'pass',
      'prior-art': 'missing',
      limits: 'missing',
      phrases: 'flagged',
      secrets: 'pass',
      paths: 'pass',
    });
    assert.equal(scoreLine(report), '3 of 14 checks pass');
    assert.equal(report.flagged, 6);
    assert.equal(report.missing, 5);
  });

  test('checklistMarkdown ticks passing checks and lists finding, quotes and fix for the rest', () => {
    const report = checkReport('# Reentrancy in `withdraw()` lets a staker drain the pool\n\nSeverity: Medium or High\n');
    const markdown = checklistMarkdown(report);
    const lines = markdown.split('\n');

    assert.equal(lines[0], `# Report check: ${scoreLine(report)}`);
    assert.ok(lines.includes('- [x] Title states mechanism and consequence'));
    assert.ok(lines.includes('- [ ] Severity stated once and consistent (flagged): Severity is given as two levels on one line.'));
    assert.ok(lines.includes('  - L3: `Severity: Medium or High`'));
    assert.ok(lines.includes('  - Fix: State one severity, at the row the body argues, and remove every other level.'));
    assert.ok(lines.includes('- [ ] Pinned revision (missing): No commit hash found.'));
    assert.equal(lines.filter((line) => /^- \[[ x]\] /.test(line)).length, 14);
    // A backtick in a quoted line cannot break out of its code span.
    assert.match(checklistMarkdown(checkReport('# `a` in `b()` is 3 words\n')), /L1: `# 'a' in 'b\(\)' is 3 words`/);
    assert.ok(markdown.endsWith('https://bountyoperator.com/tools/report-check\n'));
  });

  test('workbenchHandoff follows the bo:handoff contract', () => {
    const draft = '# Reentrancy in withdraw\n';
    const handoff = workbenchHandoff(draft);
    assert.deepEqual(Object.keys(handoff), ['files', 'profile', 'focus', 'context']);
    assert.deepEqual(handoff.files, [{ name: DRAFT_NAME, content: draft }]);
    assert.equal(handoff.profile, 'report');
    assert.deepEqual(handoff.context, {});
    assert.match(handoff.focus, /left these items open: Title states mechanism and consequence \(flagged\); /);
    assert.ok(handoff.focus.length < 16000);

    assert.equal(workbenchHandoff(STRONG).focus, 'Challenge this draft report. Name the sentence a triager would close on.');
    assert.doesNotThrow(() => JSON.stringify(handoff));
  });

  test('a hostile line does not stall the checks', () => {
    const hostile = `${'a '.repeat(40000)}\n${'if '.repeat(30000)}compromised\n${'0x'.repeat(50000)}\n`;
    const started = Date.now();
    checkReport(hostile);
    assert.ok(Date.now() - started < 2000);
  });
});
