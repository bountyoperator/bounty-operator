// The local server against the remote endpoint in web/src/mcp.ts: the same
// tools under the same names, titles and descriptions, the same prompts, and
// the same results for the same call. The differences are listed here, one by
// one, so that a new one fails the test.
//
// The Worker source is TypeScript with its own dependencies. Where it cannot
// be loaded (web/node_modules not installed, or a Node without type
// stripping) these tests are skipped and say so.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_VERSIONS, VERSION, createServer } from '../src/server.mjs';
import { VAULT, reviewFor } from './helpers.mjs';

const WEB = new URL('../../web/', import.meta.url);
let skip = false;
if (!existsSync(fileURLToPath(new URL('node_modules/stripe', WEB)))) skip = 'web/node_modules is not installed; run "npm ci" in web/';
else if (!process.features.typescript) skip = 'this Node cannot load the Worker source; use Node 22.18 or later';

// Loaded only when it can be: any other failure to import is a real one and fails the run.
const remote = skip ? null : await import(new URL('src/mcp.ts', WEB));

const remoteHost = {
  account: async () => {
    throw new Error('not used');
  },
  runReview: async () => {
    throw new Error('not used');
  },
};
const local = createServer({ env: {} });

let nextId = 0;
async function ask(side, method, params) {
  nextId += 1;
  const message = { jsonrpc: '2.0', id: nextId, method, ...(params === undefined ? {} : { params }) };
  if (side === 'local') return (await local.handle(message)).result;
  const reply = await remote.handleMcpMessage(message, remoteHost);
  assert.equal(reply.status, 200);
  return reply.body.result;
}

const both = async (method, params) => ({ here: await ask('local', method, params), there: await ask('remote', method, params) });

/** What the remote description says, as it reads for a server that takes its secrets from the environment. */
function asLocal(description) {
  return description
    .replace('using the key in the X-Provider-Key header', "using the key in that provider's environment variable")
    .replace('Needs the connection token in the Authorization header.', 'Needs BOUNTY_OPERATOR_TOKEN in the server environment.');
}

const PATHS_SENTENCE = ' Name the files as paths for the server to read under its working directory, pass their text as files, or both.';

