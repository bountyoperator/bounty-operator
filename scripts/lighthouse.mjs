#!/usr/bin/env node
// Runs Lighthouse on the live site and prints, for each page on a phone and
// on a desktop, the four category scores, the lab metrics and every audit
// that did not pass. Read-only: it loads public pages and changes nothing.
//
//   node scripts/lighthouse.mjs                    the main pages, phone and desktop
//   node scripts/lighthouse.mjs / /pricing         only these paths
//   node scripts/lighthouse.mjs --all              every URL in web/public/sitemap.xml
//   node scripts/lighthouse.mjs --mobile           one form factor (or --desktop)
//   node scripts/lighthouse.mjs --min 90           exit 1 when a score is under 90
//   node scripts/lighthouse.mjs --json out.json    also write the results to a file
//   node scripts/lighthouse.mjs --base-url http://localhost:8787
//   node scripts/lighthouse.mjs --psi              measure on Google's machines instead
//
// Two ways to measure, the same report from both:
//   - By default Lighthouse runs here: npm's `npx` fetches the pinned release
//     into its cache on the first run and drives the Chrome installed on this
//     machine, headless. It needs Node 22.19 or newer and Chrome. A page on
//     localhost can be measured this way.
//   - With --psi the pages are measured through Google's PageSpeed Insights
//     API, on Google's machines. That needs a key for the PageSpeed Insights
//     API from Google Cloud, in the environment as PAGESPEED_API_KEY: the
//     quota Google shares between callers without a key is usually spent.
//
// Scores move a few points from run to run. Run it after a deploy, next to
// scripts/verify-live.mjs.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://bountyoperator.com';
export const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
// The release `npx` runs. Published 18 September 2026; move it on purpose, not by a range.
export const LIGHTHOUSE = 'lighthouse@13.5.0';
const PSI_TIMEOUT_MS = 120000;
const LOCAL_TIMEOUT_MS = 240000;
const ATTEMPTS = 3;

/** The pages a visitor is most likely to land on, and one of each kind of page. */
export const MAIN_PATHS = Object.freeze(['/', '/pricing', '/benchmark', '/guide', '/method', '/compare', '/code-security-review', '/tools/report-check', '/mcp']);

export const CATEGORIES = Object.freeze([
  { id: 'performance', param: 'PERFORMANCE', label: 'Performance' },
  { id: 'accessibility', param: 'ACCESSIBILITY', label: 'Accessibility' },
  { id: 'best-practices', param: 'BEST_PRACTICES', label: 'Best practices' },
  { id: 'seo', param: 'SEO', label: 'SEO' },
]);

// The lab metrics, in the order Lighthouse reports them.
const METRICS = Object.freeze([
  ['first-contentful-paint', 'FCP'],
  ['largest-contentful-paint', 'LCP'],
  ['total-blocking-time', 'TBT'],
  ['cumulative-layout-shift', 'CLS'],
  ['speed-index', 'SI'],
]);

// An audit in one of these modes carries no pass or fail.
const UNSCORED = new Set(['manual', 'notApplicable', 'informative', 'error']);

// What a page address may hold. No shell ever reads these (Lighthouse is
// started without one), so this is a second fence, not the only one.
const SAFE_PATH = /^\/[A-Za-z0-9._~/-]*(?:\?[A-Za-z0-9._~=-]*)?$/;
const SAFE_ORIGIN = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d+)?$/;

