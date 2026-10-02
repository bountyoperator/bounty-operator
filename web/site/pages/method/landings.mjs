// One landing page per high-intent query. Each shows an output excerpt on an
// invented example, what the profile answers, what to paste in, and a call to
// action that opens the workbench with the profile selected.
//
// Two depths. The three core profiles (solidity, report, general) are open:
// their pages describe what the profile checks, following its instructions in
// web/public/profiles.mjs. The hosted profiles (triage, prior-art) are
// described by what they answer and what they output, as their public
// description in profiles.mjs does, and never by how they reach it.

import { chip, codeBlock, dossier, findingCard, html, inline, kv, refChip, stackTable, statusChip } from '../../components.mjs';
import { ledgerCard, profileLanding } from './_landing.mjs';
import { workbenchLink } from './_shared.mjs';

const RELATED = {
  solidity: { label: 'Solidity review', href: '/solidity-review', text: 'Entry points, invariants and value flow in Solidity contracts.' },
  general: { label: 'Code security review', href: '/code-security-review', text: 'Authorization, data handling and failure paths in any codebase.' },
  report: { label: 'Challenge a draft report', href: '/challenge-report', text: 'Every claim in your draft, checked against the code.' },
  triage: { label: 'Triager simulation', href: '/triager-simulation', text: 'The three reasons a triager closes this report, ranked.' },
  priorArt: { label: 'Prior-art overlap', href: '/prior-art-check', text: 'Same root cause, or only the same symptom.' },
  poc: { label: 'Proof review', href: workbenchLink('poc'), text: 'Whether the proof shows the impact or only the defect.' },
  severity: { label: 'Severity calibration', href: workbenchLink('severity'), text: 'One level, graded on the programme’s own table.' },
  scanner: { label: 'Scanner triage', href: workbenchLink('scanner'), text: 'Static-analysis output, grouped by root cause and ranked.' },
  gauntlet: { label: 'Gauntlet', href: '/gauntlet', text: 'All eight stages in one run, with one verdict.' },
  panel: { label: 'Panel review', href: '/panel-review', text: 'Two to four models, then a cross-examination pass.' },
};

// A core profile runs three ways: hosted, as an exported prompt, or prepared over MCP.
const MODEL_FAQ = {
  q: 'Which model runs the review?',
  a: 'The one you choose, on your own key: OpenRouter, Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Mistral or Groq. With a chat subscription, export the prompt, paste it into your chat app and paste the answer back. From a coding agent, `prepare_review` hands the same request to the agent’s own model over MCP.',
};

// A hosted profile runs through bountyoperator.com on the user's key, in the
// workbench or through run_review. It has no prompt to take away.
const HOSTED_MODEL_FAQ = {
  q: 'Which model runs the review?',
  a: 'The one you choose, on your own key: OpenRouter, Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Mistral or Groq. It runs as a hosted review: one per UTC day on Free, unlimited on Operator. From a coding agent it runs through `run_review` over MCP, on the same allowance.',
};

const STORED_FAQ = {
  q: 'Where do my files go?',
  a: 'To the model provider you choose, through our server, for that one request. Bounty Operator does not store your files, prompts, keys or results. With an exported prompt they go from your browser to the chat app you paste into. The packet you download carries a SHA-256 manifest of every file reviewed.',
};

const HOSTED_STORED_FAQ = {
  q: 'Where do my files go?',
  a: 'Through our server to the model provider you choose, with your key, for that one request. The server adds the method of this profile on the way. Bounty Operator does not store your files, prompts, keys or results. The packet you download carries a SHA-256 manifest of every file reviewed.',
};

// ---------------------------------------------------------------------------
// /solidity-review
// ---------------------------------------------------------------------------

const VAULT = 'input-1/SaltmarshVault.sol';
const VAULT_SHA256 = '3f9a61c07d2b84e5a1c6f0398e7d25b4c80a17f6e3d952b08c4e71a6f39d0b25';

const DEPOSIT_SOURCE = `function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
    uint256 supply = totalSupply();
    shares = supply == 0 ? assets : (assets * supply) / totalAssets();
    asset.safeTransferFrom(msg.sender, address(this), assets);
    _mint(receiver, shares);
    emit Deposit(msg.sender, receiver, assets, shares);
}`;

const VAULT_TEST = `function test_firstDepositorTakesNextDeposit() public {
    vm.startPrank(attacker);
    vault.deposit(1, attacker);
    usdc.transfer(address(vault), 10_000e6);
    vm.stopPrank();

    vm.prank(victim);
    uint256 shares = vault.deposit(9_999e6, victim);

    assertEq(shares, 0);
    assertEq(vault.totalAssets(), 19_999e6 + 1);
}`;

