// The review shown in the home hero and on the social card.
//
// It is the first bundled example of the workbench (web/public/example.mjs),
// so "Run the example" opens the review the visitor has just seen: a draft
// that claims a Critical, cut down to the Medium the code supports. Tessera
// Staking is a protocol invented for the product. The review is the stored
// answer of a model to the product's own prompt, parsed here with the parser
// the results view uses, and the hash is the SHA-256 of the supplied file.
// Both surfaces render it as the report slip: the draft's own header lines,
// marked the way the review marked them, with the chips the results view uses
// (severity, verdict, reference), so the picture is the product.
//
// This module has no default export and lives outside web/site/pages, so the
// generator builds no page from it.

import { createHash } from 'node:crypto';

import { EXAMPLES } from '../../public/example.mjs';
import { extractRefs, parseReview } from '../../public/parse.mjs';
import { splitLines } from '../../public/review-core.mjs';
import { codeBlock, cx, html, inline, refChip, severityChip, statusChip, verdictChip } from '../components.mjs';

const SOURCE = EXAMPLES[0];
const LABELS = SOURCE.files.map((file, index) => `input-${index + 1}/${file.name}`);
const parsed = parseReview(SOURCE.review, { labels: LABELS });
const finding = parsed.findings[0];
if (!parsed.ok || !finding) throw new Error(`social/example.mjs: the bundled example "${SOURCE.id}" has no parsed finding to show`);

// The file the finding sits in, and the lines of its first location.
const location = finding.locations[0];
const file = SOURCE.files[LABELS.indexOf(location.label)];
if (!file) throw new Error(`social/example.mjs: ${location.label} is not one of the example's files`);
const fileLines = splitLines(file.content);

// The lines the card marks: where the function opens, and the line the fix names.
const fixLines = extractRefs(finding.fix, LABELS)
  .filter((ref) => ref.label === location.label && ref.start >= location.start && ref.end <= location.end)
  .map((ref) => ref.start);

// The excerpt: from the first cited line to two lines past the last marked
// line. The card is a picture of the result, so it shows the lines the
// finding turns on and the full result opens the whole range. The file's own
// indentation is taken off the left, and the line numbers stay the file's.
const sourceStart = location.start;
const sourceEnd = Math.min(location.end, Math.max(location.start, ...fixLines) + 2);
const cited = fileLines.slice(sourceStart - 1, sourceEnd);
const indent = Math.min(...cited.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
const excerpt = cited.map((line) => line.slice(indent));

const DRAFT = SOURCE.files.find((entry) => /draft/i.test(entry.name));
if (!DRAFT) throw new Error(`social/example.mjs: the bundled example "${SOURCE.id}" has no draft report`);

/** One header line of the draft: its title (the first "# " line) or a "Name: value" line. */
function draftLine(pattern, what) {
  const found = pattern.exec(DRAFT.content);
  if (!found) throw new Error(`social/example.mjs: the example draft states no ${what}`);
  return found[1].trim();
}

export const EXAMPLE = {
  id: SOURCE.id,
  protocol: 'Tessera Staking',
  model: SOURCE.model,
  file: location.label,
  sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'),
  lines: `${fileLines.length} lines`,
  claimed: draftLine(/^Severity:\s*(critical|high|medium|low)\b/im, 'severity').toLowerCase(),
  draftTitle: draftLine(/^#\s+(.+)$/m, 'title'),
  supported: finding.severity,
  verdict: parsed.verdict,
  headline: parsed.headline,
  source: excerpt.join('\n'),
  sourceStart,
  sourceEnd,
  highlight: [...new Set([location.start, ...fixLines])],
  // The line the fix names: the one that decides the finding.
  deciding: fixLines[0] ?? location.start,
  // When the stored review was written, as the slip's dater prints it.
  reviewedOn: new Date(SOURCE.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
  // The card cites the location its excerpt shows. The full result lists all of them.
  finding: { ...finding, locations: [location] },
  locations: finding.locations,
};

if (!fixLines.length) throw new Error('social/example.mjs: the example fix names no line inside the cited range');

/** The deciding line with the line above it and below it, as the slip prints them. */
const SLIP_FROM = Math.max(EXAMPLE.sourceStart, EXAMPLE.deciding - 2);
const SLIP_TO = Math.min(EXAMPLE.sourceEnd, EXAMPLE.deciding + 1);
const SLIP_CODE = excerpt.slice(SLIP_FROM - EXAMPLE.sourceStart, SLIP_TO - EXAMPLE.sourceStart + 1).join('\n');

/**
 * The report slip: the draft's header as the hunter wrote it, with the claimed
 * severity struck in pen, the severity the code supports stamped beside it,
 * the line that decides it printed under its reference, and the verdict
 * stamped in the box the form keeps for it, dated. Paper in both themes.
 *
 *   caption    line under the slip; false leaves it out
 *   still      no stamp animation (the social card is a still picture)
 */
export function reportSlip({
  caption = `Saved example. ${EXAMPLE.protocol} is an invented protocol.`,
  still = false,
  className,
} = {}) {
  const deciding = codeBlock({
    code: SLIP_CODE,
    start: SLIP_FROM,
    highlight: [EXAMPLE.deciding],
    label: `${location.label}, lines ${SLIP_FROM} to ${SLIP_TO}`,
    className: 'slip__code',
  });
  return html`<figure class="${cx('home-shot', still && 'home-shot--still', className)}">
<div class="slip theme-light">
<div class="slip__head"><p class="slip__form">Draft report</p><p class="home-shot__stamp">${statusChip('example')}</p></div>
<dl class="slip__fields">
<div class="slip__field slip__field--wide slip__field--title"><dt>Title</dt><dd class="slip__title">${EXAMPLE.draftTitle}</dd></div>
<div class="slip__field"><dt>Draft claims</dt><dd><s class="slip__claimed">${severityChip(EXAMPLE.claimed)}</s></dd></div>
<div class="slip__field"><dt>Code supports</dt><dd class="slip__supported">${severityChip(EXAMPLE.supported, undefined, { stamp: true })}</dd></div>
<div class="slip__field slip__field--wide slip__field--review"><dt>Review</dt><dd class="slip__headline">${inline(EXAMPLE.headline)}</dd></div>
<div class="slip__field slip__field--wide slip__field--source"><dt>Source</dt><dd>${refChip(location)}${deciding}</dd></div>
<div class="slip__field slip__field--wide slip__field--verdict"><dt>Verdict</dt><dd class="slip__stamp">${verdictChip(EXAMPLE.verdict, { size: 'lg' })}<span class="slip__dater">${EXAMPLE.reviewedOn} · ${EXAMPLE.model}</span></dd></div>
</dl>
</div>
${caption && html`<figcaption class="home-shot__caption">${caption}</figcaption>`}
</figure>`;
}
