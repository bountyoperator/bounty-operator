#!/usr/bin/env node
// Builds web/public/example.mjs from web/public/examples/<id>/ and, on request,
// regenerates the stored model answers by running the product's own prompts.
//
//   node scripts/build-examples.mjs                    assemble example.mjs (no network)
//   node scripts/build-examples.mjs --check            exit 1 when example.mjs is out of date
//   node scripts/build-examples.mjs --review <id>      run the example's profile and store review.md
//   node scripts/build-examples.mjs --gauntlet <id>    run the eight stages and store gauntlet/stage-N-<profile>.md
//   node scripts/build-examples.mjs --panel <id>       run the panel and store panel/panel-N-<model>.md and panel/merged.md
//
// Options
//   --model <slug>      OpenRouter model for --review, --gauntlet and the panel judge (default anthropic/claude-opus-5.5)
//   --from <n>          with --gauntlet: keep stages 1 to n-1 as stored and run from stage n
//   --models <a,b,c>    with --panel: the model for each seat
//   --reuse-review      with --panel: seat 1 is the stored review.md, when its model is first in --models
//
// The key is OPENROUTER_API_KEY from the environment, else from .local/benchmark.env.
// It is sent to openrouter.ai and nowhere else, and never printed.
//
// A model answer is stored exactly as it arrived. When an answer is wrong, change
// the example's input files and run it again; never edit the answer.
//
// The gauntlet stages and the panel merge are hosted profiles: their method is
// not in this repository. Regenerating them needs web/private/operator-profiles.mjs
// and is refused without it, because an example shows the product, not the
// community stub. A stored answer is a model output and is published; one that
// repeats eight words in a row of the method is refused, never stored.
//
// An example folder holds
//   example.json            id, order, title, summary, profile, mode, focus, context, files (names, in order)
//   <the input files>
//   review.md, review.json  the stored answer and how it was produced
//   gauntlet/               stage-N-<profile>.md and gauntlet.json
//   panel/                  panel-N-<model>.md, merged.md and panel.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'web', 'public');
const EXAMPLES_DIR = path.join(PUBLIC, 'examples');
const OUTPUT = path.join(PUBLIC, 'example.mjs');
const DEFAULT_MODEL = 'anthropic/claude-opus-5.5';
const PROVIDER = 'openrouter';

