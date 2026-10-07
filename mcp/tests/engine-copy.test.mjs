// The package carries copies of the shared engine. These tests hold the
// copies to the source in web/public, and the package metadata to one version.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';

import { PROVIDERS } from '../lib/providers.mjs';
import { COPIES, ENGINE_FILES, ENGINE_SOURCE, ENGINE_TARGET, assertClosed, importsOf, staleCopies } from '../scripts/sync-engine.mjs';
import { PROTOCOL_VERSIONS, VERSION } from '../src/server.mjs';
import { PACKAGE_ROOT } from './helpers.mjs';

const readJson = async (name) => JSON.parse(await readFile(join(PACKAGE_ROOT, name), 'utf8'));
const manifest = await readJson('package.json');
const registry = await readJson('server.json');

test('every engine copy in lib/ is byte-identical to its source in web/public', async () => {
  assert.deepEqual(await staleCopies(), [], 'run "npm run sync" in mcp/');

  for (const [source, target] of COPIES) {
    const [wanted, found] = await Promise.all([readFile(source), readFile(target)]);
    assert.ok(wanted.equals(found), `${basename(target)} differs from ${source}`);
  }
  assert.deepEqual((await readdir(ENGINE_TARGET)).sort(), [...ENGINE_FILES].sort(), 'lib/ holds the engine and nothing else');
});

test('the package carries the method of the three core profiles and of no hosted one', async () => {
  const { PROFILES, CORE_PROFILE_IDS, profileInstructions } = await import('../lib/profiles.mjs');
  assert.deepEqual([...CORE_PROFILE_IDS], ['general', 'solidity', 'report']);

  for (const profile of PROFILES) {
    if (profile.hosted) {
      assert.equal(profile.instructions, '', profile.id);
      assert.equal(profile.extraFormat, '', profile.id);
      assert.throws(() => profileInstructions(profile.id), (error) => error.code === 'hosted_profile', profile.id);
    } else {
      assert.ok(profile.instructions.startsWith('Profile: '), profile.id);
      assert.ok(profile.extraFormat.startsWith('## '), profile.id);
    }
    // What a form needs stays: the name, what it reads and the titles of its sections.
    assert.ok(profile.name && profile.description && profile.needs.length && profile.sections.length, profile.id);
  }

  // No module of the package reaches for a method that lives elsewhere.
  for (const directory of ['lib', 'src', 'bin']) {
    for (const name of await readdir(join(PACKAGE_ROOT, directory))) {
      const text = await readFile(join(PACKAGE_ROOT, directory, name), 'utf8');
      assert.ok(!/operator-profiles|web\/private|web\/src/.test(text), `${directory}/${name}`);
    }
  }
});

test('the copied modules import only each other', async () => {
  for (const name of ENGINE_FILES) {
    const source = await readFile(join(ENGINE_SOURCE, name), 'utf8');
    assert.doesNotThrow(() => assertClosed(name, source));
  }

  assert.deepEqual(importsOf("import { a } from './a.mjs';\nexport { b } from \"./b.mjs\";\nimport './c.mjs';\nconst d = await import('./d.mjs');"), [
    './a.mjs',
    './b.mjs',
    './c.mjs',
    './d.mjs',
  ]);
  assert.throws(() => assertClosed('x.mjs', "import { z } from './github.mjs';"), /not copied into lib/);
  assert.throws(() => assertClosed('x.mjs', "import fs from 'node:fs';"), /not copied into lib/);
});

test('the server imports the engine from lib/ and nothing from outside the package', async () => {
  const sources = [...(await readdir(join(PACKAGE_ROOT, 'src'))).map((name) => join('src', name)), join('bin', 'bounty-operator-mcp.mjs')];
  for (const file of sources) {
    const text = await readFile(join(PACKAGE_ROOT, file), 'utf8');
    for (const specifier of importsOf(text)) {
      const allowed = specifier.startsWith('node:') || /^\.\/[\w-]+\.mjs$/.test(specifier) || /^\.\.\/(?:lib|src)\/[\w-]+\.mjs$/.test(specifier);
      assert.ok(allowed, `${file} imports ${specifier}`);
    }
  }
});

