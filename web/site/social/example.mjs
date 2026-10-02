// The review shown in the home hero and on the social card.
//
// It is the first bundled example of the workbench (web/public/example.mjs),
// so "Run the example" opens the review the visitor has just seen: a draft
// that claims a Critical, cut down to the Medium the code supports. Tessera
// Staking is a protocol invented for the product. The review is the stored
// answer of a model to the product's own prompt, parsed here with the parser
// the results view uses, and the hash is the SHA-256 of the supplied file.
// Both surfaces render it with the same helpers the results view uses
// (dossier, findingCard), so the picture is the product.
//
// This module has no default export and lives outside web/site/pages, so the
// generator builds no page from it.

import { createHash } from 'node:crypto';

import { EXAMPLES } from '../../public/example.mjs';
import { extractRefs, parseReview } from '../../public/parse.mjs';
import { splitLines } from '../../public/review-core.mjs';
import { cx, dossier, findingCard, html, icon, severityChip, statusChip } from '../components.mjs';

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

/** The severity the draft claims, read from the draft's own Severity line. */
function claimedSeverity() {
  const draft = SOURCE.files.find((entry) => /draft/i.test(entry.name));
  const stated = draft ? /^Severity:\s*(critical|high|medium|low)\b/im.exec(draft.content) : null;
  if (!stated) throw new Error('social/example.mjs: the example draft states no severity');
  return stated[1].toLowerCase();
}

export const EXAMPLE = {
  id: SOURCE.id,
  protocol: 'Tessera Staking',
  model: SOURCE.model,
  file: location.label,
  sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'),
  lines: `${fileLines.length} lines`,
  claimed: claimedSeverity(),
  supported: finding.severity,
  verdict: parsed.verdict,
  headline: parsed.headline,
  source: excerpt.join('\n'),
  sourceStart,
  sourceEnd,
  highlight: [...new Set([location.start, ...fixLines])],
  // The card cites the location its excerpt shows. The full result lists all of them.
  finding: { ...finding, locations: [location] },
  locations: finding.locations,
};

/** "Draft claims Critical -> Code supports Medium": the cut, in two chips. */
export function severityCut({ claimed = EXAMPLE.claimed, supported = EXAMPLE.supported, className } = {}) {
  // " claims" and " supports" drop out on a phone so the cut stays on one line.
  const side = (lead, rest, chip) =>
    html`<span class="home-cut__side"><span class="meta">${lead}<span class="home-cut__more"> ${rest}</span></span>${chip}</span>`;
  return html`<p class="${cx('home-cut', className)}">${side('Draft', 'claims', html`<s class="home-cut__claimed">${severityChip(claimed)}</s>`)}${icon('arrow-right', { className: 'home-cut__arrow' })}${side('Code', 'supports', severityChip(supported))}</p>`;
}

/**
 * The rendered result: a verdict banner over one finding card, on an
 * always-dark surface.
 *
 *   rows       finding rows to show, in order
 *   steps      false leaves the numbered path out and keeps the code excerpt
 *   level      heading level of the finding title
 *   id         id prefix, so the card never collides with a live result
 *   caption    line under the card; false leaves it out
 *   reveal     add the entrance animation of the finding card
 */
export function exampleShot({
  rows = ['impact', 'observed', 'counter', 'next'],
  steps = true,
  level = 2,
  id = 'example',
  caption = `Example review, as the model wrote it. ${EXAMPLE.protocol} is an invented protocol.`,
  reveal = false,
  className,
} = {}) {
  const shown = steps ? EXAMPLE.finding : { ...EXAMPLE.finding, path: [] };
  return html`<figure class="${cx('home-shot', 'theme-dark', className)}">
<p class="home-shot__stamp">${statusChip('example')}</p>
<div class="home-shot__banner">
${severityCut()}
${dossier({ verdict: EXAMPLE.verdict, headline: EXAMPLE.headline })}
</div>
${findingCard(shown, {
  level,
  id: `${id}-finding`,
  rows,
  reveal,
  bar: { name: EXAMPLE.file, hash: EXAMPLE.sha256, tag: EXAMPLE.lines },
  code: { code: EXAMPLE.source, start: EXAMPLE.sourceStart, highlight: EXAMPLE.highlight, label: `Source: ${EXAMPLE.file}` },
})}
${caption && html`<figcaption class="home-shot__caption">${caption}</figcaption>`}
</figure>`;
}
