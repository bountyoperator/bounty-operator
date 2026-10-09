// The social card (Open Graph image) as an HTML document.
//
// 1200 x 630, on the black page. The promise on the left with the pen's ring,
// the report slip on the right in the ember's light, the proof and the price
// along the foot. It is drawn from the same helpers and stylesheets as the
// home hero, so the card and the page cannot drift apart.
//
//   node web/site/social/render.mjs      writes card.html here and web/public/social-v5.png
//
// This module lives outside web/site/pages, so the generator builds no page from it.

import { brandMark, html, penned } from '../components.mjs';
import { SITE } from '../layout.mjs';
import { reportSlip } from './example.mjs';

export const CARD = { width: 1200, height: 630 };

// The field behind the card: lines of the example report and its code, as the
// page's moving field prints them (/field.mjs). Still here; a card is a picture.
const FIELD = [
  'function stake(uint256 amount) external {',
  '    if (amount == 0) revert ZeroAmount();',
  '    _updateGlobal();',
  '    balanceOf[msg.sender] += amount;',
  'input-1/src/TesseraStaking.sol:87-94',
  '## Proof of concept',
  'forge test --match-test test_reserveDrain -vv',
  'assertGt(stolen, 0);',
  'C3 | overstated | rewards are capped at rewardReserve',
  '## Impact',
  'Theft of unclaimed yield',
  'N-1: exit() reverts when the reserve is short (known issue)',
  'earned = balance * (rewardPerToken() - paidPerToken[account])',
  'C4 | contradicted | input-1/src/TesseraStaking.sol:115',
  'Impact in scope: Medium, theft of unclaimed rewards',
  'Verdict: rewrite-then-submit',
  'function claim() external nonReentrant {',
  '    if (reward > rewardReserve) revert ReserveShort();',
  'Already reported? docs/known-issues.md:13',
  'vm.prank(attacker); staking.stake(1_166_666e18);',
  '## Recommended fix',
  'Call _settle(msg.sender) before the balance changes',
];

/** Thirty-four rows, each one line repeated across the card and started at its own offset. */
function fieldText() {
  return Array.from({ length: 34 }, (_, row) => {
    const line = FIELD[(row * 5 + 2) % FIELD.length];
    const lead = ' '.repeat((row * 7) % 12);
    return `${lead}${`${line}        `.repeat(8)}`.slice(0, 190);
  }).join('\n');
}

/** `assets` is the path from the document to web/public, as a relative URL. */
export function cardDocument({ assets = '../../public' } = {}) {
  const body = html`<main class="social-card">
<pre class="social-card__field" aria-hidden="true">${fieldText()}</pre>
<div class="social-card__pitch">
<p class="social-card__brand">${brandMark()}<span>${SITE.name}</span></p>
<h1 class="social-card__title">${penned(SITE.promise, 'the hole')}</h1>
</div>
<div class="social-card__shot">
${reportSlip({ caption: false, still: true })}
</div>
<footer class="social-card__strip">
<p class="social-card__proof">Built by Tradi3: most valid Criticals in ENS, 2nd of 133 in Firelight</p>
<p class="social-card__price"><span>Free: one review a day</span><span>Operator: US$10 a week</span></p>
</footer>
</main>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${CARD.width}">
<meta name="robots" content="noindex">
<title>${SITE.name} social card</title>
<link rel="stylesheet" href="${assets}/css/base.css">
<link rel="stylesheet" href="${assets}/css/home.css">
<link rel="stylesheet" href="social.css">
</head>
<body class="social">
${body}
</body>
</html>
`;
}
