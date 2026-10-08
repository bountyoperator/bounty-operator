// /benchmark, /benchmark/method and the home-page strip, built from published
// Paydirt results. The fixture releases are made by the benchmark's own
// aggregate() from synthetic outcomes, in three shapes: many models, two of
// them with profile arms, and a practice set; six models with neither; and a
// release whose not_run list is partly filled, with a model whose runs did
// not finish.
//
// The page ranks models on the raw arm and shows no with/without comparison.
// The "many" release has profile arms that score below the raw arm and above
// it, so the tests here prove that neither reaches the page.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_SCORING, NOT_RUN_REASON, aggregate, modelFile } from '../../bench/lib/score.mjs';
import { loadPages, scanTags, validateMarkup } from '../../scripts/build-site.mjs';
import { renderPage } from '../site/layout.mjs';
import { DEFAULT_DIR, PUBLISHED_DIR, buildView, findings, fmt, loadPublished, pairsRight } from '../site/pages/benchmark/_data.mjs';
import { renderMethod, repoLink } from '../site/pages/benchmark/_markdown.mjs';
import { benchmarkPages } from '../site/pages/benchmark/index.mjs';
import { methodPages } from '../site/pages/benchmark/method.mjs';
import { teaser } from '../site/pages/benchmark/_teaser.mjs';
import { assertNoBannedNames } from './private-lists.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(WEB_DIR, '..');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const PAGES_DIR = path.join(WEB_DIR, 'site', 'pages');
const BENCH_PAGES = path.join(PAGES_DIR, 'benchmark');

// ---------------------------------------------------------------------------
// Fixture releases
// ---------------------------------------------------------------------------

const ARMS = { 'find-sol': ['raw', 'solidity'], 'find-ts': ['raw', 'general'], challenge: ['raw', 'report'] };
const VARIANTS = { 'find-sol': ['vulnerable', 'fixed'], 'find-ts': ['vulnerable', 'fixed'], challenge: ['overclaimed', 'accurate'] };
const AUTHORS = ['google', 'openai', 'x-ai', 'anthropic', 'deepseek', 'qwen'];

function pairsOf(prefixes) {
  const pairs = [];
  for (const [family, prefix, count, visibility] of prefixes) {
    for (let index = 1; index <= count; index += 1) {
      const pair = `${prefix}-${String(index).padStart(2, '0')}`;
      const cases = Object.fromEntries(VARIANTS[family].map((variant) => [variant, `${pair}-${variant[0]}`]));
      pairs.push({ pair, family, visibility, author: AUTHORS[(index + prefix.length) % AUTHORS.length], cases });
    }
  }
  return pairs;
}

const SCORED = pairsOf([['find-sol', 'sol', 10, 'held'], ['find-ts', 'ts', 2, 'held'], ['challenge', 'ch', 6, 'held']]);
const PRACTICE = pairsOf([['find-sol', 'psol', 3, 'public'], ['find-ts', 'pts', 1, 'public'], ['challenge', 'pch', 2, 'public']]);

/** A deterministic number in [0, 1) from a string. */
function unit(text) {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash / 2 ** 32;
}

function outcome({ pair, variant, arm, model, correct, failed, usd }) {
  const base = {
    case: pair.cases[variant], pair: pair.pair, family: pair.family, variant, status: 'ok', failure: null, correct,
    findings_read: 1, hits: [], planted: variant === 'vulnerable' ? 1 : 0, primary_all: null, bite: null, decoys: pair.family === 'challenge' ? 0 : 1, decoy_bites: 0, unmatched: 0,
    verdict: null, quote_hit: null, max_severity: 'high', max_severity_exact: null,
    usd, wall_s: 60 + Math.round(unit(`${model.slug}|${pair.pair}|${variant}|t`) * 600), tokens_in: 1000, tokens_out: 400, tokens_reasoning: 100, turns: 3,
    effort: model.effort ?? 'max', providers: ['HostOne'], stop: 'stop', arm, rep: 1, infra_retries: unit(`${model.slug}|${pair.pair}|r`) < 0.05 ? 1 : 0,
  };
  if (failed) return { ...base, status: 'failed', failure: 'timeout', correct: false };
  if (variant === 'vulnerable') return { ...base, hits: correct ? [{ id: 'p1', primary: true, finding: 0, by_line: true, by_function: true, severity: 'high', severity_exact: true, severity_distance: 0 }] : [], primary_all: correct };
  if (variant === 'fixed') return { ...base, bite: !correct };
  if (variant === 'overclaimed') return { ...base, verdict: correct ? 'overclaimed' : 'supported', quote_hit: correct };
  return { ...base, verdict: correct ? 'supported' : 'overclaimed' };
}