export function parseArguments(argv) {
  const options = { paths: [], all: false, strategies: ['mobile', 'desktop'], min: null, json: '', baseUrl: SITE, engine: 'local' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      // "--json --psi" is a forgotten file name, not a file called --psi.
      if (argv[index] === undefined || argv[index].startsWith('--')) throw new Error(`${argument} needs a value.`);
      return argv[index];
    };
    if (argument === '--all') options.all = true;
    else if (argument === '--mobile') options.strategies = ['mobile'];
    else if (argument === '--desktop') options.strategies = ['desktop'];
    else if (argument === '--psi') options.engine = 'psi';
    else if (argument === '--json') options.json = value();
    else if (argument === '--base-url') {
      const url = new URL(value());
      if (!SAFE_ORIGIN.test(url.origin)) throw new Error('--base-url takes an http or https address with a plain host name.');
      options.baseUrl = url.origin;
    } else if (argument === '--min') {
      const min = Number(value());
      if (!Number.isInteger(min) || min < 0 || min > 100) throw new Error('--min takes a whole number from 0 to 100.');
      options.min = min;
    } else if (argument.startsWith('/')) {
      if (!SAFE_PATH.test(argument)) throw new Error(`Not a path this script measures: ${argument}`);
      options.paths.push(argument);
    } else throw new Error(`Unknown argument: ${argument}. Paths start with /.`);
  }
  if (options.all && options.paths.length > 0) throw new Error('Give paths or --all, not both.');
  return options;
}

/** The paths of the sitemap, whatever origin it was written for. A path outside SAFE_PATH stops the run. */
export function sitemapPaths(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => {
    const path = new URL(match[1]).pathname;
    if (!SAFE_PATH.test(path)) throw new Error(`The sitemap lists a path this script does not measure: ${path}`);
    return path;
  });
}

/** The PageSpeed Insights request for one page and form factor. The key, when there is one, goes last. */
export function requestUrl(pageUrl, strategy, key = '') {
  const url = new URL(ENDPOINT);
  url.searchParams.set('url', pageUrl);
  url.searchParams.set('strategy', strategy.toUpperCase());
  for (const category of CATEGORIES) url.searchParams.append('category', category.param);
  if (key) url.searchParams.set('key', key);
  return url;
}

/** The arguments `npx` gets to measure one page here. A phone is Lighthouse's own default. */
export function localArguments(pageUrl, strategy) {
  return [
    '--yes', LIGHTHOUSE, pageUrl,
    '--output=json', '--output-path=stdout', '--quiet',
    `--only-categories=${CATEGORIES.map((category) => category.id).join(',')}`,
    '--chrome-flags=--headless=new',
    ...(strategy === 'desktop' ? ['--preset=desktop'] : []),
  ];
}

/**
 * How to start `npx` without a shell, so no argument is ever read as a
 * command. npm ships npx as a script beside Node: this Node runs that script.
 * Where the script is not beside Node, `npx` itself is started; Windows has
 * only a command file there, which needs a shell, so that case is refused.
 *
 * @returns {{ command: string, prefix: string[] }}
 */
export function npxCommand({ execPath = process.execPath, platform = process.platform, exists = existsSync } = {}) {
  const home = dirname(execPath);
  for (const script of [join(home, 'node_modules', 'npm', 'bin', 'npx-cli.js'), join(home, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')]) {
    if (exists(script)) return { command: execPath, prefix: [script] };
  }
  if (platform === 'win32') throw new Error('npm’s npx script is not beside this Node. Install Node with npm, or measure with --psi.');
  return { command: 'npx', prefix: [] };
}

/**
 * What one Lighthouse result says: the scores out of 100 (null when Lighthouse
 * gave none), the lab metrics as it prints them, and the audits that did not
 * pass, worst first, each once with the categories it counts in.
 *
 * @param {any} result  a Lighthouse result: the `lighthouseResult` of the API, or the CLI's JSON
 * @returns {{ version: string, scores: Record<string, number | null>, metrics: Record<string, string>, failed: { id: string, title: string, score: number, value: string, categories: string[] }[], error: string }}
 */
export function summarise(result) {
  const audits = result?.audits ?? {};
  const scores = {};
  const failed = new Map();

  for (const category of CATEGORIES) {
    const entry = result?.categories?.[category.id];
    scores[category.id] = typeof entry?.score === 'number' ? Math.round(entry.score * 100) : null;
    for (const ref of entry?.auditRefs ?? []) {
      const audit = audits[ref.id];
      if (!audit || UNSCORED.has(audit.scoreDisplayMode) || typeof audit.score !== 'number' || audit.score >= 0.9) continue;
      // A metric is listed with the metrics; a hidden audit is one Lighthouse no longer shows.
      if (ref.group === 'metrics' || ref.group === 'hidden') continue;
      const known = failed.get(ref.id);
      if (known) known.categories.push(category.label);
      else failed.set(ref.id, { id: ref.id, title: String(audit.title ?? ref.id), score: audit.score, value: String(audit.displayValue ?? ''), categories: [category.label] });
    }
  }

  const metrics = {};
  for (const [id, label] of METRICS) {
    if (typeof audits[id]?.displayValue === 'string') metrics[label] = audits[id].displayValue.replace(/ /g, ' ');
  }

  // A result with no score at all is not a measurement, whatever else it holds.
  const scored = Object.values(scores).some((score) => score !== null);
  return {
    version: String(result?.lighthouseVersion ?? ''),
    scores,
    metrics,
    failed: [...failed.values()].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)),
    error: result?.runtimeError?.message ? String(result.runtimeError.message) : scored ? '' : 'Lighthouse returned no scores.',
  };
}

