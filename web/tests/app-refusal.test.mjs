// A review the provider blocked, in every place the app shows one: the result
// view, the status line of a run, the gauntlet, the panel, the history list
// and a pasted reply. Everything here runs the modules; nothing reads their
// source. No provider, browser or network is needed.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { ANTHROPIC_CYBER_NOTICE } from '../public/providers.mjs';
import { ApiError } from '../public/app/api.mjs';
import { BLOCKS, REFUSES_GUIDE, blockOf, blockedCopy, pastedBlock } from '../public/app/blocked.mjs';
import { agreementOf, agreementSection, panelBody, seatRecord, stageStrip } from '../public/app/dossier.mjs';
import { declinedStop, stageEnd, stageNames, stopState } from '../public/app/gauntlet.mjs';
import { historyRecord, outcomeMark, resultFrom } from '../public/app/history.mjs';
import { failureLine } from '../public/app/panel.mjs';
import { pastedLine, pastedResult } from '../public/app/pasteback.mjs';
import { analyse, initResults } from '../public/app/results.mjs';
import { failureFor, finishedLine } from '../public/app/run.mjs';
import { initialState, snapshot, workbench } from '../public/app/state.mjs';

const TITLES = {
  'anthropic-cyber': "Anthropic's cyber safeguards blocked this review",
  'openai-cyber': "OpenAI's cyber safeguards blocked this review",
  policy: 'The provider blocked this review under its usage policy',
};
const BODY = 'It did not count against your allowance. Run it again on another model or provider: your files and draft go through unchanged.';
const REVIEW = '# Review\nVerdict: no-blocking-issues\nMode: own-code\nCounts: critical=0 high=0 medium=0 hardening=0 checked-safe=0\nHeadline: Nothing blocks.\n';

const RESULT = {
  review: ANTHROPIC_CYBER_NOTICE,
  manifest: [],
  profile: { id: 'general', name: 'Code security review' },
  provider: 'anthropic',
  model: 'claude-test',
  source: 'ai',
  refused: true,
  truncated: false,
  blocked: 'anthropic-cyber',
};

const policyError = (data = {}) => new ApiError('Provider blocked this request.', { code: 'provider_policy', status: 502, data: { kind: 'policy', ...data } });

// ---------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------

describe('blocked.mjs', () => {
  test('the three blocks, their titles, the next step and the guide link are fixed copy', () => {
    assert.deepEqual([...BLOCKS], ['anthropic-cyber', 'openai-cyber', 'policy']);
    assert.deepEqual({ ...REFUSES_GUIDE }, { label: 'When the model refuses', href: '/guide#model-refuses' });
    for (const block of BLOCKS) {
      const copy = blockedCopy(block);
      assert.deepEqual(copy, {
        block,
        title: TITLES[block],
        body: BODY,
        said: '',
        line: `${TITLES[block]}. It did not count against your allowance.`,
        link: REFUSES_GUIDE,
      });
      // The same words from a result that carries the block.
      assert.deepEqual(blockedCopy({ ...RESULT, blocked: block }), copy);
    }
  });

  test('a provider_policy error is a block: it names the one the server named, or the general one', () => {
    assert.equal(blockOf(policyError({ blocked: 'openai-cyber' })), 'openai-cyber');
    assert.equal(blockOf(policyError({ blocked: 'anthropic-cyber' })), 'anthropic-cyber');
    assert.equal(blockOf(policyError()), 'policy');
    assert.equal(blockOf(policyError({ blocked: 'something-new' })), 'policy', 'an id this build does not know reads as the general block');
    const worded = blockedCopy(policyError({ blocked: 'openai-cyber', detail: `  This request was flagged. ${'x'.repeat(400)}` }));
    assert.equal(worded.title, TITLES['openai-cyber']);
    assert.match(worded.said, /^This request was flagged\. x+$/);
    assert.equal(worded.said.length, 300, "the provider's words are bounded");
  });

  test('nothing else is a block', () => {
    const others = [
      undefined, null, '', 'other-provider-reason', 42, true, [],
      { refused: true }, { blocked: undefined }, { blocked: 'other-provider-reason' }, { blocked: { apiKey: 'never-store-this' } },
      new ApiError('Provider rejected the API key (HTTP 403).', { code: 'provider', status: 502, data: { kind: 'auth' } }),
      new ApiError("Today's free review is used.", { code: 'daily_used', status: 429 }),
    ];
    for (const value of others) {
      assert.equal(blockOf(value), '', JSON.stringify(value));
      assert.equal(blockedCopy(value), null);
    }
  });

  test('where the block landed, and what to do there, replaces the general next step', () => {
    const copy = blockedCopy('policy', { context: 'The run stopped at stage 3, Prior art. Pick another model above, then resume.' });
    assert.equal(copy.body, 'It did not count against your allowance. The run stopped at stage 3, Prior art. Pick another model above, then resume.');
    assert.doesNotMatch(copy.body, /Run it again/, 'one instruction, not two');
  });

  test('a reply pasted from a chat app gets the one step that applies there, and no allowance line', () => {
    for (const block of BLOCKS) {
      const copy = blockedCopy({ ...RESULT, source: 'pasted', blocked: block });
      assert.equal(copy.title, TITLES[block]);
      assert.equal(copy.body, 'Paste the same prompt into another model.');
      assert.equal(copy.line, `${TITLES[block]}. Paste the same prompt into another model.`);
      assert.doesNotMatch(`${copy.body} ${copy.line}`, /allowance|Run it again|provider:/, 'a pasted reply never touched the allowance or a provider key');
      assert.deepEqual(copy.link, REFUSES_GUIDE);
    }
    // A hosted answer keeps the hosted words, whatever else it carries.
    assert.equal(blockedCopy({ ...RESULT, source: 'ai' }).body, BODY);
  });
});

