// The social card (Open Graph image) as an HTML document.
//
// 1200 x 630, dark. Headline on the left, the rendered example on the right,
// the proof strip and the price line along the bottom. It is drawn from the
// same helpers and stylesheets as the home hero, so the card and the page
// cannot drift apart.
//
//   node web/site/social/render.mjs      writes card.html here and web/public/social-v3.png
//
// This module lives outside web/site/pages, so the generator builds no page from it.

import { brandMark, html } from '../components.mjs';
import { SITE } from '../layout.mjs';
import { exampleShot } from './example.mjs';

export const CARD = { width: 1200, height: 630 };

/** `assets` is the path from the document to web/public, as a relative URL. */
export function cardDocument({ assets = '../../public' } = {}) {
  const body = html`<main class="social-card">
<div class="social-card__pitch">
<p class="social-card__brand">${brandMark()}<span>${SITE.name}</span></p>
<p class="eyebrow social-card__eyebrow">Pre-submission review for bug bounty hunters and auditors</p>
<h1 class="social-card__title">${SITE.promise}</h1>
</div>
<div class="social-card__shot">
${exampleShot({ id: 'card', rows: ['observed'], steps: false, caption: false, level: 2 })}
</div>
<footer class="social-card__strip">
<p class="social-card__proof"><span>Built by Tradi3</span><span>Most valid Criticals, ENS</span><span>2nd of 135, Firelight</span></p>
<p class="social-card__price"><span>Free: one review a day</span><span>Operator: US$10 a week</span></p>
</footer>
</main>`;

  return `<!doctype html>
<html lang="en" data-theme="dark">
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
