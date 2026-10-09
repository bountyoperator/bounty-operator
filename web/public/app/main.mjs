/**
 * The workbench entry. Loaded as a module script by the page that holds
 * web/site/fragments/workbench.mjs.
 *
 * On load it restores the tab's work (or takes the handoff another page left),
 * applies a deep link, wires every workbench module, and finishes an
 * OpenRouter connection or a Stripe return in progress.
 *
 * Deep links
 *   /?profile=<id>#workspace     preselect a listed profile and open the Load step
 *   /?start=<id>#workspace       the same, for hero buttons (`?start=report`)
 *   /?start=example#workspace    load the bundled example
 *   sessionStorage["bo:handoff"] files, profile, focus and context from a tool or template page
 *
 * Any element with a `data-example` attribute loads an example when clicked;
 * its value is the example id, or empty for the first one.
 *
 * Exports (for tests and for other entry code)
 *   boot()                       -> boolean   false when the page has no workbench
 *   loadExample(id?)             -> Promise<boolean>
 *   exampleList(module)          -> Example[]   the usable entries of an example module; pure
 *   deepLink(search)             -> { profile, example }   pure
 *   PLACEHOLDER_EXAMPLE          the example used until web/public/example.mjs supplies entries in the v0.7 shape
 */

import { reviewProfile } from '../profiles.mjs';
import { manifestFor } from '../review-core.mjs';
import { account, track } from './api.mjs';
import { initDossier } from './dossier.mjs';
import { EVENTS } from './events.mjs';
import { initFiles, showFileErrors } from './files.mjs';
import { initGauntlet } from './gauntlet.mjs';
import { initGithub } from './github-ui.mjs';
import { initHistory } from './history.mjs';
import { initPanel } from './panel.mjs';
import { initPasteback } from './pasteback.mjs';
import { initProviders, resumeOpenRouter } from './providers-ui.mjs';
import { initResults } from './results.mjs';
import { initRun } from './run.mjs';
import { initSourcePane } from './source-pane.mjs';
import { initialState, loadWorkbench, persistWorkbench, takeHandoff, workbench } from './state.mjs';
import { formatDate, on, qs } from './ui.mjs';
import { WORK_FIELDS, enterExample, initWorkbench, leaveExample, say, sayQuietly, setStep, view } from './workbench.mjs';

// ---------------------------------------------------------------------------
// The placeholder example
// ---------------------------------------------------------------------------

const VAULT_SOURCE = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity ^0.8.24;',
  '',
  '/// Holds ETH deposits and pays them back on request.',
  '/// Synthetic example written for Bounty Operator. Not deployed anywhere.',
  'contract PayoutVault {',
  '    mapping(address => uint256) public balanceOf;',
  '    uint256 public totalDeposits;',
  '    address public owner;',
  '    address public feeRecipient;',
  '    uint256 public constant FEE_BPS = 50;',
  '',
  '    event Deposited(address indexed account, uint256 amount);',
  '    event Withdrawn(address indexed account, uint256 amount, uint256 fee);',
  '',
  '    constructor(address feeRecipient_) {',
  '        owner = msg.sender;',
  '        feeRecipient = feeRecipient_;',
  '    }',
  '',
  '    function deposit() external payable {',
  '        require(msg.value > 0, "zero deposit");',
  '        balanceOf[msg.sender] += msg.value;',
  '        totalDeposits += msg.value;',
  '        emit Deposited(msg.sender, msg.value);',
  '    }',
  '',
  '    function withdraw() external {',
  '        uint256 amount = balanceOf[msg.sender];',
  '        require(amount > 0, "nothing to withdraw");',
  '        uint256 fee = (amount * FEE_BPS) / 10_000;',
  '',
  '        (bool paid, ) = msg.sender.call{value: amount - fee}("");',
  '        require(paid, "payout failed");',
  '        (bool feePaid, ) = feeRecipient.call{value: fee}("");',
  '        require(feePaid, "fee failed");',
  '',
  '        balanceOf[msg.sender] = 0;',
  '        totalDeposits -= amount;',
  '        emit Withdrawn(msg.sender, amount, fee);',
  '    }',
  '',
  '    function setFeeRecipient(address next) external {',
  '        require(next != address(0), "zero address");',
  '        feeRecipient = next;',
  '    }',
  '',
  '    function transferOwnership(address next) external {',
  '        require(msg.sender == owner, "not owner");',
  '        require(next != address(0), "zero address");',
  '        owner = next;',
  '    }',
  '}',
  '',
].join('\n');

