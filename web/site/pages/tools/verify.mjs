// /tools/verify: recompute the SHA-256 of every file a review packet lists.

import { button, codeBlock, faq, html, stackTable } from '../../components.mjs';
import { faqPageLd } from '../../layout.mjs';
import { COUNTER_LINE, LASTMOD, TOOL_STYLES, dropZone, nextAction, relatedTools, stepsStrip, toolCrumbsLd, toolHead, toolPanel } from './_shared.mjs';

const PATH = '/tools/verify';

const QUESTIONS = [
  {
    q: 'Are my files uploaded?',
    a: `No. The page reads each file with the browser’s file API and hashes it with Web Crypto. It makes no request with a file name, a hash or any content. ${COUNTER_LINE}`,
  },
  {
    q: 'What does a match prove?',
    a: 'That the bytes you hold are the bytes the review was run on, to the last character. It is a statement about the files. Whether the review’s conclusions hold is a separate question, answered by the code and the proof.',
  },
  {
    q: 'Where does a packet come from?',
    a: 'The workbench writes one for every finished review: the verdict, the context you gave, the file list with a SHA-256 per file, and the review itself. A manifest is the same file list as JSON, as returned by the review API and the MCP server.',
  },
];

const panel = toolPanel({
  id: 'verify',
  name: 'verify',
  tag: 'Local · SHA-256',
  body: html`
<div class="tool-pair">
<div class="tool-pair__col">
<h2 class="tool-label"><span class="tool-label__n">1</span>Packet or manifest</h2>
${dropZone({ id: 'verify-manifest', title: 'Drop the packet (.md) or manifest (.json)', hint: 'Or click to choose the file.', multiple: false, accept: '.md,.markdown,.json,.txt' })}
<p class="tool-state" id="manifest-state">No packet loaded.</p>
</div>
<div class="tool-pair__col">
<h2 class="tool-label"><span class="tool-label__n">2</span>Source files</h2>
${dropZone({ id: 'verify-files', title: 'Drop the files or the repository folder', hint: 'Matched by path, then name, then hash.', folder: true })}
<p class="tool-state" id="files-state">No files loaded.</p>
</div>
</div>
<div class="cluster">
${button({ label: 'Load example', id: 'verify-example', variant: 'quiet' })}
${button({ label: 'Clear', id: 'verify-clear', variant: 'quiet' })}
</div>
<div id="verify-notice"></div>
<div class="tool-result" id="verify-result" hidden>
<div class="tool-summary" id="verify-summary" role="status"></div>
<div id="verify-rows"></div>
<p class="tool-state" id="verify-extras"></p>
<div class="cluster">
${button({ label: 'Copy result as Markdown', id: 'verify-copy', icon: 'copy' })}
</div>
</div>`,
});

const results = stackTable({
  caption: 'The four results',
  columns: [{ label: 'Result' }, { label: 'Meaning' }, { label: 'What to do' }],
  rows: [
    ['Match', 'The file hashes to the value in the manifest.', 'Nothing. The review covered this exact file.'],
    [
      'Matches after line-ending normalisation',
      'The content is the same; one side has CRLF line endings and the other LF.',
      'Nothing to fix in the code. Check out with the same line endings if you need the raw hash to agree.',
    ],
    ['Mismatch', 'A file with that name was supplied and its content differs.', 'Check out the commit the review was run on, or run the review again on the current file.'],
    ['Missing', 'No supplied file has that name or that hash.', 'Drop the missing file, or the folder that holds it.'],
  ],
  className: 'tool-table',
});

const body = html`
<section class="section section--tight wrap">
${toolHead({
  path: PATH,
  lede: 'A review packet lists every file it covered with a SHA-256. Drop the packet and the files, and see whether what you hold is what was reviewed.',
})}
${panel}
</section>

<section class="section section--tight wrap" aria-labelledby="how">
<h2 id="how">How the check works</h2>
${stepsStrip([
  { title: 'Read the file list', text: 'Every packet has a Files section: one row per file with its label, byte size, line count and SHA-256. A manifest JSON carries the same rows.' },
  { title: 'Hash the files again', text: 'Each file you drop is read as UTF-8 text and hashed in this tab with Web Crypto, the same way the workbench hashed it.' },
  { title: 'Compare row by row', text: 'Every listed file gets one result. Files you dropped that the packet does not list are named underneath.' },
])}
</section>

<section class="section section--tight wrap" aria-labelledby="results">
<h2 id="results" class="visually-hidden">Results</h2>
${results}
</section>

<section class="section section--tight wrap" aria-labelledby="endings">
<div class="split">
<div class="tool-copy">
<h2 id="endings">Why line endings get their own result</h2>
<p>Git on Windows checks files out with CRLF line endings when <code>core.autocrlf</code> is on. The same commit then hashes to a different value on two machines, and a plain comparison calls it a mismatch.</p>
<p>The verifier hashes each file three ways: as supplied, with CRLF replaced by LF, and with LF replaced by CRLF. A file that only matches after the swap is reported on its own line, with the direction, so a line-ending difference is never mistaken for a changed file.</p>
</div>
<div class="tool-copy">
<h2>Check one hash by hand</h2>
<p>The hash in a packet is a plain SHA-256 of the file. Any tool gives the same value.</p>
${codeBlock({ code: '# Linux\nsha256sum src/Vault.sol\n\n# macOS\nshasum -a 256 src/Vault.sol\n\n# Windows PowerShell\nGet-FileHash -Algorithm SHA256 src\\Vault.sol', name: 'shell', numbers: false, copy: true, label: 'Hash commands' })}
</div>
</div>
</section>

<section class="section section--tight wrap wrap--narrow" aria-labelledby="questions">
<h2 id="questions">Questions</h2>
${faq(QUESTIONS, { className: 'tool-faq' })}
</section>

${nextAction({
  title: 'No packet yet',
  text: 'Run a review in the workbench. The packet it saves carries the verdict, the evidence you gave and the hash of every file, ready to attach to a submission.',
  primary: { label: 'Open the workbench', href: '/#workspace' },
  secondary: { label: 'Connect over MCP', href: '/mcp' },
})}

${relatedTools(PATH)}`;

export default {
  path: PATH,
  title: 'Verify a review packet: SHA-256 check | Bounty Operator',
  description: 'Drop a review packet or manifest with its source files and see match, mismatch or missing for every SHA-256. The hashing runs in your browser.',
  nav: 'tools',
  label: 'Packet verifier',
  order: 2,
  styles: TOOL_STYLES,
  scripts: ['/tools/verify.mjs'],
  jsonld: [toolCrumbsLd(PATH), faqPageLd(QUESTIONS)],
  lastmod: LASTMOD,
  body,
};
