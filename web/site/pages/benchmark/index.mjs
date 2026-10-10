// /benchmark: the Paydirt leaderboard, generated from the published results.
//
// Read at build time from latest.json and models/<slug>.json (see _data.mjs).
// When nothing is published this module exports no page, and the header,
// the footer and the home page do not link here (layout.mjs shows the
// Benchmark item only when the page exists).
//
// Every number on the page comes from the files through the formatters in
// _data.mjs. Every sentence that states a number is guarded: when its
// condition does not hold, the sentence is left out. No case text exists in
// the published files and none is described here.
//
// Sections: hero and facts, leaderboard, findings, picks, pair by pair, input by
// input, how it is kept honest, check it yourself, not run, FAQ. The page ranks models on the
// raw arm only. The profile arms of a release stay in its results file, which
// is published and downloadable; the page shows no with/without comparison.
// /benchmark/leaderboard.mjs adds column sorting and a column picker; the
// table reads the same without it.

import { readFileSync } from 'node:fs';

import { PROVIDERS } from '../../../public/providers.mjs';
import { attrs, button, chip, codeBlock, cx, faq, html, icon, inline, link, sectionHeading, stackTable } from '../../components.mjs';
import { SITE, absoluteUrl, breadcrumbsLd, faqPageLd } from '../../layout.mjs';
import { pageHero, workbenchLink } from '../method/_shared.mjs';
import { FAMILIES, METHOD_PATH, PAGE_PATH, SERVED, buildView, familyLabel, findings, fmt, inWords, listing, listingOr, loadPublished, pairsRight, profileRuns } from './_data.mjs';
import { BLOB, methodSentence } from './_markdown.mjs';
import { METHOD_SOURCE } from './method.mjs';

export const STYLES = ['/css/landing.css', '/css/benchmark.css'];
export const SCRIPTS = ['/benchmark/leaderboard.mjs'];
/** The day the page around the results last changed. The results carry their own date. */
const PAGE_UPDATED = '2026-10-09';

const NONE = html`<span class="bench-none" aria-hidden="true">–</span><span class="visually-hidden">none</span>`;
/** A formatted value, or the dash that says there is none. */
const show = (text) => (text === null || text === undefined ? NONE : text);
const TIER_LABEL = { best: 'Best score', budget: 'Budget', 'open-weight': 'Open weight' };

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** The 95% interval as a bar on 0 to 100, with the score marked. The numbers are in the text beside it. */
function intervalBar(ci, score, { min = 0, max = 100 } = {}) {
  if (!ci) return '';
  const span = max - min;
  const x = (value) => (((Math.min(max, Math.max(min, value)) - min) / span) * 100).toFixed(2);
  const lo = Number(x(ci[0]));
  const hi = Number(x(ci[1]));
  const mark = Number(x(score));
  return html`<svg class="ci" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="ci__track" x="0" y="3" width="100" height="2"/><rect class="ci__range" x="${lo}" y="1.5" width="${Math.max(0.8, hi - lo).toFixed(2)}" height="5" rx="1"/><rect class="ci__mark" x="${Math.max(0, mark - 0.9).toFixed(2)}" y="0" width="1.8" height="8"/></svg>`;
}

function modelCell(row, { level = 'th' } = {}) {
  const chips = html`<span class="lb__chips">${chip(row.vendor, { tone: 'neutral' })}${row.open && chip('Open weight', { tone: 'observed' })}</span>`;
  const inner = html`<span class="lb__who"><span class="lb__name">${row.name}</span><span class="lb__slug mono">${row.slug}</span>${chips}</span>`;
  return level === 'th' ? html`<th scope="row" class="lb__model">${inner}</th>` : inner;
}

function effortText(row) {
  if (!row.effort) return NONE;
  const asked = row.effortRequested && row.effortRequested !== row.effort ? html`<span class="lb__asked">asked ${row.effortRequested}</span>` : '';
  const mixed = row.effortMixed ? html`<span class="lb__asked">mixed: ${Object.entries(row.effortMixed).map(([effort, runs]) => `${effort} ${runs}`).join(', ')}</span>` : '';
  return html`<span class="mono">${row.effort}</span>${asked}${mixed}`;
}

/** data-* sort keys for one row; an empty value sorts last. */
const sortValue = (value) => (typeof value === 'number' ? String(value) : '');

// ---------------------------------------------------------------------------
// The leaderboard
// ---------------------------------------------------------------------------

/**
 * Columns after rank and model. `key` names the sort key and the column the
 * picker hides; `better` is the direction a first click sorts.
 */
const COLUMNS = [
  { key: 'score', label: 'Paydirt Score', short: 'Score', better: 'descending', value: (row) => row.score, fixed: true },
  { key: 'recall', label: 'Recall', short: 'Recall', better: 'descending', value: (row) => row.arm.recall, cell: (row) => show(fmt.rate(row.arm.recall)) },
  { key: 'fools', label: 'Fool’s gold', short: 'Fool’s gold', better: 'ascending', value: (row) => row.arm.fools_gold, cell: (row) => show(fmt.rate(row.arm.fools_gold)) },
  { key: 'challenge', label: 'Challenge accuracy', short: 'Challenge', better: 'descending', value: (row) => row.arm.challenge_ba, cell: (row) => show(fmt.rate(row.arm.challenge_ba)) },
  { key: 'failure', label: 'Failure rate', short: 'Failures', better: 'ascending', value: (row) => row.arm.failure, cell: (row) => show(fmt.rate(row.arm.failure)) },
  { key: 'cost', label: 'Cost per run', short: 'Cost / run', better: 'ascending', value: (row) => row.arm.usd_run, cell: (row) => show(fmt.usd(row.arm.usd_run)) },
  { key: 'time', label: 'Median time', short: 'Time', better: 'ascending', value: (row) => row.arm.latency_p50_s, cell: (row) => show(fmt.seconds(row.arm.latency_p50_s)) },
  { key: 'effort', label: 'Effort sent', short: 'Effort', value: () => null, cell: effortText, sortable: false },
];

