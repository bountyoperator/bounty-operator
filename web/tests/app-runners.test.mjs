// The gauntlet, the panel, their result shapes and the bundled examples, run
// under node: every decision that needs no DOM. The flows through a real
// browser (the stage strip, early stop, cancel, a provider error mid-run, an
// exhausted allowance, the dossier) are checked with Playwright against
// wrangler dev with a scripted /api/review; this file pins the logic those
// flows rest on and the rules the code has to keep.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { EXAMPLES } from '../public/example.mjs';
import { checkRefs, parseReview } from '../public/parse.mjs';
import { GAUNTLET, PROFILES, reviewProfile } from '../public/profiles.mjs';
import { PROVIDERS } from '../public/providers.mjs';
import { LIMITS, checkInputs, manifestFor } from '../public/review-core.mjs';
import {
  STAGE_LABELS,
  STOP_VERDICTS,
  VERDICT_LABELS,
  agreementOf,
  decisionOf,
  exampleGauntletResult,
  examplePanelResult,
  fullStages,
  gateDecision,
  gauntletResult,
  isComplete,
  matchAgreement,
  panelFileName,
  panelResult,
  seatRecord,
  stageFileName,
  stageLabel,
  stageRecord,
  stopsRun,
  sumUsage,
} from '../public/app/dossier.mjs';
import { compactStage, effectiveMode, extraInputs, signatureOf, stageInputs, stageStates } from '../public/app/gauntlet.mjs';
import { historyRecord } from '../public/app/history.mjs';
import { exampleList } from '../public/app/main.mjs';
import { MAX_SEATS, MIN_SEATS, cleanSeats, defaultSeats, pickJudge, runPool, seatKey, seatProblems } from '../public/app/panel.mjs';
import { analyse, packetFor } from '../public/app/results.mjs';
import { initialState, snapshot } from '../public/app/state.mjs';
import { workbench } from '../site/fragments/workbench.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

const run = promisify(execFile);
const APP_DIR = new URL('../public/app/', import.meta.url);
const RUNNER_MODULES = ['gauntlet.mjs', 'panel.mjs', 'dossier.mjs'];

const file = (name, content) => ({ name, content });

const SOURCE = `${Array.from({ length: 40 }, (unused, index) => `line ${index + 1}`).join('\n')}\n`;
const FILES = [file('src/Vault.sol', SOURCE), file('draft-report.md', '# Draft\n\nThe vault can be drained.\n')];

/** A stage answer in the review format, with the profile's own section. */
function answer({ verdict = 'submit', headline = 'Asset, revision and row bind.', sections = '', finding = false } = {}) {
  return `# Review
Verdict: ${verdict}
Mode: bounty
Counts: critical=0 high=${finding ? 1 : 0} medium=0 hardening=1 checked-safe=1
Headline: ${headline}

${sections}
${finding ? `## F-1: withdraw pays before it clears the balance
Severity: high
Basis: proven-in-source
Location: input-1/src/Vault.sol:12-14
Impact: A depositor takes other depositors' funds, bounded by the vault balance.
Path:
1. Deposit 1 ETH.
2. Re-enter withdraw from the receive hook.
Counterargument: Checked arithmetic stops it | resolved | The subtraction runs after the calls return (input-1/src/Vault.sol:20).
Gap: none
Fix: Move the balance update above the call (input-1/src/Vault.sol:12).
Test:
\`\`\`solidity
function test_reenter() public {}
\`\`\`
Next: Apply the fix.
` : ''}
## Hardening
- Fee transfer can block payouts | input-1/src/Vault.sol:22 | Let the recipient pull it.

## Checked and safe
- Deposit accounting | input-1/src/Vault.sol:5-7 | Balance and total rise together.

## Coverage
Reviewed: input-1/src/Vault.sol, input-2/draft-report.md
Not supplied: none
`;
}

const BINDING = `## Binding
- Vault | example/vault | v1.2.0 | v1.2.0 | bound | input-1/src/Vault.sol:1
`;

const DECISION = `## Stages
- stage-1-scope.md | submit | The row binds.
- stage-7-report.md | rewrite-then-submit | Limits are not stated.

## Decision
Why: The draft claims the Critical row and the proof asserts a reward balance (input-1/src/Vault.sol:12).
Rule: The draft asks for Critical and the proof reaches Medium.
Blocker: The selected row is Critical and the proof satisfies Medium.
Cheapest action: Select the Medium row and quote it in the first paragraph.
Severity to claim: Medium, on the programme's own scale
Deadline: file within hours of removing the blocker, or skip
First reproduced: 2026-09-30

