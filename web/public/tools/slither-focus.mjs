// /tools/slither-focus: parses Slither JSON in this tab, keeps the curated
// detectors, ranks them and shows the queue as Markdown. The first queue is
// counted by name (ping.mjs): nothing of the scan is sent.

import { DEFAULT_CHECKS, MAX_INPUT_BYTES, parseSlither, triageQueue, workbenchHandoff } from './slither-focus-core.mjs';
import { byId, chip, clear, downloadText, el, formatBytes, isPlainClick, notice, sendToWorkbench, wireDrop } from './dom.mjs';
import { ping } from './ping.mjs';

// One file in a review is at most 120 KB (LIMITS.fileBytes in review-core.mjs).
const WORKBENCH_FILE_BYTES = 120_000;

const IMPACT_TONES = { high: 'danger', medium: 'unproven', low: 'observed' };

const noticeBox = byId('slither-notice');
const resultBox = byId('slither-result');
const summary = byId('slither-summary');
const tableBox = byId('slither-table');
const output = resultBox.querySelector('.tool-output code');
const limitInput = /** @type {HTMLInputElement} */ (byId('slither-limit'));
const pasteInput = /** @type {HTMLTextAreaElement} */ (byId('slither-paste'));
const handoffLink = byId('slither-handoff');

/** @type {{ data: object | null, name: string, queue: ReturnType<typeof triageQueue> | null }} */
const state = { data: null, name: '', queue: null };

// A hand-written sample in Slither's JSON shape: five results, four of them in the curated set.
const EXAMPLE = {
  success: true,
  error: null,
  results: {
    detectors: [
      {
        check: 'unused-return',
        impact: 'Medium',
        confidence: 'Medium',
        description: 'TidalStaking.recoverToken(address,uint256) (src/TidalStaking.sol#158-163) ignores return value by IERC20(token).transfer(owner,amount) (src/TidalStaking.sol#161)\n',
        elements: [
          { type: 'function', name: 'recoverToken', source_mapping: { filename_relative: 'src/TidalStaking.sol', lines: [158, 159, 160, 161, 162, 163] } },
          { type: 'node', name: 'IERC20(token).transfer(owner,amount)', source_mapping: { filename_relative: 'src/TidalStaking.sol', lines: [161] } },
        ],
      },
      {
        check: 'naming-convention',
        impact: 'Informational',
        confidence: 'High',
        description: 'Parameter TidalStaking.stake(uint256)._amount (src/TidalStaking.sol#93) is not in mixedCase\n',
        elements: [{ type: 'variable', name: '_amount', source_mapping: { filename_relative: 'src/TidalStaking.sol', lines: [93] } }],
      },
      {
        check: 'reentrancy-eth',
        impact: 'High',
        confidence: 'Medium',
        description: 'Reentrancy in TidalStaking.claim() (src/TidalStaking.sol#119-125):\n\tExternal calls:\n\t- _sendEth(msg.sender,reward) (src/TidalStaking.sol#122)\n\tState variables written after the call(s):\n\t- rewards[msg.sender] = 0 (src/TidalStaking.sol#123)\n',
        elements: [
          { type: 'function', name: 'claim', source_mapping: { filename_relative: 'src/TidalStaking.sol', lines: [119, 120, 121, 122, 123, 124, 125] } },
          { type: 'node', name: '_sendEth(msg.sender,reward)', source_mapping: { filename_relative: 'src/TidalStaking.sol', lines: [122] } },
          { type: 'node', name: 'rewards[msg.sender] = 0', source_mapping: { filename_relative: 'src/TidalStaking.sol', lines: [123] } },
        ],
      },
      {
        check: 'low-level-calls',
        impact: 'Informational',
        confidence: 'High',
        description: 'Low level call in TidalStaking._sendEth(address,uint256) (src/TidalStaking.sol#170-173):\n\t- (ok) = to.call{value: amount}() (src/TidalStaking.sol#171)\n',
        elements: [{ type: 'function', name: '_sendEth', source_mapping: { filename_relative: 'src/TidalStaking.sol', lines: [170, 171, 172, 173] } }],
      },
      {
        check: 'incorrect-equality',
        impact: 'Medium',
        confidence: 'High',
        description: 'TidalStaking.rewardPerToken() (src/TidalStaking.sol#81-85) uses a dangerous strict equality:\n\t- totalStaked == 0 (src/TidalStaking.sol#82)\n',
        elements: [
          { type: 'function', name: 'rewardPerToken', source_mapping: { filename_relative: 'src/TidalStaking.sol', lines: [81, 82, 83, 84, 85] } },
          { type: 'node', name: 'totalStaked == 0', source_mapping: { filename_relative: 'src/TidalStaking.sol', lines: [82] } },
        ],
      },
    ],
  },
};

function showError(title, body) {
  state.data = null;
  state.queue = null;
  resultBox.hidden = true;
  noticeBox.replaceChildren(notice('error', title, body));
}

function currentLimit() {
  const value = Number.parseInt(limitInput.value, 10);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 50) : 8;
}

