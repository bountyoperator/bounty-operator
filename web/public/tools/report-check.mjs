// /tools/report-check: runs the seventeen checks on the pasted draft and renders
// the result. The draft never leaves this tab; the workbench handoff writes it
// to session storage and opens /#workspace. The first check of a draft is
// counted by name (ping.mjs): the request carries nothing of the draft.

import { checkReport, checklistMarkdown, workbenchHandoff } from './report-check-core.mjs';
import { byId, chip, clear, copyWithFeedback, downloadText, el, isPlainClick, notice, readTextFiles, sendToWorkbench, wireDrop } from './dom.mjs';
import { ping } from './ping.mjs';
import { addEvidence, checkEvidence, createEvidencePacket, evidenceExcerpt, evidenceLimits, evidenceMarkdown, PACKET_MAX_BYTES, REFERENCE_STATUS, reportFiles, restoreEvidencePacket } from './report-evidence-core.mjs';

const DEBOUNCE_MS = 200;

const STATUS = {
  pass: { label: 'Pass', tone: 'ok', dashed: false },
  missing: { label: 'Missing', tone: 'unproven', dashed: true },
  flagged: { label: 'Flagged', tone: 'danger', dashed: false },
};

// A hand-written draft with several open items, so the result shows all three
// states. Its citations show every citation state too: four resolve, one points
// past the end of the file and one names a file that is not attached.
const EXAMPLE = `# Missing checkpoint in \`stake()\` lets a new staker drain accrued rewards

Severity: High

## Target
https://github.com/example-protocol/tidal-staking/blob/main/src/TidalStaking.sol

## Impact
The closest impact is loss of rewards. A new staker is paid rewards that accrued before the stake, so an attacker could potentially take the whole reward balance.

## Root cause
\`_updateReward()\` returns before the checkpoint when the caller's balance is 0 (src/TidalStaking.sol:16-18). \`stake()\` calls it before the balance is credited (src/TidalStaking.sol:22-23), so \`earned()\` later pays the whole accumulator since launch (src/TidalStaking.sol:29). \`claim()\` then transfers it (src/TidalStaking.sol:88).

## Attack path
1. The owner calls notifyReward() with 7 ETH for a 7 day period.
2. Alice stakes 100 TIDE and three days pass.
3. Mallory stakes 200 TIDE. updateReward() skips her checkpoint because her balance is still 0.
4. Mallory calls claim() in the same block and receives 5.99 ETH.

## Proof
Full test: test/FreshStaker.t.sol:12. Output: forge-output.txt:2-4.

\`\`\`
$ forge test --match-test test_freshStakerDrainsRewards -vvv
[PASS] test_freshStakerDrainsRewards() (gas: 214512)
Suite result: ok. 1 passed; 0 failed; 0 skipped
\`\`\`

\`\`\`solidity
function test_freshStakerDrainsRewards() public {
    vm.prank(owner);
    staking.notifyReward{value: 7 ether}();
    vm.prank(alice);
    staking.stake(100e18);
    vm.warp(block.timestamp + 3 days);

    vm.startPrank(mallory);
    staking.stake(200e18);
    staking.claim();
    assertEq(mallory.balance, 5.99 ether);
}
\`\`\`

## Limits
This report does not claim loss of staked principal. The proof was not tested against the upgraded proxy.
`;
const EXAMPLE_FILES = [
  {
    name: 'src/TidalStaking.sol',
    content: [
      '// SPDX-License-Identifier: MIT',
      'pragma solidity ^0.8.24;',
      '',
      'contract TidalStaking {',
      '    uint256 public rewardRate;',
      '    uint256 public lastUpdate;',
      '    uint256 public rewardPerTokenStored;',
      '    uint256 public totalStaked;',
      '    mapping(address => uint256) public balanceOf;',
      '    mapping(address => uint256) public userRewardPerTokenPaid;',
      '    mapping(address => uint256) public rewards;',
      '',
      '    function _updateReward(address account) internal {',
      '        rewardPerTokenStored = rewardPerToken();',
      '        lastUpdate = block.timestamp;',
      '        if (balanceOf[account] == 0) return;',
      '        rewards[account] = earned(account);',
      '        userRewardPerTokenPaid[account] = rewardPerTokenStored;',
      '    }',
      '',
      '    function stake(uint256 amount) external {',
      '        _updateReward(msg.sender);',
      '        balanceOf[msg.sender] += amount;',
      '        totalStaked += amount;',
      '    }',
      '',
      '    function earned(address account) public view returns (uint256) {',
      '        return rewards[account]',
      '            + balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account]) / 1e18;',
      '    }',
      '',
      '    function claim() external {',
      '        _updateReward(msg.sender);',
      '        uint256 amount = rewards[msg.sender];',
      '        rewards[msg.sender] = 0;',
      '        payable(msg.sender).transfer(amount);',
      '    }',
      '',
      '    function rewardPerToken() public view returns (uint256) {',
      '        if (totalStaked == 0) return rewardPerTokenStored;',
      '        return rewardPerTokenStored + (block.timestamp - lastUpdate) * rewardRate * 1e18 / totalStaked;',
      '    }',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'forge-output.txt',
    content: [
      '$ forge test --match-test test_freshStakerDrainsRewards -vvv',
      '[PASS] test_freshStakerDrainsRewards() (gas: 214512)',
      'Logs:',
      '  mallory claimed: 5990000000000000000',
      'Suite result: ok. 1 passed; 0 failed; 0 skipped',
      '',
    ].join('\n'),
  },
];

const draft = /** @type {HTMLTextAreaElement} */ (byId('draft'));
const scoreNumber = byId('score-n');
const scoreText = byId('score-text');
const scoreNote = byId('score-note');
const tally = byId('tally');
const list = byId('checks');
const copyButton = /** @type {HTMLButtonElement} */ (byId('check-copy'));
const handoffLink = byId('check-handoff');
const score = byId('score');
const saveButton = byId('check-save');
const evidenceList = byId('evidence-files');
const refList = byId('evidence-refs');

// The static list of checks, shown again whenever the draft is empty.
const pending = [...list.children].map((node) => node.cloneNode(true));

let report = checkReport('');
let evidence = [];
let evidenceResult = checkEvidence('');
let editVersion = 0;
let timer = 0;

/** Selects one line of the draft, so a quoted line can be found and fixed. */
function selectLine(number) {
  const lines = draft.value.split(/\r\n|\r|\n/);
  let start = 0;
  for (let index = 0; index < number - 1 && index < lines.length; index += 1) start += lines[index].length + 1;
  const end = start + (lines[number - 1]?.length ?? 0);
  draft.focus();
  draft.setSelectionRange(start, end);
  // Scroll the selection into view: a textarea does not do it on its own.
  const lineHeight = parseFloat(getComputedStyle(draft).lineHeight) || 20;
  draft.scrollTop = Math.max(0, (number - 4) * lineHeight);
}

function evidenceItem(evidence) {
  const lineButton = el('button', { class: 'check__line', type: 'button', text: `L${evidence.line}`, 'aria-label': `Select line ${evidence.line} in the draft` });
  lineButton.addEventListener('click', () => selectLine(evidence.line));
  const item = el('li', {}, [lineButton]);
  // A secret is reported by kind only: there is no quote to show.
  if (evidence.quote !== null) item.append(el('code', { class: 'check__quote', text: evidence.quote }));
  if (evidence.note) item.append(el('span', { class: 'check__note', text: evidence.note }));
  return item;
}

function checkItem(check) {
  const status = STATUS[check.status];
  const item = el('li', { class: 'check', 'data-status': check.status }, [
    el('div', { class: 'check__head' }, [
      chip(status.label, status.tone, { dashed: status.dashed }),
      el('h3', { class: 'check__label', text: check.label }),
    ]),
    el('p', { class: 'check__finding', text: check.finding }),
  ]);
  if (check.evidence.length) {
    const evidence = el('ul', { class: 'check__evidence' }, check.evidence.map(evidenceItem));
    if (check.more) evidence.append(el('li', { class: 'check__more', text: `and ${check.more} more` }));
    item.append(evidence);
  }
  if (check.status !== 'pass') {
    item.append(el('p', { class: 'check__fix' }, [el('span', { class: 'meta', text: 'Fix' }), el('span', { text: check.fix })]));
  }
  return item;
}

function showEvidenceMessage(title, message, tone = 'error') {
  byId('evidence-notice').replaceChildren(notice(tone, title, message));
}

function renderEvidence() {
  evidenceResult = checkEvidence(draft.value, evidence);
  clear(evidenceList);
  evidence.forEach((file, index) => {
    const remove = el('button', { class: 'check__line', type: 'button', text: 'Remove', 'aria-label': `Remove ${file.name}` });
    remove.addEventListener('click', () => {
      evidence = evidence.filter((_, at) => at !== index);
      editVersion += 1;
      render();
      byId('evidence-drop-input').focus();
    });
    evidenceList.append(el('li', {}, [el('span', { text: file.name }), remove]));
  });
  byId('evidence-file-count').textContent = evidence.length ? `${evidence.length} ${evidence.length === 1 ? 'file' : 'files'} attached. Cite them as ${evidence[0].name}:12 or ${evidence[0].name}:12-18.` : 'No files attached.';
  const { linked, total, unresolved, remoteLinks, omitted } = evidenceResult;
  clear(refList);
  // Before any file is attached, every citation would read "File not attached":
  // one line says that instead of a row per citation.
  if (!evidence.length) {
    byId('evidence-summary').textContent = total
      ? `${total} file:line ${total === 1 ? 'citation' : 'citations'} in the draft. Attach the cited files to check that each line exists.`
      : 'No file:line citations in the draft. Cite code as src/Vault.sol:42-48 so a triager can find it.';
    return;
  }
  byId('evidence-summary').textContent = total
    ? `${linked} of ${total} citations point at a real line${unresolved ? `; ${unresolved} ${unresolved === 1 ? 'does' : 'do'} not` : ''}.`
    : 'No file:line citations in the draft. Cite the attached files as src/Vault.sol:42-48 so a triager can find the line.';
  for (const ref of evidenceResult.refs) {
    const draftLink = el('button', { class: 'check__line', type: 'button', text: `L${ref.draftLine}`, 'aria-label': `Select line ${ref.draftLine} in the draft` });
    draftLink.addEventListener('click', () => selectLine(ref.draftLine));
    const location = `${ref.path}:${ref.start}${ref.end === ref.start ? '' : `-${ref.end}`}`;
    const tone = ref.status === 'linked' ? 'ok' : ref.status === 'range' ? 'danger' : 'unproven';
    const body = el('li', { 'data-status': ref.status }, [
      el('div', { class: 'report-reference-head' }, [el('code', { text: location }), chip(REFERENCE_STATUS[ref.status], tone), draftLink]),
    ]);
    if (ref.status === 'linked') {
      body.append(el('details', { class: 'report-source' }, [
        el('summary', { text: ref.end === ref.start ? `View line ${ref.start}` : `View lines ${ref.start}–${ref.end}` }),
        el('pre', { tabindex: '0' }, [el('code', { text: evidenceExcerpt(ref, evidence) })]),
      ]));
    } else if (ref.status === 'range') body.append(el('p', { class: 'fine', text: `${ref.name} has ${ref.lines} lines. Fix the line number or attach the version you cited.` }));
    else if (ref.status === 'ambiguous') body.append(el('p', { class: 'fine', text: `Use the full path: ${ref.choices.join(' or ')}.` }));
    else body.append(el('p', { class: 'fine', text: 'Attach this file or correct its name in the draft.' }));
    refList.append(body);
  }
  if (remoteLinks || omitted) refList.append(el('li', { class: 'fine', text: [remoteLinks ? `${remoteLinks} external ${remoteLinks === 1 ? 'link was' : 'links were'} not opened.` : '', omitted ? `${omitted} more citations are not listed.` : ''].filter(Boolean).join(' ') }));
}

function takeEvidence(incoming) {
  const result = addEvidence(evidence, incoming, draft.value);
  evidence = result.files;
  editVersion += 1;
  if (result.errors.length) showEvidenceMessage('Some files were not added.', result.errors.join(' '));
  else clear(byId('evidence-notice'));
  render();
  return result.errors.length === 0;
}

function render() {
  report = checkReport(draft.value);
  renderEvidence();
  const squares = [...tally.children];
  report.checks.forEach((check, index) => {
    if (report.empty) squares[index]?.removeAttribute('data-status');
    else squares[index]?.setAttribute('data-status', check.status);
  });

  scoreNumber.textContent = String(report.passed);
  scoreText.textContent = `of ${report.total} checks pass`;
  score.toggleAttribute('data-ready', !report.empty);
  copyButton.disabled = report.empty;
  saveButton.disabled = report.empty;
  clear(list);

  if (report.empty) {
    scoreNote.textContent = 'Paste a draft, or load the example, to see each check with the line it found.';
    list.append(...pending.map((node) => node.cloneNode(true)));
    return;
  }
  ping('tool_report_check');
  const open = [];
  if (report.missing) open.push(`${report.missing} missing`);
  if (report.flagged) open.push(`${report.flagged} flagged`);
  scoreNote.textContent = open.length ? `${open.join(', ')}. ${report.lines} lines read.` : `Nothing open. ${report.lines} lines read.`;
  // Open checks first; the passing ones fold under one line.
  list.append(...report.checks.filter((check) => check.status !== 'pass').map(checkItem));
  const passed = report.checks.filter((check) => check.status === 'pass');
  if (passed.length) list.append(el('li', { class: 'report-found' }, [el('details', {}, [el('summary', { text: `${passed.length} ${passed.length === 1 ? 'check passes' : 'checks pass'}` }), el('ol', { class: 'checks' }, passed.map(checkItem))])]));
}

function schedule() {
  editVersion += 1;
  window.clearTimeout(timer);
  timer = window.setTimeout(render, DEBOUNCE_MS);
}

draft.addEventListener('input', schedule);

byId('check-run').addEventListener('click', () => {
  render();
  if (report.empty) draft.focus();
});

byId('check-example').addEventListener('click', () => {
  editVersion += 1;
  draft.value = EXAMPLE;
  evidence = EXAMPLE_FILES.map((file) => ({ ...file }));
  clear(byId('evidence-notice'));
  render();
});

byId('check-clear').addEventListener('click', () => {
  editVersion += 1;
  draft.value = '';
  evidence = [];
  clear(byId('evidence-notice'));
  clear(byId('check-notice'));
  render();
  draft.focus();
});

copyButton.addEventListener('click', () => {
  render();
  if (!report.empty) copyWithFeedback(copyButton, evidence.length ? `${checklistMarkdown(report)}\n${evidenceMarkdown(evidenceResult, evidence)}` : checklistMarkdown(report));
});

wireDrop(byId('evidence-drop'), async (entries) => {
  const version = editVersion;
  const read = await readTextFiles(entries, { maxBytes: 120000 });
  if (version !== editVersion) return showEvidenceMessage('Files were not added.', 'The draft changed while files were being read. Choose the files again.');
  takeEvidence(read.files);
  if (read.skipped.length) showEvidenceMessage('Some files were not added.', read.skipped.map((file) => `${file.name}: ${file.reason}`).join(' '));
});

byId('evidence-add').addEventListener('click', () => {
  const name = byId('evidence-name').value.trim();
  const content = byId('evidence-content').value;
  if (!name) {
    showEvidenceMessage('Name the file first.', 'Use the name your draft cites, for example forge-output.txt or src/Vault.sol.');
    byId('evidence-name').focus();
    return;
  }
  if (takeEvidence([{ name, content }])) {
    byId('evidence-name').value = '';
    byId('evidence-content').value = '';
    byId('evidence-name').focus();
  }
});

saveButton.addEventListener('click', async () => {
  if (!draft.value.trim()) return;
  saveButton.disabled = true;
  try {
    const packet = await createEvidencePacket(draft.value, evidence);
    downloadText('report-evidence.json', `${JSON.stringify(packet, null, 2)}\n`, 'application/json');
    byId('check-notice').replaceChildren(notice('success', 'Evidence packet saved.', 'It contains your draft and attachments. Reopen it here to continue with the same files.'));
  } catch (error) {
    byId('check-notice').replaceChildren(notice('error', 'The packet could not be saved.', error.message));
  } finally { saveButton.disabled = !draft.value.trim(); }
});

byId('evidence-restore').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const version = editVersion;
  try {
    if (file.size > PACKET_MAX_BYTES) throw new Error('This packet is too large.');
    const restored = await restoreEvidencePacket(await file.text());
    if (version !== editVersion) throw new Error('The draft changed while the packet was being read. Open it again to restore.');
    draft.value = restored.draft;
    evidence = restored.files;
    editVersion += 1;
    render();
    showEvidenceMessage('Evidence packet opened.', 'All file checksums match. The draft checks were run again.', 'success');
  } catch (error) { showEvidenceMessage('The packet was not opened.', error.message); }
});

// With a draft on the page the link hands it over; without one it is a plain
// link to the workbench with the report profile selected.
handoffLink.addEventListener('click', (event) => {
  if (!draft.value.trim() || !isPlainClick(event)) return;
  event.preventDefault();
  render();
  const error = evidenceLimits(draft.value, evidence);
  if (error) {
    byId('check-notice').replaceChildren(notice('error', 'The draft could not be handed over.', error));
    return;
  }
  if (!sendToWorkbench(workbenchHandoff(draft.value, report, reportFiles(draft.value, evidence)))) {
    byId('check-notice').replaceChildren(notice('error', 'The draft could not be handed over.', 'This browser blocked session storage. Copy the draft and paste it into the workbench.'));
  }
});

// A draft the browser restored after a reload is checked straight away.
if (draft.value.trim()) render();
