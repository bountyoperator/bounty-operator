// /guide — How to write a bug bounty report that survives triage.
//
// Content follows .local/build/PUBLIC-METHOD.md and goes no deeper: the seven
// things a report that lands contains, the twelve checks (name, question,
// verdict; the method page says why reports die on each) and the eight
// gauntlet stages (name and question). The worked example (HarborVault) is
// invented for this page. Its contract and test were compiled and run with
// Foundry; the output shown is that run.

import { button, chip, codeBlock, disclosure, html, inline, link, verdictChip } from '../../components.mjs';
import { SITE, absoluteUrl, breadcrumbsLd, faqPageLd } from '../../layout.mjs';
import { CHECKS, RECORD_CLAIM, checksRunLine } from '../method/_shared.mjs';
import { DOCS_STYLES, UPDATED, checklist, docPage, ext, nextStep } from './_shared.mjs';

const PATH = '/guide';
const TITLE = 'Bug bounty report guide';
const DESCRIPTION =
  'Twelve checks to run and the evidence to attach before you submit a bug bounty report, with a worked example rewritten line by line.';

const FIRELIGHT = 'https://immunefi.com/audit-competition/audit-comp-firelight-1/leaderboard/';
const QUANTUS = 'https://immunefi.com/audit-competition/audit-comp-quantus/leaderboard/';
const ENS = 'https://immunefi.com/audit-competition/audit-competition-ens/leaderboard/';

/** The day this page's own text last changed. UPDATED is the legal pages' date and stays the publication date. */
const GUIDE_UPDATED = '2026-10-09';

// ---------------------------------------------------------------------------
// The worked example
// ---------------------------------------------------------------------------

const CONTRACT_NAME = 'src/HarborVault.sol';

const CONTRACT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Written for the Bounty Operator report guide. Not a real protocol.
contract HarborVault {
    IERC20 public immutable asset;
    uint256 public constant DELAY = 2 days;

    uint256 public totalShares;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public queued;
    mapping(address => uint256) public unlockAt;

    constructor(IERC20 asset_) {
        asset = asset_;
    }

    function deposit(uint256 assets) external returns (uint256 minted) {
        uint256 pool = asset.balanceOf(address(this));
        minted = totalShares == 0 ? assets : assets * totalShares / pool;
        shares[msg.sender] += minted;
        totalShares += minted;
        require(asset.transferFrom(msg.sender, address(this), assets), "transfer failed");
    }

    /// @dev Burns shares now and pays after DELAY, so an exit cannot be front-run.
    function requestWithdraw(uint256 shareAmount) external {
        uint256 pool = asset.balanceOf(address(this));
        uint256 owed = shareAmount * pool / totalShares;
        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        queued[msg.sender] += owed;
        unlockAt[msg.sender] = block.timestamp + DELAY;
    }

    function claim() external {
        require(block.timestamp >= unlockAt[msg.sender], "locked");
        uint256 owed = queued[msg.sender];
        queued[msg.sender] = 0;
        require(asset.transfer(msg.sender, owed), "transfer failed");
    }
}`;

const WEAK_TITLE = 'Critical: accounting bug in HarborVault lets an attacker steal funds';
const STRONG_TITLE =
  '`requestWithdraw` prices shares against assets already queued for withdrawal, so a split exit is overpaid out of the remaining holders’ assets';

const WEAK_DRAFT = `# ${WEAK_TITLE}

## Summary
The withdrawal accounting in HarborVault is wrong. An attacker can withdraw more than they put in and drain the vault. All user funds are at risk.

## Impact
Critical. Loss of all user funds.

## Proof of concept
PoC attached. Run the test to see the exploit.

## Recommendation
Fix the accounting in requestWithdraw.`;

const PROOF_OUTPUT = `$ forge test --match-contract HarborVaultSplitTest -vv

[PASS] test_control_oneRequest() (gas: 155201)
Logs:
  alice paid 50000000
  bob paid   50000000

[PASS] test_split_twoRequests() (gas: 158023)
Logs:
  alice paid 58333333
  bob paid   41666667`;

const STEPS = [
  'Alice and Bob each hold 50.000000 shares. The vault holds 100.000000 USDC.',
  'Alice calls `requestWithdraw(25.000000)`. Queued for Alice: 25.000000. Shares outstanding: 75.000000. Vault balance: still 100.000000.',
  'Alice calls `requestWithdraw(25.000000)` again. Line 35 computes 25 × 100 / 75 = 33.333333. Queued for Alice: 58.333333.',
  'After the two-day delay Alice calls `claim()` and receives 58.333333 USDC.',
  'Bob holds the only 50.000000 shares left. The vault holds 41.666667 USDC. Bob exits and receives 41.666667 USDC.',
];

const STRONG_REPORT = `# ${STRONG_TITLE.replaceAll('`', '').replace('’', "'")}