const VAULT_REVIEW = `# Review
Verdict: fix-before-deploy
Mode: own-code
Counts: critical=1 high=1 medium=0 hardening=1 checked-safe=2
Headline: withdraw pays out before it clears the balance, so one depositor can empty the vault.

## Entry points
- deposit | input-1/PayoutVault.sol:21-26 | anyone | guard=no | value=in
- withdraw | input-1/PayoutVault.sol:28-41 | anyone | guard=no | value=out
- setFeeRecipient | input-1/PayoutVault.sol:43-46 | anyone | guard=no | value=none
- transferOwnership | input-1/PayoutVault.sol:48-52 | role:owner | guard=yes | value=none

## Invariants
- The vault holds at least totalDeposits in ETH | broken | F-1
- Only the owner changes where fees go | broken | F-2
- totalDeposits equals the sum of balanceOf | holds | input-1/PayoutVault.sol:23-24

## F-1: withdraw sends ETH before it clears the caller's balance
Severity: critical
Basis: proven-in-source
Location: input-1/PayoutVault.sol:33; input-1/PayoutVault.sol:38-39
Impact: Any depositor takes every other depositor's ETH, less the 0.5% fee. The loss is bounded only by the vault's balance.
Path:
1. The vault holds 10 ETH from other accounts. The attacker contract deposits 1 ETH, so \`totalDeposits\` is 11 ETH.
2. The attacker calls \`withdraw\`. Line 33 sends 0.995 ETH to the attacker while \`balanceOf[attacker]\` is still 1 ETH.
3. The attacker's \`receive\` calls \`withdraw\` again. Line 29 reads the same 1 ETH and line 33 pays again. This repeats until 11 calls are open.
4. The calls unwind. Each one runs lines 38-39, and \`totalDeposits\` falls from 11 ETH to 0 without underflow.
5. The attacker holds 10.945 ETH for a 1 ETH deposit. The vault holds nothing.
Counterargument: Checked arithmetic on line 39 reverts the nested calls | resolved | The subtraction underflows only after totalDeposits / amount calls. With 11 ETH and a 1 ETH deposit, 11 calls fit, which is the whole balance (input-1/PayoutVault.sol:39).
Gap: none
Fix: Move lines 38-39 above the call on line 33, so the balance is zero before any ETH leaves (input-1/PayoutVault.sol:33).
Test:
\`\`\`solidity
function test_withdraw_cannot_be_reentered() public {
    vm.deal(address(victim), 10 ether);
    vm.prank(address(victim));
    vault.deposit{value: 10 ether}();

    Reenterer attacker = new Reenterer(vault);
    attacker.attack{value: 1 ether}();

    // With the fix the attacker gets its own deposit back, less the fee.
    assertEq(address(attacker).balance, 0.995 ether);
    assertEq(address(vault).balance, 10 ether);
}
\`\`\`
Next: Apply the fix, then run the test against the patched contract.

## F-2: setFeeRecipient has no owner check
Severity: high
Basis: proven-in-source
Location: input-1/PayoutVault.sol:43-46
Impact: Any account redirects the 0.5% fee on every later withdrawal to itself, or points it at a contract that rejects ETH and blocks every withdrawal at line 36.
Path:
1. \`transferOwnership\` requires \`msg.sender == owner\` on line 49. \`setFeeRecipient\` on lines 43-46 has no such check.
2. The attacker calls \`setFeeRecipient(attacker)\`. Line 45 stores it.
3. A user withdraws 100 ETH. Line 35 sends the 0.5 ETH fee to the attacker.
Counterargument: The fee is 0.5%, so the loss is small | open | The same call can set a recipient that reverts, and line 36 then reverts every withdrawal until someone resets it. A test with a reverting recipient shows how long funds stay locked.
Gap: A test that shows a withdrawal reverting while feeRecipient is a contract with no receive function.
Fix: Add \`require(msg.sender == owner, "not owner")\` as the first line of \`setFeeRecipient\` (input-1/PayoutVault.sol:44).
Test:
\`\`\`solidity
function test_only_owner_sets_fee_recipient() public {
    vm.prank(address(0xBEEF));
    vm.expectRevert(bytes("not owner"));
    vault.setFeeRecipient(address(0xBEEF));
}
\`\`\`
Next: Add the owner check and the reverting-recipient test.

## Hardening
- Fee transfer can block payouts | input-1/PayoutVault.sol:35-36 | Record the fee and let the recipient pull it, so a failing recipient cannot stop withdrawals.

## Checked and safe
- Deposit accounting | input-1/PayoutVault.sol:22-24 | Balance and total rise by the same msg.value, and zero deposits are rejected.
- Ownership transfer | input-1/PayoutVault.sol:49-50 | Owner-only, and the zero address is rejected.

## Coverage
Reviewed: input-1/PayoutVault.sol
Not supplied: tests, deployment script
`;

