// Each tool, called in process. The account API is a stand-in for fetch, so
// nothing here touches the network.

import assert from 'node:assert/strict';
import test from 'node:test';

import { GAUNTLET, CORE_PROFILE_IDS, PROFILES } from '../lib/profiles.mjs';
import { PROVIDERS } from '../lib/providers.mjs';
import { LIMITS, REVIEW_CONTRACT } from '../lib/review-core.mjs';
import { runsHosted, stageFile } from '../src/gauntlet.mjs';
import { PROVIDER_KEY, TOKEN, VAULT, failure, fakeFetch, project, reviewFor, server, sha256 } from './helpers.mjs';

const MARKER = 'UNIQUE_BODY_MARKER_7f3a';
const SOURCE = `// ${MARKER}\n${VAULT}`;
const AWS_KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const USAGE = { plan: 'free', usedToday: 1, remainingToday: 0, running: 0, concurrency: 1, resetsAt: '2026-10-03T00:00:00.000Z', paidUntil: null };

// ---------------------------------------------------------------------------
// list_profiles
// ---------------------------------------------------------------------------

test('list_profiles returns the listed profiles, the gauntlet, the providers and what this process holds', async (t) => {
  const cwd = await project(t);
  const { tool } = server({ cwd, env: { OPENROUTER_API_KEY: PROVIDER_KEY, BOUNTY_OPERATOR_MODEL: 'some/model' } });
  const { structuredContent: listed, content } = await tool('list_profiles');

  assert.deepEqual(listed.profiles.map((profile) => profile.id), PROFILES.filter((profile) => profile.listed).map((profile) => profile.id));
  assert.equal(listed.profiles.length, 11);
  for (const profile of listed.profiles) {
    assert.deepEqual(Object.keys(profile), ['id', 'name', 'tagline', 'description', 'mode', 'needs', 'next', 'hosted']);
  }
  assert.deepEqual(listed.profiles.filter((profile) => !profile.hosted).map((profile) => profile.id), ['general', 'solidity', 'report']);
  assert.deepEqual(listed.gauntlet, [...GAUNTLET]);
  assert.deepEqual(listed.verdicts.bounty, ['submit', 'rewrite-then-submit', 'prove-first', 'hold-duplicate', 'drop']);
  assert.deepEqual(listed.limits, { ...LIMITS });

  assert.deepEqual(listed.providers.map((provider) => provider.id), PROVIDERS.map((provider) => provider.id));
  assert.deepEqual(listed.providers.filter((provider) => provider.keySet).map((provider) => provider.envVar), ['OPENROUTER_API_KEY']);
  assert.deepEqual(listed.environment, { workingDirectory: cwd, tokenSet: false, model: 'some/model' });

  // The method text of a core profile is returned by prepare_review, one profile at a time.
  assert.ok(!content[0].text.includes(PROFILES[0].instructions.slice(0, 80)));
  assert.ok(!content[0].text.includes(PROVIDER_KEY));
});

// ---------------------------------------------------------------------------
// prepare_review
// ---------------------------------------------------------------------------

