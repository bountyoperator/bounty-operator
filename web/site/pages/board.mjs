// /board: every public bug bounty program on the platforms in
// web/public/board/platforms.mjs, with what filing at each one costs.
//
// The page is built from the data bundled at web/public/board/data (written by
// scripts/build-board.mjs). The same render functions run again in the browser
// (/board/board.mjs) when the Worker has a newer day's data, so the built page
// and the live page cannot drift apart. No figure is typed here: each one is
// read from the data.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { button, checkbox, closingBand, field, html, input, link, raw, select } from '../components.mjs';
import { absoluteUrl, breadcrumbsLd } from '../layout.mjs';
import { PLATFORMS } from '../../public/board/platforms.mjs';
import { SORTS, contestList, costPanel, count, freshList, platformTable, programTable, select as selectPrograms, shortDate, shownLine, tiles, updatedLine, withFresh } from '../../public/board/render.mjs';
import { toHtml } from '../../public/board/tree.mjs';

const PATH = '/board';
const data = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../public/board/data/${name}.json`, import.meta.url)), 'utf8'));

export const SNAPSHOT = data('snapshot');
export const PROGRAMS = withFresh(data('programs').programs, SNAPSHOT);

/** Rows of the program table the built page carries; the script loads the rest. */
export const FIRST_ROWS = 40;

const tree = (node) => raw(toHtml(node));
const names = PLATFORMS.map((platform) => platform.name);
const nameList = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
const open = PROGRAMS.filter((program) => program.kind !== 'contest');
const firstRows = selectPrograms(open, { sort: 'max' });

const sources = html`<ul class="board-sources">${PLATFORMS.map((platform) => html`<li><strong>${platform.name}.</strong> ${platform.source.charAt(0).toUpperCase()}${platform.source.slice(1)}.</li>`)}</ul>`;

const controls = html`<form class="board-controls" id="board-controls" aria-label="Filter the programs">
${field({ label: 'Search', for: 'board-q', className: 'board-controls__search', control: input({ id: 'board-q', type: 'search', placeholder: 'Program or company', attrs: { autocomplete: 'off', spellcheck: 'false' } }) })}
${field({ label: 'Platform', for: 'board-platform', control: select({ id: 'board-platform', value: '', options: [{ value: '', label: 'All platforms' }, ...PLATFORMS.map((platform) => ({ value: platform.id, label: platform.name }))] }) })}
${field({ label: 'Order', for: 'board-sort', control: select({ id: 'board-sort', value: 'max', options: SORTS.map(([value, label]) => ({ value, label })) }) })}
<fieldset class="board-controls__checks"><legend class="label">Only</legend>
${checkbox({ id: 'board-pays', label: 'Pays a bounty' })}
${checkbox({ id: 'board-free', label: 'No fee or stake' })}
${checkbox({ id: 'board-nokyc', label: 'No KYC' })}
${checkbox({ id: 'board-new', label: 'New or new scope' })}
</fieldset>
</form>`;

const body = html`
<section class="section section--tight wrap wrap--wide" id="board" data-day="${SNAPSHOT.day}" data-at="${SNAPSHOT.at}">
<header class="page-head page-field board-head">
<h1>Every public bug bounty, on one board</h1>
<p class="lede">${count(SNAPSHOT.totals.programs)} programs on ${nameList}: what each one pays, what it costs to file there, and what changed this month.</p>
<p class="meta board-updated" id="board-updated">${updatedLine(SNAPSHOT)}</p>
</header>
<div id="board-tiles">${tree(tiles(SNAPSHOT))}</div>
</section>

<section class="section section--tight wrap wrap--wide" aria-labelledby="platforms">
<h2 id="platforms">By platform</h2>
<p class="fine board-hint">Web2 and web3 side by side. A line shows the last twelve months where the platform's history is known; green rose, ochre fell, grey moved less than 2%.</p>
<div id="board-platforms">${tree(platformTable(SNAPSHOT))}</div>
</section>

<section class="section section--tight wrap wrap--wide" aria-labelledby="cost">
<div class="board-cost-wrap">
<div class="board-cost__intro">
<h2 id="cost">A report that bounces now costs money</h2>
<p>Some programs take a fee or a stake with every report, ask for an identity check, or close a report that has no proof of concept. The board reads each of these from what the platform publishes about the program.</p>
<div class="cluster board-cost__actions">
${button({ label: 'Review my report', href: '/?profile=report#workspace', variant: 'primary', iconEnd: 'arrow-right' })}
${button({ label: 'Report templates', href: '/templates' })}
</div>
<p class="fine">The review argues against your draft the way a triager would, before you pay to submit it. The copy-paste route is free and needs no account.</p>
</div>
<div id="board-cost">${tree(costPanel(SNAPSHOT))}</div>
</div>
</section>