/** Outcomes of one model: `skill` sets how often it is right; `missing` leaves inputs out (an unfinished run). */
function outcomesOf(model, pairs, { arms = ['raw'], missing = 0 } = {}) {
  const list = [];
  let left = missing;
  for (const arm of arms) {
    for (const pair of pairs) {
      if (!ARMS[pair.family].includes(arm)) continue;
      for (const variant of VARIANTS[pair.family]) {
        if (arm === 'raw' && left > 0 && unit(`${model.slug}|${pair.pair}|${variant}|m`) < 0.5) {
          left -= 1;
          continue;
        }
        const roll = unit(`${model.slug}|${pair.pair}|${variant}|${arm}`);
        const skill = arm === 'raw' ? model.skill : model.skill + (model.lift ?? 0);
        const failed = roll > 0.985;
        list.push(outcome({ pair, variant, arm, model, correct: !failed && roll < skill, failed, usd: model.usd * (0.8 + unit(`${model.slug}|${pair.pair}|${variant}|u`) * 0.4) }));
      }
    }
  }
  return list;
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Write latest.json, models/, practice/ and an archive into `dir` the way publish does. */
function writeRelease(dir, { models, notRun, notes, practice = false, release = 'fx-1' }) {
  const archive = `paydirt-${release}-public.tar.gz`;
  const meta = {
    release, run_id: release, protocol_sha256: 'a'.repeat(64),
    hashes: { protocol: 'a'.repeat(64), core: 'b'.repeat(64), arms: { raw: 'b'.repeat(64), solidity: 'c'.repeat(64), general: 'd'.repeat(64), report: 'e'.repeat(64) } },
    harness_commit: 'abcdef1', omp_version: 'omp/18.4.4', generated_at: '2026-10-04T08:00:00.000Z', prices_at: '2026-10-01T00:00:00.000Z', repeats: 1, thinking: 'max',
    commitments: SCORED.flatMap((pair) => Object.values(pair.cases)).map((id) => ({ case: id, sha256: 'f'.repeat(64) })),
    downloads: { archive, sha256: '9'.repeat(64), bytes: 331776, public_runs: 0 },
    ...(notRun !== undefined ? { not_run: notRun } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  const input = (pairs, list) => ({
    meta, scoring: DEFAULT_SCORING, arms: ARMS, pairs,
    models: list.map((model) => ({ slug: model.slug, name: model.name, vendor: model.slug.split('/')[0], open_weight: model.open === true, price: { in: 0.1, out: 0.5 }, run_tier: model.tier ?? 1, outcomes: outcomesOf(model, pairs, model) })),
  });
  const scored = input(SCORED, models);
  const results = aggregate(scored);
  writeJson(path.join(dir, 'latest.json'), results);
  writeJson(path.join(dir, `${release}.json`), results);
  for (const model of scored.models) writeJson(path.join(dir, 'models', modelFile(model.slug)), { schema: 'paydirt.model/1', release, run_id: release, slug: model.slug, outcomes: model.outcomes });
  writeFileSync(path.join(dir, archive), 'archive bytes');
  if (practice) {
    const list = models.slice(0, 3).map((model) => ({ ...model, arms: ['raw'], missing: 0 }));
    const practiced = input(PRACTICE, list);
    const practiceResults = aggregate({ ...practiced, meta: { ...meta, commitments: [], downloads: { ...meta.downloads, archive: `../${archive}` }, not_run: undefined, notes: undefined } });
    writeJson(path.join(dir, 'practice', 'latest.json'), practiceResults);
    for (const model of practiced.models) writeJson(path.join(dir, 'practice', 'models', modelFile(model.slug)), { schema: 'paydirt.model/1', release, slug: model.slug, outcomes: model.outcomes });
  }
  return results;
}

const model = (slug, name, skill, usd, extra = {}) => ({ slug, name, skill, usd, open: /deepseek|qwen|z-ai/.test(slug), ...extra });

const MANY = [
  model('deepseek/ds-flash', 'DS Flash', 0.92, 0.06, { arms: ['raw', 'solidity', 'general', 'report'], lift: -0.3 }),
  model('openai/oa-luna', 'OA Luna', 0.9, 0.21, { arms: ['raw', 'solidity', 'general', 'report'], lift: 0.05 }),
  model('anthropic/an-sonnet', 'AN Sonnet', 0.88, 0.35),
  model('google/gg-flash', 'GG Flash', 0.86, 0.02),
  model('z-ai/za-glm', 'ZA GLM', 0.84, 0.016),
  model('qwen/qw-27b', 'QW 27B', 0.8, 0.085, { effort: 'high' }),
  model('x-ai/xa-grok', 'XA Grok', 0.75, 0.12),
  model('mistralai/mi-med', 'MI Medium', 0.7, 0.03),
  model('meta/me-spark', 'ME Spark', 0.6, 0.05),
  model('minimax/mm-m3', 'MM M3', 0.55, 0.039),
  model('moonshotai/ms-k3', 'MS K3', 0.45, 0.21),
  model('tencent/tc-hy4', 'TC Hy4', 0.35, 0.087),
];

const SHAPES = {
  many: { models: MANY, notRun: [{ slug: 'openai/gpt-oss-x', name: 'gpt-oss-x', tier: 1, reason: 'Its hosts returned the model’s tool calls as plain text on every input, so no answer was produced.' }, ...['a/one', 'b/two', 'c/three'].map((slug) => ({ slug, name: slug, tier: 3, reason: NOT_RUN_REASON }))], notes: ['One repeat per input in this release.'], practice: true },
  six: { models: MANY.slice(2, 8).map((entry) => ({ ...entry, arms: ['raw'] })), notRun: [], notes: [] },
  partial: {
    models: [...MANY.slice(0, 5).map((entry) => ({ ...entry, arms: ['raw'] })), model('google/gg-pro', 'GG Pro', 0.9, 0.4, { missing: 20 })],
    notRun: [{ slug: 'x-ai/xa-mini', name: 'XA Mini', tier: 2, reason: NOT_RUN_REASON }],
  },
};

const ROOT = mkdtempSync(path.join(tmpdir(), 'paydirt-page-'));
const EMPTY = path.join(ROOT, 'empty');
mkdirSync(EMPTY, { recursive: true });
const fixtures = {};
for (const [name, shape] of Object.entries(SHAPES)) {
  const dir = path.join(ROOT, name);
  writeRelease(dir, shape);
  const published = loadPublished(dir);
  fixtures[name] = { dir, published, view: buildView(published), page: benchmarkPages(published)[0], method: methodPages(published)[0] };
}
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

// The pages of the rest of the site, for link resolution. The benchmark modules export none here: nothing is published by default.
const sitePages = await loadPages(PAGES_DIR);

function resolverFor(dir, extra = []) {
  const paths = new Set([...sitePages.map((page) => page.path), ...extra.map((page) => page.path)]);
  return (pathname) => {
    if (paths.has(pathname) || pathname.startsWith('/api/')) return true;
    if (pathname.startsWith('/bench/')) return existsSync(path.join(dir, pathname.slice('/bench/'.length)));
    if (pathname === '/') return true;
    const file = path.join(PUBLIC_DIR, pathname);
    return existsSync(file) || existsSync(`${file}.html`);
  };
}

function render(page, dir, extra) {
  const resolves = resolverFor(dir, extra);
  return renderPage(page, { pages: [...sitePages, ...extra], has: resolves, preloadsFor: () => [] });
}

const textOf = (markup) =>
  markup
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

const mainOf = (markup) => markup.slice(markup.indexOf('<main'), markup.indexOf('</main>'));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the fixture releases have the shapes the page must handle', () => {
  const { many, six, partial } = fixtures;
  assert.equal(many.view.rows.length, 12);
  const withProfiles = many.published.results.models.filter((entry) => Object.keys(entry.lift ?? {}).length);
  assert.equal(withProfiles.length, 2, 'two models with profile arms in the results file');
  const deltas = withProfiles.flatMap((entry) => Object.values(entry.lift).map((lift) => lift.delta));
  assert.ok(deltas.some((delta) => delta < 0) && deltas.some((delta) => delta > 0), 'the file holds a profile arm below the raw arm and one above it');
  assert.ok(many.view.practice, 'a practice set');
  assert.equal(six.view.rows.length, 6);
  assert.equal(six.view.practice, null);
  assert.equal(partial.view.rows.length, 5, 'the unfinished model is not ranked');
  assert.deepEqual(partial.view.incomplete.map((entry) => entry.slug), ['google/gg-pro']);
  assert.equal(partial.published.results.notes, undefined, 'a file without notes');
});

test('each shape renders /benchmark and /benchmark/method with no generator error, one h1 and every internal link resolving', () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    const extra = [fixture.page, fixture.method];
    for (const page of extra) {
      const markup = render(page, fixture.dir, extra);
      const result = validateMarkup(markup, resolverFor(fixture.dir, extra));
      assert.deepEqual(result.errors, [], `${name} ${page.path}`);
      assert.deepEqual(result.unresolved, [], `${name} ${page.path}: every internal link resolves`);
      assert.deepEqual(result.warnings, [], `${name} ${page.path}`);
      assert.equal(scanTags(markup).filter((tag) => tag.name === 'h1').length, 1);
      assert.ok(page.description.length >= 50 && page.description.length <= 160, `${name}: description ${page.description.length}`);
      assert.ok(page.title.length <= 65, `${name}: title ${page.title.length}`);
      assert.equal(page.nav, 'benchmark');
    }
    assert.equal(fixture.page.path, '/benchmark');
    assert.equal(fixture.method.path, '/benchmark/method');
  }
});

