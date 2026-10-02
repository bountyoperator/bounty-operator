// A stand-in for omp used by the offline runner tests. It speaks just enough of omp's
// `--mode json` protocol to exercise the harness: argument handling, the request dump,
// event capture, retries and the hard kill. Usage: node fake-omp.mjs <mode> <omp args...>
//   ok      answer with a sheet and exit 0
//   flaky   fail with HTTP 429 on the first call in this home directory, then behave like ok
//   hang    start a grandchild process and never exit (the harness must kill the tree)
//   sheet <answers.json>   answer each workspace with the text stored for it in answers.json, a map
//           from the workspace digest (sha256 over "<path>\0<sha256 of the file>\n" for every file
//           in path order) to the answer text; an unknown workspace gets an answer without a sheet.
//           Used by tools/offline-smoke.mjs to drive every case through the real runner and scorer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const [mode, ...argv] = process.argv.slice(2);
if (argv.includes('--version')) { console.log('omp/18.4.4'); process.exit(0); }
const arg = (name) => argv[argv.indexOf(name) + 1];
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const cwd = arg('--cwd');
const model = arg('--model').replace(/^openrouter\//, '');
const task = argv[argv.indexOf('--') + 1];
const system = `${fs.readFileSync(arg('--system-prompt'), 'utf8')}\n<critical>appended by omp</critical>\n\n${arg('--append-system-prompt')}`;
const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();
const assistant = (extra) => ({ type: 'message_end', message: { role: 'assistant', api: 'openrouter', provider: 'openrouter', model, ...extra } });

emit({ type: 'session', version: 3, cwd });
emit({ type: 'agent_start' });
if (process.env.OMP_BENCH_DUMP) {
  const tools = arg('--tools').split(',').map((name) => ({ type: 'function', name }));
  // like omp: models.yml of the active profile supplies the provider-routing block of every request
  let routing;
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    const file = path.join(home, '.omp', 'profiles', arg('--profile'), 'agent', 'models.yml');
    routing = JSON.parse(fs.readFileSync(file, 'utf8')).providers?.openrouter?.compat?.openRouterRouting;
  } catch { /* no models.yml: no routing block */ }
  fs.appendFileSync(process.env.OMP_BENCH_DUMP, `${JSON.stringify({ model, instructions: system, input: [{ role: 'user', content: [{ type: 'input_text', text: task }] }], tools, reasoning: { effort: 'high', summary: 'auto' }, ...(routing ? { provider: routing } : {}) })}\n`);
}
for (let i = 0; i < 5; i++) emit({ type: 'message_update', delta: 'x'.repeat(200) });

const counter = path.join(process.env.HOME ?? process.env.USERPROFILE, 'fake-omp-calls');
const calls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
fs.writeFileSync(counter, String(calls));

if (mode === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  emit({ type: 'fake_pids', pid: process.pid, grandchild: grandchild.pid });
  setInterval(() => {}, 1000);
} else if (mode === 'sheet') {
  const answers = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
  const h = crypto.createHash('sha256');
  for (const rel of walk(cwd)) h.update(`${rel}\0${crypto.createHash('sha256').update(fs.readFileSync(path.join(cwd, rel))).digest('hex')}\n`);
  const text = answers[h.digest('hex')] ?? 'This workspace is not in the answers file.';
  emit(assistant({ content: [{ type: 'text', text }], usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, cost: { total: 0.0001 } }, stopReason: 'stop', responseId: 'gen-fake-sheet' }));
  emit({ type: 'agent_end', messages: [1], isTerminal: true, yielded: true });
  process.exit(0);
} else if (mode === 'flaky' && calls === 1) {
  emit(assistant({ content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: 'error', errorStatus: 429, errorMessage: 'Rate limit exceeded: try again later' }));
  process.exit(1);
} else {
  const report = {
    files: walk(cwd),
    launch: fs.readdirSync(process.cwd()),
    env: Object.keys(process.env).sort(),
    key: process.env.OPENROUTER_API_KEY ?? null,
    home: process.env.HOME ?? process.env.USERPROFILE,
    user: process.env.USERNAME ?? null,
    calls,
    args: argv.slice(0, argv.indexOf('--')),
  };
  const sheet = { findings: [{ file: 'src/PocketBank.sol', function: 'withdrawAll', line_start: 42, line_end: 44, severity: 'high', claim: 'pays before zeroing the balance' }], rejected: [], verdict: 'n/a', max_severity: 'high' };
  const text = `FAKE-REPORT ${JSON.stringify(report)}\n\n\`\`\`json\n${JSON.stringify(sheet)}\n\`\`\`\n`;
  emit(assistant({ content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text }], usage: { input: 1200, output: 300, cacheRead: 100, cacheWrite: 0, reasoningTokens: 40, cost: { total: 0.00123 } }, stopReason: 'stop', responseId: 'gen-fake-1' }));
  emit({ type: 'turn_end', message: { big: 'x'.repeat(500) }, toolResults: [] });
  emit({ type: 'agent_end', messages: [1, 2], isTerminal: true, yielded: true });
  process.exit(0);
}
