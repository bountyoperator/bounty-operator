// Offline checks of the runner's command line, environment and work-root choice.
// No omp process is started and no network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OMP_PIN_NAMES, contextMarkers, createInvocation, describeOmp, modelsYmlPath, ompArgs, ompProfile, pickWorkRoot, resolveOmp, routingModelsYml } from '../lib/omp.mjs';
import { readEnvValues, readKey } from '../lib/openrouter.mjs';
import { loadProtocol } from '../bench.mjs';
import { buildArm, frozenHashes, taskText } from '../lib/arms.mjs';
import { loadCases } from '../lib/cases.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { protocol } = loadProtocol();

function withInvocation(fn) {
  const saved = process.env.PAYDIRT_OMP;
  process.env.PAYDIRT_OMP = process.execPath; // any existing file: nothing is executed here
  const ctx = createInvocation({ benchDir: BENCH, protocol, key: 'sk-or-v1-TESTKEY' });
  try { return fn(ctx); } finally {
    ctx.destroy();
    if (saved === undefined) delete process.env.PAYDIRT_OMP; else process.env.PAYDIRT_OMP = saved;
  }
}

test('the omp command line is the validated template', () => {
  withInvocation((ctx) => {
    const args = ompArgs(ctx, { model: 'anthropic/claude-opus-5.5', systemFile: 'S', nonce: 'N', cwd: 'W', task: 'TASK' });
    assert.deepEqual(args, [
      '-p', '--mode', 'json', '--profile', 'bench', '--no-session', '--no-title', '--no-skills', '--no-rules', '--no-extensions', '--no-lsp', '--no-pty',
      '--config', ctx.harness['bench-overlay.yml'], '-e', ctx.harness['dump-ext.ts'], '-e', ctx.harness['jail-ext.ts'],
      '--tools', 'read,grep,glob', '--thinking', 'max', '--max-time', '30m',
      '--system-prompt', 'S', '--append-system-prompt', 'run-nonce: N',
      '--cwd', 'W', '--model', 'openrouter/anthropic/claude-opus-5.5', '--', 'TASK',
    ]);
    for (const file of Object.values(ctx.harness)) {
      assert.ok(fs.existsSync(file));
      assert.ok(!path.resolve(file).toLowerCase().startsWith(path.resolve(BENCH, '..').toLowerCase()), 'harness files are loaded from the work root, not from the repository');
    }
  });
});