<section class="section section--tight wrap wrap--wide">
<div class="board-split">
<div aria-labelledby="fresh">
<h2 id="fresh">New in the last ${SNAPSHOT.newDays} days</h2>
<p class="fine board-hint" id="board-since">Programs that launched, and programs that added assets to their scope. Fresh scope has had the fewest eyes on it.</p>
<div id="board-fresh">${tree(freshList(SNAPSHOT))}</div>
</div>
<div aria-labelledby="contests">
<h2 id="contests">Audit contests open now</h2>
<p class="fine board-hint">Public contests with an end date, soonest first.</p>
<div id="board-contests">${tree(contestList(SNAPSHOT))}</div>
</div>
</div>
</section>

<section class="section section--tight wrap wrap--wide" aria-labelledby="programs">
<h2 id="programs">Every program</h2>
${controls}
<p class="fine board-count" id="board-count" role="status">${shownLine(Math.min(FIRST_ROWS, firstRows.length), firstRows.length, open.length)}</p>
<div id="board-programs">${tree(programTable(firstRows, SNAPSHOT, { limit: FIRST_ROWS }))}</div>
<div class="board-more">${button({ label: 'Show more programs', id: 'board-more', variant: 'secondary', attrs: { hidden: true } })}</div>
<noscript><p class="fine">The list above is the first ${FIRST_ROWS} programs by reward. Searching and filtering the other ${count(open.length - FIRST_ROWS)} needs JavaScript.</p></noscript>
</section>

<section class="section section--tight wrap" aria-labelledby="method">
<div class="prose board-method">
<h2 id="method">Where the figures come from</h2>
<p>Once a day the board reads each platform's own public list. It needs no account anywhere, and it shows a program only while the platform lists it as open to the public.</p>
${sources}
<p>Every figure is the platform's own. A reward is shown in the currency the platform publishes it in, and ordering by reward compares the figures as published, without converting. Where a platform does not publish something, the cell is empty; nothing is estimated.</p>
<p><strong>New.</strong> A launch date is the platform's where it publishes one. Where it does not, the board uses the day it first saw the program, and says "first listed". An asset counts as added to scope on the day the board first saw it, or on the platform's own date where it gives one. The history of the four web2 platforms comes from the commit log of the open ${link({ label: 'bounty-targets-data', href: 'https://github.com/arkadiyt/bounty-targets-data', external: true })} set (MIT licence): one day a month back to December 2025, one a week from August 2026 and every day from 20 October 2026, so a first-listed date before then is the end of its week or month.</p>
<p><strong>Cost to file.</strong> Immunefi marks a program "Pay to Submit" and shows the amount when you submit. Cantina publishes a submission fee per bounty. Sherlock takes a stake with a report and returns it when the report is valid. HackerOne's response time is the latest figure in its own directory and can differ from the one on the program page.</p>
<p>The program page is the authority. Read it before you rely on anything here.</p>
</div>
</section>

${closingBand({
  title: 'Found something on one of them?',
  text: 'Run the draft through a review before you file. It checks every claim against the code you add and ends in one verdict: submit, rewrite, prove first, hold as a duplicate, or drop.',
  actions: [{ label: 'Review my report', href: '/?profile=report#workspace' }, { label: 'Report templates', href: '/templates' }],
  note: 'Free in ChatGPT or Claude with no account, or once a day on your own AI key with a free account.',
})}`;

const datasetLd = {
  '@context': 'https://schema.org',
  '@type': 'Dataset',
  name: 'Public bug bounty programs across platforms',
  description: `${count(SNAPSHOT.totals.programs)} public bug bounty and vulnerability disclosure programs on ${nameList}, with reward ceilings, scope sizes and what filing a report costs.`,
  url: absoluteUrl(PATH),
  dateModified: SNAPSHOT.day,
  isAccessibleForFree: true,
  variableMeasured: ['open programs', 'paying programs', 'assets in scope', 'highest reward', 'submission fee', 'KYC requirement'],
  publisher: { '@type': 'Organization', name: 'Bounty Operator', url: absoluteUrl('/') },
};

export default {
  path: PATH,
  title: 'Bug bounty board: every public program on eight platforms | Bounty Operator',
  description: `${count(SNAPSHOT.totals.programs)} public bug bounty programs on HackerOne, Bugcrowd, Intigriti, YesWeHack, Immunefi, Cantina and Sherlock: rewards, scope, fees to file. Daily.`,
  nav: 'board',
  label: 'Bounty board',
  styles: ['/css/board.css'],
  scripts: ['/board/board.mjs'],
  jsonld: [breadcrumbsLd([{ name: 'Bounty board', path: PATH }]), datasetLd],
  lastmod: SNAPSHOT.day,
  body,
};

export const BOARD_DAY_TEXT = shortDate(SNAPSHOT.day);
