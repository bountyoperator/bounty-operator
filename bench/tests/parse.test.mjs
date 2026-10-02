import test from 'node:test';
import assert from 'node:assert/strict';
import { compactEvent, extractSheet, normSeverity, normVerdict, normalizeSheet, parseEvents, parseRequests, requestEffort, requestSystem, requestTools } from '../lib/parse.mjs';

const F = '```';
const finding = { file: 'src/Vault.sol', function: 'deposit', line_start: 70, line_end: 77, severity: 'high', claim: 'x' };
const sheetJson = JSON.stringify({ findings: [finding], rejected: [], verdict: 'n/a', max_severity: 'high' });

test('clean fenced sheet', () => {
  const r = extractSheet(`Review done.\n\n${F}json\n${sheetJson}\n${F}\n`);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'fence');
  assert.equal(r.repaired, false);
  assert.deepEqual(r.sheet.findings[0], finding);
  assert.equal(r.sheet.verdict, 'n/a');
});

test('the last parseable sheet wins over code blocks and an echoed template', () => {
  const template = '{"findings":[{"file":"","function":"","line_start":0,"line_end":0,"severity":"critical|high|medium|low|info|unrated","claim":""}],"rejected":[{"quote":""}],"verdict":"supported|overclaimed|unsupported|n/a","max_severity":"critical|high|medium|low|info|unrated"}';
  const text = [
    'The sheet format is:', `${F}json`, template, F,
    'Vulnerable code:', `${F}solidity`, 'function deposit() external { if (x) { y(); } }', F,
    '## Answer', `${F}json`, sheetJson, F, '', 'Thanks!',
  ].join('\n');
  const r = extractSheet(text);
  assert.equal(r.ok, true);
  assert.equal(r.sheet.findings.length, 1);
  assert.equal(r.sheet.findings[0].function, 'deposit');
});

test('trailing commas, comments, CRLF and a tilde fence are repaired', () => {
  const messy = `~~~json\r\n{\r\n  // main issue\r\n  "findings": [\r\n    {"file": "a.sol", "function": "f", "line_start": "12", "line_end": 15, "severity": "High", "claim": "c",},\r\n  ],\r\n  /* none */ "rejected": [],\r\n  "verdict": "N/A",\r\n  "max_severity": "HIGH",\r\n}\r\n~~~`;
  const r = extractSheet(messy);
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.sheet.findings[0], { file: 'a.sol', function: 'f', line_start: 12, line_end: 15, severity: 'high', claim: 'c' });
  assert.equal(r.sheet.max_severity, 'high');
});

test('comment markers and braces inside strings survive repair', () => {
  const obj = { findings: [{ file: 'a.ts', function: 'h', line_start: 3, line_end: 4, severity: 'medium', claim: 'url http://x/y // not a comment, braces { } and "quotes"' }], rejected: [], verdict: 'n/a', max_severity: 'medium' };
  const r = extractSheet(`${F}json\n${JSON.stringify(obj, null, 2).replace(/\n\}$/, ',\n}')}\n${F}`);
  assert.equal(r.ok, true);
  assert.equal(r.sheet.findings[0].claim, obj.findings[0].claim);
});

test('unterminated fence, untagged fence and bare JSON are all found', () => {
  assert.equal(extractSheet(`Answer:\n${F}json\n${sheetJson}`).source, 'open-fence');
  assert.equal(extractSheet(`Answer:\n${F}\n${sheetJson}\n${F}`).source, 'fence');
  const bare = extractSheet(`My answer is ${sheetJson} and that is all.`);
  assert.equal(bare.ok, true);
  assert.equal(bare.source, 'bare');
  const single = extractSheet(`${F}json ${sheetJson} ${F}`);
  assert.equal(single.ok, true);
  const afterStrayQuote = extractSheet(`He said "use { carefully.\n\n${sheetJson}`);
  assert.equal(afterStrayQuote.ok, true);
  assert.equal(afterStrayQuote.sheet.findings[0].line_start, 70);
});