test('no inline script, no inline style, and the only scripts are the page module and JSON-LD', () => {
  for (const fixture of Object.values(fixtures)) {
    const markup = render(fixture.page, fixture.dir, [fixture.page, fixture.method]);
    const tags = scanTags(markup);
    assert.equal(tags.filter((tag) => tag.name === 'style').length, 0);
    assert.equal(tags.filter((tag) => tag.attributes.has('style')).length, 0);
    assert.equal(tags.filter((tag) => [...tag.attributes.keys()].some((key) => /^on/.test(key))).length, 0);
    const scripts = tags.filter((tag) => tag.name === 'script');
    for (const script of scripts) {
      if (script.attributes.has('src')) assert.ok(['/theme.js', '/benchmark/leaderboard.mjs'].includes(script.attributes.get('src')), script.attributes.get('src'));
      else assert.equal(script.attributes.get('type'), 'application/ld+json');
    }
  }
});

test('every number in the leaderboard is the file’s number through the page’s formatter', () => {
  for (const [name, { page, view, dir }] of Object.entries(fixtures)) {
    const markup = render(page, dir, [page]);
    const rows = [...markup.matchAll(/<tr class="lb__row"([^>]*)>([\s\S]*?)<\/tr>/g)];
    assert.equal(rows.length, view.rows.length, name);
    const results = view.results;
    const ranked = results.models.filter((m) => m.arms.raw && m.arms.raw.unresolved === 0);
    assert.deepEqual(view.rows.map((row) => row.slug), ranked.map((m) => m.slug), `${name}: the file's order`);
    rows.forEach(([, rowAttrs, cells], index) => {
      const m = ranked[index];
      const arm = m.arms.raw;
      const text = textOf(cells);
      for (const value of [
        fmt.score(arm.score.median),
        `${pairsRight(arm.score.median, arm.pairs)} pairs`,
        `95% interval ${fmt.score(arm.score.ci95[0])} to ${fmt.score(arm.score.ci95[1])}`,
        fmt.rate(arm.recall),
        fmt.rate(arm.fools_gold),
        fmt.rate(arm.challenge_ba),
        fmt.rate(arm.failure),
        fmt.usd(arm.usd_run),
        fmt.seconds(arm.latency_p50_s),
        m.effort,
        m.name,
        m.slug,
      ]) {
        assert.ok(text.includes(value), `${name} ${m.slug}: "${value}" in "${text}"`);
      }
      assert.match(rowAttrs, new RegExp(`data-score="${arm.score.median}"`));
      assert.match(rowAttrs, new RegExp(`data-tier="${m.tier}"`));
    });
    // the facts strip
    const facts = textOf(markup.slice(markup.indexOf('bench-facts'), markup.indexOf('id="board"')));
    const spend = results.models.reduce((sum, m) => sum + m.usd_total, 0);
    for (const value of [`Models ranked ${view.rows.length}`, `Held pairs ${results.cases.pairs}`, `Inputs per model ${results.cases.inputs}`, `Recorded inference cost ${fmt.usd(spend)}`, `Published ${fmt.date(results.generated_at)}`, 'Harness omp 18.4.4']) {
      assert.ok(facts.includes(value), `${name}: ${value} in ${facts}`);
    }
  }
});

