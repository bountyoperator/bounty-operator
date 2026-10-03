#!/usr/bin/env node
// Re-read every stored run of a run id with the current classifier and archive the ones that
// are not answers under the current rules (METHOD.md, "The harness"): a run that ended in an
// unparsed tool call, and a run stored as the model's error whose provider message the
// current rules sort as infrastructure (a stalled stream, an account-level refusal). An
// archived run is simply run again by the next `bench.mjs run`; its evidence and cost remain.
//
//   node bench/tools/sweep-stray.mjs --run-id 2026-10            list them
//   node bench/tools/sweep-stray.mjs --run-id 2026-10 --apply    archive them
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEvents } from '../lib/parse.mjs';
import { classifyError } from '../lib/runs.mjs';
import { archiveStoredRun, rawRunDirectories, resolveRunRoot } from '../lib/evidence.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sweepStray(runRoot, { apply = false, log = console.log } = {}) {
  let seen = 0;
  const stray = [];
  for (const dir of rawRunDirectories(runRoot)) {
    let meta, metaText, events;
    try {
      if (!['meta.json', 'events.jsonl'].every((name) => fs.lstatSync(path.join(dir, name)).isFile())) continue;
      metaText = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
      meta = JSON.parse(metaText);
      events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    } catch { continue; }
    seen++;
    const record = { dir, metaText, events, model: meta.model, run: path.basename(dir), providers: meta.providers ?? [] };
    if (meta.failure === 'error' && classifyError(null, meta.failure_detail ?? '').kind !== 'error') {
      stray.push({ ...record, stored: `error (${String(meta.failure_detail).slice(0, 60)})` });
      continue;
    }
    if (meta.status === 'ok' && !meta.failure) {
      // a run stored as an answer is only swept when its final message is an unparsed call
      if (!parseEvents(events).final?.strayToolCall) continue;
    } else if (!['empty', 'unparseable'].includes(meta.failure) || !parseEvents(events).final?.strayToolCall) continue;
    stray.push({ ...record, stored: meta.failure ?? meta.status });
  }

  for (const s of stray) {
    if (apply) {
      if (fs.readFileSync(path.join(s.dir, 'meta.json'), 'utf8') !== s.metaText || fs.readFileSync(path.join(s.dir, 'events.jsonl'), 'utf8') !== s.events) throw new Error(`run changed during sweep; retry after its writer stops: ${s.dir}`);
      s.archived = archiveStoredRun(runRoot, s.dir);
    }
    log(`${apply ? 'archived' : 'stray   '}  ${s.model}  ${s.run}  stored as ${s.stored}${s.providers.length ? `  via ${s.providers.join('+')}` : ''}`);
  }
  log(`${seen} stored runs read, ${stray.length} classified as infrastructure${apply ? ' and archived with evidence and cost retained' : stray.length ? ' (pass --apply to archive them)' : ''}`);
  return { seen, stray };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--run-id');
  const runId = i < 0 ? null : args[i + 1];
  if (!runId || runId.startsWith('--')) throw new Error('usage: sweep-stray.mjs --run-id <id> [--apply]');
  const runRoot = resolveRunRoot(path.join(BENCH, 'runs'), runId);
  sweepStray(runRoot, { apply: args.includes('--apply') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`error: ${error.message}`); process.exitCode = 1; }
}