test('failures: empty, no sheet, broken JSON, wrong shape', () => {
  assert.deepEqual(extractSheet(''), { ok: false, reason: 'empty' });
  assert.deepEqual(extractSheet('   \n'), { ok: false, reason: 'empty' });
  assert.deepEqual(extractSheet(undefined), { ok: false, reason: 'empty' });
  assert.deepEqual(extractSheet('I cannot help with security reviews.'), { ok: false, reason: 'no_sheet' });
  assert.deepEqual(extractSheet(`${F}json\n{"findings": [ {"file": "a.sol", \n${F}`), { ok: false, reason: 'bad_json' });
  assert.deepEqual(extractSheet(`${F}json\n["findings"]\n${F}`), { ok: false, reason: 'bad_json' });
  assert.deepEqual(extractSheet(`${F}json\n{"summary": "nothing"}\n${F}`), { ok: false, reason: 'no_sheet' });
});

test('normalisation of odd values never throws', () => {
  const s = normalizeSheet({
    findings: [
      'not an object', null,
      { path: 'x.sol', fn: 'g', line: 'L40-45', severity: 'Informational' },
      { file: 'y.sol', function: null, line_start: 9, line_end: 3, severity: 'whatever' },
      { file: 'z.sol', line_start: -4, severity: '' },
    ],
    rejected: ['a plain string quote', { quote: 'an object quote' }, { quote: '   ' }, 7],
    verdict: 'Over-claimed',
    maxSeverity: 'crit',
  });
  assert.equal(s.findings.length, 3);
  assert.deepEqual(s.findings[0], { file: 'x.sol', function: 'g', line_start: 40, line_end: 40, severity: 'info', claim: '' });
  assert.deepEqual([s.findings[1].line_start, s.findings[1].line_end, s.findings[1].severity], [9, 9, 'unrated']);
  assert.deepEqual([s.findings[2].line_start, s.findings[2].severity], [0, 'unrated']);
  assert.deepEqual(s.rejected, [{ quote: 'a plain string quote' }, { quote: 'an object quote' }]);
  assert.equal(s.verdict, 'overclaimed');
  assert.equal(s.max_severity, 'critical');
  assert.deepEqual(normalizeSheet(null), { findings: [], rejected: [], verdict: 'n/a', max_severity: 'unrated' });
  assert.deepEqual(normalizeSheet({ findings: 'none' }).findings, []);
});

test('severity and verdict vocabularies', () => {
  assert.deepEqual(['Critical', 'HIGH', 'med', 'Low', 'informational', 'unrated', '', undefined, 'severe'].map(normSeverity), ['critical', 'high', 'medium', 'low', 'info', 'unrated', 'unrated', 'unrated', 'unrated']);
  assert.deepEqual(['supported', 'Overclaimed', 'not supported', 'N/A', '', 'maybe'].map(normVerdict), ['supported', 'overclaimed', 'unsupported', 'n/a', 'n/a', 'invalid']);
});

const line = (o) => JSON.stringify(o);
const assistant = (extra) => ({ type: 'message_end', message: { role: 'assistant', api: 'openrouter', provider: 'openrouter', model: 'openai/gpt-oss-120b', ...extra } });

test('parseEvents sums usage and cost and finds the final answer', () => {
  const events = [
    line({ type: 'session', cwd: 'D:\\pdw\\a\\b\\ws' }),
    line({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'task' }] } }),
    line(assistant({ content: [{ type: 'thinking', thinking: 'hm' }, { type: 'toolCall', id: 't1', name: 'read', arguments: { path: '../x' } }], usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, reasoningTokens: 7, cost: { total: 0.001 } }, stopReason: 'toolUse', responseId: 'gen-1' })),
    line({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: '../x' } }),
    line({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: { content: [{ type: 'text', text: 'Blocked by benchmark sandbox (parent traversal): only relative paths inside the workspace are readable.' }] }, isError: true }),
    'not json at all',
    line(assistant({ content: [{ type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }], usage: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } }, stopReason: 'stop', responseId: 'gen-2' })),
    line({ type: 'agent_end', stub: true, messages: 4 }),
  ].join('\n');
  const ev = parseEvents(events);
  assert.equal(ev.bad, 1);
  assert.equal(ev.cwd, 'D:\\pdw\\a\\b\\ws');
  assert.deepEqual(ev.usage, { input: 300, output: 70, cacheRead: 5, cacheWrite: 0, reasoning: 7 });
  assert.ok(Math.abs(ev.costReported - 0.003) < 1e-12);
  assert.equal(ev.finalText, 'Part one. Part two.');
  assert.equal(ev.stopReason, 'stop');
  assert.deepEqual(ev.responseIds, ['gen-1', 'gen-2']);
  assert.deepEqual(ev.tools, [{ name: 'read', path: '../x', isError: true, blocked: true }]);
  assert.deepEqual(ev.models, ['openai/gpt-oss-120b']);
  assert.equal(parseEvents('').final, null);
  assert.equal(parseEvents(line(assistant({ content: [], usage: { input: 0, output: 0 }, stopReason: 'error', errorStatus: 429, errorMessage: 'rate limited' }))).costReported, null);
});

