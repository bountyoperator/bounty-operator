#!/usr/bin/env node
// The production deploy of bountyoperator.com, and the gates in front of it.
//
//   node scripts/deploy.mjs             run every gate, then deploy
//   node scripts/deploy.mjs --dry-run   run every gate, then build the production bundle and deploy nothing
//
// `npm run deploy` in web/ runs this script. The steps, in order:
//   1. The production configuration must exist. It is web/wrangler.production.jsonc,
//      which git does not track: it holds the account, the routes, the database
//      id and the Stripe ids. Without it the script stops here with one line.
//   2. scripts/select-profiles.mjs --require-private: the Worker is built with
//      the hosted method, never with the community stub.
//   3. scripts/leak-audit.mjs: no text of the hosted method is in a file git
//      would publish, under web/public or in the MCP download.
//   4. scripts/build-site.mjs --check: the pages in web/public match their sources.
//   5. wrangler deploy --config wrangler.production.jsonc
//
// web/wrangler.jsonc is the public template. Its Worker has another name, so
// `wrangler deploy` run by hand in web/ cannot replace the production Worker.
// This script holds no secret and no production value.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = join(ROOT, 'web');

export const PRODUCTION_CONFIG = 'wrangler.production.jsonc';
export const TEMPLATE_CONFIG = 'wrangler.jsonc';

/**
 * Why a deploy cannot start, as one line, or null when the production
 * configuration is there.
 *
 * @param {string} [config]  File name under web/.
 * @param {(path: string) => boolean} [exists]
 * @returns {string | null}
 */
export function configRefusal(config = PRODUCTION_CONFIG, exists = existsSync) {
  if (config === TEMPLATE_CONFIG) {
    return `Refusing to deploy: web/${TEMPLATE_CONFIG} is the public template, not the production configuration.`;
  }
  if (exists(join(WEB_DIR, config))) return null;
  return `Refusing to deploy: web/${config} does not exist. It holds the production account, routes and ids and is not in the repository.`;
}

/** Wrangler's own entry script, so it runs under this Node without a shell. */
function wranglerEntry() {
  const require = createRequire(join(WEB_DIR, 'package.json'));
  const manifestPath = require.resolve('wrangler/package.json');
  const manifest = require(manifestPath);
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.wrangler;
  return join(dirname(manifestPath), bin);
}

/**
 * The commands of a deploy, in the order they run. Each is `{ name, args, cwd }`
 * for this Node; the last one is Wrangler.
 *
 * @param {{ config?: string, dryRun?: boolean, outDir?: string, wrangler?: string }} [options]
 */
export function deploySteps({ config = PRODUCTION_CONFIG, dryRun = false, outDir = '', wrangler = 'wrangler' } = {}) {
  const deploy = [wrangler, 'deploy', '--config', config];
  if (dryRun) deploy.push('--dry-run', '--outdir', outDir);
  return [
    { name: 'hosted profiles', args: [join(ROOT, 'scripts', 'select-profiles.mjs'), '--require-private'], cwd: ROOT },
    { name: 'leak audit', args: [join(ROOT, 'scripts', 'leak-audit.mjs')], cwd: ROOT },
    { name: 'page check', args: [join(ROOT, 'scripts', 'build-site.mjs'), '--check'], cwd: ROOT },
    { name: dryRun ? 'production bundle (nothing is deployed)' : 'deploy', args: deploy, cwd: WEB_DIR },
  ];
}

function parseArguments(argv) {
  const options = { dryRun: false, config: PRODUCTION_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--config') options.config = argv[(index += 1)] ?? '';
    else throw new Error(`Unknown argument: ${argument}`);
  }
  // A file name under web/, never a path: the deploy runs from that folder.
  if (!/^[A-Za-z0-9._-]+\.jsonc?$/.test(options.config)) throw new Error('--config takes a file name under web/, such as wrangler.production.jsonc.');
  return options;
}

function main(argv) {
  const options = parseArguments(argv);

  const refusal = configRefusal(options.config);
  if (refusal) {
    console.error(refusal);
    return 1;
  }

  const outDir = options.dryRun ? mkdtempSync(join(tmpdir(), 'bounty-operator-deploy-')) : '';
  const steps = deploySteps({ ...options, outDir, wrangler: wranglerEntry() });
  for (const [index, step] of steps.entries()) {
    console.log(`\n[${index + 1}/${steps.length}] ${step.name}`);
    const result = spawnSync(process.execPath, step.args, { cwd: step.cwd, stdio: 'inherit' });
    if (result.status !== 0) {
      const deploying = index === steps.length - 1 && !options.dryRun;
      console.error(
        deploying
          ? 'Wrangler stopped with an error. Check what is live: npm run verify:live -- --base-url https://bountyoperator.com'
          : `Stopped at "${step.name}". Nothing was deployed.`,
      );
      if (outDir) rmSync(outDir, { recursive: true, force: true });
      return result.status ?? 1;
    }
  }
  if (options.dryRun) {
    // The bundle holds the hosted method: it is built to prove that it builds, then removed.
    rmSync(outDir, { recursive: true, force: true });
    console.log('\nThe production bundle builds. Nothing was deployed.');
  } else {
    console.log('\nDeployed. Now run: npm run verify:live -- --base-url https://bountyoperator.com');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