function scoreCell(row) {
  const ci = row.ci ? `95% interval ${fmt.score(row.ci[0])} to ${fmt.score(row.ci[1])}` : 'no interval';
  return html`<span class="lb__score num">${fmt.score(row.score)}</span><span class="lb__pairs">${pairsRight(row.score, row.pairs)} pairs</span>${intervalBar(row.ci, row.score)}<span class="lb__ci">${row.ci ? html`<span aria-hidden="true">${fmt.score(row.ci[0])}–${fmt.score(row.ci[1])}</span>` : ''}<span class="visually-hidden">${ci}</span></span>`;
}

function leaderboard(view) {
  const headers = COLUMNS.map((column) => {
    const label = html`${column.label}`;
    const cellAttrs = attrs({ scope: 'col', class: cx(column.key !== 'effort' && 'num', `lb__col--${column.key}`), 'data-col': column.key, 'data-sort-key': column.sortable === false ? null : column.key, 'data-better': column.better ?? null });
    if (column.sortable === false) return html`<th${cellAttrs}>${label}</th>`;
    return html`<th${cellAttrs}><button class="table__sort" type="button" disabled>${label}${icon('sort')}</button></th>`;
  });
  const span = COLUMNS.length + 2;
  let order = 0;
  const body = view.tiers.map((group) => {
    const tierRow = html`<tr class="lb__tier" data-tier="${group.tier}"><td colspan="${span}"><span class="lb__tier-name">Tier ${group.tier}</span>${group.rows.length > 1 && html`<span class="lb__tier-note">intervals overlap tier leader</span>`}</td></tr>`;
    const rows = group.rows.map((row) => {
      const data = Object.fromEntries(COLUMNS.filter((column) => column.sortable !== false).map((column) => [`data-${column.key}`, sortValue(column.value(row))]));
      const rowAttrs = attrs({ class: 'lb__row', 'data-order': String(order++), 'data-tier': String(group.tier), ...data });
      const cells = COLUMNS.map((column) => {
        const content = column.key === 'score' ? scoreCell(row) : column.cell(row);
        return html`<td class="${cx(column.key !== 'effort' && 'num', `lb__col--${column.key}`)}" data-col="${column.key}"><span class="cell-label">${column.short}</span>${content}</td>`;
      });
      return html`<tr${rowAttrs}><td class="num lb__rank" data-col="rank">${row.rank}</td>${modelCell(row)}${cells}</tr>`;
    });
    return html`${tierRow}${rows}`;
  });

  const picker = html`<div class="lb-tools" data-lb-tools hidden>
<button class="btn btn--quiet btn--sm" type="button" data-lb-reset disabled>${icon('refresh')}<span class="btn__label">Default order</span></button>
<details class="disclosure lb-cols"><summary class="disclosure__summary">Show columns</summary><div class="disclosure__body"><ul class="lb-cols__list">${COLUMNS.filter((column) => !column.fixed).map(
    (column) => html`<li><label class="check"><input class="check__box" type="checkbox" checked data-lb-col="${column.key}"><span class="check__label">${column.label}</span></label></li>`,
  )}</ul></div></details>
</div>`;

  return html`${picker}<div class="table-wrap lb-wrap" tabindex="0" role="region" aria-label="Paydirt leaderboard, release ${view.release}">
<table class="table stack-table stack-table--wide lb" id="leaderboard">
<caption class="visually-hidden">Paydirt release ${view.release}: ${view.rows.length} ranked models on ${view.pairs} held pairs, in the order of the results file, grouped by tier.</caption>
<thead><tr><th scope="col" class="num lb__col--rank" data-col="rank">#</th><th scope="col" class="lb__col--model">Model</th>${headers}</tr></thead>
<tbody>${body}</tbody>
</table>
</div>`;
}

