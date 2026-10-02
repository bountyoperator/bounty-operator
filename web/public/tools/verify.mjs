// /tools/verify: reads a packet or manifest and the source files, hashes the
// files in this tab and shows one result per listed file. The first
// verification is counted by name (ping.mjs): no file name and no hash is sent.

import { manifestFor } from '../review-core.mjs';
import { reviewPacket } from '../evidence.mjs';
import { STATUS_LABELS, readManifest, summaryLine, verificationMarkdown, verifyFiles } from './verify-core.mjs';
import { byId, chip, clear, copyWithFeedback, el, hashText, notice, readTextFiles, wireDrop } from './dom.mjs';
import { ping } from './ping.mjs';

const CHIPS = {
  match: ['Match', 'ok', false],
  normalised: ['Line endings', 'observed', false],
  mismatch: ['Mismatch', 'danger', false],
  missing: ['Missing', 'unproven', true],
};

const manifestState = byId('manifest-state');
const filesState = byId('files-state');
const noticeBox = byId('verify-notice');
const resultBox = byId('verify-result');
const summary = byId('verify-summary');
const tableBox = byId('verify-rows');
const extras = byId('verify-extras');
const copyButton = byId('verify-copy');

/** @type {{ source: import('./verify-core.mjs').ManifestSource | null, sourceName: string, files: Map<string, { name: string, content: string, bom: boolean }>, verification: import('./verify-core.mjs').Verification | null }} */
const state = { source: null, sourceName: '', files: new Map(), verification: null };

function showNotice(tone, title, body) {
  noticeBox.replaceChildren(notice(tone, title, body));
}

function describeSource() {
  if (!state.source) {
    manifestState.textContent = 'No packet loaded.';
    return;
  }
  const { entries, details, kind } = state.source;
  const parts = [`${state.sourceName}: ${entries.length} ${entries.length === 1 ? 'file' : 'files'} listed`];
  if (kind === 'packet' && details.created) parts.push(`created ${details.created}`);
  if (details.verdict) parts.push(`verdict ${details.verdict}`);
  manifestState.textContent = `${parts.join(' · ')}.`;
}

function describeFiles(skipped = []) {
  const count = state.files.size;
  const text = count ? `${count} ${count === 1 ? 'file' : 'files'} loaded.` : 'No files loaded.';
  filesState.textContent = skipped.length ? `${text} Not read: ${skipped.map((entry) => `${entry.name} (${entry.reason})`).join(', ')}` : text;
}

function hashLine(label, sha256) {
  return el('p', { class: 'vrow__hash' }, [el('span', { class: 'vrow__key', text: label }), hashText(sha256)]);
}

function resultRow(row) {
  const [label, tone, dashed] = CHIPS[row.status];
  const body = el('div', { class: 'vrow__body' }, [hashLine('Manifest', row.expected)]);
  if (row.actual && row.actual !== row.expected) body.append(hashLine('Supplied', row.actual));
  if (row.note) body.append(el('p', { class: 'vrow__note', text: row.note }));
  return el('li', { class: 'vrow', 'data-status': row.status }, [
    el('div', { class: 'vrow__head' }, [
      chip(label, tone, { dashed }),
      el('span', { class: 'visually-hidden', text: `${STATUS_LABELS[row.status]}: ` }),
      el('span', { class: 'tool-file', text: row.label }),
    ]),
    body,
  ]);
}

function renderResult() {
  const verification = state.verification;
  resultBox.hidden = !verification;
  if (!verification) return;

  const { counts, total } = verification;
  const stateName = counts.mismatch || counts.missing ? 'bad' : counts.normalised ? 'note' : 'ok';
  summary.dataset.state = stateName;
  summary.replaceChildren(
    el('p', { class: 'tool-summary__line', text: summaryLine(verification) }),
    el('p', { class: 'tool-summary__meta', text: `${total} listed · ${counts.match} match · ${counts.normalised} line endings · ${counts.mismatch} mismatch · ${counts.missing} missing` }),
  );

  tableBox.replaceChildren(el('ol', { class: 'vrows', 'aria-label': 'Result per file' }, verification.rows.map(resultRow)));

  extras.textContent = verification.extras.length
    ? `Supplied and not listed in the manifest: ${verification.extras.join(', ')}`
    : '';
}

