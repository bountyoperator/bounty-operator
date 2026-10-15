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
//      It also stops when the owner alerts are half set up: an ALERT_EMAIL
//      send_email binding and vars.ALERT_EMAIL_TO must both be there and name
//      exactly the same plain address, or both be absent.
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** JSON with // comments, as Wrangler reads it. A // inside a string is kept. */
export function parseJsonc(text) {
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

// The Worker's own test for ALERT_EMAIL_TO. Kept the same as ADDRESS in web/src/alerts.ts,
// which web/tests/deploy-config.test.mjs checks: a value the Worker rejects must fail the deploy.
const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/**
 * Why the owner-alert settings in a parsed Wrangler config cannot work, as one
 * line, or null when they can (or are off: no ALERT_EMAIL binding and a blank
 * ALERT_EMAIL_TO). Cloudflare only delivers to the binding's
 * destination_address, and it compares the two byte for byte, so the Worker's
 * trimmed ALERT_EMAIL_TO must equal destination_address exactly, case
 * included. The line never prints an address.
 *
 * @param {{ vars?: Record<string, unknown>, send_email?: Array<Record<string, unknown>> }} config
 * @returns {string | null}
 */
export function alertConfigRefusal(config) {
  const binding = (Array.isArray(config.send_email) ? config.send_email : []).find((entry) => entry?.name === 'ALERT_EMAIL');
  const raw = config.vars?.ALERT_EMAIL_TO;
  const to = typeof raw === 'string' ? raw.trim() : '';
  if (!binding && !to) return null;
  const prefix = 'Refusing to deploy: the owner alerts are half set up.';
  if (!binding) return `${prefix} vars.ALERT_EMAIL_TO is set, but there is no send_email binding named ALERT_EMAIL.`;
  // The binding's value is taken as written: Cloudflare does not trim it.
  const destination = typeof binding.destination_address === 'string' ? binding.destination_address : '';
  if (!destination.trim()) return `${prefix} The ALERT_EMAIL send_email binding has no destination_address; pin it to the owner's verified Email Routing address.`;
  if (!to) return `${prefix} The ALERT_EMAIL binding is there, but vars.ALERT_EMAIL_TO is blank; set it to the binding's destination_address.`;
  if (!ADDRESS.test(to)) return `${prefix} vars.ALERT_EMAIL_TO is not one plain address, so the Worker would treat the alerts as not configured and send nothing.`;
  if (destination !== to) return `${prefix} vars.ALERT_EMAIL_TO differs from the ALERT_EMAIL binding's destination_address, which must match exactly, case and spacing included, or every alert would be refused.`;
  return null;
}

/** The alert check on the file being deployed. A file this parser cannot read is left to Wrangler, which reports it. */
function productionAlertRefusal(config) {
  let parsed;
  try {
    parsed = parseJsonc(readFileSync(join(WEB_DIR, config), 'utf8'));
  } catch {
    console.error(`Note: web/${config} could not be parsed here, so the owner-alert settings were not checked. Wrangler checks the file itself.`);
    return null;
  }
  return alertConfigRefusal(parsed);
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

/**
 * The site paths of the pages among `files`, as git prints them: web/public/guide.html is
 * /guide, and the home page is /. The 404 page has no address of its own.
 *
 * @param {string[]} files
 * @returns {string[]}
 */
export function pagesOf(files) {
  const paths = new Set();
  for (const file of files) {
    const match = /^web\/public\/(.+)\.html$/.exec(file.replace(/\\/g, '/'));
    if (!match || match[1] === '404') continue;
    paths.add(match[1] === 'index' ? '/' : `/${match[1]}`);
  }
  return [...paths].sort();
}

/** The pages whose built file changed in the commit being deployed. Empty when git cannot say. */
function changedPages() {
  const diff = spawnSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD', '--', 'web/public'], { cwd: ROOT, encoding: 'utf8' });
  return diff.status === 0 ? pagesOf(diff.stdout.split(/\r?\n/).filter(Boolean)) : [];
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

  const refusal = configRefusal(options.config) ?? productionAlertRefusal(options.config);
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
    const changed = changedPages();
    console.log(changed.length ? `After a deploy IndexNow would be told of ${changed.length} changed page(s): ${changed.join(' ')}` : 'No page changed in the last commit, so IndexNow would not be called.');
  } else {
    // Tell the IndexNow search engines which pages this release changed. A failure here
    // leaves the deploy as it is: the pages are live either way.
    const changed = changedPages();
    if (changed.length) {
      console.log(`\nIndexNow: ${changed.length} changed page(s)`);
      const ping = spawnSync(process.execPath, [join(ROOT, 'scripts', 'indexnow.mjs'), ...changed], { cwd: ROOT, stdio: 'inherit' });
      if (ping.status !== 0) console.error('IndexNow did not take the list. The deploy stands. Send it later: node scripts/indexnow.mjs');
    }
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
