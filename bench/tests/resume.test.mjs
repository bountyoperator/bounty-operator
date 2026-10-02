import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, classifyError, classifyRun, harnessChecks, modelDir, protocolHash, resumeKey, runFacts, runName, toScoreRun } from '../lib/runs.mjs';
import { inputHash, loadCases } from '../lib/cases.mjs';
import { costFromTokens, modelInfo, readKey, redact } from '../lib/openrouter.mjs';
import { loadProtocol, parseArgs, protocolDrift, storedRun } from '../bench.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = { armSha: 'p'.repeat(64), model: 'openai/gpt-oss-120b', inputHash: 'c'.repeat(64), arm: 'raw', rep: 1 };

test('the resume key is stable and depends on every component', () => {
  // pinned: a change here would make every stored run look new and re-bill it
  assert.equal(resumeKey(base), '76015f4f5da04b8501de3eebce448fb5d79a651ac5f5a4780ae9fd160940eaaa');
  assert.equal(resumeKey({ ...base }), resumeKey(base));
  assert.equal(resumeKey({ ...base, rep: '1' }), resumeKey(base), 'the repeat is compared as text');
  const variants = [{ armSha: 'q'.repeat(64) }, { model: 'openai/gpt-oss-120b:free' }, { inputHash: 'd'.repeat(64) }, { arm: 'solidity' }, { rep: 2 }];
  const keys = new Set(variants.map((v) => resumeKey({ ...base, ...v })));
  keys.add(resumeKey(base));
  assert.equal(keys.size, variants.length + 1);
  // a key is never made without the hash of its arm (a profile with no frozen text has none)
  assert.throws(() => resumeKey({ ...base, armSha: null }), /no hash for the raw arm/);
  assert.throws(() => resumeKey({ ...base, armSha: undefined, arm: 'solidity' }), /no hash for the solidity arm/);
});

test('canonical JSON and the protocol hash ignore key order', () => {
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
  assert.equal(protocolHash({ b: 1, a: [1, { d: 2, c: 3 }] }), 'e23f8d4197e06fb14090fd7ae275b6f9f4e8449202851dab79c411cb3426d4a2');
  assert.equal(protocolHash({ a: [1, { c: 3, d: 2 }], b: 1 }), protocolHash({ b: 1, a: [1, { d: 2, c: 3 }] }));
  assert.notEqual(protocolHash({ a: [1, 2] }), protocolHash({ a: [2, 1] }), 'array order is content');
  assert.equal(protocolHash({ b: 1, a: [1, { d: 2, c: 3 }], hashes: { protocol: 'x', core: 'y', arms: {} } }), protocolHash({ b: 1, a: [1, { d: 2, c: 3 }] }), 'the hashes block that freeze writes into the file is not part of what is hashed');
});

test('run directory names', () => {
  assert.equal(modelDir('nvidia/nemotron-3-ultra-550b-a55b'), 'nvidia__nemotron-3-ultra-550b-a55b');
  assert.equal(modelDir('openai/gpt-oss-120b:free'), 'openai__gpt-oss-120b__free');
  assert.equal(runName('sol-01-v', 'solidity', 3), 'sol-01-v.solidity.3');
});

test('the case input hash covers what the model sees and nothing else', () => {
  const [kase] = loadCases([path.join(HERE, 'fixtures', 'cases')], { glob: 'fx-01-v' });
  const h = inputHash(kase);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(inputHash({ ...kase, truth: { changed: true }, truthMd: 'changed' }), h, 'editing the answer key keeps stored runs valid');
  assert.notEqual(inputHash({ ...kase, case: { ...kase.case, focus: 'Another task.' } }), h);
  assert.notEqual(inputHash({ ...kase, workspace: kase.workspace.map((f, i) => (i ? f : { ...f, sha256: '0'.repeat(64) })) }), h);
  assert.notEqual(inputHash({ ...kase, id: 'fx-01-x' }), h);
});