function columnNotes(view) {
  const notes = [
    ['Paydirt Score', `100 × pairs right ÷ ${view.pairs}, on the raw arm. A pair is right only when both of its inputs are right. The bar is the 95% interval.`],
    ['Recall', 'Planted bugs hit ÷ planted bugs, on the vulnerable twins.'],
    ['Fool’s gold', `Fixed twins whose patched code was reported as a bug rated ${listingOr(view.biteSeverities)} ÷ fixed twins.`],
    ['Challenge accuracy', 'The mean of two shares: overclaimed drafts caught with a quote of a false statement, and accurate drafts accepted.'],
    ['Failure rate', 'Inputs that ended with no readable answer (refusal, timeout, truncation, a provider error of the model’s own, an answer sheet that does not parse) ÷ inputs.'],
    ['Cost per run', 'The mean recorded cost per input in US dollars, including preserved retries. Unpreserved attempts are excluded, so the recorded cost can be lower than total account spend.'],
    ['Median time', 'Wall time of the median run.'],
    ['Effort sent', 'The reasoning effort the recorded requests carried. The harness asks every model for its highest.'],
  ];
  return html`<details class="disclosure lb-notes"><summary class="disclosure__summary">What each column means</summary><div class="disclosure__body"><dl class="kv lb-notes__list">${notes.map(([term, text]) => html`<div class="kv__row"><dt>${term}</dt><dd>${text}</dd></div>`)}</dl></div></details>`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function factsStrip(view) {
  const { results } = view;
  const items = [
    ['Models ranked', fmt.count(view.rows.length)],
    ['Held pairs', fmt.count(view.pairs)],
    ['Inputs per model', fmt.count(view.inputs)],
    ['Recorded inference cost', fmt.usd(view.usdTotal)],
    ['Published', fmt.date(results.generated_at)],
    ['Harness', typeof results.omp_version === 'string' ? results.omp_version.replace('/', ' ') : null],
  ].filter(([, value]) => value !== null && value !== undefined);
  return html`<dl class="bench-facts">${items.map(([term, value]) => html`<div class="bench-facts__item"><dt class="meta">${term}</dt><dd class="bench-facts__value num">${value}</dd></div>`)}</dl>`;
}

function findingsSection(view) {
  const list = findings(view);
  if (!list.length) return '';
  return html`<section class="section section--tight wrap" aria-labelledby="findings">
  ${sectionHeading({ title: 'What the numbers say', id: 'findings' })}
  <ol class="bench-findings">${list.map((entry) => html`<li class="bench-findings__item" data-finding="${entry.id}">${entry.text}</li>`)}</ol>
</section>`;
}

function picksSection(view) {
  if (!view.picks.length) return '';
  const cards = view.picks.map((group) => {
    const family = FAMILIES[group.family];
    const entries = group.entries.map((entry) => {
      return html`<li class="pick">
  <p class="pick__tags">${entry.tiers.map((tier) => chip(tier === 'budget' && view.budget !== null ? `Under ${fmt.usd(view.budget)} a run` : TIER_LABEL[tier] ?? tier, { tone: tier === 'best' ? 'observed' : 'neutral' }))}</p>
  <p class="pick__name">${entry.row.name}</p>
  <p class="pick__slug mono">${entry.row.slug}</p>
  <dl class="pick__nums">
    <div><dt class="meta">Score</dt><dd class="num">${fmt.score(entry.score)}${group.pairs !== null && html`<span class="pick__of">${pairsRight(entry.score, group.pairs)}</span>`}</dd></div>
    <div><dt class="meta">Median cost per run</dt><dd class="num">${show(fmt.usd(entry.usd_run))}</dd></div>
  </dl>
  ${family && link({ label: 'Open the workbench', href: workbenchLink(family.profile), className: 'pick__go' })}
</li>`;
    });
    return html`<article class="picks__card" aria-labelledby="pick-${group.family}">
  <header class="picks__head"><h3 class="picks__title" id="pick-${group.family}">${familyLabel(group.family)}</h3>${group.pairs !== null && html`<span class="meta">${group.pairs} pairs</span>`}</header>
  <ul class="picks__list">${entries}</ul>
</article>`;
  });
  return html`<section class="section section--tight wrap" aria-labelledby="picks">
  ${sectionHeading({
    title: 'Which model to use for what',
    id: 'picks',
    lede: `The highest score on each kind of task, the best of the models under ${fmt.usd(view.budget) ?? 'the budget line'} a run, and the best open-weight model. Equal scores go to the cheaper run.`,
  })}
  <div class="picks">${cards}</div>
  <p class="fine bench-note">Each model on its own. A score counts only the pairs of that task. A cost is the median over every input of the model’s run, other tasks included. The workbench adds its own profile to the model you pick there; these scores do not measure that profile.</p>
</section>`;
}

const OUTCOME = {
  right: { icon: 'check', label: 'Right' },
  wrong: { icon: 'x', label: 'Wrong' },
  failed: { icon: 'minus', label: 'Failed' },
};

function pairGrid(view, distribution) {
  if (!view.grid.length || !view.gridComplete) return '';
  const families = [];
  for (const pair of view.pairList) {
    const last = families.at(-1);
    if (last && last.family === pair.family) last.count += 1;
    else families.push({ family: pair.family, count: 1 });
  }
  const head = html`<thead>
<tr class="pg__families"><td class="pg__corner"></td>${families.map((entry) => html`<th scope="colgroup" colspan="${entry.count}" class="pg__family">${FAMILIES[entry.family]?.short ?? entry.family}</th>`)}<td class="pg__corner"></td></tr>
<tr><th scope="col" class="pg__model-head">Model</th>${view.pairList.map((pair) => html`<th scope="col" class="pg__pair"><span>${pair.pair}</span></th>`)}<th scope="col" class="num pg__total">Right</th></tr>
</thead>`;
  const body = view.grid.map((line) => html`<tr>
<th scope="row" class="pg__model">${line.row.name}</th>${line.cells.map((cell, index) => html`<td class="pg__cell" data-outcome="${cell}">${icon(OUTCOME[cell].icon)}<span class="visually-hidden">${view.pairList[index].pair}: ${OUTCOME[cell].label.toLowerCase()}</span></td>`)}<td class="num pg__total">${line.right}</td>
</tr>`);
  return html`<section class="section section--tight wrap" aria-labelledby="pairs">
  ${sectionHeading({
    title: 'Pair by pair',
    id: 'pairs',
    lede: `Every ranked model on each of the ${view.pairs} held pairs, on the raw arm. Right means right on both inputs of the pair. Failed means at least one input ended with no readable answer.`,
  })}
  <ul class="pg-legend" aria-label="Legend">${Object.entries(OUTCOME).map(([key, entry]) => html`<li><span class="pg__cell pg-legend__mark" data-outcome="${key}">${icon(entry.icon)}</span>${entry.label}</li>`)}</ul>
  <div class="table-wrap pg-wrap" tabindex="0" role="region" aria-label="Outcome of every ranked model on every held pair">
  <table class="pg">${head}<tbody>${body}</tbody></table>
  </div>
  <p class="fine bench-note">Pair names only: the held pairs are not published. ${distribution ?? ''}</p>
</section>`;
}

/** The release whose five blocked answers were read one by one: the note about them is shown for it alone. */
const isOriginalRelease = (results) => results.run_id === '2026-10' && results.harness_commit === '2aa1601b097aea7edc8711d88b4219bc900e8dc7';

/** The file's failure labels in plain words. A label with no entry here is printed as it is stored. */
const FAILURE_WORDS = {
  truncated: 'cut off at the output limit',
  timeout: 'timed out',
  unparseable: 'gave no readable answer sheet',
  error: 'ended in a provider error',
  empty: 'came back empty',
};
/** Failure counts as words, most frequent first: "11 cut off at the output limit, 2 timed out". */
const failureList = (kinds) =>
  Object.entries(kinds)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([kind, count]) => `${fmt.count(count)} ${FAILURE_WORDS[kind] ?? kind}`);