test('picks, the pair grid and the not-run list show the file’s values and nothing invented', () => {
  const { many, six, partial } = fixtures;
  const markup = render(many.page, many.dir, [many.page]);
  const text = textOf(markup);
  // picks: every shown pick is in the file with that score and cost
  const pickSection = textOf(markup.slice(markup.indexOf('id="picks"'), markup.indexOf('id="pairs"')));
  for (const group of many.view.picks) {
    for (const entry of group.entries) {
      assert.ok(pickSection.includes(entry.row.name));
      assert.ok(pickSection.includes(fmt.usd(entry.usd_run)));
      assert.ok(many.published.results.picks.some((pick) => pick.model === entry.model && pick.score === entry.score && pick.usd_run === entry.usd_run));
    }
  }
  assert.match(markup, /href="\/\?profile=solidity#workspace"/);
  // pair grid: one row per ranked model, one cell per pair, right counts match the score
  for (const line of many.view.grid) {
    assert.equal(line.cells.length, many.published.results.pairs.length);
    assert.equal(line.right, Math.round((line.row.score * line.row.pairs) / 100), line.row.slug);
  }
  assert.equal((markup.match(/class="pg__cell" data-outcome=/g) ?? []).length, many.view.grid.length * 18);
  // no practice set: that section is absent
  const sixMarkup = render(six.page, six.dir, [six.page]);
  assert.doesNotMatch(sixMarkup, /The practice set/);
  assert.match(text, /The practice set/);
  // not run: every listed model, the default reason, and the unfinished model with its count
  const partialText = textOf(render(partial.page, partial.dir, [partial.page]));
  assert.ok(partialText.includes('XA Mini'));
  assert.ok(partialText.includes(NOT_RUN_REASON));
  const gg = partial.view.incomplete[0];
  assert.ok(partialText.includes(`${gg.answered} of ${gg.inputs} inputs completed`));
  assert.ok(!/GG Pro[^.]*\b\d+(?:\.\d)? of 18 pairs/.test(partialText.slice(0, partialText.indexOf('Not run'))), 'the unfinished model has no score');
  assert.ok(text.includes('One repeat per input in this release.'), 'the release notes are shown');
  assert.ok(text.includes('gpt-oss-x'));
});

