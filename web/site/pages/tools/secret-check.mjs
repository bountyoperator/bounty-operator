// /tools/secret-check: scan a PoC or a gist for secrets before it is published.

import { button, chip, disclosure, faq, field, html, input, stackTable, textarea } from '../../components.mjs';
import { faqPageLd } from '../../layout.mjs';
import { COUNTER_LINE, LASTMOD, TOOL_STYLES, dropZone, nextAction, relatedTools, toolCrumbsLd, toolHead, toolPanel } from './_shared.mjs';

const PATH = '/tools/secret-check';

const block = () => chip('Block', { tone: 'danger' });
const warn = () => chip('Warn', { tone: 'unproven' });

const QUESTIONS = [
  {
    q: 'Are the files uploaded?',
    a: `No. The scan is JavaScript that runs in this tab. The page makes no request with a file name, a line or a match, and a result lists the kind of secret and its line, never the secret. ${COUNTER_LINE}`,
  },
  {
    q: 'What does a clean result cover?',
    a: 'The key, token and link formats in the table above. A password written in a sentence, or a token in a format of your own, has no pattern to match. Read the diff once before you push.',
  },
  {
    q: 'Is this the same check the workbench runs?',
    a: 'Yes. It is the scanner that runs before every review. A file that shows a Block here is refused there until the line is removed.',
  },
];

const panel = toolPanel({
  id: 'secret-check',
  name: 'secret-check',
  tag: 'Local · no upload',
  body: html`
${dropZone({ id: 'secret-drop', title: 'Drop PoC files or the whole folder', hint: 'Tests, scripts, configs, logs and traces. Folders named .git and node_modules are left out.', folder: true })}
${disclosure({
  summary: 'Paste text instead',
  hint: 'A gist, a trace, a config',
  body: html`<div class="stack">
${field({ label: 'File name', for: 'secret-name', control: input({ id: 'secret-name', value: 'pasted.txt', mono: true, attrs: { autocomplete: 'off', spellcheck: 'false' } }) })}
${field({ label: 'Text', for: 'secret-paste', control: textarea({ id: 'secret-paste', rows: 8, mono: true, attrs: { spellcheck: 'false', autocomplete: 'off' } }) })}
<div class="cluster">${button({ label: 'Scan pasted text', id: 'secret-scan', icon: 'search' })}</div>
</div>`,
})}
<div class="cluster">
${button({ label: 'Load example', id: 'secret-example', variant: 'quiet' })}
${button({ label: 'Clear', id: 'secret-clear', variant: 'quiet' })}
</div>
<div id="secret-notice"></div>
<div class="tool-result" id="secret-result" hidden>
<div class="tool-summary" id="secret-summary" role="status"></div>
<ol class="hits" id="secret-hits" aria-label="Hits"></ol>
<p class="tool-state" id="secret-clean"></p>
<p class="tool-state" id="secret-skipped"></p>
<div class="cluster tool-actions">
${button({ label: 'Review this proof in the workbench', href: '/?profile=poc#workspace', id: 'secret-handoff', variant: 'primary', iconEnd: 'arrow-right' })}
${button({ label: 'Copy result as Markdown', id: 'secret-copy', icon: 'copy' })}
</div>
</div>`,
});