test('prepare_review with inline files returns the manifest and the request, and no file content', async () => {
  const { tool } = server();
  const result = await tool('prepare_review', {
    files: [{ name: 'src/Vault.sol', content: SOURCE }],
    profile: 'solidity',
    mode: 'own-code',
    prompt: 'Look at withdraw.',
    context: { target: 'Example vault', version: 'abc1234' },
  });
  assert.equal(result.isError, false);
  const prepared = result.structuredContent;

  assert.deepEqual(prepared.profile, { id: 'solidity', name: 'Solidity review' });
  assert.equal(prepared.mode, 'own-code');
  assert.deepEqual(prepared.verdicts, ['fix-before-deploy', 'no-blocking-issues']);
  assert.deepEqual(prepared.manifest, [{ label: 'input-1/src/Vault.sol', bytes: Buffer.byteLength(SOURCE), sha256: sha256(SOURCE), lines: 4 }]);
  assert.deepEqual(prepared.findings, []);

  assert.ok(prepared.instructions.startsWith(REVIEW_CONTRACT.slice(0, 200)), 'the shared contract comes first');
  assert.match(prepared.instructions, /Profile: Solidity review/i);
  assert.ok(!prepared.instructions.includes('Verdict: <one value allowed by Mode>'), 'the format is a field of its own');
  assert.match(prepared.outputFormat, /^# Review\nVerdict: /);
  assert.match(prepared.outputFormat, /## Coverage/);

  assert.match(prepared.request, /^## Request\nLook at withdraw\./);
  assert.match(prepared.request, /Mode: own-code/);
  assert.match(prepared.request, /Target: Example vault/);
  assert.match(prepared.request, /Review the files you passed to this tool, in the order you passed them\. Their labels:\n- input-1\/src\/Vault\.sol \(4 lines\)\n/);
  assert.match(prepared.next, /build_packet/);

  assert.ok(!JSON.stringify(result).includes(MARKER), 'file content is never echoed');
});

test('prepare_review reads paths from disk, before any inline file', async (t) => {
  const cwd = await project(t, { 'src/Vault.sol': SOURCE, 'report.md': '# Draft\nwithdraw is open.\n' });
  const { tool } = server({ cwd });
  const result = await tool('prepare_review', {
    paths: ['report.md', 'src/Vault.sol'],
    files: [{ name: 'stage-1-scope.md', content: '# Review\nVerdict: submit\n' }],
    profile: 'report',
  });
  const prepared = result.structuredContent;

  assert.deepEqual(
    prepared.manifest.map((entry) => entry.label),
    ['input-1/report.md', 'input-2/src/Vault.sol', 'input-3/stage-1-scope.md'],
  );
  assert.equal(prepared.manifest[1].sha256, sha256(SOURCE), 'the manifest hash is the hash of the file on disk');
  assert.match(prepared.request, /- input-2\/src\/Vault\.sol \(4 lines\), on disk at src\/Vault\.sol/);
  assert.match(prepared.request, /- input-3\/stage-1-scope\.md \(2 lines\), passed inline/);
  assert.match(prepared.request, /Read each file marked "on disk"/);
  assert.ok(!JSON.stringify(result).includes(MARKER), 'file content is never echoed');
});

test('prepare_review builds a request for every core profile', async () => {
  const { tool } = server();
  assert.deepEqual([...CORE_PROFILE_IDS], ['general', 'solidity', 'report']);
  for (const profile of PROFILES.filter((entry) => !entry.hosted)) {
    const result = await tool('prepare_review', { files: [{ name: 'a.sol', content: VAULT }], profile: profile.id });
    assert.equal(result.isError, false, profile.id);
    assert.equal(result.structuredContent.profile.id, profile.id);
    assert.ok(result.structuredContent.instructions.includes(profile.instructions.slice(0, 60)), profile.id);
  }
});

test('prepare_review refuses every hosted profile and points at run_review, before it reads a file', async (t) => {
  const cwd = await project(t, { 'src/Vault.sol': SOURCE });
  const { tool } = server({ cwd });
  const hosted = PROFILES.filter((profile) => profile.hosted);
  assert.equal(hosted.length, 10);

  for (const profile of hosted) {
    // The package holds no method for it: nothing to hand out.
    assert.equal(profile.instructions, '', profile.id);
    assert.equal(profile.extraFormat, '', profile.id);

    const result = await tool('prepare_review', { paths: ['src/Vault.sol'], profile: profile.id });
    const body = failure(result);
    assert.equal(body.code, 'hosted_profile', profile.id);
    assert.equal(body.profile, profile.id);
    assert.match(body.error, new RegExp(`run_review with profile "${profile.id}"`));
    assert.match(body.error, /BOUNTY_OPERATOR_TOKEN/);
    assert.equal(result.structuredContent, undefined);
  }

  // The refusal comes first: a path that does not exist is never looked up.
  assert.equal(failure(await tool('prepare_review', { paths: ['missing.sol'], profile: 'scope' })).code, 'hosted_profile');
});

test('prepare_review reports a blocked secret by file, line and kind, without the secret', async (t) => {
  const cwd = await project(t, { 'deploy.py': `import os\nKEY = "${AWS_KEY}"\n` });
  const { tool } = server({ cwd });

  for (const args of [{ paths: ['deploy.py'] }, { files: [{ name: 'deploy.py', content: `import os\nKEY = "${AWS_KEY}"\n` }] }]) {
    const result = await tool('prepare_review', args);
    const body = failure(result);
    assert.equal(body.code, 'privacy_block');
    assert.match(body.error, /sensitive/);
    assert.equal(body.findings.length, 1);
    assert.deepEqual(
      { source: body.findings[0].source, name: body.findings[0].name, line: body.findings[0].line, severity: body.findings[0].severity },
      { source: 'input-1', name: 'deploy.py', line: 2, severity: 'block' },
    );
    assert.ok(body.findings[0].kind);
    assert.ok(!JSON.stringify(result).includes(AWS_KEY));
    assert.equal(result.structuredContent, undefined);
  }
});

test('prepare_review stops on an email address until the caller acknowledges it', async () => {
  const { tool } = server();
  const files = [{ name: 'notes.md', content: 'Contact alice@corp-internal.io about the fix.\n' }];

  const warned = failure(await tool('prepare_review', { files }));
  assert.equal(warned.code, 'privacy_warn');
  assert.equal(warned.findings[0].severity, 'warn');

  const sent = await tool('prepare_review', { files, acknowledgeWarnings: true });
  assert.equal(sent.isError, false);
  assert.equal(sent.structuredContent.findings.length, 1);
});

test('prepare_review rejects what it cannot use, and says what it takes', async () => {
  const { tool } = server();
  const files = [{ name: 'a.sol', content: VAULT }];

  const unknown = failure(await tool('prepare_review', { files, evidence: {}, authorized: true }));
  assert.equal(unknown.code, 'bad_input');
  assert.match(unknown.error, /no argument named "evidence", "authorized"\. It takes: paths, files, profile, prompt, mode, context, acknowledgeWarnings\./);

  assert.equal(failure(await tool('prepare_review', { files, profile: 'nope' })).code, 'bad_profile');
  assert.match(failure(await tool('prepare_review', {})).error, /Pass between 1 and 50 files: as paths, as files, or both\./);
  assert.equal(failure(await tool('prepare_review', { files: 'a.sol' })).code, 'bad_input');
  assert.equal(failure(await tool('prepare_review', { paths: 'a.sol' })).code, 'bad_input');
  assert.match(failure(await tool('prepare_review', { files: [{ name: '../a.sol', content: VAULT }] })).error, /unsupported filename/);
  assert.match(failure(await tool('prepare_review', { files, mode: 'audit', profile: 'general' })).error, /Mode must be bounty or own-code/);
  assert.match(failure(await tool('prepare_review', { files, context: { proof: 'maybe' } })).error, /Context proof must be/);
  assert.equal(failure(await tool('prepare_review', { files, prompt: 7 })).code, 'bad_input');

  const many = Array.from({ length: LIMITS.files + 1 }, (_, index) => ({ name: `f${index}.sol`, content: 'x' }));
  assert.match(failure(await tool('prepare_review', { files: many })).error, /between 1 and 50/);
});

// ---------------------------------------------------------------------------
// build_packet
// ---------------------------------------------------------------------------

async function preparedManifest(tool) {
  const prepared = await tool('prepare_review', { files: [{ name: 'src/Vault.sol', content: VAULT }], profile: 'solidity', mode: 'bounty' });
  return prepared.structuredContent.manifest;
}

test('build_packet reads the verdict, checks every reference and returns the packet', async () => {
  const { tool } = server();
  const manifest = await preparedManifest(tool);
  const result = await tool('build_packet', {
    review: reviewFor('input-1/src/Vault.sol'),
    manifest,
    profile: 'solidity',
    model: 'claude-opus-5-5',
    provider: 'Anthropic',
    context: { target: 'Example vault', proof: 'local' },
  });
  const built = result.structuredContent;

  assert.equal(built.ok, true);
  assert.equal(built.verdict, 'prove-first');
  assert.equal(built.mode, 'bounty');
  assert.equal(built.headline, 'withdraw has no access check.');
  assert.equal(built.counts.high, 1);
  assert.deepEqual(built.findings, [
    { id: 'F-1', title: 'Anyone can withdraw', severity: 'high', basis: 'proven-in-source', counterargument: 'open', gap: 'a local test' },
  ]);
  assert.deepEqual(built.referenceProblems, [{ location: 'input-1/src/Vault.sol:40', problem: 'line-out-of-range' }]);

  assert.match(built.packet, /^# Bounty Operator review packet/);
  assert.match(built.packet, /Profile: Solidity review/);
  assert.match(built.packet, /Verdict: prove-first/);
  assert.match(built.packet, /Anthropic \/ claude-opus-5-5/);
  assert.ok(built.packet.includes(manifest[0].sha256));
  assert.match(built.packet, /## Reference check\n- input-1\/src\/Vault\.sol:40/);
  assert.match(built.packet, /Verify: https:\/\/bountyoperator\.com\/tools\/verify/);
});

test('build_packet neutralises live markup in a review and flags a review with no verdict', async () => {
  const { tool } = server();
  const manifest = await preparedManifest(tool);
  const review = `${reviewFor('input-1/src/Vault.sol')}\n\n![pixel](https://tracker.example/p.png)\n<img src=x onerror=alert(1)>`;
  const { packet } = (await tool('build_packet', { review, manifest })).structuredContent;
  assert.ok(!packet.includes('![pixel]('));
  assert.ok(!packet.includes('<img'));

  const loose = (await tool('build_packet', { review: 'The code looks fine to me.', manifest })).structuredContent;
  assert.equal(loose.ok, false);
  assert.equal(loose.verdict, '');
  assert.match(loose.packet, /The code looks fine to me\./);
});

test('build_packet records the stages of a gauntlet', async () => {
  const { tool } = server();
  const manifest = await preparedManifest(tool);
  const built = await tool('build_packet', {
    review: reviewFor('input-1/src/Vault.sol', 'submit'),
    manifest,
    profile: 'verdict',
    source: 'gauntlet',
    model: 'the-agent-model',
    stages: [
      { profile: 'scope', verdict: 'submit', headline: 'In scope at the deployed revision.' },
      { profile: 'provenance', verdict: 'submit', headline: 'An unprivileged caller performs every step.' },
    ],
  });
  const { packet } = built.structuredContent;
  // The caller lists the earlier stages. The packet counts and lists the stage of the review itself too.
  assert.match(packet, /Produced by: Gauntlet: 3 stages, final verdict by the-agent-model\./);
  assert.match(packet, /## Stages\n- 1 · Scope and impact fit · submit · In scope at the deployed revision\.\n- 2 · Design intent and actors · submit · An unprivileged caller performs every step\.\n- 3 · Final verdict · the-agent-model · submit · withdraw has no access check\.\n/);
  assert.match(packet, /Profile: Final verdict/);

  // A run the first gate ended: one stage, in the singular. A provider id reads as its label.
  const gated = await tool('build_packet', { review: reviewFor('input-1/src/Vault.sol', 'drop'), manifest, profile: 'scope', source: 'gauntlet', provider: 'openrouter', model: 'some/model' });
  assert.match(gated.structuredContent.packet, /Produced by: Gauntlet: 1 stage, final verdict by OpenRouter \/ some\/model\./);
  assert.match(gated.structuredContent.packet, /## Stages\n- 1 · Scope and impact fit · some\/model · drop · withdraw has no access check\.\n/);
});

test('build_packet rejects a manifest it did not issue and arguments out of range', async () => {
  const { tool } = server();
  const manifest = await preparedManifest(tool);
  const review = reviewFor('input-1/src/Vault.sol');

  assert.match(failure(await tool('build_packet', { review, manifest: [{ label: 'x', bytes: 1, sha256: 'abc' }] })).error, /manifest that prepare_review returned/);
  assert.match(failure(await tool('build_packet', { review, manifest: [] })).error, /manifest/);
  assert.match(failure(await tool('build_packet', { review: '   ', manifest })).error, /review must be the review text/);
  assert.match(failure(await tool('build_packet', { review, manifest, source: 'example' })).error, /source must be one of: pasted, ai, panel, gauntlet\./);
  assert.match(failure(await tool('build_packet', { review, manifest, model: 'm'.repeat(201) })).error, /model must be text of up to 200 characters/);
  assert.match(failure(await tool('build_packet', { review, manifest, stages: new Array(13).fill({}) })).error, /stages must be a list of up to 12/);
  assert.equal(failure(await tool('build_packet', { review, manifest, stages: [{ profile: 'nope' }] })).code, 'bad_profile');
  assert.match(failure(await tool('build_packet', { review, manifest, context: { prior: 'yes' } })).error, /Context prior must be/);
});

// ---------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------

test('account says how to connect when the token is missing or malformed, and calls nothing', async () => {
  const api = fakeFetch({});
  const missing = failure(await server({ fetch: api.fetch }).tool('account'));
  assert.equal(missing.code, 'token');
  assert.match(missing.error, /Set BOUNTY_OPERATOR_TOKEN in this server's environment/);
  assert.match(missing.error, /https:\/\/bountyoperator\.com\/#account/);

  const malformed = failure(await server({ fetch: api.fetch, env: { BOUNTY_OPERATOR_TOKEN: 'bok_short' } }).tool('account'));
  assert.equal(malformed.code, 'token');
  assert.ok(!JSON.stringify(malformed).includes('bok_short'));
  assert.equal(api.calls.length, 0);
});

test('account returns the usage of the account behind the token', async () => {
  const api = fakeFetch({ 'GET /api/client/account': () => ({ body: { usage: USAGE, billing: 'live', limits: LIMITS, price: { usd: 10, interval: 'week' }, version: '0.7.0' } }) });
  const result = await server({ fetch: api.fetch, env: { BOUNTY_OPERATOR_TOKEN: TOKEN } }).tool('account');

  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.usage, USAGE);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].origin, 'https://bountyoperator.com');
  assert.equal(api.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('the token goes to bountyoperator.com or to this machine, and nowhere else', async () => {
  for (const origin of ['https://evil.example', 'http://bountyoperator.com', 'https://bountyoperator.com.evil.example', 'http://localhost:8787@evil.example', 'http://192.168.1.5:8787']) {
    const api = fakeFetch({});
    const body = failure(await server({ fetch: api.fetch, env: { BOUNTY_OPERATOR_TOKEN: TOKEN, BOUNTY_OPERATOR_ORIGIN: origin } }).tool('account'));
    assert.equal(body.code, 'bad_origin', origin);
    assert.equal(api.calls.length, 0, origin);
  }

  for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8799/', 'http://[::1]:8787']) {
    const api = fakeFetch({ 'GET /api/client/account': () => ({ body: { usage: USAGE } }) });
    const result = await server({ fetch: api.fetch, env: { BOUNTY_OPERATOR_TOKEN: TOKEN, BOUNTY_OPERATOR_ORIGIN: origin } }).tool('account');
    assert.equal(result.isError, false, origin);
    assert.equal(api.calls[0].origin, origin.replace(/\/$/, ''));
  }
});

test('account passes on the coded error of a revoked token and reports an unreachable server', async () => {
  const revoked = fakeFetch({ 'GET /api/client/account': () => ({ status: 401, body: { error: 'This connection token has expired or was revoked.', code: 'token' } }) });
  const body = failure(await server({ fetch: revoked.fetch, env: { BOUNTY_OPERATOR_TOKEN: TOKEN } }).tool('account'));
  assert.deepEqual(body, { error: 'This connection token has expired or was revoked.', code: 'token' });

  const down = async () => {
    throw new TypeError('fetch failed');
  };
  const unreachable = failure(await server({ fetch: down, env: { BOUNTY_OPERATOR_TOKEN: TOKEN } }).tool('account'));
  assert.equal(unreachable.code, 'network');

  const html = fakeFetch({ 'GET /api/client/account': () => ({ status: 502, body: '<html>bad gateway</html>' }) });
  const gateway = failure(await server({ fetch: html.fetch, env: { BOUNTY_OPERATOR_TOKEN: TOKEN } }).tool('account'));
  assert.deepEqual(gateway, { error: 'Bounty Operator answered with HTTP 502.', code: 'hosted' });
});

// ---------------------------------------------------------------------------
// run_review
// ---------------------------------------------------------------------------

const HOSTED_ENV = { BOUNTY_OPERATOR_TOKEN: TOKEN, OPENROUTER_API_KEY: PROVIDER_KEY };

function reviewApi(review, extra = {}) {
  return fakeFetch({
    'POST /api/client/review': ({ body }) => ({
      body: {
        review,
        manifest: body.files.map((file, index) => ({ label: `input-${index + 1}/${file.name}`, bytes: Buffer.byteLength(file.content), sha256: sha256(file.content), lines: 3 })),
        profile: { id: body.profile, name: 'Solidity review' },
        mode: 'bounty',
        model: body.model,
        truncated: false,
        refused: false,
        usage: { input: 900, output: 300 },
        ...extra,
      },
    }),
    'GET /api/client/account': () => ({ body: { usage: USAGE } }),
  });
}

test('run_review sends the files and the key from the environment, and returns the checked review', async (t) => {
  const cwd = await project(t, { 'src/Vault.sol': VAULT });
  const review = `${reviewFor('input-1/src/Vault.sol')}\n\n![pixel](https://tracker.example/p.png)`;
  const api = reviewApi(review);
  const { tool } = server({ cwd, fetch: api.fetch, env: HOSTED_ENV });

  const result = await tool('run_review', {
    paths: ['src/Vault.sol'],
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-5.5',
    profile: 'solidity',
    mode: 'bounty',
    prompt: 'Look at withdraw.',
    context: { target: 'Example vault' },
  });
  assert.equal(result.isError, false);

  const [sent, after] = api.calls;
  assert.equal(api.calls.length, 2);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, '/api/client/review');
  assert.equal(sent.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(sent.headers['Content-Type'], 'application/json');
  assert.deepEqual(sent.body, {
    files: [{ name: 'src/Vault.sol', content: VAULT }],
    prompt: 'Look at withdraw.',
    profile: 'solidity',
    context: { target: 'Example vault' },
    mode: 'bounty',
    acknowledgeWarnings: false,
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-5.5',
    apiKey: PROVIDER_KEY,
  });
  assert.equal(after.path, '/api/client/account');

  const ran = result.structuredContent;
  assert.equal(ran.verdict, 'prove-first');
  assert.equal(ran.headline, 'withdraw has no access check.');
  assert.deepEqual(ran.referenceProblems, [{ location: 'input-1/src/Vault.sol:40', problem: 'line-out-of-range' }]);
  assert.equal(ran.manifest[0].sha256, sha256(VAULT));
  assert.equal(ran.model, 'anthropic/claude-sonnet-5.5');
  assert.deepEqual(ran.allowance, USAGE);
  assert.ok(!ran.review.includes('![pixel]('), 'model output is defanged');
  assert.match(ran.review, /Verdict: prove-first/);

  const wire = JSON.stringify(result);
  assert.ok(!wire.includes(PROVIDER_KEY));
  assert.ok(!wire.includes(TOKEN));
});

test('run_review takes the model from BOUNTY_OPERATOR_MODEL, and asks for one when neither is given', async () => {
  const files = [{ name: 'a.sol', content: VAULT }];

  const api = reviewApi(reviewFor('input-1/a.sol'));
  const fromEnv = await server({ fetch: api.fetch, env: { ...HOSTED_ENV, BOUNTY_OPERATOR_MODEL: 'x-ai/grok-4.7' } }).tool('run_review', { files, provider: 'openrouter' });
  assert.equal(fromEnv.isError, false);
  assert.equal(api.calls[0].body.model, 'x-ai/grok-4.7');

  const none = fakeFetch({});
  const body = failure(await server({ fetch: none.fetch, env: HOSTED_ENV }).tool('run_review', { files, provider: 'openrouter' }));
  assert.equal(body.code, 'bad_model');
  assert.match(body.error, /pass model, or set BOUNTY_OPERATOR_MODEL/);
  assert.match(body.error, /OpenRouter models: deepseek\/deepseek-v4\.1-flash,/);
  assert.equal(none.calls.length, 0);
});

test('run_review names the missing key by its variable, per provider, and sends nothing', async () => {
  const files = [{ name: 'a.sol', content: VAULT }];
  for (const provider of PROVIDERS) {
    const api = fakeFetch({});
    const { tool } = server({ fetch: api.fetch, env: { BOUNTY_OPERATOR_TOKEN: TOKEN } });
    const body = failure(await tool('run_review', { files, provider: provider.id, model: provider.defaultModel }));
    assert.equal(body.code, 'bad_key', provider.id);
    assert.ok(body.error.startsWith(`Set ${provider.envVar} in this server's environment`), provider.id);
    assert.equal(api.calls.length, 0);
  }

  const api = fakeFetch({});
  const { tool } = server({ fetch: api.fetch, env: HOSTED_ENV });
  assert.equal(failure(await tool('run_review', { files, provider: 'acme', model: 'm' })).code, 'bad_provider');
  assert.equal(failure(await tool('run_review', { files, provider: 'openrouter', model: 'has space' })).code, 'bad_model');
  assert.equal(failure(await tool('run_review', { files, provider: 'openrouter', model: 'm', apiKey: PROVIDER_KEY })).code, 'bad_input', 'a key is never a tool argument');
  assert.equal(api.calls.length, 0);

  const short = server({ fetch: api.fetch, env: { ...HOSTED_ENV, OPENROUTER_API_KEY: 'short' } });
  assert.equal(failure(await short.tool('run_review', { files, provider: 'openrouter', model: 'm' })).code, 'bad_key');
});

test('run_review needs the token before it sends anything', async () => {
  const api = fakeFetch({});
  const { tool } = server({ fetch: api.fetch, env: { OPENROUTER_API_KEY: PROVIDER_KEY } });
  const body = failure(await tool('run_review', { files: [{ name: 'a.sol', content: VAULT }], provider: 'openrouter', model: 'm' }));
  assert.equal(body.code, 'token');
  assert.equal(api.calls.length, 0);
});

test('run_review runs the privacy check on this machine: a blocked file is never sent', async (t) => {
  const cwd = await project(t, { 'deploy.py': `KEY = "${AWS_KEY}"\n` });
  const api = reviewApi(reviewFor('input-1/deploy.py'));
  const { tool } = server({ cwd, fetch: api.fetch, env: HOSTED_ENV });

  const body = failure(await tool('run_review', { paths: ['deploy.py'], provider: 'openrouter', model: 'm' }));
  assert.equal(body.code, 'privacy_block');
  assert.equal(body.findings[0].line, 1);
  assert.equal(api.calls.length, 0);
});

test('run_review passes on the coded errors of the account API', async () => {
  const files = [{ name: 'a.sol', content: VAULT }];
  const used = fakeFetch({
    'POST /api/client/review': () => ({
      status: 429,
      body: { error: "Today's free review is used. The next one opens at 00:00 UTC. Operator has no daily limit.", code: 'daily_used', resetsAt: '2026-10-03T00:00:00.000Z', upgradeUrl: 'https://bountyoperator.com/pricing' },
    }),
  });
  const body = failure(await server({ fetch: used.fetch, env: HOSTED_ENV }).tool('run_review', { files, provider: 'openrouter', model: 'm' }));
  assert.deepEqual(body, {
    resetsAt: '2026-10-03T00:00:00.000Z',
    upgradeUrl: 'https://bountyoperator.com/pricing',
    error: "Today's free review is used. The next one opens at 00:00 UTC. Operator has no daily limit.",
    code: 'daily_used',
  });
  assert.equal(used.calls.length, 1, 'a failed review is not followed by an account call');
});

test('run_review passes on the plan refusal for the two gauntlet and panel profiles', async () => {
  const files = [{ name: 'a.sol', content: VAULT }];
  for (const [profile, sentence] of [
    ['verdict', "Final verdict is the last stage of the gauntlet, which runs on Operator. Nothing was sent to the provider and today's review was not used."],
    ['panel', "Panel cross-examination is the cross-examination of a panel review, which runs on Operator. Nothing was sent to the provider and today's review was not used."],
  ]) {
    const refused = fakeFetch({
      'POST /api/client/review': ({ body }) => ({
        status: 403,
        body: { profile: body.profile, upgradeUrl: 'https://bountyoperator.com/pricing', error: sentence, code: 'operator_only' },
      }),
    });
    const result = await server({ fetch: refused.fetch, env: HOSTED_ENV }).tool('run_review', { files, provider: 'openrouter', model: 'm', profile });
    assert.equal(result.isError, true, profile);
    assert.deepEqual(failure(result), { profile, upgradeUrl: 'https://bountyoperator.com/pricing', error: sentence, code: 'operator_only' });
    assert.equal(refused.calls.length, 1, 'one request, and no account call after the refusal');
    assert.equal(refused.calls[0].body.profile, profile);
  }

  // The tool and the plan say so before an agent spends a free review on stage 1.
  const { tool, call } = server();
  const described = (await call('tools/list')).result.tools.find((entry) => entry.name === 'run_review').description;
  assert.match(described, /The verdict and panel profiles run on an Operator plan: a free account is refused with code operator_only and keeps its daily review\./);
  const plan = (await tool('run_gauntlet_plan')).structuredContent;
  assert.match(plan.hosted.needs, /The last stage runs on an Operator plan: a free account is refused there with code operator_only\./);
  assert.match(plan.steps.join('\n'), /On a free plan, say before stage 1 that the last stage runs on Operator\./);
});

test('a secret this process holds is removed from everything it returns', async () => {
  const files = [{ name: 'a.sol', content: VAULT }];
  const leaky = fakeFetch({
    'POST /api/client/review': () => ({ status: 502, body: { error: `Provider rejected key ${PROVIDER_KEY} for ${TOKEN}.`, code: 'provider', kind: PROVIDER_KEY } }),
  });
  const failed = await server({ fetch: leaky.fetch, env: HOSTED_ENV }).tool('run_review', { files, provider: 'openrouter', model: 'm' });
  assert.deepEqual(failure(failed), { kind: '[redacted]', error: 'Provider rejected key [redacted] for [redacted].', code: 'provider' });

  const echo = reviewApi(`${reviewFor('input-1/a.sol')}\nkey ${PROVIDER_KEY}`, { note: TOKEN });
  const ran = await server({ fetch: echo.fetch, env: HOSTED_ENV }).tool('run_review', { files, provider: 'openrouter', model: 'm' });
  assert.equal(ran.isError, false);
  const wire = JSON.stringify(ran);
  assert.ok(!wire.includes(PROVIDER_KEY));
  assert.ok(!wire.includes(TOKEN));
  assert.match(ran.structuredContent.review, /key \[redacted\]/);
});

test('run_review still returns the review when the allowance cannot be read', async () => {
  const api = fakeFetch({
    'POST /api/client/review': ({ body }) => ({ body: { review: reviewFor('input-1/a.sol'), manifest: [{ label: 'input-1/a.sol', bytes: 1, sha256: sha256('x'), lines: 3 }], model: body.model } }),
    'GET /api/client/account': () => ({ status: 500, body: { error: 'down', code: 'internal' } }),
  });
  const ran = await server({ fetch: api.fetch, env: HOSTED_ENV }).tool('run_review', { files: [{ name: 'a.sol', content: VAULT }], provider: 'openrouter', model: 'm' });
  assert.equal(ran.isError, false);
  assert.equal(ran.structuredContent.verdict, 'prove-first');
  assert.equal('allowance' in ran.structuredContent, false);

  for (const answer of [{ review: 7 }, { review: reviewFor('input-1/a.sol'), manifest: [null] }]) {
    const odd = fakeFetch({ 'POST /api/client/review': () => ({ body: answer }) });
    const body = failure(await server({ fetch: odd.fetch, env: HOSTED_ENV }).tool('run_review', { files: [{ name: 'a.sol', content: VAULT }], provider: 'openrouter', model: 'm' }));
    assert.equal(body.code, 'hosted');
  }
});

test('a cancelled run_review stops the request and sends no response', async () => {
  let aborted = false;
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  const instance = server({ fetch: hanging, env: HOSTED_ENV });

  const reply = instance.handle({
    jsonrpc: '2.0',
    id: 'slow-1',
    method: 'tools/call',
    params: { name: 'run_review', arguments: { files: [{ name: 'a.sol', content: VAULT }], provider: 'openrouter', model: 'm' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await instance.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow-1' } }), null);

  assert.equal(await reply, null);
  assert.equal(aborted, true);
});

test('run_review reports progress while it waits, to a client that asked for it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release;
  const api = fakeFetch({
    'POST /api/client/review': () =>
      new Promise((resolve) => {
        release = () => resolve({ body: { review: reviewFor('input-1/a.sol'), manifest: [{ label: 'input-1/a.sol', bytes: 1, sha256: sha256('x'), lines: 3 }] } });
      }),
    'GET /api/client/account': () => ({ body: { usage: USAGE } }),
  });
  const instance = server({ fetch: api.fetch, env: HOSTED_ENV });
  const sent = [];
  const args = { files: [{ name: 'a.sol', content: VAULT }], provider: 'openrouter', model: 'some/model' };

  const reply = instance.handle(
    { jsonrpc: '2.0', id: 'p-1', method: 'tools/call', params: { name: 'run_review', arguments: args, _meta: { progressToken: 'tok-1' } } },
    (notification) => sent.push(notification),
  );
  while (!release) await new Promise((resolve) => setImmediate(resolve));

  t.mock.timers.tick(15000);
  t.mock.timers.tick(15000);
  assert.deepEqual(sent, [
    { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'tok-1', progress: 1, message: 'Waiting for some/model' } },
    { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'tok-1', progress: 2, message: 'Waiting for some/model' } },
  ]);

  release();
  assert.equal((await reply).result.isError, false);
  t.mock.timers.tick(60000);
  assert.equal(sent.length, 2, 'nothing is sent after the response');

  // No token, no notifications.
  const quiet = [];
  release = undefined;
  const silent = instance.handle({ jsonrpc: '2.0', id: 'p-2', method: 'tools/call', params: { name: 'run_review', arguments: args } }, (notification) => quiet.push(notification));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(45000);
  release();
  await silent;
  assert.deepEqual(quiet, []);
});

// ---------------------------------------------------------------------------
// run_gauntlet_plan
// ---------------------------------------------------------------------------

test('run_gauntlet_plan lays out the eight stages in order, and the call that ends the run', async () => {
  const { tool } = server();
  const plan = (await tool('run_gauntlet_plan')).structuredContent;

  assert.deepEqual(plan.stages.map((stage) => stage.profile), ['scope', 'provenance', 'prior-art', 'poc', 'severity', 'triage', 'report', 'verdict']);
  assert.deepEqual(plan.stages.map((stage) => stage.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(plan.stages.map((stage) => stage.saveAs).slice(0, 3), ['stage-1-scope.md', 'stage-2-provenance.md', 'stage-3-prior-art.md']);
  // Seven stages are hosted and run on the server; the report stage is open and runs on the agent's model.
  assert.deepEqual(
    plan.stages.map((stage) => stage.tool),
    ['run_review', 'run_review', 'run_review', 'run_review', 'run_review', 'run_review', 'prepare_review', 'run_review'],
  );
  assert.equal(plan.stages[0].name, 'Scope and impact fit');
  assert.deepEqual(plan.stages[0].reads, ['Draft report', 'Source files']);
  assert.deepEqual(plan.stages[0].context, ['target', 'scope', 'version', 'proofRevision', 'impactList', 'impactRow', 'exclusions']);
  assert.equal(
    plan.stages[0].instruction,
    'Stage 1 of 8. Call run_review with profile "scope", the provider and model the researcher chose, the collected paths and the context. Keep the returned review as stage-1-scope.md.',
  );
  assert.equal(
    plan.stages[6].instruction,
    'Stage 7 of 8. Call prepare_review with profile "report", the collected paths, the context and the earlier reviews as files. Answer the request it returns yourself, as the reviewer its instructions describe: start at "# Review" and follow the output format exactly. Keep your review as stage-7-report.md.',
  );
  assert.match(plan.stages[7].instruction, /run_review with profile "verdict", the provider and model the researcher chose, the collected paths, the context and the earlier reviews as files/);

  assert.equal(plan.hosted.stages, 7);
  assert.match(plan.hosted.needs, /7 of the 8 stages run on the Bounty Operator server through run_review/);
  assert.equal(plan.steps.length, 10);
  assert.match(plan.steps.join('\n'), /drop or hold-duplicate/);
  assert.match(plan.steps.join('\n'), /which provider and model/);
  assert.deepEqual(plan.verdicts, ['submit', 'rewrite-then-submit', 'prove-first', 'hold-duplicate', 'drop']);

  assert.equal(plan.finish.tool, 'build_packet');
  assert.equal(plan.finish.arguments.source, 'gauntlet');
  assert.equal(plan.finish.arguments.profile, 'verdict');
  assert.deepEqual(plan.finish.arguments.stages.map((stage) => stage.profile), ['scope', 'provenance', 'prior-art', 'poc', 'severity', 'triage', 'report']);

  // The plan names the stages. It carries no method: a core stage gets its
  // method from prepare_review, and the method of a hosted stage is not in the package.
  const text = JSON.stringify(plan);
  for (const id of GAUNTLET) {
    const { instructions, hosted } = PROFILES.find((profile) => profile.id === id);
    if (!hosted) assert.ok(!text.includes(instructions.slice(0, 80)), id);
  }
  assert.ok(!/Profile: /.test(text), 'no profile method in the plan');
});

test('a profile whose method is not in the package runs as a hosted stage', () => {
  assert.equal(runsHosted({ instructions: 'Profile: scope.' }), false);
  assert.equal(runsHosted({ instructions: '' }), true);
  assert.equal(runsHosted({ instructions: 'Profile: scope.', hosted: true }), true);
  assert.equal(stageFile(3, 'prior-art'), 'stage-3-prior-art.md');
});

test('run_gauntlet_plan asks only for the Context fields still empty', async () => {
  const { tool } = server();
  const empty = (await tool('run_gauntlet_plan')).structuredContent;
  const target = empty.ask.find((field) => field.key === 'target');
  assert.deepEqual(target, { key: 'target', label: 'Target', hint: 'Programme or project, and the asset under review.', stages: [1] });
  assert.ok(empty.ask.some((field) => field.key === 'impactRow'));

  const filled = (await tool('run_gauntlet_plan', { context: { target: 'Example vault', impactRow: 'Direct theft of user funds (Critical)', proof: 'local' } })).structuredContent;
  const keys = filled.ask.map((field) => field.key);
  assert.ok(!keys.includes('target'));
  assert.ok(!keys.includes('impactRow'));
  assert.ok(!keys.includes('proof'));
  assert.ok(keys.includes('scope'));

  assert.match(failure(await tool('run_gauntlet_plan', { context: { proof: 'yes' } })).error, /Context proof must be/);
});

test('the plan runs end to end: seven hosted stages, one on the agent model, then one packet', async (t) => {
  const cwd = await project(t, { 'report.md': '# Draft\nwithdraw has no access check.\n', 'src/Vault.sol': VAULT });
  const sent = [];
  // The stand-in for the account API: it answers every hosted stage with a review of the files it was sent.
  const api = fakeFetch({
    'POST /api/client/review': ({ body }) => {
      sent.push(body.profile);
      return {
        body: {
          review: reviewFor('input-2/src/Vault.sol', body.profile === 'verdict' ? 'submit' : 'prove-first'),
          manifest: body.files.map((file, index) => ({ label: `input-${index + 1}/${file.name}`, bytes: Buffer.byteLength(file.content), sha256: sha256(file.content), lines: 3 })),
          profile: { id: body.profile, name: body.profile },
          mode: 'bounty',
          model: body.model,
          truncated: false,
          refused: false,
          usage: { input: 900, output: 300 },
        },
      };
    },
    'GET /api/client/account': () => ({ body: { usage: { ...USAGE, plan: 'weekly' } } }),
  });
  const { tool } = server({ cwd, fetch: api.fetch, env: HOSTED_ENV });
  const context = { target: 'Example vault', version: 'abc1234' };
  const plan = (await tool('run_gauntlet_plan', { context })).structuredContent;

  const kept = [];
  let last;
  for (const stage of plan.stages) {
    const hosted = stage.tool === 'run_review';
    const result = await tool(stage.tool, {
      paths: ['report.md', 'src/Vault.sol'],
      files: kept.length ? kept : undefined,
      profile: stage.profile,
      context,
      ...(hosted ? { provider: 'openrouter', model: 'some/model' } : {}),
    });
    assert.equal(result.isError, false, stage.profile);
    last = result.structuredContent;
    assert.equal(last.manifest.length, 2 + kept.length);
    assert.equal(last.mode, 'bounty');
    // A hosted stage returns the review. A core stage returns the request, and the agent writes the review.
    assert.equal(typeof last.review, hosted ? 'string' : 'undefined', stage.profile);
    assert.equal(typeof last.instructions, hosted ? 'undefined' : 'string', stage.profile);
    kept.push({ name: stage.saveAs, content: hosted ? last.review : reviewFor('input-2/src/Vault.sol') });
  }
  assert.deepEqual(sent, ['scope', 'provenance', 'prior-art', 'poc', 'severity', 'triage', 'verdict']);
  assert.deepEqual(last.manifest.slice(2).map((entry) => entry.label), plan.stages.slice(0, 7).map((stage, index) => `input-${index + 3}/${stage.saveAs}`));

  const built = await tool('build_packet', {
    review: kept[7].content,
    manifest: last.manifest,
    context,
    profile: plan.finish.arguments.profile,
    source: plan.finish.arguments.source,
    model: 'the-agent-model',
    stages: plan.finish.arguments.stages.map((stage) => ({ profile: stage.profile, verdict: 'prove-first', headline: 'withdraw has no access check.' })),
  });
  assert.equal(built.structuredContent.verdict, 'submit');
  // Seven earlier stages were passed. The packet lists all eight: the verdict stage is the review itself.
  assert.match(built.structuredContent.packet, /Gauntlet: 8 stages, final verdict by the-agent-model\./);
  assert.match(built.structuredContent.packet, /- 7 · Challenge a draft report · prove-first/);
  assert.match(built.structuredContent.packet, /- 8 · Final verdict · the-agent-model · submit · withdraw has no access check\./);
});
