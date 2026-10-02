#!/usr/bin/env node
// Paydirt runbook: turns a budget plan into the batches of a release run.
//   node bench/bench.mjs plan --budget-usd 160 --json <plan.json>
//   node bench/tools/runbook.mjs --plan <plan.json> [--out .local/build/BENCH-RUNBOOK.md]
//        [--concurrency 12] [--per-model 4] [--window-min 110] [--seconds-per-run 480]
//        [--key-remaining X --key-limit Y --key-used Z]   (figures of the key, printed as given)
//        [--notes <file.md>]   a hand-written section placed before the budget table
//        [--smoke-cap X]       make the first model a batch of its own with --max-usd X (the end-to-end smoke)
// Offline: it reads the plan file and protocol.json and writes Markdown. It runs nothing.
//
// A batch is one `bench.mjs run` command. Rows are taken in the order of the plan; a batch
// never mixes run tiers, and it holds no more runs than can be started and finished inside the
// window at the chosen concurrency and the assumed mean time per run. The runner enforces the
// window itself (--max-minutes), so a batch that turns out slower stops cleanly and the same
// command resumes it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { headlineArm, protocolHashes } from '../lib/protocol.mjs';

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(BENCH, '..');
const money = (v) => (v === null || v === undefined ? '-' : v < 10 ? v.toFixed(2) : v.toFixed(1));
const capOf = (high) => { const v = Math.max(1, high * 1.5); return v < 10 ? Math.ceil(v * 2) / 2 : Math.ceil(v); };

/**
 * Split the plan's rows into batches. Pure.
 * A batch must be able to finish inside one window. Runs can only start during the first
 * (window - one full run) minutes; a batch is sized so that, at the assumed mean time per
 * run, all of it is done in "fill" of that launch time (the rest is slack for slow runs and
 * timeouts). The per-model concurrency of a batch is the smallest that lets its largest
 * model finish in that time, never more than the overall concurrency.
 */
export function makeBatches({ rows, line, protocol, concurrency, windowMin, secondsPerRun, fill = 0.7, smokeCap = null }) {
  const head = protocol.scoring.headline_arm;
  const profileArms = [...new Set(Object.values(protocol.arms).flat().filter((x) => x !== head))];
  const runLimitMin = protocol.omp.max_time_minutes + (protocol.omp.hard_kill_grace_seconds + 120) / 60;
  const launchMin = windowMin - runLimitMin;
  const targetMin = fill * launchMin;
  const capacity = Math.max(1, Math.floor((concurrency * targetMin * 60) / secondsPerRun));
  const priced = rows.map((r, i) => ({ ...r, index: i, inBudget: i < line })).filter((r) => r.usd !== null);
  const profileModels = new Set(priced.filter((r) => r.arm === 'profile').map((r) => r.slug));
  // a model is one unit: its headline row plus, when both are on the same side of the budget line, its profile row
  const units = [];
  for (const r of priced) {
    const prev = units.at(-1);
    if (r.arm === 'profile' && prev && prev.slug === r.slug && prev.inBudget === r.inBudget) { prev.rows.push(r); continue; }
    units.push({ slug: r.slug, tier: r.tier, inBudget: r.inBudget, rows: [r], profileOnly: r.arm === 'profile' });
  }
  for (const u of units) {
    // which arms the command must name so that it runs exactly this unit's rows: null = the protocol's default for the model
    u.arms = u.profileOnly ? profileArms.join(',') : u.rows.length === 1 && profileModels.has(u.slug) ? head : null;
    u.plain = !profileModels.has(u.slug); // runs the headline arm only, with or without --arms
    u.runs = u.rows.reduce((s, r) => s + r.runs, 0);
  }
  // one --arms value per command: equal values share a batch, and "headline only" may share with models that have no profile arms
  const joinArms = (batch, u) => {
    if (batch.arms === u.arms) return { ok: true, arms: u.arms };
    if (batch.arms === null && u.arms === head && batch.units.every((x) => x.plain)) return { ok: true, arms: head };
    if (batch.arms === head && u.arms === null && u.plain) return { ok: true, arms: head };
    return { ok: false };
  };
  const batches = [];
  for (const u of units) {
    const last = batches.at(-1);
    // with smokeCap the first model is a batch of its own: the end-to-end smoke of the release, kept as that model's scored run
    const j = last && !(smokeCap !== null && batches.length === 1) && last.tier === u.tier && last.inBudget === u.inBudget && last.runs + u.runs <= capacity ? joinArms(last, u) : { ok: false };
    if (j.ok) { last.arms = j.arms; last.units.push(u); last.models.push(u.slug); last.rows.push(...u.rows); last.runs += u.runs; }
    else batches.push({ tier: u.tier, inBudget: u.inBudget, arms: u.arms, units: [u], models: [u.slug], rows: [...u.rows], runs: u.runs });
  }
  for (const [i, x] of batches.entries()) {
    x.n = i + 1;
    x.usd = x.rows.reduce((s, r) => s + r.usd, 0);
    x.low = x.rows.reduce((s, r) => s + (r.low ?? r.usd), 0);
    x.high = x.rows.reduce((s, r) => s + (r.high ?? r.usd), 0);
    x.cap = smokeCap !== null && i === 0 ? smokeCap : capOf(x.high);
    x.smoke = smokeCap !== null && i === 0;
    x.running = x.rows.at(-1).running;
    const largest = Math.max(...x.units.map((u) => u.runs));
    x.perModel = Math.min(concurrency, Math.max(2, Math.ceil((largest * secondsPerRun) / (targetMin * 60))));
    // the slowest lane decides: all runs through the workers, or the largest model through its own lane
    x.minutes = Math.ceil(Math.max((x.runs * secondsPerRun) / Math.min(concurrency, x.models.length * x.perModel), (largest * secondsPerRun) / x.perModel) / 60);
    x.fitsWindow = x.minutes <= launchMin;
  }
  return { batches, capacity, profileArms, launchMin, targetMin };
}

