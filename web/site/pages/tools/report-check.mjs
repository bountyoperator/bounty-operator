// /tools/report-check: paste a draft report, get fourteen text checks.
//
// The check table and the phrase list are rendered from the same definitions
// the browser module runs, so the page can never describe a check it does not do.

import { button, chip, faq, field, html, icon, stackTable, textarea } from '../../components.mjs';
import { faqPageLd } from '../../layout.mjs';
import { CHECKS, PHRASE_NOTES } from '../../../public/tools/report-check-core.mjs';
import { COUNTER_LINE, LASTMOD, TOOL_STYLES, nextAction, relatedTools, toolCrumbsLd, toolHead, toolPanel } from './_shared.mjs';

const PATH = '/tools/report-check';

const QUESTIONS = [
  {
    q: 'Where does my draft go?',
    a: `Nowhere. The fourteen checks are JavaScript that runs in this tab, and the page sends no request with your text. ${COUNTER_LINE} Pressing “Run the full challenge on your model” moves the draft to the workbench through this browser’s session storage. A model sees it only when you start a review there.`,
  },
  {
    q: 'What does 14 of 14 tell me?',
    a: 'That the draft contains the text these checks look for: a commit, a quoted impact row, one severity, an inline proof with its output, and a prior-art reference or search result. The check does not verify comparison quality or duplicate status. The workbench challenge reviews the claims against the evidence you supply.',
  },
  {
    q: 'Which report formats does it read?',
    a: 'Markdown and plain text. Immunefi, Cantina, Sherlock and HackerOne reports all carry these parts, under different headings. The checks look for the content, so the heading names do not matter.',
  },
];

// Before a draft is pasted the list shows the fourteen checks, not yet run.
const pendingRows = CHECKS.map((check) => html`<li class="check" data-status="pending"><div class="check__head">${chip('Not run', { dashed: true })}<h3 class="check__label">${check.label}</h3></div></li>`);

const panel = toolPanel({
  id: 'report-check',
  name: 'report-check',
  tag: 'Local · 14 checks',
  body: html`
<div class="tool-split">
<div class="tool-split__in">
${field({
    label: 'Draft report',
    for: 'draft',
    control: textarea({
      id: 'draft',
      rows: 18,
      mono: true,
      className: 'tool-draft',
      placeholder: '# Missing checkpoint in stake() lets a new staker drain accrued rewards\n\nSeverity: High\n…',
      attrs: { spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'draft-help' },
    }),
    help: 'Markdown or plain text. The checks run as you type.',
  })}
<div class="cluster">
${button({ label: 'Check report', id: 'check-run', variant: 'secondary', icon: 'play' })}
${button({ label: 'Load example', id: 'check-example', variant: 'quiet' })}
${button({ label: 'Clear', id: 'check-clear', variant: 'quiet' })}
</div>
</div>
<div class="tool-split__out">
<h2 class="visually-hidden">Result</h2>
<div class="score" id="score" role="status">
<p class="score__line"><span class="score__n" id="score-n">0</span><span id="score-text">of ${CHECKS.length} checks pass</span></p>
<ol class="tally" id="tally" aria-hidden="true">${CHECKS.map(() => html`<li></li>`)}</ol>
<p class="score__note" id="score-note">Paste a draft, or load the example, to see each check with the line it found.</p>
</div>
<div class="cluster tool-actions">
${button({ label: 'Run the full challenge on your model', href: '/?profile=report#workspace', id: 'check-handoff', variant: 'primary', iconEnd: 'arrow-right' })}
${button({ label: 'Copy checklist as Markdown', id: 'check-copy', icon: 'copy', disabled: true })}
</div>
<div id="check-notice"></div>
<ol class="checks" id="checks" aria-label="Check results">${pendingRows}</ol>
</div>
</div>`,
});

const checkTable = stackTable({
  caption: 'What each check looks for',
  columns: [{ label: 'Check' }, { label: 'What it looks for' }, { label: 'Fix when it is open' }],
  rows: CHECKS.map((check) => [check.label, check.test, check.fix]),
  className: 'tool-table',
});

const phraseList = html`<dl class="phrases">${PHRASE_NOTES.map((entry) => html`<div class="phrases__row"><dt>“${entry.phrase}”</dt><dd>${entry.note}</dd></div>`)}</dl>`;

const body = html`
<section class="section section--tight wrap">
${toolHead({
  path: PATH,
  lede: 'Paste a draft. Fourteen checks answer at once: what is on the page, what is missing, and which sentence a triager will quote back at you.',
})}
${panel}
</section>

<section class="section section--tight wrap" aria-labelledby="checks-heading">
<div class="tool-copy">
<h2 id="checks-heading">The fourteen checks</h2>
<p class="lede">Each result is one of three states. <strong>Pass</strong>: the expected text is on the page, with the line that carries it. <strong>Missing</strong>: no matching evidence is stated, or the draft says the check was not done. <strong>Flagged</strong>: a line was found that a triager closes on, quoted so you can fix it.</p>
</div>
${checkTable}
</section>

<section class="section section--tight wrap" aria-labelledby="phrases-heading">
<div class="split">
<div class="tool-copy">
<h2 id="phrases-heading">Seven phrases that close a report</h2>
<p>Each one concedes a point before the triager has to make it. The check quotes the sentence so you can prove the condition or cut the claim.</p>
${phraseList}
</div>
<div class="tool-copy">
<h2>What a report that lands contains</h2>
<ul class="ticks">
<li>${icon('check')}<span>An executed proof with its command and output, and a control case.</span></li>
<li>${icon('check')}<span>A final assertion on the object the impact row names: a balance, an owner, a stored record.</span></li>
<li>${icon('check')}<span>The exact code location on a pinned revision, and a concrete fix.</span></li>
<li>${icon('check')}<span>A title that states mechanism and consequence in one sentence.</span></li>
<li>${icon('check')}<span>Numbered attack steps, kept separate from test code.</span></li>
<li>${icon('check')}<span>The impact row quoted verbatim.</span></li>
<li>${icon('check')}<span>Limits and non-claims stated by the author, and the nearest known issue compared by root cause and whether the same fix applies.</span></li>
</ul>
<p>Twelve checks, distilled from 105 real case files across five platforms. The wins and the closures. For a blank page, start from a <a class="link" href="/templates">report template</a> or the <a class="link" href="/guide">report guide</a>.</p>
</div>
</div>
</section>

<section class="section section--tight wrap wrap--narrow" aria-labelledby="questions">
<h2 id="questions">Questions</h2>
${faq(QUESTIONS, { className: 'tool-faq' })}
</section>

${nextAction({
  title: 'The text is in order. Now test the claim.',
  text: 'In the workbench your own model splits the draft into claims and marks each one confirmed, overstated, contradicted or unverifiable, with the line that decides it.',
  primary: { label: 'Challenge a draft report', href: '/?profile=report#workspace' },
  secondary: { label: 'How the challenge works', href: '/challenge-report' },
})}

${relatedTools(PATH)}`;

export default {
  path: PATH,
  title: 'Bug bounty report check: 14 instant checks on a draft | Bounty Operator',
  description: 'Paste a draft bug bounty report and get 14 instant checks: pinned commit, quoted impact row, inline proof, trusted roles, leftover secrets. Runs in the browser.',
  nav: 'tools',
  label: 'Report check',
  order: 1,
  styles: TOOL_STYLES,
  scripts: ['/tools/report-check.mjs'],
  jsonld: [toolCrumbsLd(PATH), faqPageLd(QUESTIONS)],
  lastmod: LASTMOD,
  body,
};