test('a stored run is skipped only when it is final and its key matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-resume-'));
  try {
    const [kase] = loadCases([path.join(HERE, 'fixtures', 'cases')], { glob: 'fx-01-v' });
    const task = { model: 'openai/gpt-oss-120b', kase, arm: 'raw', rep: 1 };
    const dir = path.join(root, 'raw', modelDir(task.model), runName(kase.id, 'raw', 1));
    fs.mkdirSync(dir, { recursive: true });
    const key = resumeKey({ armSha: 'c1', model: task.model, inputHash: kase.inputHash, arm: 'raw', rep: 1 });
    const write = (meta) => fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    // the hashes of a protocol: the raw arm runs under the core hash, each profile arm under its own
    const h = { core: 'c1', arms: { raw: 'c1', solidity: 's1' } };
    assert.equal(storedRun(root, h, task, []), null, 'no meta.json: an interrupted run is redone');
    write({ key, final: true, failure: null });
    assert.ok(storedRun(root, h, task, []));
    assert.equal(storedRun(root, { core: 'c2', arms: { raw: 'c2', solidity: 's1' } }, task, []), null, 'another core hash');
    assert.ok(storedRun(root, { core: 'c1', arms: { raw: 'c1', solidity: 's2' } }, task, []), 'another profile hash does not concern a raw-arm run');
    assert.equal(storedRun(root, h, { ...task, rep: 2 }, []), null);
    assert.equal(storedRun(root, h, { ...task, arm: 'general' }, []), null, 'an arm without a hash (no text frozen) has no stored run');
    write({ key, final: false, failure: 'infra' });
    assert.equal(storedRun(root, h, task, []), null, 'infrastructure failures are retried on the next invocation');
    write({ key, final: true, failure: 'timeout' });
    assert.ok(storedRun(root, h, task, []), 'a model failure is a completed run and is never re-rolled');
    assert.equal(storedRun(root, h, task, ['timeout']), null, 'unless --redo names its failure kind');
    // a run stored before the hashes were split: its key was made with the hash of the whole protocol.json
    write({ key: 'ea1794d0a2822dc9962f2fdf663117a29d59907a22ac942a39a28268ea5d3bab', final: true, failure: null, protocol_sha256: '1f59eab60de1754b79ad94dacf6f27d4945b8e74360a6d0feec21f7e4e30bd8d' });
    assert.equal(storedRun(root, h, task, []), null, 'an old run folder is read without error and its runs are not taken for current ones');
    write({ final: true });
    assert.equal(storedRun(root, h, task, []), null, 'nor is a record without a key');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('protocol.json matches the prompt and harness files on disk', () => {
  const { protocol, sha, hashes } = loadProtocol();
  assert.deepEqual(protocolDrift(protocol), [], 'run "node bench/bench.mjs freeze" after changing a prompt or harness file');
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.equal(sha, hashes.protocol, 'the hash shown for the file is the protocol hash');
  assert.equal(sha, protocolHash(protocol));
  assert.equal(protocol.omp.version, 'omp/18.4.4');
  assert.deepEqual(protocol.omp.tools, ['read', 'grep', 'glob']);
  assert.equal(protocol.omp.thinking, 'max');
  for (const flag of ['-p', '--no-session', '--no-title', '--no-skills', '--no-rules', '--no-extensions', '--no-lsp', '--no-pty']) assert.ok(protocol.omp.flags.includes(flag), flag);
  const slugs = Object.values(protocol.tiers).flat();
  assert.equal(slugs.length, 25);
  assert.equal(new Set(slugs).size, 25);
  assert.deepEqual(protocol.arms, { 'find-sol': ['raw', 'solidity'], 'find-ts': ['raw', 'general'], challenge: ['raw', 'report'] });
});

test('argument parsing', () => {
  assert.deepEqual(parseArgs(['--tier', '1', '--proofs', '--max-usd=20', 'extra', '--cases', 'sol-*']), { flags: { tier: '1', proofs: true, 'max-usd': '20', cases: 'sol-*' }, rest: ['extra'] });
});

// ---------------------------------------------------------------- classification

const okChecks = { requests: true, tools: true, model: true, system: true, nonce: true, cwd: true, no_sampling: true, ok: true };
const ev = (final, usage = { input: 10, output: 5, cacheRead: 0 }) => ({ final, usage, models: [], providers: [] });
const res = (over = {}) => ({ spawnError: null, timedOut: false, sawModelOutput: true, exitCode: 0, ...over });

test('provider errors are sorted into retry, stop and model failures', () => {
  assert.deepEqual(classifyError(429, 'Rate limit exceeded'), { kind: 'infra', retry: true, halt: null });
  assert.equal(classifyError(503, 'Service unavailable').kind, 'infra');
  assert.equal(classifyError(null, 'fetch failed: ECONNRESET').kind, 'infra');
  assert.equal(classifyError(undefined, 'HTTP 502 from upstream').kind, 'infra');
  assert.deepEqual(classifyError(402, 'Insufficient credits'), { kind: 'budget', retry: false, halt: 'all' });
  assert.deepEqual(classifyError(401, 'No auth credentials found'), { kind: 'auth', retry: false, halt: 'all' });
  assert.deepEqual(classifyError(404, 'No endpoints found that support tool use'), { kind: 'unavailable', retry: false, halt: 'model' });
  assert.deepEqual(classifyError(400, 'This request exceeds the context window of 500 tokens'), { kind: 'error', retry: false, halt: null });
  assert.equal(classifyError(null, 'The model refused: content policy').kind, 'error');
});

test('run classification: only stopReason "stop" counts as an answer', () => {
  const c = (r, e, checks = okChecks, stderr = '') => classifyRun({ res: r, ev: e, checks, stderr });
  assert.deepEqual(c(res(), ev({ stopReason: 'stop' })), { status: 'ok', failure: null, detail: null, final: true, retry: false, halt: null });
  assert.deepEqual([c(res(), ev({ stopReason: 'length' })).failure, c(res(), ev({ stopReason: 'length' })).final], ['truncated', true]);
  assert.deepEqual([c(res(), ev({ stopReason: 'toolUse' })).failure, c(res(), ev({ stopReason: 'toolUse' })).final], ['timeout', true]);
  const hard = c(res({ timedOut: true }), ev({ stopReason: 'toolUse' }));
  assert.deepEqual([hard.failure, hard.final, hard.retry], ['timeout', true, false]);
  const early = c(res({ timedOut: true, sawModelOutput: false }), ev(null));
  assert.deepEqual([early.failure, early.final, early.retry], ['infra', false, true], 'a timeout before any model output is infrastructure');
  const rate = c(res({ exitCode: 1 }), ev({ stopReason: 'error', errorStatus: 429, errorMessage: 'rate limited' }));
  assert.deepEqual([rate.failure, rate.final, rate.retry, rate.halt], ['infra', false, true, null]);
  const credit = c(res({ exitCode: 1 }), ev({ stopReason: 'error', errorStatus: 402, errorMessage: 'Insufficient credits' }));
  assert.deepEqual([credit.failure, credit.retry, credit.halt], ['infra', false, 'all']);
  const gone = c(res({ exitCode: 1 }), ev({ stopReason: 'error', errorStatus: 404, errorMessage: 'No endpoints found' }));
  assert.deepEqual([gone.failure, gone.halt], ['infra', 'model']);
  const refused = c(res({ exitCode: 1 }), ev({ stopReason: 'error', errorStatus: 400, errorMessage: 'content filtered' }));
  assert.deepEqual([refused.failure, refused.final], ['error', true], 'the model\'s own error is final');
  const silent = c(res({ exitCode: 0, sawModelOutput: false }), ev(null));
  assert.deepEqual([silent.failure, silent.final, silent.retry], ['infra', false, true]);
  const noKey = c(res({ exitCode: 1, sawModelOutput: false }), ev(null), { ...okChecks, requests: false, ok: false }, 'Error: No auth credentials found');
  assert.deepEqual([noKey.failure, noKey.halt], ['infra', 'all']);
  assert.equal(c(res(), ev({ stopReason: 'stop' }, { input: 0, output: 0, cacheRead: 0 })).failure, 'infra', 'zero usage means a cached response');
  assert.deepEqual([c(res({ spawnError: 'ENOENT' }), ev(null)).failure, c(res({ spawnError: 'ENOENT' }), ev(null)).halt], ['infra', 'all']);
});

test('harness checks: a wrong tool list or prompt stops everything, a wrong model id stops that model', () => {
  const requests = (over = {}) => ({ count: 2, toolsets: ['glob,grep,read'], models: ['a/b'], system: 'SYSTEM TEXT\n\n<critical>..</critical>\n\nrun-nonce: n-1', summaries: [{ temperature: null }, { temperature: null }], ...over });
  const expected = { tools: ['read', 'grep', 'glob'], model: 'a/b', provider: 'openrouter', system: 'SYSTEM TEXT\n', nonce: 'n-1', cwd: 'D:\\pdw\\x\\y\\ws' };
  const events = { cwd: 'D:/pdw/x/y/ws/', models: ['a/b'], providers: ['openrouter'] };
  assert.equal(harnessChecks({ ev: events, requests: requests(), expected }).ok, true);
  const extraTool = harnessChecks({ ev: events, requests: requests({ toolsets: ['bash,glob,grep,read'] }), expected });
  assert.deepEqual([extraTool.tools, extraTool.ok], [false, false]);
  assert.equal(classifyRun({ res: res(), ev: ev({ stopReason: 'stop' }), checks: extraTool }).halt, 'all');
  const mixed = harnessChecks({ ev: events, requests: requests({ toolsets: ['glob,grep,read', 'glob,grep,read,write'] }), expected });
  assert.equal(mixed.tools, false);
  const otherModel = harnessChecks({ ev: { ...events, models: ['a/b-latest'] }, requests: requests(), expected });
  assert.deepEqual([otherModel.model, otherModel.ok], [false, false]);
  assert.equal(classifyRun({ res: res(), ev: ev({ stopReason: 'stop' }), checks: otherModel }).halt, 'model');
  assert.equal(harnessChecks({ ev: events, requests: requests({ system: 'OTHER\nrun-nonce: n-1' }), expected }).system, false);
  assert.equal(harnessChecks({ ev: events, requests: requests({ system: 'SYSTEM TEXT\n\nrun-nonce: n-2' }), expected }).nonce, false);
  assert.equal(harnessChecks({ ev: { ...events, cwd: 'E:\\repo' }, requests: requests(), expected }).cwd, false);
  assert.equal(harnessChecks({ ev: events, requests: requests({ summaries: [{ temperature: 0.7 }] }), expected }).no_sampling, false);
});

test('stored run to scorer: the sheet is re-read from the event stream', () => {
  const answer = 'Done.\n```json\n{"findings":[],"rejected":[],"verdict":"n/a","max_severity":"unrated"}\n```';
  const events = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop', usage: { input: 1, output: 1 } } });
  const meta = { failure: null, usd: 0.5, wall_s: 12.3, usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 0, reasoning: 30 }, turns: 3, effort: 'xhigh', providers: ['A'], stop_reason: 'stop' };
  const run = toScoreRun({ meta, eventsText: events });
  assert.equal(run.failure, null);
  assert.equal(run.sheet.ok, true);
  assert.deepEqual(run.facts, { usd: 0.5, wall_s: 12.3, tokens_in: 110, tokens_out: 40, tokens_reasoning: 30, turns: 3, effort: 'xhigh', providers: ['A'], stop: 'stop' });
  assert.equal(toScoreRun({ meta: { ...meta, failure: 'timeout' }, eventsText: events }).failure, 'timeout');
  assert.equal(toScoreRun({ meta: { ...meta, failure: 'unparseable' }, eventsText: events }).sheet.ok, true, 'parse failures are always re-derived, never trusted from meta');
  assert.deepEqual(runFacts({}).providers, []);
});

