// The Worker configuration is split in two. web/wrangler.jsonc is the public
// template: no account, no route, no live database, billing off, and a Worker
// name that is not the production one. The production values live in
// web/wrangler.production.jsonc, which git ignores, and scripts/deploy.mjs is
// the only thing that deploys from it.
//
// The comparison with the production file runs only where that file exists.
// It compares shapes and shared values and never prints an id.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PRODUCTION_CONFIG, TEMPLATE_CONFIG, configRefusal, deploySteps, pagesOf } from '../../scripts/deploy.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(WEB_DIR, '..');
const DEPLOY_SCRIPT = path.join(REPO_DIR, 'scripts', 'deploy.mjs');
const PRODUCTION_PATH = path.join(WEB_DIR, PRODUCTION_CONFIG);

/** JSON with // comments, as Wrangler reads it. A // inside a string is kept. */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === '\\') {
        index += 1;
        out += text[index];
      } else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
    } else {
      out += char;
    }
  }
  return JSON.parse(out);
}

const template = parseJsonc(readFileSync(path.join(WEB_DIR, TEMPLATE_CONFIG), 'utf8'));
const templateText = readFileSync(path.join(WEB_DIR, TEMPLATE_CONFIG), 'utf8');

test('the public template names no account, no route and no live database', () => {
  assert.equal(template.name, 'bounty-operator-dev');
  assert.equal(Object.hasOwn(template, 'account_id'), false);
  assert.equal(Object.hasOwn(template, 'routes'), false);
  assert.equal(Object.hasOwn(template, 'route'), false);
  assert.equal(template.workers_dev, false);
  assert.equal(template.preview_urls, false);

  assert.equal(template.d1_databases.length, 1);
  assert.equal(template.d1_databases[0].binding, 'DB');
  assert.equal(template.d1_databases[0].database_id, '00000000-0000-0000-0000-000000000000');

  assert.deepEqual(template.vars, {
    SITE_ORIGIN: 'http://localhost:8787',
    BILLING_MODE: 'disabled',
    STRIPE_PRICE_ID: '',
    STRIPE_PORTAL_CONFIGURATION: '',
    AI_REVIEW_ENABLED: 'true',
  });

  // No identifier of a live resource in any form: a 32-hex account id, a
  // database UUID other than the placeholder, a Stripe id, a custom domain.
  assert.doesNotMatch(templateText, /\b[0-9a-f]{32}\b/);
  const uuids = templateText.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g) ?? [];
  assert.deepEqual(uuids, ['00000000-0000-0000-0000-000000000000']);
  assert.doesNotMatch(templateText, /\b(?:price|bpc|prod|cus|sub|whsec|sk|rk)_[A-Za-z0-9]{8,}/);
  assert.doesNotMatch(templateText, /custom_domain/);

  // It says where the production values are.
  assert.match(templateText, /wrangler\.production\.jsonc, which git does not track/);
});

test('the template still runs the whole Worker: assets, crons, limits, flags and bindings', () => {
  assert.equal(template.main, 'src/worker.ts');
  assert.deepEqual(template.compatibility_flags, ['nodejs_compat', 'enable_request_signal']);
  assert.deepEqual(template.limits, { cpu_ms: 30000 });
  assert.equal(template.observability.logs.invocation_logs, false, 'no per-request logs of addresses and user agents');
  assert.deepEqual(template.assets, {
    directory: './public',
    binding: 'ASSETS',
    run_worker_first: true,
    html_handling: 'auto-trailing-slash',
    not_found_handling: '404-page',
  });
  assert.deepEqual(template.triggers, { crons: ['17 3 * * *', '*/15 * * * *'] });
  assert.deepEqual(template.ratelimits, [{ name: 'API_LIMITER', namespace_id: '7001', simple: { limit: 120, period: 60 } }]);
  assert.deepEqual(template.version_metadata, { binding: 'CF_VERSION_METADATA' });
  assert.equal(template.d1_databases[0].migrations_dir, './migrations');
});

test('git ignores the production configuration', () => {
  const ignore = readFileSync(path.join(REPO_DIR, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('web/wrangler.production.jsonc'));
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '--', 'web/wrangler.production.jsonc'], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(listed.stdout.trim(), '', 'git would not publish it');
});

