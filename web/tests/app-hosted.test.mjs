// The workbench and the open-core split: what the browser offers for a hosted
// profile, and the two renderer changes that came with the engine techniques.
// Pure helpers and source checks; the browser run is covered by the page tests.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { EXAMPLES } from '../public/example.mjs';
import { reviewPacket } from '../public/evidence.mjs';
import { parseReview } from '../public/parse.mjs';
import { CORE_PROFILE_IDS, PROFILES } from '../public/profiles.mjs';
import { prepareRequest, prepareReview, promptExport } from '../public/review-core.mjs';
import { issueMarkdown, sectionColumns } from '../public/app/results.mjs';
import { hostedLine, isHosted } from '../public/app/workbench.mjs';

const APP = new URL('../public/app/', import.meta.url);
const source = (name) => readFile(new URL(name, APP), 'utf8');

describe('hosted profiles in the workbench', () => {
  test('isHosted is true for the ten hosted profiles and false for the three core ones', () => {
    assert.deepEqual(PROFILES.filter((profile) => !isHosted(profile.id)).map((profile) => profile.id), ['general', 'solidity', 'report']);
    assert.equal(PROFILES.filter((profile) => isHosted(profile.id)).length, 10);
    // An id the workbench does not know is treated as the general profile.
    assert.equal(isHosted('no-such-profile'), false);
  });

  test('the one line names the profile, says where it runs and lists the three that can be exported', () => {
    assert.equal(
      hostedLine('scope'),
      'Scope and impact fit runs on our server with your key. Prompt export covers Code security review, Solidity review and Challenge a draft report.',
    );
    for (const profile of PROFILES.filter((entry) => entry.hosted)) {
      const line = hostedLine(profile.id);
      assert.ok(line.startsWith(`${profile.name} runs on our server with your key.`), profile.id);
      for (const id of CORE_PROFILE_IDS) assert.ok(line.includes(PROFILES.find((entry) => entry.id === id).name), id);
      // One plain line: no hedging, no second sentence about limits.
      assert.equal(line.split('. ').length, 2);
      assert.ok(!/\b(?:may|might|cannot|unfortunately|sorry)\b/i.test(line));
    }
  });

  test('the preview of a hosted profile is the request: exactly the files and the context that leave', async () => {
    const files = [{ name: 'report.md', content: '# Draft\nLine two.\n' }, { name: 'src/Vault.sol', content: 'contract Vault {}\n' }];
    const context = { target: 'Example vault', impactRow: 'Direct theft of user funds (Critical)' };
    const { request, manifest } = await prepareRequest(files, 'Check the scope.', 'scope', { context });

    assert.ok(request.startsWith('## Request\nCheck the scope.\n\n## Context\nMode: bounty\nTarget: Example vault\n'));
    assert.ok(request.includes('Selected impact row: Direct theft of user funds (Critical)'));
    assert.ok(request.includes('### input-1/report.md\n```\n1| # Draft\n2| Line two.\n```'));
    assert.ok(request.includes('### input-2/src/Vault.sol\n```\n1| contract Vault {}\n```'));
    assert.deepEqual(manifest.map((entry) => entry.label), ['input-1/report.md', 'input-2/src/Vault.sol']);
    // Nothing of a method, because the browser has none.
    assert.ok(!/Profile: |You are a security reviewer|Output exactly the structure/.test(request));
    await assert.rejects(prepareReview(files, '', 'scope', { context }), (error) => error.code === 'hosted_profile');
  });

  test('prompt export and paste-back are offered for core profiles only', async () => {
    const workbench = await source('workbench.mjs');
    // The prompt builder refuses a hosted profile with the one line; the preview shows the request in its place.
    assert.match(workbench, /if \(state\.files\.length && isHosted\(state\.profile\)\) \{\s+say\(hostedLine\(state\.profile\), \{ tone: 'warn', hold: true \}\);\s+return null;/);
    assert.match(workbench, /const prepared = await prepareRequest\(state\.files, state\.focus, state\.profile, \{/);
    assert.match(workbench, /return \{ text: prepared\.request, hosted: true \};/);
    // In the preview of a hosted profile the copy and download buttons are hidden.
    assert.match(workbench, /for \(const control of \[qs\('#wb-preview-copy'\), qs\('#wb-preview-download'\)\]\) \{\s+if \(control\) control\.hidden = built\.hosted;/);
    // The preview of a hosted profile is the request. It does not claim to be all that leaves the tab: the key travels too.
    assert.match(workbench, /built\.hosted \? 'The request' : 'The prompt your model receives'/);
    assert.match(workbench, /Below is the request: your focus, the context and the files\./);
    assert.doesNotMatch(workbench, /everything that leaves/i);

    const providers = await source('providers-ui.mjs');
    // Chat-subscription rows: the reply field goes, and the line stands where the buttons were.
    assert.match(providers, /const exportable = !isHosted\(profileId\);\s+show\('#wb-row-reply', exportable\);/);
    assert.match(providers, /line\.textContent = exportable \? '' : hostedLine\(profileId\);/);
    assert.match(providers, /workbench\.select\(\(current\) => current\.profile, \(\) => \{\s+if \(view\.get\(\)\.via === 'export'\) paintExport\(\);/);

    const pasteback = await source('pasteback.mjs');
    assert.match(pasteback, /if \(isHosted\(state\.profile\)\) \{\s+warmed = null;\s+return;/);
    assert.match(pasteback, /if \(isHosted\(state\.profile\)\) \{\s+say\(hostedLine\(state\.profile\), \{ tone: 'warn', hold: true \}\);\s+return;/);
  });

  test('no browser module asks the engine for a hosted method', async () => {
    for (const name of ['workbench.mjs', 'pasteback.mjs', 'run.mjs', 'gauntlet.mjs', 'panel.mjs', 'dossier.mjs', 'main.mjs', 'results.mjs', 'providers-ui.mjs']) {
      const text = await source(name);
      assert.ok(!/instructionsFor|profileInstructions|\.extraFormat\b/.test(text), name);
      assert.ok(!/operator-profiles/.test(text), name);
    }
    // A hosted run is a request to the server: the gauntlet and the panel send files, never a prompt.
    for (const name of ['run.mjs', 'gauntlet.mjs', 'panel.mjs']) assert.ok(!/prepareReview|promptExport/.test(await source(name)), name);
  });

  test('an exported prompt exists for each core profile and carries its method', async () => {
    const files = [{ name: 'src/Vault.sol', content: 'contract Vault {}\n' }];
    for (const id of CORE_PROFILE_IDS) {
      const exported = promptExport(await prepareReview(files, '', id));
      assert.ok(exported.includes(PROFILES.find((profile) => profile.id === id).instructions), id);
    }
  });
});

describe('examples', () => {
  test('a packet built from a bundled example names the model and the day it answered', () => {
    assert.ok(EXAMPLES.length >= 2);
    for (const example of EXAMPLES) {
      assert.ok(example.model && example.generatedAt, example.id);
      const packet = reviewPacket({
        review: example.review,
        manifest: [],
        context: example.context,
        model: example.model,
        timestamp: example.generatedAt,
        source: 'example',
        profileId: example.profile,
      });
      const line = packet.split('\n').find((entry) => entry.startsWith('Produced by: '));
      assert.equal(line, `Produced by: Bundled example: a stored answer generated by ${example.model} on ${example.generatedAt.slice(0, 10)}. No model was called now.`);
      assert.ok(!/written by hand/.test(packet), example.id);
    }
  });

  test('the stored gauntlet stages and the panel are model answers to hosted profiles, shown as outputs only', () => {
    const withGauntlet = EXAMPLES.filter((example) => example.gauntlet);
    assert.ok(withGauntlet.length >= 1);
    for (const example of withGauntlet) {
      for (const stage of example.gauntlet.stages) {
        assert.ok(PROFILES.some((profile) => profile.id === stage.profileId), stage.profileId);
        assert.ok(stage.review.startsWith('# Review'), `${example.id} / ${stage.profileId}`);
        // An output never opens with a method.
        assert.ok(!/^Profile: /m.test(stage.review), `${example.id} / ${stage.profileId}`);
        assert.deepEqual(Object.keys(stage).filter((key) => /instruction|prompt|system/i.test(key)), []);
      }
    }
  });
});

describe('renderer changes that came with the engine techniques', () => {
  test('the Invariants table has a header for the stated or inferred column', () => {
    assert.deepEqual(sectionColumns('Invariants', 3), ['Property', 'State', 'Evidence']);
    assert.deepEqual(sectionColumns('Invariants', 4), ['Property', 'Source', 'State', 'Evidence']);
    const parsed = parseReview('# Review\nVerdict: fix-before-deploy\nMode: own-code\n\n## Invariants\n- sum of balances equals totalStaked | stated | broken | F-1\n- shares never exceed assets | inferred | holds | input-1/a.sol:9\n');
    assert.deepEqual(parsed.sections[0].rows.map((row) => row.length), [4, 4]);
  });

  test('a Path that starts at step 6 keeps its numbers in the issue text', () => {
    const review = [
      '# Review', 'Verdict: prove-first', 'Mode: bounty', 'Counts: critical=0 high=0 medium=1 hardening=0 checked-safe=0', 'Headline: A late staker is paid rewards she did not earn.', '',
      '## F-1: stake() skips settlement', 'Severity: medium', 'Basis: proven-in-source', 'Location: input-1/a.sol:4', 'Impact: A late staker takes 3 ether of rewards.',
      'Path:', '6. Carol stakes 10 ether.', '7. Carol claims 3 ether she never earned.', 'Gap: none', 'Fix: settle before the balance changes.', 'Next: add the test.',
    ].join('\n');
    const result = { review, manifest: [{ label: 'input-1/a.sol', bytes: 10, sha256: 'a'.repeat(64), lines: 20 }] };
    const text = issueMarkdown(result);
    assert.match(text, /\*\*Path\*\*\n\n6\. Carol stakes 10 ether\.\n7\. Carol claims 3 ether she never earned\.\n/);
    assert.ok(!/\n1\. Carol/.test(text));
  });

  test('the step list sets its start and moves the counter the stylesheet draws', async () => {
    const results = await source('results.mjs');
    assert.match(results, /list\.setAttribute\('start', String\(start\)\);/);
    assert.match(results, /list\.style\.counterReset = `step \$\{start - 1\}`;/);
    const css = await readFile(new URL('../public/css/base.css', import.meta.url), 'utf8');
    assert.match(css, /\.steps \{\s+counter-reset: step;/);
    assert.match(css, /\.steps > li \{[^}]*counter-increment: step;/);
  });
});
