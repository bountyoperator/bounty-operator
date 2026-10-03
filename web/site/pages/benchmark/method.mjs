// /benchmark/method: bench/METHOD.md, rendered when the site is generated.
//
// The page exists only when /benchmark does: when the published results are
// present. Without them this module exports no page.

import { readFileSync } from 'node:fs';

import { button, html } from '../../components.mjs';
import { breadcrumbsLd } from '../../layout.mjs';
import { DOCS_STYLES, docPage, nextStep } from '../docs/_shared.mjs';
import { METHOD_PATH, PAGE_PATH, loadPublished } from './_data.mjs';
import { BLOB, renderMethod } from './_markdown.mjs';

export const METHOD_SOURCE = new URL('../../../../bench/METHOD.md', import.meta.url);
export const STYLES = [...DOCS_STYLES, '/css/benchmark.css'];

/** The method page for one publication, or [] when nothing is published. */
export function methodPages(published) {
  if (!published) return [];
  const markdown = readFileSync(METHOD_SOURCE, 'utf8');
  const method = renderMethod(markdown);
  const { release } = published.results;
  const lastmod = typeof published.results.generated_at === 'string' ? published.results.generated_at.slice(0, 10) : undefined;

  const body = html`<div class="method-doc">${docPage({
    head: {
      crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Benchmark', href: PAGE_PATH }, { label: 'Method' }],
      title: 'Paydirt method',
      lede: html`How the cases are built and held, how an answer is scored and how every run is isolated. This is <a href="${BLOB}/bench/METHOD.md" target="_blank" rel="noopener noreferrer">bench/METHOD.md</a> from the repository, as it stood for release ${release}.`,
      actions: html`${button({ label: 'Back to the leaderboard', href: PAGE_PATH, icon: 'arrow-left' })}${button({ label: 'Check the numbers', href: `${PAGE_PATH}#verify`, variant: 'quiet', iconEnd: 'arrow-right' })}`,
    },
    before: html`<div class="prose">${method.intro}</div>`,
    sections: method.sections.map((section) => ({ id: section.id, title: section.title, body: section.body })),
    after: nextStep({
      title: 'See what it measured',
      text: `The leaderboard of release ${release}: every score with its interval, the cost of a run and the outcome of every model on every pair.`,
      actions: html`${button({ label: 'Open the leaderboard', href: PAGE_PATH, variant: 'primary', iconEnd: 'arrow-right' })}`,
    }),
  })}</div>`;

  return [
    {
      path: METHOD_PATH,
      title: 'Paydirt benchmark method | Bounty Operator',
      label: 'Benchmark method',
      description: 'How Paydirt is built and scored: held twin pairs, a mechanical scoring rule, one agent harness, one routing policy, and how to check every number.',
      nav: 'benchmark',
      styles: STYLES,
      jsonld: [breadcrumbsLd([{ name: 'Benchmark', path: PAGE_PATH }, { name: 'Method', path: METHOD_PATH }])],
      ...(lastmod ? { lastmod } : {}),
      body,
    },
  ];
}

export default methodPages(loadPublished());
