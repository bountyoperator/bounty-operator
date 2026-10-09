// /panel-review: the Operator feature page. Two to four models review in
// parallel on the user's own keys, then a cross-examination pass keeps what
// the code proves. The example is invented. No performance claims.
//
// Keys follow web/public/app/panel.mjs: one OpenRouter key covers a whole
// panel, and a seat on another provider takes that provider's own key. Every
// seat and the cross-examination are hosted reviews through /api/review.
//
// The page says what a panel returns and shows it on an example. How the
// cross-examination rules on a finding is the hosted product: the page states
// the principle (the cited lines decide, the count is recorded) and stops.

import { button, chip, dossier, faq, findingCard, html, inline, refChip, sectionHeading, stackTable, statusChip } from '../../components.mjs';
import { breadcrumbsLd, faqPageLd } from '../../layout.mjs';
import { OPERATOR_LINE, RENEWAL } from '../../plans.mjs';
import { PROVIDERS } from '../../../public/providers.mjs';
import { LASTMOD, STYLES, ctaBand, exampleFrame, operatorActions, pageHero, points, relatedLinks, tickList } from './_shared.mjs';

const PATH = '/panel-review';

const openrouter = PROVIDERS.find((entry) => entry.id === 'openrouter');
// One model per lab, in the order the engine lists them.
const PANEL_MODELS = openrouter.models
  .filter((model, index, all) => all.findIndex((other) => other.id.split('/')[0] === model.id.split('/')[0]) === index)
  .slice(0, 3);

// ---------------------------------------------------------------------------
// The example panel: StreamVault, an invented staking contract
// ---------------------------------------------------------------------------

const FILE = 'input-1/StreamVault.sol';
const FILE_SHA256 = 'b41f07c2e9a6d3580f1c7e24a9d6b03c5e81f7a2d4c9063b7e5a18f2c0d94e6b';

const WITHDRAW_SOURCE = `function withdraw(uint256 shares) external nonReentrant {
    if (shares == 0) revert ZeroAmount();
    uint256 remaining = balanceOf[msg.sender] - shares;
    if (remaining != 0) {
        _checkpoint(msg.sender);
    }
    balanceOf[msg.sender] = remaining;
    totalShares -= shares;
    token.safeTransfer(msg.sender, shares);
}`;

const finding = {
  id: 'F-1',
  title: '`withdraw` skips the checkpoint when the balance falls to zero',
  severity: 'high',
  basis: 'proven-in-source',
  locations: [
    { label: FILE, start: 88, end: 97 },
    { label: FILE, start: 61, end: 64 },
  ],
  impact:
    'A staker who withdraws everything forfeits the rewards accrued since their last checkpoint. The forfeited amount stays in the vault and is paid out to the remaining stakers.',
  path: [
    '`withdraw` calls `_checkpoint` only when `remaining != 0` (lines 91-93).',
    'A full withdrawal sets the balance to 0 at line 94 without settling `earned` for the period since the last checkpoint.',
    '`claim` reads `earned[msg.sender]`, which was never updated for that period (lines 61-64).',
  ],
  counterargument: {
    objection: 'A full exit is meant to go through `exit()`, which claims first.',
    status: 'resolved',
    why: '`withdraw` is external and accepts the full balance. Nothing at lines 88-97 sends a full withdrawal to `exit()`.',
  },
  gap: ['No test was run. The forfeited amount follows from lines 61-64 and 91-94.'],
  fix: 'Call `_checkpoint(msg.sender)` before the balance changes, with no condition on `remaining`.',
  next: 'Write the test: stake, accrue, withdraw the full balance, then assert `earned` equals the accrued amount.',
};

function agreement(count, total) {
  return html`<span class="tally" aria-label="${count} of ${total} reviewers"><span class="tally__n">${count}/${total}</span>${Array.from(
    { length: total },
    (unused, index) => html`<span class="tally__dot"${index < count ? html` data-on` : ''}></span>`,
  )}</span>`;
}

const kept = () => chip('Kept', { tone: 'observed' });
const dropped = () => chip('Dropped', { tone: 'neutral', dashed: true });