/** What the page must never carry: the comparison, the lift table, a signed drop, a link to either. */
function assertNoComparison(markup, where) {
  assert.doesNotMatch(markup, /id="comparison"/, `${where}: no comparison section`);
  assert.doesNotMatch(markup, /id="lift"/, `${where}: no lift section`);
  assert.doesNotMatch(markup, /href="[^"]*#(?:comparison|lift)"/, `${where}: no link to either`);
  assert.doesNotMatch(markup, /data-sign=/, `${where}: no signed change cell`);
  const text = textOf(markup);
  // U+2212 is the minus the formatters printed; a hyphen counts when it opens a number.
  assert.doesNotMatch(text, /\u2212\s?\d/, `${where}: no minus sign before a digit`);
  assert.doesNotMatch(text, /(?:^|[\s(])-\d/, `${where}: no hyphen-minus opening a number`);
  for (const phrase of [/with and without/i, /without Bounty Operator/i, /With Bounty Operator/, /\blifts?\b/i, /\bdeclines?\b/i, /percentage points/i, /Historical comparison/i]) {
    assert.doesNotMatch(text, phrase, `${where}: ${phrase}`);
  }
}

test('the with/without comparison is withheld: no section, no lift table, no negative number, no link to either', () => {
  const { many } = fixtures;
  for (const [name, fixture] of Object.entries(fixtures)) {
    assertNoComparison(render(fixture.page, fixture.dir, [fixture.page, fixture.method]), `/benchmark (${name})`);
  }
  // The hero leads to the leaderboard and the method, and nowhere else.
  const body = String(many.page.body);
  const hero = body.slice(0, body.indexOf('aria-label="Test setup"'));
  assert.deepEqual([...hero.matchAll(/<a class="btn[^"]*" href="([^"]+)"/g)].map((match) => match[1]), ['#board', '/benchmark/method']);
  assert.match(textOf(hero), /12 models on 18 held pairs: which one finds the planted bug/);
  assert.match(body, /<h2 id="board">Model leaderboard<\/h2>/);
  // The view the pages are built from carries no comparison either.
  for (const key of ['lifts', 'liftsPending', 'comparisons', 'liftModels']) assert.ok(!(key in many.view), key);
  assert.equal(fmt.delta, undefined, 'the signed-difference formatter is gone with its only users');
  // The frozen results file still holds every profile arm: withheld from the page, not removed from the release.
  const file = JSON.parse(readFileSync(path.join(many.dir, 'latest.json'), 'utf8'));
  assert.ok(file.models.some((entry) => Object.values(entry.lift ?? {}).some((lift) => lift.delta < 0)));
  assert.match(body, /href="\/bench\/latest\.json"/);
  assert.match(textOf(body), /The profile arms, which add a Bounty Operator core profile, are in the results file: download it, the file keeps every published number\./);
  // A release that ran no profile arm says nothing about them.
  assert.doesNotMatch(textOf(String(fixtures.six.page.body)), /profile arms/);
});

test('no page source and no stylesheet links or styles the withheld sections', () => {
  const sources = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(?:mjs|md)$/.test(name)) sources.push(file);
    }
  };
  walk(path.join(WEB_DIR, 'site'));
  assert.ok(sources.length > 30);
  for (const file of sources) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /#comparison\b|#lift\b|id="comparison"|id="lift"|data-sign/, path.relative(WEB_DIR, file));
  }
  for (const name of ['benchmark.css', 'home.css', 'landing.css']) {
    assert.doesNotMatch(readFileSync(path.join(PUBLIC_DIR, 'css', name), 'utf8'), /\.comparison|\.lift\b|\.lift__|data-sign/, name);
  }
  // Every page of the site, rendered with the fixture release in place.
  const site = siteWith(fixtures.many.dir);
  assert.deepEqual(site.errors, []);
  for (const [file, markup] of Object.entries(site.pages)) {
    assert.doesNotMatch(markup, /href="[^"]*#(?:comparison|lift)"/, file);
    assert.doesNotMatch(markup, /id="(?:comparison|lift)"/, file);
  }
  assert.match(site.pages['index.html'], /<a class="link" href="\/benchmark">See the model benchmark<\/a>/);
  assertNoComparison(site.pages['benchmark.html'], 'benchmark.html in the built site');
});

test('each finding is true of the data or left out', () => {
  const { many } = fixtures;
  const list = findings(many.view);
  assert.ok(list.length >= 3 && list.length <= 4);
  const top = many.view.tiers[0].rows;
  const first = list.find((entry) => entry.id === 'top-tier');
  if (top.length >= 2) assert.ok(first.text.includes(String(top.length)) || /^[A-Z][a-z]+ models share/.test(first.text));
  // one ranked model: nothing about tiers or spreads can be said
  const single = { ...many.view, rows: many.view.rows.slice(0, 1), tiers: [{ tier: 1, rows: many.view.rows.slice(0, 1) }] };
  const alone = findings(single).map((entry) => entry.id);
  assert.ok(!alone.includes('top-tier') && !alone.includes('top-tier-cost') && !alone.includes('cost-spread'));
  // equal costs: no cost sentence
  const flat = many.view.rows.map((row) => ({ ...row, arm: { ...row.arm, usd_run: 0.05 } }));
  const same = findings({ ...many.view, rows: flat, tiers: [{ tier: 1, rows: flat }] }).map((entry) => entry.id);
  assert.ok(!same.includes('top-tier-cost') && !same.includes('cost-spread'));
  // every number a finding states is in the file
  for (const entry of findings(many.view, { limit: 10 })) {
    for (const money of entry.text.match(/\$[\d.]+/g) ?? []) {
      assert.ok(many.view.rows.some((row) => fmt.usd(row.arm.usd_run) === money), `${entry.id}: ${money}`);
    }
  }
});