test('npm run deploy goes through the gates, in order, and deploys from the production file only', () => {
  const manifest = JSON.parse(readFileSync(path.join(WEB_DIR, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.deploy, 'node ../scripts/deploy.mjs');
  assert.equal(manifest.scripts['deploy:check'], 'node ../scripts/deploy.mjs --dry-run');
  assert.equal(Object.hasOwn(manifest.scripts, 'predeploy'), false, 'the gates live in one place');
  // No script calls `wrangler deploy` on its own.
  for (const [name, command] of Object.entries(manifest.scripts)) assert.doesNotMatch(command, /wrangler deploy/, name);
  assert.match(manifest.scripts.dev, /^wrangler dev /);
  assert.doesNotMatch(manifest.scripts.dev, /--config/, 'development runs from the public template');

  const relative = (step) => step.args.map((arg) => path.relative(REPO_DIR, arg).split(path.sep).join('/') || arg);
  const steps = deploySteps();
  assert.deepEqual(steps.map((step) => step.name), ['hosted profiles', 'leak audit', 'page check', 'deploy']);
  assert.deepEqual(relative(steps[0]).slice(0, 1).concat(steps[0].args.slice(1)), ['scripts/select-profiles.mjs', '--require-private']);
  assert.deepEqual(relative(steps[1]), ['scripts/leak-audit.mjs']);
  assert.deepEqual(relative(steps[2]).slice(0, 1).concat(steps[2].args.slice(1)), ['scripts/build-site.mjs', '--check']);
  assert.deepEqual(steps[3].args, ['wrangler', 'deploy', '--config', 'wrangler.production.jsonc']);
  assert.equal(path.relative(REPO_DIR, steps[3].cwd), 'web');

  const dry = deploySteps({ dryRun: true, outDir: 'out' });
  assert.deepEqual(dry[3].args, ['wrangler', 'deploy', '--config', 'wrangler.production.jsonc', '--dry-run', '--outdir', 'out']);
  assert.equal(dry.length, 4);
});

test('a deploy without the production file is refused with one line, before any gate runs', () => {
  assert.equal(configRefusal('wrangler.production.jsonc', () => true), null);
  const missing = configRefusal('wrangler.production.jsonc', () => false);
  assert.equal(missing, 'Refusing to deploy: web/wrangler.production.jsonc does not exist. It holds the production account, routes and ids and is not in the repository.');
  assert.equal(missing.split('\n').length, 1);
  assert.match(configRefusal(TEMPLATE_CONFIG, () => true), /is the public template, not the production configuration/);

  // The command itself, pointed at a file that is not there: exit 1, the one line, and nothing else ran.
  const run = spawnSync(process.execPath, [DEPLOY_SCRIPT, '--config', 'wrangler.absent.jsonc'], { cwd: WEB_DIR, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), 'Refusing to deploy: web/wrangler.absent.jsonc does not exist. It holds the production account, routes and ids and is not in the repository.');
  assert.equal(run.stdout, '', 'no gate ran and Wrangler was not started');

  const template = spawnSync(process.execPath, [DEPLOY_SCRIPT, '--config', TEMPLATE_CONFIG], { cwd: WEB_DIR, encoding: 'utf8' });
  assert.equal(template.status, 1);
  assert.equal(template.stdout, '');

  // A path is not a file name under web/.
  for (const config of ['../wrangler.jsonc', 'sub/wrangler.jsonc', '']) {
    const refused = spawnSync(process.execPath, [DEPLOY_SCRIPT, '--config', config], { cwd: WEB_DIR, encoding: 'utf8' });
    assert.equal(refused.status, 1, config);
    assert.equal(refused.stdout, '', config);
  }
  assert.equal(spawnSync(process.execPath, [DEPLOY_SCRIPT, '--force'], { cwd: WEB_DIR, encoding: 'utf8' }).status, 1);
});

test('the deploy script holds no production value', () => {
  const source = readFileSync(DEPLOY_SCRIPT, 'utf8');
  assert.doesNotMatch(source, /\b[0-9a-f]{32}\b|\b(?:price|bpc|whsec|sk|rk)_[A-Za-z0-9]{8,}|account_id|process\.env/);
});

test(
  'the production configuration differs from the template only where production must',
  { skip: existsSync(PRODUCTION_PATH) ? false : 'this checkout has no production configuration' },
  () => {
    const production = parseJsonc(readFileSync(PRODUCTION_PATH, 'utf8'));

    // What production adds, and what it changes.
    assert.deepEqual(Object.keys(production).filter((key) => !Object.hasOwn(template, key)).sort(), ['account_id', 'routes']);
    assert.deepEqual(Object.keys(template).filter((key) => !Object.hasOwn(production, key)), []);
    assert.notEqual(production.name, template.name);
    assert.match(production.account_id, /^[0-9a-f]{32}$/);
    assert.ok(production.routes.length >= 2 && production.routes.every((route) => route.custom_domain === true));
    assert.equal(production.workers_dev, false);

    assert.deepEqual(Object.keys(production.vars).sort(), Object.keys(template.vars).sort());
    assert.equal(production.vars.BILLING_MODE, 'live');
    assert.match(production.vars.SITE_ORIGIN, /^https:\/\/[a-z0-9.-]+$/);
    assert.equal(production.vars.AI_REVIEW_ENABLED, template.vars.AI_REVIEW_ENABLED);
    assert.ok(production.vars.STRIPE_PRICE_ID.startsWith('price_'));
    assert.ok(production.routes.some((route) => `https://${route.pattern}` === production.vars.SITE_ORIGIN), 'the site origin is one of the routes');

    assert.match(production.d1_databases[0].database_id, /^[0-9a-f-]{36}$/);
    assert.notEqual(production.d1_databases[0].database_id, template.d1_databases[0].database_id);

    // Everything else is the same Worker. Compared with the ids left out, so a failure prints none.
    const shared = (config) => {
      const { name, account_id, routes, vars, d1_databases, $schema, ...rest } = config;
      return { ...rest, d1: d1_databases.map(({ database_id, ...database }) => database) };
    };
    assert.deepEqual(shared(production), shared(template));
  },
);

test('after a deploy IndexNow is told of the pages that changed, by their site paths', () => {
  assert.deepEqual(
    pagesOf(['web/public/index.html', 'web/public/guide.html', 'web/public/tools/report-check.html', 'web/public/css/base.css', 'web/public/404.html', 'web\\public\\pricing.html', 'README.md', 'web/public/guide.html']),
    ['/', '/guide', '/pricing', '/tools/report-check'],
  );
  assert.deepEqual(pagesOf([]), []);
  // The step runs after Wrangler has deployed, and its failure does not fail the deploy.
  const source = readFileSync(DEPLOY_SCRIPT, 'utf8');
  assert.ok(source.indexOf("'scripts', 'indexnow.mjs'") > source.indexOf('const steps = deploySteps('));
  assert.match(source, /if \(ping\.status !== 0\) console\.error\('IndexNow did not take the list\. The deploy stands\./);
  assert.deepEqual(deploySteps().map((step) => step.name), ['hosted profiles', 'leak audit', 'page check', 'deploy'], 'the gates are unchanged');
});
