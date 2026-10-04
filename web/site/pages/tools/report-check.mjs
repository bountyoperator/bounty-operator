// /tools/report-check: paste a draft report, get fourteen text checks, and
// check every file:line citation against the files the draft cites.
//
// The check table and the phrase list are rendered from the same definitions
// the browser module runs, so the page can never describe a check it does not do.

import { button, chip, faq, field, html, icon, stackTable, textarea } from '../../components.mjs';
import { faqPageLd } from '../../layout.mjs';
import { CHECKS, PHRASE_NOTES } from '../../../public/tools/report-check-core.mjs';
import { COUNTER_LINE, TOOL_STYLES, dropZone, nextAction, relatedTools, toolCrumbsLd, toolHead, toolPanel } from './_shared.mjs';

const PATH = '/tools/report-check';

const QUESTIONS = [
  {
    q: 'Where does my draft go?',
    a: `Nowhere. The fourteen checks and the citation check are JavaScript that runs in this tab, and the page sends no request with your text or your files. ${COUNTER_LINE} Pressing “Run the full challenge on your model” moves the draft and its files to the workbench through this browser’s session storage. A model sees them only when you start a review there.`,
  },
  {
    q: 'What does 14 of 14 tell me?',
    a: 'That the draft contains the text these checks look for: a commit, a quoted impact row, one severity, an inline proof with its output, and a prior-art reference or search result. The check does not verify comparison quality or duplicate status. The workbench challenge reviews the claims against the evidence you supply.',
  },
  {
    q: 'How does the citation check work?',
    a: 'Attach the files your draft cites. Every citation such as src/Vault.sol:42-48, Vault.sol#L42 or input-1/src/Vault.sol:42 is matched to an attached file, and the cited lines open in place. A citation to a file you did not attach, a line past the end of the file, or a short name that matches two files is listed so you can fix it before a triager finds it. Links to websites are counted, never opened.',
  },
  {
    q: 'What is the evidence packet?',
    a: 'One JSON file with the draft, the attached files and a SHA-256 checksum of each. Open it here later to carry on with the same files; a file that changed since it was saved is refused. It holds your full draft and files, so keep it private.',
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
  className: 'report-check',
  tag: 'Local · 14 checks + citations',
  body: html`
<div class="tool-split">
<div class="tool-split__in">
${field({
    label: 'Draft report',
    for: 'draft',
    control: textarea({
      id: 'draft',
      rows: 16,
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
<h2 class="h3" id="evidence-heading">Attach the files it cites <span class="label__hint">Optional</span></h2>
<p class="fine">Source, test output or logs. Each <code>file:line</code> in the draft is checked against them. Up to 49 text files, 120 KB each, 240 KB with the draft.</p>
${dropZone({ id: 'evidence-drop', title: 'Choose files or drop them here', hint: 'They stay in this tab.', folder: true })}
<details class="disclosure">
<summary>Paste a file instead</summary>
<div class="report-evidence-paste">
${field({ label: 'File name', for: 'evidence-name', control: html`<input class="input mono" id="evidence-name" type="text" placeholder="forge-output.txt" autocomplete="off" spellcheck="false" maxlength="240">` })}
${field({ label: 'Content', for: 'evidence-content', control: textarea({ id: 'evidence-content', rows: 5, mono: true, attrs: { spellcheck: 'false', autocomplete: 'off' } }) })}
${button({ label: 'Add file', id: 'evidence-add', variant: 'secondary', icon: 'plus' })}
</div>
</details>
<ul class="report-attachments" id="evidence-files" aria-label="Attached files"></ul>
<p class="fine" id="evidence-file-count" role="status">No files attached.</p>
<div id="evidence-notice"></div>
<label class="drop__folder report-restore" for="evidence-restore">${icon('file')}<span>Open a saved evidence packet</span><input class="drop__input" type="file" id="evidence-restore" accept=".json,application/json"></label>
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
${button({ label: 'Save evidence packet', id: 'check-save', variant: 'quiet', icon: 'download', disabled: true })}
</div>
<div id="check-notice"></div>
<section class="report-evidence-result" aria-labelledby="evidence-result-heading">
<h3 class="h4" id="evidence-result-heading">Citations</h3>
<p id="evidence-summary" role="status">No file:line citations in the draft yet.</p>
<ul class="report-references" id="evidence-refs" aria-label="Citations in the draft"></ul>
</section>
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
  lede: 'Paste a draft and attach the files it cites. Fourteen checks answer at once: what is on the page, what is missing, which sentence a triager will quote back at you, and which citation points at nothing.',
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
<p>Each one concedes a point before the triager has to make it. The check quotes the sentence so you can prove the condition or cut the claim. Under your own Limits heading they are stated non-claims and are not flagged.</p>
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
<p>The list comes from 105 real case files across five platforms, the paid ones and the closed ones. For a blank page, start from a <a class="link" href="/templates">report template</a> or the <a class="link" href="/guide">report guide</a>.</p>
</div>
</div>
</section>

<section class="section section--tight wrap wrap--narrow" aria-labelledby="questions">
<h2 id="questions">Questions</h2>
${faq(QUESTIONS, { className: 'tool-faq' })}
</section>

${nextAction({
  title: 'The text is in order. Now test the claim.',
  text: 'In the workbench your own model splits the draft into claims and marks each one confirmed, overstated, contradicted or unverifiable, with the line that decides it. The files you attached here go with the draft.',
  primary: { label: 'Challenge a draft report', href: '/?profile=report#workspace' },
  secondary: { label: 'How the challenge works', href: '/challenge-report' },
})}

${relatedTools(PATH)}`;

export default {
  path: PATH,
  title: 'Bug bounty report check: 14 instant checks and a citation check | Bounty Operator',
  description: 'Paste a draft bug bounty report: 14 instant checks (pinned commit, impact row, inline proof, trusted roles, secrets) and a file:line citation check. In-browser.',
  nav: 'tools',
  label: 'Report check',
  order: 1,
  styles: TOOL_STYLES,
  scripts: ['/tools/report-check.mjs'],
  jsonld: [toolCrumbsLd(PATH), faqPageLd(QUESTIONS)],
  lastmod: '2026-10-04',
  body,
};
