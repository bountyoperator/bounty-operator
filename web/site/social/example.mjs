// A report slip is rendered from the immutable saved review and supplied draft.
// The default stays Tessera for callers tied to the original example; a named
// example can show a different outcome without changing that saved evidence.

import { EXAMPLES } from '../../public/example.mjs';
import { extractRefs, parseReview } from '../../public/parse.mjs';
import { splitLines } from '../../public/review-core.mjs';
import { codeBlock, cx, html, inline, refChip, severityChip, statusChip, verdictChip } from '../components.mjs';

/**
 * The draft's header, supported severity, cited source and dated review verdict.
 * A claim is struck only when the saved review changes its severity.
 *
 *   exampleId  a bundled example id; omitted keeps the original Tessera example
 *   caption    line under the slip; false leaves it out
 *   still      no stamp animation (the social card is a still picture)
 */
export function reportSlip({ exampleId = EXAMPLES[0].id, caption, still = false, className } = {}) {
  const source = EXAMPLES.find((entry) => entry.id === exampleId);
  if (!source) throw new Error(`social/example.mjs: unknown example "${exampleId}"`);
  const labels = source.files.map((file, index) => `input-${index + 1}/${file.name}`);
  const parsed = parseReview(source.review, { labels });
  const finding = parsed.findings[0];
  if (!parsed.ok || !finding) throw new Error(`social/example.mjs: the bundled example "${source.id}" has no parsed finding to show`);

  const location = finding.locations[0];
  const file = source.files[labels.indexOf(location?.label)];
  if (!file) throw new Error(`social/example.mjs: ${location?.label} is not one of the example's files`);
  const fix = extractRefs(finding.fix, labels)
    .find((ref) => ref.label === location.label && ref.start >= location.start && ref.end <= location.end);
  if (!fix) throw new Error('social/example.mjs: the example fix names no line inside the cited range');

  // Keep the entire first fix reference visible, with context inside the finding.
  const from = Math.max(location.start, fix.start - 2);
  const to = Math.min(location.end, fix.end + 1);
  const cited = splitLines(file.content).slice(from - 1, to);
  const indent = Math.min(...cited.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
  const deciding = codeBlock({
    code: cited.map((line) => line.slice(indent)).join('\n'),
    start: from,
    highlight: Array.from({ length: fix.end - fix.start + 1 }, (_, index) => fix.start + index),
    label: `${location.label}, lines ${from} to ${to}`,
    className: 'slip__code',
  });

  const draft = source.files.find((entry) => /draft/i.test(entry.name));
  if (!draft) throw new Error(`social/example.mjs: the bundled example "${source.id}" has no draft report`);
  const draftLine = (pattern, what) => {
    const found = pattern.exec(draft.content);
    if (!found) throw new Error(`social/example.mjs: the example draft states no ${what}`);
    return found[1].trim();
  };
  const claimed = draftLine(/^Severity:\s*(critical|high|medium|low)\b/im, 'severity').toLowerCase();
  const draftTitle = draftLine(/^#\s+(.+)$/m, 'title');
  const claim = severityChip(claimed);
  const reviewedOn = new Date(source.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const protocol = source.context.target.split(' bounty programme')[0];
  if (caption === undefined) caption = `Saved example. ${protocol} is an invented protocol.`;

  return html`<figure class="${cx('home-shot', still && 'home-shot--still', className)}">
<div class="slip theme-light">
<div class="slip__head"><p class="slip__form">Draft report</p><p class="home-shot__stamp">${statusChip('example')}</p></div>
<dl class="slip__fields">
<div class="slip__field slip__field--wide slip__field--title"><dt>Title</dt><dd class="slip__title">${draftTitle}</dd></div>
<div class="slip__field"><dt>Draft claims</dt><dd>${claimed === finding.severity ? claim : html`<s class="slip__claimed">${claim}</s>`}</dd></div>
<div class="slip__field"><dt>Code supports</dt><dd class="slip__supported">${severityChip(finding.severity, undefined, { stamp: true })}</dd></div>
<div class="slip__field slip__field--wide slip__field--review"><dt>Review</dt><dd class="slip__headline">${inline(parsed.headline)}</dd></div>
<div class="slip__field slip__field--wide slip__field--source"><dt>Source</dt><dd>${refChip(location)}${deciding}</dd></div>
<div class="slip__field slip__field--wide slip__field--verdict"><dt>Verdict</dt><dd class="slip__stamp">${verdictChip(parsed.verdict, { size: 'lg' })}<span class="slip__dater">${reviewedOn} · ${source.model}</span></dd></div>
</dl>
</div>
${caption && html`<figcaption class="home-shot__caption">${caption}</figcaption>`}
</figure>`;
}
