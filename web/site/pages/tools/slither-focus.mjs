// /tools/slither-focus: Slither JSON in, a ranked Markdown triage queue out.

import { button, codeBlock, disclosure, faq, field, html, inline, input, stackTable, textarea } from '../../components.mjs';
import { faqPageLd } from '../../layout.mjs';
import { DEFAULT_CHECKS } from '../../../public/tools/slither-focus-core.mjs';
import { COUNTER_LINE, LASTMOD, TOOL_STYLES, dropZone, nextAction, relatedTools, toolCrumbsLd, toolHead, toolPanel } from './_shared.mjs';

const PATH = '/tools/slither-focus';

// Why each curated detector is worth a manual read.
const REASONS = {
  'arbitrary-send-erc20': '`transferFrom` with a `from` the caller chooses. Any approval given to the contract is spendable.',
  'arbitrary-send-eth': 'ETH sent to an address the caller controls.',
  'calls-loop': 'External calls inside a loop. One reverting callee blocks the whole batch.',
  'controlled-delegatecall': '`delegatecall` to a target the caller controls.',
  'delegatecall-loop': '`delegatecall` in a loop inside a payable function. `msg.value` is counted on every pass.',
  'incorrect-equality': 'Strict equality on a balance or a supply that anyone can move with a transfer.',
  'low-level-calls': '`call`, `delegatecall` and `staticcall` sites. Each needs its target and its success check read.',
  'reentrancy-benign': 'State written after an external call, where re-entering repeats the call.',
  'reentrancy-eth': 'State written after an external call that sends ETH.',
  'reentrancy-no-eth': 'State written after an external call, with no ETH sent.',
  'unchecked-transfer': 'ERC-20 `transfer` or `transferFrom` whose return value is ignored.',
  'uninitialized-local': 'A local variable read before it is assigned.',
  'unused-return': 'The return value of an external call is dropped.',
};

const missing = DEFAULT_CHECKS.filter((check) => !REASONS[check]);
if (missing.length || Object.keys(REASONS).length !== DEFAULT_CHECKS.length) {
  throw new Error(`slither-focus page: the detector table is out of step with DEFAULT_CHECKS (${missing.join(', ')})`);
}

const QUESTIONS = [
  {
    q: 'Is the Slither output uploaded?',
    a: `No. The file is parsed and filtered in this tab. ${COUNTER_LINE} Pressing “Triage this in the workbench” moves the queue to the workbench through this browser’s session storage. It leaves the browser only when you run a review there: through our server to the provider you chose.`,
  },
  {
    q: 'Why these 13 detectors?',
    a: 'Slither reports naming, style and gas detectors next to the ones that move funds. These 13 are the classes where a hit is worth reading line by line on a bounty target: value sent to a caller-chosen address, state written after an external call, ignored return values, controlled `delegatecall`.',
  },
  {
    q: 'What does the tool decide?',
    a: 'Nothing about validity. It filters, ranks and formats. A detector hit is a lead: the scanner triage profile in the workbench groups the leads by root cause and gives each one a next check.',
  },
];

const panel = toolPanel({
  id: 'slither-focus',
  name: 'slither-focus',
  tag: `Local · ${DEFAULT_CHECKS.length} detectors`,
  body: html`
${dropZone({ id: 'slither-drop', title: 'Drop slither.json', hint: 'The file written by: slither . --json slither.json', multiple: false, accept: '.json,application/json' })}
${disclosure({
  summary: 'Paste JSON instead',
  body: html`<div class="stack">
${field({ label: 'Slither JSON', for: 'slither-paste', control: textarea({ id: 'slither-paste', rows: 8, mono: true, attrs: { spellcheck: 'false', autocomplete: 'off' } }) })}
<div class="cluster">${button({ label: 'Build queue', id: 'slither-parse', icon: 'play' })}</div>
</div>`,
})}
<div class="tool-options">
${field({
  label: 'Locations per detector',
  for: 'slither-limit',
  control: input({ id: 'slither-limit', type: 'number', value: '8', className: 'tool-number', attrs: { min: '1', max: '50', step: '1', inputmode: 'numeric' } }),
  help: 'Each location lists up to four line numbers.',
})}
<div class="cluster">
${button({ label: 'Load example', id: 'slither-example', variant: 'quiet' })}
${button({ label: 'Clear', id: 'slither-clear', variant: 'quiet' })}
</div>
</div>
<div id="slither-notice"></div>
<div class="tool-result" id="slither-result" hidden>
<div class="tool-summary" id="slither-summary" role="status"></div>
<div id="slither-table"></div>
${codeBlock({ code: '', name: 'slither-focus.md', numbers: false, copy: true, wrap: true, label: 'Triage queue as Markdown', className: 'tool-output' })}
<div class="cluster tool-actions">
${button({ label: 'Triage this in the workbench', href: '/?profile=scanner#workspace', id: 'slither-handoff', variant: 'primary', iconEnd: 'arrow-right' })}
${button({ label: 'Download .md', id: 'slither-download', icon: 'download' })}
</div>
</div>`,
});