const vaultFinding = {
  id: 'F-1',
  title: 'A direct transfer moves the share price, and `deposit` accepts zero shares',
  severity: 'high',
  basis: 'proven-in-source',
  locations: [
    { label: VAULT, start: 44, end: 50 },
    { label: VAULT, start: 58, end: 60 },
  ],
  impact: 'The first depositor takes the next deposit in full. Bound: any deposit smaller than the balance donated to the vault.',
  path: [
    '`totalAssets()` returns the vault’s raw token balance (lines 58-60). A plain transfer raises it.',
    '`deposit` divides by that balance at line 46 and rounds down. Nothing rejects `shares == 0`.',
    'The attacker deposits 1 unit into the empty vault for 1 share, then transfers 10,000 USDC to the vault.',
    'A victim deposits 9,999 USDC. `9_999e6 * 1 / (10_000e6 + 1)` is 0 shares. The attacker redeems 1 share for the whole balance.',
  ],
  counterargument: {
    objection: 'The deployer seeds the vault in the deployment script, so it is never empty.',
    status: 'open',
    why: 'No deployment script was supplied. Lines 44-50 hold no minimum-share check and no dead shares.',
  },
  gap: ['The deployment script, or the transaction of the first deposit.'],
  fix: 'Revert when `shares == 0`. Mint dead shares on the first deposit, or track assets in storage instead of reading the balance.',
  test: { code: VAULT_TEST, name: 'test/SaltmarshVault.t.sol', numbers: false, copy: true },
  next: 'Run the test, then read the deployment script for a seed deposit.',
};

const solidityHead = {
  verdict: 'prove-first',
  headline: 'The share price follows the vault’s raw balance. A seed deposit would close it, and no deployment script was supplied.',
  counts: { critical: 0, high: 1, medium: 0, hardening: 2, 'checked-safe': 3 },
};

const solidity = profileLanding({
  path: '/solidity-review',
  title: 'AI Solidity review on your own model | Bounty Operator',
  description:
    'Run an AI Solidity review on your own model and key: entry points, sibling diffs, invariants, and a line reference and counterargument for every finding.',
  profileId: 'solidity',
  profileName: 'Solidity review',
  hero: {
    title: 'AI Solidity review on your own model',
    lede: 'Paste the contracts. Your model maps who can call what, compares sibling functions, checks every write site of each accounting invariant, and reports each way value or control is taken, with the lines that prove it and the strongest argument against it.',
    exampleLabel: 'Example output · invented contract',
    example: html`
      <div class="stack">
        ${dossier(solidityHead)}
        ${findingCard(vaultFinding, {
          bar: { name: VAULT, hash: VAULT_SHA256, tag: '112 lines' },
          code: { code: DEPOSIT_SOURCE, name: VAULT, start: 44, highlight: [46], copy: true },
          rows: ['impact', 'observed', 'counter', 'gap', 'next'],
          id: 'solidity-f-1',
        })}
      </div>`,
  },
  checks: {
    title: 'What the Solidity review checks',
    lede: 'The profile works through the contracts in a fixed order before it writes anything.',
    items: [
      {
        title: 'Entry points',
        text: 'Every external or public function that changes state: who can call it, whether it carries a reentrancy guard, and whether value moves in or out.',
      },
      {
        title: 'Sibling diff',
        text: 'Each function next to the others that do the same work. A modifier, pause check or checkpoint that one sibling has and another lacks is a finding.',
      },
      {
        title: 'Invariants',
        text: 'Conservation, ratio, ordering and bounds. For each one, every line that writes the variables involved. One write site that skips the update breaks it.',
      },
      {
        title: 'Value flow and rounding',
        text: 'Which way every division rounds and who gains, the first deposit into an empty pool, and direct transfers that move a price or a share ratio.',
      },
      {
        title: 'Checkpoints and external calls',
        text: 'Accumulators updated before a balance changes. State that is stale at the moment of each call, token transfer, hook or callback.',
      },
      {
        title: 'Signatures, oracles, upgrades',
        text: 'Nonce, deadline and chain id inside the signed data. Stale or movable prices. Initialisers callable twice and privileged setters left open.',
      },
    ],
  },
  paste: {
    lede: 'The review judges the files you supply and names what it could not see.',
    items: [
      { name: 'The contracts in scope', note: 'One file or a small set. Import them from GitHub at a pinned commit to keep line numbers exact.' },
      { name: 'Interfaces, libraries and tokens they call', note: 'A control that lives in an unsupplied file is reported as depending on that file.', optional: true },
      { name: 'Context', note: 'The target, the commit, how the tokens behave, and whether privileged roles are in scope.', optional: true },
    ],
  },
  returns: {
    lede: 'One review in a fixed format, built to be checked against the source.',
    items: [
      'A verdict and a one-sentence headline.',
      'A finding card per issue: severity, basis, location, impact and the path with concrete values.',
      'The strongest counterargument to each finding, marked resolved or open.',
      'The evidence gap: the one artefact still missing.',
      'A fix and a test for each finding.',
      'Entry points and Invariants tables, then Hardening and Checked-and-safe lists.',
      'A packet with the SHA-256 manifest of every file reviewed.',
    ],
  },
  more: {
    title: 'The rest of the same review',
    lede: 'The entry points and the invariants the profile mapped before it reported the finding above.',
    label: 'Example output · invented contract · SaltmarshVault',
    body: html`
      <div class="stack stack--24">
        ${stackTable({
          caption: 'Entry points',
          columns: [{ label: 'Function' }, { label: 'Location' }, { label: 'Caller' }, { label: 'Guard' }, { label: 'Value' }],
          rows: [
            [inline('`deposit`'), refChip(`${VAULT}:44-50`), 'anyone', 'no', 'in'],
            [inline('`redeem`'), refChip(`${VAULT}:62-71`), 'anyone', 'no', 'out'],
            [inline('`setFeeRecipient`'), refChip(`${VAULT}:83-86`), 'admin', 'no', 'none'],
          ],
        })}
        ${stackTable({
          caption: 'Invariants',
          columns: [{ label: 'Property' }, { label: 'State' }, { label: 'Where' }],
          rows: [
            ['Ratio: shares minted for a deposit are worth the assets paid in', chip('Broken', { tone: 'danger' }), 'F-1'],
            [inline('Conservation: `totalSupply` equals the sum of balances'), chip('Holds', { tone: 'ok' }), refChip(`${VAULT}:48`)],
            [inline('Bounds: `redeem` pays out no more than the caller’s shares are worth'), chip('Holds', { tone: 'ok' }), refChip(`${VAULT}:64-66`)],
          ],
          plain: true,
        })}
      </div>`,
  },
  faqItems: [
    MODEL_FAQ,
    {
      q: 'Does it work for a bounty and for my own code?',
      a: 'Yes. In bounty mode the verdict is submit, rewrite-then-submit, prove-first, hold-duplicate or drop. In own-code mode it is fix-before-deploy or no-blocking-issues.',
    },
    {
      q: 'How does it treat admin-only bugs?',
      a: 'A bug that needs the owner or an admin to act against users is listed under Hardening. Say in Context that privileged roles are in scope and it is reported as a finding.',
    },
    STORED_FAQ,
  ],
  cta: {
    button: 'Review my contracts',
    title: 'Run a Solidity review on your contracts',
    lede: 'Your model, your key, a line reference for every claim.',
  },
  related: [RELATED.poc, RELATED.report, RELATED.general, RELATED.panel, RELATED.gauntlet],
});