/**
 * @typedef {object} Example
 * @property {string} id
 * @property {string} title
 * @property {string} profile   a profile id
 * @property {'bounty' | 'own-code'} [mode]
 * @property {{ name: string, content: string }[]} files
 * @property {string} [focus]
 * @property {Record<string, string>} [context]
 * @property {string} review    in the review output format
 * @property {string} [model]
 * @property {string} [generatedAt]  ISO 8601
 */

/** @type {Example} */
export const PLACEHOLDER_EXAMPLE = Object.freeze({
  id: 'payout-vault',
  title: 'PayoutVault: a withdrawal that can be re-entered',
  profile: 'solidity',
  mode: 'own-code',
  files: Object.freeze([Object.freeze({ name: 'PayoutVault.sol', content: VAULT_SOURCE })]),
  focus: '',
  context: Object.freeze({ target: 'PayoutVault, a synthetic example', scope: 'One contract written for this example', version: 'example-1' }),
  review: VAULT_REVIEW,
  model: '',
  generatedAt: '2026-10-02T00:00:00.000Z',
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isExample(entry) {
  return Boolean(entry)
    && typeof entry.id === 'string' && entry.id !== ''
    && typeof entry.profile === 'string'
    && typeof entry.review === 'string' && entry.review !== ''
    && Array.isArray(entry.files) && entry.files.length > 0
    && entry.files.every((file) => file && typeof file.name === 'string' && typeof file.content === 'string');
}

/**
 * The usable examples an example module exports. It may export `EXAMPLES`
 * (an array), a default array, or one `EXAMPLE`. Entries that are not in the
 * v0.7 shape are left out; with none left, the placeholder is used.
 *
 * @param {Record<string, unknown> | null} module
 * @returns {Example[]}
 */
export function exampleList(module) {
  const exported = module?.EXAMPLES ?? module?.default ?? module?.EXAMPLE;
  const entries = Array.isArray(exported) ? exported : exported ? [exported] : [];
  const usable = entries.filter(isExample);
  return usable.length ? usable : [PLACEHOLDER_EXAMPLE];
}

/**
 * Reads the deep link from a query string.
 *
 * @param {string} search  `location.search`
 * @returns {{ profile: string, example: boolean, exampleId: string }}
 */
export function deepLink(search) {
  const params = new URLSearchParams(search);
  const start = params.get('start') ?? '';
  const named = params.get('profile') ?? (start !== 'example' ? start : '');
  let profile = '';
  try {
    const found = named ? reviewProfile(named) : null;
    if (found?.listed) profile = found.id;
  } catch {
    profile = '';
  }
  return { profile, example: start === 'example' || params.has('example'), exampleId: params.get('example') ?? '' };
}

// ---------------------------------------------------------------------------
// Example
// ---------------------------------------------------------------------------

let examplesPromise = null;

function examples() {
  examplesPromise ??= import('../example.mjs').then(exampleList, () => [PLACEHOLDER_EXAMPLE]);
  return examplesPromise;
}

/**
 * Loads a bundled example and opens its result. Work in progress is put aside
 * and comes back when the example is left.
 *
 * @param {string} [id]  Empty loads the first example.
 * @returns {Promise<boolean>}
 */
export async function loadExample(id = '') {
  if (workbench.get().busy) {
    say('A review is running. Cancel it to open the example.', { tone: 'warn' });
    return false;
  }
  const list = await examples();
  const example = list.find((entry) => entry.id === id) ?? list[0];
  const files = example.files.map((file) => ({ name: file.name, content: file.content }));
  let profile;
  try {
    profile = reviewProfile(example.profile);
  } catch {
    profile = reviewProfile('general');
  }

  const result = {
    review: example.review,
    manifest: await manifestFor(files),
    profile: { id: profile.id, name: profile.name },
    mode: profile.mode === 'either' ? (example.mode === 'own-code' ? 'own-code' : 'bounty') : profile.mode,
    provider: '',
    model: typeof example.model === 'string' ? example.model : '',
    truncated: false,
    refused: false,
    usage: { input: null, output: null },
    source: 'example',
    timestamp: typeof example.generatedAt === 'string' ? example.generatedAt : new Date().toISOString(),
  };
  const hadWork = !view.get().example && workbench.get().files.length > 0;
  enterExample({ ...example, files, profile: profile.id }, result);
  track(EVENTS.EXAMPLE_LOADED);
  // A bundled example carries a stored model answer; the placeholder is written by hand.
  const stored = example.model
    ? ` The review is a stored answer from ${example.model}${formatDate(example.generatedAt) ? `, generated ${formatDate(example.generatedAt)}` : ''}.`
    : '';
  // The result prints the model and the day on its first line, where the page lands, so that line is
  // not pinned over it as well: a screen reader hears it. The status line keeps what the page prints
  // nowhere else.
  sayQuietly(`Example loaded.${stored}`);
  say([
    stored ? '' : 'The example was written by hand: no model was called.',
    hadWork ? 'Your own files are put aside and come back when you leave the example.' : '',
  ].filter(Boolean).join(' '), { tone: 'success' });
  return true;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function stripParams(names) {
  const url = new URL(window.location.href);
  let changed = false;
  for (const name of names) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (changed) window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function applyHandoff(handoff, saved) {
  let profile;
  try {
    profile = reviewProfile(handoff.profile);
  } catch {
    profile = reviewProfile('general');
  }
  const blank = initialState();
  view.set({ example: '', ack: '', history: null });
  workbench.set({
    ...Object.fromEntries(WORK_FIELDS.map((field) => [field, blank[field]])),
    files: handoff.files,
    focus: handoff.focus,
    context: handoff.context,
    profile: profile.id,
    mode: profile.mode === 'either' ? blank.mode : profile.mode,
    // The provider and model the tab already used stay as they were.
    provider: saved?.provider ?? blank.provider,
    model: saved?.model ?? blank.model,
    step: 'files',
  });
}

function reportHandoff(handoff) {
  const loaded = handoff.files.length;
  if (handoff.skipped.length) {
    showFileErrors(handoff.skipped.map((entry) => ({ name: entry.name, reason: `was not loaded: ${entry.reason.replace(/\.$/, '')}` })));
  }
  if (loaded) say(`${loaded} file${loaded === 1 ? '' : 's'} loaded from the previous page. Check the profile, then continue.`, { tone: 'success', hold: true });
  else if (handoff.skipped.length) say('The files from the previous page could not be loaded. The reasons are listed under the drop zone.', { error: true });
}

/**
 * Starts the workbench.
 *
 * @returns {boolean} False when the page has no #workspace.
 */
export function boot() {
  if (!qs('#workspace')) return false;

  // 1. What the tab held, or what another page handed over. From here on
  //    every change is stored for the tab, including the ones made below.
  const handoff = takeHandoff();
  const saved = loadWorkbench();
  if (saved && !handoff) {
    // Storage that ran short keeps the settings and drops the files: the Run step has nothing to run then.
    const stranded = saved.step === 'review' && saved.files.length === 0;
    workbench.set(stranded ? { ...saved, step: 'files' } : saved);
  }
  persistWorkbench();

  // 2. Wire the modules. Each one paints from the store.
  initWorkbench();
  if (handoff) applyHandoff(handoff, saved);
  initSourcePane();
  initFiles();
  initGithub();
  initProviders();
  initRun();
  // The Operator runs: the gauntlet and the panel rows, and the result bodies they end in.
  initGauntlet();
  initPanel();
  initPasteback();
  initHistory();
  initDossier();
  initResults();
  if (handoff) reportHandoff(handoff);

  // 3. Deep links. The parameters are removed once applied, so a reload keeps what the user changed since.
  const link = deepLink(window.location.search);
  const arrived = Boolean(handoff) || Boolean(link.profile) || link.example;
  if (link.profile) {
    leaveExample();
    const profile = reviewProfile(link.profile);
    workbench.set((state) => ({ profile: profile.id, mode: profile.mode === 'either' ? state.mode : profile.mode }));
    setStep('files', { scroll: false, focus: false });
  }
  stripParams(['profile', 'start', 'example']);
  if (link.example) loadExample(link.exampleId);
  else if (arrived) qs('#workspace').scrollIntoView({ block: 'start' });

  // 4. Examples, from any control on the page.
  on(document, 'click', '[data-example]', (event, control) => {
    event.preventDefault();
    loadExample(control.dataset.example ?? '');
  });

  // 5. The account, and a connection or a checkout that is on its way back.
  account().catch(() => {});
  resumeOpenRouter().then((connected) => {
    if (!connected) return;
    setStep(workbench.get().files.length ? 'review' : 'files');
  }).catch(() => {});
  // The account panel (sign-in, the account sheet, checkout and its return)
  // wires itself on import. The workbench works on a page without it.
  import('./account.mjs').catch(() => {});
  return true;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
