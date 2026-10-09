// The package as it ships: packed with npm, installed into an empty folder
// outside the repository, started through its command and spoken to over stdio.

import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { ENGINE_FILES, ENGINE_SOURCE } from '../scripts/sync-engine.mjs';
import { WHITELIST, assertNoHostedMethod, expectedFiles, handshake, hostedTextIn, install, pack, readTarball, scratch, sha256, verifyTarball } from '../scripts/tarball.mjs';
import { PACKAGE_ROOT, VAULT } from './helpers.mjs';

const TOOL_NAMES = ['list_profiles', 'prepare_review', 'run_gauntlet_plan', 'build_packet', 'account', 'run_review'];
const WINDOWS = process.platform === 'win32';

test('npm pack, install into an empty folder, and a stdio handshake', { timeout: 300000 }, async (t) => {
  const { directory, remove } = await scratch();
  t.after(remove);

  // --- pack -----------------------------------------------------------------
  const packed = await pack(join(directory, 'out'));
  assert.equal(packed.filename, 'bounty-operator-mcp-0.8.4.tgz');
  assert.equal(packed.version, '0.8.4');

  const files = await verifyTarball(packed.bytes);
  const paths = [...files.keys()].sort();
  assert.deepEqual(paths, (await expectedFiles()).map((path) => `package/${path}`).sort());
  for (const path of paths) assert.match(path, WHITELIST);
  for (const path of ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/server.json', 'package/bin/bounty-operator-mcp.mjs', 'package/src/server.mjs']) {
    assert.ok(files.has(path), path);
  }
  for (const unwanted of ['tests', 'scripts', 'node_modules', 'package-lock.json', '.gitignore']) {
    assert.ok(!paths.some((path) => path.includes(unwanted)), `${unwanted} stays out of the tarball`);
  }
  for (const name of ENGINE_FILES) {
    assert.equal(sha256(files.get(`package/lib/${name}`)), sha256(await readFile(join(ENGINE_SOURCE, name))), `lib/${name} is the engine in web/public`);
  }
  assert.match(files.get('package/LICENSE').toString('utf8'), /^MIT License/);
  // Core profiles only: no hosted method as a field, and none of its text in any file.
  await assertNoHostedMethod(files);

  // --- install ----------------------------------------------------------------
  const installed = await install(packed.path, join(directory, 'app'));
  await access(installed.command);
  for (const [path, bytes] of files) {
    const onDisk = await readFile(join(installed.root, path.slice('package/'.length)));
    assert.ok(onDisk.equals(bytes), `${path} installed unchanged`);
  }
  await assert.rejects(access(join(directory, 'app', 'node_modules', '@modelcontextprotocol')), 'nothing else was installed');

  // --- handshake ---------------------------------------------------------------
  const work = join(directory, 'project');
  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src', 'Vault.sol'), VAULT);
  const calls = [
    { name: 'prepare_review', arguments: { paths: ['src/Vault.sol'], profile: 'solidity' } },
    { name: 'prepare_review', arguments: { paths: ['../app/package.json'] } },
    { name: 'run_gauntlet_plan', arguments: {} },
    { name: 'prepare_review', arguments: { paths: ['src/Vault.sol'], profile: 'verdict' } },
  ];

  // Through the command npm linked, which is what `npx bounty-operator-mcp` starts.
  const viaCommand = await handshake(WINDOWS ? `"${installed.command}"` : installed.command, [], { cwd: work, shell: WINDOWS, calls });
  // And straight through node, which is what a client config with an absolute path starts.
  const viaNode = await handshake(process.execPath, [installed.bin], { cwd: work, calls });

  for (const session of [viaCommand, viaNode]) {
    assert.deepEqual(session.initialize.serverInfo, { name: 'bounty-operator', title: 'Bounty Operator', version: '0.8.4' });
    assert.equal(session.initialize.protocolVersion, '2025-06-18');
    assert.deepEqual(session.tools.map((tool) => tool.name), TOOL_NAMES);

    const [prepared, refused, plan, hosted] = session.results;
    assert.equal(prepared.isError, false);
    assert.equal(prepared.structuredContent.manifest[0].label, 'input-1/src/Vault.sol');
    assert.equal(prepared.structuredContent.manifest[0].sha256, sha256(Buffer.from(VAULT)));
    assert.equal(refused.isError, true);
    assert.equal(JSON.parse(refused.content[0].text).code, 'bad_path');
    assert.equal(plan.structuredContent.stages.length, 8);
    assert.deepEqual(plan.structuredContent.stages.filter((stage) => stage.tool === 'prepare_review').map((stage) => stage.profile), ['report']);
    // The installed package has no method for a hosted profile to hand out.
    assert.equal(hosted.isError, true);
    assert.equal(JSON.parse(hosted.content[0].text).code, 'hosted_profile');
    assert.equal(session.stderr, '');
  }
});

test('a file that repeats eight words of a hosted method is found, however it is wrapped', () => {
  const methods = {
    scope: { instructions: 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet.', extraFormat: '## Binding\n- <kilo> | <lima>' },
  };
  const files = new Map([
    ['package/lib/clean.mjs', Buffer.from('const text = "alpha bravo charlie delta echo foxtrot golf";\n')],
    ['package/lib/quoted.mjs', Buffer.from('// > ALPHA, bravo;\n// > charlie - delta\n// > echo "foxtrot" golf (hotel)\n')],
    ['package/README.md', Buffer.from('## Binding\n\nAn unrelated paragraph about binding.\n')],
  ]);
  assert.deepEqual(hostedTextIn(files, methods), ['package/lib/quoted.mjs']);
  assert.deepEqual(hostedTextIn(files, {}), []);
});

test('the tarball reader refuses what a package must not hold', async () => {
  const packageJson = await readFile(join(PACKAGE_ROOT, 'package.json'));
  const tar = (entries) => {
    const blocks = [];
    for (const { name, body = Buffer.alloc(0), type = '0' } of entries) {
      const header = Buffer.alloc(512);
      header.write(name, 0, 100, 'utf8');
      header.write('0000644\0', 100, 8, 'ascii');
      header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
      header.write(type, 156, 1, 'ascii');
      header.write('ustar\0', 257, 6, 'ascii');
      blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
  };
  const { gzipSync } = await import('node:zlib');

  const plain = readTarball(gzipSync(tar([{ name: 'package/package.json', body: packageJson }, { name: 'package/src/', type: '5' }])));
  assert.deepEqual([...plain.keys()], ['package/package.json']);
  assert.ok(plain.get('package/package.json').equals(packageJson));

  assert.throws(() => readTarball(gzipSync(tar([{ name: 'package/link', type: '2' }]))), /Only regular files are allowed/);
  await assert.rejects(verifyTarball(gzipSync(tar([{ name: 'package/.env', body: Buffer.from('X=1') }]))), /not on the whitelist/);
  await assert.rejects(verifyTarball(gzipSync(tar([{ name: 'package/tests/x.test.mjs', body: Buffer.from('1') }]))), /not on the whitelist/);
  await assert.rejects(verifyTarball(gzipSync(tar([{ name: 'package/package.json', body: packageJson }]))), /Tarball contents differ from the package\. Missing: /);
});
