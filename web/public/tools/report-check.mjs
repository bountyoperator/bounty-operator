// /tools/report-check: runs the fourteen checks on the pasted draft and renders
// the result. The draft never leaves this tab; the workbench handoff writes it
// to session storage and opens /#workspace. The first check of a draft is
// counted by name (ping.mjs): the request carries nothing of the draft.

import { checkReport, checklistMarkdown, workbenchHandoff } from './report-check-core.mjs';
import { byId, chip, clear, copyWithFeedback, el, isPlainClick, notice, sendToWorkbench } from './dom.mjs';
import { ping } from './ping.mjs';

const DEBOUNCE_MS = 200;

const STATUS = {
  pass: { label: 'Pass', tone: 'ok', dashed: false },
  missing: { label: 'Missing', tone: 'unproven', dashed: true },
  flagged: { label: 'Flagged', tone: 'danger', dashed: false },
};

// A hand-written draft with several open items, so the result shows all three states.
const EXAMPLE = `# Missing checkpoint in \`stake()\` lets a new staker drain accrued rewards

Severity: High

## Target
https://github.com/example-protocol/tidal-staking/blob/main/src/TidalStaking.sol

## Impact
The closest impact is loss of rewards. A new staker is paid rewards that accrued before the stake, so an attacker could potentially take the whole reward balance.

## Attack path
1. The owner calls notifyReward() with 7 ETH for a 7 day period.
2. Alice stakes 100 TIDE and three days pass.
3. Mallory stakes 200 TIDE. updateReward() skips her checkpoint because her balance is still 0.
4. Mallory calls claim() in the same block and receives 5.99 ETH.

## Proof
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

const draft = /** @type {HTMLTextAreaElement} */ (byId('draft'));
const scoreNumber = byId('score-n');
const scoreText = byId('score-text');
const scoreNote = byId('score-note');
const tally = byId('tally');
const list = byId('checks');
const copyButton = /** @type {HTMLButtonElement} */ (byId('check-copy'));
const handoffLink = byId('check-handoff');
const score = byId('score');

// The static list of checks, shown again whenever the draft is empty.
const pending = [...list.children].map((node) => node.cloneNode(true));

let report = checkReport('');
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

function render() {
  report = checkReport(draft.value);
  const squares = [...tally.children];
  report.checks.forEach((check, index) => {
    if (report.empty) squares[index]?.removeAttribute('data-status');
    else squares[index]?.setAttribute('data-status', check.status);
  });

  scoreNumber.textContent = String(report.passed);
  scoreText.textContent = `of ${report.total} checks pass`;
  score.toggleAttribute('data-ready', !report.empty);
  copyButton.disabled = report.empty;
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
  list.append(...report.checks.map(checkItem));
}

function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(render, DEBOUNCE_MS);
}

draft.addEventListener('input', schedule);

byId('check-run').addEventListener('click', () => {
  render();
  if (report.empty) draft.focus();
});

byId('check-example').addEventListener('click', () => {
  draft.value = EXAMPLE;
  render();
});

byId('check-clear').addEventListener('click', () => {
  draft.value = '';
  render();
  draft.focus();
});

copyButton.addEventListener('click', () => {
  if (!report.empty) copyWithFeedback(copyButton, checklistMarkdown(report));
});

// With a draft on the page the link hands it over; without one it is a plain
// link to the workbench with the report profile selected.
handoffLink.addEventListener('click', (event) => {
  if (!draft.value.trim() || !isPlainClick(event)) return;
  event.preventDefault();
  render();
  if (!sendToWorkbench(workbenchHandoff(draft.value, report))) {
    byId('check-notice').replaceChildren(notice('error', 'The draft could not be handed over.', 'This browser blocked session storage. Copy the draft and paste it into the workbench.'));
  }
});

// A draft the browser restored after a reload is checked straight away.
if (draft.value.trim()) render();
