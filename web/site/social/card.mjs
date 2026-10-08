// The social card (Open Graph image) as an HTML document.
//
// 1200 x 630, printed on the canary field. The promise on the left, the
// report slip on the right, the proof and the price on a black strip along
// the bottom. It is drawn from the same helpers and stylesheets as the home
// hero, so the card and the page cannot drift apart.
//
//   node web/site/social/render.mjs      writes card.html here and web/public/social-v4.png
//
// This module lives outside web/site/pages, so the generator builds no page from it.

import { brandMark, html } from '../components.mjs';
import { SITE } from '../layout.mjs';
import { reportSlip } from './example.mjs';

export const CARD = { width: 1200, height: 630 };

/** `assets` is the path from the document to web/public, as a relative URL. */
export function cardDocument({ assets = '../../public' } = {}) {
  const body = html`<main class="social-card page-field">
<div class="social-card__pitch">
<p class="social-card__brand">${brandMark()}<span>${SITE.name}</span></p>
<h1 class="social-card__title">${SITE.promise}</h1>
</div>
<div class="social-card__shot">
${reportSlip({ caption: false, still: true })}
</div>
<footer class="social-card__strip theme-dark">
<p class="social-card__proof">Built by Tradi3: most valid Criticals in ENS, 2nd of 135 in Firelight</p>
<p class="social-card__price"><span>Free: one review a day</span><span>Operator: US$10 a week</span></p>
</footer>
</main>`;

  return `<!doctype html>
<html lang="en" data-theme="light">
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
