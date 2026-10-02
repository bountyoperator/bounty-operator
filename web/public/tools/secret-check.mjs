// /tools/secret-check: scans dropped or pasted files with the workbench's
// privacy scanner and lists each hit as file:line and kind. The matched text
// is never read back out, so it never reaches the page. The first scan is
// counted by name (ping.mjs): no file name, line or match is sent.

import { scanFiles, scanMarkdown, scanSummary, workbenchHandoff } from './secret-check-core.mjs';
import { byId, chip, clear, copyWithFeedback, el, isPlainClick, notice, readTextFiles, refChip, sendToWorkbench, wireDrop } from './dom.mjs';
import { ping } from './ping.mjs';

const noticeBox = byId('secret-notice');
const resultBox = byId('secret-result');
const summary = byId('secret-summary');
const hits = byId('secret-hits');
const cleanLine = byId('secret-clean');
const skippedLine = byId('secret-skipped');
const copyButton = byId('secret-copy');
const handoffLink = byId('secret-handoff');
const pasteName = /** @type {HTMLInputElement} */ (byId('secret-name'));
const pasteText = /** @type {HTMLTextAreaElement} */ (byId('secret-paste'));

/** @type {{ files: Map<string, { name: string, content: string }>, unread: { name: string, reason: string }[], scan: import('./secret-check-core.mjs').Scan | null }} */
const state = { files: new Map(), unread: [], scan: null };

function hitItem(file, hit) {
  const isBlock = hit.severity === 'block';
  return el('li', { class: 'hit', 'data-severity': hit.severity }, [
    chip(isBlock ? 'Block' : 'Warn', isBlock ? 'danger' : 'unproven'),
    refChip(file.name, hit.line > 0 ? hit.line : null),
    el('span', { class: 'hit__kind', text: hit.label }),
  ]);
}

function render() {
  const scan = state.scan;
  resultBox.hidden = !scan;
  if (!scan) return;

  const { totals } = scan;
  summary.dataset.state = totals.blocking ? 'bad' : totals.warnings ? 'note' : 'ok';
  summary.replaceChildren(
    el('p', { class: 'tool-summary__line', text: scanSummary(scan) }),
    el('p', { class: 'tool-summary__meta', text: `${totals.scanned} scanned · ${totals.blocking} block · ${totals.warnings} warn · ${totals.skipped + state.unread.length} not scanned` }),
  );

  clear(hits);
  for (const file of scan.files) {
    for (const hit of file.hits) hits.append(hitItem(file, hit));
  }

  const clean = scan.files.filter((file) => file.status === 'clean').map((file) => file.name);
  cleanLine.textContent = clean.length ? `Nothing found in: ${clean.join(', ')}` : '';

  const skipped = [
    ...scan.files.filter((file) => file.status === 'skipped').map((file) => `${file.name} (${file.reason})`),
    ...state.unread.map((entry) => `${entry.name} (${entry.reason})`),
  ];
  skippedLine.textContent = skipped.length ? `Not scanned: ${skipped.join(', ')}` : '';
}

function rescan() {
  clear(noticeBox);
  const files = [...state.files.values()];
  state.scan = files.length || state.unread.length ? scanFiles(files) : null;
  if (state.scan) ping('tool_secret_check');
  render();
}

async function addFiles(entries) {
  const { files, skipped } = await readTextFiles(entries);
  for (const file of files) state.files.set(file.name, { name: file.name, content: file.content });
  state.unread.push(...skipped);
  rescan();
}

// Secret-shaped example values are assembled here, so this module holds no
// string a scanner would flag. None of them is a real credential.
function exampleFiles() {
  const walletKey = `0x${'5e1d'.repeat(16)}`;
  const providerKey = 'k9'.repeat(16);
  const privateLink = ['https://bugs.immunefi.com', 'dashboard', 'submission', '00000'].join('/');
  const email = ['mallory', 'proton.me'].join('@');
  return [
    {
      name: 'test/Exploit.t.sol',
      content: `contract ExploitTest is Test {\n    function setUp() public {\n        vm.createSelectFork("https://eth-mainnet.g.alchemy.com/v2/${providerKey}", 19_000_000);\n    }\n\n    function test_drain() public {\n        vm.prank(mallory);\n        staking.claim();\n        assertEq(mallory.balance, 5.99 ether);\n    }\n}\n`,
    },
    {
      name: 'script/Run.s.sol',
      content: `contract Run is Script {\n    function run() external {\n        uint256 deployerPrivateKey = ${walletKey};\n        vm.startBroadcast(deployerPrivateKey);\n    }\n}\n`,
    },
    { name: '.env', content: 'ETH_RPC_URL=http://127.0.0.1:8545\n' },
    { name: 'README.md', content: `# PoC\n\nReported in ${privateLink}\n\nQuestions: ${email}\n\nRun with \`forge test -vvv\`.\n` },
    { name: 'foundry.toml', content: '[profile.default]\nsrc = "src"\nout = "out"\n' },
  ];
}

wireDrop(byId('secret-drop'), addFiles);

byId('secret-scan').addEventListener('click', () => {
  if (!pasteText.value.trim()) {
    pasteText.focus();
    return;
  }
  const name = pasteName.value.trim() || 'pasted.txt';
  state.files.set(name, { name, content: pasteText.value });
  rescan();
  resultBox.scrollIntoView({ block: 'nearest' });
});

byId('secret-example').addEventListener('click', () => {
  state.files = new Map(exampleFiles().map((file) => [file.name, file]));
  state.unread = [];
  rescan();
});

byId('secret-clear').addEventListener('click', () => {
  state.files = new Map();
  state.unread = [];
  state.scan = null;
  pasteText.value = '';
  clear(noticeBox);
  render();
});

copyButton.addEventListener('click', () => {
  if (state.scan) copyWithFeedback(copyButton, scanMarkdown(state.scan));
});

// A set the workbench accepts is handed over. Anything else follows the plain
// link, which opens the workbench with the proof profile selected.
handoffLink.addEventListener('click', (event) => {
  const files = [...state.files.values()];
  if (!state.scan || !files.length || !isPlainClick(event)) return;
  event.preventDefault();
  const payload = workbenchHandoff(files, state.scan);
  if (!payload) {
    noticeBox.replaceChildren(notice(
      'warn',
      state.scan.totals.blocking ? 'Remove the Block lines first.' : 'This set is larger than one review takes.',
      state.scan.totals.blocking
        ? 'The workbench refuses a file that holds a key, a token or a private link.'
        : 'A review takes up to 50 text files, 120 KB each, 240 KB and 20,000 lines together. Open the workbench and add the files that matter.',
    ));
    noticeBox.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (!sendToWorkbench(payload)) {
    noticeBox.replaceChildren(notice('error', 'The files could not be handed over.', 'This browser blocked session storage. Open the workbench and add the files there.'));
  }
});