## To do
- 1 | Select the Medium row | The edited form | severity
`;

function eightStages(overrides = {}) {
  return GAUNTLET.map((profileId, index) => stageRecord({
    number: index + 1,
    profileId,
    review: overrides[profileId] ?? answer(profileId === 'verdict'
      ? { verdict: 'rewrite-then-submit', headline: 'A real bug, claimed one tier too high.', sections: DECISION, finding: true }
      : { sections: profileId === 'scope' ? BINDING : '' }),
    model: 'anthropic/claude-opus-5.5',
    usage: { input: 1000 + index, output: 200 },
    elapsed: 4000,
  }));
}

async function manifestWith(stages) {
  return manifestFor([...FILES, ...stages.slice(0, -1).map((stage) => file(stage.file, stage.review))]);
}

// ---------------------------------------------------------------------------
// Names and records
// ---------------------------------------------------------------------------

describe('stage and seat records', () => {
  test('a stage answer travels as stage-<n>-<profile>.md and a model review as panel-<n>-<model>.md', () => {
    assert.equal(stageFileName(3, 'prior-art'), 'stage-3-prior-art.md');
    assert.equal(panelFileName(2, 'openai/gpt-6-astra'), 'panel-2-openai-gpt-6-astra.md');
    assert.equal(panelFileName(1, '../../etc/passwd'), 'panel-1-etc-passwd.md');
    assert.equal(panelFileName(4, ''), 'panel-4-model.md');
    // Every name the engine would accept as a file name.
    for (const name of [stageFileName(8, 'verdict'), panelFileName(1, 'x-ai/grok-4.7'), panelFileName(3, 'a b\\c:d')]) {
      assert.doesNotThrow(() => checkInputs([file(name, 'text\n')]));
    }
  });

  test('every gauntlet stage has the short name the method page uses', () => {
    assert.deepEqual(Object.keys(STAGE_LABELS), [...GAUNTLET]);
    assert.equal(stageLabel('poc'), 'Proof');
    assert.equal(stageLabel('solidity'), reviewProfile('solidity').name);
    assert.equal(stageLabel('unknown'), 'unknown');
    for (const verdict of ['submit', 'rewrite-then-submit', 'prove-first', 'hold-duplicate', 'drop']) assert.ok(VERDICT_LABELS[verdict]);
  });

  test('drop and hold-duplicate end a run; nothing else does', () => {
    assert.deepEqual([...STOP_VERDICTS], ['drop', 'hold-duplicate']);
    assert.ok(stopsRun('drop') && stopsRun('hold-duplicate'));
    for (const verdict of ['submit', 'rewrite-then-submit', 'prove-first', '']) assert.equal(stopsRun(verdict), false);
  });

  test('a stage record carries what the packet lists', () => {
    const record = stageRecord({ number: 2, profileId: 'provenance', review: answer({ verdict: 'drop', headline: 'The owner performs the decisive step.' }), model: 'm', usage: { input: 10, output: 5 }, elapsed: 1200 });
    assert.deepEqual(
      { number: record.number, profileId: record.profileId, name: record.name, file: record.file, model: record.model, verdict: record.verdict, headline: record.headline },
      { number: 2, profileId: 'provenance', name: 'Design intent and actors', file: 'stage-2-provenance.md', model: 'm', verdict: 'drop', headline: 'The owner performs the decisive step.' },
    );
    assert.deepEqual(record.usage, { input: 10, output: 5 });
    assert.equal(record.sent, undefined);
    assert.equal(stageRecord({ number: 1, profileId: 'scope', review: 'no format here' }).verdict, '');
    assert.equal(stageRecord({ number: 1, profileId: 'scope', review: 'a', sent: 'b' }).sent, 'b');
    assert.throws(() => stageRecord({ number: 1, profileId: 'nope', review: 'x' }), /supported review profile/);
  });

  test('a seat record is named by its model', () => {
    const seat = seatRecord({ number: 2, provider: 'openrouter', model: 'openai/gpt-6-astra', review: answer({ verdict: 'prove-first' }) });
    assert.equal(seat.name, 'openai/gpt-6-astra');
    assert.equal(seat.file, 'panel-2-openai-gpt-6-astra.md');
    assert.equal(seat.verdict, 'prove-first');
  });

  test('token counts add up, and stay unknown when nobody reported one', () => {
    assert.deepEqual(sumUsage([{ usage: { input: 5, output: 1 } }, { usage: { input: null, output: 2 } }, {}]), { input: 5, output: 3 });
    assert.deepEqual(sumUsage([{ usage: { input: null, output: null } }]), { input: null, output: null });
  });
});

// ---------------------------------------------------------------------------
// The gauntlet result and its packet
// ---------------------------------------------------------------------------

describe('gauntlet result', () => {
  test('a full run ends as one result whose review is the verdict stage', async () => {
    const stages = eightStages();
    const result = gauntletResult({ stages, manifest: await manifestWith(stages), provider: 'openrouter', timestamp: '2026-10-02T12:00:00.000Z' });
    assert.equal(result.source, 'gauntlet');
    assert.equal(result.review, stages[7].review);
    assert.deepEqual(result.profile, { id: 'verdict', name: 'Final verdict' });
    assert.equal(result.mode, 'bounty');
    assert.equal(result.stages.length, 8);
    // The verdict stage's text is the result's own review: it is not carried twice.
    assert.equal(result.stages[7].review, undefined);
    assert.equal(result.stages[0].review, stages[0].review);
    assert.deepEqual(result.usage, { input: 8028, output: 1600 });
    assert.ok(isComplete(result));
    assert.equal(fullStages(result)[7].review, stages[7].review);
    assert.equal(result.manifest.length, FILES.length + 7);
  });

  test('a run a gate ended keeps the gate as its last stage', async () => {
    const stages = eightStages({ provenance: answer({ verdict: 'drop', headline: 'The owner performs the decisive step.' }) }).slice(0, 2);
    const result = gauntletResult({ stages, manifest: await manifestWith(stages) });
    assert.equal(isComplete(result), false);
    assert.equal(result.profile.id, 'provenance');
    assert.equal(analyse(result).parsed.verdict, 'drop');
    assert.deepEqual(gateDecision(stages[1]), {
      why: 'The owner performs the decisive step.',
      rule: 'Stage 2, Provenance, returned drop.',
      blocker: 'The owner performs the decisive step.',
      action: 'Stop work on this finding.',
      severity: '',
      deadline: '',
      firstReproduced: '',
    });
    assert.equal(gateDecision({ ...stages[1], verdict: 'hold-duplicate' }).action, 'Add the new evidence to the existing report.');
  });

  test('the packet is one document: source gauntlet, every stage once, one Files section', async () => {
    const stages = eightStages();
    const result = gauntletResult({ stages, manifest: await manifestWith(stages), provider: 'openrouter' });
    const packet = packetFor(result, { target: 'Vault', version: 'v1.2.0' });
    assert.match(packet, /^Produced by: Gauntlet: 8 stages, final verdict by OpenRouter \/ anthropic\/claude-opus-5\.5\.$/m);
    assert.match(packet, /^Profile: Final verdict$/m);
    assert.match(packet, /^Verdict: rewrite-then-submit$/m);
    assert.equal(packet.match(/^## Files$/gm).length, 1);
    assert.equal(packet.match(/^## Stages$/gm).length, 1);
    for (const [index, stage] of stages.entries()) {
      assert.ok(packet.includes(`- ${index + 1} · ${stage.name}`), `stage ${index + 1} is listed`);
    }
    // Stages 1 to 7 are appended in full; the verdict stage is the Review section.
    assert.equal(packet.match(/^## Stage \d: /gm).length, 7);
    assert.ok(!/^## Stage 8: /m.test(packet));
    assert.ok(packet.includes('stage-7-report.md'));
  });

  test('the result survives a reload and reaches history without anything key-like', async () => {
    const stages = eightStages();
    const result = gauntletResult({ stages, manifest: await manifestWith(stages), provider: 'openrouter' });
    const stored = snapshot({ ...initialState(), files: FILES, step: 'results', result });
    assert.equal(stored.result, result);
    assert.equal(stored.step, 'results');
    const record = historyRecord({ result, packet: packetFor(result, {}), verdict: 'rewrite-then-submit' });
    assert.equal(record.source, 'gauntlet');
    assert.equal(record.profileId, 'verdict');
  });
});

describe('the decision', () => {
  test('the Decision section becomes the lines the dossier leads with', () => {
    const decision = decisionOf(parseReview(answer({ verdict: 'rewrite-then-submit', sections: DECISION })));
    assert.equal(decision.blocker, 'The selected row is Critical and the proof satisfies Medium.');
    assert.equal(decision.action, 'Select the Medium row and quote it in the first paragraph.');
    assert.equal(decision.deadline, 'file within hours of removing the blocker, or skip');
    assert.equal(decision.firstReproduced, '2026-09-30');
    assert.equal(decision.severity, "Medium, on the programme's own scale");
    assert.equal(decision.rule, 'The draft asks for Critical and the proof reaches Medium.');
    assert.match(decision.why, /input-1\/src\/Vault\.sol:12/);
  });

  test('an explicit absence of a blocker, action or deadline remains distinct from missing evidence', () => {
    const submit = decisionOf(parseReview(answer({ sections: '## Decision\nWhy: Every stage passes.\nRule: every stage passes\nBlocker: none\nCheapest action: None.\nSeverity to claim: Critical\nDeadline: none\nFirst reproduced: not given\n' })));
    assert.deepEqual([submit.blocker, submit.action, submit.deadline, submit.firstReproduced], ['none', 'None.', 'none', '']);
    assert.equal(submit.severity, 'Critical');
    assert.deepEqual(Object.values(decisionOf(parseReview(answer()))), ['', '', '', '', '', '', '']);
    assert.deepEqual(Object.values(decisionOf(null)), ['', '', '', '', '', '', '']);
  });

  test('unknown decision fields never become an explicit none', () => {
    for (const value of ['not given', 'Not stated.', 'n/a', '-', '']) {
      const decision = decisionOf(parseReview(answer({ sections: `## Decision\nBlocker: ${value}\nCheapest action: ${value}\nDeadline: ${value}\n` })));
      assert.deepEqual([decision.blocker, decision.action, decision.deadline], ['', '', ''], value);
    }
  });

  test('labels written as bullets or in bold, and wrapped lines, are still read', () => {
    const decision = decisionOf(parseReview(answer({ sections: '## Decision\n- **Blocker:** No assertion reads the balance\n  the impact row names.\n- **Cheapest action**: Add one assertEq.\n- Deadline: file today\n' })));
    assert.equal(decision.blocker, 'No assertion reads the balance the impact row names.');
    assert.equal(decision.action, 'Add one assertEq.');
    assert.equal(decision.deadline, 'file today');
  });
});