/** One line of scores: "Performance 98 · Accessibility 100 · Best practices 100 · SEO 100". */
export function scoreLine(scores) {
  return CATEGORIES.map((category) => `${category.label} ${scores[category.id] ?? 'n/a'}`).join(' · ');
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Asks the API, waiting and asking again when it is busy or rate-limited. The key never leaves this function. */
async function measureRemote(pageUrl, strategy, { key = '', fetchImpl = fetch, wait = pause }) {
  const hidden = (text) => (key ? text.split(key).join('[key]') : text);
  let last = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(requestUrl(pageUrl, strategy, key), { signal: AbortSignal.timeout(PSI_TIMEOUT_MS) });
    } catch (error) {
      last = hidden(error instanceof Error ? error.message : String(error));
      await wait(attempt * 5000);
      continue;
    }
    if (response.ok) return summarise((await response.json()).lighthouseResult);
    const body = hidden((await response.text()).replace(/\s+/g, ' '));
    last = `HTTP ${response.status}: ${body.slice(0, 200)}`;
    // A spent daily quota does not come back in a minute.
    if (/per day/i.test(body) || (response.status !== 429 && response.status < 500)) break;
    await wait(attempt * 15000);
  }
  throw new Error(last);
}

/** The line of Lighthouse's error output that says what went wrong: it prints the reason first and a stack after it. */
export function failureLine(stderr) {
  const lines = String(stderr).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /Runtime error encountered:|Error:/.test(line)) ?? lines.at(-1) ?? '';
}

/** Ends a run and everything it started. On Windows a kill reaches only the first process, so the tree is named. */
function endTree(child) {
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}

/** Runs the pinned Lighthouse here and reads the result from its output. */
function measureLocal(pageUrl, strategy) {
  return new Promise((done, fail) => {
    const { command, prefix } = npxCommand();
    // No shell: the arguments reach Lighthouse as an array, exactly as written.
    const child = spawn(command, [...prefix, ...localArguments(pageUrl, strategy)], { windowsHide: true });
    let out = '';
    let err = '';
    let settled = false;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(value);
    };
    const timer = setTimeout(() => {
      endTree(child);
      settle(fail, new Error(`Lighthouse did not finish in ${LOCAL_TIMEOUT_MS / 1000} s.`));
    }, LOCAL_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => settle(fail, error));
    child.on('close', (code) => {
      const start = out.indexOf('{');
      if (start === -1) {
        settle(fail, new Error(`Lighthouse wrote no result (exit ${code}). ${failureLine(err)}`.trim()));
        return;
      }
      try {
        settle(done, summarise(JSON.parse(out.slice(start))));
      } catch {
        settle(fail, new Error(`Lighthouse wrote a result that is not JSON (exit ${code}).`));
      }
    });
  });
}