// ---------------------------------------------------------------------------
// /challenge-report
// ---------------------------------------------------------------------------

const POOL = 'input-2/RewardPool.sol';

const claimChips = {
  confirmed: () => chip('Confirmed', { tone: 'ok' }),
  overstated: () => chip('Overstated', { tone: 'unproven' }),
  contradicted: () => chip('Contradicted', { tone: 'danger' }),
  unverifiable: () => chip('Unverifiable', { tone: 'unproven', dashed: true }),
};

const claimsCard = ledgerCard({
  id: 'claims',
  tag: 'Claims',
  title: 'Five claims in the draft, checked against `RewardPool.sol`',
  bar: { name: 'input-1/draft-report.md', tag: '5 claims' },
  rows: [
    {
      label: 'C1',
      kind: 'observed',
      quote: '`claimFor` has no access control.',
      chip: claimChips.confirmed(),
      text: 'There is no caller check at lines 71-79. Anyone calls it for any account.',
      refs: refChip(`${POOL}:71-79`),
    },
    {
      label: 'C2',
      kind: 'counter',
      status: 'open',
      quote: 'The attacker receives the victim’s rewards.',
      chip: claimChips.contradicted(),
      text: 'Line 76 transfers to `user`, the account that earned the reward. The caller receives nothing.',
      refs: refChip(`${POOL}:76`),
    },
    {
      label: 'C3',
      kind: 'counter',
      status: 'open',
      quote: 'This drains the reward pool.',
      chip: claimChips.overstated(),
      text: 'Each call pays one account what it has already earned. The pool pays nothing it does not owe.',
      refs: refChip(`${POOL}:73-76`),
    },
    {
      label: 'C4',
      kind: 'gap',
      quote: 'It breaks the auto-compounder integration.',
      chip: claimChips.unverifiable(),
      text: 'No compounder code was supplied.',
    },
    {
      label: 'C5',
      kind: 'counter',
      status: 'open',
      quote: 'Severity: Critical.',
      chip: claimChips.overstated(),
      text: 'The code supports a forced claim with no loss of principal. The assumption that would move it: a forced claim costs the user something the compounder would have earned.',
    },
  ],
  next: 'Find the docs for `claimFor`. If they describe a keeper path, drop the report. If they do not, file the rewritten version.',
});

const poolFinding = {
  id: 'F-1',
  title: 'Anyone triggers a reward claim for any account',
  severity: 'medium',
  basis: 'proven-in-source',
  locations: [{ label: POOL, start: 71, end: 79 }],
  impact: 'A third party chooses when another account’s rewards are paid out. The rewards go to their owner. No principal moves.',
  path: [
    '`claimFor(address user)` is external and has no caller check (line 71).',
    'It settles `earned[user]` and transfers that amount to `user` (lines 73-76).',
  ],
  counterargument: {
    objection: 'Claiming for another account is the design. Keepers do it.',
    status: 'open',
    why: 'Nothing supplied documents `claimFor` as a keeper path. If the docs do, the behaviour is intended.',
  },
  gap: ['The NatSpec or the docs page for `claimFor`.', 'The auto-compounder code, to show what a forced claim costs the user.'],
  fix: 'Require `msg.sender == user`, or restrict the call to an allowlisted keeper.',
  next: 'Read the docs for `claimFor` before anything else.',
};

