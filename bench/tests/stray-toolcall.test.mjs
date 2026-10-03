// A host that cannot parse a model's native tool-call format hands the call back as text:
// the message carries no tool call and no answer, only reasoning (or text) that ends in the
// call's arguments. That is a provider fault, retried like a network error, never an answer.
import test from 'node:test';
import assert from 'node:assert/strict';

import { endsInToolArguments, parseEvents } from '../lib/parse.mjs';
import { classifyRun } from '../lib/runs.mjs';

const okChecks = { requests: true, ok: true };
const res = { spawnError: null, timedOut: false, sawModelOutput: true, exitCode: 0 };
const usage = { input: 5000, output: 200, cacheRead: 0, cacheWrite: 0 };
const assistant = (content, stopReason = 'stop') => JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'a/b', provider: 'openrouter', stopReason, usage, content } });
const classify = (...lines) => classifyRun({ res, ev: parseEvents(lines.join('\n')), checks: okChecks });

const SHEET = 'Reviewed.\n```json\n{"findings":[{"file":"src/A.sol","function":"withdraw","line_start":10,"line_end":14,"severity":"high","claim":"x"}],"rejected":[],"verdict":"n/a","max_severity":"high"}\n```';

test('reasoning or text that ends in file-tool arguments is recognised', () => {
  assert.equal(endsInToolArguments('We need to read them.{ "path": "programme.md" }'), true);
  assert.equal(endsInToolArguments('Let\'s explore the workspace.{\n  "path": ".",\n  "hidden": false,\n  "gitignore": true,\n  "limit": 1000\n}\n'), true);
  assert.equal(endsInToolArguments('search for it {"pattern":"onlyOwner\\\\b","path":"src"}'), true);
  assert.equal(endsInToolArguments('a brace inside a string {"path":"src/{a,b}.sol"}'), true);
  assert.equal(endsInToolArguments('The answer is final.'), false);
  assert.equal(endsInToolArguments('{"findings":[],"rejected":[],"verdict":"n/a","max_severity":"unrated"}'), false, 'an answer sheet is not tool arguments');
  assert.equal(endsInToolArguments('{"findings":[{"file":"a","path":"b"}]}'), false, 'a nested path does not count');
  assert.equal(endsInToolArguments('{"path": 3}'), false);
  assert.equal(endsInToolArguments('broken {"path": "a"'), false);
  assert.equal(endsInToolArguments(''), false);
  assert.equal(endsInToolArguments(null), false);
});

test('call markup in a model\'s own token format is recognised when it ends the message', () => {
  // as returned for a model whose host left three parallel calls unparsed
  const native = '<tool_call>\n]<]minimax[>[<invoke name="read">]<]minimax[>[<path>src/Till.sol]<]minimax[>[</path>]<]minimax[>[</invoke>\n]<]minimax[>[<invoke name="read">]<]minimax[>[<path>src/Gage.sol]<]minimax[>[</path>]<]minimax[>[</invoke>\n]<]minimax[>[</tool_call>';
  assert.equal(endsInToolArguments(native), true);
  assert.equal(endsInToolArguments('<|channel|>commentary to=functions.read<|message|>{"file":"a.sol"}'), true);
  assert.equal(endsInToolArguments('<function=grep>{"query": "onlyOwner"}</function>'), true);
  assert.equal(endsInToolArguments('Next step.\n<tool_call>\n{"name": "glob", "arguments": {"glob": "**/*.sol"}}\n</tool_call>'), true);
  assert.equal(endsInToolArguments('{"name": "read", "arguments": {"file_path": "src/A.sol"}}'), true, 'a function-call wrapper around the arguments');
  assert.equal(endsInToolArguments('<invoke name="deploy"><target>mainnet</target></invoke>'), false, 'markup that names none of the three tools');
  assert.equal(endsInToolArguments('I tried <invoke name="read"> earlier, and it worked. The code is safe.'), false, 'markup that is followed by prose');
  assert.equal(endsInToolArguments('{"name": "read"}'), false);
});