const load = (relative) => import(pathToFileURL(path.join(PUBLIC, relative)).href);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { command: 'build', id: '', model: DEFAULT_MODEL, from: 1, models: [], reuseReview: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${arg} needs a value.`);
      return argv[index];
    };
    if (arg === '--check') options.command = 'check';
    else if (arg === '--review' || arg === '--gauntlet' || arg === '--panel') {
      options.command = arg.slice(2);
      options.id = value();
    } else if (arg === '--model') options.model = value();
    else if (arg === '--from') options.from = Number(value());
    else if (arg === '--models') options.models = value().split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (arg === '--reuse-review') options.reuseReview = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Reading an example folder
// ---------------------------------------------------------------------------

function readText(file) {
  // Line endings are normalised so the stored hashes do not depend on the checkout.
  return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function exists(file) {
  return fs.existsSync(file);
}

function exampleIds() {
  return fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exists(path.join(EXAMPLES_DIR, entry.name, 'example.json')))
    .map((entry) => entry.name);
}

function readExample(id) {
  const dir = path.join(EXAMPLES_DIR, id);
  if (!exists(path.join(dir, 'example.json'))) throw new Error(`No example named "${id}" in web/public/examples.`);
  const meta = readJson(path.join(dir, 'example.json'));
  if (meta.id !== id) throw new Error(`${id}/example.json names the id "${meta.id}".`);
  const files = meta.files.map((name) => ({ name, content: readText(path.join(dir, ...name.split('/'))) }));
  return { dir, meta, files };
}

/** The stored answers of an example, as they go into example.mjs. Missing parts are left out. */
function storedAnswers(dir) {
  const stored = {};
  if (exists(path.join(dir, 'review.md')) && exists(path.join(dir, 'review.json'))) {
    const info = readJson(path.join(dir, 'review.json'));
    stored.review = readText(path.join(dir, 'review.md'));
    stored.model = info.model;
    stored.generatedAt = info.generatedAt;
    stored.usage = info.usage;
  }
  const gauntletInfo = path.join(dir, 'gauntlet', 'gauntlet.json');
  if (exists(gauntletInfo)) {
    const info = readJson(gauntletInfo);
    stored.gauntlet = {
      model: info.model,
      generatedAt: info.generatedAt,
      stages: info.stages.map((stage) => ({
        profileId: stage.profileId,
        model: stage.model,
        usage: stage.usage,
        review: readText(path.join(dir, 'gauntlet', stage.file)),
      })),
    };
  }
  const panelInfo = path.join(dir, 'panel', 'panel.json');
  if (exists(panelInfo)) {
    const info = readJson(panelInfo);
    stored.panel = {
      generatedAt: info.generatedAt,
      profileId: info.profileId,
      judge: { model: info.judge.model, usage: info.judge.usage, review: readText(path.join(dir, 'panel', 'merged.md')) },
      seats: info.seats.map((seat) => ({ model: seat.model, usage: seat.usage, review: readText(path.join(dir, 'panel', seat.file)) })),
    };
  }
  return stored;
}

// ---------------------------------------------------------------------------
// example.mjs
// ---------------------------------------------------------------------------

function moduleSource() {
  const entries = exampleIds()
    .map((id) => {
      const { dir, meta, files } = readExample(id);
      const stored = storedAnswers(dir);
      if (!stored.review) return null;
      const { order = 100, files: names, ...rest } = meta;
      return { order, entry: { ...rest, files, ...stored } };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order || a.entry.id.localeCompare(b.entry.id))
    .map(({ entry }) => entry);

  return `// GENERATED by scripts/build-examples.mjs from web/public/examples/. Do not edit by hand.
//
// The bundled examples of the workbench. Every protocol, contract, draft and
// programme below is invented for this product and deployed nowhere. The
// reviews are model answers to the product's own prompts, stored as they
// arrived, with the model and the date beside each one.
//
// Entry: { id, title, summary, profile, mode, focus, context, files: [{ name, content }],
//          review, model, generatedAt, usage,
//          gauntlet?: { model, generatedAt, stages: [{ profileId, model, usage, review }] },
//          panel?: { generatedAt, profileId, judge: { model, usage, review }, seats: [{ model, usage, review }] } }

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const EXAMPLES = freeze(${JSON.stringify(entries, null, 1)});

/** The first example, for callers that show one. */
export const EXAMPLE = EXAMPLES[0];

export default EXAMPLES;
`;
}

function build({ check }) {
  const source = moduleSource();
  const current = exists(OUTPUT) ? readText(OUTPUT) : '';
  if (check) {
    if (current !== source) {
      console.error('web/public/example.mjs is out of date. Run: node scripts/build-examples.mjs');
      process.exitCode = 1;
    } else {
      console.log('web/public/example.mjs is up to date.');
    }
    return;
  }
  fs.writeFileSync(OUTPUT, source);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)} (${Math.round(source.length / 1000)} KB).`);
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  const file = path.join(ROOT, '.local', 'benchmark.env');
  if (exists(file)) {
    for (const line of readText(file).split('\n')) {
      const match = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)$/.exec(line);
      const value = match ? match[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
      if (value) return value;
    }
  }
  throw new Error('Set OPENROUTER_API_KEY, or put it in .local/benchmark.env.');
}

/** USD per token for a model, from OpenRouter's public catalogue. */
async function priceOf(model) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(60000) });
    const catalogue = await response.json();
    const entry = catalogue.data.find((candidate) => candidate.id === model);
    return entry ? { input: Number(entry.pricing.prompt), output: Number(entry.pricing.completion) } : null;
  } catch {
    return null;
  }
}

function costOf(usage, price) {
  if (!price || !usage || !Number.isFinite(usage.input) || !Number.isFinite(usage.output)) return null;
  return Math.round((usage.input * price.input + usage.output * price.output) * 10000) / 10000;
}

const PRIVATE_PROFILES = path.join(ROOT, 'web', 'private', 'operator-profiles.mjs');
const METHOD_WORD = /[\p{L}\p{N}]+/gu;
const methodWords = (text) => (String(text).match(METHOD_WORD) ?? []).map((word) => word.toLowerCase());

/** The method of a hosted profile, from the private module only. */
async function hostedMethod(profile) {
  if (!fs.existsSync(PRIVATE_PROFILES)) {
    throw new Error(`${profile.name} is a hosted profile. Regenerating its example needs web/private/operator-profiles.mjs, which this checkout does not have.`);
  }
  const { OPERATOR_PROFILES } = await import(pathToFileURL(PRIVATE_PROFILES).href);
  return Object.hasOwn(OPERATOR_PROFILES, profile.id) ? OPERATOR_PROFILES[profile.id] : null;
}