const challengeHead = {
  verdict: 'rewrite-then-submit',
  headline: 'The missing caller check is in the code. The theft is contradicted: line 76 pays the account that earned the reward.',
  counts: { critical: 0, high: 0, medium: 1, hardening: 0, 'checked-safe': 2 },
};

const challenge = profileLanding({
  path: '/challenge-report',
  title: 'Check a bug bounty report before you submit | Bounty Operator',
  description:
    'Every claim in your draft marked confirmed, overstated, contradicted or unverifiable against the code, with the line that decides it. Runs on your own model.',
  profileId: 'report',
  profileName: 'Challenge a draft report',
  label: 'Challenge a report',
  hero: {
    title: 'Check a bug bounty report before you submit',
    lede: 'Paste your draft and the code it cites. Your model reads it as the triager who has to pay for it, splits it into claims and marks each one against the lines you supplied. A correct report gets confirmed.',
    exampleLabel: 'Example output · invented protocol',
    example: html`
      <div class="stack">
        ${dossier(challengeHead)}
        ${claimsCard}
      </div>`,
  },
  checks: {
    title: 'What the challenge checks',
    lede: 'The draft is split into the claims that decide it. Each is checked against the code.',
    items: [
      { title: 'Root cause', text: 'The missing or wrong check, located in the code. A root cause the code contradicts ends the report.' },
      { title: 'Each attack step', text: 'Every step of the path, checked in order against the lines it relies on.' },
      { title: 'Preconditions', text: 'What has to be true before the attack starts, and whether the draft says so.' },
      { title: 'Impact and severity', text: 'Who loses what, with the bound. The severity the evidence supports, and the one assumption that would move it.' },
      { title: 'The fix', text: 'Whether the proposed change closes the path.' },
      { title: 'The proof', text: 'Whether the test asserts the claimed end state, and whether that assertion fails once the fix is applied.' },
    ],
  },
  paste: {
    lede: 'One file is the draft. The rest is the evidence it relies on.',
    items: [
      { name: 'Your draft report', note: 'Markdown or plain text, as you intend to submit it.' },
      { name: 'The source files the report cites', note: 'At the commit the report names.' },
      { name: 'The PoC and its output', note: 'A supplied test lets the review confirm the impact instead of asking for it.', optional: true },
    ],
  },
  returns: {
    lede: 'A verdict on the draft and a row for every claim.',
    items: [
      'One verdict: submit, rewrite-then-submit, prove-first, hold-duplicate or drop.',
      'A Claims table: each claim marked confirmed, overstated, contradicted or unverifiable, with the line that decides it.',
      'The finding the code supports, at the severity it supports, as a finding card.',
      'Only the gaps that change the decision. A gap the draft already discloses is skipped.',
      'On rewrite-then-submit: a rewritten title, severity, summary and impact.',
      'A packet with the SHA-256 manifest of every file reviewed.',
    ],
  },
  more: {
    title: 'The finding that survives',
    lede: 'RewardPool is a contract invented for this page. The draft claimed a Critical theft. This is what the code supports.',
    label: 'Example output · invented protocol · RewardPool',
    body: html`
      <div class="stack stack--24">
        <div class="findings">${findingCard(poolFinding, { id: 'challenge-f-1' })}</div>
        <div class="card">
          <div class="card__head"><h3 class="card__title">Rewritten report</h3><div class="card__meta">Title, severity, summary and impact only</div></div>
          <div class="card__body">${kv([
            ['Title', inline('`claimFor` lets any caller trigger a reward claim for any account')],
            ['Severity', 'Medium on the rules of this review. Grade it on the programme’s own table before filing.'],
            [
              'Summary',
              inline(
                '`claimFor(address user)` has no caller check, so anyone settles and pays out another account’s rewards at a time of their choosing. The rewards are sent to their owner.',
              ),
            ],
            ['Impact', 'Loss of control over claim timing for every staker. No loss of principal and no loss of rewards is shown.'],
          ])}</div>
        </div>
      </div>`,
  },
  faqItems: [
    {
      q: 'Does it rewrite my report?',
      a: 'Only when the verdict is rewrite-then-submit, and only the title, severity, summary and impact. You write the report. The review marks which claims the code does not support.',
    },
    {
      q: 'What if my report is correct?',
      a: 'Every decisive claim is marked confirmed and the verdict is submit. The profile is instructed to agree when the code and the proof support the draft, and to manufacture no objections.',
    },
    MODEL_FAQ,
    STORED_FAQ,
  ],
  cta: {
    button: 'Challenge my report',
    title: 'Find the hole in your report before the triager does',
    lede: 'Paste the draft and the code. Read the claims table. Then decide.',
  },
  related: [RELATED.triage, RELATED.priorArt, RELATED.poc, RELATED.gauntlet],
});