test('compactEvent drops streaming deltas and stubs repeated payloads', () => {
  assert.equal(compactEvent({ type: 'message_update', delta: 'x' }), null);
  assert.equal(compactEvent({ type: 'message_start' }), null);
  assert.equal(compactEvent({ type: 'tool_execution_update' }), null);
  assert.deepEqual(compactEvent({ type: 'agent_end', messages: [1, 2, 3], isTerminal: true, yielded: true }), { type: 'agent_end', stub: true, messages: 3, isTerminal: true, yielded: true });
  assert.deepEqual(compactEvent({ type: 'turn_end', message: { big: 1 }, toolResults: [1] }), { type: 'turn_end', stub: true, toolResults: 1 });
  const kept = { type: 'message_end', message: { role: 'assistant' } };
  assert.equal(compactEvent(kept), kept);
});

test('request bodies: effort, tools and system prompt in both wire formats', () => {
  const responses = { model: 'openai/gpt-oss-120b', instructions: 'SYS\n\nrun-nonce: abc', input: [{ role: 'user', content: [{ type: 'input_text', text: 'task' }] }], tools: [{ type: 'function', name: 'read' }, { type: 'function', name: 'grep' }, { type: 'function', name: 'glob' }], reasoning: { effort: 'high', summary: 'auto' } };
  const chat = { model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'system', content: [{ type: 'text', text: 'SYS' }] }, { role: 'user', content: 'task' }], tools: [{ type: 'function', function: { name: 'glob' } }, { type: 'function', function: { name: 'read' } }, { type: 'function', function: { name: 'grep' } }], reasoning: { effort: 'xhigh' }, provider: { order: ['x'] } };
  assert.equal(requestEffort(responses), 'high');
  assert.equal(requestEffort(chat), 'xhigh');
  assert.equal(requestEffort({ reasoning_effort: 'low' }), 'low');
  assert.equal(requestEffort({ reasoning: { enabled: false } }), 'disabled');
  assert.equal(requestEffort({ reasoning: { max_tokens: 32000 } }), 'budget:32000');
  assert.equal(requestEffort({ thinking: { type: 'enabled', budget_tokens: 1024 } }), 'budget:1024');
  assert.equal(requestEffort({ output_config: { effort: 'max' }, thinking: { type: 'adaptive' } }), 'max');
  assert.equal(requestEffort({}), 'none');
  assert.deepEqual(requestTools(responses), ['read', 'grep', 'glob']);
  assert.deepEqual(requestTools(chat), ['glob', 'read', 'grep']);
  assert.deepEqual(requestTools({ tools: [{ type: 'web_search' }] }), ['<web_search>']);
  assert.equal(requestSystem(responses), 'SYS\n\nrun-nonce: abc');
  assert.equal(requestSystem(chat), 'SYS');
  const parsed = parseRequests(`${JSON.stringify(responses)}\n${JSON.stringify(responses)}\nbroken\n`);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.bad, 1);
  assert.deepEqual(parsed.efforts, ['high']);
  assert.deepEqual(parsed.toolsets, ['glob,grep,read']);
  assert.deepEqual(parsed.models, ['openai/gpt-oss-120b']);
  assert.equal(parsed.summaries[0].wire, 'responses');
  assert.deepEqual(parseRequests(JSON.stringify(chat)).routing, ['{"order":["x"]}']);
});