## Impact row
"Direct theft of user funds held by the vault."

## Location
src/HarborVault.sol:34-35 at commit 4f1c9e2, the revision the scope page lists.

## Root cause
Line 34 reads the vault's whole token balance as the pool. Assets queued at line 38 stay in that balance until claim() pays them, while the shares they belonged to were burned at line 37. Every request made while a queue exists is priced against assets that are already owed to someone.

## Attack steps
${STEPS.map((step, index) => `${index + 1}. ${step.replaceAll('`', '')}`).join('\n')}

Every step is a public call by an ordinary holder. No privileged role acts.

## Proof
\`\`\`
${PROOF_OUTPUT}
\`\`\`
The control test is the same exit made with one request. The final assertion in each test reads Bob's token balance. The test deploys HarborVault unmodified and a plain six-decimal token. Nothing is mocked.

## Severity
High. The proof shows theft of part of one holder's funds: 8.333333 of Bob's 50.000000 USDC. The programme's Critical row requires loss of all funds in the vault, which this proof does not assert.

## Limits
Measured for two requests only. More requests take more; that follows from line 35 and is not measured here. deposit() reads the same balance at line 25 and is not part of this claim.

## Nearest known issue
Audit note L-03, "rounding in requestWithdraw favours the user". L-03 concerns one unit of rounding and its fix changes the rounding direction. This report concerns the unsubtracted queue and its fix is different.

## Fix
Track a totalQueued counter. Add to it at line 38, subtract it in claim(), and price shares against balanceOf(vault) - totalQueued at lines 25 and 34.`;

/** One fragment of the report, as first written and as rewritten. */
function beforeAfter({ id, label, before, after, why }) {
  return html`<div class="ba">
<h3 class="ba__label" id="${id}">${label}</h3>
<div class="ba__panes">
<div class="ba__pane" data-side="before"><p class="ba__tag">${chip('Before', { tone: 'unproven', dashed: true })}</p><div class="ba__text">${before}</div></div>
<div class="ba__pane" data-side="after"><p class="ba__tag">${chip('After', { tone: 'observed' })}</p><div class="ba__text">${after}</div></div>
</div>
<p class="ba__why">${why}</p>
</div>`;
}

const example = html`
<div class="prose">
<p>HarborVault is a contract written for this guide. It is not a real protocol and no report on it was ever filed. The bug is real in the code as written, and the test output below is from an actual Foundry run.</p>
<p>The vault burns shares when a withdrawal is requested and pays two days later. Line 34 prices the shares against the vault's whole token balance, which still holds assets queued for earlier requests.</p>
</div>
<div id="guide-contract">
${codeBlock({ code: CONTRACT, name: CONTRACT_NAME, highlight: [34, 35], flag: [38], copy: true })}
</div>

${beforeAfter({
  id: 'example-title',
  label: 'Title',
  before: html`<p>${WEAK_TITLE}</p>`,
  after: html`<p>${inline(STRONG_TITLE)}</p>`,
  why: 'Mechanism and consequence in one sentence. The severity moves to the severity field, where it has to match the programme’s scale.',
})}

${beforeAfter({
  id: 'example-impact',
  label: 'Impact',
  before: html`<p>Critical. Loss of all user funds.</p>`,
  after: html`<p><strong>Impact row:</strong> “Direct theft of user funds held by the vault.”</p><p>A holder who splits a 50.000000-share exit into two requests is paid 58.333333 USDC instead of 50.000000. The other holder’s 50.000000 shares then redeem for 41.666667 USDC.</p>`,
  why: 'The impact row is quoted word for word, and each clause has a number behind it: who is paid, how much, and who is short.',
})}

${beforeAfter({
  id: 'example-steps',
  label: 'Attack steps',
  before: html`<p>An attacker can withdraw more than they put in and drain the vault.</p>`,
  after: html`<ol>${STEPS.map((step) => html`<li>${inline(step)}</li>`)}</ol><p>Every step is a public call by an ordinary holder. No privileged role acts.</p>`,
  why: 'Numbered steps with concrete values, kept apart from the test code. The last line is the actor trace: nobody trusted has to do anything.',
})}

${beforeAfter({
  id: 'example-proof',
  label: 'Proof',
  before: html`<p>PoC attached. Run the test to see the exploit.</p>`,
  after: html`${codeBlock({ code: PROOF_OUTPUT, numbers: false, label: 'Test command and output' })}<p>The control test is the same exit made with one request. The final assertion in each test reads Bob’s token balance. The test deploys HarborVault unmodified and a plain six-decimal token. Nothing is mocked.</p>`,
  why: 'The command and its output sit in the report body. The control case shows the loss comes from the second request, and the last assertion reads the object the impact row names: a holder’s balance.',
})}

${beforeAfter({
  id: 'example-severity',
  label: 'Severity',
  before: html`<p>Critical.</p>`,
  after: html`<p>High. The proof shows theft of part of one holder’s funds: 8.333333 of Bob’s 50.000000 USDC. The programme’s Critical row requires loss of all funds in the vault, which this proof does not assert.</p>`,
  why: 'The claim is the highest row the proof fully asserts. The report also names the one fact that would move it up.',
})}

${beforeAfter({
  id: 'example-limits',
  label: 'Limits and prior art',
  before: html`<p class="ba__empty">Nothing. The draft has no section for either.</p>`,
  after: html`<p><strong>Limits:</strong> measured for two requests only. More requests take more; that follows from line 35 and is not measured here. ${inline('`deposit()` reads the same balance at line 25 and is not part of this claim.')}</p><p><strong>Nearest known issue:</strong> audit note L-03, “rounding in requestWithdraw favours the user”. L-03 concerns one unit of rounding and its fix changes the rounding direction. This report concerns the unsubtracted queue and its fix is different.</p>`,
  why: 'The limit and the nearest known issue are stated by the author, before a triager raises either. The known issue is distinguished by its fix, not by its wording.',
})}

<div class="stack stack--12 guide-drafts">
<div id="guide-draft">
${disclosure({ summary: 'The first draft in full', hint: 'draft-report.md', body: codeBlock({ code: WEAK_DRAFT, name: 'draft-report.md', numbers: false, wrap: true, copy: true }) })}
</div>
${disclosure({ summary: 'The rewritten report in full', hint: 'report.md', body: codeBlock({ code: STRONG_REPORT, name: 'report.md', numbers: false, wrap: true, copy: true }) })}
</div>

<div class="guide-try">
<div class="guide-try__text">
<p class="guide-try__title">Run the weak draft yourself</p>
<p class="muted small">Loads HarborVault.sol and the first draft with Challenge a draft report selected. You choose the model and supply the key, or export the prompt to your chat app.</p>
</div>
${button({
  label: 'Challenge this draft',
  href: '/?profile=report#workspace',
  variant: 'primary',
  iconEnd: 'arrow-right',
  attrs: { 'data-handoff': 'guide-example' },
})}
</div>`;

// ---------------------------------------------------------------------------
// What a report that lands contains
// ---------------------------------------------------------------------------

const LANDS = [
  ['An executed proof, with its command and output, and a control case.', 'The control is the same test without the bug step. It shows the loss comes from the bug and not from the setup.'],
  ['A final assertion on the object the impact row names.', 'A balance, an owner, a stored record. An event or a reverted call is not the object.'],
  ['The exact code location on a pinned revision, and a concrete fix.', 'File, lines and commit. The fix names the lines it changes.'],
  ['A title that states mechanism and consequence in one sentence.', 'Numbered attack steps follow it, kept separate from the test code.'],
  ['Limits and non-claims, stated by you.', 'Name the nearest known issue and say how this one differs.'],
  ['The impact row, quoted verbatim.', 'Copy it from the programme page. Do not paraphrase it.'],
  ['Filed within hours of reproduction.', 'Fold the variants into one report.'],
];

const lands = html`
<div class="prose">
<p>A report that lands has these seven things. A triager can verify each of them without taking your word for it.</p>
</div>
${checklist(LANDS.map(([lead, rest]) => html`<p><strong>${lead}</strong> ${rest}</p>`), { className: 'guide-lands' })}`;

// ---------------------------------------------------------------------------
// The twelve checks
// ---------------------------------------------------------------------------

const outcome = (lead) => (typeof lead === 'string' ? verdictChip(lead) : chip(lead.label, { tone: 'neutral' }));

const checks = html`
<div class="prose">
<p>Every check exists because real reports were closed for that reason. Each one asks one question of your draft and leads to a verdict. The <a href="/method">method page</a> says why reports die on each one.</p>
</div>
<ol class="checks">
${CHECKS.map(
  (check) => html`<li class="checks__item">
<span class="checks__n" aria-hidden="true">${String(check.n).padStart(2, '0')}</span>
<div class="checks__body">
<h3 class="checks__name">${check.name}</h3>
<p class="checks__test">${check.asks}</p>
</div>
<p class="checks__outcome"><span class="visually-hidden">Leads to: </span>${check.leads.map(outcome)}</p>
</li>`,
)}
</ol>
<div class="prose">
<p>${checksRunLine({ className: null })}</p>
</div>`;

// ---------------------------------------------------------------------------
// The order to work in
// ---------------------------------------------------------------------------

const STAGES = [
  { name: 'Scope', profile: 'scope', question: 'Is the code in the scoped asset at the deployed revision, is the class excluded, and does every clause of the impact row have an artefact behind it?' },
  { name: 'Provenance', profile: 'provenance', question: 'Who performs each step, is the behaviour documented design or an audit fix, and is every precondition reachable from live state?' },
  { name: 'Prior art', profile: 'prior-art', question: 'Same root cause or same one-line fix as a known issue, a prior audit note, a team branch, or your own earlier report?' },
  { name: 'Proof', profile: 'poc', question: 'Does the proof run production code on every step and end by reading the object the impact row names, with measured numbers?' },
  { name: 'Severity', profile: 'severity', question: 'What is the highest row of the programme’s own scale that the proof fully asserts, after every downgrade clause?' },
  { name: 'Triager', profile: 'triage', question: 'What is the one sentence that closes this report in ten minutes, and is it answered in the first paragraph?' },
  { name: 'Report', profile: 'report', question: 'Do the claims follow from the code, is the proof inline, do form and body agree, are the limits stated?' },
  { name: 'Verdict', profile: null, question: 'One verdict, the blocker, the cheapest action that removes it and a filing deadline.' },
];

const VERDICTS = ['submit', 'rewrite-then-submit', 'prove-first', 'hold-duplicate', 'drop'];

const order = html`
<div class="prose">
<p>Run the gates that end a report before the stages that cost work. Scope, provenance and prior art are reading. A proof is building, so it comes fourth.</p>
</div>
<ol class="stages">
${STAGES.map(
  (stage) => html`<li class="stages__item">
<div class="stages__body">
<p class="stages__name">${stage.name}</p>
<p class="stages__q">${stage.question}</p>
</div>
${stage.profile && html`<a class="stages__link" href="/?profile=${stage.profile}#workspace">Run this stage<span class="visually-hidden">: ${stage.name}</span></a>`}
</li>`,
)}
</ol>
<div class="prose">
<p>Every stage but the last is a review type you can run on its own, as a hosted review with your own model key. Free covers 1 hosted review a day, any review type, on this site or with <code>run_review</code> from a coding agent. The report stage is a core profile: as a copy-paste review in ChatGPT or Claude, or on your coding agent’s own model with <code>prepare_review</code>, it needs no account and is not counted. Operator runs all eight in order as one <a href="/gauntlet">Gauntlet</a> and ends with a single verdict:</p>
</div>
<p class="cluster cluster--tight guide-verdicts">${VERDICTS.map((verdict) => verdictChip(verdict))}</p>`;

// ---------------------------------------------------------------------------
// Evidence to collect
// ---------------------------------------------------------------------------

const EVIDENCE = [
  'The programme’s impact list, and the row you selected',
  'Exclusions and trusted roles',
  'The severity scale, with thresholds and downgrade clauses',
  'The asset, the revision your proof ran on, and the deployed revision',
  'Known issues, audits and fix-review notes, team branches, and how deep your clone goes',
  'Your own earlier reports on the programme',
  'The actor behind each step',
  'The measured loss',
  'The proof run: command, commit, output, and anything mocked',
  'Fee and duplicate rules, and the date you first reproduced it',
  'The platform’s read-back of the stored submission',
];

const evidence = html`
<div class="prose">
<p>These decide outcomes, so gather them before you write a sentence. A missing one is a gap a triager finds for you.</p>
</div>
${checklist(EVIDENCE.map((item) => html`<p>${item}</p>`), { className: 'checklist--columns' })}`;

// ---------------------------------------------------------------------------
// When the model refuses
// ---------------------------------------------------------------------------

// Every name and link here was read at its primary source on 9 October 2026:
// Anthropic's Help Center article on the Cyber Verification Program and its
// security requirements, and OpenAI's cyber safety documentation. Read them
// again before changing a word. The app links to this section as
// /guide#model-refuses.
const CVP = 'https://support.claude.com/en/articles/14604842-cyber-verification-program';
const CVP_PORTAL = 'https://portal.anthropic.com/programs';
const CVP_KEY_RULES = 'https://support.claude.com/en/articles/17202708-cyber-verification-program-security-requirements';
const OPENAI_CYBER = 'https://chatgpt.com/cyber';

const REFUSES = {
  q: 'When the model refuses',
  a: html`<p>Some providers screen security work before the model answers. Anthropic’s newest Claude models block most of it by default, and OpenAI’s newer models can return a cyber policy error. A report about an exploit reads the same to a filter whether you found the bug or plan to use it.</p>
<p>Bounty Operator tells you when a provider blocked a review. A blocked review is never counted.</p>
<p>Run it again on another model or provider. That works today and needs no approval.</p>
<p>The gauntlet’s fourth stage, the proof review, is where it happens most. In our own run on 9 October 2026, OpenAI’s safeguards stopped that stage on GPT-6.1 Sol for all four drafts we tried. Claude Sonnet 5.5 had no stage blocked in 16 runs, which is one reason it is the default model on OpenRouter. When a stage is blocked on an OpenRouter key, the notice has a button that resumes that stage on a model from another vendor. The finished stages are kept.</p>
<p>For fewer blocks on your own Anthropic account, apply to the ${ext('Cyber Verification Program', CVP)}. Bug bounty hunters apply as individuals for Defense Access, on a paid plan, at ${ext('portal.anthropic.com/programs', CVP_PORTAL)}. Anthropic aims to answer within seven business days. The programme has ${ext('its own rules for API keys', CVP_KEY_RULES)}: read them before you use a granted key in any tool.</p>
<p>On OpenAI, Trusted Access for Cyber grants Daybreak access. Individuals request it at ${ext('chatgpt.com/cyber', OPENAI_CYBER)}.</p>
<p>An approval reduces blocks. It does not remove them.</p>`,
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const record = html`<p>${RECORD_CLAIM} Built by Tradi3: ${link({ label: '2nd of 133 in Immunefi’s Firelight competition', href: FIRELIGHT, external: true })}, ${link({ label: '8th of 65 in Quantus', href: QUANTUS, external: true })} and ${link({ label: '15th of 186 in ENS, with 17 valid Critical submissions, the most on the board', href: ENS, external: true })}.</p>`;

const body = docPage({
  head: {
    crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Report guide' }],
    title: TITLE,
    lede: 'Seven things a report that lands has, and a weak draft rewritten line by line.',
    actions: html`${button({ label: 'Check a draft', href: '/tools/report-check', variant: 'primary', iconEnd: 'arrow-right' })}${button({ label: 'Report templates', href: '/templates' })}`,
  },
  before: html`<div class="docs-record">${record}</div>`,
  sections: [
    { id: 'lands', title: 'What a report that lands contains', label: 'What lands', body: lands, prose: false },
    { id: 'example', title: 'A worked example, before and after', label: 'Worked example', body: example, prose: false },
    { id: 'checks', title: 'The twelve checks', body: checks, prose: false },
    { id: 'order', title: 'The order to work in', label: 'Order of work', body: order, prose: false },
    { id: 'evidence', title: 'Evidence to collect before you write', label: 'Evidence to collect', body: evidence, prose: false },
    // A section, not a folded answer: a visitor sent here by a blocked review reads it without opening anything.
    { id: 'model-refuses', title: REFUSES.q, body: REFUSES.a },
  ],
  after: nextStep({
    title: 'Now your own draft',
    text: 'Paste your draft into the report check, start from a platform template, or run a review against your own files.',
    actions: html`${button({ label: 'Review my report', href: '/?profile=report#workspace', variant: 'primary', iconEnd: 'arrow-right' })}${button({ label: 'Report check', href: '/tools/report-check' })}${button({ label: 'Report templates', href: '/templates' })}`,
  }),
});

const articleLd = {
  '@context': 'https://schema.org',
  '@type': 'TechArticle',
  headline: TITLE,
  description: DESCRIPTION,
  url: absoluteUrl(PATH),
  mainEntityOfPage: absoluteUrl(PATH),
  datePublished: UPDATED,
  dateModified: GUIDE_UPDATED,
  author: { '@type': 'Organization', name: SITE.builder.name, url: SITE.builder.url },
  publisher: { '@type': 'Organization', name: SITE.name, url: `${SITE.origin}/` },
};

export default {
  path: PATH,
  title: `${TITLE} | Bounty Operator`,
  label: 'Report guide',
  description: DESCRIPTION,
  nav: 'guide',
  og: { type: 'article' },
  styles: DOCS_STYLES,
  scripts: ['/docs/handoff.mjs'],
  jsonld: [breadcrumbsLd([{ name: 'Report guide', path: PATH }]), articleLd, faqPageLd([REFUSES])],
  lastmod: GUIDE_UPDATED,
  body,
};
