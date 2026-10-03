#!/usr/bin/env node
// Builds the MCP download served at https://bountyoperator.com/dl/.
//
//   node scripts/build-mcp.mjs           copy the engine, pack, verify, smoke-test, write web/public/dl/
//   node scripts/build-mcp.mjs --check   exit 1 when web/public/dl/ no longer matches the source
//
// Output, all under web/public/dl/:
//   bounty-operator-mcp-<version>.tgz   the npm tarball, pinned by version
//   bounty-operator-mcp.tgz             the same bytes, the address the install commands use
//   SHA256SUMS.txt                      one line per file, in sha256sum format
//
// The tarball is the output of `npm pack` in mcp/. Before anything is written
// its contents are checked against a whitelist, against the files on disk and
// for text of a hosted method, then it is installed into an empty folder and
// answers an MCP handshake. The package ships the core profiles only: the
// installed server must refuse to prepare a hosted one.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handshake, install, pack, readTarball, scratch, sha256, verifyTarball } from '../mcp/scripts/tarball.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'web', 'public', 'dl');
const LATEST = 'bounty-operator-mcp.tgz';
const SUMS = 'SHA256SUMS.txt';
const TOOLS = ['list_profiles', 'prepare_review', 'run_gauntlet_plan', 'build_packet', 'account', 'run_review'];

const check = process.argv.includes('--check');

/** Installs the tarball into an empty folder and talks MCP to the installed command. */
async function smokeTest(tarball, directory, version) {
  const installed = await install(tarball, join(directory, 'app'));
  const work = join(directory, 'project');
  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src', 'Vault.sol'), 'contract Vault {\n  function withdraw() external {}\n}\n');

  const session = await handshake(process.execPath, [installed.bin], {
    cwd: work,
    calls: [
      { name: 'prepare_review', arguments: { paths: ['src/Vault.sol'], profile: 'solidity' } },
      { name: 'prepare_review', arguments: { paths: ['../app/package.json'] } },
      { name: 'prepare_review', arguments: { paths: ['src/Vault.sol'], profile: 'scope' } },
      { name: 'run_gauntlet_plan', arguments: {} },
    ],
  });

  const names = session.tools.map((tool) => tool.name);
  if (session.initialize.serverInfo.version !== version) throw new Error(`The installed server reports version ${session.initialize.serverInfo.version}, expected ${version}.`);
  if (names.join() !== TOOLS.join()) throw new Error(`The installed server lists ${names.join(', ')}.`);
  const [prepared, refused, hosted, plan] = session.results;
  if (prepared.isError || prepared.structuredContent.manifest[0].label !== 'input-1/src/Vault.sol') throw new Error('prepare_review did not read a path under the working directory.');
  if (!refused.isError) throw new Error('prepare_review read a path outside the working directory.');
  if (!hosted.isError || JSON.parse(hosted.content[0].text).code !== 'hosted_profile') throw new Error('prepare_review handed out a hosted profile.');
  const tools = plan.structuredContent.stages.map((stage) => `${stage.profile}:${stage.tool}`).join(' ');
  if (!/^scope:run_review .*report:prepare_review verdict:run_review$/.test(tools)) throw new Error(`The gauntlet plan routes its stages as: ${tools}.`);
}

/** path -> sha256 for every file in a tarball. */
function digest(files) {
  return Object.fromEntries([...files].map(([path, bytes]) => [path, sha256(bytes)]).sort(([a], [b]) => a.localeCompare(b)));
}

function sumsFor(entries) {
  return `${entries.map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n')}\n`;
}

async function readOrNull(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const { directory, remove } = await scratch('bo-mcp-build-');
try {
  const packed = await pack(join(directory, 'out'));
  const files = await verifyTarball(packed.bytes);
  await smokeTest(packed.path, directory, packed.version);
  const versioned = packed.filename;
  // Keep earlier versioned downloads and their checksums available when the
  // unversioned alias advances. A pinned URL must keep serving the same bytes.
  const earlier = [];
  for (const name of (await readdir(OUTPUT).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).sort()) {
    if (name !== versioned && /^bounty-operator-mcp-\d+\.\d+\.\d+\.tgz$/.test(name)) {
      earlier.push([name, await readFile(join(OUTPUT, name))]);
    }
  }

  if (check) {
    // The comparison is by content: two machines can gzip the same files into different bytes.
    const problems = [];
    const published = await readOrNull(join(OUTPUT, versioned));
    const latest = await readOrNull(join(OUTPUT, LATEST));
    const sums = await readOrNull(join(OUTPUT, SUMS));

    if (!published || !latest || !sums) {
      problems.push(`web/public/dl/ is missing ${[!published && versioned, !latest && LATEST, !sums && SUMS].filter(Boolean).join(', ')}`);
    } else {
      if (!published.equals(latest)) problems.push(`${LATEST} and ${versioned} differ`);
      await verifyTarball(published).catch((error) => problems.push(`${versioned}: ${error.message}`));
      const [built, served] = [digest(files), digest(readTarball(published))];
      const changed = [...new Set([...Object.keys(built), ...Object.keys(served)])].filter((path) => built[path] !== served[path]);
      if (changed.length) problems.push(`${versioned} is stale: ${changed.join(', ')}`);
      if (sums.toString('utf8') !== sumsFor([[versioned, published], [LATEST, latest], ...earlier])) problems.push(`${SUMS} does not list the hashes of the current and retained tarballs`);
    }

    if (problems.length) {
      console.error(`MCP download is out of date:\n${problems.map((problem) => `  ${problem}`).join('\n')}\nRun: node scripts/build-mcp.mjs`);
      process.exitCode = 1;
    } else {
      console.log(`MCP download is current: ${versioned}, ${files.size} files.`);
    }
  } else {
    await mkdir(OUTPUT, { recursive: true });
    await writeFile(join(OUTPUT, versioned), packed.bytes);
    await writeFile(join(OUTPUT, LATEST), packed.bytes);
    await writeFile(join(OUTPUT, SUMS), sumsFor([[versioned, packed.bytes], [LATEST, packed.bytes], ...earlier]));

    console.log(`MCP download: ${versioned}, ${files.size} files, ${packed.bytes.length} bytes`);
    for (const path of [...files.keys()].sort()) console.log(`  ${path.slice('package/'.length)}`);
    console.log(`Verified against the whitelist, installed into an empty folder, handshake answered with ${TOOLS.length} tools.`);
    console.log(`SHA256 ${sha256(packed.bytes)}`);
    console.log(`Written to ${OUTPUT}`);
  }
} finally {
  await remove();
}
