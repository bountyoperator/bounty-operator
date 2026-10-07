// The Paydirt strip on the home page: the first three places (with any model tied with the third) and a link to
// /benchmark. It exists only when results are published; otherwise both
// exports are empty and the home page renders as it did before.

import { html, icon } from '../../components.mjs';
import { PAGE_PATH, buildView, fmt, loadPublished } from './_data.mjs';

/** The strip for one publication, or '' when nothing is published or nothing is ranked. */
export function teaser(published) {
  if (!published) return '';
  const view = buildView(published);
  if (!view.rows.length) return '';
  // The first three places, and every model tied with the third: a cut through a tie would
  // show some of the equal models as if they were ahead of the rest. Five rows at most; the
  // remainder of a larger tie is counted under the list.
  const cutRank = view.rows[Math.min(2, view.rows.length - 1)].rank;
  const placed = view.rows.filter((row) => row.rank <= cutRank);
  const top = placed.slice(0, Math.max(3, Math.min(5, placed.length)));
  const tiedLeft = placed.length - top.length;
  return html`<section class="wrap bench-teaser" aria-labelledby="bench-teaser-title">
<div class="bench-teaser__inner">
  <div class="bench-teaser__head">
    <p class="eyebrow">Benchmark · release ${view.release}</p>
    <h2 class="bench-teaser__title" id="bench-teaser-title">Paydirt: ${view.rows.length} models on ${view.pairs} held pairs</h2>
  </div>
  <div class="bench-teaser__table">
  <div class="bench-teaser__row bench-teaser__labels" aria-hidden="true"><span></span><span class="meta">Model</span><span class="meta">Score</span><span class="meta">Cost / run</span></div>
  <ol class="bench-teaser__list">${top.map(
    (row) => html`<li class="bench-teaser__row"><span class="bench-teaser__rank num" aria-hidden="true">${row.rank}</span><span class="bench-teaser__name">${row.name}</span><span class="bench-teaser__score num">${fmt.score(row.score)}<span class="visually-hidden"> Paydirt Score</span></span><span class="bench-teaser__cost num">${fmt.usd(row.arm.usd_run) ?? ''}<span class="visually-hidden"> a run</span></span></li>`,
  )}</ol>${tiedLeft > 0 && html`<p class="fine">${tiedLeft === 1 ? 'One more model' : `${tiedLeft} more models`} tied at ${fmt.score(top.at(-1).score)}.</p>`}
  </div>
  <a class="bench-teaser__go link" href="${PAGE_PATH}">See the leaderboard${icon('arrow-right')}</a>
</div>
</section>`;
}

// Its rules are in home.css: the home page does not load benchmark.css for one strip.
export const BENCH_TEASER = teaser(loadPublished());