// ---------------------------------------------------------------------------
// Stage inputs
// ---------------------------------------------------------------------------

describe('stage inputs', () => {
  test('earlier answers follow the user files, so cited input numbers never move', () => {
    const stages = eightStages().slice(0, 3);
    const inputs = stageInputs(FILES, stages, { context: { target: 'Vault' } });
    assert.deepEqual(inputs.files.map((entry) => entry.name), ['src/Vault.sol', 'draft-report.md', 'stage-1-scope.md', 'stage-2-provenance.md', 'stage-3-prior-art.md']);
    assert.equal(inputs.files[0], FILES[0]);
    assert.equal(inputs.files[2].content, stages[0].review);
    assert.deepEqual([inputs.compact, inputs.masked, inputs.warnings], [false, 0, 0]);
    // The first stage receives the user's files and nothing else.
    assert.deepEqual(stageInputs(FILES, []).files, FILES);
  });

  test('the summary keeps verdict, headline, findings and the stage sections, and still parses', () => {
    const review = answer({ verdict: 'rewrite-then-submit', headline: 'A real bug, one tier too high.', sections: `${BINDING}\n${DECISION}`, finding: true });
    const summary = compactStage(review);
    const parsed = parseReview(summary);
    assert.ok(parsed.ok);
    assert.equal(parsed.verdict, 'rewrite-then-submit');
    assert.equal(parsed.headline, 'A real bug, one tier too high.');
    assert.match(summary, /^- F-1 \| high \| proven-in-source \| withdraw pays before it clears the balance \| input-1\/src\/Vault\.sol:12-14 \| /m);
    assert.match(summary, /^## Binding\n- Vault \| example\/vault \| v1\.2\.0/m);
    assert.match(summary, /^Blocker: The selected row is Critical/m);
    assert.match(summary, /^## Coverage\nReviewed: /m);
    // The prose, the test and the supporting lists are what gets left out.
    assert.ok(!summary.includes('test_reenter'));
    assert.ok(!summary.includes('## Hardening') && !summary.includes('## Checked and safe'));
    assert.ok(!summary.includes('Re-enter withdraw'));
    assert.ok(summary.length < review.length);
    // An answer outside the format is clipped, not parsed.
    assert.equal(compactStage('x'.repeat(9000)).length, 4001);
  });

  test('answers too large for the limits travel summarised; too large even then is an error', () => {
    const padding = `${'Prose that argues at length about the finding and repeats itself. '.repeat(1400)}\n`;
    const big = eightStages().slice(0, 7).map((stage) => ({ ...stage, review: `${stage.review}\n${padding}` }));
    const inputs = stageInputs(FILES, big);
    assert.equal(inputs.compact, true);
    assert.equal(inputs.files.length, FILES.length + 7);
    assert.ok(inputs.files.slice(2).every((entry) => parseReview(entry.content).ok));
    assert.doesNotThrow(() => checkInputs(inputs.files));

    const row = `${'a'.repeat(99)}\n`;
    const full = [file('big-1.sol', row.repeat(1198)), file('big-2.sol', row.repeat(1198))];
    assert.throws(() => stageInputs(full, big), /240 KB limit/);
    // The file count is a limit like the others.
    const many = Array.from({ length: LIMITS.files - 2 }, (unused, index) => file(`f${index}.sol`, 'x\n'));
    assert.throws(() => stageInputs(many, eightStages().slice(0, 3)), /between 1 and 50/);
  });

  test('a secret a model repeats is masked in its answer, never in the user files', () => {
    const leaked = `${answer()}\nThe deploy script holds AKIA${'IOSFODNN7EXAMPLE'} on line 3.\n`;
    const stage = stageRecord({ number: 1, profileId: 'scope', review: leaked });
    const inputs = stageInputs(FILES, [stage]);
    assert.equal(inputs.masked, 1);
    assert.ok(!inputs.files[2].content.includes('AKIA'));
    assert.match(inputs.files[2].content, /\[masked: AWS access key\]/);
    assert.equal(checkInputs(inputs.files).blocking, 0);
    // Line numbers of the answer do not move.
    assert.equal(inputs.files[2].content.split('\n').length, leaked.split('\n').length);

    // A secret in the user's own file is the user's to remove: it still blocks.
    const own = [file('deploy.py', `KEY = "AKIA${'IOSFODNN7EXAMPLE'}"\n`)];
    const kept = stageInputs(own, [stage]);
    assert.equal(kept.files[0].content, own[0].content);
    assert.equal(checkInputs(kept.files).blocking, 1);
  });

  test('an address in an answer is counted, so the stage can be sent acknowledged', () => {
    const stage = stageRecord({ number: 1, profileId: 'scope', review: `${answer()}\nContact dev@halyard-treasury.io for the deployed revision.\n` });
    assert.equal(stageInputs(FILES, [stage]).warnings, 1);
  });

  test('extras fall back to the caller summary only when one is given', () => {
    const extras = [file('panel-1-a.md', 'x'.repeat(100000)), file('panel-2-b.md', 'y'.repeat(100000)), file('panel-3-c.md', 'z'.repeat(100000))];
    assert.throws(() => extraInputs(FILES, extras), /240 KB limit/);
    const fitted = extraInputs(FILES, extras, { compact: (entry) => file(entry.name, entry.content.slice(0, 10)) });
    assert.equal(fitted.compact, true);
    assert.deepEqual(fitted.extras.map((entry) => entry.content.length), [10, 10, 10]);
  });

  test('a run is tied to the exact files it was made on', () => {
    const base = signatureOf(FILES);
    assert.equal(signatureOf([...FILES]), base);
    assert.notEqual(signatureOf([FILES[1], FILES[0]]), base);
    assert.notEqual(signatureOf([FILES[0], file('draft-report.md', '# Draft\n\nThe vault can be drained!\n')]), base);
    assert.notEqual(signatureOf([FILES[0], file('draft.md', FILES[1].content)]), base);
    assert.notEqual(signatureOf(FILES, 'report|bounty'), base);
    // Moving a boundary between name and content is a different input.
    assert.notEqual(signatureOf([file('ab', 'c')]), signatureOf([file('a', 'bc')]));
  });

  test('the strip shows each stage as waiting, running, done, not run or failed', () => {
    const two = eightStages().slice(0, 2);
    assert.deepEqual(stageStates({ status: 'idle', stages: [] }), Array(8).fill('waiting'));
    assert.deepEqual(stageStates({ status: 'running', stages: two }), ['done', 'done', 'running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    assert.deepEqual(stageStates({ status: 'gate', stages: two }), ['done', 'done', ...Array(6).fill('stopped')]);
    assert.deepEqual(stageStates({ status: 'stopped', stages: two, failedAt: 2 }), ['done', 'done', 'failed', ...Array(5).fill('waiting')]);
    assert.deepEqual(stageStates({ status: 'stopped', stages: two, failedAt: null }), ['done', 'done', ...Array(6).fill('waiting')]);
    assert.deepEqual(stageStates({ status: 'done', stages: eightStages() }), Array(8).fill('done'));
  });

  test('the gauntlet runs in bounty mode: a fixed-mode profile decides, else the chosen mode', () => {
    assert.equal(effectiveMode({ profile: 'report', mode: 'own-code' }), 'bounty');
    assert.equal(effectiveMode({ profile: 'solidity', mode: 'own-code' }), 'own-code');
    assert.equal(effectiveMode({ profile: 'solidity', mode: 'bounty' }), 'bounty');
    assert.equal(effectiveMode({ profile: 'gone', mode: 'bounty' }), 'bounty');
    // Every stage is a bounty profile, so the stage calls never depend on the chosen mode.
    for (const id of GAUNTLET) assert.equal(reviewProfile(id).mode, 'bounty');
  });
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

describe('panel seats', () => {
  test('every provider suggests two or three distinct models from its own list', () => {
    for (const provider of PROVIDERS) {
      const seats = defaultSeats(provider.id);
      assert.ok(seats.length >= MIN_SEATS && seats.length <= 3, provider.id);
      assert.ok(seats.every((seat) => seat.provider === provider.id && provider.models.some((model) => model.id === seat.model)), provider.id);
      assert.equal(new Set(seats.map((seat) => seat.model)).size, seats.length, provider.id);
    }
    // One model per vendor first, on a provider that serves several vendors.
    const vendors = defaultSeats('openrouter').map((seat) => seat.model.split('/')[0]);
    assert.equal(new Set(vendors).size, 3);
    assert.equal(defaultSeats('openrouter')[0].model, PROVIDERS.find((entry) => entry.id === 'openrouter').defaultModel);
    assert.deepEqual(defaultSeats('unknown'), defaultSeats(PROVIDERS[0].id));
  });

  test('stored seats are taken only when they are two to four seats on known providers', () => {
    const seats = [{ provider: 'openrouter', model: 'a/b' }, { provider: 'anthropic', model: '' }];
    assert.deepEqual(cleanSeats({ seats, judge: 1 }), { seats, judge: 1 });
    assert.equal(cleanSeats({ seats, judge: 7 }).judge, 0);
    assert.equal(cleanSeats({ seats: seats.slice(0, 1) }), null);
    assert.equal(cleanSeats({ seats: [...seats, ...seats, seats[0]] }), null);
    assert.equal(cleanSeats({ seats: [seats[0], { provider: 'nope', model: 'x' }] }), null);
    assert.equal(cleanSeats(null), null);
    // A model id with a space or a control character is dropped, not sent.
    assert.equal(cleanSeats({ seats: [seats[0], { provider: 'openai', model: 'bad id' }] }).seats[1].model, '');
    assert.ok(MAX_SEATS === 4 && MIN_SEATS === 2);
  });

  test('a missing key, a repeated model and a refused model id stop the run before anything is sent', () => {
    const good = { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', apiKey: 'sk-or-v1-0123456789abcdef' };
    assert.deepEqual(seatProblems([good, { ...good, model: 'openai/gpt-6-astra' }]), []);
    const problems = seatProblems([good, { ...good }, { provider: 'mistral', model: 'mistral-medium-latest', apiKey: '' }, { ...good, model: 'bad model id' }]);
    assert.deepEqual(problems.map((problem) => [problem.index, problem.field]), [[1, 'model'], [2, 'key'], [3, 'model']]);
    assert.match(problems[0].message, /Model 2 repeats model 1/);
    assert.match(problems[1].message, /Model 3 needs the Mistral API key/);
    assert.equal(seatKey(good), 'openrouter/anthropic/claude-sonnet-5.5');
    // No message repeats a key.
    assert.ok(problems.every((problem) => !problem.message.includes('sk-or-')));
  });

  test('the chosen model cross-examines when it answered; otherwise the first that did', () => {
    assert.equal(pickJudge(1, [true, true, true]), 1);
    assert.equal(pickJudge(1, [true, false, true]), 0);
    assert.equal(pickJudge(0, [false, false, true]), 2);
    assert.equal(pickJudge(0, [false, false]), -1);
  });

  test('the pool never runs more at once than the limit and keeps every outcome in order', async () => {
    let active = 0;
    let peak = 0;
    const work = async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5 + (item % 3) * 4));
      active -= 1;
      if (item === 3) throw new Error('seat 3 failed');
      return item * 10;
    };
    const outcomes = await runPool([1, 2, 3, 4, 5, 6], 4, work);
    assert.equal(peak, 4);
    assert.deepEqual(outcomes.map((outcome) => ('value' in outcome ? outcome.value : outcome.error.message)), [10, 20, 'seat 3 failed', 40, 50, 60]);
    assert.deepEqual(await runPool([], 4, work), []);
    peak = 0;
    await runPool([1, 2, 4], 0, work);
    assert.equal(peak, 1);
  });
});

const AGREEMENT = `## Agreement
- Unsettled stake drains the reward reserve | 3/3 | kept | input-1/src/Vault.sol:12-14 | panel-1-a.md, panel-2-b.md, panel-3-c.md
- Principal can be stolen | 1/3 | dropped | input-1/src/Vault.sol:20 | panel-2-b.md
- Fee recipient has no owner check | 2/3 | kept | input-1/src/Vault.sol:30 | panel-1-a.md, panel-3-c.md
`;

describe('panel result', () => {
  test('the cross-examination is the review and the model reviews are its stages', async () => {
    const seats = ['anthropic/claude-sonnet-5.5', 'openai/gpt-6-astra'].map((model, index) => seatRecord({ number: index + 1, provider: 'openrouter', model, review: answer({ finding: true }), usage: { input: 100, output: 10 } }));
    const manifest = await manifestFor([...FILES, ...seats.map((seat) => file(seat.file, seat.review))]);
    const result = panelResult({
      seats,
      judge: { review: answer({ sections: AGREEMENT, finding: true }), model: 'anthropic/claude-sonnet-5.5', provider: 'openrouter', usage: { input: 300, output: 30 } },
      manifest,
      mode: 'bounty',
      profile: { id: 'solidity', name: 'Solidity review' },
    });
    assert.equal(result.source, 'panel');
    assert.deepEqual(result.profile, { id: 'panel', name: 'Panel cross-examination: Solidity review' });
    assert.deepEqual(result.reviewed, { id: 'solidity', name: 'Solidity review' });
    assert.deepEqual(result.usage, { input: 500, output: 50 });
    assert.equal(result.stages.length, 2);

    const packet = packetFor(result, {});
    assert.match(packet, /^Produced by: Panel review: 2 model reviews, cross-examined by OpenRouter \/ anthropic\/claude-sonnet-5\.5\.$/m);
    assert.match(packet, /^## Stage 1: anthropic\/claude-sonnet-5\.5$/m);
    assert.match(packet, /^## Stage 2: openai\/gpt-6-astra$/m);
    assert.equal(packet.match(/^## Files$/gm).length, 1);
    assert.equal(snapshot({ ...initialState(), files: FILES, step: 'results', result }).result, result);
  });

  test('Agreement rows are read as counts, kept or dropped, and the reviews behind them', () => {
    const rows = agreementOf(parseReview(answer({ sections: AGREEMENT })));
    assert.deepEqual(rows.map((row) => [row.k, row.n, row.kept]), [[3, 3, true], [1, 3, false], [2, 3, true]]);
    assert.deepEqual(rows.map((row) => row.status), ['kept', 'dropped', 'kept']);
    assert.equal(rows[0].settledBy, 'input-1/src/Vault.sol:12-14');
    assert.match(rows[2].reviewers, /panel-1-a\.md, panel-3-c\.md/);
    assert.deepEqual(agreementOf(parseReview(answer())), []);
    assert.deepEqual(agreementOf(null), []);
  });

  test('an unproven row is neither kept nor dropped, and it can carry the finding card', () => {
    const rows = agreementOf(parseReview(answer({ sections: `## Agreement
- shownBytes multiplies by 1000 | 3/3 | unproven | src/conversion.ts not supplied; input-6/observations.txt:1 | panel-1-a.md, panel-2-b.md, panel-3-c.md
- Header padding changes the count | 1/3 | dropped | input-4/register.md:1 | panel-2-b.md
- Label wraps on narrow screens | 1/3 | withdrawn | none | panel-3-c.md
` })));
    assert.deepEqual(rows.map((row) => [row.status, row.kept]), [['unproven', false], ['dropped', false], ['dropped', false]]);
    // With nothing kept, the unproven finding is the one a card stands for; a dropped row never is.
    const [matched] = matchAgreement([{ title: 'shownBytes multiplies kibibytes by 1000', locations: [] }], rows);
    assert.equal(matched.status, 'unproven');
    assert.deepEqual(matchAgreement([{ title: 'Header padding', locations: [{ label: 'input-4/register.md', start: 1, end: 1 }] }], rows.slice(1)), [null]);
  });

  test('each surviving finding gets its own row: by cited line, then by words, then by order', () => {
    const rows = agreementOf(parseReview(answer({ sections: AGREEMENT })));
    const findings = [
      { title: 'setFeeRecipient lacks the owner check', locations: [{ label: 'input-1/src/Vault.sol', start: 28, end: 31 }] },
      { title: 'stake skips settlement', locations: [{ label: 'input-1/src/Vault.sol', start: 12, end: 14 }] },
    ];
    const matched = matchAgreement(findings, rows);
    assert.equal(matched[0].k, 2);
    assert.equal(matched[1].k, 3);
    // A dropped row is never attached to a surviving finding.
    assert.ok(matched.every((row) => row.kept));
    // Nothing in common and the same count: the order decides.
    const blind = matchAgreement([{ title: 'alpha', locations: [] }, { title: 'beta', locations: [] }], rows);
    assert.deepEqual(blind.map((row) => row.k), [3, 2]);
    // Nothing in common and a different count: no guess.
    assert.deepEqual(matchAgreement([{ title: 'alpha', locations: [] }], rows), [null]);
  });
});

// ---------------------------------------------------------------------------
// The bundled examples
// ---------------------------------------------------------------------------

describe('examples', () => {
  const byId = Object.fromEntries(EXAMPLES.map((example) => [example.id, example]));

  test('two examples in the shape the workbench loads', () => {
    assert.deepEqual(EXAMPLES.map((example) => example.id), ['critical-to-medium', 'confirmed-critical']);
    assert.deepEqual(exampleList({ EXAMPLES }), [...EXAMPLES]);
    for (const example of EXAMPLES) {
      assert.equal(example.profile, 'report');
      assert.equal(example.mode, 'bounty');
      assert.ok(example.title && example.summary);
      assert.match(example.model, /^[a-z0-9-]+\/[a-z0-9.-]+$/);
      assert.ok(!Number.isNaN(Date.parse(example.generatedAt)));
      assert.ok(Object.isFrozen(example) && Object.isFrozen(example.files) && Object.isFrozen(example.context));
    }
  });

  test('the files pass the privacy check with nothing flagged and nothing to accept', () => {
    for (const example of EXAMPLES) {
      const coverage = checkInputs(example.files.map((entry) => ({ ...entry })), example.focus, example.context);
      assert.deepEqual([coverage.blocking, coverage.warnings], [0, 0], example.id);
    }
  });

  test('each stored review parses, cites only supplied lines and reaches the verdict the example is named for', async () => {
    const expected = { 'critical-to-medium': ['rewrite-then-submit', 'medium'], 'confirmed-critical': ['submit', 'critical'] };
    for (const example of EXAMPLES) {
      const manifest = await manifestFor(example.files);
      const analysis = analyse({ review: example.review, manifest });
      assert.ok(analysis.parsed.ok, example.id);
      assert.deepEqual(analysis.problems, [], example.id);
      assert.ok(analysis.refCount > 5, example.id);
      assert.equal(analysis.parsed.verdict, expected[example.id][0], example.id);
      assert.equal(analysis.parsed.findings.length, 1, example.id);
      assert.equal(analysis.parsed.findings[0].severity, expected[example.id][1], example.id);
    }
  });

  test('the first example is a staking contract of about 150 lines with a draft that claims Critical', () => {
    const example = byId['critical-to-medium'];
    const source = example.files.find((entry) => entry.name.endsWith('.sol') && entry.name.startsWith('src/'));
    const length = source.content.split('\n').length;
    assert.ok(length >= 130 && length <= 170, `${length} lines`);
    const draft = example.files.find((entry) => entry.name === 'draft-report.md').content;
    assert.match(draft, /^Severity: Critical$/m);
    assert.match(draft, /Permanent freezing/);
    assert.match(example.context.rules, /^Critical$[\s\S]*^Medium$/m);
    assert.match(example.context.impactRow, /^Critical: /);
  });

  test('the second example supplies a known issue and the review does not call it the same root', () => {
    const example = byId['confirmed-critical'];
    assert.ok(example.files.some((entry) => entry.name === 'docs/known-issues.md'));
    const parsed = parseReview(example.review);
    assert.notEqual(parsed.verdict, 'hold-duplicate');
    // Every claim of the draft is confirmed. (A model may itemise under a claim; only the claim rows are read here.)
    const claims = parsed.sections.find((section) => section.title === 'Claims').rows.filter((row) => /^C\d+$/.test(row[0]));
    assert.ok(claims.length >= 5 && claims.every((row) => row[1] === 'confirmed'));
    assert.ok(parsed.sections.find((section) => section.title === 'Submission checks').rows.every((row) => row[1] !== 'fail'));
  });

  test('the stored gauntlet is a real run: stages in order, each parsed, every citation resolving', async () => {
    const example = byId['critical-to-medium'];
    assert.ok(example.gauntlet, 'the first example carries a gauntlet');
    const { stages } = example.gauntlet;
    assert.deepEqual(stages.map((stage) => stage.profileId), GAUNTLET.slice(0, stages.length));
    // Either the verdict stage ran, or a gate ended the run where a hosted run would stop.
    const records = stages.map((stage, index) => stageRecord({ number: index + 1, ...stage }));
    const ended = records.at(-1);
    assert.ok(ended.profileId === 'verdict' || stopsRun(ended.verdict));
    assert.ok(records.slice(0, -1).every((record) => !stopsRun(record.verdict)));

    const result = await exampleGauntletResult(example);
    assert.equal(result.source, 'gauntlet');
    assert.equal(result.example, example.id);
    assert.equal(result.manifest.length, example.files.length + stages.length - 1);
    for (const [index, record] of records.entries()) {
      // Stage n saw the user's files and the n-1 answers before it, exactly as stageInputs builds them.
      const inputs = stageInputs(example.files.map((entry) => ({ ...entry })), records.slice(0, index), { context: example.context });
      assert.equal(inputs.compact, false);
      const manifest = await manifestFor(inputs.files);
      assert.deepEqual(manifest, result.manifest.slice(0, manifest.length));
      const parsed = parseReview(record.review, { labels: manifest.map((entry) => entry.label) });
      assert.ok(parsed.ok, `stage ${index + 1}`);
      assert.deepEqual(checkRefs(parsed, manifest), [], `stage ${index + 1}`);
      assert.match(record.model, /^[a-z0-9-]+\/[a-z0-9.-]+$/);
    }
    if (isComplete(result)) {
      const decision = decisionOf(analyse(result).parsed);
      assert.ok(decision.rule, 'the verdict stage names the rule that decided');
      assert.ok(decision.severity, 'and the severity to claim');
    }
  });

  test('a stored panel, when an example carries one, is seats first and the cross-examination last', async () => {
    for (const example of EXAMPLES.filter((entry) => entry.panel)) {
      const result = await examplePanelResult(example);
      assert.equal(result.source, 'panel');
      assert.equal(result.stages.length, example.panel.seats.length);
      assert.equal(result.manifest.length, example.files.length + example.panel.seats.length);
      const analysis = analyse(result);
      assert.ok(analysis.parsed.ok);
      assert.deepEqual(analysis.problems, []);
      assert.ok(agreementOf(analysis.parsed).length > 0);
      for (const seat of result.stages) assert.ok(parseReview(seat.review).ok, seat.model);
    }
  });

  test('nothing in an example names a real programme, the owner or a borrowed method', () => {
    // Names that must stay out are read from lists git ignores (./private-lists.mjs): a pattern here would publish the name it guards.
    const banned = /\b(?:immunefi|cantina|sherlock|code4rena|hackerone)\b/i;
    for (const example of EXAMPLES) {
      const text = [...example.files.map((entry) => entry.content), ...Object.values(example.context), example.title, example.summary].join('\n');
      assert.equal(text.match(banned), null, example.id);
      assertNoBannedNames(text, `example ${example.id}`);
      assert.match(text, /[Ss]ynthetic/);
    }
  });

  test('example.mjs is what scripts/build-examples.mjs builds from web/public/examples', async () => {
    const script = fileURLToPath(new URL('../../scripts/build-examples.mjs', import.meta.url));
    const { stdout } = await run(process.execPath, [script, '--check']);
    assert.match(stdout, /up to date/);
    for (const example of EXAMPLES) {
      for (const entry of example.files) {
        const onDisk = (await readFile(new URL(`../public/examples/${example.id}/${entry.name}`, import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
        assert.equal(entry.content, onDisk, `${example.id}/${entry.name}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Rules the code keeps
// ---------------------------------------------------------------------------

describe('rules', () => {
  const rows = String(workbench());
  const ids = [...rows.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

  test('a stage and a panel review are drawn as their own review type', async () => {
    // results.mjs decides by the profile whether a late-numbered Path follows a draft: the answer carries it.
    const dossier = await readFile(new URL('dossier.mjs', APP_DIR), 'utf8');
    assert.match(dossier, /const stageResult = \{ review: stage\.review, manifest: manifest\.slice\(0, baseCount \+ index\), profile: \{ id: stage\.profileId \} \};/);
    assert.match(dossier, /const seatResult = \{ review: seat\.review, manifest: manifest\.slice\(0, baseCount\), profile: result\.reviewed \};/);
    const results = await readFile(new URL('results.mjs', APP_DIR), 'utf8');
    assert.match(results, /draft: result\.profile\?\.id === 'report'/);
    // The bundled panel is a draft review: its first model review starts its Path at step 6.
    const panel = await examplePanelResult(EXAMPLES.find((example) => example.panel));
    assert.equal(panel.reviewed.id, 'report');
    assert.equal(parseReview(panel.stages[0].review).findings[0].pathStart, 6);
  });

  test('the fragment carries the two rows, and every id the runners look up exists once', async () => {
    for (const id of ['wb-row-gauntlet', 'wb-row-panel', 'wb-gauntlet-stages', 'wb-gauntlet-run', 'wb-gauntlet-cancel', 'wb-gauntlet-text', 'wb-panel-seats', 'wb-panel-run', 'wb-panel-live']) {
      assert.equal(ids.filter((entry) => entry === id).length, 1, id);
    }
    const dynamic = new Set(['wb-gauntlet-alt', 'wb-gauntlet-switch', 'wb-panel-add', 'wb-panel-cancel', 'workspace', 'wb-result']);
    const missing = [];
    for (const name of RUNNER_MODULES) {
      const source = await readFile(new URL(name, APP_DIR), 'utf8');
      for (const match of source.matchAll(/qs\('#([a-z][a-z0-9-]*)(?:'| |\[|:|>)/g)) {
        if (!ids.includes(match[1]) && !dynamic.has(match[1])) missing.push(`${name}: #${match[1]}`);
      }
    }
    assert.deepEqual(missing, []);
    // Both rows come after the single run and before the chat-subscription rows.
    assert.ok(rows.indexOf('id="wb-row-run"') < rows.indexOf('id="wb-row-gauntlet"'));
    assert.ok(rows.indexOf('id="wb-row-gauntlet"') < rows.indexOf('id="wb-row-panel"'));
    assert.ok(rows.indexOf('id="wb-row-panel"') < rows.indexOf('id="wb-row-prompt"'));
  });

  test('no runner module parses a string as markup', async () => {
    const banned = new RegExp(['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML', 'document\\.write', 'DOMParser', 'createContextualFragment'].join('|'));
    for (const name of RUNNER_MODULES) {
      const source = await readFile(new URL(name, APP_DIR), 'utf8');
      assert.ok(!banned.test(source), `${name} uses a markup-parsing API`);
    }
  });

  test('no key is written to storage, and a key is never part of a kept run', async () => {
    for (const name of RUNNER_MODULES) {
      const source = await readFile(new URL(name, APP_DIR), 'utf8');
      assert.ok(!/localStorage/.test(source), `${name} uses localStorage`);
      assert.ok(!/writeSession\([^)]*(?:apiKey|token|\bkey\b)/.test(source), `${name} stores a key`);
    }
    const panel = await readFile(new URL('panel.mjs', APP_DIR), 'utf8');
    // What the panel stores: the seats (provider and model) and finished reviews.
    assert.deepEqual([...panel.matchAll(/writeSession\(([A-Z_]+), (\{[^}]*\})/g)].map((match) => [match[1], match[2]]), [
      ['SEATS_KEY', '{ seats, judge }'],
      ['RUN_KEY', '{ v: 1, signature: held.signature, records: held.records }'],
    ]);
  });

  test('the stylesheet uses tokens only, and every token exists', async () => {
    const css = await readFile(new URL('../public/css/runners.css', import.meta.url), 'utf8');
    const base = await readFile(new URL('../public/css/base.css', import.meta.url), 'utf8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual(rules.match(/#[0-9a-fA-F]{3,8}\b(?![^{]*\{)/g) ?? [], [], 'a colour that is not a token');
    assert.ok(!/\b(?:rgb|hsl)a?\(/.test(rules));
    const defined = new Set([...base.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const used = new Set([...rules.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]));
    assert.deepEqual([...used].filter((name) => !defined.has(name)), []);
    assert.ok(!/font-size:\s*(?:0\.[0-6]\d*rem|[0-9]px|1[01]px)/.test(rules));
  });

  test('the copy keeps the voice and the price', async () => {
    const banned = /\b(?:simply|powerful|seamless|not a guarantee|can help|we cannot|free trial|discount)\b|!['"`]\s*[,)]/i;
    const sources = [rows];
    for (const name of RUNNER_MODULES) sources.push(await readFile(new URL(name, APP_DIR), 'utf8'));
    for (const source of sources) {
      assertNoBannedNames(source, 'runner copy');
      const hit = source.match(banned);
      assert.equal(hit, null, hit ? `banned wording: ${hit[0]}` : '');
    }
    const gauntlet = await readFile(new URL('gauntlet.mjs', APP_DIR), 'utf8');
    // One price, in the words the account panel uses. No dash in a button label.
    assert.deepEqual([...new Set(gauntlet.match(/US\$\d+(?:\/| a | per )\w+/g))], ['US$10 a week']);
    for (const source of sources) assert.doesNotMatch(source, /label: [`'"][^`'"\n]*—/);
  });

  test('the two unlisted profiles are the ones the runs end with', () => {
    assert.deepEqual(PROFILES.filter((profile) => !profile.listed).map((profile) => profile.id), ['verdict', 'panel']);
    assert.equal(GAUNTLET.at(-1), 'verdict');
    assert.equal(GAUNTLET.length, 8);
  });

  test('the plan is checked before the key, the sign-in and the privacy check', async () => {
    const gauntlet = await readFile(new URL('gauntlet.mjs', APP_DIR), 'utf8');
    const preflight = gauntlet.slice(gauntlet.indexOf('export async function preflight('), gauntlet.indexOf('// The run', gauntlet.indexOf('export async function preflight(')));
    const plan = preflight.indexOf("if (plan !== 'operator') {");
    assert.ok(plan > 0, 'preflight stops a plan that is not Operator');
    // Nothing that asks for a key, signs in or reads the files comes before it.
    for (const later of ['checkCredentials()', 'credentials()', 'scan(state)']) assert.ok(preflight.indexOf(later) > plan, later);
    assert.equal(preflight.slice(0, plan).includes('ensureSignedIn'), false);
    assert.match(preflight.slice(plan), /showNote\(upgradeNote\(\{ feature, plan, retry \}\)\);[\s\S]*?return null;/);

    // Both runs go through it before their first request.
    const panel = await readFile(new URL('panel.mjs', APP_DIR), 'utf8');
    for (const [name, source, run] of [['gauntlet.mjs', gauntlet, 'export async function runGauntlet('], ['panel.mjs', panel, 'export async function runPanel(']]) {
      const body = source.slice(source.indexOf(run));
      assert.ok(body.indexOf('await preflight({') > 0, name);
      assert.ok(body.indexOf('await preflight({') < body.indexOf('streamReview({'), `${name}: the plan check comes before the first request`);
    }
  });

  test('a stage or a cross-examination the server refuses for the plan shows the Operator panel, not the daily one', async () => {
    const gauntlet = await readFile(new URL('gauntlet.mjs', APP_DIR), 'utf8');
    assert.match(gauntlet, /const used = !failure\.operatorOnly;\s+showNote\(upgradeNote\(\{ feature: 'gauntlet', plan: [^}]+, kept: done, used, retry: \(\) => runGauntlet\(\) \}\)\);/);
    // The refused stage never started, so it is not painted as failed.
    assert.match(gauntlet, /!\['daily_used', 'operator_only', 'signin'\]\.includes\(stop\.error\?\.code\)/);

    const panel = await readFile(new URL('panel.mjs', APP_DIR), 'utf8');
    assert.match(panel, /failure\?\.code === 'daily_used' \|\| failure\?\.code === 'operator_only'/);
    assert.match(panel, /const used = failure\.code === 'daily_used';/);

    // A single run never sends an unlisted profile: it is stopped before the key is read.
    const run = await readFile(new URL('run.mjs', APP_DIR), 'utf8');
    const body = run.slice(run.indexOf('export async function runReview('));
    assert.ok(body.indexOf('if (!listedProfile(state.profile)) {') > 0);
    assert.ok(body.indexOf('if (!listedProfile(state.profile)) {') < body.indexOf('checkCredentials()'));
    assert.ok(body.indexOf('if (!listedProfile(state.profile)) {') < body.indexOf('streamReview({'));
    // Stored state and links cannot carry one in either.
    const state = await readFile(new URL('state.mjs', APP_DIR), 'utf8');
    assert.match(state, /return profile\.listed \? profile\.id : 'general';/);
    const main = await readFile(new URL('main.mjs', APP_DIR), 'utf8');
    assert.match(main, /if \(found\?\.listed\) profile = found\.id;/);
  });
});