test('the Dataset, breadcrumb and FAQ JSON-LD parse and point at the published files', () => {
  for (const fixture of Object.values(fixtures)) {
    const markup = render(fixture.page, fixture.dir, [fixture.page]);
    const blocks = scanTags(markup).filter((tag) => tag.name === 'script' && tag.attributes.get('type') === 'application/ld+json').map((tag) => JSON.parse(tag.content));
    const dataset = blocks.find((block) => block['@type'] === 'Dataset');
    assert.ok(dataset);
    assert.equal(dataset.creator.name, 'Bounty Operator');
    assert.equal(dataset.dateModified, '2026-10-04');
    assert.ok(dataset.distribution.some((entry) => entry.contentUrl === 'https://bountyoperator.com/bench/latest.json'));
    assert.ok(dataset.distribution.some((entry) => entry.contentUrl === `https://bountyoperator.com/bench/${fixture.published.results.downloads.archive}`));
    assert.match(dataset.license, /\/LICENSE$/);
    assert.ok(dataset.description.length >= 50);
    assert.ok(blocks.some((block) => block['@type'] === 'BreadcrumbList'));
    const faq = blocks.find((block) => block['@type'] === 'FAQPage');
    const visible = textOf(markup);
    for (const entry of faq.mainEntity) assert.ok(visible.includes(entry.acceptedAnswer.text), entry.name);
    assert.match(markup, /<link rel="canonical" href="https:\/\/bountyoperator\.com\/benchmark">/);
    assert.match(markup, /<meta property="og:title" content="Paydirt fx-1: which model finds the real bug">/);
  }
});

test('the copy carries no hedges, no exclamation, no em dash and no private name', () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    const text = textOf(mainOf(render(fixture.page, fixture.dir, [fixture.page])));
    for (const pattern of [/\bmay\b/i, /\bmight\b/i, /can help/i, /not a guarantee/i, /\bcannot\b/i, /\bsimply\b/i, /\bpowerful\b/i, /!/, /—/]) {
      assert.doesNotMatch(text, pattern, `${name}: ${pattern}`);
    }
    assertNoBannedNames(text, `/benchmark (${name})`, { page: '/benchmark' });
    assertNoBannedNames(textOf(mainOf(render(fixture.method, fixture.dir, [fixture.page, fixture.method]))), `/benchmark/method (${name})`, { page: '/method' });
  }
  for (const file of readdirSync(BENCH_PAGES)) assertNoBannedNames(readFileSync(path.join(BENCH_PAGES, file), 'utf8'), file);
});

test('nothing is generated or linked when no results are published', () => {
  assert.equal(loadPublished(EMPTY), null);
  assert.deepEqual(benchmarkPages(null), []);
  assert.deepEqual(methodPages(null), []);
  assert.equal(teaser(null), '');
  // The pages exist exactly when the folder the build reads (web/public/bench unless PAYDIRT_PUBLISHED_DIR says otherwise) has a latest.json.
  const published = existsSync(path.join(PUBLISHED_DIR, 'latest.json'));
  assert.equal(sitePages.some((page) => page.path === '/benchmark'), published);
  assert.equal(sitePages.some((page) => page.path === '/benchmark/method'), published);
});

/**
 * The whole site rendered in a child process with PAYDIRT_PUBLISHED_DIR set, so the page modules
 * load fresh. It renders against a copy of web/public without generated benchmark pages or
 * published files, so a page left on disk by an earlier build cannot count as existing.
 */
let copies = 0;
function siteWith(dir) {
  const publicCopy = path.join(ROOT, `public-${(copies += 1)}`);
  cpSync(PUBLIC_DIR, publicCopy, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(PUBLIC_DIR, source).split(path.sep).join('/');
      return rel !== 'benchmark.html' && !rel.startsWith('benchmark/method') && rel !== 'bench' && !rel.startsWith('bench/');
    },
  });
  const script = `
    const { renderSite } = await import(${JSON.stringify(pathToFileURL(path.join(REPO_DIR, 'scripts', 'build-site.mjs')).href)});
    const site = await renderSite({ dev: true, publicDir: ${JSON.stringify(publicCopy)} });
    const out = {};
    for (const [file, markup] of site.outputs) if (file.endsWith('.html')) out[file.split(String.fromCharCode(92)).join('/')] = markup;
    process.stdout.write(JSON.stringify({ errors: site.errors, pages: out }));`;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO_DIR, env: { ...process.env, PAYDIRT_PUBLISHED_DIR: dir }, maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout.toString('utf8'));
}

test('the site without results: no benchmark page, no link to one, no strip on the home page', () => {
  const site = siteWith(EMPTY);
  assert.deepEqual(site.errors, []);
  assert.ok(!('benchmark.html' in site.pages) && !('benchmark/method.html' in site.pages));
  for (const [file, markup] of Object.entries(site.pages)) {
    assert.doesNotMatch(markup, /href="\/benchmark(?:[#/"])/, file);
  }
  assert.doesNotMatch(site.pages['index.html'], /bench-teaser|\/css\/benchmark\.css/);
});

