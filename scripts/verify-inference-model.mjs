#!/usr/bin/env node
// Live deployment check. Uses synthetic fixtures only; never prints credentials.
// RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be supplied by the operator.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const endpoint = process.env.RUNPOD_ENDPOINT_ID;
const key = process.env.RUNPOD_API_KEY;
if (!/^[a-z0-9]+$/.test(endpoint ?? '') || !key) throw new Error('Supply RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY.');
const base = `https://${endpoint}.api.runpod.ai`;
const model = process.env.INFERENCE_TEST_MODEL ?? 'cyber-qwen-27b-awq';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const results = [];

async function chat(name, messages, extra = {}, verify = () => {}) {
  const started = performance.now();
  const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, signal: AbortSignal.timeout(180000), body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 512, chat_template_kwargs: { enable_thinking: false }, ...extra }) });
  const body = await response.json();
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
  assert.ok(Number.isInteger(body.usage?.prompt_tokens) && Number.isInteger(body.usage?.completion_tokens), `${name}: usage missing`);
  verify(body);
  const seconds = (performance.now() - started) / 1000;
  const record = { name, passed: true, seconds: Number(seconds.toFixed(3)), prompt_tokens: body.usage.prompt_tokens, completion_tokens: body.usage.completion_tokens, tokens_per_second: Number((body.usage.completion_tokens / seconds).toFixed(2)), response: body.choices[0].message };
  results.push(record);
  console.log(JSON.stringify({ ...record, response: undefined }));
  return body;
}

await chat('plain', [{ role: 'user', content: 'Reply with exactly READY.' }], { max_tokens: 16 }, (body) => assert.equal(body.choices[0].message.content.trim(), 'READY'));
if (process.argv.includes('--cold')) {
  await writeFile('.local/inference-cold-start.json', JSON.stringify({ tested_at: new Date().toISOString(), endpoint, model, results }, null, 2) + '\n');
  process.exit(0);
}
await chat('security-fixture', [{ role: 'user', content: 'Review this synthetic route. Give the concrete security issue and a minimal fix in fewer than 100 words. The authenticated user ID is req.user.id; invoice.owner_id identifies its owner. Code: app.get("/invoice/:id", requireLogin, async (req,res)=>{ const invoice=await db.invoices.findById(req.params.id); res.json(invoice); });' }], { max_tokens: 256 }, (body) => assert.match(body.choices[0].message.content, /authoriz|ownership|owner|IDOR|access control/i));
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file in the authorized workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
const toolMessages = [{ role: 'user', content: 'Use read_file to inspect /workspace/example.ts. Call the tool before answering.' }];
const called = await chat('tool-call', toolMessages, { tools, tool_choice: 'auto', max_tokens: 128 }, (body) => { assert.equal(body.choices[0].message.tool_calls?.[0]?.function.name, 'read_file'); assert.equal(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments).path, '/workspace/example.ts'); });
const call = called.choices[0].message.tool_calls[0];
await chat('tool-result', [...toolMessages, called.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'export const answer = 42;' }, { role: 'user', content: 'What is the exported value? Reply with the number only.' }], { tools, max_tokens: 64 }, (body) => assert.match(body.choices[0].message.content, /42/));
await chat('structured-output', [{ role: 'user', content: 'Return status ready and count 2.' }], { max_tokens: 64, response_format: { type: 'json_schema', json_schema: { name: 'check', strict: true, schema: { type: 'object', properties: { status: { type: 'string', enum: ['ready'] }, count: { type: 'integer' } }, required: ['status', 'count'], additionalProperties: false } } } }, (body) => assert.deepEqual(JSON.parse(body.choices[0].message.content), { status: 'ready', count: 2 }));
await chat('long-input', [{ role: 'user', content: `Remember the marker: COPPER-741.\n${'This is synthetic context for a service acceptance test. '.repeat(1600)}\nWhat was the marker? Reply with only the marker.` }], { max_tokens: 32 }, (body) => assert.match(body.choices[0].message.content, /COPPER-741/));
await chat('throughput', [{ role: 'user', content: 'Write a detailed numbered checklist for reviewing a small web application for broken access control. Use at least 500 words.' }], { max_tokens: 512 }, (body) => assert.ok(body.usage.completion_tokens >= 300));

const started = performance.now();
const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, signal: AbortSignal.timeout(180000), body: JSON.stringify({ model, messages: [{ role: 'user', content: 'List the numbers 1 through 10, separated by spaces.' }], stream: true, stream_options: { include_usage: true, continuous_usage_stats: true }, max_tokens: 96, temperature: 0, chat_template_kwargs: { enable_thinking: false } }) });
assert.equal(response.status, 200);
const reader = response.body.getReader();
const decoder = new TextDecoder();
let text = '', firstTokenMs = null;
for (;;) { const part = await reader.read(); if (part.done) break; if (firstTokenMs === null) firstTokenMs = performance.now() - started; text += decoder.decode(part.value, { stream: true }); }
const chunks = text.split('\n\n').flatMap((event) => { const data = event.split('\n').find((line) => line.startsWith('data: '))?.slice(6); return data && data !== '[DONE]' ? [JSON.parse(data)] : []; });
assert.match(text, /data: \[DONE\]/);
assert.ok(chunks.filter((chunk) => chunk.usage?.completion_tokens > 0).length > 1, 'continuous usage not supplied');
assert.ok(chunks.some((chunk) => chunk.choices.length === 0 && chunk.usage?.completion_tokens > 0), 'final usage missing');
const streamResult = { name: 'stream', passed: true, first_token_ms: Math.round(firstTokenMs), seconds: Number(((performance.now() - started) / 1000).toFixed(3)), usage: chunks.at(-1).usage };
results.push(streamResult);
console.log(JSON.stringify(streamResult));
const report = { tested_at: new Date().toISOString(), endpoint, model, results };
await writeFile(process.env.INFERENCE_TEST_REPORT ?? '.local/inference-model-acceptance.json', JSON.stringify(report, null, 2) + '\n');