// ---------------------------------------------------------------- key handling and cost

test('the key is read from the env file and can be redacted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-key-'));
  try {
    const file = path.join(dir, 'benchmark.env');
    fs.writeFileSync(file, '# comment\r\nOPENROUTER_PROVISIONING_KEY=other\r\nOPENROUTER_API_KEY="sk-or-test-123"\r\n');
    assert.equal(readKey(dir, file), 'sk-or-test-123');
    fs.writeFileSync(file, 'SOMETHING=1\n');
    assert.throws(() => readKey(dir, file), /OPENROUTER_API_KEY is not set/);
    assert.throws(() => readKey(dir, path.join(dir, 'missing.env')), /not found/);
    assert.equal(redact('a sk-or-test-123 b sk-or-test-123', 'sk-or-test-123'), 'a [REDACTED] b [REDACTED]');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cost from tokens and catalogue prices', () => {
  const info = modelInfo({ id: 'z-ai/glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash', hugging_face_id: 'zai-org/GLM-5.3-Flash', pricing: { prompt: '0.00000015', completion: '0.0000005', input_cache_read: '0.00000003' }, supported_parameters: ['tools', 'reasoning'], reasoning: { supported_efforts: ['high', 'low'] } });
  assert.deepEqual(info.price, { in: 0.15, out: 0.5, cache_read: 0.03, cache_write: null });
  assert.deepEqual([info.name, info.vendor, info.open_weight, info.supports_tools], ['GLM 5.3 Flash', 'z-ai', true, true]);
  assert.equal(costFromTokens({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }, info.price), 0.68);
  assert.equal(costFromTokens({ input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 }, { in: 2, out: 10 }), 0.009);
  assert.equal(costFromTokens({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, { in: null, out: null }), null);
  assert.equal(modelInfo({ id: 'x/y', hugging_face_id: '' }).open_weight, false);
});
