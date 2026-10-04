// /gauntlet: the Operator feature page. One run, eight stages, one verdict.
//
// The dossier shown here is an invented example on a fictional protocol. The
// page shows what a run returns. For each stage it gives the name, the
// question and the names of the outputs, and nothing about how a stage reaches
// its answer: that is the hosted product.

import { button, dossier, faq, findingCard, html, inline, kv, sectionHeading, stackTable, statusChip, verdictChip } from '../../components.mjs';
import { breadcrumbsLd, faqPageLd } from '../../layout.mjs';
import { OPERATOR_LINE, RENEWAL } from '../../plans.mjs';
import {
  GAUNTLET_EXAMPLE,
  LASTMOD,
  STAGES,
  STYLES,
  ctaBand,
  exampleFrame,
  operatorActions,
  pageHero,
  pipeline,
  points,
  relatedLinks,
  tickList,
  verdictList,
} from './_shared.mjs';

const PATH = '/gauntlet';

// ---------------------------------------------------------------------------
// The example run: Brinewell Lend, an invented lending protocol
// ---------------------------------------------------------------------------

const FILE = 'input-2/src/LiquidationEngine.sol';
const FILE_SHA256 = '7c1e9a40b6d25f83e0a4c7719d3b58e2f6a09c14d7e3b5a8809f2c61d4e7b3a5';

const LIQUIDATE_SOURCE = `function liquidate(address borrower, uint256 repay) external nonReentrant {
    Position storage p = positions[borrower];
    if (_healthFactor(p) >= WAD) revert Healthy();
    uint256 seized = (p.collateral * (BPS + bonusBps)) / BPS;
    if (seized > p.collateral) seized = p.collateral;
    p.debt -= repay;
    p.collateral -= seized;
    debtToken.safeTransferFrom(msg.sender, address(this), repay);
    collateralToken.safeTransfer(msg.sender, seized);
}`;

const finding = {
  id: 'F-1',
  title: '`liquidate` sizes the seizure from the whole collateral, not from the amount repaid',
  severity: 'high',
  basis: 'proven-in-source',
  locations: [{ label: FILE, start: 212, end: 221 }],
  impact:
    'A liquidator who repays 1 unit of debt on an unhealthy position takes all of its collateral. The borrower loses the collateral above the debt. Bound: each unhealthy position’s collateral, minus the debt repaid.',
  path: [
    '`liquidate` checks one thing about the position: `_healthFactor(p) < WAD` (line 214).',
    'Line 215 computes `seized` from `p.collateral` and `bonusBps`. `repay` is not in the expression.',
    'Line 216 caps `seized` at `p.collateral`, so any `repay` above zero seizes the whole collateral.',
    'Lines 217-220 reduce the debt by `repay` and send `seized` to the caller.',
  ],
  counterargument: {
    objection: 'The position is unhealthy. The borrower was going to lose that collateral to liquidation anyway.',
    status: 'open',
    why: 'The intended path seizes the repaid amount plus the bonus. The draft never shows the two outcomes side by side, and its test reaches the unhealthy state through `MockOracle.setPrice`.',
  },
  gap: [
    'A run on a fork of the deployed revision where the position turns unhealthy through the real price feed.',
    'A final assertion on the borrower’s collateral balance, next to a control run that repays the debt in full.',
  ],
  fix: 'Compute `seized` from `repay`: convert it to collateral at the oracle price, add `bonusBps`, then cap at `p.collateral`.',
  next: 'Run the fork test with both assertions, then paste the command and its output into the report body.',
};