/**
 * Input by input: how many each ranked model answered right, answered wrong and
 * did not finish. A pair is lost either way, so the leaderboard cannot tell a
 * model that judges badly from one that runs out of room; this table can.
 */
function inputSplit(view) {
  if (!view.splitComplete) return '';
  const perModel = view.split[0].inputs;
  const sum = (key) => view.split.reduce((total, line) => total + line[key], 0);
  const failed = sum('failed');
  const kinds = {};
  for (const line of view.split) for (const [kind, count] of Object.entries(line.kinds)) kinds[kind] = (kinds[kind] ?? 0) + count;

  // The original release stored its five blocked answers under the label for an unreadable sheet.
  const blockedAmongThem = isOriginalRelease(view.results) && (kinds.unparseable ?? 0) >= 5;

  // The models that lost inputs only by not finishing them, the most unfinished first.
  const unfinishedOnly = view.split.filter((line) => line.wrong === 0 && line.failed > 0).sort((a, b) => b.failed - a.failed).slice(0, 3);
  const workbenchDefault = PROVIDERS.find((entry) => entry.id === 'openrouter')?.defaultModel;
  const notes = unfinishedOnly.map((line) => html`<p class="bench-note" data-unfinished="${line.row.slug}"><strong>${line.row.name}</strong> answered no input wrong. The ${fmt.count(line.failed)} it lost were not finished: ${listing(failureList(line.kinds))}.${line.row.slug === workbenchDefault ? ' It is the workbench’s default model on OpenRouter, where a review is one request and not an agent run at the highest effort.' : ''}</p>`);

  const rows = view.split.map((line) => [
    html`<span class="lb__name">${line.row.name}</span>`,
    fmt.count(line.right),
    fmt.count(line.wrong),
    fmt.count(line.failed),
    line.failed ? listing(failureList(line.kinds)) : NONE,
  ]);

  return html`<section class="section section--tight wrap" aria-labelledby="inputs">
  ${sectionHeading({
    title: 'Right, wrong and not finished',
    id: 'inputs',
    lede: `Every ranked model on each of its ${fmt.count(perModel)} inputs, on the raw arm. An input that ends with no readable answer scores as wrong, so a low rank can mean wrong answers or unfinished ones. This table tells them apart.`,
  })}
  <p class="bench-note" data-split-total>Of ${fmt.count(sum('inputs'))} inputs, ${fmt.count(sum('right'))} were answered right and ${fmt.count(sum('wrong'))} wrong.${failed ? ` ${fmt.count(failed)} were not finished: ${listing(failureList(kinds))}.` : ' Every input was finished.'}${blockedAmongThem && html` Five of the answers with no readable sheet are <a class="link" href="#blocked-answers">the blocked answers</a> of this release.`}</p>
  ${notes}
  ${stackTable({
    label: 'Inputs each ranked model answered right, answered wrong and did not finish',
    dense: true,
    columns: [{ label: 'Model' }, { label: 'Right', align: 'end' }, { label: 'Wrong', align: 'end' }, { label: 'Not finished', align: 'end' }, { label: 'Why not finished' }],
    rows,
  })}
</section>`;
}

