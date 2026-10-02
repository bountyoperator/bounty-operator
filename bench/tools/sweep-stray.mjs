#!/usr/bin/env node
// Re-read every stored run of a run id with the current classifier and remove the ones that
// ended in an unparsed tool call (METHOD.md, "The harness": a provider fault, never an
// answer). A removed run is simply run again by the next `bench.mjs run`.
//
//   node bench/tools/sweep-stray.mjs --run-id 2026-10            list them
//   node bench/tools/sweep-stray.mjs --run-id 2026-10 --apply    remove them
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEvents } from '../lib/parse.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1] ?? true; };
const runId = flag('run-id');
if (!runId || runId === true) { console.error('usage: sweep-stray.mjs --run-id <id> [--apply]'); process.exit(2); }
const apply = args.includes('--apply');
const raw = path.join(BENCH, 'runs', String(runId), 'raw');

let seen = 0;
const stray = [];
for (const model of fs.existsSync(raw) ? fs.readdirSync(raw) : []) {
  for (const run of fs.readdirSync(path.join(raw, model))) {
    const dir = path.join(raw, model, run);
    let meta, events;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'); } catch { continue; }
    seen++;
    if (meta.status === 'ok' && !meta.failure) {
      // a run stored as an answer is only swept when its final message is an unparsed call
      if (!parseEvents(events).final?.strayToolCall) continue;
    } else if (!['empty', 'unparseable'].includes(meta.failure) || !parseEvents(events).final?.strayToolCall) continue;
    stray.push({ dir, model: meta.model, run, stored: meta.failure ?? meta.status, providers: meta.providers ?? [] });
  }
}

for (const s of stray) {
  console.log(`${apply ? 'removed' : 'stray  '}  ${s.model}  ${s.run}  stored as ${s.stored}${s.providers.length ? `  via ${s.providers.join('+')}` : ''}`);
  if (apply) fs.rmSync(s.dir, { recursive: true, force: true });
}
console.log(`${seen} stored runs read, ${stray.length} ended in an unparsed tool call${apply ? ' and were removed' : stray.length ? ' (pass --apply to remove them)' : ''}`);
