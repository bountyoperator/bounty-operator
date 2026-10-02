// The server as a client meets it: started as a process, spoken to over
// stdio, first by the official MCP client and then by hand.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { BIN, PACKAGE_ROOT, VAULT, project, sha256, stdioClient } from './helpers.mjs';

const TOOL_NAMES = ['list_profiles', 'prepare_review', 'run_gauntlet_plan', 'build_packet', 'account', 'run_review'];
const PROMPT_NAMES = ['challenge-report', 'solidity-review', 'gauntlet'];
const { version: VERSION } = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

/** Runs `use` against a connected client, and closes it before the test's own cleanup removes the folder it runs in. */
async function withClient(cwd, use) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], cwd, stderr: 'pipe' });
  const client = new Client({ name: 'bounty-operator-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    await use(client);
  } finally {
    await client.close();
  }
}

test('the official client connects, lists and calls', async (t) => {
  const cwd = await project(t, { 'src/Vault.sol': VAULT });
  await withClient(cwd, async (client) => {
    assert.deepEqual(client.getServerVersion(), { name: 'bounty-operator', title: 'Bounty Operator', version: VERSION });
    assert.match(client.getInstructions(), /prepare_review scans the files for secrets/);
    assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: false }, prompts: { listChanged: false } });
    assert.deepEqual(await client.ping(), {});

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
    for (const tool of tools) {
      assert.ok(tool.title, tool.name);
      assert.ok(tool.description.length > 60, tool.name);
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(tool.outputSchema.type, 'object', tool.name);
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    }

    // The client checks structuredContent against each tool's outputSchema and throws when it does not fit.
    const profiles = await client.callTool({ name: 'list_profiles', arguments: {} });
    assert.equal(profiles.isError, false);
    assert.equal(profiles.structuredContent.environment.workingDirectory, cwd);
    assert.deepEqual(JSON.parse(profiles.content[0].text), profiles.structuredContent);

    const prepared = await client.callTool({ name: 'prepare_review', arguments: { paths: ['src/Vault.sol'], profile: 'solidity' } });
    assert.equal(prepared.isError, false);
    assert.deepEqual(prepared.structuredContent.manifest, [
      { label: 'input-1/src/Vault.sol', bytes: Buffer.byteLength(VAULT), sha256: sha256(VAULT), lines: 3 },
    ]);

    const plan = await client.callTool({ name: 'run_gauntlet_plan', arguments: {} });
    assert.equal(plan.structuredContent.stages.length, 8);

    const packet = await client.callTool({
      name: 'build_packet',
      arguments: { review: '# Review\nVerdict: no-blocking-issues\nMode: own-code\nHeadline: nothing blocks.', manifest: prepared.structuredContent.manifest },
    });
    assert.equal(packet.structuredContent.verdict, 'no-blocking-issues');

    const account = await client.callTool({ name: 'account', arguments: {} });
    assert.equal(account.isError, true);
    assert.equal(JSON.parse(account.content[0].text).code, 'token');
  });
});

test('the official client lists and reads the three prompts', async () => {
  await withClient(PACKAGE_ROOT, async (client) => {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((prompt) => prompt.name), PROMPT_NAMES);

    for (const name of PROMPT_NAMES) {
      const prompt = await client.getPrompt({ name, arguments: { platform: 'Immunefi' } });
      assert.equal(prompt.messages.length, 1);
      assert.equal(prompt.messages[0].role, 'user');
      assert.match(prompt.messages[0].content.text, /build_packet/);
    }

    const gauntlet = await client.getPrompt({ name: 'gauntlet', arguments: { platform: 'Immunefi' } });
    assert.match(gauntlet.messages[0].content.text, /The report is for Immunefi\./);
    assert.match(gauntlet.messages[0].content.text, /run_gauntlet_plan/);

    // Some clients list a prompt as a command with underscores.
    const aliased = await client.getPrompt({ name: 'challenge_report' });
    assert.match(aliased.messages[0].content.text, /profile "report"/);
    await assert.rejects(client.getPrompt({ name: 'nope' }), /Unknown prompt/);
  });
});

test('the wire: version negotiation, errors, notifications and a clean exit', async () => {
  const client = stdioClient(process.execPath, [BIN], { cwd: PACKAGE_ROOT });

  const hello = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(hello.result.protocolVersion, '2024-11-05');
  client.notify('notifications/initialized');

  const future = await client.request('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(future.result.protocolVersion, '2025-11-25');

  assert.equal((await client.request('nope/nothing')).error.code, -32601);
  assert.equal((await client.request('tools/call', { name: 'nope' })).error.code, -32602);
  assert.equal((await client.request('tools/call', { name: 'list_profiles', arguments: [] })).error.code, -32602);
  assert.equal((await client.request('tools/list', [])).error.code, -32602);

  // Three lines that get an error with a null id, in order: not JSON, a batch, a request without a version.
  client.write('this is not json\n');
  client.write(`${JSON.stringify([{ jsonrpc: '2.0', id: 90, method: 'ping' }])}\n`);
  client.write(`${JSON.stringify({ id: 91, method: 'ping' })}\n`);
  // A notification and a stray response get no answer at all.
  client.notify('notifications/cancelled', { requestId: 12345 });
  client.write(`${JSON.stringify({ jsonrpc: '2.0', id: 92, result: {} })}\n`);

  // A request split across two writes, with a multi-byte character on the boundary.
  const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'split-é', method: 'ping' })}\n`);
  const cut = line.indexOf(0xc3) + 1;
  const split = new Promise((resolve) => {
    client.child.stdout.on('data', function watch() {
      const found = client.stray.find((message) => message.id === 'split-é');
      if (found) {
        client.child.stdout.off('data', watch);
        resolve(found);
      }
    });
  });
  client.child.stdin.write(line.subarray(0, cut));
  await new Promise((resolve) => setTimeout(resolve, 50));
  client.child.stdin.write(line.subarray(cut));
  assert.deepEqual((await split).result, {});

  assert.equal(await client.close(), 0);
  const errors = client.stray.filter((message) => message.id === null).map((message) => message.error.code);
  assert.deepEqual(errors, [-32700, -32600, -32600]);
  assert.equal(client.stray.length, 4, 'nothing else was written to stdout');
  assert.equal(client.stderr(), '');
});

test('a request still running when stdin closes is answered before the process exits', async (t) => {
  const cwd = await project(t, { 'a.sol': VAULT });
  const client = stdioClient(process.execPath, [BIN], { cwd });
  const reply = client.request('tools/call', { name: 'prepare_review', arguments: { paths: ['a.sol'] } });
  client.child.stdin.end();
  assert.equal((await reply).result.isError, false);
  assert.equal(await client.exited, 0);
});

test('--version and --help print and exit', async () => {
  const run = promisify(execFile);
  const version = await run(process.execPath, [BIN, '--version']);
  assert.equal(version.stdout.trim(), VERSION);

  const help = await run(process.execPath, [BIN, '--help']);
  assert.match(help.stdout, /npx -y https:\/\/bountyoperator\.com\/dl\/bounty-operator-mcp\.tgz/);
  assert.match(help.stdout, /BOUNTY_OPERATOR_TOKEN/);
});
