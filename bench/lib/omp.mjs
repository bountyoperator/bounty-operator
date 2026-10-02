// Paydirt runner: one fresh `omp -p --mode json` process per run, built exactly from the
// validated template (.local/audit/omp-harness-facts.md):
//   throwaway home, an environment holding only the OpenRouter key, an empty launch
//   directory, a fresh copy of the case workspace outside any repository, the overlay and
//   the dump + jail extensions, read-only tools, a per-run nonce, an exact model selector,
//   omp's own --max-time plus an external hard kill of the whole process tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { compactEvent, parseRequests, summarizeRequest } from './parse.mjs';
import { envFilePath, readEnvValues } from './openrouter.mjs';

const WIN = process.platform === 'win32';
const HARNESS_FILES = ['bench-overlay.yml', 'dump-ext.ts', 'jail-ext.ts'];
/** Anything that an agent CLI might pick up as ambient context or configuration. */
const CONTEXT_MARKERS = ['AGENTS.md', 'AGENT.md', 'CLAUDE.md', 'GEMINI.md', '.git', '.omp', '.claude', '.codex', '.cursor', '.cursorrules', '.windsurfrules', '.clinerules', '.mcp.json', '.env', '.agents', '.github', 'opencode.json', '.opencode'];

const lf = (text) => String(text).replace(/\r\n?/g, '\n');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const rid = () => crypto.randomBytes(4).toString('hex');

function rmrf(target) {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return true; } catch { /* a handle may still be closing */ }
  }
  return false;
}

/** The omp profile the runs use (`--profile <name>` in protocol.omp.flags). */
export function ompProfile(protocol) {
  const flags = protocol?.omp?.flags ?? [];
  const at = flags.indexOf('--profile');
  return at >= 0 && typeof flags[at + 1] === 'string' ? flags[at + 1] : null;
}

/**
 * The models.yml written into the throwaway profile, or null when the protocol sets no
 * routing. omp 18.4.4 copies `providers.<provider>.compat.openRouterRouting` verbatim into
 * the `provider` field of every request it sends to OpenRouter, for every model of that
 * provider, so this one file is the routing policy of the whole benchmark. The text is JSON,
 * which is valid YAML.
 */
export function routingModelsYml(protocol) {
  const routing = protocol?.omp?.routing;
  if (!routing || typeof routing !== 'object' || !Object.keys(routing).length) return null;
  return `${JSON.stringify({ providers: { [protocol.omp.provider]: { compat: { openRouterRouting: routing } } } }, null, 2)}\n`;
}

/** Where omp looks for models.yml under a home directory when started with `--profile <name>`. */
export function modelsYmlPath(home, profile) {
  return profile ? path.join(home, '.omp', 'profiles', profile, 'agent', 'models.yml') : path.join(home, '.omp', 'agent', 'models.yml');
}