function honestSection(view) {
  const { results } = view;
  const originalRelease = isOriginalRelease(results);
  const commitments = Array.isArray(results.commitments) ? results.commitments.length : 0;
  const harness = typeof results.omp_version === 'string' ? results.omp_version.replace('/', ' ') : 'one pinned agent harness';
  const cards = [
    {
      title: 'Original cases, committed in advance',
      text: `Every case was written for Paydirt. ${commitments ? `${fmt.count(commitments)} held cases carry a salted SHA-256 commitment written before the first scored run; a case’s salt is published when it moves to the public set.` : 'Each held case carries a salted SHA-256 commitment written before the first scored run.'}`,
    },
    {
      title: 'Twins',
      text: 'Each pair is a vulnerable twin and its fix, or an overclaimed draft and an accurate one. Flagging everything, or nothing, scores zero for the pair.',
    },
    {
      title: 'Mechanical scoring',
      text: 'A finding hits when it names the right file and either the right function or overlapping lines. A challenge counts by verdict and a quote found at a false statement of the draft. No model judges a model.',
    },
    {
      title: 'One harness, one process per run',
      text: `Every run is a fresh ${harness} process with a throwaway home, a fresh copy of the workspace and three read-only tools: read, grep and glob.`,
    },
    {
      title: 'Highest reasoning effort',
      text: `The harness asks every model for ${results.thinking ? `“${results.thinking}”, ` : ''}its highest effort, and records the effort each request carried. The table shows it per model.`,
    },
    {
      title: 'One routing policy, faults retried',
      text: `Every request carries the same provider-routing block: no endpoint that declares less than 8-bit precision, slow endpoints last. A rate limit, a server error or a dropped connection is retried, never scored.${view.retries !== null ? ` The latest stored invocations record ${view.retries === 1 ? 'one automatic retry' : `${fmt.count(view.retries)} automatic retries`}; earlier invocations and interrupted records are excluded from this count.` : ''}`,
    },
  ];

  const downloads = results.downloads ?? null;
  const hashes = results.hashes?.arms ? Object.entries(results.hashes.arms) : [];
  const models = results.models.filter((model) => model.detail);
  const links = html`<ul class="bench-links">
  <li>${icon('file')}<div><a class="link" href="${METHOD_PATH}">The full method</a><span class="fine">Cases, twins, the scoring rule, the harness command, routing, the three sets.</span></div></li>
  <li>${icon('download')}<div><a class="link" href="${SERVED}/latest.json">Results file</a><span class="fine">latest.json: every published number of this release, with each model’s score without the pairs its own vendor drafted.</span></div></li>
  ${models.length > 0 && html`<li>${icon('download')}<div><details class="disclosure bench-files"><summary class="disclosure__summary">Per-model outcome files<span class="disclosure__hint">${models.length}</span></summary><div class="disclosure__body"><ul class="bench-files__list">${models.map((model) => html`<li><a class="link mono" href="${SERVED}/${model.detail}">${model.detail.replace(/^models\//, '')}</a></li>`)}</ul></div></details><span class="fine">The outcome of every run: right or wrong, hits, bites, cost and time. No case text.</span></div></li>`}
  ${downloads?.archive && html`<li>${icon('download')}<div><a class="link" href="${SERVED}/${downloads.archive}">Public archive</a> <span class="meta">${fmt.bytes(downloads.bytes) ?? ''}</span>${downloads.sha256 && html`<span class="bench-links__hash"><span class="meta">SHA-256</span> <span class="mono">${downloads.sha256}</span></span>`}<span class="fine">The harness, the scorer, the prompts, protocol.json, the public practice cases with their answer keys and proofs, and the held-case commitments.</span></div></li>`}
  ${results.harness_commit && html`<li>${icon('code')}<div>${link({ label: 'The harness at this release', href: `${SITE.source}/tree/${results.harness_commit}/bench`, external: true })}<span class="fine mono">${results.harness_commit}</span></div></li>`}
</ul>`;

  const hashTable = results.protocol_sha256 && html`<div class="table-wrap bench-hashes" tabindex="0" role="region" aria-label="Protocol hash and the hash each arm ran under">
<table class="table table--dense">
<thead><tr><th scope="col">What</th><th scope="col">SHA-256</th></tr></thead>
<tbody>
<tr><th scope="row">Protocol</th><td class="mono bench-hashes__value">${results.protocol_sha256}</td></tr>
${hashes.map(([arm, hash]) => html`<tr><th scope="row">${arm === view.headline ? html`Arm <code>${arm}</code> (the core)` : html`Arm <code>${arm}</code>`}</th><td class="mono bench-hashes__value">${hash}</td></tr>`)}
</tbody>
</table>
</div>`;

  return html`<section class="section section--tight wrap" aria-labelledby="honest">
  ${sectionHeading({ title: 'How it is kept honest', id: 'honest', lede: 'Each claim, and the mechanism behind it.' })}
  ${originalRelease && html`<p class="bench-note" id="blocked-answers"><strong>Blocked answers:</strong> Anthropic’s cyber safeguards blocked 5 answers in this release: 3 from Claude Fable 5.1 and 2 from Claude Opus 5.5, all on the raw arm, the model alone. The benchmark account is not in Anthropic’s Cyber Verification Program. The blocks count as misses in this release.</p>`}
  <ul class="bench-honest">${cards.map((card) => html`<li class="bench-honest__card"><h3 class="bench-honest__title">${card.title}</h3><p class="bench-honest__text">${card.text}</p></li>`)}</ul>
  <div class="bench-proof">
    <div class="bench-proof__links">${links}</div>
    ${hashTable && html`<div class="bench-proof__hashes"><p class="meta">Hashes this release ran under</p>${hashTable}</div>`}
  </div>
</section>`;
}