test('the site with results: both pages, the nav item, the footer link and the home strip with the top three', () => {
  const { many } = fixtures;
  const site = siteWith(many.dir);
  assert.deepEqual(site.errors, []);
  assert.ok('benchmark.html' in site.pages && 'benchmark/method.html' in site.pages);
  assert.match(site.pages['guide.html'], /<li><a href="\/benchmark">Benchmark<\/a><\/li>/);
  const home = site.pages['index.html'];
  // The strip is styled by home.css: the home page does not load benchmark.css for it.
  assert.doesNotMatch(home, /\/css\/benchmark\.css/);
  assert.match(home, /<link rel="stylesheet" href="\/css\/home\.css">/);
  const homeCss = readFileSync(path.join(PUBLIC_DIR, 'css', 'home.css'), 'utf8');
  const benchCss = readFileSync(path.join(PUBLIC_DIR, 'css', 'benchmark.css'), 'utf8');
  assert.doesNotMatch(benchCss, /\.bench-teaser/);
  for (const name of ['bench-teaser', 'bench-teaser__inner', 'bench-teaser__row', 'bench-teaser__go']) assert.ok(homeCss.includes(`.${name} {`), `home.css styles .${name}`);
  const start = home.indexOf('class="wrap bench-teaser"');
  const strip = textOf(home.slice(start, home.indexOf('</section>', start)));
  assert.ok(strip.includes(`Paydirt: ${many.view.rows.length} models on 18 held pairs`));
  // the first three places and every model tied with the third, five rows at most
  const cut = many.view.rows[2].rank;
  const shown = many.view.rows.filter((row) => row.rank <= cut).slice(0, 5);
  assert.ok(shown.length >= 3);
  for (const row of shown) {
    assert.ok(strip.includes(row.name) && strip.includes(fmt.score(row.score)) && strip.includes(fmt.usd(row.arm.usd_run)), row.slug);
  }
  const next = many.view.rows[shown.length];
  if (next && next.rank > cut) assert.ok(!strip.includes(`>${next.name}<`) && !strip.includes(next.name), 'no row past the third place and its ties');
  // the home copy rules hold with the strip in place
  for (const pattern of [/\bmay\b/i, /!/, /—/]) assert.doesNotMatch(strip, pattern);
});