// ---------------------------------------------------------------------------
// The result view, drawn into a stand-in document
// ---------------------------------------------------------------------------

// The renderer writes text and builds nodes; this stand-in has no HTML parser.
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.nodeType = 1;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.hidden = false;
  }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener() {}
}

function descendants(node) {
  return node.children.filter((child) => child instanceof Element).flatMap((child) => [child, ...descendants(child)]);
}

describe('the result view', () => {
  const root = new Element('section');
  const screen = { narrow: false };
  let previous;

  before(() => {
    previous = { document: globalThis.document, window: globalThis.window, state: workbench.get() };
    globalThis.document = {
      createElement: (tag) => new Element(tag),
      querySelector: (selector) => selector === '#wb-result' ? root : null,
      querySelectorAll: (selector) => descendants(root).filter((node) =>
        selector === '#wb-result-tabs [role="tab"]' ? node.attributes.role === 'tab'
          : selector === '#wb-result [role="tabpanel"]' && node.attributes.role === 'tabpanel'),
    };
    globalThis.window = {
      addEventListener() {},
      matchMedia: (query) => ({ matches: query === '(max-width: 39.99em)' && screen.narrow, addEventListener() {} }),
    };
    workbench.set({ ...initialState() });
    initResults();
  });

  after(() => {
    workbench.set(previous.state);
    for (const name of ['document', 'window']) {
      if (previous[name] === undefined) delete globalThis[name];
      else globalThis[name] = previous[name];
    }
  });

  const show = (result) => {
    workbench.set({ result });
    return {
      notices: descendants(root).filter((node) => node.className.startsWith('notice ')),
      text: root.textContent,
      raw: descendants(root).filter((node) => node.tagName === 'pre'),
      links: descendants(root).filter((node) => node.tagName === 'a'),
    };
  };

  test('each block shows its own notice: the title, that it was not counted, the next step and a link a keyboard reaches', () => {
    for (const block of BLOCKS) {
      const view = show({ ...RESULT, blocked: block });
      assert.equal(view.notices.length, 1, block);
      const [notice] = view.notices;
      assert.equal(notice.className, 'notice notice--warn');
      assert.equal(notice.dataset.blocked, block);
      assert.equal(notice.textContent, `${TITLES[block]}${BODY}When the model refuses`);
      // The way to the guide is a real link: in the tab order, opened beside the work.
      const link = descendants(notice).find((node) => node.tagName === 'a');
      assert.deepEqual(link.attributes, { href: '/guide#model-refuses', target: '_blank', rel: 'noopener noreferrer' });
      assert.equal(link.textContent, 'When the model refuses');
      assert.equal(link.attributes.tabindex, undefined, 'nothing takes the link out of the tab order');
      assert.doesNotMatch(view.text, /no Verdict line|Review done|The model declined to answer/);
      // The provider's own words stay on the page, as text.
      assert.equal(view.raw.length, 2, 'both the Findings and Raw views keep the reply');
      assert.ok(view.raw.every((node) => node.textContent === ANTHROPIC_CYBER_NOTICE));
      assert.ok(view.raw.every((node) => node.children.every((child) => typeof child === 'string')), 'provider text stays text');
      assert.equal(descendants(root).find((node) => node.attributes.id === 'panel-findings').hidden, false);
    }
  });

  test('the block alone is enough: an older saved result without `refused` reads the same', () => {
    const view = show({ ...RESULT, refused: undefined });
    assert.equal(view.notices.length, 1);
    assert.match(view.notices[0].textContent, /^Anthropic's cyber safeguards blocked this review/);
    assert.doesNotMatch(view.text, /no Verdict line/);
  });

  test('a block after part of an answer keeps that text and still reads as blocked', () => {
    const partial = 'Review text written before the block. '.repeat(80);
    const view = show({ ...RESULT, review: partial, blocked: 'policy' });
    assert.equal(view.notices.length, 1);
    assert.match(view.notices[0].textContent, /^The provider blocked this review under its usage policy/);
    assert.ok(view.raw.every((node) => node.textContent === partial));
  });

  test('a refusal in the model\'s own words promises nothing about the allowance and links nowhere', () => {
    const view = show({ ...RESULT, blocked: undefined, review: 'Review text. '.repeat(200) });
    assert.equal(view.notices.length, 1);
    assert.equal(view.notices[0].textContent, 'The model declined to answer' + 'Its reply is shown as written.');
    assert.doesNotMatch(view.text, /not count|allowance|no Verdict line|blocked this review/);
    assert.equal(view.links.length, 0);
  });

  test('only a review is offered as a stage file for the next one', () => {
    const offersNext = (view) => /Run next/.test(view.text);
    assert.equal(offersNext(show({ ...RESULT, blocked: undefined, refused: false, review: REVIEW })), true, 'a review is offered');
    for (const block of BLOCKS) assert.equal(offersNext(show({ ...RESULT, blocked: block })), false, block);
    assert.equal(offersNext(show({ ...RESULT, blocked: undefined, refused: true })), false, 'a declined answer');
  });

  test('an unknown `blocked` value from storage is ignored, and an ordinary unformatted reply still gets its own notice', () => {
    const unknown = show({ ...RESULT, blocked: 'other-provider-reason' });
    assert.equal(unknown.notices[0].textContent, 'The model declined to answer' + 'Its reply is shown as written.');
    const plain = show({ ...RESULT, blocked: undefined, refused: false });
    assert.match(plain.text, /no Verdict line/);
    assert.doesNotMatch(plain.text, /blocked this review|declined/);
    const review = show({ ...RESULT, blocked: undefined, refused: false, review: REVIEW });
    assert.equal(review.notices.length, 0);
  });

  test('a blocked or declined answer offers nothing to export, on a wide screen and on a narrow one', () => {
    const exports = () => descendants(root).filter((node) => node.attributes.id === 'wb-result-actions' || node.attributes['data-action'] === 'packet');
    const answers = [...BLOCKS.map((block) => ({ ...RESULT, blocked: block })), { ...RESULT, blocked: undefined, refused: true }, { ...RESULT, review: 'Part of a review. '.repeat(120), blocked: 'policy' }];
    for (const narrow of [false, true]) {
      screen.narrow = narrow;
      try {
        for (const answer of answers) {
          const view = show(answer);
          assert.deepEqual(exports(), [], `${answer.blocked ?? 'declined'}, narrow ${narrow}`);
          assert.doesNotMatch(view.text, /Download packet|More exports|Copy as issue/);
          // The reply is still there to read and select.
          assert.equal(view.raw.length, 2);
        }
        // A review on the same screen keeps its exports.
        show({ ...RESULT, blocked: undefined, refused: false, review: REVIEW });
        assert.equal(exports().length, 2, 'the actions row and its packet button');
      } finally {
        screen.narrow = false;
      }
    }
  });

  test('the files of a blocked or declined answer are listed as sent, not as reviewed', () => {
    const manifest = [{ label: 'input-1/src/Vault.sol', bytes: 2048, lines: 60, sha256: 'ab'.repeat(32) }];
    const files = () => descendants(root).find((node) => node.dataset.section === 'files');
    const heading = () => files().children.find((node) => node.tagName === 'h4').textContent;

    for (const answer of [...BLOCKS.map((block) => ({ ...RESULT, manifest, blocked: block })), { ...RESULT, manifest, blocked: undefined, refused: true }, { ...RESULT, manifest, source: 'pasted' }]) {
      const view = show(answer);
      assert.equal(heading(), 'Files sent', answer.blocked ?? 'declined');
      assert.ok(files().textContent.includes('input-1/src/Vault.sol'), 'the list itself is still there');
      assert.doesNotMatch(view.text, /Files reviewed|the verifier/, 'no review, so no packet to check the list against');
    }

    const view = show({ ...RESULT, manifest, blocked: undefined, refused: false, review: REVIEW });
    assert.equal(heading(), 'Files reviewed');
    assert.match(view.text, /Check any file against this list at the verifier/);
  });

  test('every table carries its column names, for the phone layout that reads one block per row', () => {
    const review = `${REVIEW}
## Claims
- C1 | confirmed | input-1/src/Vault.sol:10-12 | stake() never settles.
- A line the model wrote between the rows.
- C2 | contradicted |  | The draft names no location for this one.

## Left for later
- alpha | beta
`;
    const manifest = [
      { label: 'input-1/src/Vault.sol', bytes: 2048, lines: 60, sha256: 'ab'.repeat(32) },
      { label: 'input-2/logo.png', bytes: 512, lines: null, sha256: 'cd'.repeat(32) },
    ];
    show({ ...RESULT, review, manifest, blocked: undefined, refused: false });
    const tables = descendants(root).filter((node) => node.tagName === 'table');
    const rowsOf = (table) => descendants(table).filter((node) => node.tagName === 'tr' && node.children.some((cell) => cell.tagName === 'td'));
    // The column name is the first thing in its cell, ahead of the value.
    const labelOf = (cell) => (cell.children[0] instanceof Element && cell.children[0].className === 'cell-label' ? cell.children[0].textContent : null);
    const labelsIn = (cell) => descendants(cell).filter((node) => node.className === 'cell-label').length;
    const headOf = (table) => descendants(table).filter((node) => node.tagName === 'th' && node.attributes.scope === 'col').map((node) => node.textContent);

    const claims = tables.find((table) => headOf(table)[0] === 'Claim');
    assert.equal(claims.className, 'table table--dense stack-table');
    const [first, note, second] = rowsOf(claims);
    assert.deepEqual(first.children.map((cell) => cell.tagName), ['th', 'td', 'td', 'td'], 'the first cell names the row');
    assert.deepEqual(first.children.slice(1).map(labelOf), headOf(claims).slice(1));
    assert.deepEqual(first.children.map(labelsIn), [0, 1, 1, 1]);
    assert.equal(first.children[3].textContent, `${headOf(claims)[3]}stake() never settles.`);
    // A line without cells runs the width of the table and carries no column name.
    assert.equal(note.children.length, 1);
    assert.equal(note.children[0].attributes.colspan, '4');
    assert.equal(note.children[0].textContent, 'A line the model wrote between the rows.');
    assert.equal(labelsIn(note.children[0]), 0);
    // A cell the model left empty stays empty, so the stack skips it (td:empty in base.css).
    assert.equal(second.children[2].textContent, '');
    assert.equal(labelsIn(second.children[2]), 0);
    assert.equal(second.children[2].children.filter((child) => child instanceof Element).length, 0, 'no element in it, so td:empty hides it');
    assert.equal(labelOf(second.children[3]), headOf(claims)[3]);

    // A table whose columns the format does not name has no header row: it stacks without labels.
    const unnamed = tables.find((table) => table.textContent.includes('alpha'));
    assert.equal(unnamed.className, 'table table--dense stack-table stack-table--plain');
    assert.deepEqual(headOf(unnamed), []);
    assert.deepEqual(rowsOf(unnamed)[0].children.map(labelsIn), [0, 0]);

    // The files table has its own class: wb-files is the list of the Load step.
    const files = tables.find((table) => headOf(table)[0] === 'File');
    assert.equal(files.className, 'table table--dense stack-table wb-manifest');
    const [source, image] = rowsOf(files);
    assert.deepEqual(source.children.slice(1).map(labelOf), ['Size', 'Lines', 'SHA-256']);
    assert.equal(source.children[3].textContent, `SHA-256${'ab'.repeat(32)}`);
    assert.equal(image.children[2].textContent, '', 'a file with no line count leaves the cell empty');
    assert.equal(image.children[2].children.length, 0);
  });

  test('the panel’s agreement table carries its column names, and a cell with nothing to say carries none', () => {
    const review = `${REVIEW}
## Agreement
- Unsettled stake drains the reserve | 3/3 | kept | input-1/src/Vault.sol:12-14 | panel-1-a.md, panel-2-b.md
- Principal can be stolen |  | dropped |  |
- Fee recipient has no owner check | 2/3 | kept
`;
    const analysis = analyse({ ...RESULT, review, blocked: undefined, refused: false });
    const rows = agreementOf(analysis.parsed);
    assert.deepEqual(rows.map((row) => [row.k, row.status, row.settledBy !== '', row.reviewers !== '']), [[3, 'kept', true, true], [null, 'dropped', false, false], [2, 'kept', false, false]]);
    const context = { seats: [{ number: 1, model: 'a/one' }, { number: 2, model: 'b/two' }], source: { analysis, files: null, manifest: [] } };
    const section = agreementSection(rows, context);
    assert.equal(section.dataset.section, 'agreement');
    const table = descendants(section).find((node) => node.tagName === 'table');
    assert.equal(table.className, 'table table--dense stack-table');
    const names = descendants(table).filter((node) => node.tagName === 'th' && node.attributes.scope === 'col').map((node) => node.textContent);
    assert.deepEqual(names, ['Finding', 'Reported by', 'Result', 'Settled by', 'Reviews']);
    const labelOf = (cell) => (cell.children[0] instanceof Element && cell.children[0].className === 'cell-label' ? cell.children[0].textContent : null);
    const body = descendants(table).filter((node) => node.tagName === 'tr' && node.children.some((cell) => cell.tagName === 'td'));
    const [full, bare, short] = body.map((row) => row.children);
    // A full row: every cell after the first under its own column name, the name first.
    assert.deepEqual(full.map((cell) => cell.tagName), ['th', 'td', 'td', 'td', 'td']);
    assert.deepEqual(full.map(labelOf), [null, 'Reported by', 'Result', 'Settled by', 'Reviews']);
    assert.equal(full[1].textContent, 'Reported by3 of 3');
    assert.deepEqual(descendants(full[4]).filter((node) => node.tagName === 'button').map((node) => node.dataset.openReview), ['pn-seat-1', 'pn-seat-2']);
    // No count, no settling line, no reviews: those cells are empty and carry no name.
    assert.deepEqual(bare.map(labelOf), [null, null, 'Result', null, null]);
    assert.deepEqual([bare[1], bare[3], bare[4]].map((cell) => cell.children.length), [0, 0, 0]);
    // A row of three cells: the two it lacks stay empty.
    assert.deepEqual(short.map(labelOf), [null, 'Reported by', 'Result', null, null]);
    assert.equal(short[1].textContent, 'Reported by2 of 3');
    assert.deepEqual([short[3], short[4]].map((cell) => cell.children.length), [0, 0]);
    // No rows, no section.
    assert.equal(agreementSection([], context), null);
    // The panel body draws the table, once, and leaves the section out of the review below it.
    const drawn = panelBody({ ...RESULT, review, blocked: undefined, refused: false, source: 'panel', stages: [1, 2].map((number) => seatRecord({ number, model: context.seats[number - 1].model, review: REVIEW })), manifest: [] }, { analysis, files: null }).filter(Boolean);
    const sections = drawn.flatMap((node) => [node, ...descendants(node)]).filter((node) => node.dataset?.section === 'agreement');
    assert.equal(sections.length, 1);
    // A file entry without a hash carries no label over nothing.
    show({ ...RESULT, review: REVIEW, blocked: undefined, refused: false, manifest: [{ label: 'input-1/old.txt', bytes: 10, lines: 1, sha256: '' }] });
    const stored = descendants(root).find((node) => node.tagName === 'table' && node.className.includes('wb-manifest'));
    const hashCell = descendants(stored).filter((node) => node.tagName === 'td').at(-1);
    assert.equal(hashCell.children.length, 0);
  });

  test('a pasted notice says to paste the prompt into another model, with the guide link', () => {
    const view = show({ ...RESULT, source: 'pasted', provider: '' });
    assert.equal(view.notices.length, 1);
    assert.equal(view.notices[0].textContent, `${TITLES['anthropic-cyber']}Paste the same prompt into another model.When the model refuses`);
    assert.doesNotMatch(view.text, /allowance|Run it again|no Verdict line/);
  });

  test('on a wide screen the five export actions sit in the bar, as before', () => {
    screen.narrow = false;
    show({ ...RESULT, blocked: undefined, refused: false, review: REVIEW });
    const order = root.children.map((node) => node.attributes.id || node.className);
    assert.deepEqual(order.slice(0, 2), ['wb-result__bar', 'wb-result-tabs']);
    const bar = root.children[0];
    const actions = bar.children.find((node) => node.attributes.id === 'wb-result-actions');
    assert.ok(actions, 'the actions are inside the bar');
    assert.deepEqual(descendants(actions).map((node) => node.attributes['data-action']).filter(Boolean), ['packet', 'copy', 'issue', 'manifest', 'print']);
    assert.ok(!root.children.includes(actions));
  });

  test('on a narrow screen the review comes first and the secondary exports fold behind one control', () => {
    screen.narrow = true;
    try {
      show({ ...RESULT, blocked: undefined, refused: false, review: REVIEW });
      const ids = root.children.map((node) => node.attributes.id || node.className);
      const at = (id) => ids.indexOf(id);
      assert.ok(at('panel-findings') > -1 && at('wb-result-actions') > at('panel-findings'), 'the verdict block is above the export actions');
      assert.ok(at('wb-result-actions') > at('panel-raw'));
      const bar = root.children[0];
      assert.ok(!descendants(bar).some((node) => node.attributes.id === 'wb-result-actions'), 'the bar keeps only the facts of the review');

      const actions = root.children[at('wb-result-actions')];
      const [packet, toggle, more] = actions.children;
      assert.equal(packet.attributes['data-action'], 'packet');
      assert.equal(toggle.textContent, 'More exports');
      assert.deepEqual([toggle.tagName, toggle.attributes['aria-expanded'], toggle.attributes['aria-controls']], ['button', 'false', 'wb-result-more']);
      assert.deepEqual([more.attributes.id, more.dataset.open], ['wb-result-more', 'false']);
      assert.deepEqual(more.children.map((node) => node.attributes['data-action']), ['copy', 'issue', 'manifest', 'print']);
    } finally {
      screen.narrow = false;
    }
  });
});

// ---------------------------------------------------------------------------
// The single run
// ---------------------------------------------------------------------------

describe('the status line of a run', () => {
  test('a blocked answer names the block and never reads as a finished review', () => {
    for (const block of BLOCKS) {
      assert.deepEqual(finishedLine({ ...RESULT, blocked: block }, 4200), { message: `${TITLES[block]}. It did not count against your allowance.`, tone: 'warn', hold: true });
    }
    // The block outranks every other flag on the same answer.
    assert.match(finishedLine({ blocked: 'policy', refused: false, truncated: true }, 1).message, /^The provider blocked this review/);
  });

  test('a refusal, a cut-off answer and a review each keep their own line', () => {
    assert.deepEqual(finishedLine({ refused: true, truncated: false }, 1000), { message: 'The model declined to answer. Its reply is shown as written.', tone: 'warn', hold: true });
    assert.deepEqual(finishedLine({ refused: false, truncated: true }, 1000), { message: 'The answer was cut off before it finished. What arrived is shown.', tone: 'warn', hold: true });
    assert.deepEqual(finishedLine({ refused: false, truncated: false }, 65000), { message: 'Review done in 1:05.', tone: 'success', hold: false });
    assert.deepEqual(finishedLine({ refused: true, blocked: 'other-provider-reason' }, 1000).message, 'The model declined to answer. Its reply is shown as written.');
  });

  test('a provider_policy error is a block and not a key or model problem', () => {
    for (const via of ['key', 'connect']) {
      const failure = failureFor(policyError({ blocked: 'openai-cyber' }), via);
      assert.deepEqual(failure, { message: "OpenAI's cyber safeguards blocked this review. It did not count against your allowance.", tone: 'warn', blocked: 'openai-cyber' });
      assert.equal(failure.field, undefined, 'no field is marked invalid: the key is fine');
    }
    assert.equal(failureFor(policyError()).blocked, 'policy');
    // A rejected key is still a rejected key.
    const auth = failureFor(new ApiError('Provider rejected the API key (HTTP 403).', { code: 'provider', status: 502, data: { kind: 'auth' } }));
    assert.deepEqual([auth.field, auth.blocked, auth.tone], ['key', undefined, 'error']);
  });
});

// ---------------------------------------------------------------------------
// Gauntlet and panel
// ---------------------------------------------------------------------------

describe('the gauntlet', () => {
  const where = { at: 'stage 3, Prior art', keptLine: ' 2 finished stages are kept.' };

  test('a blocked stage stops the run with the block, keeps the earlier stages and says to pick another model', () => {
    for (const block of BLOCKS) {
      // The block as an answer, and the same block sent as an error.
      for (const stop of [{ kind: 'refused', blocked: block }, { kind: 'error', error: policyError({ blocked: block }) }]) {
        const said = declinedStop(stop, where);
        assert.deepEqual(said, {
          blocked: block,
          title: TITLES[block],
          context: 'The run stopped at stage 3, Prior art. 2 finished stages are kept. Pick another model above, then resume.',
          status: `${TITLES[block]}: the gauntlet stopped at stage 3, Prior art. 2 finished stages are kept. Pick another model, then resume.`,
        });
        // The notice the row shows is the shared one: not counted, then where the run stopped and the one way on.
        assert.equal(blockedCopy(stop.blocked || stop.error, { context: said.context }).body, `It did not count against your allowance. ${said.context}`);
      }
    }
  });

  test('no stop tells the user to ask the same model again, or promises a refusal is free', () => {
    const stops = [
      { kind: 'refused', blocked: 'anthropic-cyber' },
      { kind: 'refused', blocked: '' },
      { kind: 'refused' },
      { kind: 'error', error: policyError() },
    ];
    for (const stop of stops) {
      const said = declinedStop(stop, where);
      const all = `${said.title} ${said.context} ${said.status}`;
      assert.doesNotMatch(all, /ask again|Resume to|A refusal is not counted/i, JSON.stringify(stop));
      assert.match(said.context, /Pick another model above, then resume\.$/);
      assert.match(all, /2 finished stages are kept\./);
    }
    const generic = declinedStop({ kind: 'refused' }, where);
    assert.deepEqual(generic, {
      blocked: '',
      title: 'The model declined stage 3, Prior art',
      context: 'Its answer is not a stage review. 2 finished stages are kept. Pick another model above, then resume.',
      status: 'The model declined stage 3, Prior art. 2 finished stages are kept. Pick another model, then resume.',
    });
    assert.doesNotMatch(`${generic.context} ${generic.status}`, /allowance|not count/, 'a refusal of 2,000 characters or more is counted, so nothing is promised');
  });

  test('the stage that stopped is named for what happened: Blocked, Declined, or Failed only when it broke', () => {
    for (const block of BLOCKS) {
      const blocked = { status: 'failed', what: 'blocked by the provider', chip: 'Blocked' };
      assert.deepEqual(stageEnd({ kind: 'refused', blocked: block }), blocked, block);
      assert.deepEqual(stageEnd({ kind: 'error', error: policyError({ blocked: block }) }), blocked, `${block} as an error`);
    }
    assert.deepEqual(stageEnd({ kind: 'refused' }), { status: 'failed', what: 'declined by the model', chip: 'Declined' });
    assert.deepEqual(stageEnd({ kind: 'refused', blocked: '' }), { status: 'failed', what: 'declined by the model', chip: 'Declined' });
    assert.deepEqual(stageEnd({ kind: 'aborted' }), { status: 'queued', what: 'stopped' });
    const broke = [
      { kind: 'format', truncated: true },
      { kind: 'error', error: new ApiError('Provider had a server error (HTTP 503).', { code: 'provider', status: 502, data: { kind: 'server' } }) },
      { kind: 'error', error: new ApiError('Provider rejected the API key (HTTP 403).', { code: 'provider', status: 502, data: { kind: 'auth' } }) },
    ];
    for (const stop of broke) assert.deepEqual(stageEnd(stop), { status: 'failed', what: 'did not finish' }, stop.kind);
  });

  test('a stopped run remembers the stage that did not finish and why; a stage that never started is not marked', () => {
    // Stage 3 started and did not become a review.
    for (const block of BLOCKS) {
      assert.deepEqual(stopState({ kind: 'refused', blocked: block }, 2), { failedAt: 2, failedAs: 'Blocked' }, block);
      assert.deepEqual(stopState({ kind: 'error', error: policyError({ blocked: block }) }, 2), { failedAt: 2, failedAs: 'Blocked' }, `${block} as an error`);
    }
    assert.deepEqual(stopState({ kind: 'refused' }, 0), { failedAt: 0, failedAs: 'Declined' });
    assert.deepEqual(stopState({ kind: 'format', truncated: false }, 5), { failedAt: 5, failedAs: null });
    assert.deepEqual(stopState({ kind: 'error', error: new ApiError('Provider had a server error (HTTP 503).', { code: 'provider', status: 502, data: { kind: 'server' } }) }, 7), { failedAt: 7, failedAs: null });
    // Nothing started: the allowance, the plan, a sign-in, the input limits, a cancel.
    const never = [
      { kind: 'aborted' },
      { kind: 'input', error: new Error('Too many files.') },
      { kind: 'error', error: new ApiError("Today's free review is used.", { code: 'daily_used', status: 429 }) },
      { kind: 'error', error: new ApiError('The gauntlet is an Operator run.', { code: 'operator_only', status: 403 }) },
      { kind: 'error', error: new ApiError('Sign in to run a review.', { code: 'signin', status: 401 }) },
    ];
    for (const stop of never) assert.deepEqual(stopState(stop, 3), { failedAt: null, failedAs: null }, stop.error?.code ?? stop.kind);
  });

  test('only the stage that stopped carries the name, and only while the run is stopped there', () => {
    const two = [{}, {}];
    const rest = Array(5).fill(null);
    assert.deepEqual(stageNames({ status: 'stopped', stages: two, failedAt: 2, failedAs: 'Blocked' }), [null, null, 'Blocked', ...rest]);
    assert.deepEqual(stageNames({ status: 'stopped', stages: two, failedAt: 2, failedAs: 'Declined' }), [null, null, 'Declined', ...rest]);
    // A stage that broke has no name of its own: the strip prints Failed.
    assert.deepEqual(stageNames({ status: 'stopped', stages: two, failedAt: 2, failedAs: null }), Array(8).fill(null));
    assert.deepEqual(stageNames({ status: 'stopped', stages: two, failedAt: 2 }), Array(8).fill(null));
    // A name left over from an earlier stop is never printed once the run moves on.
    for (const status of ['running', 'gate', 'done', 'idle']) {
      assert.deepEqual(stageNames({ status, stages: two, failedAt: 2, failedAs: 'Blocked' }), Array(8).fill(null), status);
    }
    assert.deepEqual(stageNames({ status: 'stopped', stages: two, failedAt: null, failedAs: 'Blocked' }), Array(8).fill(null), 'no stage failed');
    // What a stop stores is what the strip reads back.
    const stopped = { status: 'stopped', stages: two, ...stopState({ kind: 'refused', blocked: 'openai-cyber' }, two.length) };
    assert.equal(stageNames(stopped)[2], 'Blocked');
  });

  test('the stage strip prints that name on the stage, and Failed when none is given', () => {
    const previous = globalThis.document;
    globalThis.document = { createElement: (tag) => new Element(tag) };
    try {
      const chipOf = (entry) => descendants(stageStrip([{ number: 3, label: 'Prior art', ...entry }])).find((node) => node.className.startsWith('chip'));
      for (const [failedAs, text] of [['Blocked', 'Blocked'], ['Declined', 'Declined'], [null, 'Failed'], [undefined, 'Failed']]) {
        const chip = chipOf({ state: 'failed', failedAs });
        assert.equal(chip.textContent, text);
        assert.equal(chip.dataset.status, 'failed', 'the same ink as any stage that did not finish');
      }
      // The name belongs to the failed stage only.
      assert.equal(chipOf({ state: 'waiting', failedAs: 'Blocked' }).textContent, 'Waiting');
      assert.equal(chipOf({ state: 'stopped', failedAs: 'Blocked' }).textContent, 'Not run');
    } finally {
      if (previous === undefined) delete globalThis.document;
      else globalThis.document = previous;
    }
  });

  test('every other stop is left to its own message', () => {
    const others = [
      { kind: 'gate' }, { kind: 'aborted' }, { kind: 'format', truncated: true }, { kind: 'input', error: new Error('Too many files.') },
      { kind: 'error', error: new ApiError('Provider rejected the API key (HTTP 403).', { code: 'provider', status: 502, data: { kind: 'auth' } }) },
      { kind: 'error', error: new ApiError("Today's free review is used.", { code: 'daily_used', status: 429 }) },
    ];
    for (const stop of others) assert.equal(declinedStop(stop, where), null, stop.kind);
  });
});

describe('the panel', () => {
  const seat = { provider: 'anthropic', model: 'claude-opus-5-5' };

  test("a blocked seat's row names the block and the way on", () => {
    for (const block of BLOCKS) {
      const line = `claude-opus-5-5: ${TITLES[block]}. It did not count against your allowance. Pick another model for this seat.`;
      // A blocked answer (the seat throws `refused` carrying the block) and a block sent as an error.
      assert.equal(failureLine(seat, Object.assign(new Error('The model declined to answer.'), { code: 'refused', blocked: block }), 'key'), line);
      assert.equal(failureLine(seat, policyError({ blocked: block }), 'key'), line);
    }
  });

  test('every other failed seat keeps its own reason', () => {
    assert.equal(failureLine(seat, Object.assign(new Error('The model declined to answer.'), { code: 'refused' }), 'key'), 'claude-opus-5-5: The model declined to answer.');
    assert.equal(failureLine(seat, Object.assign(new Error('The answer is not in the review format.'), { code: 'format' }), 'key'), 'claude-opus-5-5: The answer is not in the review format.');
    const auth = new ApiError('Provider rejected the API key (HTTP 403).', { code: 'provider', status: 502, data: { kind: 'auth' } });
    assert.equal(failureLine(seat, auth, 'key'), 'claude-opus-5-5: Provider rejected the API key (HTTP 403).');
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe('history', () => {
  test('a block survives the round trip through storage, and only a known one does', () => {
    for (const block of BLOCKS) {
      const record = historyRecord({ result: { ...RESULT, blocked: block }, packet: ANTHROPIC_CYBER_NOTICE });
      assert.equal(record.blocked, block);
      assert.equal(record.refused, true);
      assert.equal(record.review, ANTHROPIC_CYBER_NOTICE);
      // What IndexedDB hands back is a structured clone of the record.
      const restored = resultFrom(structuredClone(record));
      assert.equal(restored.blocked, block);
      assert.equal(restored.refused, true);
      assert.equal(restored.review, ANTHROPIC_CYBER_NOTICE);
      assert.equal(blockedCopy(restored).title, TITLES[block], 'the reopened review shows the same notice');
      assert.equal(snapshot({ ...initialState(), result: { ...RESULT, blocked: block } }).result.blocked, block);
    }
    for (const blocked of [undefined, 'other-provider-reason', { apiKey: 'never-store-this' }]) {
      const record = historyRecord({ result: { ...RESULT, blocked }, packet: ANTHROPIC_CYBER_NOTICE });
      assert.equal(Object.hasOwn(record, 'blocked'), false);
      // A record another build or a hand edit put there is filtered on the way out too.
      const restored = resultFrom({ ...structuredClone(record), blocked });
      assert.equal(Object.hasOwn(restored, 'blocked'), false);
    }
  });

  test('the list marks a row that is not a review', () => {
    assert.equal(outcomeMark(historyRecord({ result: RESULT, packet: '' })), 'Blocked');
    assert.equal(outcomeMark(historyRecord({ result: { ...RESULT, blocked: 'policy' }, packet: '' })), 'Blocked');
    assert.equal(outcomeMark(historyRecord({ result: { ...RESULT, blocked: undefined }, packet: '' })), 'Declined');
    assert.equal(outcomeMark(historyRecord({ result: { ...RESULT, blocked: 'other-provider-reason', refused: false }, packet: '' })), '');
    assert.equal(outcomeMark(historyRecord({ result: { ...RESULT, blocked: undefined, refused: false, review: REVIEW }, packet: '' })), '');
    assert.equal(outcomeMark({}), '');
    assert.equal(outcomeMark(null), '');
  });
});

// ---------------------------------------------------------------------------
// A reply pasted back from a chat app
// ---------------------------------------------------------------------------

describe('a pasted reply', () => {
  const profile = { id: 'general', name: 'Code security review', mode: 'either' };
  const paste = (reply) => pastedResult({ reply, profile, mode: 'own-code', manifest: [] });

  test("the provider's notice is a block, not a reply with no Verdict line", () => {
    const variants = [
      ANTHROPIC_CYBER_NOTICE,
      `\n  ${ANTHROPIC_CYBER_NOTICE}\n`,
      ANTHROPIC_CYBER_NOTICE.replace("Anthropic's", 'Anthropic’s'),
      ANTHROPIC_CYBER_NOTICE.replace(/ To learn more.*$/, ' To request an adjustment pursuant to our Cyber Verification Program, see the Help Center.'),
    ];
    for (const reply of variants) {
      assert.equal(pastedBlock(reply), 'anthropic-cyber');
      const result = paste(reply);
      assert.deepEqual([result.blocked, result.refused, result.source], ['anthropic-cyber', true, 'pasted']);
      const line = pastedLine(result, false);
      assert.deepEqual(line, { message: "Anthropic's cyber safeguards blocked this review. Paste the same prompt into another model.", tone: 'warn', hold: true });
      assert.doesNotMatch(line.message, /Verdict line/);
    }
  });

  test('a review that quotes the notice, and a notice followed by a Verdict line, are replies', () => {
    const quoting = `${REVIEW}\n## Findings\nThe upstream log says: "${ANTHROPIC_CYBER_NOTICE}"\n${'The handler was read line by line. '.repeat(60)}`;
    const withVerdict = `${ANTHROPIC_CYBER_NOTICE}\nVerdict: drop`;
    const long = `${ANTHROPIC_CYBER_NOTICE}\n${'The configuration was reviewed. '.repeat(80)}`;
    for (const reply of [quoting, withVerdict, long, 'No issues found.', REVIEW]) {
      assert.equal(pastedBlock(reply), '');
      const result = paste(reply);
      assert.equal(result.refused, false);
      assert.equal(Object.hasOwn(result, 'blocked'), false);
    }
    assert.deepEqual(pastedLine(paste(REVIEW), true), { message: 'Result built from the pasted reply.', tone: 'success', hold: false });
    assert.deepEqual(pastedLine(paste('No issues found.'), false), { message: 'The reply has no Verdict line in the review format, so it is shown as written.', tone: 'warn', hold: true });
  });
});