// ---------------------------------------------------------------------------
// /triager-simulation
// ---------------------------------------------------------------------------

const reasonsCard = ledgerCard({
  id: 'reasons',
  tag: 'Rejection reasons',
  title: 'The three a triager reaches first on this draft',
  bar: { name: 'input-1/draft-report.md', tag: 'Ranked' },
  rows: [
    {
      label: 'Reason 1',
      name: 'Impact not shown',
      kind: 'counter',
      status: 'open',
      quote: 'An attacker can steal all staked funds.',
      chip: statusChip('open'),
      text: 'The test ends at the revert on line 58. Add an assertion on the staker’s balance after the attack.',
      refs: refChip('input-3/test/Exploit.t.sol:41-58'),
    },
    {
      label: 'Reason 2',
      name: 'Privileged precondition',
      kind: 'counter',
      status: 'open',
      quote: 'After the operator raises the rate, the next claim overpays.',
      chip: statusChip('open'),
      text: 'The rules pasted in Context exclude operator actions. Show the path without `setRate`, or cut the step.',
      refs: refChip('input-2/StakingRewards.sol:132-137'),
    },
    {
      label: 'Reason 3',
      name: 'Known issue',
      kind: 'counter',
      status: 'resolved',
      quote: 'Missing section: the draft does not mention the prior audit.',
      chip: statusChip('resolved', 'Answered'),
      text: 'The audit note covers access to `setRate`, a different root cause. Say so in the first paragraph.',
      refs: refChip('input-4/audit-notes.md:112'),
    },
  ],
  next: 'Write the balance assertion first. It answers the reason a triager reaches in the first minute.',
});

const triageHead = {
  verdict: 'prove-first',
  headline: 'Fastest close: impact not shown. The proof ends at the revert and the loss is narrated.',
};

// What the simulation answers, at the depth of the profile's public description.
const TRIAGE_ANSWERS = [
  {
    title: 'The closing sentence',
    text: 'The one sentence that closes this report in ten minutes, and whether your first paragraph already answers it.',
  },
  { title: 'Three reasons, ranked', text: 'The three likeliest rejection reasons for this draft, the likeliest first.' },
  { title: 'The sentence that invites each', text: 'Quoted from your draft. Where the trouble is a gap, the missing section is named.' },
  { title: 'What flips it', text: 'A line in the files you supplied, or the one artefact to add. Each reason is marked answered or open.' },
];

const triage = profileLanding({
  path: '/triager-simulation',
  title: 'See why a triager would close your report | Bounty Operator',
  description:
    'The three likeliest reasons a triager rejects your bug bounty report, the sentence that triggers each one and the evidence that flips it. On your own model.',
  profileId: 'triage',
  profileName: 'Triager simulation',
  hero: {
    title: 'See why a triager would close your report',
    lede: 'Your model reads the draft as a triager does: fast, and looking for the reason to close it. It returns the three likeliest reasons, the sentence of yours that invites each one, and the evidence that flips it.',
    exampleLabel: 'Example output · invented protocol',
    example: html`
      <div class="stack">
        ${dossier(triageHead)}
        ${reasonsCard}
      </div>`,
  },
  checksButton: 'What it answers',
  checks: {
    title: 'What the simulation answers',
    lede: html`A triager needs one sentence to close a report. The simulation writes that sentence before the triager does. The reasons reports are closed for are on the <a class="link" href="/method#closures">method page</a>.`,
    columns: 2,
    items: TRIAGE_ANSWERS,
  },
  paste: {
    lede: 'The rules decide half the reasons. Paste them.',
    items: [
      { name: 'Your draft report', note: 'As you intend to submit it.' },
      { name: 'The source files it cites', note: 'So an objection the code already answers is marked answered, with the line.' },
      { name: 'Programme rules and scope, in Context', note: 'The scope list, the exclusions and the severity table. Reasons that depend on rules are judged only when the rules are supplied.' },
    ],
  },
  returns: {
    lede: 'Three rows, ranked, each with its way out.',
    items: [
      'The closing sentence, and whether your first paragraph answers it.',
      'The three likeliest rejection reasons for this draft, in order.',
      'For each: the sentence of yours that invites it, or the missing section.',
      'For each: the evidence that flips it. A line in your files, or the one artefact to add.',
      'Each marked answered or open. An objection your files already answer comes back answered, with the line.',
      'One verdict: submit, rewrite-then-submit, prove-first, hold-duplicate or drop.',
    ],
  },
  faqItems: [
    {
      q: 'Does it know my programme’s rules?',
      a: 'It uses the rules you paste into Context: the scope list, the exclusions and the severity table. Rules it was not given are named in the review as not supplied.',
    },
    {
      q: 'Is this the platform’s own triager?',
      a: 'No. It is your own model, reading the draft the way a programme triager does. It runs on a draft for any platform: Immunefi, Cantina, Sherlock or HackerOne.',
    },
    {
      q: 'What do I do with an open reason?',
      a: 'Add the artefact the row names, or rewrite the sentence that triggers it. Then run the simulation again.',
    },
    HOSTED_MODEL_FAQ,
    HOSTED_STORED_FAQ,
  ],
  cta: {
    button: 'Simulate the triager',
    title: 'Read your report the way the triager will',
    lede: 'Three reasons to close it, and what answers each.',
  },
  related: [RELATED.priorArt, RELATED.poc, RELATED.severity, RELATED.gauntlet],
});