const detectorTable = stackTable({
  caption: `The ${DEFAULT_CHECKS.length} detectors kept`,
  columns: [{ label: 'Detector' }, { label: 'Why it gets a manual pass' }],
  rows: DEFAULT_CHECKS.map((check) => [html`<code>${check}</code>`, html`${inline(REASONS[check])}`]),
  className: 'tool-table',
  plain: true,
});

const body = html`
<section class="section section--tight wrap">
${toolHead({
  path: PATH,
  lede: `Slither prints every detector it has, naming and style included. Drop the JSON and get the ${DEFAULT_CHECKS.length} detectors worth a manual pass, ranked by impact and confidence, with file and line.`,
})}
${panel}
</section>

<section class="section section--tight wrap" aria-labelledby="make">
<div class="split">
<div class="tool-copy">
<h2 id="make">Make the input</h2>
<p>Run Slither with JSON output from the project root. The file holds every detector result with its impact, its confidence and the source lines of each element.</p>
${codeBlock({ code: 'slither . --json slither.json', name: 'shell', numbers: false, copy: true, label: 'Slither command' })}
<p>The same filter ships in the open-source kit, for a terminal or a CI step:</p>
${codeBlock({ code: 'bounty-kit slither-focus slither.json --markdown --limit 8', name: 'shell', numbers: false, copy: true, label: 'Kit command' })}
</div>
<div class="tool-copy">
<h2>What the queue holds</h2>
<p>One section per detector result, highest impact first, then highest confidence. Each section has Slither’s description and a table of locations: file, up to four line numbers, and the function or node name.</p>
<p>A failed run is refused. When compilation fails, Slither writes <code>"success": false</code> and no results; the tool stops there and says so. An empty queue always means the 13 detectors found nothing.</p>
<p>The Markdown is plain: paste it into an issue, a notes file or a chat with your model.</p>
</div>
</div>
</section>

<section class="section section--tight wrap" aria-labelledby="detectors">
<h2 id="detectors" class="visually-hidden">Detectors</h2>
${detectorTable}
</section>

<section class="section section--tight wrap wrap--narrow" aria-labelledby="questions">
<h2 id="questions">Questions</h2>
${faq(QUESTIONS, { className: 'tool-faq' })}
</section>

${nextAction({
  title: 'A queue is a list of leads',
  text: 'Scanner triage groups the leads by root cause, ranks them by what each could cost, and gives every queued lead one next check.',
  primary: { label: 'Open scanner triage', href: '/?profile=scanner#workspace' },
  secondary: { label: 'Solidity review', href: '/solidity-review' },
})}

${relatedTools(PATH)}`;

export default {
  path: PATH,
  title: `Slither triage queue: ${DEFAULT_CHECKS.length} detectors | Bounty Operator`,
  description: `Drop Slither’s JSON output and get a ranked Markdown queue of the ${DEFAULT_CHECKS.length} detectors worth a manual pass, with file and line. Runs in your browser.`,
  nav: 'tools',
  label: 'Slither triage queue',
  order: 5,
  styles: TOOL_STYLES,
  scripts: ['/tools/slither-focus.mjs'],
  jsonld: [toolCrumbsLd(PATH), faqPageLd(QUESTIONS)],
  lastmod: LASTMOD,
  body,
};