/** What each stage decided in the example run: [verdict, the one thing it decided]. */
const STAGE_RESULTS = {
  scope: ['submit', 'The file and the function exist in the scoped asset at the deployed revision. No exclusion names the class.'],
  provenance: [
    'prove-first',
    'Every step is performed by an unprivileged liquidator. The unhealthy state is set through `MockOracle.setPrice`, with no route from live state shown.',
  ],
  'prior-art': [
    'rewrite-then-submit',
    'Audit item L-04 has the same symptom and a different root cause. The report has to state the difference in its first paragraph.',
  ],
  poc: ['prove-first', 'The final assertion reads the return value of `liquidate`. The impact row names the borrower’s collateral.'],
  severity: ['rewrite-then-submit', 'The proof supports High on the scale supplied. The draft selects Critical.'],
  triage: ['prove-first', 'Fastest close: impact not shown. “The attacker drains the pool” has no assertion behind it.'],
  report: [
    'rewrite-then-submit',
    'Root cause and fix are confirmed against lines 215-216. The title claims a pool drain; the code shows a loss per position.',
  ],
  verdict: ['prove-first', 'One fork test stands between this draft and a High.'],
};

const stageTable = stackTable({
  caption: 'Stages',
  columns: [{ label: 'Stage' }, { label: 'Its verdict' }, { label: 'The one thing it decided' }],
  rows: STAGES.map((stage) => {
    const [verdict, decided] = STAGE_RESULTS[stage.id];
    return [html`<span class="stage-cell"><span class="stage-cell__n">${stage.n}</span>${stage.name}</span>`, verdictChip(verdict), inline(decided)];
  }),
  className: 'stage-table',
  plain: true,
});

const decision = kv(
  [
    ['Blocker', inline('The proof never reads the borrower’s collateral balance, and the unhealthy state comes from a mock oracle.')],
    [
      'Cheapest action',
      inline(
        'One fork test at the deployed revision: let the real feed move the price, liquidate with 1 unit of debt, assert the borrower’s collateral before and after, and run a control that repays in full.',
      ),
    ],
    ['Severity to claim', 'High, on the programme scale supplied in Context.'],
    ['Filing deadline', 'Within hours of the fork run. The fix is one line on the central liquidation path.'],
  ],
  { className: 'decision' },
);

const todoTable = stackTable({
  caption: 'To do, in order',
  dense: true,
  columns: [{ label: '#', align: 'end', header: false }, { label: 'Action' }, { label: 'Artefact it produces' }, { label: 'Stage' }],
  rows: [
    ['1', inline('Rerun the test on a fork of the deployed revision, with the price moved by the real feed.'), 'Command and output', 'Proof'],
    ['2', inline('Assert the borrower’s collateral balance before and after, and add the full-repay control.'), 'Two assertions', 'Proof'],
    ['3', 'Change the claimed severity to High and quote the impact row word for word.', 'Edited report', 'Severity'],
    ['4', 'Name audit item L-04 in the first paragraph and state the different root cause.', 'One paragraph', 'Prior art'],
    ['5', 'Replace “drains the pool” in the title with the per-position loss.', 'Edited title', 'Report'],
  ],
});