test('unparsed call markup as the whole answer is the same infrastructure failure', () => {
  const stray = classify(assistant([{ type: 'text', text: '<tool_call>\n]<]minimax[>[<invoke name="read">]<]minimax[>[<path>src/Till.sol]<]minimax[>[</path>]<]minimax[>[</invoke>\n]<]minimax[>[</tool_call>' }]));
  assert.deepEqual([stray.failure, stray.final, stray.retry], ['infra', false, true]);
});

test('an answer sheet always wins: text that also mentions call markup is an answer', () => {
  const sheet = '{"findings":[],"rejected":[],"verdict":"n/a","max_severity":"unrated"}';
  const answered = classify(assistant([{ type: 'text', text: `The earlier <invoke name="read"> calls covered every file.\n\`\`\`json\n${sheet}\n\`\`\`` }]));
  assert.deepEqual([answered.status, answered.final], ['ok', true]);
  const bare = classify(assistant([{ type: 'text', text: `I used to=functions.read on each file. ${sheet}` }]));
  assert.deepEqual([bare.status, bare.final], ['ok', true], 'a bare sheet at the end is still a sheet');
});

test('a tool call returned as reasoning text is an infrastructure failure, retried and never final', () => {
  const stray = classify(
    assistant([{ type: 'thinking', thinking: 'List the files first.' }, { type: 'toolCall', id: 't1', name: 'glob', arguments: { pattern: '**/*' } }], 'toolUse'),
    assistant([{ type: 'thinking', thinking: 'We have three files. We need to read them.{ "path": "programme.md" }' }]),
  );
  assert.deepEqual([stray.status, stray.failure, stray.final, stray.retry, stray.halt], ['failed', 'infra', false, true, null]);
  assert.match(stray.detail, /tool call as reasoning text/);
});

test('the same call returned as answer text is the same fault', () => {
  const stray = classify(assistant([{ type: 'text', text: 'I will read the draft now.\n{"path": "draft-report.md"}' }]));
  assert.deepEqual([stray.failure, stray.final, stray.retry], ['infra', false, true]);
});

test('an answer is an answer, whatever the reasoning ends in', () => {
  const answered = classify(assistant([{ type: 'thinking', thinking: 'Earlier I ran {"path": "src/A.sol"}' }, { type: 'text', text: SHEET }]));
  assert.deepEqual([answered.status, answered.final], ['ok', true]);
});

test('an empty reply with ordinary reasoning stays the model\'s own failure', () => {
  const empty = classify(assistant([{ type: 'thinking', thinking: 'I have looked at everything and have nothing to add.' }]));
  assert.deepEqual([empty.status, empty.final], ['ok', true], 'classified as a finished run; the scorer then reads an empty sheet and marks the input wrong');
  const noReasoning = classify(assistant([]));
  assert.deepEqual([noReasoning.status, noReasoning.final], ['ok', true]);
});

test('an account-level gate on a model stops that model and is never scored', async () => {
  const { classifyError } = await import('../lib/runs.mjs');
  assert.deepEqual(classifyError(403, '403 This model requires you to complete the following before use: 18+ age confirmation. Confirm at https://openrouter.ai/settings/preferences.'), { kind: 'unavailable', retry: false, halt: 'model' });
  assert.deepEqual(classifyError(403, 'This model is not available in your region'), { kind: 'unavailable', retry: false, halt: 'model' });
  assert.equal(classifyError(403, 'Your chosen model requires moderation and your input was flagged for violence').kind, 'error', 'a moderation refusal stays the model\'s own failure');
});

test('a real tool call in the last message is not a stray one', () => {
  const calling = classify(assistant([{ type: 'thinking', thinking: 'read it {"path": "a.sol"}' }, { type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'a.sol' } }], 'toolUse'));
  assert.equal(calling.failure, 'timeout', 'a session that ends on a tool call ran out of time between turns');
});