/** The longest run of words, eight or more, that an answer shares with a method. 0 when there is none. */
function sharedRun(answer, method) {
  const RUN = 8;
  const runs = new Set();
  for (const text of [method.instructions, method.extraFormat]) {
    const list = methodWords(text);
    for (let index = 0; index + RUN <= list.length; index += 1) runs.add(list.slice(index, index + RUN).join(' '));
  }
  const list = methodWords(answer);
  let longest = 0;
  let current = 0;
  for (let index = 0; index + RUN <= list.length; index += 1) {
    current = runs.has(list.slice(index, index + RUN).join(' ')) ? (current ? current + 1 : RUN) : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

/**
 * Runs one review through the engine exactly as a hosted run does: the same
 * prepared messages, the same provider call.
 */
async function runReview({ files, focus, profileId, context, mode, model, apiKey }) {
  const { prepareReview } = await load('review-core.mjs');
  const { providerReview } = await load('providers.mjs');
  const { parseReview, checkRefs } = await load('parse.mjs');

  const prepared = await prepareReview(files, focus ?? '', profileId, { context, mode, acknowledgeWarnings: true, instructionsFor: hostedMethod });
  const started = Date.now();
  let result;
  try {
    result = await providerReview({ provider: PROVIDER, model, apiKey, prepared });
  } catch (error) {
    // Defence in depth: an error message never carries the key.
    throw new Error(String(error?.message ?? error).split(apiKey).join('[key]'));
  }
  if (prepared.profile.hosted) {
    // The stored answer is published. One that quotes the method is not stored.
    const shared = sharedRun(result.text, await hostedMethod(prepared.profile));
    if (shared) throw new Error(`The ${profileId} answer repeats ${shared} words in a row of the hosted method, so it cannot be published. Nothing was stored. Run it again.`);
  }
  const labels = prepared.manifest.map((entry) => entry.label);
  const parsed = parseReview(result.text, { labels });
  const problems = checkRefs(parsed, prepared.manifest);
  const price = await priceOf(model);
  return {
    text: result.text,
    model: result.model || model,
    usage: result.usage,
    truncated: result.truncated,
    refused: result.refused,
    seconds: Math.round((Date.now() - started) / 1000),
    cost: costOf(result.usage, price),
    manifest: prepared.manifest,
    parsed,
    problems,
  };
}

function describe(label, run) {
  const { parsed, problems } = run;
  const findings = parsed.findings.map((finding) => `${finding.id}=${finding.severity}`).join(' ') || 'no findings';
  const cost = run.cost === null ? 'cost unknown' : `US$${run.cost.toFixed(4)}`;
  console.log(`${label}: ${parsed.ok ? parsed.verdict : 'NOT PARSED'} · ${findings} · ${problems.length} reference problem${problems.length === 1 ? '' : 's'} · ${run.usage.input ?? '?'} in / ${run.usage.output ?? '?'} out · ${cost} · ${run.seconds}s · ${run.model}${run.truncated ? ' · TRUNCATED' : ''}${run.refused ? ' · REFUSED' : ''}`);
  for (const { ref, problem } of problems) console.log(`  reference problem: ${ref.label}:${ref.start}-${ref.end} ${problem}`);
}

function assertUsable(label, run) {
  if (run.refused) throw new Error(`${label}: the model declined.`);
  if (run.truncated) throw new Error(`${label}: the answer was cut off.`);
  if (!run.parsed.ok) throw new Error(`${label}: the answer has no verdict in the review format.`);
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function info(run) {
  return { model: run.model, usage: run.usage, costUsd: run.cost, verdict: run.parsed.verdict, referenceProblems: run.problems.length };
}

async function review(options) {
  const { dir, meta, files } = readExample(options.id);
  const apiKey = readKey();
  const run = await runReview({ files, focus: meta.focus, profileId: meta.profile, context: meta.context, mode: meta.mode, model: options.model, apiKey });
  describe(`${meta.id} · ${meta.profile}`, run);
  assertUsable(meta.id, run);
  writeFile(path.join(dir, 'review.md'), run.text.endsWith('\n') ? run.text : `${run.text}\n`);
  writeFile(path.join(dir, 'review.json'), `${JSON.stringify({ ...info(run), profile: meta.profile, generatedAt: new Date().toISOString() }, null, 2)}\n`);
}

async function gauntlet(options) {
  const { dir, meta, files } = readExample(options.id);
  const apiKey = readKey();
  const { GAUNTLET } = await load('profiles.mjs');
  const { stageInputs } = await load('app/gauntlet.mjs');
  const { stageRecord, stopsRun } = await load('app/dossier.mjs');

  const infoFile = path.join(dir, 'gauntlet', 'gauntlet.json');
  const previous = exists(infoFile) ? readJson(infoFile) : { stages: [] };
  const kept = options.from > 1 ? previous.stages.slice(0, options.from - 1) : [];
  if (kept.length !== options.from - 1) throw new Error(`--from ${options.from} needs stages 1 to ${options.from - 1} stored already.`);

  // The records the browser runner would hold, rebuilt from the stored answers.
  const stages = kept.map((stage, index) => stageRecord({
    number: index + 1,
    profileId: stage.profileId,
    review: readText(path.join(dir, 'gauntlet', stage.file)),
    model: stage.model,
    usage: stage.usage,
  }));
  const stored = [...kept];
  let total = 0;

  for (let index = stages.length; index < GAUNTLET.length; index += 1) {
    const profileId = GAUNTLET[index];
    // Earlier stage outputs travel as stage-N-<profile>.md, exactly as in a hosted run.
    const inputs = stageInputs(files, stages, { context: meta.context });
    const run = await runReview({ files: inputs.files, focus: '', profileId, context: meta.context, mode: 'bounty', model: options.model, apiKey });
    describe(`${meta.id} · stage ${index + 1} ${profileId}${inputs.compact ? ' (summarised inputs)' : ''}`, run);
    assertUsable(`stage ${index + 1}`, run);
    total += run.cost ?? 0;

    const record = stageRecord({ number: index + 1, profileId, review: run.text, model: run.model, usage: run.usage });
    stages.push(record);
    writeFile(path.join(dir, 'gauntlet', record.file), run.text.endsWith('\n') ? run.text : `${run.text}\n`);
    stored.push({ profileId, file: record.file, ...info(run) });
    writeFile(infoFile, `${JSON.stringify({ model: options.model, generatedAt: new Date().toISOString(), stages: stored }, null, 2)}\n`);

    if (stopsRun(record.verdict) && index < GAUNTLET.length - 1) {
      console.log(`Stage ${index + 1} says ${record.verdict}: a hosted run stops here. The stored dossier ends at this stage.`);
      break;
    }
  }
  console.log(`Gauntlet stored: ${stages.length} stage${stages.length === 1 ? '' : 's'}, about US$${total.toFixed(4)} for the stages run now.`);
}

async function panel(options) {
  const { dir, meta, files } = readExample(options.id);
  const apiKey = readKey();
  const { panelFileName, extraInputs } = await load('app/gauntlet.mjs');
  if (options.models.length < 2 || options.models.length > 4) throw new Error('--models takes two to four model slugs.');

  const reviewInfo = exists(path.join(dir, 'review.json')) ? readJson(path.join(dir, 'review.json')) : null;
  const seats = [];
  let total = 0;
  for (const [index, model] of options.models.entries()) {
    const file = panelFileName(index + 1, model);
    if (index === 0 && options.reuseReview && reviewInfo?.model === model) {
      const text = readText(path.join(dir, 'review.md'));
      writeFile(path.join(dir, 'panel', file), text);
      seats.push({ model, file, usage: reviewInfo.usage, costUsd: 0, verdict: reviewInfo.verdict, text });
      console.log(`${meta.id} · seat 1 ${model}: stored review reused`);
      continue;
    }
    const run = await runReview({ files, focus: meta.focus, profileId: meta.profile, context: meta.context, mode: meta.mode, model, apiKey });
    describe(`${meta.id} · seat ${index + 1}`, run);
    assertUsable(`seat ${index + 1}`, run);
    total += run.cost ?? 0;
    writeFile(path.join(dir, 'panel', file), run.text.endsWith('\n') ? run.text : `${run.text}\n`);
    seats.push({ model: run.model, file, ...info(run), text: run.text });
  }

  const inputs = extraInputs(files, seats.map((seat) => ({ name: seat.file, content: seat.text })), { context: meta.context });
  const judge = await runReview({ files: inputs.files, focus: '', profileId: 'panel', context: meta.context, mode: meta.mode, model: options.model, apiKey });
  describe(`${meta.id} · cross-examination`, judge);
  assertUsable('cross-examination', judge);
  total += judge.cost ?? 0;
  writeFile(path.join(dir, 'panel', 'merged.md'), judge.text.endsWith('\n') ? judge.text : `${judge.text}\n`);
  writeFile(path.join(dir, 'panel', 'panel.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    profileId: meta.profile,
    judge: info(judge),
    seats: seats.map(({ text, ...seat }) => seat),
  }, null, 2)}\n`);
  console.log(`Panel stored: ${seats.length} seats and the cross-examination, about US$${total.toFixed(4)} for the calls made now.`);
}

// ---------------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));
try {
  if (options.command === 'review') await review(options);
  else if (options.command === 'gauntlet') await gauntlet(options);
  else if (options.command === 'panel') await panel(options);
  if (options.command !== 'check') build({ check: false });
  else build({ check: true });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