test('initialize answers with the same server, capabilities and protocol versions', { skip }, async () => {
  assert.deepEqual([...PROTOCOL_VERSIONS], [...remote.MCP_PROTOCOL_VERSIONS]);

  for (const protocolVersion of [...PROTOCOL_VERSIONS, '1999-01-01']) {
    const { here, there } = await both('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(here.protocolVersion, there.protocolVersion);
    assert.deepEqual(here.capabilities, there.capabilities);
    assert.deepEqual(here.serverInfo, there.serverInfo);
  }
  assert.equal((await ask('remote', 'initialize', {})).serverInfo.version, VERSION);
});

test('every remote tool exists here under the same name, title and description', { skip }, async () => {
  const { here, there } = await both('tools/list');
  const localTools = new Map(here.tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(here.tools.map((tool) => tool.name).filter((name) => !there.tools.some((tool) => tool.name === name)), ['run_gauntlet_plan'], 'the one tool only this server has');

  for (const remoteTool of there.tools) {
    const tool = localTools.get(remoteTool.name);
    assert.ok(tool, `${remoteTool.name} is missing here`);
    assert.equal(tool.title, remoteTool.title, remoteTool.name);
    assert.deepEqual(tool.annotations, remoteTool.annotations, remoteTool.name);

    const expected = asLocal(remoteTool.description) + (remoteTool.name === 'prepare_review' ? PATHS_SENTENCE : '');
    assert.equal(tool.description, expected, remoteTool.name);

    // Every remote argument exists here. This server adds paths wherever files are taken.
    const remoteArgs = Object.keys(remoteTool.inputSchema.properties);
    const localArgs = Object.keys(tool.inputSchema.properties);
    const added = localArgs.filter((name) => !remoteArgs.includes(name));
    assert.deepEqual(remoteArgs.filter((name) => !localArgs.includes(name)), [], remoteTool.name);
    assert.deepEqual(added, remoteArgs.includes('files') ? ['paths'] : [], remoteTool.name);
    assert.equal(tool.inputSchema.additionalProperties, false);

    // Files may come by path here, so files is not required. Nothing else changes.
    const required = (remoteTool.inputSchema.required ?? []).filter((name) => name !== 'files');
    assert.deepEqual(tool.inputSchema.required ?? [], required, remoteTool.name);

    for (const name of remoteArgs) {
      // context is described field by field from the engine here; model has no default here.
      if (name === 'context' || name === 'model') continue;
      const { description: localText, ...localRest } = tool.inputSchema.properties[name];
      const { description: remoteText, ...remoteRest } = remoteTool.inputSchema.properties[name];
      assert.deepEqual(localRest, remoteRest, `${remoteTool.name}.${name}`);
      if (name !== 'provider') assert.equal(localText, remoteText, `${remoteTool.name}.${name}`);
    }

    assert.deepEqual(tool.outputSchema.required, remoteTool.outputSchema.required, remoteTool.name);
    for (const name of Object.keys(remoteTool.outputSchema.properties)) {
      assert.deepEqual(tool.outputSchema.properties[name], remoteTool.outputSchema.properties[name], `${remoteTool.name} output ${name}`);
    }
  }
});

test('the three prompts carry the same names, titles, descriptions and arguments', { skip }, async () => {
  const { here, there } = await both('prompts/list');
  assert.deepEqual(here.prompts, there.prompts);

  for (const { name } of there.prompts) {
    const { here: mine, there: theirs } = await both('prompts/get', { name, arguments: { platform: 'Cantina', mode: 'bounty' } });
    assert.equal(mine.description, theirs.description);
    assert.equal(mine.messages[0].role, theirs.messages[0].role);
    // The steps differ where this server reads files by path; the first line is the same request.
    assert.equal(mine.messages[0].content.text.split('\n')[0], theirs.messages[0].content.text.split('\n')[0]);
  }
});

test('list_profiles returns what the remote returns, plus what this process holds', { skip }, async () => {
  const { here, there } = await both('tools/call', { name: 'list_profiles', arguments: {} });
  const { environment, providers, ...rest } = here.structuredContent;
  const { providers: remoteProviders, ...remoteRest } = there.structuredContent;

  assert.deepEqual(rest, remoteRest);
  assert.deepEqual(providers.map(({ envVar, keySet, ...provider }) => provider), remoteProviders);
  assert.deepEqual(Object.keys(environment), ['workingDirectory', 'tokenSet', 'model']);
});

test('prepare_review returns the same manifest, instructions, format and request for inline files', { skip }, async () => {
  const cases = [
    { files: [{ name: 'src/Vault.sol', content: VAULT }] },
    { files: [{ name: 'src/Vault.sol', content: VAULT }], profile: 'solidity', mode: 'own-code', prompt: 'Look at withdraw.' },
    { files: [{ name: 'report.md', content: '# Draft\n' }, { name: 'src/Vault.sol', content: VAULT }], profile: 'report', context: { target: 'Example', proof: 'local', prior: 'searched', rules: 'Critical: direct theft.' } },
    { files: [{ name: 'report.md', content: '# Draft\n' }, { name: 'stage-1-scope.md', content: reviewFor('input-1/report.md') }], profile: 'report', context: { impactRow: 'Direct theft (Critical)' } },
    { files: [{ name: 'notes.md', content: 'Mail bob@corp-internal.io\n' }], acknowledgeWarnings: true },
  ];
  for (const args of cases) {
    const { here, there } = await both('tools/call', { name: 'prepare_review', arguments: args });
    assert.equal(here.isError, false);
    assert.deepEqual(here.structuredContent, there.structuredContent, args.profile ?? 'general');
  }
});

test('prepare_review refuses a hosted profile on both sides, each naming where its own secrets go', { skip }, async () => {
  const { PROFILES } = await import('../lib/profiles.mjs');
  for (const profile of PROFILES.filter((entry) => entry.hosted)) {
    const args = { files: [{ name: 'report.md', content: '# Draft\n' }], profile: profile.id };
    const { here, there } = await both('tools/call', { name: 'prepare_review', arguments: args });
    assert.equal(here.isError, true, profile.id);
    assert.equal(there.isError, true, profile.id);

    const [mine, theirs] = [JSON.parse(here.content[0].text), JSON.parse(there.content[0].text)];
    assert.deepEqual({ code: mine.code, profile: mine.profile }, { code: 'hosted_profile', profile: profile.id });
    assert.deepEqual({ code: theirs.code, profile: theirs.profile }, { code: 'hosted_profile', profile: profile.id });
    const sentence = `${profile.name} runs on the server. Call run_review with profile "${profile.id}"`;
    assert.ok(mine.error.startsWith(sentence), mine.error);
    assert.ok(theirs.error.startsWith(sentence), theirs.error);
    assert.match(mine.error, /BOUNTY_OPERATOR_TOKEN and the provider key in this server's environment/);
    assert.match(theirs.error, /your connection token and your provider key in the X-Provider-Key header/);
    // Neither refusal says anything about the method.
    assert.equal(here.structuredContent, undefined);
    assert.equal(there.structuredContent, undefined);
  }
});

test('the gauntlet runs its hosted stages through run_review on both sides', { skip }, async () => {
  const { here, there } = await both('prompts/get', { name: 'gauntlet', arguments: {} });
  const remoteText = there.messages[0].content.text;
  assert.match(remoteText, /1\. scope: Scope and impact fit \(run_review\)/);
  assert.match(remoteText, /7\. report: Challenge a draft report \(prepare_review\)/);
  assert.match(remoteText, /8\. verdict: Final verdict \(run_review\)/);
  assert.match(remoteText, /connection token in the Authorization header and my provider key in the X-Provider-Key header/);
  assert.match(here.messages[0].content.text, /run_gauntlet_plan/);
  assert.match(here.messages[0].content.text, /A run_review stage runs on the Bounty Operator server/);
});

test('prepare_review fails the same way', { skip }, async () => {
  const cases = [
    { files: [{ name: 'deploy.py', content: 'KEY = "AKIAABCDEFGHIJKLMNOP"\n' }] },
    { files: [{ name: 'notes.md', content: 'Mail bob@corp-internal.io\n' }] },
    { files: [{ name: '../x.sol', content: VAULT }] },
    { files: [{ name: 'a.sol', content: VAULT }], context: { proof: 'maybe' } },
    { files: [{ name: 'a.sol', content: VAULT }], mode: 'audit' },
  ];
  for (const args of cases) {
    const { here, there } = await both('tools/call', { name: 'prepare_review', arguments: args });
    assert.equal(here.isError, true);
    assert.equal(there.isError, true);
    assert.deepEqual(JSON.parse(here.content[0].text), JSON.parse(there.content[0].text));
  }
});

test('build_packet returns the same verdict, reference check and packet', { skip }, async () => {
  const prepared = await ask('local', 'tools/call', { name: 'prepare_review', arguments: { files: [{ name: 'src/Vault.sol', content: VAULT }], profile: 'solidity', mode: 'bounty' } });
  const { manifest } = prepared.structuredContent;
  const withoutClock = (packet) => packet.replace(/^Created: .*$/m, 'Created: -');

  const cases = [
    { review: reviewFor('input-1/src/Vault.sol'), manifest },
    { review: reviewFor('input-1/src/Vault.sol', 'submit'), manifest, profile: 'verdict', source: 'gauntlet', model: 'm', provider: 'p', context: { target: 'Example' }, stages: [{ profile: 'scope', verdict: 'submit', headline: 'In scope.' }] },
    { review: 'No verdict here. ![x](https://e.example/p.png)', manifest },
  ];
  for (const args of cases) {
    const { here, there } = await both('tools/call', { name: 'build_packet', arguments: args });
    const { packet: mine, ...rest } = here.structuredContent;
    const { packet: theirs, ...remoteRest } = there.structuredContent;
    assert.deepEqual(rest, remoteRest);
    assert.equal(withoutClock(mine), withoutClock(theirs));
  }

  const { here, there } = await both('tools/call', { name: 'build_packet', arguments: { review: 'x', manifest: [] } });
  assert.deepEqual(JSON.parse(here.content[0].text), JSON.parse(there.content[0].text));
});
