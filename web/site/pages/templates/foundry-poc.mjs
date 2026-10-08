// /templates/foundry-poc — the fork-test scaffold.
//
// The page shows web/public/templates/ImpactPoC.t.sol exactly as it is served,
// so the block on the page, the copy button and the download are one file.

import { readFileSync } from 'node:fs';

import { button, codeBlock, html, stackTable } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { CHECKED, PLATFORMS } from './data.mjs';
import { checkDraft, crumbs, pageIndex, plain, sourceList } from './shared.mjs';

const FILE = 'ImpactPoC.t.sol';
const scaffold = readFileSync(new URL(`../../../public/templates/${FILE}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Mark the two assertions (observed) and every line the hunter fills in (unproven).
const lines = scaffold.split('\n');
const numbered = (test) => lines.flatMap((line, index) => (test(line) ? [index + 1] : []));
const assertions = numbered((line) => /\bassert(Ge|Eq)\(/.test(line));
const todos = numbered((line) => line.includes('TODO'));

const RUN_COMMAND = `export RPC_URL=<archive node for the chain>
forge test --match-path test/${FILE} -vvv`;

// Real output: this scaffold filled in for a test vault whose redeem() has no
// owner check, deployed on a local anvil chain and forked at block 2.
// forge 1.7.1, forge-std 1.9.5, solc 0.8.26.
const RUN_VULNERABLE = `$ forge test --match-path test/${FILE} -vvv
Ran 2 tests for test/${FILE}:ImpactPoC
[PASS] test_control() (gas: 64727)
[PASS] test_impact() (gas: 80048)
Logs:
  impact object before 100000000000
  impact object after  0
  measured loss        100000000000
  attacker before      1000000000
  attacker after       101000000000

Suite result: ok. 2 passed; 0 failed; 0 skipped; finished in 41.09ms (4.81ms CPU time)`;

const RUN_FIXED = `$ FIXED=true forge test --match-path test/${FILE} -vvv
Ran 2 tests for test/${FILE}:ImpactPoC
[PASS] test_control() (gas: 64754)
[FAIL: not owner] test_impact() (gas: 81399)
Backtrace:
  at Target.redeem
  at ImpactPoC.test_impact

Suite result: FAILED. 1 passed; 1 failed; 0 skipped; finished in 11.83ms (1.10ms CPU time)`;

const PARTS = [
  {
    id: 'setup',
    title: 'Setup: one chain, one block, the scoped addresses',
    text: '`vm.createSelectFork` with a block number makes the run repeatable. The triager gets the same numbers you did. `TARGET` is the address on the programme’s asset list. The header records the commit the deployed code was built from.',
    check: 'Asset and version binding',
  },
  {
    id: 'actors',
    title: 'Actors: who performs each step',
    text: '`makeAddr` gives every party a name in the trace. The attacker holds no role. There is no `vm.prank` on an owner, an admin, a keeper or governance: a decisive step performed by a trusted role ends the report.',
    check: 'Actor trace',
  },
  {
    id: 'values',
    title: 'Concrete values',
    text: 'Deposit, capital and expected loss are constants with the unit in the comment, and the report quotes the same numbers. `deal` funds accounts. Nothing writes the target’s storage and nothing mocks its calls, because every state the proof sets up needs a route from live state by public calls.',
    check: 'Production reachability',
  },
  {
    id: 'assertion',
    title: 'The assertion that proves impact',
    text: 'One `assertGe` at the end of `test_impact`, on `_impactObject()`, against the loss the report claims. The logged numbers above it are the ones you paste into the Impact section.',
    check: 'Executed end-state proof',
  },
  {
    id: 'fix',
    title: 'The control, and the assertion that fails after the fix',
    text: '`test_control` runs the same path without the bug step and asserts the object did not move. Then patch the source and run with `FIXED=true`: `deployCodeTo` puts the patched build at the deployed address, and `test_impact` fails. The bug step reverts, or the final assertion reports no loss. Paste that line next to the fix.',
    check: 'Design intent and counterfactual',
  },
];

const OBJECTS = [
  ['Direct theft of user funds', 'What the victim can still withdraw, and the attacker’s token balance', 'A `Transfer` event or the return value of the attacking call'],
  ['Permanent freezing of funds', 'What a withdrawal returns after the longest wait, on every exit path including admin recovery', 'One reverting call'],
  ['Protocol insolvency', 'Assets held minus liabilities owed, both read from the contracts', 'A share price or an exchange rate'],
  ['Theft of unclaimed yield', 'The victim’s claimable amount before and after', 'A reward index or an accumulator'],
  ['Unauthorised minting', '`totalSupply`, and the balance of the account that received the mint', 'A counter inside the test'],
  ['Governance result changed', 'The stored outcome of the proposal, or the state its execution wrote', 'A vote count the attacker inflated'],
];

const REJECTED = [
  {
    title: 'It ran against mainnet or a public testnet',
    body: 'Grounds for a permanent ban on Immunefi. Cantina and Sherlock’s bounty rules say the same: local forks only. The scaffold never broadcasts.',
  },
  {
    title: 'It is steps or pseudocode',
    body: 'Immunefi’s guide rules out a list of steps, pseudocode, and the project’s contracts on their own. A PoC is code the triager runs.',
  },
  {
    title: 'It does not compile, or does not show the stated impact',
    body: 'Cantina’s bar is that the PoC compiles and demonstrates the impact, on the audit branch, with its output. A PoC that rests on unrealistic assumptions gets the finding downgraded or invalidated.',
  },
  {
    title: 'It asserts on the wrong object',
    body: 'A test that ends on an event, a return value or a variable inside the test proves the call happened. The impact row names a balance, an owner or a stored record. Read that.',
  },
  {
    title: 'It sets up state nobody can reach',
    body: 'A storage write on the target, a mocked in-scope call, or a prank on a trusted role each replace a step the attacker has to perform. Say what was mocked, or mock nothing.',
  },
];

const SOURCES = [
  { label: 'Immunefi Rules', href: 'https://immunefi.com/rules/', note: 'Testing on mainnet or a public testnet, and incomplete PoCs.' },
  {
    label: 'How to Submit Bug Reports That Get Paid',
    href: 'https://immunefi.com/blog/security-guides/how-to-submit-bug-reports-that-get-paid/',
    note: 'What a PoC is and is not on Immunefi.',
    dated: 'Published 10 Feb 2023',
  },
  {
    label: 'Cantina Submission Guidelines',
    href: 'https://docs.cantina.security/researchers/participation/submission-guidelines',
    note: 'PoC validity criteria and what invalidates an attack path.',
  },
  {
    label: 'Cantina Bug Bounty Participation',
    href: 'https://docs.cantina.security/researchers/participation/bug-bounty',
    note: 'Local forks in place of public chains.',
  },
  {
    label: 'Sherlock Criteria for Issue Validity',
    href: 'https://docs.sherlock.xyz/audits/judging/guidelines',
    note: 'The cases where a coded PoC is recommended.',
    dated: 'Version 1.12, 24 Jun 2025',
  },
  {
    label: 'Sherlock bug bounty Platform Rules',
    href: 'https://docs.sherlock.xyz/bug-bounties/post-launch-bounty/platform-rules',
    note: 'Testing on local forks only.',
  },
  {
    label: 'forge-std StdCheats',
    href: 'https://github.com/foundry-rs/forge-std/blob/master/src/StdCheats.sol',
    note: '`deal`, `makeAddr` and `deployCodeTo`, as used in the scaffold.',
  },
];

const body = html`
<div class="wrap tpl-page">
  <header class="tpl-hero page-field">
    ${crumbs([{ label: 'Foundry PoC' }])}
    <h1>Foundry PoC template</h1>
    <p class="lede">A fork-test scaffold for a bug bounty proof of concept: pinned block, named actors, concrete values, a control run, and a final assertion that reads the object the impact names. One file, one command, pasted output.</p>
    <div class="cluster tpl-actions">
      ${button({ label: 'Copy the scaffold', variant: 'primary', icon: 'copy', attrs: { 'data-template-copy': true } })}
      ${button({ label: `Download ${FILE}`, href: `/templates/${FILE}`, icon: 'download', attrs: { download: FILE } })}
      <span class="tpl-actions__status" role="status" data-template-status></span>
    </div>
    <p class="meta">Compiled and run with forge 1.7.1, forge-std 1.9.5 · checked ${CHECKED.label}</p>
  </header>

  <div class="tpl-layout">
    ${pageIndex([
      { id: 'rule', label: 'The rule' },
      { id: 'scaffold', label: 'The scaffold' },
      { id: 'parts', label: 'Five parts' },
      { id: 'runs', label: 'Two runs' },
      { id: 'rejected', label: 'What gets a PoC rejected' },
      { id: 'check', label: 'Review the proof' },
      { id: 'sources', label: 'Sources' },
    ])}

    <div class="tpl-main">
      <section class="tpl-block" aria-labelledby="rule">
        <h2 id="rule">The rule: the final assertion reads the object the impact names</h2>
        <p class="tpl-block__lede">The impact row says what was lost. The last line of the test reads that thing from chain state and compares it with the number in the report. Everything before it is setup.</p>
        ${stackTable({
          caption: 'The object to read, by impact row',
          columns: [{ label: 'Impact row' }, { label: 'Read this' }, { label: 'Not this' }],
          rows: OBJECTS.map(([row, read, avoid]) => [row, html`${plain(read)}`, html`${plain(avoid)}`]),
          className: 'tpl-objects',
          wide: true,
        })}
      </section>

      <section class="tpl-block" aria-labelledby="scaffold">
        <h2 id="scaffold">The scaffold</h2>
        <p class="tpl-block__lede">Save it as ${plain(`\`test/${FILE}\``)} in the project’s repository. It compiles as it stands and fails until the path is filled in. Amber lines are yours to fill. Blue lines are the two assertions.</p>
        <div data-template-source>
          ${codeBlock({ code: scaffold, name: `test/${FILE}`, highlight: assertions, flag: todos, copy: true, className: 'tpl-scaffold' })}
        </div>
      </section>

      <section class="tpl-block" aria-labelledby="parts">
        <h2 id="parts">Five parts, and the check each one answers</h2>
        <ol class="tpl-anatomy">
          ${PARTS.map(
            (part) => html`<li class="tpl-anatomy__item" id="part-${part.id}">
              <h3 class="tpl-anatomy__title">${part.title}</h3>
              <p>${plain(part.text)}</p>
              <p class="tpl-anatomy__check"><span class="meta">Answers</span> ${part.check}</p>
            </li>`,
          )}
        </ol>
      </section>

      <section class="tpl-block" aria-labelledby="runs">
        <h2 id="runs">Two runs, both pasted into the report</h2>
        <p class="tpl-block__lede">One command. The fork needs an archive node in ${plain('`RPC_URL`')}.</p>
        ${codeBlock({ code: RUN_COMMAND, numbers: false, copy: true, label: 'Command' })}
        <p class="tpl-block__lede">The output below is real, with the call trace left out. It is this scaffold filled in for a test vault whose ${plain('`redeem`')} has no owner check, deployed on a local anvil chain and forked at block 2.</p>
        <h3 class="tpl-run__title">On the deployed code: both pass</h3>
        ${codeBlock({ code: RUN_VULNERABLE, numbers: false, label: 'Output on the deployed code' })}
        <h3 class="tpl-run__title">On the patched build: the impact test fails</h3>
        ${codeBlock({ code: RUN_FIXED, numbers: false, label: 'Output on the patched build' })}
        <p class="tpl-block__lede">${plain('`deployCodeTo` runs the constructor again at the target address. Storage stays as deployed except for the slots the constructor writes. Behind a proxy, pass the implementation address.')}</p>
      </section>

      <section class="tpl-block" aria-labelledby="rejected">
        <h2 id="rejected">What gets a PoC rejected</h2>
        <ol class="closed">
          ${REJECTED.map((item) => html`<li class="closed__item"><h3 class="closed__title">${item.title}</h3><p>${plain(item.body)}</p></li>`)}
        </ol>
      </section>

      <section class="tpl-block" aria-labelledby="check">
        <h2 id="check">Have the proof reviewed</h2>
        ${checkDraft({
          id: 'proof',
          profile: 'poc',
          markers: 'todo',
          focus: 'Foundry fork-test proof of concept. Check every step runs production code, the final assertion reads the object the impact row names, and the numbers are measured.',
          fileName: `${FILE}`,
          note: `Proof written from the Foundry PoC template at bountyoperator.com/templates/foundry-poc.`,
          label: 'Your test file, then its output',
          placeholder: 'Paste the filled test and the output of both runs.',
          primary: { label: 'Review the proof in the workbench', href: '/?profile=poc#workspace' },
          intro: html`<p class="tpl-block__lede">Paste the filled test and its output. The workbench opens with Proof review selected and goes through the test step by step: executed, mocked or narrated, and whether the end state is the one the impact row names.</p>`,
        })}
      </section>

      <section class="tpl-block" aria-labelledby="sources">
        <h2 id="sources">Sources</h2>
        <p class="tpl-block__lede">Platform rules read on ${CHECKED.label}.</p>
        ${sourceList(SOURCES.map((source) => ({ ...source, note: html`${plain(source.note)}` })))}
      </section>

      <nav class="tpl-next" aria-label="Report templates">
        <p class="meta">Put the proof in a report</p>
        <ul>
          ${PLATFORMS.map((platform) => html`<li><a href="${platform.path}">${platform.name}</a></li>`)}
          <li><a href="/templates">All templates</a></li>
        </ul>
      </nav>
    </div>
  </div>
</div>`;

export default {
  path: '/templates/foundry-poc',
  title: 'Foundry PoC template | Bounty Operator',
  description:
    'Foundry fork-test scaffold for a bug bounty PoC: pinned block, named actors, concrete values, a control run and a final assertion on what the impact names.',
  label: 'Foundry PoC template',
  styles: ['/css/templates.css'],
  scripts: ['/templates/template.mjs'],
  jsonld: [
    breadcrumbsLd([
      { name: 'Report templates', path: '/templates' },
      { name: 'Foundry PoC', path: '/templates/foundry-poc' },
    ]),
  ],
  lastmod: CHECKED.iso,
  body,
};