const kinds = stackTable({
  caption: 'What the scan reports',
  columns: [{ label: 'Kind' }, { label: 'Level' }, { label: 'What it matches' }],
  rows: [
    ['Wallet private key', block(), html`A 64-digit hex value next to a key label, or passed to <code>new Wallet(…)</code>, <code>vm.startBroadcast(…)</code> or an <code>accounts</code> list.`],
    ['Wallet seed phrase', block(), 'Twelve to twenty-four lowercase words next to “mnemonic” or “seed phrase”, or alone on a line.'],
    ['Private key block', block(), html`A PEM header: <code>BEGIN … PRIVATE KEY</code>.`],
    ['RPC URL with an API key', block(), 'Alchemy, Infura and QuickNode endpoints that carry the key in the path.'],
    ['API key or token', block(), 'Model-provider and payment keys, GitHub and Slack tokens, AWS and Google keys, npm tokens, webhook signing secrets, JSON web tokens.'],
    ['URL with a username and password', block(), html`<code>https://user:password@host</code>`],
    ['Link to a private platform report', block(), 'A dashboard link to your own submission on Immunefi, Cantina or Sherlock.'],
    ['File that normally holds credentials', block(), html`By name: <code>.env</code>, <code>id_rsa</code>, <code>wallet.dat</code>, <code>.pem</code>, <code>.har</code>, cookie and keystore files, anything under <code>.ssh</code> or <code>.aws</code>.`],
    ['Email address', warn(), 'A personal address. Placeholder and no-reply addresses are skipped.'],
    ['Public IP address', warn(), 'A routable IPv4 address. Loopback, private and documentation ranges are skipped.'],
  ],
  className: 'tool-table',
  plain: true,
});

const body = html`
<section class="section section--tight wrap">
${toolHead({
  path: PATH,
  lede: 'A public PoC is read by everyone, the fork URL in line 12 included. Drop the files and get every key, token and private link as a file and a line.',
})}
${panel}
</section>

<section class="section section--tight wrap" aria-labelledby="levels">
<div class="split">
<div class="tool-copy">
<h2 id="levels">Block and warn</h2>
<p>${block()} is key material, a credential file or a link that only you can open. Take the line out before the file leaves your machine, and rotate the key if it was ever pushed. The workbench refuses a review that contains one.</p>
<p>${warn()} is an email address or a public IP address. Some belong in a proof: a contact line, a public RPC host. Read each one and decide.</p>
<p>The result names the kind and the line. It never prints the match.</p>
</div>
<div class="tool-copy">
<h2>Where secrets hide in a PoC</h2>
<ul class="ticks ticks--plain">
<li><span class="meta">01</span><span><code>vm.createSelectFork</code> and <code>--fork-url</code> lines with the provider key in the URL.</span></li>
<li><span class="meta">02</span><span><code>foundry.toml</code> RPC endpoints and the <code>accounts</code> list in <code>hardhat.config</code>.</span></li>
<li><span class="meta">03</span><span>A <code>.env</code> committed next to the test.</span></li>
<li><span class="meta">04</span><span>Terminal output pasted into the README, with the RPC URL it ran against.</span></li>
<li><span class="meta">05</span><span>A link back to your own report on the platform dashboard.</span></li>
</ul>
</div>
</div>
</section>

<section class="section section--tight wrap" aria-labelledby="kinds">
<h2 id="kinds" class="visually-hidden">Kinds</h2>
${kinds}
<p class="tool-table__foot">Left alone on purpose: the ten default Anvil and Hardhat keys and their <code>test … junk</code> mnemonic, which are public; transaction hashes, storage slots and <code>bytes32</code> constants; version strings that look like IP addresses.</p>
</section>

<section class="section section--tight wrap wrap--narrow" aria-labelledby="questions">
<h2 id="questions">Questions</h2>
${faq(QUESTIONS, { className: 'tool-faq' })}
</section>

${nextAction({
  title: 'Clean files. Next, the proof itself.',
  text: 'A proof review reads the test as the triager who will run it once: real path or mock, concrete values, and the assertion that proves the impact.',
  primary: { label: 'Run a proof review', href: '/?profile=poc#workspace' },
  secondary: { label: 'Check the report draft', href: '/tools/report-check' },
})}

${relatedTools(PATH)}`;

export default {
  path: PATH,
  title: 'Check a PoC or gist for secrets before you publish | Bounty Operator',
  description: 'Drop a PoC folder or paste a gist and get every private key, API token, seed phrase and private report link as file:line. Runs in your browser.',
  nav: 'tools',
  label: 'Secret check',
  order: 3,
  styles: TOOL_STYLES,
  scripts: ['/tools/secret-check.mjs'],
  jsonld: [toolCrumbsLd(PATH), faqPageLd(QUESTIONS)],
  lastmod: LASTMOD,
  body,
};
