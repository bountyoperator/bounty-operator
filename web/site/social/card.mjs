// The social card (Open Graph image) as an HTML document.
//
// 1200 x 630. The promise and shared Spec mark sit beside the original mascot
// portrait. The homepage and film use the same Archivo and four brand colours.
//
//   node web/site/social/render.mjs      writes card.html and social-spec-v1.png
//
// This module lives outside web/site/pages, so the generator builds no page from it.

import { brandMark, html, penned } from '../components.mjs';
import { SITE } from '../layout.mjs';

export const CARD = { width: 1200, height: 630 };

/** `assets` is the path from the document to web/public, as a relative URL. */
export function cardDocument({ assets = '../../public' } = {}) {
  const body = html`<main class="social-card">
<div class="social-card__pitch">
<p class="social-card__brand">${brandMark()}<span>${SITE.name}</span></p>
<h1 class="social-card__title">${penned(SITE.promise, 'the hole')}</h1>
<p class="social-card__lede">Review your bug report against the code and proof.</p>
</div>
<div class="social-card__shot">
<img src="${assets}/brand/spec-960.webp" width="960" height="960" alt="Spec, a coral bug with a magnifying glass.">
</div>
<footer class="social-card__strip">
<p class="social-card__proof">Spec. A bug with standards.</p>
<p class="social-card__price">bountyoperator.com</p>
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