function verifySection(view) {
  const archive = view.results.downloads?.archive ?? `paydirt-${view.release}-public.tar.gz`;
  const steps = [
    {
      title: 'Check the published numbers',
      text: 'Needs Node 22 or later and nothing else. It recomputes every published number from the per-run outcomes, recomputes the hashes from the files in the archive, and re-scores every run on a public case from its stored output.',
      code: [`node bench/bench.mjs verify --results latest.json --archive ${archive}`, ...(view.practice ? [`node bench/bench.mjs verify --results practice/latest.json --archive ${archive}`] : [])].join('\n'),
      label: 'Verify the results',
    },
    {
      title: 'Check the public cases',
      text: 'Needs Foundry for the Solidity proofs. Every planted bug must pass its proof on the vulnerable twin and fail it on the fixed one.',
      code: 'node bench/bench.mjs lint --proofs',
      label: 'Lint the public cases',
    },
    {
      title: 'Run a model on the practice set',
      text: `Needs ${typeof view.results.omp_version === 'string' ? view.results.omp_version.replace('/', ' ') : 'the pinned harness'} and an OpenRouter key. Models are not deterministic: a rerun lands near the published numbers, not on them.`,
      code: 'node bench/bench.mjs run --set public --models <slug> --run-id mine\nnode bench/bench.mjs score --set public --run-id mine',
      label: 'Run the practice set',
    },
  ];
  const practice = view.practice;
  return html`<section class="section section--tight wrap" aria-labelledby="verify">
  ${sectionHeading({
    title: 'Check it yourself',
    id: 'verify',
    lede: html`Download <a class="link" href="${SERVED}/latest.json">latest.json</a>, the per-model files and the archive, unpack the archive and run these from its folder.`,
  })}
  <ol class="bench-steps">${steps.map((step) => html`<li class="bench-steps__item"><div class="bench-steps__head"><h3 class="bench-steps__title">${step.title}</h3><p class="bench-steps__text">${step.text}</p></div>${codeBlock({ code: step.code, name: 'Terminal', numbers: false, copy: true, wrap: true, label: step.label })}</li>`)}</ol>
  ${practice && html`<div class="bench-practice">
    <h3 class="bench-practice__title">The practice set</h3>
    <p class="bench-practice__text">${practice.pairs} public pairs, published with their answer keys, proofs and the raw output of every run on them, so every outcome here can be re-scored end to end. This is not the Paydirt Score.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Practice set results">
    <table class="table table--dense stack-table">
    <thead><tr><th scope="col">Model</th><th scope="col" class="num">Pairs right</th><th scope="col" class="num">Recall</th><th scope="col" class="num">Fool’s gold</th><th scope="col" class="num">Cost per run</th></tr></thead>
    <tbody>${practice.rows.map((row) => html`<tr><th scope="row">${row.name}${!row.complete && html` <span class="fine">incomplete</span>`}</th><td class="num"><span class="cell-label">Pairs right</span>${show(pairsRight(row.arm.score.median, row.arm.pairs))}</td><td class="num"><span class="cell-label">Recall</span>${show(fmt.rate(row.arm.recall))}</td><td class="num"><span class="cell-label">Fool’s gold</span>${show(fmt.rate(row.arm.fools_gold))}</td><td class="num"><span class="cell-label">Cost per run</span>${show(fmt.usd(row.arm.usd_run))}</td></tr>`)}</tbody>
    </table>
    </div>
    <p class="fine bench-note"><a class="link" href="${SERVED}/practice/latest.json">practice/latest.json</a></p>
  </div>`}
</section>`;
}

function notRunSection(view) {
  const rows = [
    ...view.notRun.map((entry) => ({ name: entry.name, slug: entry.slug, tier: entry.tier, reason: entry.reason })),
    ...view.incomplete.map((entry) => ({
      name: entry.name,
      slug: entry.slug,
      tier: entry.tier,
      reason: `Its runs were not finished when this release was published: ${entry.answered} of ${entry.inputs} inputs completed.`,
    })),
  ];
  if (!rows.length && !view.notes.length) return '';
  // One line per reason: the models that share a reason are listed together.
  const groups = [];
  for (const row of rows) {
    const group = groups.find((entry) => entry.reason === row.reason);
    if (group) group.models.push(row);
    else groups.push({ reason: row.reason, models: [row] });
  }
  return html`<section class="section section--tight wrap" aria-labelledby="not-run">
  ${sectionHeading({
    title: 'Not run',
    id: 'not-run',
    lede: rows.length ? `${rows.length === 1 ? 'One model' : `${fmt.count(rows.length)} models`} of the release’s list ${rows.length === 1 ? 'has' : 'have'} no score. A model with no answer is listed here, not given a low score.` : null,
  })}
  ${rows.length > 0 && html`<div class="table-wrap" tabindex="0" role="region" aria-label="Models with no score in this release">
  <table class="table table--dense stack-table notrun">
  <thead><tr><th scope="col">Why</th><th scope="col">Models</th></tr></thead>
  <tbody>${groups.map((group) => html`<tr><th scope="row" class="notrun__why">${group.reason}</th><td><span class="cell-label">${group.models.length === 1 ? 'Model' : `${group.models.length} models`}</span><ul class="notrun__models">${group.models.map((row) => html`<li><span class="notrun__name">${row.name}</span>${row.name !== row.slug && html`<span class="notrun__slug mono">${row.slug}</span>`}${typeof row.tier === 'number' && html`<span class="notrun__tier meta">Run tier ${row.tier}</span>`}</li>`)}</ul></td></tr>`)}</tbody>
  </table>
  </div>`}
  ${view.notes.length > 0 && html`<div class="bench-release-notes"><p class="meta">Release notes</p>${view.notes.map((note) => html`<p>${inline(note)}</p>`)}</div>`}
</section>`;
}