test('the page modules import nothing from bench/private or web/private', () => {
  const seen = new Set();
  const queue = readdirSync(BENCH_PAGES).filter((file) => file.endsWith('.mjs')).map((file) => path.join(BENCH_PAGES, file));
  queue.push(path.join(PUBLIC_DIR, 'benchmark', 'leaderboard.mjs'));
  const imports = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith('.')) {
        assert.match(specifier, /^node:/, `${file}: ${specifier}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), specifier);
      imports.push(path.relative(REPO_DIR, target).split(path.sep).join('/'));
      if (target.startsWith(path.join(WEB_DIR, 'site')) || target.startsWith(path.join(PUBLIC_DIR, 'benchmark'))) queue.push(target);
    }
  }
  assert.ok(imports.length > 5);
  for (const entry of imports) assert.doesNotMatch(entry, /(^|\/)private\//, entry);
  // the files the pages read are the published ones and METHOD.md
  for (const file of readdirSync(BENCH_PAGES)) {
    const source = readFileSync(path.join(BENCH_PAGES, file), 'utf8');
    assert.doesNotMatch(source, /bench\/private|web\/private|operator-profiles|salts|truth\.json'|bench\/runs/, file);
  }
});

test('the method page renders METHOD.md in full and links only public repository files', () => {
  const markdown = readFileSync(path.join(REPO_DIR, 'bench', 'METHOD.md'), 'utf8');
  const method = renderMethod(markdown);
  const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
  assert.deepEqual(method.sections.map((section) => section.title), headings);
  const { many } = fixtures;
  const markup = render(many.method, many.dir, [many.page, many.method]);
  const text = textOf(markup);
  assert.ok(text.includes('Paydirt Score = 100 × correct pairs ÷ scored pairs (18)'));
  assert.match(markup, /<table class="table table--dense md-table">/);
  assert.match(markup, /<figure class="code md-code">/);
  assert.match(markup, /data-copy/);
  // the generated selection block is rendered, its comment markers are not
  assert.ok(text.includes('Status: final.'));
  assert.doesNotMatch(markup, /selection:begin|hashes:begin/);
  // repository paths resolve to the public repository; held material is never linked
  assert.match(markup, /href="https:\/\/github\.com\/bountyoperator\/bounty-operator\/blob\/main\/bench\/tools\/select\.mjs"/);
  assert.match(markup, /href="https:\/\/github\.com\/bountyoperator\/bounty-operator\/blob\/main\/bench\/protocol\.json"/);
  for (const href of [...markup.matchAll(/href="([^"]+)"/g)].map((match) => match[1])) {
    assert.doesNotMatch(href, /\/(?:private|runs|verify)\/|\.local|benchmark\.env|salts/, href);
  }
  assert.equal(repoLink('private/salts.json'), null);
  assert.equal(repoLink('runs/2026-10/plan.json'), null);
  assert.equal(repoLink('.local/benchmark.env'), null);
  assert.match(repoLink('prompts/answer-sheet.md'), /\/blob\/main\/bench\/prompts\/answer-sheet\.md$/);
  assert.ok(markup.includes('href="/benchmark"'), 'a link back to the leaderboard');
});

test('the leaderboard script builds no markup from strings, and the stylesheet uses tokens only', () => {
  const source = readFileSync(path.join(PUBLIC_DIR, 'benchmark', 'leaderboard.mjs'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|\bfetch\(/);
  const css = readFileSync(path.join(PUBLIC_DIR, 'css', 'benchmark.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  assert.doesNotMatch(css, /!important/);
  for (const match of css.matchAll(/font-size:\s*([^;]+);/g)) assert.match(match[1], /var\(--fs-\d+\)|inherit|\d*\.?\d+em/, match[0]);
  // every column the picker can hide has a rule that hides it
  const page = readFileSync(path.join(BENCH_PAGES, 'index.mjs'), 'utf8');
  for (const key of ['recall', 'fools', 'challenge', 'failure', 'cost', 'time', 'effort']) {
    assert.ok(page.includes(`key: '${key}'`), key);
    assert.ok(css.includes(`.lb[data-hide~="${key}"] [data-col="${key}"]`), key);
  }
});

test('llms.txt names the benchmark pages exactly when they are generated', () => {
  const llms = readFileSync(path.join(PUBLIC_DIR, 'llms.txt'), 'utf8');
  const generated = existsSync(path.join(DEFAULT_DIR, 'latest.json'));
  const lines = [
    '- [Benchmark](https://bountyoperator.com/benchmark): Paydirt, the model benchmark: which model finds the planted bug, leaves the fixed twin alone and catches an overclaimed report, with cost per run.',
    '- [Benchmark method](https://bountyoperator.com/benchmark/method): How Paydirt is built and scored, and how to check every published number.',
  ];
  if (generated) for (const line of lines) assert.ok(llms.includes(line), `llms.txt needs, under "## Product":\n${line}`);
  else assert.doesNotMatch(llms, /bountyoperator\.com\/benchmark/, 'llms.txt links a benchmark page that is not generated');
});

test('dollars read the same at every size: no trailing zero after rounding', () => {
  assert.equal(fmt.usd(0.1), '$0.10');
  assert.equal(fmt.usd(0.2199), '$0.22');
  assert.equal(fmt.usd(0.22), '$0.22');
  assert.equal(fmt.usd(0.063048), '$0.063');
  assert.equal(fmt.usd(0.0075), '$0.0075');
  assert.equal(fmt.usd(0.00999), '$0.010');
  assert.equal(fmt.usd(35.123), '$35.12');
  assert.equal(fmt.usd(0), '$0');
});

test('the blocked-answers note is shown for the verified original release only', () => {
  const { many } = fixtures;
  const original = {
    ...many.published,
    results: { ...many.published.results, run_id: '2026-10', harness_commit: '2aa1601b097aea7edc8711d88b4219bc900e8dc7' },
  };
  const body = String(benchmarkPages(original)[0].body);
  const honest = textOf(body.slice(body.indexOf('aria-labelledby="honest"'), body.indexOf('aria-labelledby="verify"')));
  assert.ok(honest.includes('Blocked answers: Anthropic’s cyber safeguards blocked 5 answers in this release: 3 from Claude Fable 5.1 and 2 from Claude Opus 5.5, all on the raw arm, the model alone.'));
  assert.ok(honest.includes('The benchmark account is not in Anthropic’s Cyber Verification Program.'));
  assert.ok(honest.includes('The blocks count as misses in this release.'));
  // One plain note: it names no other model and explains no other result.
  const note = honest.slice(honest.indexOf('Blocked answers:'), honest.indexOf('The blocks count as misses in this release.'));
  assert.doesNotMatch(note, /Luna|Sonnet|GLM|DeepSeek/);
  assertNoComparison(body, 'the original release');
  for (const changed of [{ run_id: 'later-run' }, { harness_commit: 'another-harness' }]) {
    const other = { ...original, results: { ...original.results, ...changed } };
    assert.ok(!textOf(String(benchmarkPages(other)[0].body)).includes('Blocked answers'), 'no unverified counts on another release');
  }
});

test('the published release: five blocked answers on the page, no comparison, and the profile arms still in the results file', () => {
  const published = loadPublished(DEFAULT_DIR);
  if (!published || published.results.run_id !== '2026-10') return;
  const [page] = benchmarkPages(published);
  const body = String(page.body);
  assertNoComparison(body, 'the published release');
  assert.ok(textOf(body).includes('Anthropic’s cyber safeguards blocked 5 answers in this release'));
  // Withheld, not removed: the file the page links keeps the profile arms it no longer shows.
  assert.ok(published.results.models.some((entry) => Object.keys(entry.lift ?? {}).length > 0));
});