export function commandOf(b, { runId, concurrency, windowMin, budget }) {
  return `node bench/bench.mjs run --run-id ${runId} --models ${b.models.join(',')}${b.arms ? ` --arms ${b.arms}` : ''} --concurrency ${concurrency} --per-model ${b.perModel} --max-usd ${b.cap} --run-budget-usd ${budget} --max-minutes ${windowMin}`;
}

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const next = argv[i + 1]; if (next === undefined || next.startsWith('--')) flags[argv[i].slice(2)] = true; else { flags[argv[i].slice(2)] = next; i++; } }
  if (!flags.plan) throw new Error('--plan <file> is required (write it with: node bench/bench.mjs plan --budget-usd <X> --json <file>)');
  const plan = JSON.parse(fs.readFileSync(path.resolve(String(flags.plan)), 'utf8'));
  const protocol = JSON.parse(fs.readFileSync(path.join(BENCH, 'protocol.json'), 'utf8'));
  const concurrency = Number(flags.concurrency ?? 12), windowMin = Number(flags['window-min'] ?? 110), secondsPerRun = Number(flags['seconds-per-run'] ?? 480), fill = Number(flags.fill ?? 0.7);
  const runId = String(flags['run-id'] ?? protocol.release);
  const smokeCap = flags['smoke-cap'] !== undefined ? Number(flags['smoke-cap']) : null;
  const { batches, capacity, profileArms, launchMin } = makeBatches({ rows: plan.rows, line: plan.line, protocol, concurrency, windowMin, secondsPerRun, fill, smokeCap });
  const opts = { runId, concurrency, windowMin, budget: plan.budget };
  const inBudget = batches.filter((b) => b.inBudget), beyond = batches.filter((b) => !b.inBudget);
  const lastFit = plan.rows[plan.line - 1], firstOut = plan.rows[plan.line];
  const withProfile = new Set(plan.rows.filter((r) => r.arm === 'profile').map((r) => r.slug));
  const label = (r) => `\`${r.slug}\`${r.arm === 'profile' ? ' (profile arms)' : withProfile.has(r.slug) ? ' (raw arm)' : ''}`;
  // the hashes are those of protocol.json as it is now: a run is keyed by the hash of its arm, not by the plan
  const hashes = protocolHashes(protocol);
  const head = headlineArm(protocol);
  const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 16) : 'none');
  const planCore = plan.hashes?.core ?? null;
  const planNote = planCore && planCore !== hashes.core
    ? ` **The plan was drawn under core hash \`${short(planCore)}\`: draw it again** (\`node bench/bench.mjs plan --budget-usd <X> --json <file>\`).`
    : plan.protocol_sha256 && plan.protocol_sha256 !== hashes.protocol
      ? ` The plan was drawn under protocol \`${short(plan.protocol_sha256)}\`${planCore ? ', with the same core hash: only the product part has changed since, and no figure of the plan depends on it' : '; `protocol.json` has changed since'}.`
      : '';
  const L = [];
  L.push('# Paydirt v1 runbook', '');
  L.push(`Written by \`bench/tools/runbook.mjs\` from the budget plan of ${String(plan.prices_at).slice(0, 16).replace('T', ' ')} UTC. Protocol \`${short(hashes.protocol)}\`, core hash \`${short(hashes.core)}\`.${planNote} Write it again when the core hash or the plan (models, prices, budget) changes. A freeze of the product texts alone changes no command below.`, '');
  L.push('## What will run', '');
  L.push(`- Scored set: ${plan.pairs} pairs, ${plan.inputs} inputs. Raw arm, one repeat: ${plan.inputs} runs per model.`);
  L.push(`- Profile arms (${profileArms.join(', ')}) for ${protocol.run.profile_arm_models.length} models only: ${protocol.run.profile_arm_models.map((m) => `\`${m}\``).join(', ')}. ${plan.profile_inputs} more runs each.`);
  L.push('- Order: tier 1, then tier 2, then tier 3; inside a tier the cheapest model first. A model\'s profile arms run straight after its raw arm.');
  L.push(`- Budget $${plan.budget}: ${plan.fit} of ${plan.rows.length} rows fit, estimated $${money(plan.fit_usd)} (high $${money(plan.fit_high_usd)}). ${firstOut ? `The budget runs out at ${label(firstOut)}, which would bring the estimate to $${money(firstOut.running)}.` : 'Every row fits.'}${lastFit ? ` The last row that fits is ${label(lastFit)}.` : ''}`);
  if (flags['key-remaining'] !== undefined) L.push(`- **Key:** limit $${flags['key-limit']}, used $${flags['key-used']}, remaining $${flags['key-remaining']}. The runner stops when the remaining limit falls below $${protocol.run.key_floor_usd}, so the key allows about $${money(Number(flags['key-remaining']) - protocol.run.key_floor_usd)} of runs${Number(flags['key-remaining']) - protocol.run.key_floor_usd < plan.budget ? `, less than the $${plan.budget} budget. Unless the key's limit is raised, the run stops there, earlier than the budget line below` : ''}.`);
  L.push('', '## Hashes', '');
  L.push('A run is stored and counted under the hash of what it was told. A run made under a hash that has since changed is not counted, and its command makes it again.', '');
  L.push('| Arm | Hash its runs are stored under | What changes it |', '|---|---|---|');
  L.push(`| ${head} | \`${hashes.core}\` (the core hash) | a change to \`protocol.json\` outside its \`engine\` block, or to a harness file, the system prompt, the task text or the answer sheet |`);
  for (const arm of profileArms) L.push(`| ${arm} | ${hashes.arms[arm] ? `\`${hashes.arms[arm]}\`` : 'no text frozen yet'} | a change to the core, to \`prompts/profile-bridge.md\`, or a freeze of a changed \`${arm}\` text |`);
  L.push('');
  L.push(`- **Freezing the product texts again leaves every ${head}-arm run valid.** The core hash does not depend on them. Only the hash of a profile whose text changed moves, and only that profile's runs are made again.`);
  L.push('- Before a freeze, `node bench/bench.mjs freeze --dry-run` prints which hashes it would move. `node bench/bench.mjs hashes` prints the present ones: the core hash must be the one above when a batch starts, and a profile hash differs from this table once its text has been frozen again.');
  L.push(`- While the product texts are not final, a batch that holds profile arms can be split: add \`--arms ${head}\` to its command now, and run the same command with \`--arms ${profileArms.join(',')}\` after the last freeze. Profile-arm runs made before a freeze of their text are paid for twice.`);
  L.push(`- \`run\` refuses to start if \`${head}\`-arm runs are already stored under another core hash, so a change to the core cannot silently buy them again.`);
  // --notes <file>: a hand-written section (status, steps that need a decision) kept across regenerations
  if (flags.notes) L.push('', fs.readFileSync(path.resolve(String(flags.notes)), 'utf8').trim());
  L.push('', '## Budget table', '');
  L.push('| # | Tier | Model | Arm | Runs | Est $ | Low–high $ | Running $ | Batch |', '|---|---|---|---|---|---|---|---|---|');
  plan.rows.forEach((r, i) => {
    if (i === plan.line) L.push(`| | | **budget $${plan.budget} runs out here** | | | | | | |`);
    const b = batches.find((x) => x.rows.some((y) => y.index === i));
    L.push(`| ${i + 1} | ${r.tier ?? '-'} | \`${r.slug}\` | ${r.arm === 'profile' ? 'profile' : plan.headline_arm} | ${r.runs} | ${money(r.usd)} | ${r.usd === null ? '-' : `${money(r.low)}–${money(r.high)}`} | ${r.usd === null ? '-' : money(r.running)} | ${b ? b.n : '-'} |`);
  });
  L.push('', `All ${plan.rows.length} rows: $${money(plan.total)}. The estimate uses the token profile of the pilot's two cheap models; low and high are each of them alone. A model that reasons longer than both costs more than its row, which is what the caps below are for.`);
  L.push('', '## Before the first batch', '');
  L.push('Free, run every time the cases or the protocol changed:', '', '```', 'node bench/bench.mjs lint --proofs', 'node --test bench/tests', 'node bench/tools/offline-smoke.mjs', 'node bench/tools/select.mjs', 'node bench/bench.mjs hashes', `node bench/bench.mjs plan --models ${plan.rows[0]?.slug ?? '<slug>'}`, '```', '');
  L.push(`\`hashes\` must print core hash \`${short(hashes.core)}\`. \`plan\` must end with \`omp: ${protocol.omp.version}\` and name the private copy pinned in \`.local/benchmark.env\` (bench/README.md, "Pinning omp"): the machine's own \`omp\` updates itself, and \`run\` refuses any version but the pinned one.`, '');
  L.push('`select.mjs` must say that `protocol.json` already holds the split and print `status: final`. If it prints `provisional`, the difficulty probe is incomplete: finish it (`node bench/tools/probe.mjs --repeats 1 --max-usd 3`, a paid step of well under $1), then `node bench/tools/select.mjs --apply`, `node bench/bench.mjs commit`, and write this file again.', '');
  L.push('## Batches', '');
  L.push(`Each batch is one command, started in its own 2-hour background window, with \`--concurrency ${concurrency}\` and \`--max-minutes ${windowMin}\`. A run may take ${protocol.omp.max_time_minutes} minutes, so runs can only start during the first ${Math.floor(launchMin)} minutes of a window. A batch is sized to be done in ${Math.round(fill * 100)}% of that at a mean of ${secondsPerRun} seconds per run (the pilot's mean was 389 s, on easier pairs): at most ${capacity} runs. The rest is slack for slow runs and timeouts. \`--per-model\` is the smallest value that lets the largest model of the batch finish in that time.`, '');
  L.push('- `--max-usd` is the cap of that invocation, 1.5 times the batch\'s high estimate. `--run-budget-usd` is the cap on everything stored under the run id. Both count the runs in flight before starting another.');
  L.push(`- \`--max-minutes ${windowMin}\`: no run starts after minute ${Math.floor(windowMin - (protocol.omp.max_time_minutes + (protocol.omp.hard_kill_grace_seconds + 120) / 60))}, so the command ends by itself inside the window with nothing in flight.`);
  L.push('- A batch that prints `STOPPED` is not finished. Run the same command again: stored runs are skipped.');
  L.push('- If a batch stops on its `--max-usd` with runs left, the model costs more than planned. Look at the spend per model it printed before raising the cap.');
  L.push('- If a provider answers with rate limits (many `FAIL(infra)` lines), run the same command with a lower `--per-model` (for example 3). It will need more than one window; the stored runs are kept.');
  L.push('- If a batch stops with `HARNESS ERROR ... is not what protocol.json records` or `... protocol.json has changed since this invocation started`, the prompts, the product texts or `protocol.json` itself were changed while it ran. Nothing was sent for that run. Run the same command again: it runs under the new hashes, and the stored runs whose hash did not move are skipped. If it was the core hash that moved, `run` then refuses to go on over the runs already stored (see "Hashes").');
  L.push('- After every batch: `node bench/bench.mjs score --run-id ' + runId + '` and read the failure column before starting the next one.', '');
  const table = (list) => {
    L.push('| Batch | Tier | Models | Runs | Est $ | High $ | `--max-usd` | Running est $ | `--per-model` | Est minutes |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const b of list) L.push(`| ${b.n} | ${b.tier} | ${b.models.map((m) => `\`${m}\``).join(', ')}${b.arms ? ` (${b.arms === plan.headline_arm ? 'raw arm only' : 'profile arms only'})` : ''} | ${b.runs} | ${money(b.usd)} | ${money(b.high)} | ${b.cap} | ${money(b.running)} | ${b.perModel} | ${b.minutes}${b.fitsWindow ? '' : ' (more than one window)'} |`);
    L.push('');
  };
  if (inBudget.length) {
    L.push(`### Inside the $${plan.budget} budget`, '');
    table(inBudget);
    L.push('```');
    for (const b of inBudget) L.push(`# batch ${b.n}${b.smoke ? ' (the smoke: one model end to end; score it and read the result before batch 2)' : ''}: ${b.runs} runs, est $${money(b.usd)}, about ${b.minutes} min${b.fitsWindow ? '' : '; more than one window, run it again until it no longer prints STOPPED'}`, commandOf(b, opts), '');
    L.pop();
    L.push('```', '');
  }
  if (beyond.length) {
    L.push(`### Beyond the budget (not to be run on the present credit)`, '');
    L.push('Listed so the order is fixed if more credit arrives. Raise `--run-budget-usd` to the new total first.', '');
    table(beyond);
    L.push('```');
    for (const b of beyond) L.push(`# batch ${b.n}: ${b.runs} runs, est $${money(b.usd)}, about ${b.minutes} min`, commandOf(b, { ...opts, budget: '<new total>' }), '');
    L.pop();
    L.push('```', '');
  }
  L.push('## After the last batch', '', '```', `node bench/bench.mjs score --run-id ${runId}`, `node bench/bench.mjs publish --run-id ${runId}`, 'node bench/bench.mjs verify', '```', '');
  L.push('`publish` refuses while a model has unresolved infrastructure failures: rerun that model\'s batch. A model the budget did not reach is simply absent.', '');
  L.push('Optional, for the part of the numbers anyone can re-score: run the public practice set (12 inputs per model) for the models of one batch before `publish`, for example', '', '```', `node bench/bench.mjs run --run-id ${runId} --set public --arms ${plan.headline_arm} --models openai/gpt-oss-120b,deepseek/deepseek-v4.1-flash,z-ai/glm-5.3-flash,openai/gpt-6-luna --concurrency ${concurrency} --per-model 3 --max-usd 3 --run-budget-usd ${plan.budget} --max-minutes ${windowMin}`, '```', '', 'These runs count against the same run budget. `publish` then writes a second results file under `practice/`.', '');
  const text = `${L.join('\n')}\n`;
  if (flags.out) { const target = path.resolve(String(flags.out)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); process.stdout.write(`wrote ${path.relative(REPO, target)} (${batches.length} batches, ${inBudget.length} inside the budget)\n`); }
  else process.stdout.write(text);
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) { try { process.exitCode = main(); } catch (error) { process.stderr.write(`error: ${error.message}\n`); process.exitCode = 1; } }