async function recompute() {
  clear(noticeBox);
  state.verification = state.source && state.files.size
    ? await verifyFiles(state.source.entries, [...state.files.values()])
    : null;
  if (state.verification) ping('tool_verify');
  renderResult();
}

/** Takes dropped files: the first one that reads as a manifest fills step 1 when it is empty. */
async function addFiles(entries, { expectManifest }) {
  const { files, skipped } = await readTextFiles(entries);
  let sources = files;

  if (expectManifest || !state.source) {
    const index = files.findIndex((file) => readManifest(file.content));
    if (index !== -1) {
      state.source = readManifest(files[index].content);
      state.sourceName = files[index].name;
      sources = files.filter((_, position) => position !== index);
    } else if (expectManifest) {
      showNotice('error', 'No file hashes found in that file.', 'Use a packet saved from the workbench, or a manifest JSON with label and sha256 fields.');
      return;
    }
  }
  // In step 1 only the packet is taken; anything else dropped with it is a source file.
  for (const file of sources) state.files.set(file.name, file);
  describeSource();
  describeFiles(skipped);
  await recompute();
}

// The example builds a real packet from three files, then supplies one of them
// unchanged, one with CRLF line endings and one edited, and leaves one out.
async function loadExample() {
  const original = [
    { name: 'src/TidalStaking.sol', content: 'contract TidalStaking {\n    mapping(address => uint256) public balanceOf;\n\n    function stake(uint256 amount) external {\n        balanceOf[msg.sender] += amount;\n    }\n}\n' },
    { name: 'test/TidalStaking.t.sol', content: 'function test_freshStakerEarnsNothingAtStake() public {\n    vm.prank(mallory);\n    staking.stake(200e18);\n    assertEq(staking.earned(mallory), 0);\n}\n' },
    { name: 'script/Deploy.s.sol', content: 'contract Deploy {\n    function run() external {}\n}\n' },
    { name: 'notes/scope.md', content: '# Scope\n\nAsset: src/TidalStaking.sol\n' },
  ];
  const manifest = await manifestFor(original);
  const packet = reviewPacket({
    review: '# Review\nVerdict: prove-first\nMode: bounty\nCounts: critical=0 high=1 medium=0 hardening=0 checked-safe=0\nHeadline: The checkpoint is skipped for a first stake; the proof has not been run.\n',
    manifest,
    context: { target: 'TidalStaking (example)', version: 'example-v1' },
    source: 'example',
    profileId: 'solidity',
    timestamp: '2026-10-02T09:00:00.000Z',
    parsed: { ok: true, verdict: 'prove-first', mode: 'bounty', headline: 'The checkpoint is skipped for a first stake; the proof has not been run.' },
  });

  state.source = readManifest(packet);
  state.sourceName = 'example-packet.md';
  state.files = new Map([
    original[0],
    { ...original[1], content: original[1].content.replace(/\n/g, '\r\n') },
    { ...original[2], content: original[2].content.replace('external', 'public') },
  ].map((file) => [file.name, { ...file, bom: false }]));
  describeSource();
  describeFiles();
  await recompute();
}

wireDrop(byId('verify-manifest'), (entries) => addFiles(entries, { expectManifest: true }));
wireDrop(byId('verify-files'), (entries) => addFiles(entries, { expectManifest: false }));

byId('verify-example').addEventListener('click', loadExample);

byId('verify-clear').addEventListener('click', () => {
  state.source = null;
  state.sourceName = '';
  state.files = new Map();
  state.verification = null;
  clear(noticeBox);
  describeSource();
  describeFiles();
  renderResult();
});

copyButton.addEventListener('click', () => {
  if (state.verification) copyWithFeedback(copyButton, verificationMarkdown(state.verification));
});