test('the child environment holds one credential and nothing from the parent', () => {
  process.env.ANTHROPIC_API_KEY = 'parent-secret';
  process.env.OPENAI_BASE_URL = 'https://example.invalid';
  try {
    withInvocation((ctx) => {
      const w = ctx.worker(0);
      const env = ctx.env(w, { OMP_BENCH_DUMP: 'dump.jsonl' });
      const names = Object.keys(env);
      assert.deepEqual(names.filter((n) => /KEY|TOKEN|SECRET|BASE_URL/i.test(n)), ['OPENROUTER_API_KEY']);
      assert.equal(env.OPENROUTER_API_KEY, 'sk-or-v1-TESTKEY');
      assert.ok(!names.some((n) => /^(PI_|GH_|GITHUB_)/.test(n)));
      assert.deepEqual(names.filter((n) => n.startsWith('OMP_')), ['OMP_BENCH_DUMP']);
      const allowed = new Set(['SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'PATH', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'OPENROUTER_API_KEY', 'OMP_BENCH_DUMP']);
      assert.deepEqual(names.filter((n) => !allowed.has(n)), []);
      assert.equal(env.HOME, w.home);
      assert.ok(w.home.startsWith(ctx.dir) && w.launch.startsWith(ctx.dir), 'throwaway home and launch directory live in the invocation directory');
      assert.notEqual(path.resolve(env.HOME).toLowerCase(), os.homedir().toLowerCase());
      assert.deepEqual(fs.readdirSync(w.launch), [], 'the launch directory is empty');
      assert.ok(!env.PATH.toLowerCase().includes('github cli') && !/[\\/]gh[\\/]?(;|:|$)/i.test(env.PATH), 'gh is not on PATH');
      assert.notEqual(ctx.worker(1).home, w.home, 'each worker has its own home');
    });
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_BASE_URL; }
});

test('the throwaway home holds the routing policy of protocol.json and nothing else', () => {
  withInvocation((ctx) => {
    const w = ctx.worker(0);
    assert.equal(ompProfile(protocol), 'bench');
    const file = modelsYmlPath(w.home, 'bench');
    assert.equal(path.relative(w.home, file).split(path.sep).join('/'), '.omp/profiles/bench/agent/models.yml');
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text, routingModelsYml(protocol));
    // the file is JSON (valid YAML); omp copies compat.openRouterRouting into every request's `provider`
    assert.deepEqual(JSON.parse(text), { providers: { openrouter: { compat: { openRouterRouting: protocol.omp.routing } } } });
    assert.deepEqual(protocol.omp.routing, { quantizations: ['fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown'], preferred_min_throughput: { p50: 60 } });
    const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
    assert.deepEqual(walk(w.home), ['.omp/profiles/bench/agent/models.yml'], 'no credential, session or settings file');
    assert.ok(!text.includes('sk-or-v1-TESTKEY'), 'the key is not written to disk');
    assert.equal(fs.readFileSync(modelsYmlPath(ctx.worker(1).home, 'bench'), 'utf8'), text, 'every worker gets the same policy');
  });
  // a protocol without a routing block writes no file
  assert.equal(routingModelsYml({ omp: { provider: 'openrouter' } }), null);
  assert.equal(routingModelsYml({ omp: { provider: 'openrouter', routing: {} } }), null);
});

test('the work root has no agent context file in any ancestor and is outside the repository', () => {
  withInvocation((ctx) => {
    assert.deepEqual(contextMarkers(ctx.dir), []);
    const repo = path.resolve(BENCH, '..').toLowerCase();
    assert.ok(!path.resolve(ctx.dir).toLowerCase().startsWith(repo));
    assert.equal(fs.existsSync(ctx.dir), true);
    const dir = ctx.dir;
    ctx.destroy();
    assert.equal(fs.existsSync(dir), false, 'destroy removes the whole invocation directory');
  });
});

test('a candidate root below an AGENTS.md is rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-root-'));
  try {
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'ambient instructions\n');
    const inner = path.join(tmp, 'a', 'b');
    assert.ok(contextMarkers(inner).some((m) => m === path.join(tmp, 'AGENTS.md')));
    const picked = pickWorkRoot({ ...process.env, PAYDIRT_WORK_ROOT: inner });
    assert.notEqual(path.resolve(picked.root), path.resolve(inner));
    assert.equal(picked.rejected[0].candidate, inner);
    assert.match(picked.rejected[0].why, /context files in an ancestor/);
    assert.equal(fs.existsSync(inner), false, 'a rejected candidate is not created');
    assert.deepEqual(contextMarkers(picked.root), []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the omp pin is read from the env file next to the key: the two pin settings and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-pin-'));
  try {
    const file = path.join(dir, 'benchmark.env');
    const cli = '["D:/pdw/omp-18.4.4/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"]';
    // as the file is on the benchmark machine: CRLF, comments, the key lines first
    fs.writeFileSync(file, ['# OpenRouter key of the benchmark', 'OPENROUTER_API_KEY=sk-or-v1-SECRET', 'OPENROUTER_PROVISIONING_KEY=sk-or-v1-OTHER', 'PAYDIRT_OMP=C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe', `PAYDIRT_OMP_ARGS=${cli}`, ''].join('\r\n'));
    const pins = readEnvValues(file, OMP_PIN_NAMES);
    assert.deepEqual(pins, { PAYDIRT_OMP: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe', PAYDIRT_OMP_ARGS: cli }, 'backslashes are literal and the JSON array is kept as written');
    assert.ok(!JSON.stringify(pins).includes('SECRET') && !JSON.stringify(pins).includes('OTHER'), 'the key is not among the values handed to the runner');
    assert.equal(readKey(dir, file), 'sk-or-v1-SECRET', 'and the key is still read from the same file');
    assert.deepEqual(OMP_PIN_NAMES, ['PAYDIRT_OMP', 'PAYDIRT_OMP_ARGS']);
    // other spellings of a line; the first non-empty value of a name wins; other PAYDIRT_ settings are not taken from the file
    fs.writeFileSync(file, '\uFEFF  export PAYDIRT_OMP = "C:\\Program Files\\bun\\bun.exe"  \nPAYDIRT_OMP_ARGS=\nPAYDIRT_OMP_ARGS=\'["a b/cli.js", "--flag"]\'\nPAYDIRT_OMP=/second/value\n#PAYDIRT_OMP=/commented/out\nPAYDIRT_WORK_ROOT=/elsewhere\nNOT_A_PIN_PAYDIRT_OMP=x\n');
    assert.deepEqual(readEnvValues(file, OMP_PIN_NAMES), { PAYDIRT_OMP: 'C:\\Program Files\\bun\\bun.exe', PAYDIRT_OMP_ARGS: '["a b/cli.js", "--flag"]' });
    fs.writeFileSync(file, 'OPENROUTER_API_KEY=sk-or-v1-SECRET\n');
    assert.deepEqual(readEnvValues(file, OMP_PIN_NAMES), {}, 'a file without a pin: omp is looked up as before');
    assert.equal(readEnvValues(path.join(dir, 'missing.env'), OMP_PIN_NAMES), null, 'no file: nothing is pinned, and nothing fails');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('omp is resolved from the environment first, then from the env-file pin; the binary and its arguments go together', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-pin-'));
  try {
    // any existing files stand for the runtime and for another binary: nothing is executed here
    const bun = path.join(dir, 'bun.exe'), other = path.join(dir, 'omp.exe');
    fs.writeFileSync(bun, '');
    fs.writeFileSync(other, '');
    const pins = { PAYDIRT_OMP: bun, PAYDIRT_OMP_ARGS: '["D:/pdw/omp-18.4.4/cli.js"]' };
    const pick = (env, file = pins) => { const r = resolveOmp({ PATH: '', ...env }, file); return [r.bin, r.prefix, r.source]; };
    assert.deepEqual(pick({}), [bun, ['D:/pdw/omp-18.4.4/cli.js'], 'env-file'], 'no variable set: the pinned copy is used');
    assert.deepEqual(pick({ PAYDIRT_OMP: other }), [other, [], 'environment'], 'the environment names another binary: the file\'s arguments are not passed to it');
    assert.deepEqual(pick({ PAYDIRT_OMP: other, PAYDIRT_OMP_ARGS: '["x.js","y"]' }), [other, ['x.js', 'y'], 'environment']);
    assert.deepEqual(pick({ PAYDIRT_OMP_ARGS: '["other-cli.js"]' }), [bun, ['other-cli.js'], 'env-file'], 'the environment wins for the variable it sets');
    assert.deepEqual(pick({ PAYDIRT_OMP_ARGS: '' }), [bun, [], 'env-file'], 'an empty variable is still the environment speaking');
    assert.deepEqual(pick({ PAYDIRT_OMP: other }, null), [other, [], 'environment'], 'no env file at all');
    assert.deepEqual(pick({}, { PAYDIRT_OMP: bun }), [bun, [], 'env-file'], 'a pinned binary without arguments');
    assert.throws(() => pick({}, { ...pins, PAYDIRT_OMP_ARGS: 'D:/pdw/cli.js' }), /PAYDIRT_OMP_ARGS must be a JSON array of strings/);
    assert.throws(() => pick({}, { ...pins, PAYDIRT_OMP_ARGS: '[1]' }), /PAYDIRT_OMP_ARGS must be a JSON array of strings/);
    assert.throws(() => pick({}, { PAYDIRT_OMP: path.join(dir, 'gone.exe') }), /omp not found at .*gone\.exe \(PAYDIRT_OMP, from \.local\/benchmark\.env\)/);
    assert.throws(() => pick({ PAYDIRT_OMP: path.join(dir, 'gone.exe') }), /omp not found at .*gone\.exe \(PAYDIRT_OMP, from the environment\)/);
    assert.equal(describeOmp({ bin: bun, prefix: ['cli.js'], source: 'env-file' }), `${bun} cli.js (pinned in .local/benchmark.env)`);
    assert.equal(describeOmp({ bin: other, prefix: [], source: 'path' }), `${other} (found on PATH)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an invocation takes the pin from the env file it is given, and from the repository\'s own by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-pin-'));
  const saved = [process.env.PAYDIRT_OMP, process.env.PAYDIRT_OMP_ARGS];
  delete process.env.PAYDIRT_OMP;
  delete process.env.PAYDIRT_OMP_ARGS;
  try {
    const file = path.join(dir, 'benchmark.env');
    fs.writeFileSync(file, `OPENROUTER_API_KEY=sk-or-v1-SECRET\r\nPAYDIRT_OMP=${process.execPath}\r\nPAYDIRT_OMP_ARGS=["pinned/cli.js"]\r\n`);
    const ctx = createInvocation({ benchDir: BENCH, protocol, envFile: file });
    try {
      assert.deepEqual([ctx.omp.bin, ctx.omp.prefix, ctx.omp.source], [process.execPath, ['pinned/cli.js'], 'env-file']);
      assert.ok(ctx.env(ctx.worker(0)).PATH.split(path.delimiter).includes(path.dirname(process.execPath)), 'the pinned runtime is on the child PATH');
      assert.ok(!Object.keys(ctx.env(ctx.worker(0))).some((n) => n.startsWith('PAYDIRT_')), 'the pin settings are not handed on to omp');
      assert.equal(ctx.key, '', 'reading the pin does not read the key');
    } finally { ctx.destroy(); }
    // the environment still wins over the file
    process.env.PAYDIRT_OMP = file;
    const fromEnv = createInvocation({ benchDir: BENCH, protocol, envFile: file });
    try { assert.deepEqual([fromEnv.omp.bin, fromEnv.omp.prefix, fromEnv.omp.source], [file, [], 'environment']); } finally { fromEnv.destroy(); }
    // the default is <repo>/.local/benchmark.env, next to bench/
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, '.local'), { recursive: true });
    fs.cpSync(path.join(BENCH, 'harness'), path.join(repo, 'bench', 'harness'), { recursive: true });
    fs.copyFileSync(file, path.join(repo, '.local', 'benchmark.env'));
    delete process.env.PAYDIRT_OMP;
    const byDefault = createInvocation({ benchDir: path.join(repo, 'bench'), protocol });
    try { assert.deepEqual([byDefault.omp.bin, byDefault.omp.prefix, byDefault.omp.source], [process.execPath, ['pinned/cli.js'], 'env-file']); } finally { byDefault.destroy(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [i, name] of ['PAYDIRT_OMP', 'PAYDIRT_OMP_ARGS'].entries()) { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }
  }
});

test('a changed harness file is refused until the protocol is frozen again', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'paydirt-harness-'));
  const saved = process.env.PAYDIRT_OMP;
  process.env.PAYDIRT_OMP = process.execPath;
  try {
    fs.cpSync(path.join(BENCH, 'harness'), path.join(copy, 'harness'), { recursive: true });
    fs.appendFileSync(path.join(copy, 'harness', 'jail-ext.ts'), '\n// loosened\n');
    assert.throws(() => createInvocation({ benchDir: copy, protocol, key: 'k' }), /jail-ext\.ts does not match protocol\.json/);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
    if (saved === undefined) delete process.env.PAYDIRT_OMP; else process.env.PAYDIRT_OMP = saved;
  }
});

test('arms: every arm gets the same task; a profile arm adds only the product system text', async () => {
  const cases = loadCases([path.join(BENCH, 'tests', 'fixtures', 'cases')]);
  const sol = cases.find((c) => c.id === 'fx-01-v'), twin = cases.find((c) => c.id === 'fx-01-f'), challenge = cases.find((c) => c.id === 'fx-02-o');
  const raw = await buildArm('raw', sol, { benchDir: BENCH });
  assert.equal(raw.engine_profile, null);
  assert.equal(raw.system, fs.readFileSync(path.join(BENCH, 'prompts', 'system.txt'), 'utf8').replace(/\r\n?/g, '\n').trim() + '\n');
  assert.ok(raw.task.startsWith('You are a security reviewer. Review the files in this workspace for security issues.\n\n## Answer sheet'));
  assert.ok(raw.task.includes('"verdict":"supported|overclaimed|unsupported|n/a"'));
  assert.equal(taskText(twin, BENCH), raw.task, 'the twins get byte-identical task text');
  assert.ok(taskText(challenge, BENCH).startsWith('You are a security reviewer. draft-report.md is a draft bug report'));
  for (const text of [raw.system, raw.task]) assert.ok(!/fx-01|vulnerable|fixed|5b0e7c1a/i.test(text), 'no case id, variant or canary in the prompt');
  const profile = await buildArm('solidity', sol, { benchDir: BENCH });
  assert.equal(profile.task, raw.task);
  assert.ok(profile.system.startsWith(raw.system.trim()));
  assert.ok(profile.system.length > raw.system.length + 500, 'the product contract and profile instructions are appended');
  assert.ok(profile.system.includes('written for files supplied inline'));
  assert.equal(profile.engine_profile, 'solidity');
  assert.notEqual(profile.system_sha256, raw.system_sha256);
});

test('arms: a profile arm sends the frozen product text when prompts/frozen/<profile>.md exists', async () => {
  const sol = loadCases([path.join(BENCH, 'tests', 'fixtures', 'cases')]).find((c) => c.id === 'fx-01-v');
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-frozen-'));
  try {
    fs.cpSync(path.join(BENCH, 'prompts'), path.join(copy, 'prompts'), { recursive: true });
    fs.rmSync(path.join(copy, 'prompts', 'frozen'), { recursive: true, force: true });
    const live = await buildArm('solidity', sol, { benchDir: copy });
    assert.equal(live.engine_source, 'live');
    assert.ok(live.system.includes('## Context\nMode: bounty'), 'the product Context block (with the Mode) precedes the product system message');
    assert.ok(live.system.indexOf('## Context') < live.system.indexOf('You are a security reviewer working for the researcher'));
    fs.mkdirSync(path.join(copy, 'prompts', 'frozen'));
    fs.writeFileSync(path.join(copy, 'prompts', 'frozen', 'solidity.md'), 'FROZEN PRODUCT TEXT\r\nline two\n');
    const frozen = await buildArm('solidity', sol, { benchDir: copy });
    assert.equal(frozen.engine_source, 'frozen');
    assert.ok(frozen.system.endsWith('FROZEN PRODUCT TEXT\nline two\n'), 'the frozen file is sent, LF-normalised');
    assert.ok(!frozen.system.includes('You are a security reviewer working for the researcher'), 'the live engine text is not used');
    assert.deepEqual(frozenHashes(['solidity', 'general'], copy), { solidity: frozen.profile_sha256, general: null });
    assert.equal(frozen.task, live.task);
    const raw = await buildArm('raw', sol, { benchDir: copy });
    assert.equal(raw.engine_source, null);
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
});