const AGREEMENT = [
  { finding: '`withdraw` skips the checkpoint when the balance falls to zero', count: 3, kept: true, ref: `${FILE}:91-94`, note: 'The checkpoint sits inside `remaining != 0`.' },
  {
    finding: 'Reward rate truncates to zero for a small `notify` amount',
    count: 1,
    kept: true,
    ref: `${FILE}:118-120`,
    note: '`amount / duration` rounds down with no minimum. One reviewer reported it; the code proves it.',
  },
  {
    finding: 'Reentrancy in `claim`',
    count: 3,
    kept: false,
    ref: `${FILE}:101-108`,
    note: '`claim` is `nonReentrant` and zeroes `earned` at line 104, before the transfer at line 106.',
  },
  { finding: '`sweep` lets the owner take staked tokens', count: 2, kept: false, ref: `${FILE}:140-146`, note: 'Line 142 reverts when the token is the staking token.' },
];

const agreementTable = stackTable({
  caption: 'Agreement',
  columns: [{ label: 'Finding' }, { label: 'Reported by' }, { label: 'After cross-examination' }, { label: 'The lines that settle it' }],
  rows: AGREEMENT.map((row) => [
    inline(row.finding),
    agreement(row.count, PANEL_MODELS.length),
    row.kept ? kept() : dropped(),
    html`${refChip(row.ref)} <span class="cell-note">${inline(row.note)}</span>`,
  ]),
  className: 'agreement',
});

const agreementMini = html`
<div class="panel-seats">
  <p class="meta">Agreement</p>
  <ul class="agree-mini">${AGREEMENT.map(
    (row) => html`<li><span class="agree-mini__finding">${inline(row.finding)}</span>${agreement(row.count, PANEL_MODELS.length)}${row.kept ? kept() : dropped()}</li>`,
  )}</ul>
</div>`;

const EXAMPLE_HEAD = {
  verdict: 'fix-before-deploy',
  headline: 'Two findings survive cross-examination. Two that most of the panel reported are contradicted by the code.',
  counts: { critical: 0, high: 1, medium: 1, hardening: 2, 'checked-safe': 2 },
};