// ---------------------------------------------------------------------------
// /code-security-review
// ---------------------------------------------------------------------------

const ROUTES = 'input-1/src/routes/invoices.ts';
const ROUTES_SHA256 = 'a06d4f19c3b7e2580d91f4a6c7e03b5d82f1a9c46e7d0b3a59c81f2e4d67a0b3';

const ROUTES_SOURCE = `router.get('/invoices/:id', requireAuth, async (req, res) => {
  const invoice = await db.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  res.json(invoice);
});

router.delete('/invoices/:id', requireAuth, async (req, res) => {
  await db.invoice.deleteMany({ where: { id: req.params.id, orgId: req.user.orgId } });
  res.status(204).end();
});`;

const ROUTES_TEST = `test('GET /invoices/:id is scoped to the caller organisation', async () => {
  const other = await createInvoice({ orgId: orgB.id });

  const response = await request(app)
    .get(\`/invoices/\${other.id}\`)
    .set('Authorization', \`Bearer \${tokenFor(userInOrgA)}\`);

  expect(response.status).toBe(404);
});`;

const routesFinding = {
  id: 'F-1',
  title: '`GET /invoices/:id` returns any organisation’s invoice',
  severity: 'high',
  basis: 'proven-in-source',
  locations: [
    { label: ROUTES, start: 41, end: 45 },
    { label: ROUTES, start: 47, end: 50 },
  ],
  impact: 'Any signed-in user reads the invoices of every other organisation: amounts, line items and billing contacts. Bound: every invoice whose id the caller knows.',
  path: [
    '`requireAuth` checks that the caller is signed in. It does not check which organisation the invoice belongs to.',
    'Line 42 looks the invoice up by `id` alone and line 44 returns it.',
    'The sibling `DELETE` handler scopes the same lookup with `orgId: req.user.orgId` (line 48).',
  ],
  counterargument: {
    objection: 'Invoice ids are UUIDs, so they cannot be guessed.',
    status: 'resolved',
    why: 'The sibling handler at line 48 adds the organisation predicate to the same lookup. The codebase itself does not treat the id as the permission.',
  },
  gap: ['No request was run. Where ids are exposed (emails, exports, logs) was not supplied.'],
  fix: 'Use `findFirst` with `where: { id: req.params.id, orgId: req.user.orgId }` at line 42.',
  test: { code: ROUTES_TEST, name: 'test/invoices.test.ts', numbers: false, copy: true },
  next: 'Apply the predicate, run the test, then check the other handlers that load by id.',
};

const generalHead = {
  verdict: 'fix-before-deploy',
  headline: 'One handler returns any organisation’s invoice by id. Its sibling scopes the same lookup by organisation.',
  counts: { critical: 0, high: 1, medium: 0, hardening: 1, 'checked-safe': 2 },
};