/**
 * Measures every page on every form factor, one at a time.
 *
 * @param {{ baseUrl: string, paths: string[], strategies: string[], engine?: 'local' | 'psi', key?: string, measure?: Function, fetchImpl?: Function, wait?: Function, onResult?: Function }} options
 *   `measure(pageUrl, strategy)` replaces the engine, and `fetchImpl` and `wait` the network and the clock of the API, for a test.
 * @returns {Promise<{ path: string, strategy: string, ok: boolean, detail?: string, version?: string, scores?: object, metrics?: object, failed?: object[] }[]>}
 */
export async function runLighthouse({ baseUrl, paths, strategies, engine = 'local', key = '', measure, fetchImpl, wait, onResult = () => {} }) {
  const run = measure ?? (engine === 'psi' ? (pageUrl, strategy) => measureRemote(pageUrl, strategy, { key, fetchImpl, wait }) : measureLocal);
  const results = [];
  for (const path of paths) {
    for (const strategy of strategies) {
      let entry;
      try {
        const summary = await run(`${baseUrl}${path}`, strategy);
        entry = summary.error ? { path, strategy, ok: false, detail: summary.error } : { path, strategy, ok: true, ...summary };
      } catch (error) {
        entry = { path, strategy, ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
      results.push(entry);
      onResult(entry);
    }
  }
  return results;
}

/** The lowest score across the results, or null when nothing was scored. */
export function lowestScore(results) {
  const scores = results.flatMap((entry) => (entry.ok ? Object.values(entry.scores).filter((score) => typeof score === 'number') : []));
  return scores.length ? Math.min(...scores) : null;
}

function printResult(entry) {
  const head = `${entry.path}  ${entry.strategy}`;
  if (!entry.ok) {
    console.log(`FAIL  ${head}: ${entry.detail}`);
    return;
  }
  console.log(`${head}\n  ${scoreLine(entry.scores)}`);
  const metrics = Object.entries(entry.metrics).map(([label, value]) => `${label} ${value}`).join(' · ');
  if (metrics) console.log(`  ${metrics}`);
  for (const audit of entry.failed) {
    console.log(`  - ${audit.title}${audit.value ? ` (${audit.value})` : ''}  [${audit.id}; ${audit.categories.join(', ')}]`);
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  const paths = options.all
    ? sitemapPaths(readFileSync(join(ROOT, 'web', 'public', 'sitemap.xml'), 'utf8'))
    : options.paths.length > 0 ? options.paths : [...MAIN_PATHS];
  const key = process.env.PAGESPEED_API_KEY ?? '';
  const where = options.engine === 'psi' ? `through PageSpeed Insights${key ? '' : ', no API key'}` : `here, with ${LIGHTHOUSE}`;
  console.log(`Lighthouse ${where}: ${paths.length} page(s) of ${options.baseUrl}, ${options.strategies.join(' and ')}.\n`);

  const results = await runLighthouse({ baseUrl: options.baseUrl, paths, strategies: options.strategies, engine: options.engine, key, onResult: printResult });

  if (options.json) {
    writeFileSync(resolve(options.json), `${JSON.stringify({ baseUrl: options.baseUrl, engine: options.engine, measuredAt: new Date().toISOString(), results }, null, 2)}\n`);
    console.log(`\nWritten to ${options.json}`);
  }

  const failed = results.filter((entry) => !entry.ok).length;
  const lowest = lowestScore(results);
  const version = results.find((entry) => entry.ok)?.version;
  console.log(`\n${results.length - failed} of ${results.length} measured${version ? ` with Lighthouse ${version}` : ''}. Lowest score: ${lowest ?? 'n/a'}.`);
  if (failed) return 1;
  if (options.min !== null && lowest !== null && lowest < options.min) {
    console.log(`A score is under ${options.min}.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