/** Context files found in `dir` or any of its ancestors. An empty list means the path is neutral. */
export function contextMarkers(dir) {
  const found = [];
  let current = path.resolve(dir);
  for (;;) {
    for (const marker of CONTEXT_MARKERS) if (fs.existsSync(path.join(current, marker))) found.push(path.join(current, marker));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

/**
 * Choose the directory that will hold throwaway homes and workspace copies. It must have
 * no agent context file in any ancestor, so the first clean candidate wins:
 * $PAYDIRT_WORK_ROOT, the user temp dir, the machine temp dir, the system drive root.
 */
export function pickWorkRoot(env = process.env) {
  const candidates = [];
  if (env.PAYDIRT_WORK_ROOT) candidates.push(env.PAYDIRT_WORK_ROOT);
  let tmp = os.tmpdir();
  try { tmp = fs.realpathSync.native(tmp); } catch { /* keep as given */ }
  candidates.push(path.join(tmp, 'pdw'));
  if (WIN) {
    candidates.push(path.join(env.SystemRoot || 'C:\\Windows', 'Temp', 'pdw'));
    candidates.push(path.join(`${env.SystemDrive || 'C:'}\\`, 'pdw'));
    // drive roots often carry agent folders (C:\.claude, C:\.codex); try the other fixed drives
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${letter}:\\`)) candidates.push(`${letter}:\\pdw`);
  } else {
    candidates.push('/var/tmp/pdw');
  }
  const rejected = [];
  for (const candidate of candidates) {
    // look before creating anything: a rejected candidate must leave no trace
    const markers = contextMarkers(candidate);
    if (markers.length) { rejected.push({ candidate, why: `context files in an ancestor: ${markers.slice(0, 3).join(', ')}` }); continue; }
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(candidate, `.w-${rid()}`);
      fs.writeFileSync(probe, '');
      fs.rmSync(probe);
    } catch (e) { rejected.push({ candidate, why: `not writable (${e.code ?? e.message})` }); continue; }
    return { root: candidate, rejected };
  }
  throw new Error(`No neutral work directory found. Set PAYDIRT_WORK_ROOT to a writable directory with no agent context files above it. Tried: ${rejected.map((r) => `${r.candidate} (${r.why})`).join('; ')}`);
}

function onPath(name, env = process.env) {
  const exts = WIN ? ['.exe'] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const direct = path.join(dir, name + ext);
      if (fs.existsSync(direct)) return direct;
      const npmShim = path.join(dir, 'node_modules', name, 'bin', name + ext); // npm global install layout
      if (fs.existsSync(npmShim)) return npmShim;
    }
  }
  return null;
}

/** The settings that pin the omp binary. They may also stand in .local/benchmark.env; the environment wins. */
export const OMP_PIN_NAMES = Object.freeze(['PAYDIRT_OMP', 'PAYDIRT_OMP_ARGS']);

/**
 * Locate the omp binary and, when it is a bun shim, the bun runtime it needs on PATH.
 *   PAYDIRT_OMP       path of the binary to start
 *   PAYDIRT_OMP_ARGS  a JSON array of arguments placed before omp's own (for running omp as
 *                     '<runtime> <cli.js>', which is how a private pinned copy is started)
 * Each is taken from the environment, else from `pins` (the same two names read from
 * .local/benchmark.env), else omp is looked up on PATH. The two belong together: when the
 * environment names the binary, the file's arguments are not used with it.
 * `source` says where the binary came from: "environment", "env-file" or "path".
 */
export function resolveOmp(env = process.env, pins = null) {
  const home = os.homedir();
  const file = pins ?? {};
  const source = env.PAYDIRT_OMP ? 'environment' : file.PAYDIRT_OMP ? 'env-file' : 'path';
  const bin = env.PAYDIRT_OMP || file.PAYDIRT_OMP || onPath('omp', env) || path.join(home, '.bun', 'bin', WIN ? 'omp.exe' : 'omp');
  if (!fs.existsSync(bin)) throw new Error(source === 'path' ? `omp not found (looked on PATH and at ${bin}). Set PAYDIRT_OMP.` : `omp not found at ${bin} (PAYDIRT_OMP, from ${source === 'environment' ? 'the environment' : '.local/benchmark.env'}).`);
  const bun = env.PAYDIRT_BUN || onPath('bun', env) || [path.join(home, '.bun', 'bin', WIN ? 'bun.exe' : 'bun')].find((p) => fs.existsSync(p)) || null;
  const raw = env.PAYDIRT_OMP_ARGS !== undefined ? env.PAYDIRT_OMP_ARGS : source === 'environment' ? undefined : file.PAYDIRT_OMP_ARGS;
  let prefix = [];
  if (raw) {
    try { prefix = JSON.parse(raw); } catch { prefix = null; }
    if (!Array.isArray(prefix) || prefix.some((a) => typeof a !== 'string')) throw new Error('PAYDIRT_OMP_ARGS must be a JSON array of strings');
  }
  return { bin, bun, prefix, source };
}

/** One line saying which omp is started and where that choice came from. */
export function describeOmp(omp) {
  const where = { environment: 'PAYDIRT_OMP in the environment', 'env-file': 'pinned in .local/benchmark.env', path: 'found on PATH' }[omp.source] ?? String(omp.source);
  return `${[omp.bin, ...omp.prefix].join(' ')} (${where})`;
}

/**
 * Set up one harness invocation: a private directory tree under the work root holding a
 * copy of the three harness files and, per worker, a throwaway home, an empty launch
 * directory and a temp directory. Nothing in it survives `destroy()`.
 * `envFile` is where an omp pin may stand (default: <repo>/.local/benchmark.env, the file
 * that holds the key); only the two pin settings are read from it here.
 */
export function createInvocation({ benchDir, protocol, key = '', envFile = envFilePath(path.resolve(benchDir, '..')) }) {
  const texts = {};
  for (const name of HARNESS_FILES) {
    texts[name] = lf(fs.readFileSync(path.join(benchDir, 'harness', name), 'utf8'));
    const expected = protocol.files?.[`harness/${name}`];
    if (expected && sha256(texts[name]) !== expected) throw new Error(`harness/${name} does not match protocol.json (run "node bench/bench.mjs freeze" after a deliberate change)`);
  }
  const { root, rejected } = pickWorkRoot();
  const omp = resolveOmp(process.env, readEnvValues(envFile, OMP_PIN_NAMES));
  const dir = path.join(root, rid());
  const h = path.join(dir, 'h');
  fs.mkdirSync(h, { recursive: true });
  const harness = {};
  for (const name of HARNESS_FILES) {
    fs.writeFileSync(path.join(h, name), texts[name]);
    harness[name] = path.join(h, name);
  }
  const modelsYml = routingModelsYml(protocol);
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const pathDirs =[omp.bun ? path.dirname(omp.bun) : null, path.dirname(omp.bin), ...(WIN ? [path.join(sysRoot, 'System32'), sysRoot] : ['/usr/local/bin', '/usr/bin', '/bin'])].filter(Boolean);
  const ctx = {
    dir, root, rejected, omp, harness, protocol, key, live: new Set(), workers: new Map(),
    worker(index) {
      if (!this.workers.has(index)) {
        const base = path.join(dir, `w${index}`);
        const w = { index, home: path.join(base, 'home'), launch: path.join(base, 'launch'), tmp: path.join(base, 'tmp') };
        for (const d of Object.values(w)) if (typeof d === 'string') fs.mkdirSync(d, { recursive: true });
        // the one file the throwaway home holds: the benchmark's provider-routing policy
        if (modelsYml !== null) {
          const target = modelsYmlPath(w.home, ompProfile(protocol));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, modelsYml);
        }
        this.workers.set(index, w);
      }
      return this.workers.get(index);
    },
    /** The complete child environment. Only the listed variables exist; the one credential is the OpenRouter key. */
    env(w, extra = {}) {
      const e = WIN
        ? {
            SystemRoot: sysRoot, windir: sysRoot, SystemDrive: process.env.SystemDrive || 'C:', COMSPEC: path.join(sysRoot, 'System32', 'cmd.exe'),
            PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: [...new Set(pathDirs)].join(';'),
            USERPROFILE: w.home, HOME: w.home, HOMEDRIVE: path.parse(w.home).root.replace(/\\$/, ''), HOMEPATH: w.home.slice(path.parse(w.home).root.length - 1),
            APPDATA: path.join(w.home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(w.home, 'AppData', 'Local'), TEMP: w.tmp, TMP: w.tmp,
            // Windows fills these in from the parent when they are absent, so set neutral values
            USERNAME: 'bench', USERDOMAIN: 'BENCH', LOGONSERVER: '\\\\BENCH',
          }
        : { PATH: [...new Set(pathDirs)].join(':'), HOME: w.home, TMPDIR: w.tmp, LANG: 'C.UTF-8' };
      for (const name of ['NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']) if (WIN && process.env[name]) e[name] = process.env[name];
      if (this.key) e.OPENROUTER_API_KEY = this.key;
      return { ...e, ...extra };
    },
    killAll() { for (const pid of [...this.live]) killTree(pid); },
    destroy() { this.killAll(); return rmrf(dir); },
  };
  return ctx;
}

/** Kill a process and every descendant. On Windows this is `taskkill /T /F`. */
export function killTree(pid) {
  if (!pid) return;
  if (WIN) {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 20000 });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
}

/** `omp --version` under the same clean environment the runs use. */
export function ompVersion(ctx) {
  const w = ctx.worker(0);
  const r = spawnSync(ctx.omp.bin, [...ctx.omp.prefix, '--version'], { env: ctx.env(w), cwd: w.launch, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.error || r.status !== 0) throw new Error(`omp --version failed: ${r.error?.message ?? String(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return String(r.stdout).trim();
}

/** The exact argument vector for one run (no shell is involved; each element is one argument). */
export function ompArgs(ctx, { model, systemFile, nonce, cwd, task }) {
  const o = ctx.protocol.omp;
  return [
    ...o.flags,
    '--config', ctx.harness['bench-overlay.yml'],
    '-e', ctx.harness['dump-ext.ts'],
    '-e', ctx.harness['jail-ext.ts'],
    '--tools', o.tools.join(','),
    '--thinking', o.thinking,
    '--max-time', `${o.max_time_minutes}m`,
    '--system-prompt', systemFile,
    '--append-system-prompt', `run-nonce: ${nonce}`,
    '--cwd', cwd,
    '--model', `${o.provider}/${model}`,
    '--', task,
  ];
}

/**
 * Run omp once.
 *   files      [{ path, bytes }] the workspace to copy
 *   outDir     where events.jsonl, stderr.txt, request.json and requests.jsonl are written
 *   task       the first user message, or ({ slot, ws }) => string (selftest only)
 *   prepare    optional ({ slot, ws }) => void, called after the workspace copy (selftest only)
 * Resolves (never rejects) with what happened; classification is the caller's job.
 */
export function runOmp(ctx, workerIndex, { model, system, task, files, outDir, nonce = crypto.randomUUID(), prepare = null, hardKillSeconds = null }) {
  const o = ctx.protocol.omp;
  const w = ctx.worker(workerIndex);
  const slot = path.join(ctx.dir, rid());
  const ws = path.join(slot, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  for (const f of files) {
    const target = path.join(ws, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.bytes);
  }
  if (prepare) prepare({ slot, ws });
  const systemFile = path.join(slot, 'system.txt');
  fs.writeFileSync(systemFile, system);
  const dump = path.join(slot, 'requests.jsonl');
  if (fs.readdirSync(w.launch).length) { rmrf(w.launch); fs.mkdirSync(w.launch, { recursive: true }); } // the launch directory must be empty
  fs.mkdirSync(outDir, { recursive: true });

  const taskText = typeof task === 'function' ? task({ slot, ws }) : task;
  const args = ompArgs(ctx, { model, systemFile, nonce, cwd: ws, task: taskText });
  const hardMs = (hardKillSeconds ?? o.max_time_minutes * 60 + o.hard_kill_grace_seconds) * 1000;
  const scrub = (text) => (ctx.key ? text.split(ctx.key).join('[REDACTED]') : text);

  return new Promise((resolve) => {
    const started = Date.now();
    const events = fs.createWriteStream(path.join(outDir, 'events.jsonl'));
    const result = { nonce, cwd: ws, args: args.slice(0, -1).map((a) => a.split(ctx.dir).join('<work>')), exitCode: null, signal: null, timedOut: false, spawnError: null, wallMs: 0, counts: {}, dropped: 0, badLines: 0, sawModelOutput: false, firstOutputMs: null };
    let stderr = '';
    let pending = '';
    let settled = false;
    let child;
    const handleLine = (line) => {
      if (!line.trim()) return;
      if (line.startsWith('{"type":"message_update"')) {
        result.counts.message_update = (result.counts.message_update ?? 0) + 1; result.dropped++;
        if (!result.sawModelOutput) { result.sawModelOutput = true; result.firstOutputMs = Date.now() - started; }
        return;
      }
      let ev;
      try { ev = JSON.parse(line); } catch { result.badLines++; events.write(`${JSON.stringify({ type: '_unparsed', text: scrub(line).slice(0, 4000) })}\n`); return; }
      result.counts[ev.type] = (result.counts[ev.type] ?? 0) + 1;
      if (ev.type === 'message_end' && ev.message?.role === 'assistant' && !result.sawModelOutput && (ev.message.usage?.output > 0 || (ev.message.content ?? []).length)) {
        result.sawModelOutput = true; result.firstOutputMs = Date.now() - started;
      }
      const kept = compactEvent(ev);
      if (!kept) { result.dropped++; return; }
      events.write(`${scrub(JSON.stringify(kept))}\n`);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.pid) ctx.live.delete(child.pid);
      if (pending) handleLine(pending);
      result.wallMs = Date.now() - started;
      fs.writeFileSync(path.join(outDir, 'stderr.txt'), scrub(stderr).slice(-200000));
      let requests = { count: 0, bad: 0, first: null, system: '', summaries: [], models: [], efforts: [], toolsets: [], routing: [] };
      try {
        const raw = scrub(fs.readFileSync(dump, 'utf8'));
        requests = parseRequests(raw);
        // keep the complete first request (system prompt, tool schemas, first user message) and a one-line summary of every request
        fs.writeFileSync(path.join(outDir, 'request.json'), `${JSON.stringify(requests.first)}\n`);
        fs.writeFileSync(path.join(outDir, 'requests.jsonl'), raw.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.stringify(summarizeRequest(JSON.parse(l))); } catch { return JSON.stringify({ unparsed: true }); } }).join('\n') + '\n');
      } catch { /* no request was sent */ }
      result.requests = requests;
      events.end(() => {
        result.slotRemoved = rmrf(slot);
        resolve(result);
      });
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      if (child?.pid) killTree(child.pid);
      setTimeout(finish, 15000).unref(); // if the pipes never close, settle anyway
    }, hardMs);
    try {
      child = spawn(ctx.omp.bin, [...ctx.omp.prefix, ...args], { cwd: w.launch, env: ctx.env(w, { OMP_BENCH_DUMP: dump }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: !WIN });
    } catch (e) {
      result.spawnError = e.message;
      finish();
      return;
    }
    if (child.pid) ctx.live.add(child.pid);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 400000) stderr += chunk; });
    child.on('error', (e) => { result.spawnError = e.message; finish(); });
    child.on('close', (code, signal) => { result.exitCode = code; result.signal = signal; finish(); });
  });
}