const general = profileLanding({
  path: '/code-security-review',
  title: 'AI code security review that cites file and line | Bounty Operator',
  description:
    'Run an AI code security review on your own model: entry points, authorization, injection and failure paths, each finding with file, line and a fix.',
  profileId: 'general',
  profileName: 'Code security review',
  hero: {
    title: 'AI code security review that cites file and line',
    lede: 'Paste the handlers, routes and middleware. Your model reads them as an attacker who controls every input, traces each entry point from input to effect, and reports what the code proves, with the file and line for every claim.',
    exampleLabel: 'Example output · invented codebase',
    example: html`
      <div class="stack">
        ${dossier(generalHead)}
        ${findingCard(routesFinding, {
          bar: { name: ROUTES, hash: ROUTES_SHA256, tag: '96 lines' },
          code: { code: ROUTES_SOURCE, name: ROUTES, start: 41, highlight: [42], dim: [43, 44, 45, 46, 47, 49, 50], copy: true },
          rows: ['impact', 'observed', 'counter', 'gap', 'fix', 'next'],
          id: 'general-f-1',
        })}
      </div>`,
  },
  checks: {
    title: 'What the code security review checks',
    lede: 'The profile works from the entry points inward, in any language.',
    items: [
      {
        title: 'Entry points',
        text: 'Every externally reachable handler, route, job, command or exported function, and who reaches it: anyone, a signed-in user, a named role, another service.',
      },
      {
        title: 'Input to effect',
        text: 'Data followed into queries, shell commands, file paths, templates, deserialisers, outbound requests and cryptographic calls.',
      },
      {
        title: 'Authorization on every lookup',
        text: 'The tenant or owner predicate belongs inside the query. A check that runs after the fetch is reported.',
      },
      { title: 'Sibling diff', text: 'A check one handler performs and its sibling skips, when both guard the same asset.' },
      { title: 'Secrets and failure paths', text: 'Secrets and personal data in responses, logs and errors. Failure paths that fail open.' },
      { title: 'State and resources', text: 'Replay, races and check-then-use gaps on state changes. Resource exhaustion from attacker-sized input.' },
    ],
  },
  paste: {
    lede: 'Start with the files that accept input.',
    items: [
      { name: 'Source files for the code under review', note: 'Handlers, controllers, resolvers, jobs. Import a pull request from GitHub to review exactly what changed.' },
      { name: 'The routes, config or middleware they rely on', note: 'A control an unsupplied layer provides is reported as depending on that layer, by name.', optional: true },
    ],
  },
  returns: {
    lede: 'One review in a fixed format, built to be checked against the source.',
    items: [
      'A verdict: fix-before-deploy or no-blocking-issues for your own code, or one of the five bounty verdicts.',
      'A finding card per issue: severity, basis, file and line, impact and the path.',
      'The strongest counterargument to each finding, marked resolved or open.',
      'A fix and a test for each finding.',
      'An Entry points table: handler, location, who reaches it, what it changes or returns.',
      'Hardening and Checked-and-safe lists, and what was not supplied.',
      'A packet with the SHA-256 manifest of every file reviewed.',
    ],
  },
  more: {
    title: 'The rest of the same review',
    lede: 'The test for the finding above, and the entry points the profile listed for the invented invoices service.',
    label: 'Example output · invented codebase · invoices service',
    body: html`
      <div class="stack stack--24">
        ${codeBlock(routesFinding.test)}
        ${stackTable({
          caption: 'Entry points',
          columns: [{ label: 'Handler' }, { label: 'Location' }, { label: 'Reached by' }, { label: 'Changes or returns' }],
          rows: [
            [inline('`GET /invoices/:id`'), refChip(`${ROUTES}:41-45`), 'authenticated', 'Returns one invoice'],
            [inline('`DELETE /invoices/:id`'), refChip(`${ROUTES}:47-50`), 'authenticated', 'Deletes an invoice of the caller’s organisation'],
            [inline('`POST /invoices`'), refChip(`${ROUTES}:18-39`), 'role:billing', 'Creates an invoice'],
          ],
        })}
      </div>`,
  },
  faqItems: [
    {
      q: 'Which languages does it review?',
      a: 'Any language that lives in a text file. The profile reads source as text and cites file and line. It reviews what you supply and runs nothing.',
    },
    {
      q: 'What if a control lives in a file I did not paste?',
      a: 'The finding is marked as depending on unsupplied code and names the layer. Add that file and run the review again.',
    },
    MODEL_FAQ,
    STORED_FAQ,
  ],
  cta: {
    button: 'Review my code',
    title: 'Run a code security review on your own model',
    lede: 'Every finding with its file, its line and the argument against it.',
  },
  related: [RELATED.solidity, RELATED.scanner, RELATED.report, RELATED.panel],
});

// ---------------------------------------------------------------------------
// /prior-art-check
// ---------------------------------------------------------------------------

const PAIR = 'input-2/Pair.sol';

const overlapChips = {
  sameRoot: () => chip('Same root', { tone: 'danger' }),
  sameSymptom: () => chip('Same symptom, different root', { tone: 'unproven' }),
  unrelated: () => chip('Unrelated', { tone: 'neutral', dashed: true }),
};

const overlapCard = ledgerCard({
  id: 'overlap',
  tag: 'Overlap',
  title: 'Three prior items, classed against the finding in `Pair.sol`',
  bar: { name: 'input-1/finding.md', tag: '3 prior items' },
  rows: [
    {
      label: 'Fingerprint',
      kind: 'observed',
      plain: '`swap` credits the amount sent, not the amount received, before `_update`. Closing fix: measure the balance delta after the transfer.',
      refs: refChip(`${PAIR}:131`),
    },
    {
      label: 'Audit M-03',
      kind: 'counter',
      status: 'open',
      quote: 'Fee-on-transfer tokens break the reserve invariant.',
      chip: overlapChips.sameRoot(),
      text: 'The same missing balance-delta check in `swap`. The fix it recommends closes this path.',
      refs: html`${refChip('input-4/audit-report.md:204-221')} ${refChip(`${PAIR}:131`)}`,
    },
    {
      label: 'Known issue 4',
      kind: 'counter',
      status: 'open',
      quote: 'Rebasing tokens are not supported.',
      chip: overlapChips.sameSymptom(),
      text: 'Reserves drift through `sync`, a different code path. Its fix leaves line 131 unchanged.',
      refs: html`${refChip('input-3/known-issues.md:18')} ${refChip(`${PAIR}:164-170`)}`,
    },
    {
      label: 'PR 212',
      kind: 'gap',
      status: 'none',
      quote: 'Add a reentrancy lock to `swap`.',
      chip: overlapChips.unrelated(),
      text: 'A guard on entry. It does not touch the amount credited.',
      refs: refChip('input-5/pr-212.diff:9-14'),
    },
  ],
  next: 'Hold the report. Audit item M-03 already carries this root cause and its fix.',
});