const heroAside = exampleFrame({
  className: 'example--narrow',
  label: 'Example panel · invented contract',
  body: html`
    <div class="stack">
      ${dossier(EXAMPLE_HEAD)}
      <div class="panel-seats">
        <p class="meta">The panel</p>
        <ul class="panel-seats__list">${PANEL_MODELS.map(
          (model, index) => html`<li><span class="panel-seats__n">panel-${index + 1}</span><code>${model.id}</code></li>`,
        )}</ul>
      </div>
      ${agreementMini}
    </div>`,
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const STEPS = [
  {
    title: 'Pick two to four models',
    text: 'Choose them from the models your OpenRouter key reaches. That key covers models from different labs, so the panel needs no second account. A model on another provider runs on that provider’s own key.',
  },
  {
    title: 'The reviews run in parallel',
    text: 'Each model runs the same profile on the same pinned files, as its own hosted review. Operator runs four hosted reviews at once.',
  },
  {
    title: 'Cross-check',
    text: 'A final hosted review, on the panel model you pick, reads the reviews next to the source and tests every finding against the lines it cites.',
  },
  {
    title: 'The merged review',
    text: 'What survives comes back as one review, with a count of how many models reported each finding.',
  },
];

const FAQ_ITEMS = [
  {
    q: 'Which keys does a panel run on?',
    a: 'One OpenRouter key reaches models from several labs, so a panel of different models runs on a single key. A panel model on Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Mistral or Groq takes that provider’s own key.',
  },
  {
    q: 'How many model calls is a panel?',
    a: 'One per panel model, plus one for the cross-examination pass. A panel of three is four hosted reviews. Each goes through our server to your provider and is billed to your key.',
  },
  {
    q: 'Does a panel run on a chat subscription?',
    a: 'A panel runs hosted, on API keys. The cross-examination is a hosted profile: its method is added on our server and the pass has no prompt to copy.',
  },
  {
    q: 'Does the majority decide?',
    a: 'No. Agreement is recorded as k of n and shown next to each finding. The cited lines decide. In the example on this page a finding one model reported is kept, and a finding all three reported is dropped.',
  },
  {
    q: 'What does the free plan show?',
    a: 'The example on this page. Panel review runs on Operator at US$10 per week.',
  },
];

const body = html`
${pageHero({
  trail: [{ label: 'Bounty Operator', href: '/' }, { label: 'Method', href: '/method' }, { label: 'Panel review' }],
  stamp: statusChip('operator'),
  title: 'Run 2 to 4 models on the same code, then cross-check their findings',
  lede: 'Each model reviews the same files on your own key. A final pass checks every finding against the lines it cites, keeps what the code proves and shows how many models reported it.',
  actions: operatorActions({ secondary: button({ label: 'How it runs', href: '#how', size: 'lg' }) }),
  note: 'US$10 per week. One OpenRouter key covers the whole panel. Model usage is billed by your provider to your key.',
  aside: heroAside,
})}

<section class="section wrap" aria-labelledby="how">
  ${sectionHeading({
    title: 'How it runs',
    id: 'how',
    lede: 'Each model reviews the files separately, and a final pass cross-checks them. Each review goes through our server to your provider. No file, key or review is stored.',
  })}
  ${points(STEPS, { columns: 4 })}
</section>

<section class="section wrap" aria-labelledby="rule">
  <div class="split">
    <div>
      ${sectionHeading({
        title: 'The code decides, not the vote',
        id: 'rule',
        lede: 'The count tells you how many reviewers saw something. The cited lines tell you whether it is there.',
      })}
    </div>
    <div class="stack">
      ${tickList([
        'Every finding in the merged review carries its count: how many of the panel reported it.',
        'Every row names the lines that settle it, so you check the ruling against the source yourself.',
        'Kept, unproven and dropped findings are all listed, so nothing a model reported goes missing.',
      ])}
    </div>
  </div>
</section>

<section class="section wrap" aria-labelledby="example">
  ${sectionHeading({
    title: 'What you get',
    id: 'example',
    lede: 'A review in the standard format, plus the agreement table. StreamVault is a staking contract invented for this page.',
  })}
  ${exampleFrame({
    label: 'Example panel review · invented contract · StreamVault',
    body: html`
    <div class="stack stack--24">
      ${dossier(EXAMPLE_HEAD)}
      ${agreementTable}
      <div class="findings">
        ${findingCard(finding, {
          bar: { name: FILE, hash: FILE_SHA256, tag: '163 lines' },
          code: { code: WITHDRAW_SOURCE, name: FILE, start: 88, highlight: [91, 92, 93], copy: true },
          id: 'panel-f-1',
        })}
      </div>
    </div>`,
  })}
</section>

<section class="section wrap" aria-labelledby="record">
  ${sectionHeading({ title: 'What is in the record', id: 'record' })}
  ${points(
    [
      { title: 'Surviving findings', text: 'Each as a finding card: location, impact, path, the strongest counterargument, the evidence gap, the fix and a test.' },
      { title: 'Agreement', text: 'Every distinct finding with its k of n count, kept, unproven or dropped, the lines that settle it and the reviews that reported it.' },
      { title: 'Checked and safe', text: 'What the panel flagged and the code clears, each with the line that guards it.' },
      { title: 'The packet', text: 'It downloads as one file: the merged review, the models used and the SHA-256 manifest of every file the panel read.' },
    ],
    { columns: 4 },
  )}
</section>

<section class="section wrap wrap--narrow" aria-labelledby="faq">
  ${sectionHeading({ title: 'Questions', id: 'faq' })}
  ${faq(FAQ_ITEMS, { exclusive: 'panel-faq' })}
</section>

${ctaBand({
  title: 'Put a panel on your next finding',
  lede: OPERATOR_LINE,
  actions: html`${button({ label: 'Get Operator', href: '/pricing', variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${button({ label: 'Your model, your key', href: '/your-model-your-key', size: 'lg' })}`,
  note: RENEWAL,
})}

<section class="section section--tight wrap">
  ${relatedLinks([
    { label: 'Gauntlet', href: '/gauntlet', text: 'Eight stages on one finding, then a verdict.' },
    { label: 'Solidity review', href: '/solidity-review', text: 'The single-model review a panel fans out.' },
    { label: 'Pricing', href: '/pricing', text: 'Free and Operator, side by side.' },
  ])}
</section>`;

export default {
  path: PATH,
  title: 'Panel review: multi-model AI review | Bounty Operator',
  description:
    'Run 2 to 4 models on the same code with your own key. A final cross-check keeps what the cited lines prove and shows how many models agreed.',
  label: 'Panel review',
  styles: STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Method', path: '/method' }, { name: 'Panel review', path: PATH }]), faqPageLd(FAQ_ITEMS)],
  lastmod: LASTMOD,
  body,
};