/**
 * The answer to "Does Bounty Operator make a model score higher?": that the
 * release does not say, with the reason in counts read from the file (the
 * models that also ran with the profiles, their pairs, the runs per input).
 * It states no score. Null when the release ran the ranked arm only.
 */
export function profileAnswer(view) {
  const profile = profileRuns(view.results, view.headline);
  if (!profile) return null;
  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  const count = capital(inWords(profile.models));
  const ranked = new Set(view.rows.map((row) => row.slug));
  const models = profile.slugs.every((slug) => ranked.has(slug))
    ? `${count} of the ${view.rows.length} ranked models`
    : `${count} ${profile.models === 1 ? 'model' : 'models'}`;
  const pairs = profile.minPairs !== profile.maxPairs
    ? `${profile.minPairs} to ${profile.maxPairs} pairs`
    : profile.minPairs === view.pairs ? `all ${view.pairs} pairs` : `${profile.minPairs} ${profile.minPairs === 1 ? 'pair' : 'pairs'}`;
  const times = view.repeats === 1 ? 'once per input' : `${view.repeats} times per input`;
  return `This release does not answer that, and the page makes no claim. ${models} also ran with the Bounty Operator profiles added, on ${pairs}, ${times}. That is too little to judge the product by. Every number from those runs is in the results file.`;
}

function faqItems(view) {
  const { results } = view;
  const commitments = Array.isArray(results.commitments) ? results.commitments.length : 0;
  // True when the release ran any arm besides the ranked one.
  const profileArms = results.models.some((model) => Object.keys(model.arms ?? {}).some((arm) => arm !== view.headline));
  const scoreHigher = profileAnswer(view);
  const repeats = view.repeats === 1
    ? 'Every model answers every input once. The release’s credit covered one repeat for many models rather than three for a handful, so the score carries the noise of one run per input: the interval covers which pairs were drawn, not how a model varies between runs.'
    : `Every model answers every input ${view.repeats} times, and the score is the median of the repeats.`;
  return [
    {
      q: `Why ${view.pairs} pairs and ${view.repeats === 1 ? 'one run' : `${view.repeats} runs`} per input?`,
      a: `Each pair is an original case with an executable proof for every planted bug and every decoy, and the scored pairs are held, so the set grows slowly. With ${view.pairs} pairs the 95% interval is wide; it is published so that a two-pair difference is not read as a ranking. ${repeats}`,
    },
    {
      q: 'Why is a model missing from the table?',
      a: 'Models run in tiers, the cheapest first inside a tier, until the release’s credit is used. A model the credit did not reach, or whose host returned no answer, is listed under Not run with the reason. A model whose runs had not finished at publication is listed there too, with how many of its inputs were completed. None of them is given a low score.',
    },
    {
      q: 'Is the benchmark tuned to Bounty Operator?',
      a: `Bounty Operator is not a row. The ranked score comes from the raw arm, which sends no product text: the same system prompt, task and answer sheet to every model. ${profileArms ? 'The profile arms, which add a Bounty Operator core profile, are in the results file: download it, the file keeps every published number. ' : ''}Each pair started as a draft by a model of one of nine vendors. Sessions of Claude Opus 5.5, a ranked model, directed by the benchmark’s owner, then checked, repaired and proved every pair and wrote two of the hard pairs. Those two count as Anthropic-drafted, and the results file gives every model’s score without the pairs its own vendor drafted. Two ranked models, DeepSeek V4.1 Flash and GLM 5.3 Flash, ran the pilot on the find pairs of that time, and while nine pairs were written, drafts were sent to a few ranked models to see whether they could be decided both ways; the method names the models and the pairs whose design changed after such a check.`,
    },
    ...(scoreHigher ? [{ q: 'Does Bounty Operator make a model score higher?', a: scoreHigher }] : []),
    {
      q: 'What does held mean?',
      a: `A held case’s files are not published. Before the first scored run each held case got a salted SHA-256 commitment${commitments ? ` (${fmt.count(commitments)} in this release)` : ''}; when a held case moves to the public set, its salt is published with it so the commitment can be checked. Held does not mean unseen by the model providers: a held case is sent to the providers that serve each model, as every prompt is.`,
    },
    {
      q: 'When does it update?',
      a: 'With each release. A release spends a fixed amount of credit in run order: tier 1 first, the cheapest model first inside a tier. Held pairs move to the public set over time and new held pairs replace them. A change to the harness, the routing policy, the task text or a set changes every hash, and no earlier run counts after it.',
    },
  ];
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** Plain description of 50 to 160 characters, built from the file. */
function describe(view) {
  const full = `${view.rows.length} AI models on ${view.pairs} held twin pairs: who finds the planted bug, leaves the fixed code alone and catches an overclaimed report, and at what cost.`;
  if (full.length <= 160) return full;
  return 'AI models on held twin pairs: who finds the planted bug, leaves the fixed code alone and catches an overclaimed report, and at what cost.';
}

function datasetLd(view) {
  const { results } = view;
  const archive = results.downloads?.archive;
  const distribution = [
    { '@type': 'DataDownload', name: 'Results file', encodingFormat: 'application/json', contentUrl: absoluteUrl(`${SERVED}/latest.json`) },
    ...(archive
      ? [{ '@type': 'DataDownload', name: 'Public archive: harness, public cases and raw output', encodingFormat: 'application/gzip', contentUrl: absoluteUrl(`${SERVED}/${archive}`), ...(typeof results.downloads.bytes === 'number' ? { contentSize: `${results.downloads.bytes} B` } : {}) }]
      : []),
  ];
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `Paydirt ${view.release}`,
    description: `Paydirt release ${view.release}: ${view.rows.length} AI models reviewed ${view.pairs} held twin pairs through one agent harness at their highest reasoning effort. Per model: the Paydirt Score with its 95% interval, recall, fool's-gold rate, challenge accuracy, failure rate, cost per run and the outcome of every run.`,
    url: absoluteUrl(PAGE_PATH),
    creator: { '@type': 'Organization', name: 'Bounty Operator', url: `${SITE.origin}/` },
    ...(fmt.date(results.generated_at) ? { dateModified: results.generated_at.slice(0, 10) } : {}),
    license: `${SITE.source}/blob/main/LICENSE`,
    isAccessibleForFree: true,
    keywords: ['AI model benchmark', 'security review', 'smart contract audit', 'bug bounty', 'LLM evaluation'],
    variableMeasured: ['Paydirt Score', 'Recall', "Fool's-gold rate", 'Challenge balanced accuracy', 'Failure rate', 'Cost per run', 'Median wall time'],
    measurementTechnique: 'Mechanical scoring of answer sheets against held answer keys, with a percentile bootstrap interval over pairs',
    distribution,
  };
}