const priorHead = {
  verdict: 'hold-duplicate',
  headline: 'Audit item M-03 has the same root cause, and the fix it recommends closes this path.',
};

const priorArt = profileLanding({
  path: '/prior-art-check',
  title: 'Known-issue and prior-art overlap check | Bounty Operator',
  description:
    'Compare your finding with the known issues and audits you supply. Each prior item is classed same-root, same-symptom or unrelated, with lines on both sides.',
  profileId: 'prior-art',
  profileName: 'Prior-art overlap',
  label: 'Prior-art check',
  hero: {
    title: html`Known-issue and <span class="nowrap">prior-art</span> overlap check`,
    lede: 'Paste your finding, the code it cites and everything already known about it: known-issue lists, audit reports, issues, pull requests. Your model fingerprints the root cause and classes every prior item as same-root, same-symptom-different-root or unrelated, with a line on each side.',
    exampleLabel: 'Example output · invented protocol',
    example: html`
      <div class="stack">
        ${dossier(priorHead)}
        ${overlapCard}
      </div>`,
  },
  checksButton: 'What it answers',
  checks: {
    title: 'What the overlap check answers',
    lede: 'One question: does a known issue, a prior audit note, a team branch or your own earlier report have the same root cause or the same one-line fix. Platforms judge duplicates on those two, so the check does too.',
    columns: 2,
    items: [
      { title: 'A root-cause fingerprint', text: 'The root cause and its one-line fix, read from the code you supplied.' },
      {
        title: 'A class for every prior item',
        text: 'Each known issue, audit note, branch or pull request classed same-root, same-symptom-different-root or unrelated, with a reference on each side.',
      },
      { title: 'Your own earlier reports', text: 'The broken invariant compared with what you already filed on the programme.' },
      { title: 'The duplicate clock', text: 'How exposed the finding is to a private duplicate, and the filing deadline that follows from it.' },
    ],
  },
  paste: {
    lede: 'The check judges the documents you supply. Supply every one you have.',
    items: [
      { name: 'Your finding or draft report', note: 'Notes are enough. The fingerprint comes from the code.' },
      { name: 'The source files it cites', note: 'At the commit the finding names.' },
      {
        name: 'Known issues, prior audits, issues and pull requests',
        note: 'The programme’s known-issues list, audit and fix-review reports, contest findings, tracker issues, diffs and commit messages.',
      },
    ],
  },
  returns: {
    lede: 'A class for every prior item, and the strings to search for the rest.',
    items: [
      'A Fingerprint: root cause, invariant, entry point and closing fix.',
      'An Overlap table: every prior item classed, with a reference in the prior material and one in your code.',
      'An Own reports table, and the duplicate clock with its filing deadline.',
      'Search strings for the material you did not supply, each with where to run it.',
      'One verdict. A same-root match holds the report as a duplicate.',
      'A packet with the SHA-256 manifest of every file reviewed.',
    ],
  },
  more: {
    title: 'The search strings from the same review',
    lede: 'What to run yourself against the material you did not supply. Pair is a contract invented for this page.',
    label: 'Example output · invented protocol · Pair',
    body: stackTable({
      caption: 'Search strings',
      columns: [{ label: 'String', mono: true }, { label: 'Where to run it' }],
      rows: [
        ['fee-on-transfer', 'Audit PDFs, the known-issues list, closed issues'],
        ['balanceOf(address(this))', 'The repository, every branch, with a full clone'],
        ['_update(', 'Pull requests and commit messages that touch Pair.sol'],
        ['reserves must equal balances', 'Audit PDFs, in an auditor’s wording of the invariant'],
      ],
      plain: true,
    }),
  },
  faqItems: [
    {
      q: 'Does it search private report queues?',
      a: 'It reads the documents you supply: known-issue lists, audit reports, issues and pull requests. Private report queues are held by the platforms. The Search strings section lists what to look for in the repository, its issues and the audit reports, so you find the public material yourself.',
    },
    {
      q: 'What counts as the same root cause?',
      a: 'The same function and consequence, or the same fix. That is how platforms judge duplicates: the title, the wording and the strength of the proof carry no weight.',
    },
    {
      q: 'What if I supply no prior material?',
      a: 'The review names the documents to collect and gives you the search strings to find them. It judges the documents it was given and nothing from memory.',
    },
    HOSTED_MODEL_FAQ,
    HOSTED_STORED_FAQ,
  ],
  cta: {
    button: 'Check the overlap',
    title: 'Check the overlap before you spend the week',
    lede: 'A root-cause fingerprint, every prior item classed against it, and a filing deadline.',
  },
  related: [RELATED.poc, RELATED.severity, RELATED.triage, RELATED.gauntlet],
});

export default [solidity, challenge, triage, general, priorArt];