const QUEUE_COLUMNS = ['#', 'Detector', 'Impact', 'Confidence', 'Locations', 'First location'];

/** A cell that also carries its column name: base.css shows the name once the rows stack on a phone. */
function labelledCell(column, props, children) {
  return el('td', props, [el('span', { class: 'cell-label', text: QUEUE_COLUMNS[column] }), ...children]);
}

function queueRow(row, index) {
  const tone = IMPACT_TONES[row.impact.toLowerCase()] ?? 'neutral';
  return el('tr', {}, [
    el('td', { class: 'num queue__rank', text: String(index + 1) }),
    el('th', { scope: 'row' }, [el('code', { text: row.check })]),
    labelledCell(2, {}, [chip(row.impact, tone)]),
    labelledCell(3, {}, [row.confidence]),
    labelledCell(4, { class: 'num' }, [String(row.locations)]),
    labelledCell(5, { class: 'mono' }, [row.first || 'none']),
  ]);
}

function render() {
  if (!state.data) {
    resultBox.hidden = true;
    return;
  }
  const queue = triageQueue(state.data, { limit: currentLimit() });
  state.queue = queue;
  resultBox.hidden = false;
  ping('tool_slither_focus');

  summary.dataset.state = queue.kept ? 'note' : 'ok';
  summary.replaceChildren(
    el('p', {
      class: 'tool-summary__line',
      text: queue.kept
        ? `${queue.kept} of ${queue.total} detector results kept.`
        : queue.total
          ? `None of the ${queue.total} detector results is in the curated set.`
          : 'The scan ran and reported no detector results.',
    }),
    el('p', { class: 'tool-summary__meta', text: `${state.name} · ${DEFAULT_CHECKS.length} detectors · ranked by impact, then confidence` }),
  );

  if (queue.rows.length) {
    const head = QUEUE_COLUMNS;
    const table = el('table', { class: 'table table--dense tool-table stack-table' }, [
      el('caption', { class: 'visually-hidden', text: 'Ranked detector results' }),
      el('thead', {}, [el('tr', {}, head.map((label, index) => el('th', { scope: 'col', class: index === 0 || index === 4 ? 'num' : null, text: label })))]),
      el('tbody', {}, queue.rows.map(queueRow)),
    ]);
    tableBox.replaceChildren(el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Ranked detector results' }, [table]));
  } else {
    clear(tableBox);
  }

  // One span per line, each ending in a line feed, as the code block component does.
  const lines = queue.markdown.replace(/\n$/, '').split('\n');
  output.replaceChildren(...lines.map((line) => el('span', { class: 'code__line', text: `${line}\n` })));
}

function load(text, name) {
  clear(noticeBox);
  try {
    state.data = parseSlither(text);
    state.name = name;
  } catch (error) {
    showError('This is not usable Slither output.', `${error.message}.`);
    return;
  }
  render();
}

wireDrop(byId('slither-drop'), async ([entry]) => {
  if (entry.file.size > MAX_INPUT_BYTES) {
    showError('The file is too large.', `Slither output up to ${formatBytes(MAX_INPUT_BYTES)} is read. This file is ${formatBytes(entry.file.size)}.`);
    return;
  }
  let text;
  try {
    text = await entry.file.text();
  } catch {
    showError('The file could not be read.', 'Choose the slither.json file again, or paste its contents.');
    return;
  }
  load(text, entry.path);
});

byId('slither-parse').addEventListener('click', () => {
  if (!pasteInput.value.trim()) {
    pasteInput.focus();
    return;
  }
  load(pasteInput.value, 'pasted JSON');
});

byId('slither-example').addEventListener('click', () => {
  clear(noticeBox);
  state.data = EXAMPLE;
  state.name = 'example slither.json';
  render();
});

byId('slither-clear').addEventListener('click', () => {
  state.data = null;
  state.queue = null;
  pasteInput.value = '';
  clear(noticeBox);
  render();
});

limitInput.addEventListener('input', () => {
  if (state.data) render();
});

byId('slither-download').addEventListener('click', () => {
  if (state.queue) downloadText('slither-focus.md', state.queue.markdown);
});

// With a queue on the page the link hands it over; without one it is a plain
// link to the workbench with the scanner profile selected.
handoffLink.addEventListener('click', (event) => {
  if (!state.queue || !isPlainClick(event)) return;
  event.preventDefault();
  const bytes = new TextEncoder().encode(state.queue.markdown).length;
  if (bytes > WORKBENCH_FILE_BYTES) {
    noticeBox.replaceChildren(notice('warn', `The queue is ${formatBytes(bytes)}. One file in a review is at most 120 KB.`, 'Lower “Locations per detector”, or run Slither on fewer contracts, then hand it over.'));
    noticeBox.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (!sendToWorkbench(workbenchHandoff(state.queue.markdown))) {
    noticeBox.replaceChildren(notice('error', 'The queue could not be handed over.', 'This browser blocked session storage. Copy the Markdown, start a review and paste it there.'));
  }
});