/** The /benchmark page for one publication, or [] when nothing is published. */
export function benchmarkPages(published) {
  if (!published) return [];
  const view = buildView(published);
  if (!view.rows.length) return [];
  const method = readFileSync(METHOD_SOURCE, 'utf8');
  const distribution = methodSentence(method, 'Bug classes of the scored find pairs');
  const items = faqItems(view);
  // The later of the day the results were published and the day the page around them last changed.
  const publishedOn = fmt.date(view.results.generated_at) ? view.results.generated_at.slice(0, 10) : undefined;
  const lastmod = publishedOn && publishedOn > PAGE_UPDATED ? publishedOn : PAGE_UPDATED;

  const body = html`
${pageHero({
  trail: [{ label: 'Bounty Operator', href: '/' }, { label: 'Benchmark' }],
  meta: `Paydirt · release ${view.release}`,
  title: 'AI model benchmark',
  lede: `${view.rows.length} models on ${view.pairs} held pairs: which one finds the planted bug, leaves the fixed code alone and catches an overclaimed report, and what a run costs.`,
  actions: html`${button({ label: 'See the model leaderboard', href: '#board', variant: 'primary', size: 'lg', iconEnd: 'arrow-right' })}${button({ label: 'Read the method', href: METHOD_PATH, size: 'lg' })}`,
})}

<section class="section section--tight wrap" aria-label="Test setup">
<details class="disclosure"><summary class="disclosure__summary">Test setup and recorded cost</summary><div class="disclosure__body">${factsStrip(view)}<p class="fine">The harness requests each model’s highest reasoning effort. A pair counts only when both answers are right. <a class="link" href="${METHOD_PATH}">Full benchmark method</a></p></div></details>
</section>

<section class="section section--tight wrap lb-section" aria-labelledby="board">
  ${sectionHeading({ title: 'Model leaderboard', id: 'board', lede: 'Each model alone on the raw arm: the shared harness and answer format, with no Bounty Operator profile added. Ranked by score and grouped by tier.' })}
  ${leaderboard(view)}
  <p class="bench-tier-line">A tier starts at its highest-scoring model and takes in every model whose 95% interval overlaps that model’s. These are descriptive groups; overlapping intervals do not establish equal performance.</p>
  ${columnNotes(view)}
</section>

${findingsSection(view)}
${picksSection(view)}
${pairGrid(view, distribution)}
${inputSplit(view)}
${honestSection(view)}
${verifySection(view)}
${notRunSection(view)}

<section class="section section--tight wrap" aria-labelledby="faq">
  <div class="bench-faq">
    ${sectionHeading({ title: 'Questions', id: 'faq' })}
    ${faq(items, { exclusive: 'bench-faq' })}
  </div>
</section>`;

  return [
    {
      path: PAGE_PATH,
      title: 'Paydirt: AI security review benchmark | Bounty Operator',
      label: 'Benchmark',
      bodyClass: 'benchmark-page',
      description: describe(view),
      nav: 'benchmark',
      og: { title: `Paydirt ${view.release}: which model finds the real bug`, description: describe(view) },
      styles: STYLES,
      scripts: SCRIPTS,
      jsonld: [breadcrumbsLd([{ name: 'Benchmark', path: PAGE_PATH }]), datasetLd(view), faqPageLd(items)],
      ...(lastmod ? { lastmod } : {}),
      body,
    },
  ];
}

const published = loadPublished();
export default benchmarkPages(published);