test('the package is publishable: one version, a bin with a shebang, a whitelist and no runtime dependency', async () => {
  assert.equal(manifest.name, 'bounty-operator-mcp');
  assert.equal(manifest.version, '0.7.8');
  assert.equal(VERSION, manifest.version);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.files, ['bin/', 'src/', 'lib/', 'server.json']);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.repository.url, 'git+https://github.com/bountyoperator/bounty-operator.git');
  assert.equal(manifest.repository.directory, 'mcp');
  assert.equal(manifest.scripts.prepack, 'node scripts/sync-engine.mjs');
  // The tests load the Worker, which needs to know where the hosted profiles come from.
  assert.equal(manifest.scripts.pretest, 'node scripts/sync-engine.mjs && node ../scripts/select-profiles.mjs --quiet');

  assert.deepEqual(manifest.bin, { 'bounty-operator-mcp': 'bin/bounty-operator-mcp.mjs' });
  const bin = await readFile(join(PACKAGE_ROOT, manifest.bin['bounty-operator-mcp']), 'utf8');
  assert.ok(bin.startsWith('#!/usr/bin/env node\n'), 'the bin starts with a shebang and Unix line ends');

  const lock = await readJson('package-lock.json');
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(lock.packages[''].dependencies, undefined);
});

test('server.json fits the registry schema and matches the package', () => {
  assert.equal(registry.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  assert.equal(registry.name, 'io.github.bountyoperator/bounty-operator');
  assert.match(registry.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.equal(manifest.mcpName, registry.name, 'the registry checks mcpName in the npm package against this name');
  assert.ok(registry.description.length >= 1 && registry.description.length <= 100, `description is ${registry.description.length} characters`);
  assert.ok(registry.title.length <= 100);
  assert.equal(registry.version, manifest.version);
  assert.deepEqual(registry.repository, { url: 'https://github.com/bountyoperator/bounty-operator', source: 'github', subfolder: 'mcp' });

  assert.equal(registry.packages.length, 1);
  const [npmPackage] = registry.packages;
  assert.equal(npmPackage.registryType, 'npm');
  assert.equal(npmPackage.identifier, manifest.name);
  assert.equal(npmPackage.version, manifest.version);
  assert.deepEqual(npmPackage.transport, { type: 'stdio' });

  const variables = npmPackage.environmentVariables;
  for (const variable of variables) {
    assert.match(variable.name, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(variable.description);
    assert.equal(variable.isRequired, false, `${variable.name}: every tool that needs no account works with no variable set`);
  }
  const names = variables.map((variable) => variable.name);
  assert.deepEqual(names.slice(0, 3), ['BOUNTY_OPERATOR_TOKEN', 'BOUNTY_OPERATOR_MODEL', 'BOUNTY_OPERATOR_ROOT']);
  assert.deepEqual(names.slice(3), PROVIDERS.map((provider) => provider.envVar), 'one key variable per provider the engine supports');
  const secret = variables.filter((variable) => variable.isSecret).map((variable) => variable.name);
  assert.deepEqual(secret, ['BOUNTY_OPERATOR_TOKEN', ...PROVIDERS.map((provider) => provider.envVar)]);

  assert.equal(registry.remotes.length, 1);
  const [remote] = registry.remotes;
  assert.equal(remote.type, 'streamable-http');
  assert.equal(remote.url, 'https://bountyoperator.com/api/mcp');
  assert.deepEqual(remote.headers.map((header) => header.name), ['Authorization', 'X-Provider-Key']);
  assert.ok(remote.headers.every((header) => header.isSecret === true && header.isRequired === false));
  assert.equal(remote.headers[0].value, 'Bearer {token}');
  assert.ok(remote.headers[0].variables.token);
});

test('the protocol versions match the ones the remote endpoint speaks', () => {
  assert.deepEqual([...PROTOCOL_VERSIONS], ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
});