const heroAside = exampleFrame({
  className: 'example--narrow',
  label: 'Result · invented protocol',
  body: html`
    <div class="stack">
      ${dossier({ verdict: GAUNTLET_EXAMPLE.verdict, headline: GAUNTLET_EXAMPLE.headline, counts: GAUNTLET_EXAMPLE.counts })}
      <div class="ledger">${decision}</div>
    </div>`,
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const HAND_OVER = [
  { title: 'The draft and the code', text: 'Your report, the source files it cites and the proof with its command and output.' },
  { title: 'Impact and exclusions', text: 'The programme’s impact list, the row you intend to select, the exclusions and the trusted roles.' },
  { title: 'The severity scale', text: 'The programme’s own scale with its thresholds and downgrade clauses, pasted in.' },
  { title: 'Asset and revisions', text: 'The scoped asset, the revision your proof ran against and the revision that is deployed.' },
  { title: 'Prior material', text: 'Known issues, audits and fix-review notes, team branches, and your own earlier reports on the programme.' },
  { title: 'Dates and what the platform saved', text: 'The date you first reproduced it, the fee and duplicate rules, and what the platform stored after you filled in the form.' },
];

const FAQ_ITEMS = [
  {
    q: 'What does a gauntlet run cost?',
    a: 'The Gauntlet is part of Operator at US$10 per week. A run is eight reviews on your own model, so your provider bills eight model calls to your key.',
  },
  {
    q: 'Which model runs the stages?',
    a: 'The one you choose, on your own API key: OpenRouter, Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Mistral or Groq. Your files and key pass through our server, which adds the method of each stage. No file, key or review is stored.',
  },
  {
    q: 'Can I run the stages on a chat subscription or from a coding agent?',
    a: 'The stages need an API key. The report stage is the Challenge a draft report review, which also works on its own in ChatGPT or Claude. From a coding agent, the `gauntlet` prompt of the MCP server runs the same order: seven hosted reviews through `run_review` with a connection token, and the report stage on your agent’s own model.',
  },
  {
    q: 'What happens when an early stage ends the report?',
    a: 'The run stops there. If scope, design intent or prior art says drop or likely duplicate, the run stops before you spend time on a PoC, and the result opens on that verdict. One button runs the remaining stages anyway.',
  },
  {
    q: 'Does the gauntlet run code or touch the target?',
    a: 'It reads the files you supply. The proof stage reads your test and its output and tells you the one run that is missing. You run it locally.',
  },
  {
    q: 'What does the free plan show?',
    a: 'The example on this page, and 1 review a day of any review type. Every gauntlet stage except the final verdict is also a review type you can run on its own.',
  },
];

const body = html`
${pageHero({
  trail: [{ label: 'Bounty Operator', href: '/' }, { label: 'Method', href: '/method' }, { label: 'Gauntlet' }],
  eyebrow: html`${statusChip('operator')}`,
  title: 'Run one finding through 8 checks and get a verdict',
  lede: 'Give it your draft, your code and the program rules. You get one verdict (submit, rewrite then submit, prove first, hold as duplicate, or drop), the main thing blocking it, and the quickest fix.',
  actions: operatorActions({ secondary: button({ label: 'See the eight stages', href: '#stages', size: 'lg' }) }),
  note: 'US$10 per week. Runs on your own model and key.',
  aside: heroAside,
  stickyText: true,
})}

<section class="section wrap" aria-labelledby="verdicts">
  <div class="split">
    <div>
      ${sectionHeading({
        title: 'The verdict is one of five',
        id: 'verdicts',
        lede: 'Each verdict tells you what to do next with the report.',
      })}
      ${tickList([
        'One verdict for the whole report.',
        'One blocker: the single fact that stops submission today.',
        'The cheapest action that removes the blocker, as something you run locally.',
        'A filing deadline, set by how exposed the finding is to a private duplicate.',
      ])}
    </div>
    ${verdictList({ className: 'verdicts--boxed' })}
  </div>
</section>

<section class="section wrap" aria-labelledby="stages">
  ${sectionHeading({
    title: 'Eight stages, gates first',
    id: 'stages',
    lede: 'Scope, provenance and prior art end a report without a proof. They run before the stages that cost you work. Each stage reads the output of the stages before it.',
    aside: html`<a class="link" href="/method">The twelve checks behind the stages</a>`,
  })}
  ${pipeline({
    label: 'Gauntlet stages of the example run',
    states: { scope: 'done', provenance: 'done', 'prior-art': 'done', poc: 'done', severity: 'done', triage: 'done', report: 'done', verdict: 'current' },
    hrefFor: () => '#example',
  })}
  <div class="stage-grid">
    ${STAGES.map(
      (stage) => html`
      <article class="stage-card">
        <p class="stage-card__n meta">Stage ${stage.n}</p>
        <h3 class="stage-card__name">${stage.name}</h3>
        <p class="stage-card__decides">${stage.decides}</p>
        <ul class="stage__outputs">${stage.outputs.map((output) => html`<li>${output}</li>`)}</ul>
      </article>`,
    )}
  </div>
</section>

<section class="section wrap" aria-labelledby="example">
  ${sectionHeading({
    title: 'A full example',
    id: 'example',
    lede: 'A draft claims a Critical pool drain in Brinewell Lend, a lending protocol invented for this page. Eight stages later the finding stands, the severity moves, and one test is missing.',
  })}
  ${exampleFrame({
    label: 'Result · invented protocol · Brinewell Lend',
    body: html`
    <div class="stack stack--24">
      ${dossier({ verdict: GAUNTLET_EXAMPLE.verdict, headline: GAUNTLET_EXAMPLE.headline, counts: GAUNTLET_EXAMPLE.counts })}
      ${stageTable}
      <div class="findings">
        ${findingCard(finding, {
          bar: { name: FILE, hash: FILE_SHA256, tag: '318 lines' },
          code: { code: LIQUIDATE_SOURCE, name: FILE, start: 212, highlight: [215], flag: [216], copy: true },
          id: 'gauntlet-f-1',
        })}
      </div>
      ${todoTable}
    </div>`,
  })}
</section>

<section class="section wrap" aria-labelledby="hand-over">
  ${sectionHeading({
    title: 'What to paste in',
    id: 'hand-over',
    lede: 'The run asks for the evidence that decides outcomes. Anything you leave empty is marked as not supplied in the result.',
  })}
  ${points(HAND_OVER, { columns: 3 })}
</section>

<section class="section wrap" aria-labelledby="how">
  ${sectionHeading({
    title: 'How it runs',
    id: 'how',
    lede: 'The Gauntlet is eight reviews, run in order from your browser on your own key.',
  })}
  ${points(
    [
      {
        title: 'Eight reviews, one after another',
        text: 'Each stage is its own review type. It goes through our server, which adds the method of the stage, to your provider. Your provider bills each call to your key.',
      },
      {
        title: 'Earlier stages become evidence',
        text: 'A stage’s output goes to the later stages as a file named `stage-<n>-<profile>.md`, next to your draft and your code.',
      },
      {
        title: 'Finished stages are kept',
        text: 'A cancelled run, a provider error or a reload keeps every stage that finished. The run picks up at the stage that did not.',
      },
      { title: 'One download', text: 'The result downloads as one file, with a SHA-256 hash of every file the run read.' },
    ],
    { columns: 2 },
  )}
</section>

<section class="section wrap wrap--narrow" aria-labelledby="faq">
  ${sectionHeading({ title: 'Questions', id: 'faq' })}
  ${faq(FAQ_ITEMS, { exclusive: 'gauntlet-faq' })}
</section>

${ctaBand({
  title: 'Run the gauntlet before the triager does',
  lede: OPERATOR_LINE,
  actions: html`${button({ label: 'Get Operator', href: '/pricing', variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${button({ label: 'Read the method', href: '/method', size: 'lg' })}`,
  note: RENEWAL,
})}

<section class="section section--tight wrap">
  ${relatedLinks([
    { label: 'The twelve checks', href: '/method', text: 'The question each check asks, and why reports die on it.' },
    { label: 'Panel review', href: '/panel-review', text: '2 to 4 models on the same code, then a cross-check.' },
    { label: 'Pricing', href: '/pricing', text: 'Free and Operator, side by side.' },
  ])}
</section>`;

export default {
  path: PATH,
  title: 'Gauntlet: eight-stage bug bounty report check | Bounty Operator',
  description:
    'One run takes your draft through eight stages and returns one verdict, the main blocker and the quickest fix. Full example included.',
  label: 'Gauntlet',
  styles: STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Method', path: '/method' }, { name: 'Gauntlet', path: PATH }]), faqPageLd(FAQ_ITEMS)],
  lastmod: LASTMOD,
  body,
};
