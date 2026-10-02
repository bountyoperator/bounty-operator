// Copies the shared engine into lib/ so the package is self-contained.
//
// The source of truth is web/public. Nothing in lib/ is edited by hand; the
// copies are byte-identical and tests/engine-copy.test.mjs holds them to that.
//
//   node scripts/sync-engine.mjs           copy
//   node scripts/sync-engine.mjs --check   exit 1 when a copy is missing or stale

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(PACKAGE_ROOT, '..');
export const ENGINE_SOURCE = join(REPO_ROOT, 'web', 'public');
export const ENGINE_TARGET = join(PACKAGE_ROOT, 'lib');

/** The engine modules the server imports, and everything they import in turn. */
export const ENGINE_FILES = Object.freeze(['review-core.mjs', 'profiles.mjs', 'evidence.mjs', 'parse.mjs', 'providers.mjs']);

/** Every generated file as [source, target], both absolute. */
export const COPIES = Object.freeze([
  ...ENGINE_FILES.map((name) => Object.freeze([join(ENGINE_SOURCE, name), join(ENGINE_TARGET, name)])),
  Object.freeze([join(REPO_ROOT, 'LICENSE'), join(PACKAGE_ROOT, 'LICENSE')]),
]);

const IMPORT = /^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** Module specifiers a source file imports. */
export function importsOf(source) {
  return Array.from(source.matchAll(IMPORT), (match) => match[1] ?? match[2] ?? match[3]);
}

/** Throws when an engine module imports anything that is not another copied engine module. */
export function assertClosed(name, source) {
  for (const specifier of importsOf(source)) {
    const local = specifier.startsWith('./') ? specifier.slice(2) : null;
    if (!local || !ENGINE_FILES.includes(local)) {
      throw new Error(`${name} imports "${specifier}", which is not copied into lib/. Add it to ENGINE_FILES.`);
    }
  }
}

async function readOrNull(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** The generated files that are missing or differ from their source. */
export async function staleCopies() {
  const stale = [];
  for (const [source, target] of COPIES) {
    const [wanted, found] = await Promise.all([readFile(source), readOrNull(target)]);
    if (!found || !wanted.equals(found)) stale.push(target);
  }
  const extra = (await readdir(ENGINE_TARGET).catch(() => [])).filter((name) => !ENGINE_FILES.includes(name));
  return [...stale, ...extra.map((name) => join(ENGINE_TARGET, name))];
}

export async function syncEngine() {
  await mkdir(ENGINE_TARGET, { recursive: true });
  for (const name of await readdir(ENGINE_TARGET)) {
    if (!ENGINE_FILES.includes(name)) await rm(join(ENGINE_TARGET, name), { recursive: true, force: true });
  }

  for (const [source, target] of COPIES) {
    const bytes = await readFile(source);
    if (target.startsWith(ENGINE_TARGET)) assertClosed(source, bytes.toString('utf8'));
    const current = await readOrNull(target);
    // Untouched when already identical, so a test run leaves modification times alone.
    if (!current || !bytes.equals(current)) await writeFile(target, bytes);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) {
    const stale = await staleCopies();
    if (stale.length) {
      console.error(`Stale or missing engine copies:\n${stale.map((path) => `  ${path}`).join('\n')}\nRun: npm run sync`);
      process.exit(1);
    }
    console.log(`Engine copies are current (${COPIES.length} files).`);
  } else {
    await syncEngine();
    console.log(`Engine copied into lib/ (${ENGINE_FILES.length} modules).`);
  }
}
